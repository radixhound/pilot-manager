import fs from 'node:fs';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LAUNCHD_DIR, LOGS_DIR, PROJECTS_FILE, ENV_DIR, ensureConfigDir } from './paths.js';
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

// Stable symlinks that typically point at the active Homebrew-managed node.
// Checked for every install, after the version-manager candidates below.
export const STABLE_NODE_SYMLINKS = ['/opt/homebrew/bin/node', '/usr/local/bin/node'];

const DAEMON_SUBPATH = path.join('@radnine', 'claude-session-daemon', 'src', 'index.js');

// Directories that belong to one installed node or ruby version. A plist that
// names one breaks when that version is removed.
const VERSIONED_DIR_PATTERNS = [
  /\/versions\/node\/[^/]+(\/|$)/,                // nvm
  /\/installs\/(node|nodejs|ruby)\/[^/]+(\/|$)/,  // mise, asdf
  /\/node-versions\/[^/]+(\/|$)/,                 // fnm
  /\/fnm_multishells\/[^/]+(\/|$)/,               // fnm per-shell links
  /\/tools\/image\/node\/[^/]+(\/|$)/,            // Volta
  /\/Cellar\/(node|ruby)(@[^/]+)?\/[^/]+(\/|$)/,   // Homebrew
  /\/\.rbenv\/versions\/[^/]+(\/|$)/,             // rbenv
];

export function isVersionedPath(p) {
  return VERSIONED_DIR_PATTERNS.some(re => re.test(p));
}

// Version-agnostic ways to run the node that is running pilot-manager, most
// specific first. 'symlink' candidates are checked with realpath; 'shim'
// candidates pick a version at launch, so they are probed by running them.
function nodeCandidates(realExec, symlinks) {
  const candidates = [];
  let m;
  if ((m = realExec.match(/^(.*)\/Cellar\/(node(?:@[^/]+)?)\/[^/]+\/bin\/node$/))) {
    candidates.push({ manager: 'homebrew', kind: 'symlink', command: [`${m[1]}/bin/node`] });
    candidates.push({ manager: 'homebrew', kind: 'symlink', command: [`${m[1]}/opt/${m[2]}/bin/node`] });
  } else if ((m = realExec.match(/^(.*)\/installs\/(?:node|nodejs)\/[^/]+\/bin\/node$/))) {
    const manager = /mise/.test(m[1]) ? 'mise' : 'asdf';
    candidates.push({ manager, kind: 'shim', command: [`${m[1]}/shims/node`] });
  } else if ((m = realExec.match(/^(.*)\/node-versions\/[^/]+\/installation\/bin\/node$/))) {
    candidates.push({ manager: 'fnm', kind: 'symlink', command: [`${m[1]}/aliases/default/bin/node`] });
  } else if ((m = realExec.match(/^(.*)\/tools\/image\/node\/[^/]+\/bin\/node$/))) {
    candidates.push({ manager: 'volta', kind: 'shim', command: [`${m[1]}/bin/node`] });
  } else if ((m = realExec.match(/^(.*)\/versions\/node\/[^/]+\/bin\/node$/))) {
    // nvm has no shim directory. ~/.nvm/current exists only with
    // NVM_SYMLINK_CURRENT; otherwise nvm-exec runs node from the default alias.
    candidates.push({ manager: 'nvm', kind: 'symlink', command: [`${m[1]}/current/bin/node`] });
    candidates.push({
      manager: 'nvm', kind: 'shim',
      command: [`${m[1]}/nvm-exec`, 'node'],
      env: { NODE_VERSION: 'default' },
    });
  }
  for (const link of symlinks) {
    candidates.push({ manager: 'homebrew', kind: 'symlink', command: [link] });
  }
  return candidates;
}

function probeNode(command, { cwd, env }) {
  return execFileSync(command[0], [...command.slice(1), '-p', 'process.execPath'], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 15000,
  }).trim();
}

// Pick the node command a plist should run. A candidate is used only if it
// runs the same node binary as the one running now, so a new plist starts the
// daemon on the node it was installed for. With no match (Linux, CI, a plain
// installer node) this returns process.execPath, as before.
export function resolveNodeLauncher({
  execPath = process.execPath,
  cwd = process.cwd(),
  symlinks = STABLE_NODE_SYMLINKS,
  exists = fs.existsSync,
  realpath = fs.realpathSync,
  probe = probeNode,
} = {}) {
  let realExec;
  try {
    realExec = realpath(execPath);
  } catch {
    return { manager: null, command: [execPath], env: {}, installPrefix: null };
  }
  const installPrefix = path.resolve(realExec, '..', '..');

  for (const candidate of nodeCandidates(realExec, symlinks)) {
    try {
      if (!exists(candidate.command[0])) continue;
      const resolved = candidate.kind === 'symlink'
        ? candidate.command[0]
        : probe(candidate.command, { cwd, env: candidate.env || {} });
      if (realpath(resolved) !== realExec) continue;
      return { manager: candidate.manager, command: candidate.command, env: candidate.env || {}, installPrefix };
    } catch {
      // missing, unreadable, or failed to run: try the next one
    }
  }
  return { manager: null, command: [execPath], env: {}, installPrefix };
}

