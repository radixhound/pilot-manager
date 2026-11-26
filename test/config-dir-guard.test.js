import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

// A restart, reinstall, install, setup, register refresh or upgrade must never
// silently change a pilot's CLAUDE_CONFIG_DIR or CODEX_HOME (#739).
//
// Isolation: HOME is a temp dir, so projects.yml, config.yml, env/ and
// Library/LaunchAgents all resolve under it (paths.js reads os.homedir() at
// import, after HOME is set below). `launchctl` and `npm` are fakes put first
// on PATH; the fake launchctl logs every call so a test can prove no unload
// happened. fetch is stubbed for register. Nothing touches real launchd, npm
// globals, ~/.config or ~/Library.

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-manager-config-dir-home-'));
const originalHome = process.env.HOME;
const originalPath = process.env.PATH;
const originalFetch = globalThis.fetch;
process.env.HOME = TEST_HOME;

const FAKE_BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-manager-config-dir-bin-'));
const STATE_FILE = path.join(FAKE_BIN, 'launchctl-state.json');
const CALL_LOG = path.join(FAKE_BIN, 'launchctl-calls.log');
const NPM_STATE = path.join(FAKE_BIN, 'npm-state.json');
const GLOBAL_ROOT = path.join(FAKE_BIN, 'global-node-modules');
const DAEMON_DIR = path.join(GLOBAL_ROOT, '@radnine', 'claude-session-daemon');

