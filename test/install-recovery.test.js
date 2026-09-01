import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// This test reproduces a specific bug: `pilot-manager install <name>` on a
// service that's already loaded (e.g. stuck/wedged) routes through a bare
// `launchctl load`. Real launchctl treats loading an already-loaded job as a
// silent no-op — no error, but no reload either — so a stuck daemon's stale
// pid gets reported right back as a false "Installed" success. `restart`
// avoids this by unloading first; `install` didn't.
//
// Exercising this against real launchctl would mutate real launchd state on
// the machine running the test, so a fake `launchctl` is put earlier on PATH.
// execSync resolves it via the shell exactly like the real binary, so the
// code under test (installService/restartService/getServicePid/etc.) runs
// completely unmodified and unaware it's talking to a fake.

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-manager-install-recovery-home-'));
const originalHome = process.env.HOME;
process.env.HOME = TEST_HOME;
fs.mkdirSync(path.join(TEST_HOME, 'Library', 'LaunchAgents'), { recursive: true });

const FAKE_BIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-manager-fake-launchctl-'));
const STATE_FILE = path.join(FAKE_BIN_DIR, 'state.json');
const LABEL = 'com.radnine.pilot.demo-project';

// A fake `launchctl` that tracks {loaded, pid} in a JSON state file:
//   list   -> prints a `launchctl list`-style line when loaded, pid column
//             is "-" when loaded-but-not-running (mirrors real launchctl).
//   load   -> if already loaded: no-op (mirrors real launchctl's silent
//             "already loaded" behavior). If not loaded: starts it, landing
//             on a fresh pid, UNLESS state.bootstrapFail is set, in which
//             case it "loads" but never comes up (pid stays null) — this is
//             the "reload/bootstrap fails" case the fix must catch.
//   unload -> always clears loaded/pid.
const FAKE_LAUNCHCTL_SOURCE = `#!/usr/bin/env node
const fs = require('node:fs');
const statePath = process.env.PM_FAKE_LAUNCHCTL_STATE;
const cmd = process.argv[2];
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));

function save() { fs.writeFileSync(statePath, JSON.stringify(state)); }

if (cmd === 'list') {
  if (state.loaded) {
    const pidField = state.pid != null ? String(state.pid) : '-';
    process.stdout.write(pidField + '\\t0\\t' + state.label + '\\n');
  }
  process.exit(0);
} else if (cmd === 'load') {
  if (!state.loaded) {
    state.loaded = true;
    state.pid = state.bootstrapFail ? null : (state.nextPid || 4242);
    save();
  }
  // else: already loaded -> silent no-op, exactly like real launchctl.
  process.exit(0);
} else if (cmd === 'unload') {
  state.loaded = false;
  state.pid = null;
  save();
  process.exit(0);
} else {
  process.exit(1);
}
`;

const FAKE_LAUNCHCTL_PATH = path.join(FAKE_BIN_DIR, 'launchctl');
fs.writeFileSync(FAKE_LAUNCHCTL_PATH, FAKE_LAUNCHCTL_SOURCE);
fs.chmodSync(FAKE_LAUNCHCTL_PATH, 0o755);

process.env.PATH = `${FAKE_BIN_DIR}${path.delimiter}${process.env.PATH}`;
process.env.PM_FAKE_LAUNCHCTL_STATE = STATE_FILE;

function setState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ label: LABEL, ...state }));
}

// generatePlist refuses to run unless it can find @radnine/claude-session-daemon
// (global install, local dev checkout, or a `which` shim). Stub the "local
// dev" candidate so this test doesn't depend on what's globally installed on
// whatever machine runs it (dev box vs. CI runner).
const DAEMON_STUB_DIR = path.join(process.cwd(), 'node_modules', '@radnine', 'claude-session-daemon', 'src');
const DAEMON_STUB_FILE = path.join(DAEMON_STUB_DIR, 'index.js');
const daemonStubPreexisting = fs.existsSync(DAEMON_STUB_FILE);
if (!daemonStubPreexisting) {
  fs.mkdirSync(DAEMON_STUB_DIR, { recursive: true });
  fs.writeFileSync(DAEMON_STUB_FILE, '// test stub for @radnine/claude-session-daemon\n');
}

const { addProject } = await import('../src/registry.js');
const { saveConfig } = await import('../src/config.js');
const { run } = await import('../src/cli.js');

saveConfig({ server_url: 'http://localhost:3000', base_port: 3601, auto_restart: true });
addProject('demo-project', '/tmp/demo-project', { port: 3601 });

const realExit = process.exit;
const realLog = console.log;
const realError = console.error;

async function captureInstall() {
  const logs = [];
  const errors = [];
  let exitCode = null;
  console.log = line => logs.push(String(line));
  console.error = line => errors.push(String(line));
  process.exit = code => {
    exitCode = code;
    const err = new Error(`exit ${code}`);
    err.__isExit = true;
    throw err;
  };
  try {
    await run(['install', 'demo-project']);
  } catch (err) {
    if (!err.__isExit) throw err;
  } finally {
    console.log = realLog;
    console.error = realError;
    process.exit = realExit;
  }
  return { logs, errors, exitCode };
}

describe('install recovers a stuck/already-loaded service', () => {
  it('does not report a false "Installed" success when a stuck service fails to come back up', async () => {
    setState({ loaded: true, pid: 999, bootstrapFail: true });
    const { logs, errors, exitCode } = await captureInstall();

    assert.equal(
      exitCode, 1,
      `expected install to report failure, got logs=${JSON.stringify(logs)} errors=${JSON.stringify(errors)}`,
    );
    assert.ok(
      !logs.some(l => l.includes('Installed')),
      `must not report a false "Installed" success: ${JSON.stringify(logs)}`,
    );
  });

  it('reports the fresh pid (not the stale one) when a stuck service reloads successfully', async () => {
    setState({ loaded: true, pid: 999, bootstrapFail: false, nextPid: 4242 });
    const { logs, errors, exitCode } = await captureInstall();

    assert.equal(exitCode, null, `expected success, got errors=${JSON.stringify(errors)}`);
    assert.ok(logs.some(l => l.includes('PID 4242')), `expected the fresh pid reported: ${JSON.stringify(logs)}`);
    assert.ok(!logs.some(l => l.includes('PID 999')), `must not report the stale pid: ${JSON.stringify(logs)}`);
  });

  it('still installs a service that was not previously loaded', async () => {
    setState({ loaded: false, pid: null, bootstrapFail: false, nextPid: 555 });
    const { logs, errors, exitCode } = await captureInstall();

    assert.equal(exitCode, null, `expected success, got errors=${JSON.stringify(errors)}`);
    assert.ok(logs.some(l => l.includes('PID 555')), `expected the fresh pid reported: ${JSON.stringify(logs)}`);
  });
});

after(() => {
  process.env.HOME = originalHome;
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
  fs.rmSync(FAKE_BIN_DIR, { recursive: true, force: true });
  if (!daemonStubPreexisting) {
    fs.rmSync(path.join(process.cwd(), 'node_modules', '@radnine'), { recursive: true, force: true });
  }
});
