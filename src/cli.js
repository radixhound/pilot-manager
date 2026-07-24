import { parseArgs } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import { execSync } from 'node:child_process';
import { loadConfig, saveConfig, persistServerUrl } from './config.js';
import { seedCommandCenter } from './seed.js';
import { addProject, removeProject, listProjects, getProject } from './registry.js';
import { ensureConfigDir, LOGS_DIR } from './paths.js';
import {
  installService, uninstallService, restartService,
  installAll, uninstallAll,
  getServiceStatus, getServicePid, planServiceRefresh,
  logPath, plistPath, resolveDaemonEntry,
} from './launchd.js';
import {
  registerProject, deregisterProject, registerAll,
  checkTokenStatus,
} from './registrar.js';
import {
  getInstalledDaemonVersion, getLatestDaemonVersion, upgradeDaemon,
} from './upgrade.js';

const HELP = `
pilot-manager — Per-machine supervisor for claude-session-daemon instances

Usage: pilot-manager <command> [options]

Registry Commands:
  init                           Interactive setup, writes config.yml
  add <path> [--name X] [--port N]  Add a project to the registry
  remove <name>                  Remove a project from the registry
  list                           List all registered projects
  scan <parent-dir> [--yes]      Auto-discover projects in subdirs

Service Commands:
  install [name]                 Generate plist + start via launchd (all or one)
  uninstall [name]               Stop + remove plist (all or one)
  start [name]                   Start service via launchctl load
  stop [name]                    Stop service via launchctl unload
  restart [name]                 Stop + regenerate plist + start (all if no name)
  reinstall [name]               Alias for restart (picks up config changes)
  logs <name> [--stdout]         Tail a daemon's log

Registration Commands:
  register [name] [--server URL] [--force]  Register with Rails server (all if no name)
  deregister [name]              Revoke token and clear from config
  token <name> [--reveal]        Show auth token for a project
  setup <path> --name X [--port N] [--server URL]  Add + register + install one project
  setup <parent-dir> [--server URL] [--yes]        Scan + register + install all found

Seed:
  seed <target-root> [--server URL]  Download + install the Command Center seed vault

Other:
  upgrade [--version X]          Upgrade daemon to latest (or specified) version
  version                        Show version
  help                           Show this help

Options:
  --help, -h    Show help for a command
  --yes, -y     Skip confirmation prompts
`.trim();

function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function cmdInit(args) {
  ensureConfigDir();
  const config = loadConfig();

  if (args.yes) {
    saveConfig(config);
    console.log('Config written with defaults.');
    return;
  }

  const serverUrl = await prompt(`Server URL [${config.server_url}]: `);
  if (serverUrl) config.server_url = serverUrl;

  const basePort = await prompt(`Base port [${config.base_port}]: `);
  if (basePort) config.base_port = parseInt(basePort, 10);

  saveConfig(config);
  console.log('Config saved to ~/.config/claude-pilot-manager/config.yml');
}