export function resolveNodeBinary(options) {
  return resolveNodeLauncher(options).command[0];
}

// Runs under /bin/sh with the node command as "$@". It finds the daemon in the
// global node_modules of whichever node that command runs today, so the plist
// keeps working after the node version changes.
const LAUNCH_SCRIPT = [
  `entry=$("$@" -p 'require("path").resolve(process.execPath, "../../lib/node_modules/@radnine/claude-session-daemon/src/index.js")') && [ -f "$entry" ] && exec "$@" "$entry"`,
  'echo "pilot-manager: @radnine/claude-session-daemon is not installed for the current node (looked for ${entry:-it}). Install it with: npm install -g @radnine/claude-session-daemon" >&2',
  'exit 78',
].join('\n');

// The plist ProgramArguments. When the daemon sits inside the running node's
// own versioned install, the plist looks it up at launch instead of naming it.
// A versioned path that is a link to somewhere stable (`npm link` to a
// checkout) is written as the link's target.
export function programArguments(launcher, daemonEntry, { realpath = fs.realpathSync } = {}) {
  if (!launcher.manager) return [...launcher.command, daemonEntry];

  let realEntry = daemonEntry;
  try {
    realEntry = realpath(daemonEntry);
  } catch {
    // keep the path as given
  }
  if (launcher.installPrefix && realEntry.startsWith(launcher.installPrefix + path.sep)) {
    return ['/bin/sh', '-c', LAUNCH_SCRIPT, 'pilot-daemon', ...launcher.command];
  }
  const entry = isVersionedPath(daemonEntry) && !isVersionedPath(realEntry) ? realEntry : daemonEntry;
  return [...launcher.command, entry];
}

// Swap versioned node and ruby dirs in PATH for their manager's stable dir.
// A dir with no stable replacement on this machine stays as it is.
export function stablePathEnv(pathValue, { launcher = { manager: null }, exists = fs.existsSync } = {}) {
  const out = [];
  for (const dir of pathValue.split(':')) {
    let next = dir;
    let m;
    const swap = candidate => { if (exists(candidate)) next = candidate; };
    if ((m = dir.match(/^(.*)\/installs\/(?:node|nodejs|ruby)\/[^/]+(\/.*)?$/))) {
      swap(`${m[1]}/shims`);
    } else if ((m = dir.match(/^(.*)\/node-versions\/[^/]+\/installation\/bin$/))) {
      swap(`${m[1]}/aliases/default/bin`);
    } else if ((m = dir.match(/^(.*)\/tools\/image\/node\/[^/]+\/bin$/))) {
      swap(`${m[1]}/bin`);
    } else if ((m = dir.match(/^(.*)\/Cellar\/((?:node|ruby)(?:@[^/]+)?)\/[^/]+\/bin$/))) {
      swap(`${m[1]}/opt/${m[2]}/bin`);
    } else if ((m = dir.match(/^(.*\/\.rbenv)\/versions\/[^/]+(\/.*)?$/))) {
      swap(`${m[1]}/shims`);
    } else if ((m = dir.match(/^(.*)\/versions\/node\/[^/]+\/bin$/))) {
      swap(`${m[1]}/current/bin`);
      // nvm-exec puts the default node's bin on PATH at launch.
      if (next === dir && launcher.manager === 'nvm') next = null;
    } else if (/\/fnm_multishells\/[^/]+\/bin$/.test(dir) && launcher.manager === 'fnm') {
      next = path.dirname(launcher.command[0]);
    }
    if (next && !out.includes(next)) out.push(next);
  }
  return out.join(':');
}

// The global node_modules this copy of pilot-manager is installed in
// (<root>/@radnine/claude-pilot-manager/src/launchd.js).
function ownGlobalRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

function npmGlobalRoot() {
  return execSync('npm root -g', { encoding: 'utf8' }).trim();
}

