import { describe, it, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-manager-cli-home-'));
const originalHome = process.env.HOME;
process.env.HOME = TEST_HOME;
fs.writeFileSync(path.join(TEST_HOME, '.gitconfig'), '[user]\n\tname = Test\n\temail = test@example.test\n');

const { run } = await import('../src/cli.js');

const realExit = process.exit;
const realError = console.error;

afterEach(() => {
  process.exit = realExit;
  console.error = realError;
});

after(() => {
  process.env.HOME = originalHome;
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

async function captureRefusal(argv) {
  const output = [];
  console.error = line => output.push(String(line));
  process.exit = code => {
    const error = new Error(`exit ${code}`);
    error.exitCode = code;
    throw error;
  };

  let exitError;
  try {
    await run(argv);
  } catch (error) {
    exitError = error;
  }
  return { exitError, output };
}

describe('managed command exit contract', () => {
  it('returns exit 3 and NEEDS_DECISION when sync-core lacks its target', async () => {
    const { exitError, output } = await captureRefusal(['sync-core']);
    assert.equal(exitError.exitCode, 3);
    assert.equal(output[0], 'NEEDS_DECISION');
  });

  it('returns exit 3 and NEEDS_DECISION when maintain lacks an exact configured project', async () => {
    const { exitError, output } = await captureRefusal([
      'maintain', 'not-configured', '--command-center', '/does/not/matter',
    ]);
    assert.equal(exitError.exitCode, 3);
    assert.equal(output[0], 'NEEDS_DECISION');
    assert.match(output.join(' '), /not configured/i);
  });

  it('returns exit 3 and NEEDS_DECISION when maintain sees an incoming migration, leaving HEAD unchanged', async () => {
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const root = fs.mkdtempSync(path.join(TEST_HOME, 'repos-'));
    const upstream = path.join(root, 'upstream.git');
    const checkout = path.join(root, 'flight-deck');
    const pusher = path.join(root, 'pusher');
    git(root, 'init', '--quiet', '--bare', '-b', 'main', upstream);
    git(root, 'clone', '--quiet', upstream, pusher);
    git(pusher, 'checkout', '--quiet', '-b', 'main');
    fs.writeFileSync(path.join(pusher, 'README.md'), 'FlightDeck\n');
    git(pusher, 'add', '.');
    git(pusher, 'commit', '--quiet', '-m', 'Initial');
    git(pusher, 'push', '--quiet', '-u', 'origin', 'main');
    git(root, 'clone', '--quiet', upstream, checkout);
    fs.mkdirSync(path.join(pusher, 'db', 'migrate'), { recursive: true });
    fs.writeFileSync(path.join(pusher, 'db', 'migrate', '20261009000000_x.rb'), '# migration\n');
    git(pusher, 'add', '.');
    git(pusher, 'commit', '--quiet', '-m', 'Add migration');
    git(pusher, 'push', '--quiet', 'origin', 'main');
    const headBefore = git(checkout, 'rev-parse', 'HEAD');

    const configDir = path.join(TEST_HOME, '.config', 'claude-pilot-manager');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'projects.yml'), `projects:\n  flight-deck:\n    path: ${checkout}\n`);

    const { exitError, output } = await captureRefusal([
      'maintain', 'flight-deck', '--command-center', path.join(root, 'vault'),
    ]);

    assert.equal(exitError.exitCode, 3);
    assert.equal(output[0], 'NEEDS_DECISION');
    assert.ok(output.includes('- Incoming: db/migrate/20261009000000_x.rb'));
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), headBefore);
  });
});
