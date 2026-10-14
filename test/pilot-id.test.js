import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

// New pilot ids carry both the machine and the macOS user. Ids already in
// projects.yml must survive add/scan/setup/install untouched, because live
// pilots are registered under them.
//
// Everything runs against a temp HOME. launchctl is faked on PATH (as in
// install-recovery.test.js), and the daemon entry is found through a fake
// `claude-session-daemon` shim on PATH, so no real launchd state or global
// install is touched.

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-manager-pilot-id-home-'));
const originalHome = process.env.HOME;
const originalPath = process.env.PATH;
process.env.HOME = TEST_HOME;
fs.mkdirSync(path.join(TEST_HOME, 'Library', 'LaunchAgents'), { recursive: true });

const FAKE_BIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-manager-pilot-id-bin-'));
const STATE_FILE = path.join(FAKE_BIN_DIR, 'state.json');
fs.writeFileSync(STATE_FILE, JSON.stringify({}));

// Fake launchctl keyed by label: load starts the job with a pid, unload stops it.
fs.writeFileSync(path.join(FAKE_BIN_DIR, 'launchctl'), `#!/usr/bin/env node
const fs = require('node:fs');
const statePath = process.env.PM_FAKE_LAUNCHCTL_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const [cmd, arg] = process.argv.slice(2);
const label = arg ? require('node:path').basename(arg, '.plist') : null;
if (cmd === 'list') {
  for (const [l, pid] of Object.entries(state)) process.stdout.write(pid + '\\t0\\t' + l + '\\n');
} else if (cmd === 'load') {
  state[label] = state[label] || 4242;
} else if (cmd === 'unload') {
  delete state[label];
} else {
  process.exit(1);
}
fs.writeFileSync(statePath, JSON.stringify(state));
`, { mode: 0o755 });
fs.mkdirSync(path.join(FAKE_BIN_DIR, 'daemon-stub', 'src'), { recursive: true });
fs.writeFileSync(path.join(FAKE_BIN_DIR, 'daemon-stub', 'src', 'index.js'), '// stub\n');
fs.writeFileSync(path.join(FAKE_BIN_DIR, 'claude-session-daemon'),
  "#!/usr/bin/env node\nrequire('./daemon-stub/src/index.js');\n", { mode: 0o755 });

process.env.PATH = `${FAKE_BIN_DIR}${path.delimiter}${process.env.PATH}`;
process.env.PM_FAKE_LAUNCHCTL_STATE = STATE_FILE;

const { mintPilotId } = await import('../src/registry.js');
const { saveConfig } = await import('../src/config.js');
const { run } = await import('../src/cli.js');

const PROJECTS_FILE = path.join(TEST_HOME, '.config', 'claude-pilot-manager', 'projects.yml');
const LEGACY_ID = 'legacy-pilot-old-mini';

after(() => {
  process.env.HOME = originalHome;
  process.env.PATH = originalPath;
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
  fs.rmSync(FAKE_BIN_DIR, { recursive: true, force: true });
});

function readProjects() {
  return yaml.load(fs.readFileSync(PROJECTS_FILE, 'utf8')).projects;
}

async function runQuiet(argv) {
  const realExit = process.exit;
  const realLog = console.log;
  const realError = console.error;
  const output = [];
  let exitCode = null;
  console.log = line => output.push(String(line));
  console.error = line => output.push(String(line));
  process.exit = code => {
    exitCode = code;
    const err = new Error(`exit ${code}`);
    err.__isExit = true;
    throw err;
  };
  try {
    await run(argv);
  } catch (err) {
    if (!err.__isExit) throw err;
  } finally {
    process.exit = realExit;
    console.log = realLog;
    console.error = realError;
  }
  return { exitCode, output };
}