function cmdAdd(positionals, args) {
  const projectPath = positionals[0];
  if (!projectPath) {
    console.error('Error: path is required. Usage: pilot-manager add <path> [--name X] [--port N]');
    process.exit(1);
  }

  const absPath = path.resolve(projectPath);
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) {
    console.error(`Error: "${absPath}" is not a valid directory`);
    process.exit(1);
  }

  const name = args.name || path.basename(absPath);
  const options = {};
  if (args.port) options.port = parseInt(args.port, 10);

  try {
    const project = addProject(name, absPath, options);
    console.log(`Added "${name}" (port ${project.port}) → ${absPath}`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

function cmdRemove(positionals) {
  const name = positionals[0];
  if (!name) {
    console.error('Error: name is required. Usage: pilot-manager remove <name>');
    process.exit(1);
  }

  try {
    removeProject(name);
    console.log(`Removed "${name}" from registry`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

function cmdList() {
  const projects = listProjects();
  if (projects.length === 0) {
    console.log('No projects registered. Use "pilot-manager add <path>" or "pilot-manager scan <dir>".');
    return;
  }

  const nameWidth = Math.max(4, ...projects.map(p => p.name.length)) + 2;
  const portWidth = 6;
  const pidWidth = 8;
  const statusWidth = 14;
  const pathWidth = Math.max(4, ...projects.map(p => p.path.length)) + 2;

  const header = [
    'NAME'.padEnd(nameWidth),
    'PORT'.padEnd(portWidth),
    'PID'.padEnd(pidWidth),
    'STATUS'.padEnd(statusWidth),
    'PATH',
  ].join('  ');

  console.log(header);

  for (const p of projects) {
    const status = getServiceStatus(p.name);
    const pid = getServicePid(p.name);
    const line = [
      p.name.padEnd(nameWidth),
      String(p.port).padEnd(portWidth),
      (pid ? String(pid) : '-').padEnd(pidWidth),
      status.padEnd(statusWidth),
      p.path,
    ].join('  ');
    console.log(line);
  }
}

async function cmdScan(positionals, args) {
  const parentDir = positionals[0];
  if (!parentDir) {
    console.error('Error: parent directory is required. Usage: pilot-manager scan <parent-dir> [--yes]');
    process.exit(1);
  }

  const absDir = path.resolve(parentDir);
  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
    console.error(`Error: "${absDir}" is not a valid directory`);
    process.exit(1);
  }

  const markers = ['.git', 'package.json', 'Gemfile', 'CLAUDE.md'];
  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  const found = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const subdir = path.join(absDir, entry.name);
    const hasMarker = markers.some(m => fs.existsSync(path.join(subdir, m)));
    if (hasMarker) {
      found.push({ name: entry.name, path: subdir });
    }
  }

  if (found.length === 0) {
    console.log(`No projects found in ${absDir}`);
    return;
  }

  console.log(`Found ${found.length} project(s):`);
  for (const f of found) {
    console.log(`  ${f.name} → ${f.path}`);
  }

  if (!args.yes) {
    const answer = await prompt('\nAdd all to registry? [y/N] ');
    if (answer.toLowerCase() !== 'y') {
      console.log('Cancelled.');
      return;
    }
  }

  const existing = listProjects();
  const existingNames = new Set(existing.map(p => p.name));
  let added = 0;

  for (const f of found) {
    if (existingNames.has(f.name)) {
      console.log(`  Skipped "${f.name}" (already registered)`);
      continue;
    }
    try {
      const project = addProject(f.name, f.path);
      console.log(`  Added "${f.name}" (port ${project.port})`);
      added++;
    } catch (err) {
      console.error(`  Error adding "${f.name}": ${err.message}`);
    }
  }

  console.log(`\n${added} project(s) added.`);
}

function cmdInstall(positionals) {
  if (positionals.length > 0) {
    const name = positionals[0];
    try {
      installService(name);
      const pid = getServicePid(name);
      console.log(`Installed "${name}"${pid ? ` (PID ${pid})` : ''}`);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  } else {
    const results = installAll();
    for (const r of results) {
      if (r.success) {
        console.log(`Installed "${r.name}"${r.pid ? ` (PID ${r.pid})` : ''}`);
      } else {
        console.error(`Failed "${r.name}": ${r.error}`);
      }
    }
    const ok = results.filter(r => r.success).length;
    console.log(`\n${ok}/${results.length} services installed.`);
  }
}

function cmdUninstall(positionals) {
  if (positionals.length > 0) {
    const name = positionals[0];
    try {
      uninstallService(name);
      console.log(`Uninstalled "${name}"`);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  } else {
    const results = uninstallAll();
    for (const r of results) {
      if (r.success) {
        console.log(`Uninstalled "${r.name}"`);
      } else {
        console.error(`Failed "${r.name}": ${r.error}`);
      }
    }
    console.log(`\n${results.filter(r => r.success).length}/${results.length} services uninstalled.`);
  }
}

function cmdStart(positionals) {
  const names = positionals.length > 0 ? [positionals[0]] : listProjects().map(p => p.name);
  for (const name of names) {
    const pp = plistPath(name);
    if (!fs.existsSync(pp)) {
      console.error(`"${name}" is not installed. Run: pilot-manager install ${name}`);
      continue;
    }
    try {
      execSync(`launchctl load "${pp}"`, { encoding: 'utf8' });
      console.log(`Started "${name}"`);
    } catch (err) {
      console.error(`Failed to start "${name}": ${err.message}`);
    }
  }
}

function cmdStop(positionals) {
  const names = positionals.length > 0 ? [positionals[0]] : listProjects().map(p => p.name);
  for (const name of names) {
    const pp = plistPath(name);
    if (!fs.existsSync(pp)) {
      console.log(`"${name}" is not installed. Nothing to stop.`);
      continue;
    }
    try {
      execSync(`launchctl unload "${pp}"`, { encoding: 'utf8' });
      console.log(`Stopped "${name}"`);
    } catch {
      console.log(`"${name}" was not running.`);
    }
  }
}

function cmdRestart(positionals) {
  const names = positionals.length > 0 ? [positionals[0]] : listProjects().map(p => p.name);
  for (const name of names) {
    try {
      restartService(name);
      const pid = getServicePid(name);
      console.log(`Restarted "${name}"${pid ? ` (PID ${pid})` : ''}`);
    } catch (err) {
      console.error(`Failed to restart "${name}": ${err.message}`);
    }
  }
}

function cmdLogs(positionals, args) {
  const name = positionals[0];
  if (!name) {
    console.error('Error: project name is required. Usage: pilot-manager logs <name> [--stdout]');
    process.exit(1);
  }

  const stream = args.stdout ? 'stdout' : 'stderr';
  const lp = logPath(name, stream);

  if (!fs.existsSync(lp)) {
    console.error(`No log file found at ${lp}`);
    console.error('Is the service installed? Run: pilot-manager install ' + name);
    process.exit(1);
  }

  const lines = args.lines ? parseInt(args.lines, 10) : 50;
  try {
    execSync(`tail -n ${lines} -f "${lp}"`, { stdio: 'inherit' });
  } catch {
    // User pressed Ctrl+C — normal exit
  }
}

// After a registration saves a fresh token, an already-installed launchd service
// still holds the OLD token in its plist's EnvironmentVariables, so the running
// daemon keeps authenticating with a revoked credential. Bring it back in sync:
// regenerate the plist and reload. No-op (with a note) when nothing is installed
// yet — the token gets baked in at first install. Never throws: a refresh failure
// after a successful registration must NOT read as a registration failure, so it's
// reported with a `reinstall` retry pointer and returned to the caller to decide.
function refreshServiceIfInstalled(name) {
  const plan = planServiceRefresh(getServiceStatus(name));

  if (plan.action === 'skip') {
    console.log(`  No launchd service installed for "${name}" yet — token applies at install.`);
    return { installed: false, refreshed: false };
  }

  try {
    restartService(name);
    const pid = getServicePid(name);
    console.log(`  Reinstalled service "${name}"${pid ? ` (PID ${pid})` : ''} to apply the new token.`);
    return { installed: true, refreshed: true, pid };
  } catch (err) {
    console.error(`  Token saved, but reloading the service failed: ${err.message}`);
    console.error(`  Retry: pilot-manager reinstall ${name}`);
    return { installed: true, refreshed: false, error: err.message };
  }
}

async function cmdRegister(positionals, args) {
  const options = {};
  if (args.server) {
    options.server = args.server;
    // Persist the explicit server so a later `install` bakes it into the
    // daemon's plist — otherwise the URL was used for this call only and the
    // installed service kept pointing at the config default.
    if (persistServerUrl(args.server)) {
      console.log(`server_url saved to config (${args.server}).`);
    }
  }
  if (args.force) options.force = true;

  if (positionals.length > 0) {
    const name = positionals[0];
    try {
      const project = getProject(name);
      if (project?.auth_token && !args.force) {
        console.log(`"${name}" is already registered. Use --force to re-register.`);
        return;
      }
      const result = await registerProject(name, options);
      console.log(`Registered "${name}" — token: ${result.auth_token?.slice(0, 8)}...`);
      refreshServiceIfInstalled(name);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  } else {
    const results = await registerAll(options);
    for (const r of results) {
      if (r.success) {
        console.log(`Registered "${r.name}" — token: ${r.auth_token?.slice(0, 8)}...`);
        refreshServiceIfInstalled(r.name);
      } else if (r.skipped) {
        console.log(`Skipped "${r.name}" (${r.error})`);
      } else {
        console.error(`Failed "${r.name}": ${r.error}`);
      }
    }
    const ok = results.filter(r => r.success).length;
    console.log(`\n${ok}/${results.length} projects registered.`);
  }
}

async function cmdDeregister(positionals) {
  const name = positionals[0];
  if (!name) {
    console.error('Error: project name is required. Usage: pilot-manager deregister <name>');
    process.exit(1);
  }

  try {
    await deregisterProject(name);
    console.log(`Deregistered "${name}" — token revoked and cleared.`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

function cmdToken(positionals, args) {
  const name = positionals[0];
  if (!name) {
    console.error('Error: project name is required. Usage: pilot-manager token <name> [--reveal]');
    process.exit(1);
  }

  const project = getProject(name);
  if (!project) {
    console.error(`Error: Project "${name}" not found`);
    process.exit(1);
  }

  if (!project.auth_token) {
    console.log(`No token for "${name}". Run: pilot-manager register ${name}`);
    return;
  }

  if (args.reveal) {
    console.log(project.auth_token);
  } else {
    console.log(`${project.auth_token.slice(0, 8)}...(use --reveal to show full token)`);
  }
}

// Run add → register → install for a single named project, stopping at the
// first stage that fails and pointing at the staged command to retry.
async function setupSingleProject(projectPath, name, args) {
  const absPath = path.resolve(projectPath);
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) {
    console.error(`Error: "${absPath}" is not a valid directory`);
    process.exit(1);
  }

  // Stage 1: add to registry (idempotent — reuse an existing entry)
  console.log('--- Adding to registry ---');
  const existing = getProject(name);
  if (existing) {
    if (path.resolve(existing.path) !== absPath) {
      console.error(
        `Error: "${name}" already exists in registry pointing at ${existing.path}.\n` +
        `  Use a different --name, or remove it first: pilot-manager remove ${name}`
      );
      process.exit(1);
    }
    console.log(`"${name}" already in registry (port ${existing.port}) — reusing.`);
  } else {
    try {
      const options = {};
      if (args.port) options.port = parseInt(args.port, 10);
      const project = addProject(name, absPath, options);
      console.log(`Added "${name}" (port ${project.port}) → ${absPath}`);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  }

  // Stage 2: register with server
  console.log('\n--- Registering with server ---');
  const project = getProject(name);
  if (project?.auth_token && !args.force) {
    console.log(`"${name}" already registered — reusing token. Use --force to re-register.`);
  } else {
    try {
      const options = {};
      if (args.server) options.server = args.server;
      if (args.force) options.force = true;
      const result = await registerProject(name, options);
      console.log(`Registered "${name}" — token: ${result.auth_token?.slice(0, 8)}...`);
    } catch (err) {
      console.error(`Added OK, register failed: ${err.message}`);
      console.error(`  Fix the issue, then retry: pilot-manager register ${name}`);
      process.exit(1);
    }
  }

  // Stage 3: install + load launchd service (bakes the token into the plist).
  // If a service is already installed, regenerate the plist and reload so a
  // freshly-saved token takes effect — a plain `launchctl load` would fail
  // ("already loaded") and silently skip the reload.
  console.log('\n--- Installing launchd service ---');
  const alreadyInstalled = getServiceStatus(name) !== 'not installed';
  if (alreadyInstalled) {
    // Same rule as `register`: refresh the installed service so the freshly-saved
    // token takes effect (a plain `launchctl load` would fail "already loaded").
    const refresh = refreshServiceIfInstalled(name);
    if (refresh.error) process.exit(1);
  } else {
    try {
      installService(name);
      const pid = getServicePid(name);
      console.log(`Installed "${name}"${pid ? ` (PID ${pid})` : ''}`);
    } catch (err) {
      console.error(`Registered OK, install failed: ${err.message}`);
      console.error(`  Fix the issue, then retry: pilot-manager install ${name}`);
      process.exit(1);
    }
  }

  const finalPid = getServicePid(name);
  console.log(`\nReady: "${name}"${finalPid ? ` (PID ${finalPid})` : ''}`);
}

async function cmdSetup(positionals, args) {
  const target = positionals[0];
  if (!target) {
    console.error('Error: a path is required. Usage:\n' +
      '  pilot-manager setup <path> --name X   (one project)\n' +
      '  pilot-manager setup <parent-dir>      (scan all subdirs)');
    process.exit(1);
  }

  // Init server config if provided (shared by both modes)
  const config = loadConfig();
  if (args.server) {
    config.server_url = args.server;
    saveConfig(config);
  }
  ensureConfigDir();

  // Single-project mode: --name signals "this path IS the project"
  if (args.name) {
    await setupSingleProject(target, args.name, args);
    return;
  }

  // Bulk mode: scan the parent dir for projects (existing behavior)
  console.log('--- Scanning for projects ---');
  await cmdScan(positionals, { ...args, yes: args.yes });

  // Step 3: Register
  console.log('\n--- Registering with server ---');
  const regResults = await registerAll({ server: args.server });
  for (const r of regResults) {
    if (r.success) {
      console.log(`Registered "${r.name}"`);
    } else if (r.skipped) {
      console.log(`Skipped "${r.name}" (already registered)`);
    } else {
      console.error(`Failed "${r.name}": ${r.error}`);
    }
  }

  // Step 4: Install
  console.log('\n--- Installing launchd services ---');
  cmdInstall([]);
}

async function cmdSeed(positionals, args) {
  const targetRoot = positionals[0];
  if (!targetRoot) {
    console.error('Error: a target root is required. Usage: pilot-manager seed <target-root> [--server URL]');
    process.exit(1);
  }

  // Same server precedence as register: --server flag, else config default.
  const config = loadConfig();
  const serverUrl = args.server || config.server_url;

  try {
    const { dest, personas } = await seedCommandCenter(targetRoot, serverUrl);
    // Persist the server only after a successful delivery. seed is atomic —
    // a bad target, unreachable server, or 404 must not mutate config.
    if (args.server && persistServerUrl(args.server)) {
      console.log(`server_url saved to config (${args.server}).`);
    }
    console.log(`\nSeeded Command Center vault → ${dest}`);
    console.log(`Personas: ${personas.join(', ')}`);
    console.log(`\nNext: pilot-manager add ${dest}`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

function cmdUpgrade(args) {
  const currentVersion = getInstalledDaemonVersion();
  if (!currentVersion) {
    console.error('Error: daemon not found. Install it first with: npm install -g @radnine/claude-session-daemon');
    process.exit(1);
  }

  const targetVersion = args.version || null;
  const latest = getLatestDaemonVersion();

  if (!targetVersion && currentVersion === latest) {
    console.log(`Daemon is already at the latest version (${currentVersion}).`);
    return;
  }

  if (targetVersion && currentVersion === targetVersion) {
    console.log(`Daemon is already at version ${currentVersion}.`);
    return;
  }

  const target = targetVersion || latest;
  console.log(`Upgrading daemon: ${currentVersion} → ${target}`);

  const newVersion = upgradeDaemon(targetVersion);
  console.log(`Installed daemon version ${newVersion}`);

  // Reinstall all running services to pick up the new binary
  const projects = listProjects();
  const installed = projects.filter(p => getServiceStatus(p.name) !== 'not installed');

  if (installed.length > 0) {
    console.log(`\nRestarting ${installed.length} service(s)...`);
    for (const p of installed) {
      try {
        restartService(p.name);
        const pid = getServicePid(p.name);
        console.log(`  Restarted "${p.name}"${pid ? ` (PID ${pid})` : ''}`);
      } catch (err) {
        console.error(`  Failed "${p.name}": ${err.message}`);
      }
    }
  } else {
    console.log('\nNo installed services to restart.');
  }
}

function cmdVersion() {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(`pilot-manager: @radnine/claude-pilot-manager@${pkg.version}`);

  const daemonEntry = resolveDaemonEntry();
  if (daemonEntry) {
    try {
      const daemonPkg = path.resolve(daemonEntry, '..', '..', 'package.json');
      if (fs.existsSync(daemonPkg)) {
        const dpkg = JSON.parse(fs.readFileSync(daemonPkg, 'utf8'));
        console.log(`daemon:         @radnine/claude-session-daemon@${dpkg.version}`);
      }
    } catch {
      // ignore
    }
  } else {
    console.log('daemon:         not found');
  }

  console.log(`node:           ${process.version}`);

  const projects = listProjects();
  const installed = projects.filter(p => getServiceStatus(p.name) !== 'not installed').length;
  const running = projects.filter(p => getServiceStatus(p.name) === 'running').length;
  console.log(`launchd agents: ${installed} installed, ${running} running`);
}

export async function run(argv) {
  const command = argv[0];
  const rest = argv.slice(1);

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }

  if (command === 'version' || command === '--version') {
    cmdVersion();
    return;
  }

  // Parse flags for subcommands
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        name: { type: 'string' },
        port: { type: 'string' },
        server: { type: 'string' },
        force: { type: 'boolean', default: false },
        reveal: { type: 'boolean', default: false },
        yes: { type: 'boolean', short: 'y', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        stdout: { type: 'boolean', default: false },
        lines: { type: 'string' },
        version: { type: 'string' },
      },
      allowPositionals: true,
      strict: false,
    });
  } catch {
    parsed = { values: {}, positionals: rest };
  }

  if (parsed.values.help) {
    console.log(HELP);
    return;
  }

  switch (command) {
    case 'init':
      await cmdInit(parsed.values);
      break;
    case 'add':
      cmdAdd(parsed.positionals, parsed.values);
      break;
    case 'remove':
      cmdRemove(parsed.positionals);
      break;
    case 'list':
    case 'ls':
      cmdList();
      break;
    case 'scan':
      await cmdScan(parsed.positionals, parsed.values);
      break;
    case 'install':
      cmdInstall(parsed.positionals);
      break;
    case 'uninstall':
      cmdUninstall(parsed.positionals);
      break;
    case 'start':
      cmdStart(parsed.positionals);
      break;
    case 'stop':
      cmdStop(parsed.positionals);
      break;
    case 'restart':
    case 'reinstall':
      cmdRestart(parsed.positionals);
      break;
    case 'logs':
      cmdLogs(parsed.positionals, parsed.values);
      break;
    case 'register':
      await cmdRegister(parsed.positionals, parsed.values);
      break;
    case 'deregister':
      await cmdDeregister(parsed.positionals);
      break;
    case 'token':
      cmdToken(parsed.positionals, parsed.values);
      break;
    case 'setup':
      await cmdSetup(parsed.positionals, parsed.values);
      break;
    case 'seed':
      await cmdSeed(parsed.positionals, parsed.values);
      break;
    case 'upgrade':
      cmdUpgrade(parsed.values);
      break;
    default:
      console.error(`Unknown command: ${command}\nRun "pilot-manager help" for usage.`);
      process.exit(1);
  }
}
