import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const TEST_DIR = path.join(os.tmpdir(), `pilot-manager-launchd-test-${Date.now()}`);
const origHome = process.env.HOME;

process.env.HOME = TEST_DIR;
fs.mkdirSync(path.join(TEST_DIR, '.config', 'claude-pilot-manager', 'env'), { recursive: true });
fs.mkdirSync(path.join(TEST_DIR, '.config', 'claude-pilot-manager', 'logs'), { recursive: true });
fs.mkdirSync(path.join(TEST_DIR, 'Library', 'LaunchAgents'), { recursive: true });

const {
  generatePlist, plistPath, resolveNodeBinary, resolveDaemonEntry, planServiceRefresh,
  stablePathEnv, isVersionedPath,
} = await import('../src/launchd.js');
const { saveConfig } = await import('../src/config.js');
const { addProject } = await import('../src/registry.js');

// Keeps generatePlist off the host's node install: no stable path exists, and
// the daemon entry is given.
const HERMETIC = {
  daemonEntry: '/opt/pm-test/daemon/src/index.js',
  symlinks: [],
  exists: () => false,
};

describe('Plist Generation', () => {
  before(() => {
    saveConfig({ server_url: 'http://localhost:3000', base_port: 3601, auto_restart: true });
  });

  it('generates valid plist XML', () => {
    const projectConfig = {
      path: '/tmp/test-project',
      port: 3601,
      pilot_id: 'test-pilot',
      auth_token: 'abc123',
      auto_restart: true,
      extra_env: {},
    };
    const globalConfig = {
      server_url: 'http://localhost:3000',
      auto_restart: true,
    };

    // This may throw if daemon not found — skip gracefully
    let plist;
    try {
      plist = generatePlist('test-project', projectConfig, globalConfig, HERMETIC);
    } catch (err) {
      if (err.message.includes('Cannot find')) {
        // Daemon not installed globally — test plist structure won't work
        // but we can still test other aspects
        return;
      }
      throw err;
    }

    assert.ok(plist.includes('<?xml version="1.0"'));
    assert.ok(plist.includes('com.radnine.pilot.test-project'));
    assert.ok(plist.includes('<key>CLAUDE_DAEMON_PORT</key>'));
    assert.ok(plist.includes('<string>3601</string>'));
    assert.ok(plist.includes('<key>CLAUDE_AUTH_TOKEN</key>'));
    assert.ok(plist.includes('<string>abc123</string>'));
    assert.ok(plist.includes('<key>KeepAlive</key>'));
    assert.ok(plist.includes('<true/>'));
    assert.ok(plist.includes('ThrottleInterval'));
  });

  it('uses correct plist path', () => {
    const pp = plistPath('my-project');
    assert.ok(pp.endsWith('com.radnine.pilot.my-project.plist'));
    assert.ok(pp.includes('LaunchAgents'));
  });

  it('resolves node binary', () => {
    const nodeBin = resolveNodeBinary(HERMETIC);
    assert.ok(nodeBin.includes('node'));
    assert.ok(fs.existsSync(nodeBin));
  });

  it('sanitizes project names in labels', () => {
    const pp = plistPath('My Project With Spaces!');
    assert.ok(pp.includes('com.radnine.pilot.my-project-with-spaces-'));
  });

  it('handles auto_restart false', () => {
    const projectConfig = {
      path: '/tmp/test-project',
      port: 3601,
      pilot_id: 'test-pilot',
      auth_token: null,
      auto_restart: false,
      extra_env: {},
    };
    const globalConfig = { server_url: 'http://localhost:3000', auto_restart: true };

    let plist;
    try {
      plist = generatePlist('no-restart', projectConfig, globalConfig, HERMETIC);
    } catch (err) {
      if (err.message.includes('Cannot find')) return;
      throw err;
    }

    assert.ok(plist.includes('<false/>'));
  });
});

