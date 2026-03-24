import { parseArgs } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import { execSync } from 'node:child_process';
import { loadConfig, saveConfig } from './config.js';
import { addProject, removeProject, listProjects, getProject } from './registry.js';
import { ensureConfigDir, LOGS_DIR } from './paths.js';
import {
  installService, uninstallService, restartService,
  installAll, uninstallAll,
  getServiceStatus, getServicePid,
  logPath, plistPath, resolveDaemonEntry,
} from './launchd.js';
import {
  registerProject, deregisterProject, registerAll,
  checkTokenStatus,
} from './registrar.js';

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
  setup <dir> [--server URL] [--yes]  Scan + register + install in one step

Other:
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

async function cmdRegister(positionals, args) {
  const options = {};
  if (args.server) options.server = args.server;
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
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  } else {
    const results = await registerAll(options);
    for (const r of results) {
      if (r.success) {
        console.log(`Registered "${r.name}" — token: ${r.auth_token?.slice(0, 8)}...`);
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

async function cmdSetup(positionals, args) {
  const parentDir = positionals[0];
  if (!parentDir) {
    console.error('Error: parent directory is required. Usage: pilot-manager setup <dir> [--server URL] [--yes]');
    process.exit(1);
  }

  // Step 1: Init if needed
  const config = loadConfig();
  if (args.server) {
    config.server_url = args.server;
    saveConfig(config);
  }
  ensureConfigDir();

  // Step 2: Scan
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
    default:
      console.error(`Unknown command: ${command}\nRun "pilot-manager help" for usage.`);
      process.exit(1);
  }
}
