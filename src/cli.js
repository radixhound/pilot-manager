import { parseArgs } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import { loadConfig, saveConfig } from './config.js';
import { addProject, removeProject, listProjects, getProject } from './registry.js';
import { ensureConfigDir } from './paths.js';

const HELP = `
pilot-manager — Per-machine supervisor for claude-session-daemon instances

Usage: pilot-manager <command> [options]

Commands:
  init                           Interactive setup, writes config.yml
  add <path> [--name X] [--port N]  Add a project to the registry
  remove <name>                  Remove a project from the registry
  list                           List all registered projects
  scan <parent-dir> [--yes]      Auto-discover projects in subdirs
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
  const pathWidth = Math.max(4, ...projects.map(p => p.path.length)) + 2;

  const header = [
    'NAME'.padEnd(nameWidth),
    'PORT'.padEnd(portWidth),
    'PATH'.padEnd(pathWidth),
    'STATUS',
  ].join('  ');

  console.log(header);

  for (const p of projects) {
    const status = 'not installed'; // Phase 2 will enhance this
    const line = [
      p.name.padEnd(nameWidth),
      String(p.port).padEnd(portWidth),
      p.path.padEnd(pathWidth),
      status,
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

function cmdVersion() {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(`pilot-manager: @radnine/claude-pilot-manager@${pkg.version}`);
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
    default:
      console.error(`Unknown command: ${command}\nRun "pilot-manager help" for usage.`);
      process.exit(1);
  }
}