describe('planServiceRefresh (token-changed decision)', () => {
  it('skips refresh when no service is installed', () => {
    const plan = planServiceRefresh('not installed');
    assert.equal(plan.action, 'skip');
    assert.equal(plan.installed, false);
  });

  it('reinstalls when the service is installed but not running', () => {
    const plan = planServiceRefresh('installed');
    assert.equal(plan.action, 'reinstall');
    assert.equal(plan.installed, true);
  });

  it('reinstalls when the service is currently running', () => {
    const plan = planServiceRefresh('running');
    assert.equal(plan.action, 'reinstall');
    assert.equal(plan.installed, true);
  });
});

after(() => {
  process.env.HOME = origHome;
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// #435: plists survive a node version change.
//
// Each test builds a fake node install in a temp dir, generates a plist from
// it, then replaces that node version (new version in, old version deleted)
// and checks the plist still names something that exists. Nothing reads or
// runs the host's own node managers: the running node is a temp file, and the
// shim probe is injected.
// ---------------------------------------------------------------------------

const PROJECT = {
  path: '/tmp/test-project',
  port: 3601,
  pilot_id: 'test-pilot',
  auth_token: null,
  auto_restart: true,
  extra_env: {},
};
const GLOBAL = { server_url: 'http://localhost:3000', auto_restart: true };
const DAEMON = path.join('@radnine', 'claude-session-daemon', 'src', 'index.js');

function tempRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pm-435-')));
}

function writeFile(file, content = '#!/bin/sh\n', mode = 0o755) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  fs.chmodSync(file, mode);
  return file;
}

// A node install at <prefix>/bin/node with the daemon in <prefix>/lib/node_modules.
function installNode(prefix) {
  writeFile(path.join(prefix, 'lib', 'node_modules', DAEMON), '// daemon\n', 0o644);
  return writeFile(path.join(prefix, 'bin', 'node'));
}

function relink(link, target) {
  fs.rmSync(link, { force: true });
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link);
}

function unescapeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function programArgs(plist) {
  const block = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)[1];
  return [...block.matchAll(/<string>([\s\S]*?)<\/string>/g)].map(m => unescapeXml(m[1]));
}

function plistEnv(plist, key) {
  const m = plist.match(new RegExp(`<key>${key}</key>\\s*<string>([\\s\\S]*?)</string>`));
  return m ? unescapeXml(m[1]) : undefined;
}

// Every path the plist names, minus the inline launch script.
function namedPaths(args) {
  return args[0] === '/bin/sh' ? args.slice(3) : args;
}

function assertNoVersionedPaths(args, oldVersion) {
  for (const arg of namedPaths(args)) {
    assert.ok(!isVersionedPath(arg), `versioned path in ProgramArguments: ${arg}`);
    assert.ok(!arg.includes(oldVersion), `old version ${oldVersion} named in ProgramArguments: ${arg}`);
  }
}

// The node command in the plist: everything but a trailing daemon entry.
function nodeCommand(args) {
  return args[0] === '/bin/sh' ? args.slice(4) : args.slice(0, -1);
}