fs.writeFileSync(path.join(FAKE_BIN, 'launchctl'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const statePath = process.env.PM_FAKE_LAUNCHCTL_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const [cmd, arg] = process.argv.slice(2);
const label = arg ? path.basename(arg, '.plist') : null;
fs.appendFileSync(process.env.PM_FAKE_LAUNCHCTL_LOG, cmd + (label ? ' ' + label : '') + '\\n');
if (cmd === 'list') {
  for (const [l, pid] of Object.entries(state)) process.stdout.write(pid + '\\t0\\t' + l + '\\n');
} else if (cmd === 'load') {
  if (!state[label]) state[label] = 5000 + Object.keys(state).length;
} else if (cmd === 'unload') {
  delete state[label];
} else {
  process.exit(1);
}
fs.writeFileSync(statePath, JSON.stringify(state));
`, { mode: 0o755 });

// Fake npm: `root -g` names the fake global root, `view` reports the latest
// daemon version, `install -g` records the new version in the stub daemon.
fs.writeFileSync(path.join(FAKE_BIN, 'npm'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const state = JSON.parse(fs.readFileSync(process.env.PM_FAKE_NPM_STATE, 'utf8'));
const args = process.argv.slice(2);
const pkgPath = path.join(process.env.PM_FAKE_DAEMON_DIR, 'package.json');
if (args[0] === 'root' && args[1] === '-g') {
  process.stdout.write(process.env.PM_FAKE_GLOBAL_ROOT + '\\n');
} else if (args[0] === 'view') {
  process.stdout.write(state.latest + '\\n');
} else if (args[0] === 'install' && args[1] === '-g') {
  const version = args[2].split('@').pop();
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = version === 'latest' ? state.latest : version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg));
} else {
  process.exit(1);
}
`, { mode: 0o755 });

fs.mkdirSync(path.join(DAEMON_DIR, 'src'), { recursive: true });
fs.writeFileSync(path.join(DAEMON_DIR, 'src', 'index.js'), '// stub\n');

process.env.PATH = `${FAKE_BIN}${path.delimiter}${process.env.PATH}`;
process.env.PM_FAKE_LAUNCHCTL_STATE = STATE_FILE;
process.env.PM_FAKE_LAUNCHCTL_LOG = CALL_LOG;
process.env.PM_FAKE_NPM_STATE = NPM_STATE;
process.env.PM_FAKE_GLOBAL_ROOT = GLOBAL_ROOT;
process.env.PM_FAKE_DAEMON_DIR = DAEMON_DIR;

const { saveConfig } = await import('../src/config.js');
const { CONFIG_DIR, PROJECTS_FILE, ENV_DIR, LAUNCHD_DIR } = await import('../src/paths.js');
const { plistEnvironment, guardConfigDirs, ConfigDirGuardError, generatePlist } = await import('../src/launchd.js');
const { run } = await import('../src/cli.js');

// The guard rails for this file: every path the code writes is under TEST_HOME.
assert.ok(CONFIG_DIR.startsWith(TEST_HOME + path.sep), CONFIG_DIR);
assert.ok(LAUNCHD_DIR.startsWith(TEST_HOME + path.sep), LAUNCHD_DIR);

after(() => {
  process.env.HOME = originalHome;
  process.env.PATH = originalPath;
  globalThis.fetch = originalFetch;
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
  fs.rmSync(FAKE_BIN, { recursive: true, force: true });
});

const SECRET_TOKEN = 'tok_DO-NOT-PRINT-9f8e7d6c5b4a';
const DIRS = {
  a: path.join(TEST_HOME, 'claude-a'),
  b: path.join(TEST_HOME, 'claude-b'),
  codex: path.join(TEST_HOME, 'codex-home'),
  missing: path.join(TEST_HOME, 'no-such-folder'),
};
for (const key of ['a', 'b', 'codex']) fs.mkdirSync(DIRS[key], { recursive: true });

const label = name => `com.radnine.pilot.${name}`;
const plistFile = name => path.join(LAUNCHD_DIR, `${label(name)}.plist`);
const readPlist = name => fs.readFileSync(plistFile(name), 'utf8');

function projectDir(name) {
  const dir = path.join(TEST_HOME, 'repos', name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// projects.yml with these pilots; extraEnv maps name -> extra_env.
function writeProjects(extraEnv) {
  const projects = {};
  let port = 3601;
  for (const [name, env] of Object.entries(extraEnv)) {
    projects[name] = {
      path: projectDir(name),
      port: port++,
      pilot_id: `${name}-pilot-test`,
      auth_token: SECRET_TOKEN,
      auto_restart: true,
      extra_env: env,
    };
  }
  fs.mkdirSync(path.dirname(PROJECTS_FILE), { recursive: true });
  fs.writeFileSync(PROJECTS_FILE, yaml.dump({ projects }));
}

function setLoaded(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}
const loaded = () => JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
const calls = () => (fs.existsSync(CALL_LOG) ? fs.readFileSync(CALL_LOG, 'utf8').trim().split('\n').filter(Boolean) : []);
const changingCalls = () => calls().filter(c => !c.startsWith('list'));

async function cli(argv) {
  const realExit = process.exit;
  const realLog = console.log;
  const realError = console.error;
  const output = [];
  let exitCode = null;
  console.log = (...a) => output.push(a.join(' '));
  console.error = (...a) => output.push(a.join(' '));
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
  const text = output.join('\n');
  assert.ok(!text.includes(SECRET_TOKEN.slice(8)), 'auth token must never be printed');
  return { exitCode, text };
}

// Install the pilots as described, as a first install would, then clear the
// launchctl log so each test sees only its own calls.
async function installed(extraEnv) {
  writeProjects(extraEnv);
  for (const name of Object.keys(extraEnv)) {
    const { exitCode, text } = await cli(['install', name]);
    assert.equal(exitCode, null, text);
  }
  fs.writeFileSync(CALL_LOG, '');
}

// Hand-edit the installed plist the way the Nov 18 fix was made: only in the
// plist, with projects.yml left alone.
function handEditPlist(name, key, value) {
  const xml = readPlist(name);
  const entry = `    <key>${key}</key>\n    <string>${value}</string>\n`;
  fs.writeFileSync(plistFile(name), xml.replace('<key>EnvironmentVariables</key>\n  <dict>\n',
    `<key>EnvironmentVariables</key>\n  <dict>\n${entry}`));
}

function assertUntouched(name, before, text) {
  assert.equal(readPlist(name), before, `plist for ${name} must be unchanged`);
  assert.ok(!changingCalls().some(c => c.endsWith(` ${label(name)}`)),
    `no load/unload for ${name}: ${JSON.stringify(calls())}\n${text}`);
  assert.ok(loaded()[label(name)], `${name} must still be loaded`);
}

beforeEach(() => {
  fs.rmSync(LAUNCHD_DIR, { recursive: true, force: true });
  fs.mkdirSync(LAUNCHD_DIR, { recursive: true });
  fs.rmSync(ENV_DIR, { recursive: true, force: true });
  fs.mkdirSync(ENV_DIR, { recursive: true });
  saveConfig({ server_url: 'http://localhost:3000', base_port: 3601, auto_restart: true });
  setLoaded({});
  fs.writeFileSync(CALL_LOG, '');
  fs.writeFileSync(path.join(DAEMON_DIR, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  fs.writeFileSync(NPM_STATE, JSON.stringify({ latest: '2.0.0' }));
  globalThis.fetch = originalFetch;
});

describe('plistEnvironment', () => {
  it('reads what generatePlist writes, including escaped values', () => {
    const xml = generatePlist('esc', {
      path: '/tmp/esc', port: 3601, pilot_id: 'p', extra_env: { CLAUDE_CONFIG_DIR: '/a & <b>' },
    }, { server_url: 'http://x' }, { daemonEntry: '/opt/d/src/index.js', symlinks: [], exists: () => false });
    assert.equal(plistEnvironment(xml).CLAUDE_CONFIG_DIR, '/a & <b>');
  });

  it('ignores commented-out settings and reads CDATA values', () => {
    const xml = '<key>EnvironmentVariables</key>\n<dict>\n' +
      '<key>CLAUDE_CONFIG_DIR</key><string>/active</string>\n' +
      '<!-- <key>CLAUDE_CONFIG_DIR</key><string>/commented</string> -->\n' +
      '<!-- </dict> --><key>CODEX_HOME</key><string><![CDATA[/c & d]]></string>\n</dict>';
    assert.deepEqual(plistEnvironment(xml), { CLAUDE_CONFIG_DIR: '/active', CODEX_HOME: '/c & d' });
  });

  it('ignores a commented-out EnvironmentVariables block', () => {
    const xml = '<!-- <key>EnvironmentVariables</key><dict><key>CODEX_HOME</key><string>/old</string></dict> -->\n' +
      '<key>EnvironmentVariables</key>\n<dict>\n<key>CODEX_HOME</key><string>/new</string>\n</dict>';
    assert.deepEqual(plistEnvironment(xml), { CODEX_HOME: '/new' });
  });

  it('reads a plutil-style layout with tabs and an empty <string/>', () => {
    const xml = '<dict>\n\t<key>EnvironmentVariables</key>\n\t<dict>\n\t\t<key>CODEX_HOME</key>\n' +
      '\t\t<string>/x/codex</string>\n\t\t<key>EMPTY</key>\n\t\t<string/>\n\t</dict>\n</dict>';
    assert.deepEqual(plistEnvironment(xml), { CODEX_HOME: '/x/codex', EMPTY: '' });
  });
});

describe('restart refuses a changed config folder', () => {
  it('changed: leaves the plist and daemon alone and names pilot, setting, both values and both ways forward', async () => {
    await installed({ viv: { CLAUDE_CONFIG_DIR: DIRS.a } });
    const before = readPlist('viv');
    writeProjects({ viv: { CLAUDE_CONFIG_DIR: DIRS.b } });

    const { exitCode, text } = await cli(['restart', 'viv']);

    assert.equal(exitCode, 1, text);
    assertUntouched('viv', before, text);
    assert.match(text, /"viv"/);
    assert.match(text, /CLAUDE_CONFIG_DIR would change/);
    assert.ok(text.includes(`installed plist:           ${DIRS.a}`), text);
    assert.ok(text.includes(`pilot-manager would write: ${DIRS.b}`), text);
    assert.ok(text.includes(`set CLAUDE_CONFIG_DIR: ${DIRS.a} under extra_env`), text);
    assert.ok(text.includes(PROJECTS_FILE), text);
    assert.ok(text.includes(path.join(ENV_DIR, 'viv.env')), text);
    assert.match(text, /re-run with --accept-config-dir-change/);
  });

  it('removed: a value set only in the plist (the Nov 18 case) is not dropped', async () => {
    await installed({ viv: {} });
    handEditPlist('viv', 'CLAUDE_CONFIG_DIR', DIRS.a);
    const before = readPlist('viv');

    const { exitCode, text } = await cli(['reinstall', 'viv']);

    assert.equal(exitCode, 1, text);
    assertUntouched('viv', before, text);
    assert.ok(text.includes(`installed plist:           ${DIRS.a}`), text);
    assert.ok(text.includes('pilot-manager would write: (not set)'), text);
  });

  it('added: a new CODEX_HOME is not written over a plist without one', async () => {
    await installed({ viv: {} });
    const before = readPlist('viv');
    writeProjects({ viv: { CODEX_HOME: DIRS.codex } });

    const { exitCode, text } = await cli(['restart', 'viv']);

    assert.equal(exitCode, 1, text);
    assertUntouched('viv', before, text);
    assert.match(text, /CODEX_HOME would change/);
    assert.ok(text.includes('installed plist:           (not set)'), text);
    assert.match(text, /To keep it unset, remove CODEX_HOME/);
  });

  it('a change that comes from the env file is caught too', async () => {
    await installed({ viv: {} });
    const before = readPlist('viv');
    fs.writeFileSync(path.join(ENV_DIR, '_default.env'), `CLAUDE_CONFIG_DIR=${DIRS.b}\n`);

    const { exitCode, text } = await cli(['restart', 'viv']);

    assert.equal(exitCode, 1, text);
    assertUntouched('viv', before, text);
  });

  it('a commented-out value after the active one does not hide a change', async () => {
    await installed({ viv: { CLAUDE_CONFIG_DIR: DIRS.a } });
    const xml = readPlist('viv').replace(
      `<string>${DIRS.a}</string>\n`,
      `<string>${DIRS.a}</string>\n    <!-- <key>CLAUDE_CONFIG_DIR</key><string>${DIRS.b}</string> -->\n`);
    fs.writeFileSync(plistFile('viv'), xml);
    const before = readPlist('viv');
    writeProjects({ viv: { CLAUDE_CONFIG_DIR: DIRS.b } });

    const { exitCode, text } = await cli(['restart', 'viv']);

    assert.equal(exitCode, 1, text);
    assertUntouched('viv', before, text);
    assert.ok(text.includes(`installed plist:           ${DIRS.a}`), text);
    assert.ok(text.includes(`pilot-manager would write: ${DIRS.b}`), text);
  });

  it('--accept-config-dir-change writes the new value and restarts', async () => {
    await installed({ viv: { CLAUDE_CONFIG_DIR: DIRS.a } });
    writeProjects({ viv: { CLAUDE_CONFIG_DIR: DIRS.b } });

    const { exitCode, text } = await cli(['restart', 'viv', '--accept-config-dir-change']);

    assert.equal(exitCode, null, text);
    assert.equal(plistEnvironment(readPlist('viv')).CLAUDE_CONFIG_DIR, DIRS.b);
    assert.deepEqual(changingCalls(), [`unload ${label('viv')}`, `load ${label('viv')}`]);
  });

  it('unchanged values restart as before', async () => {
    await installed({ viv: { CLAUDE_CONFIG_DIR: DIRS.a, CODEX_HOME: DIRS.codex } });

    const { exitCode, text } = await cli(['restart', 'viv']);

    assert.equal(exitCode, null, text);
    assert.match(text, /Restarted "viv"/);
    assert.deepEqual(changingCalls(), [`unload ${label('viv')}`, `load ${label('viv')}`]);
  });
});

describe('a folder that does not exist', () => {
  it('is refused before unloading, even with the value unchanged', async () => {
    await installed({ viv: { CLAUDE_CONFIG_DIR: DIRS.a } });
    handEditPlist('viv', 'CODEX_HOME', DIRS.missing);
    writeProjects({ viv: { CLAUDE_CONFIG_DIR: DIRS.a, CODEX_HOME: DIRS.missing } });
    const before = readPlist('viv');

    const { exitCode, text } = await cli(['restart', 'viv']);

    assert.equal(exitCode, 1, text);
    assertUntouched('viv', before, text);
    assert.ok(text.includes(`CODEX_HOME names a folder that does not exist: ${DIRS.missing}`), text);
  });

  it('is refused even with --accept-config-dir-change', async () => {
    await installed({ viv: { CLAUDE_CONFIG_DIR: DIRS.a } });
    const before = readPlist('viv');
    writeProjects({ viv: { CLAUDE_CONFIG_DIR: DIRS.missing } });

    const { exitCode, text } = await cli(['restart', 'viv', '--accept-config-dir-change']);

    assert.equal(exitCode, 1, text);
    assertUntouched('viv', before, text);
    assert.match(text, /--accept-config-dir-change does not skip this check/);
    assert.ok(text.includes(`installed plist:           ${DIRS.a}`), text);
    assert.ok(text.includes(`pilot-manager would write: ${DIRS.missing}`), text);
  });

  it('a file in place of the folder counts as missing', async () => {
    await installed({ viv: { CLAUDE_CONFIG_DIR: DIRS.a } });
    const before = readPlist('viv');
    const file = path.join(TEST_HOME, 'not-a-dir');
    fs.writeFileSync(file, '');
    writeProjects({ viv: { CLAUDE_CONFIG_DIR: file } });

    const { exitCode, text } = await cli(['restart', 'viv', '--accept-config-dir-change']);

    assert.equal(exitCode, 1, text);
    assertUntouched('viv', before, text);
  });
});

describe('install', () => {
  it('first install writes the configured folders as before', async () => {
    writeProjects({ viv: { CLAUDE_CONFIG_DIR: DIRS.a, CODEX_HOME: DIRS.codex } });

    const { exitCode, text } = await cli(['install', 'viv']);

    assert.equal(exitCode, null, text);
    const env = plistEnvironment(readPlist('viv'));
    assert.equal(env.CLAUDE_CONFIG_DIR, DIRS.a);
    assert.equal(env.CODEX_HOME, DIRS.codex);
    assert.deepEqual(changingCalls(), [`load ${label('viv')}`]);
  });

  it('refuses on a loaded pilot without unloading it', async () => {
    await installed({ viv: { CLAUDE_CONFIG_DIR: DIRS.a } });
    const before = readPlist('viv');
    writeProjects({ viv: { CLAUDE_CONFIG_DIR: DIRS.b } });

    const { exitCode, text } = await cli(['install', 'viv']);

    assert.equal(exitCode, 1, text);
    assertUntouched('viv', before, text);
  });

  it('refuses on an installed but unloaded pilot without rewriting its plist', async () => {
    await installed({ viv: { CLAUDE_CONFIG_DIR: DIRS.a } });
    setLoaded({});
    const before = readPlist('viv');
    writeProjects({ viv: { CLAUDE_CONFIG_DIR: DIRS.b } });

    const { exitCode, text } = await cli(['install', 'viv']);

    assert.equal(exitCode, 1, text);
    assert.equal(readPlist('viv'), before);
    assert.deepEqual(changingCalls(), []);
  });

  it('install of all pilots installs the others and exits non-zero', async () => {
    await installed({ viv: { CLAUDE_CONFIG_DIR: DIRS.a }, other: {} });
    const before = readPlist('viv');
    writeProjects({ viv: { CLAUDE_CONFIG_DIR: DIRS.b }, other: {} });

    const { exitCode, text } = await cli(['install']);

    assert.equal(exitCode, 1, text);
    assertUntouched('viv', before, text);
    assert.match(text, /Installed "other"/);
    assert.deepEqual(changingCalls(), [`unload ${label('other')}`, `load ${label('other')}`]);
  });
});

describe('several pilots', () => {
  it('restart with no name restarts the others and exits non-zero', async () => {
    await installed({ alpha: {}, viv: { CLAUDE_CONFIG_DIR: DIRS.a }, zulu: {} });
    const before = readPlist('viv');
    writeProjects({ alpha: {}, viv: { CLAUDE_CONFIG_DIR: DIRS.b }, zulu: {} });

    const { exitCode, text } = await cli(['restart']);

    assert.equal(exitCode, 1, text);
    assertUntouched('viv', before, text);
    assert.match(text, /Restarted "alpha"/);
    assert.match(text, /Restarted "zulu"/);
    assert.match(text, /Left unchanged: viv/);
    assert.deepEqual(changingCalls(), [
      `unload ${label('alpha')}`, `load ${label('alpha')}`,
      `unload ${label('zulu')}`, `load ${label('zulu')}`,
    ]);
  });

  it('upgrade restarts the others and exits non-zero', async () => {
    await installed({ alpha: {}, viv: { CLAUDE_CONFIG_DIR: DIRS.a } });
    const before = readPlist('viv');
    writeProjects({ alpha: {}, viv: { CLAUDE_CONFIG_DIR: DIRS.b } });

    const { exitCode, text } = await cli(['upgrade']);

    assert.equal(exitCode, 1, text);
    assert.match(text, /Installed daemon version 2\.0\.0/);
    assertUntouched('viv', before, text);
    assert.match(text, /Restarted "alpha"/);
    assert.deepEqual(changingCalls(), [`unload ${label('alpha')}`, `load ${label('alpha')}`]);
  });

  it('upgrade with the accept flag restarts every pilot', async () => {
    await installed({ alpha: {}, viv: { CLAUDE_CONFIG_DIR: DIRS.a } });
    writeProjects({ alpha: {}, viv: { CLAUDE_CONFIG_DIR: DIRS.b } });

    const { exitCode, text } = await cli(['upgrade', '--accept-config-dir-change']);

    assert.equal(exitCode, null, text);
    assert.equal(plistEnvironment(readPlist('viv')).CLAUDE_CONFIG_DIR, DIRS.b);
  });
});

describe('register and setup', () => {
  const NEW_TOKEN = 'newtok00-REST-NOT-PRINTED';
  const mockRegister = () => {
    globalThis.fetch = async () => ({
      status: 201,
      json: async () => ({ pilot: { pilot_id: 'viv-pilot-test' }, authentication: { api_key: NEW_TOKEN } }),
    });
  };

  it("register's service refresh reports the refusal with a retry command and leaves the service alone", async () => {
    await installed({ viv: { CLAUDE_CONFIG_DIR: DIRS.a } });
    const before = readPlist('viv');
    writeProjects({ viv: { CLAUDE_CONFIG_DIR: DIRS.b } });
    mockRegister();

    const { text } = await cli(['register', 'viv', '--force']);

    assertUntouched('viv', before, text);
    assert.ok(!text.includes(NEW_TOKEN.slice(8)), 'new token must not be printed');
    assert.match(text, /Token saved/);
    assert.match(text, /CLAUDE_CONFIG_DIR would change/);
    assert.match(text, /retry: pilot-manager reinstall viv/);
  });

  it('register --accept-config-dir-change refreshes the service', async () => {
    await installed({ viv: { CLAUDE_CONFIG_DIR: DIRS.a } });
    writeProjects({ viv: { CLAUDE_CONFIG_DIR: DIRS.b } });
    mockRegister();

    const { text } = await cli(['register', 'viv', '--force', '--accept-config-dir-change']);

    assert.match(text, /Reinstalled service "viv"/);
    assert.equal(plistEnvironment(readPlist('viv')).CLAUDE_CONFIG_DIR, DIRS.b);
  });

  it('setup <path> --name on an installed pilot refuses and exits non-zero', async () => {
    await installed({ viv: { CLAUDE_CONFIG_DIR: DIRS.a } });
    const before = readPlist('viv');
    writeProjects({ viv: { CLAUDE_CONFIG_DIR: DIRS.b } });

    const { exitCode, text } = await cli(['setup', projectDir('viv'), '--name', 'viv']);

    assert.equal(exitCode, 1, text);
    assertUntouched('viv', before, text);
    assert.match(text, /CLAUDE_CONFIG_DIR would change/);
  });
});

describe('guardConfigDirs', () => {
  it('refuses an installed plist it cannot read', () => {
    const bad = path.join(TEST_HOME, 'bad.plist');
    fs.writeFileSync(bad, 'bplist00 not really');
    assert.throws(
      () => guardConfigDirs('x', '<dict/>', { installedPath: bad }),
      err => err instanceof ConfigDirGuardError && /could not read the installed plist/.test(err.message),
    );
  });

  it('passes when there is no installed plist', () => {
    assert.doesNotThrow(() => guardConfigDirs('x', '<dict/>', {
      installedPath: path.join(TEST_HOME, 'none.plist'),
    }));
  });
});

describe('help', () => {
  it('lists the accept flag', async () => {
    const { text } = await cli(['help']);
    assert.match(text, /--accept-config-dir-change/);
  });
});