describe('mintPilotId', () => {
  it('is <name>-pilot-<hostname>-<user>', () => {
    assert.equal(mintPilotId('vivlio-manager', { hostname: 'Chriss-Mac-mini.local', username: 'chrisd' }),
      'vivlio-manager-pilot-Chriss-Mac-mini.local-chrisd');
  });

  it('defaults to this machine and this macOS user', () => {
    assert.equal(mintPilotId('p'), `p-pilot-${os.hostname()}-${os.userInfo().username}`);
  });

  it('gives two users on the same host different ids that share the host prefix', () => {
    const a = mintPilotId('vivlio-manager', { hostname: 'studio', username: 'chrisd' });
    const b = mintPilotId('vivlio-manager', { hostname: 'studio', username: 'agent' });
    assert.notEqual(a, b);
    assert.ok(a.startsWith('vivlio-manager-pilot-studio-'));
    assert.ok(b.startsWith('vivlio-manager-pilot-studio-'));
  });

  it('gives the same user on two hosts different ids', () => {
    assert.notEqual(
      mintPilotId('p', { hostname: 'studio', username: 'chrisd' }),
      mintPilotId('p', { hostname: 'mini', username: 'chrisd' }),
    );
  });

  it('turns characters unsafe in a URL query value into -', () => {
    const id = mintPilotId('p', { hostname: 'my mac&co', username: 'jo smith?x=1#y' });
    assert.equal(id, 'p-pilot-my-mac-co-jo-smith-x-1-y');
    assert.equal(encodeURIComponent(id), id);
  });
});

describe('existing pilot ids are never rewritten', () => {
  const legacyPath = path.join(TEST_HOME, 'repos', 'legacy');
  const freshPath = path.join(TEST_HOME, 'repos', 'fresh');
  fs.mkdirSync(legacyPath, { recursive: true });
  fs.mkdirSync(freshPath, { recursive: true });
  // scan only picks up dirs with a project marker
  fs.writeFileSync(path.join(legacyPath, 'CLAUDE.md'), '');
  fs.writeFileSync(path.join(freshPath, 'CLAUDE.md'), '');
  fs.mkdirSync(path.dirname(PROJECTS_FILE), { recursive: true });
  saveConfig({ server_url: 'http://localhost:3000', base_port: 3601, auto_restart: true });
  fs.writeFileSync(PROJECTS_FILE, yaml.dump({
    projects: {
      legacy: {
        path: legacyPath,
        port: 3601,
        pilot_id: LEGACY_ID,
        auth_token: 'existing-token',
        auto_restart: true,
        extra_env: {},
      },
    },
  }));

  it('add refuses the existing name and leaves its id alone', async () => {
    const { exitCode } = await runQuiet(['add', legacyPath]);
    assert.equal(exitCode, 1);
    assert.equal(readProjects().legacy.pilot_id, LEGACY_ID);
  });

  it('scan skips the existing project and mints the new format only for the new one', async () => {
    await runQuiet(['scan', path.join(TEST_HOME, 'repos'), '--yes']);
    const projects = readProjects();
    assert.equal(projects.legacy.pilot_id, LEGACY_ID);
    assert.equal(projects.fresh.pilot_id, mintPilotId('fresh'));
  });

  it('setup <path> --name reuses the existing entry and keeps its id', async () => {
    const { exitCode, output } = await runQuiet(['setup', legacyPath, '--name', 'legacy']);
    assert.equal(exitCode, null, output.join('\n'));
    assert.equal(readProjects().legacy.pilot_id, LEGACY_ID);
  });

  it('install bakes the stored id into the plist and leaves projects.yml alone', async () => {
    const { exitCode, output } = await runQuiet(['install', 'legacy']);
    assert.equal(exitCode, null, output.join('\n'));
    assert.equal(readProjects().legacy.pilot_id, LEGACY_ID);
    const plist = fs.readFileSync(
      path.join(TEST_HOME, 'Library', 'LaunchAgents', 'com.radnine.pilot.legacy.plist'), 'utf8');
    assert.match(plist, new RegExp(`<string>${LEGACY_ID}</string>`));
  });
});