describe('#435 stable node path: one test per version manager', () => {
  let root;
  beforeEach(() => { root = tempRoot(); });

  it('Homebrew: names /opt/homebrew/bin/node and the shared lib/node_modules, both survive brew upgrade node', () => {
    const brew = path.join(root, 'opt', 'homebrew');
    const oldNode = writeFile(path.join(brew, 'Cellar', 'node', '25.0.0', 'bin', 'node'));
    relink(path.join(brew, 'bin', 'node'), oldNode);
    const daemonEntry = writeFile(path.join(brew, 'lib', 'node_modules', DAEMON), '// daemon\n', 0o644);

    const args = programArgs(generatePlist('brew', PROJECT, GLOBAL, {
      execPath: oldNode, daemonEntry, symlinks: [],
    }));
    assert.deepEqual(args, [path.join(brew, 'bin', 'node'), daemonEntry]);

    const newNode = writeFile(path.join(brew, 'Cellar', 'node', '25.1.0', 'bin', 'node'));
    relink(path.join(brew, 'bin', 'node'), newNode);
    fs.rmSync(path.join(brew, 'Cellar', 'node', '25.0.0'), { recursive: true });

    assertNoVersionedPaths(args, '25.0.0');
    assert.equal(fs.realpathSync(args[0]), newNode);
    assert.ok(fs.existsSync(args[1]));
  });

  it('Homebrew: keeps the #19 behaviour for the fixed symlink list', () => {
    const real = writeFile(path.join(root, 'pkg', 'node'));
    const link = path.join(root, 'usr', 'local', 'bin', 'node');
    relink(link, real);
    assert.equal(resolveNodeBinary({ execPath: real, symlinks: [link] }), link);
    // A listed symlink that points at a different node is ignored.
    relink(link, writeFile(path.join(root, 'other', 'node')));
    assert.equal(resolveNodeBinary({ execPath: real, symlinks: [link] }), real);
  });

  it('mise: names the mise shim and looks the daemon up at launch', () => {
    const mise = path.join(root, '.local', 'share', 'mise');
    let current = installNode(path.join(mise, 'installs', 'node', '22.1.0'));
    writeFile(path.join(mise, 'shims', 'node'));
    const probe = () => current;

    const args = programArgs(generatePlist('mise', PROJECT, GLOBAL, {
      execPath: current, daemonEntry: path.join(mise, 'installs', 'node', '22.1.0', 'lib', 'node_modules', DAEMON),
      symlinks: [], probe,
    }));
    assert.equal(args[0], '/bin/sh');
    assert.deepEqual(nodeCommand(args), [path.join(mise, 'shims', 'node')]);

    current = installNode(path.join(mise, 'installs', 'node', '22.2.0'));
    fs.rmSync(path.join(mise, 'installs', 'node', '22.1.0'), { recursive: true });

    assertNoVersionedPaths(args, '22.1.0');
    assert.ok(fs.existsSync(nodeCommand(args)[0]));
  });

  it('nvm: runs node through nvm-exec with the default alias', () => {
    const nvm = path.join(root, '.nvm');
    let current = installNode(path.join(nvm, 'versions', 'node', 'v22.1.0'));
    writeFile(path.join(nvm, 'nvm-exec'));
    const probe = (command, { env }) => {
      assert.equal(env.NODE_VERSION, 'default');
      return current;
    };

    const plist = generatePlist('nvm', PROJECT, GLOBAL, {
      execPath: current, daemonEntry: path.join(nvm, 'versions', 'node', 'v22.1.0', 'lib', 'node_modules', DAEMON),
      symlinks: [], probe,
    });
    const args = programArgs(plist);
    assert.deepEqual(nodeCommand(args), [path.join(nvm, 'nvm-exec'), 'node']);
    assert.equal(plistEnv(plist, 'NODE_VERSION'), 'default');

    current = installNode(path.join(nvm, 'versions', 'node', 'v22.2.0'));
    fs.rmSync(path.join(nvm, 'versions', 'node', 'v22.1.0'), { recursive: true });

    assertNoVersionedPaths(args, 'v22.1.0');
    assert.ok(fs.existsSync(nodeCommand(args)[0]));
  });

  it('nvm: prefers ~/.nvm/current when NVM_SYMLINK_CURRENT made one', () => {
    const nvm = path.join(root, '.nvm');
    const oldNode = installNode(path.join(nvm, 'versions', 'node', 'v22.1.0'));
    relink(path.join(nvm, 'current'), path.join(nvm, 'versions', 'node', 'v22.1.0'));
    assert.equal(
      resolveNodeBinary({ execPath: oldNode, symlinks: [], probe: () => assert.fail('no probe needed') }),
      path.join(nvm, 'current', 'bin', 'node'),
    );
  });

  it('asdf: names the asdf shim', () => {
    const asdf = path.join(root, '.asdf');
    let current = installNode(path.join(asdf, 'installs', 'nodejs', '22.1.0'));
    writeFile(path.join(asdf, 'shims', 'node'));

    const args = programArgs(generatePlist('asdf', PROJECT, GLOBAL, {
      execPath: current, daemonEntry: path.join(asdf, 'installs', 'nodejs', '22.1.0', 'lib', 'node_modules', DAEMON),
      symlinks: [], probe: () => current,
    }));
    assert.deepEqual(nodeCommand(args), [path.join(asdf, 'shims', 'node')]);

    current = installNode(path.join(asdf, 'installs', 'nodejs', '22.2.0'));
    fs.rmSync(path.join(asdf, 'installs', 'nodejs', '22.1.0'), { recursive: true });

    assertNoVersionedPaths(args, '22.1.0');
    assert.ok(fs.existsSync(nodeCommand(args)[0]));
  });

  it('fnm: names the default alias symlink', () => {
    const fnm = path.join(root, 'Library', 'Application Support', 'fnm');
    const oldNode = installNode(path.join(fnm, 'node-versions', 'v22.1.0', 'installation'));
    relink(path.join(fnm, 'aliases', 'default'), path.join(fnm, 'node-versions', 'v22.1.0', 'installation'));

    const args = programArgs(generatePlist('fnm', PROJECT, GLOBAL, {
      execPath: oldNode,
      daemonEntry: path.join(fnm, 'node-versions', 'v22.1.0', 'installation', 'lib', 'node_modules', DAEMON),
      symlinks: [],
    }));
    assert.deepEqual(nodeCommand(args), [path.join(fnm, 'aliases', 'default', 'bin', 'node')]);

    const newNode = installNode(path.join(fnm, 'node-versions', 'v22.2.0', 'installation'));
    relink(path.join(fnm, 'aliases', 'default'), path.join(fnm, 'node-versions', 'v22.2.0', 'installation'));
    fs.rmSync(path.join(fnm, 'node-versions', 'v22.1.0'), { recursive: true });

    assertNoVersionedPaths(args, 'v22.1.0');
    assert.equal(fs.realpathSync(nodeCommand(args)[0]), newNode);
  });

  it('Volta: names the Volta node shim', () => {
    const volta = path.join(root, '.volta');
    let current = installNode(path.join(volta, 'tools', 'image', 'node', '22.1.0'));
    writeFile(path.join(volta, 'bin', 'node'));

    const args = programArgs(generatePlist('volta', PROJECT, GLOBAL, {
      execPath: current,
      daemonEntry: path.join(volta, 'tools', 'image', 'node', '22.1.0', 'lib', 'node_modules', DAEMON),
      symlinks: [], probe: () => current,
    }));
    assert.deepEqual(nodeCommand(args), [path.join(volta, 'bin', 'node')]);

    current = installNode(path.join(volta, 'tools', 'image', 'node', '22.2.0'));
    fs.rmSync(path.join(volta, 'tools', 'image', 'node', '22.1.0'), { recursive: true });

    assertNoVersionedPaths(args, '22.1.0');
    assert.ok(fs.existsSync(nodeCommand(args)[0]));
  });

  it('skips a shim that runs a different node than the one installing the plist', () => {
    const mise = path.join(root, 'mise');
    const running = installNode(path.join(mise, 'installs', 'node', '22.1.0'));
    const other = installNode(path.join(mise, 'installs', 'node', '20.0.0'));
    writeFile(path.join(mise, 'shims', 'node'));
    assert.equal(resolveNodeBinary({ execPath: running, symlinks: [], probe: () => other }), running);
    assert.equal(resolveNodeBinary({ execPath: running, symlinks: [], probe: () => { throw new Error('boom'); } }), running);
  });
});

