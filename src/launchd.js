import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { LAUNCHD_DIR, LOGS_DIR, ensureConfigDir } from './paths.js';
import { loadConfig, resolveEnvVars } from './config.js';
import { getProject, listProjects } from './registry.js';

const LABEL_PREFIX = 'com.radnine.pilot';

function sanitizeName(name) {
  return name.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
}

function label(name) {
  return `${LABEL_PREFIX}.${sanitizeName(name)}`;
}

export function plistPath(name) {
  return path.join(LAUNCHD_DIR, `${label(name)}.plist`);
}

export function resolveNodeBinary() {
  return process.execPath;
}

export function resolveDaemonEntry() {
  // Try to find the daemon's index.js via require.resolve-style lookup
  // The daemon is a CJS package, so we locate it relative to global node_modules
  const candidates = [
    // Global npm install
    () => {
      const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
      const entry = path.join(globalRoot, '@radnine', 'claude-session-daemon', 'src', 'index.js');
      if (fs.existsSync(entry)) return entry;
      return null;
    },
    // Local to rad-project (development)
    () => {
      const devPaths = [
        path.join(process.cwd(), '..', 'rad-project', 'daemon', 'src', 'index.js'),
        path.join(process.cwd(), 'node_modules', '@radnine', 'claude-session-daemon', 'src', 'index.js'),
      ];
      for (const p of devPaths) {
        const resolved = path.resolve(p);
        if (fs.existsSync(resolved)) return resolved;
      }
      return null;
    },
    // which claude-session-daemon (CLI shim)
    () => {
      try {
        const bin = execSync('which claude-session-daemon', { encoding: 'utf8' }).trim();
        if (!bin) return null;
        // Read the shim to find the actual module path
        const content = fs.readFileSync(bin, 'utf8');
        const match = content.match(/require\(['"](.+?)['"]\)/);
        if (match) return path.resolve(path.dirname(bin), match[1]);
        // If it's a simple node script, the daemon index.js is nearby
        const dir = path.dirname(fs.realpathSync(bin));
        const nearby = path.join(dir, '..', 'src', 'index.js');
        if (fs.existsSync(nearby)) return nearby;
      } catch {
        // not found
      }
      return null;
    },
  ];

  for (const candidate of candidates) {
    try {
      const result = candidate();
      if (result) return result;
    } catch {
      // try next
    }
  }

  return null;
}

function envToDict(env) {
  let xml = '';
  for (const [key, value] of Object.entries(env)) {
    xml += `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>\n`;
  }
  return xml;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function generatePlist(name, projectConfig, globalConfig) {
  const nodeBin = resolveNodeBinary();
  const daemonEntry = resolveDaemonEntry();

  if (!daemonEntry) {
    throw new Error(
      'Cannot find @radnine/claude-session-daemon. Install it with:\n' +
      '  npm install -g @radnine/claude-session-daemon'
    );
  }

  const env = resolveEnvVars(name, projectConfig, globalConfig);
  const autoRestart = projectConfig.auto_restart !== undefined
    ? projectConfig.auto_restart
    : globalConfig.auto_restart;

  const logDir = LOGS_DIR;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label(name)}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodeBin)}</string>
    <string>${escapeXml(daemonEntry)}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${escapeXml(projectConfig.path)}</string>

  <key>EnvironmentVariables</key>
  <dict>
${envToDict(env)}  </dict>

  <key>KeepAlive</key>
  <${autoRestart}/>

  <key>RunAtLoad</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(logDir, `${sanitizeName(name)}.stdout.log`))}</string>

  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(logDir, `${sanitizeName(name)}.stderr.log`))}</string>

  <key>ThrottleInterval</key>
  <integer>5</integer>
</dict>
</plist>`;
}

export function writePlist(name, plistXml) {
  ensureConfigDir();
  const pPath = plistPath(name);
  fs.writeFileSync(pPath, plistXml);
  fs.chmodSync(pPath, 0o600);
}

export function removePlist(name) {
  const pPath = plistPath(name);
  if (fs.existsSync(pPath)) {
    fs.unlinkSync(pPath);
  }
}

export function isServiceLoaded(name) {
  try {
    const output = execSync('launchctl list', { encoding: 'utf8' });
    return output.includes(label(name));
  } catch {
    return false;
  }
}

export function getServicePid(name) {
  try {
    const output = execSync('launchctl list', { encoding: 'utf8' });
    for (const line of output.split('\n')) {
      if (line.includes(label(name))) {
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[0], 10);
        return isNaN(pid) ? null : pid;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

export function getServiceStatus(name) {
  const pPath = plistPath(name);
  if (!fs.existsSync(pPath)) return 'not installed';

  const pid = getServicePid(name);
  if (pid) return 'running';

  if (isServiceLoaded(name)) return 'installed';

  return 'not installed';
}

export function installService(name) {
  const project = getProject(name);
  if (!project) throw new Error(`Project "${name}" not found in registry`);

  const config = loadConfig();
  const plistXml = generatePlist(name, project, config);
  writePlist(name, plistXml);

  try {
    execSync(`launchctl load "${plistPath(name)}"`, { encoding: 'utf8' });
  } catch (err) {
    throw new Error(`launchctl load failed: ${err.message}`);
  }
}

export function uninstallService(name) {
  const pPath = plistPath(name);

  if (isServiceLoaded(name)) {
    try {
      execSync(`launchctl unload "${pPath}"`, { encoding: 'utf8' });
    } catch {
      // ignore — may not be loaded
    }
  }

  removePlist(name);
}

export function restartService(name) {
  const pPath = plistPath(name);

  // Unload if loaded
  if (isServiceLoaded(name)) {
    try {
      execSync(`launchctl unload "${pPath}"`, { encoding: 'utf8' });
    } catch {
      // ignore
    }
  }

  // Regenerate plist with current config
  const project = getProject(name);
  if (!project) throw new Error(`Project "${name}" not found in registry`);

  const config = loadConfig();
  const plistXml = generatePlist(name, project, config);
  writePlist(name, plistXml);

  try {
    execSync(`launchctl load "${plistPath(name)}"`, { encoding: 'utf8' });
  } catch (err) {
    throw new Error(`launchctl load failed: ${err.message}`);
  }
}

export function installAll() {
  const projects = listProjects();
  const results = [];
  for (const p of projects) {
    try {
      installService(p.name);
      const pid = getServicePid(p.name);
      results.push({ name: p.name, success: true, pid });
    } catch (err) {
      results.push({ name: p.name, success: false, error: err.message });
    }
  }
  return results;
}

export function uninstallAll() {
  const projects = listProjects();
  const results = [];
  for (const p of projects) {
    try {
      uninstallService(p.name);
      results.push({ name: p.name, success: true });
    } catch (err) {
      results.push({ name: p.name, success: false, error: err.message });
    }
  }
  return results;
}

export function logPath(name, stream = 'stderr') {
  const safeName = sanitizeName(name);
  return path.join(LOGS_DIR, `${safeName}.${stream}.log`);
}