export function resolveDaemonEntry({ ownRoot = ownGlobalRoot, npmRoot = npmGlobalRoot } = {}) {
  // Try to find the daemon's index.js via require.resolve-style lookup
  // The daemon is a CJS package, so we locate it relative to global node_modules
  const inRoot = root => {
    const entry = path.join(root(), DAEMON_SUBPATH);
    return fs.existsSync(entry) ? entry : null;
  };
  const candidates = [
    // Installed next to pilot-manager. Checked before `npm root -g`, which
    // answers for whichever node leads PATH, not the node running us.
    () => inRoot(ownRoot),
    // Global npm install
    () => inRoot(npmRoot),
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

// `options` is for tests: resolveNodeLauncher options plus `daemonEntry`.
export function generatePlist(name, projectConfig, globalConfig, options = {}) {
  const { daemonEntry = resolveDaemonEntry(), ...launcherOptions } = options;
  const launcher = resolveNodeLauncher({ cwd: projectConfig.path, ...launcherOptions });

  if (!daemonEntry) {
    throw new Error(
      'Cannot find @radnine/claude-session-daemon. Install it with:\n' +
      '  npm install -g @radnine/claude-session-daemon'
    );
  }

  const env = {
    ...resolveEnvVars(name, projectConfig, globalConfig),
    ...launcher.env,
  };
  env.PATH = stablePathEnv(env.PATH, { launcher, exists: launcherOptions.exists });
  const args = programArguments(launcher, daemonEntry, { realpath: launcherOptions.realpath });
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
${args.map(arg => `    <string>${escapeXml(arg)}</string>\n`).join('')}  </array>

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

// The Claude and Codex config folders decide which sign-in and chat history a
// pilot's chats use. A rewrite that changes one strands every chat on that
// pilot, so it never happens silently.
export const GUARDED_ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'];
export const ACCEPT_CONFIG_DIR_FLAG = '--accept-config-dir-change';

export class ConfigDirGuardError extends Error {
  constructor(pilot, message) {
    super(message);
    this.name = 'ConfigDirGuardError';
    this.pilot = pilot;
  }
}

function unescapeXml(str) {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&');
}

// The EnvironmentVariables of an XML plist, as a plain object. Handles the
// layout generatePlist writes and the one plutil/PlistBuddy write after a
// hand edit (tabs, <string/> for an empty value). Comments are dropped and
// CDATA sections read as text, as launchd reads them, so a commented-out
// setting can't stand in for the active one.
export function plistEnvironment(rawXml) {
  // One pass, so whichever starts first wins: "<!--" inside CDATA is text,
  // and "<![CDATA[" inside a comment is comment.
  const xml = rawXml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->/g,
    (_, cdata) => (cdata === undefined ? '' : escapeXml(cdata)));
  const block = xml.match(/<key>\s*EnvironmentVariables\s*<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
  if (!block) return {};
  const env = {};
  const pair = /<key>([\s\S]*?)<\/key>\s*(?:<string>([\s\S]*?)<\/string>|<string\s*\/>)/g;
  let m;
  while ((m = pair.exec(block[1]))) {
    env[unescapeXml(m[1].trim())] = unescapeXml(m[2] ?? '');
  }
  return env;
}

function readInstalledPlist(pPath) {
  const buf = fs.readFileSync(pPath);
  if (buf.subarray(0, 6).toString('latin1') === 'bplist') {
    // A binary plist (after `plutil -convert binary1`). -o - prints the XML
    // form and leaves the file alone.
    return execFileSync('plutil', ['-convert', 'xml1', '-o', '-', pPath], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  }
  return buf.toString('utf8');
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const shown = value => (value === undefined ? '(not set)' : value);

// Compare the installed plist's config folders with the ones a rewrite would
// write. Throws ConfigDirGuardError when the rewrite must not happen:
//   - a folder setting changed, was added, or was removed, unless
//     acceptConfigDirChange is set;
//   - a folder the rewrite would write does not exist (the accept flag does
//     not skip this).
// With no installed plist (a first install) there is nothing to protect.
export function guardConfigDirs(name, newPlistXml, {
  acceptConfigDirChange = false,
  installedPath = plistPath(name),
  isDir = isDirectory,
} = {}) {
  if (!fs.existsSync(installedPath)) return;

  let installedEnv;
  try {
    installedEnv = plistEnvironment(readInstalledPlist(installedPath));
  } catch (err) {
    throw new ConfigDirGuardError(name,
      `Did not touch "${name}": could not read the installed plist ${installedPath} ` +
      `to check ${GUARDED_ENV_KEYS.join(' and ')} (${err.message}).`);
  }
  const wantedEnv = plistEnvironment(newPlistXml);
  const projectEnvFile = path.join(ENV_DIR, `${name}.env`);
  const defaultEnvFile = path.join(ENV_DIR, '_default.env');
  const problems = [];

  for (const key of GUARDED_ENV_KEYS) {
    const installed = installedEnv[key];
    const wanted = wantedEnv[key];

    if (wanted !== undefined && !isDir(wanted)) {
      problems.push(
        `Did not touch "${name}": ${key} names a folder that does not exist: ${wanted}\n` +
        `  installed plist:           ${shown(installed)}\n` +
        `  pilot-manager would write: ${wanted}\n` +
        `  Create that folder, or fix ${key} under extra_env for "${name}" in ${PROJECTS_FILE} ` +
        `(or in ${projectEnvFile} or ${defaultEnvFile}).\n` +
        `  ${ACCEPT_CONFIG_DIR_FLAG} does not skip this check.`);
      continue;
    }

    if (installed === wanted || acceptConfigDirChange) continue;

    const keep = installed === undefined
      ? `To keep it unset, remove ${key} from extra_env for "${name}" in ${PROJECTS_FILE}, ` +
        `and from ${projectEnvFile} and ${defaultEnvFile}.`
      : `To keep the installed value, set ${key}: ${installed} under extra_env for "${name}" ` +
        `in ${PROJECTS_FILE} (or ${key}=${installed} in ${projectEnvFile}).`;
    problems.push(
      `Did not touch "${name}": ${key} would change.\n` +
      `  installed plist:           ${shown(installed)}\n` +
      `  pilot-manager would write: ${shown(wanted)}\n` +
      `  ${keep}\n` +
      `  To accept the change, re-run with ${ACCEPT_CONFIG_DIR_FLAG}.`);
  }

  if (problems.length > 0) throw new ConfigDirGuardError(name, problems.join('\n'));
}

// The plist a (re)install would write, after the config-folder guard passes.
// Throws before anything is unloaded or written.
function preparePlist(name, { acceptConfigDirChange = false } = {}) {
  const project = getProject(name);
  if (!project) throw new Error(`Project "${name}" not found in registry`);

  const config = loadConfig();
  const plistXml = generatePlist(name, project, config);
  guardConfigDirs(name, plistXml, { acceptConfigDirChange });
  return plistXml;
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

// Decide what to do with a launchd service after its registration token changed,
// given the service's current status. Pure (no launchctl, no fs) so the branch
// logic is unit-testable in isolation:
//   'not installed' → skip: nothing to reload; the token bakes in at first install.
//   'installed' / 'running' → reinstall: regenerate the plist and reload so the
//                             running daemon picks up the new token.
export function planServiceRefresh(status) {
  if (status === 'not installed') {
    return { action: 'skip', installed: false };
  }
  return { action: 'reinstall', installed: true };
}

export function installService(name, options = {}) {
  if (isServiceLoaded(name)) {
    // A bare `launchctl load` on an already-loaded job is a silent no-op —
    // it reports no error but never actually reloads a stuck or wedged
    // daemon, so `install` on a service that's already loaded must kick it
    // the same way `restart` does (unload, then load), not leave it exactly
    // as it was found. Reuse that path rather than reimplementing it here.
    restartService(name, options);
  } else {
    const plistXml = preparePlist(name, options);
    writePlist(name, plistXml);

    try {
      execSync(`launchctl load "${plistPath(name)}"`, { encoding: 'utf8' });
    } catch (err) {
      throw new Error(`launchctl load failed: ${err.message}`);
    }
  }

  // `launchctl load` (bare or via restartService) can report success while
  // the daemon itself never comes up — don't call it installed until a pid
  // actually shows, otherwise a stuck service that fails to reload reports a
  // false "Installed" success off its old, stale pid.
  const pid = getServicePid(name);
  if (!pid) {
    throw new Error(`"${name}" did not come up after install — check: pilot-manager logs ${name}`);
  }
  return pid;
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

export function restartService(name, options = {}) {
  const pPath = plistPath(name);

  // Build the new plist and run the config-folder guard before anything is
  // unloaded: a refusal must leave the running daemon exactly as it was.
  const plistXml = preparePlist(name, options);

  // Unload if loaded
  if (isServiceLoaded(name)) {
    try {
      execSync(`launchctl unload "${pPath}"`, { encoding: 'utf8' });
    } catch {
      // ignore
    }
  }

  writePlist(name, plistXml);

  try {
    execSync(`launchctl load "${plistPath(name)}"`, { encoding: 'utf8' });
  } catch (err) {
    throw new Error(`launchctl load failed: ${err.message}`);
  }
}

export function installAll(options = {}) {
  const projects = listProjects();
  const results = [];
  for (const p of projects) {
    try {
      installService(p.name, options);
      const pid = getServicePid(p.name);
      results.push({ name: p.name, success: true, pid });
    } catch (err) {
      results.push({
        name: p.name, success: false, error: err.message, refused: err instanceof ConfigDirGuardError,
      });
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