describe('#435 daemon entry is not a versioned path', () => {
  it('prefers the daemon installed next to pilot-manager over `npm root -g`', () => {
    const root = tempRoot();
    const ownRoot = path.join(root, 'own', 'lib', 'node_modules');
    writeFile(path.join(ownRoot, DAEMON), '// daemon\n', 0o644);
    const otherRoot = path.join(root, 'other', 'lib', 'node_modules');
    writeFile(path.join(otherRoot, DAEMON), '// daemon\n', 0o644);

    const entry = resolveDaemonEntry({ ownRoot: () => ownRoot, npmRoot: () => otherRoot });
    assert.equal(entry, path.join(ownRoot, DAEMON));
  });

  it('keeps a stable daemon entry as a plain argument', () => {
    const root = tempRoot();
    const brew = path.join(root, 'opt', 'homebrew');
    const node = writeFile(path.join(brew, 'Cellar', 'node', '25.0.0', 'bin', 'node'));
    relink(path.join(brew, 'bin', 'node'), node);
    const daemonEntry = writeFile(path.join(brew, 'lib', 'node_modules', DAEMON), '// daemon\n', 0o644);
    const args = programArgs(generatePlist('brew', PROJECT, GLOBAL, { execPath: node, daemonEntry, symlinks: [] }));
    assert.equal(args.length, 2);
    assert.ok(!isVersionedPath(args[1]));
  });

  it('writes an npm-linked daemon as the checkout it links to', () => {
    const root = tempRoot();
    const nvm = path.join(root, '.nvm');
    const node = installNode(path.join(nvm, 'versions', 'node', 'v22.1.0'));
    writeFile(path.join(nvm, 'nvm-exec'));
    const checkout = path.join(root, 'flight-deck', 'daemon');
    writeFile(path.join(checkout, 'src', 'index.js'), '// daemon\n', 0o644);
    const linked = path.join(nvm, 'versions', 'node', 'v22.1.0', 'lib', 'node_modules', '@radnine', 'claude-session-daemon');
    fs.rmSync(linked, { recursive: true });
    relink(linked, checkout);

    const args = programArgs(generatePlist('linked', PROJECT, GLOBAL, {
      execPath: node, daemonEntry: path.join(linked, 'src', 'index.js'), symlinks: [], probe: () => node,
    }));
    assert.deepEqual(args, [path.join(nvm, 'nvm-exec'), 'node', path.join(checkout, 'src', 'index.js')]);
    assertNoVersionedPaths(args, 'v22.1.0');
  });

  it('runs the daemon from the new node version after the old one is deleted', () => {
    // A real launch: the mise shim and the node "installs" are shell scripts
    // that hand off to the node running this test, reporting the fake path as
    // process.execPath so the launch script looks in the fake install.
    const root = tempRoot();
    const mise = path.join(root, 'mise');
    const realNode = process.execPath;
    const fakeNode = prefix => {
      const bin = path.join(prefix, 'bin', 'node');
      writeFile(path.join(prefix, 'lib', 'node_modules', DAEMON),
        "console.log('daemon ran from ' + __filename);\n", 0o644);
      return writeFile(bin, [
        '#!/bin/sh',
        'if [ "$1" = "-p" ]; then',
        `  exec "${realNode}" -e 'Object.defineProperty(process, "execPath", { value: process.argv[1] }); console.log(eval(process.argv[2]))' "${bin}" "$2"`,
        'fi',
        `exec "${realNode}" "$@"`,
        '',
      ].join('\n'));
    };
    const currentFile = path.join(mise, 'current');
    let current = fakeNode(path.join(mise, 'installs', 'node', '22.1.0'));
    fs.writeFileSync(currentFile, current);
    writeFile(path.join(mise, 'shims', 'node'), `#!/bin/sh\nexec "$(cat "${currentFile}")" "$@"\n`);

    const args = programArgs(generatePlist('mise-e2e', PROJECT, GLOBAL, {
      execPath: current, daemonEntry: path.join(mise, 'installs', 'node', '22.1.0', 'lib', 'node_modules', DAEMON),
      symlinks: [], cwd: root,
    }));
    assert.equal(args[0], '/bin/sh');

    current = fakeNode(path.join(mise, 'installs', 'node', '22.2.0'));
    fs.writeFileSync(currentFile, current);
    fs.rmSync(path.join(mise, 'installs', 'node', '22.1.0'), { recursive: true });

    const run = spawnSync(args[0], args.slice(1), { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /daemon ran from .*installs\/node\/22\.2\.0\/lib\/node_modules/);

    // New node without the daemon: a clear message and EX_CONFIG, not a crash loop on a missing file.
    fs.rmSync(path.join(mise, 'installs', 'node', '22.2.0', 'lib'), { recursive: true });
    const missing = spawnSync(args[0], args.slice(1), { cwd: root, encoding: 'utf8' });
    assert.equal(missing.status, 78);
    assert.match(missing.stderr, /npm install -g @radnine\/claude-session-daemon/);
  });
});

describe('#435 plist PATH holds no versioned node or ruby dirs', () => {
  it('swaps each manager\'s versioned dirs for its stable dir', () => {
    const h = '/Users/me';
    const stable = new Set([
      `${h}/.local/share/mise/shims`, `${h}/.asdf/shims`, `${h}/.rbenv/shims`,
      `${h}/.volta/bin`, `${h}/.fnm/aliases/default/bin`, '/opt/homebrew/opt/ruby/bin',
    ]);
    const input = [
      `${h}/.local/bin`,
      `${h}/.local/share/mise/installs/node/22.20.0/bin`,
      `${h}/.local/share/mise/installs/ruby/3.4.1/bin`,
      `${h}/.asdf/installs/nodejs/22.1.0/bin`,
      `${h}/.rbenv/versions/3.3.0/bin`,
      `${h}/.volta/tools/image/node/22.1.0/bin`,
      `${h}/.fnm/node-versions/v22.1.0/installation/bin`,
      '/opt/homebrew/Cellar/ruby/3.4.1/bin',
      `${h}/.nvm/versions/node/v22.20.0/bin`,
      '/usr/bin',
    ].join(':');

    const out = stablePathEnv(input, { launcher: { manager: 'nvm' }, exists: p => stable.has(p) });
    for (const dir of out.split(':')) {
      assert.ok(!isVersionedPath(dir), `versioned dir left in PATH: ${dir}`);
    }
    assert.deepEqual(out.split(':'), [
      `${h}/.local/bin`,
      `${h}/.local/share/mise/shims`,
      `${h}/.asdf/shims`,
      `${h}/.rbenv/shims`,
      `${h}/.volta/bin`,
      `${h}/.fnm/aliases/default/bin`,
      '/opt/homebrew/opt/ruby/bin',
      '/usr/bin',
    ]);
  });

  it('writes the stable PATH into the plist', () => {
    const root = tempRoot();
    const mise = path.join(root, 'mise');
    const node = installNode(path.join(mise, 'installs', 'node', '22.1.0'));
    writeFile(path.join(mise, 'shims', 'node'));
    const project = { ...PROJECT, extra_env: { PATH: `${path.join(mise, 'installs', 'ruby', '3.4.1', 'bin')}:/usr/bin` } };
    const plist = generatePlist('mise-path', project, GLOBAL, {
      execPath: node, daemonEntry: path.join(mise, 'installs', 'node', '22.1.0', 'lib', 'node_modules', DAEMON),
      symlinks: [], probe: () => node,
    });
    for (const dir of plistEnv(plist, 'PATH').split(':')) {
      assert.ok(!isVersionedPath(dir), `versioned dir in plist PATH: ${dir}`);
    }
    assert.ok(plistEnv(plist, 'PATH').split(':').includes(path.join(mise, 'shims')));
  });
});

describe('#435 no stable path: behaviour unchanged (Linux, CI)', () => {
  it('falls back to process.execPath and the plain entry', () => {
    const plist = generatePlist('fallback', PROJECT, GLOBAL, {
      execPath: process.execPath,
      daemonEntry: '/opt/pm-test/daemon/src/index.js',
      symlinks: ['/no/such/node/binary'],
      exists: () => false,
    });
    assert.deepEqual(programArgs(plist), [process.execPath, '/opt/pm-test/daemon/src/index.js']);
  });

  it('leaves a PATH without known manager dirs as it was', () => {
    const input = '/Users/runner/hostedtoolcache/node/22.11.0/arm64/bin:/usr/local/bin:/usr/bin:/bin';
    assert.equal(stablePathEnv(input, { exists: () => false }), input);
  });

  it('keeps an nvm dir when nothing else would put node on PATH', () => {
    const input = '/Users/me/.nvm/versions/node/v22.20.0/bin:/usr/bin';
    assert.equal(stablePathEnv(input, { launcher: { manager: null }, exists: () => false }), input);
  });
});
