import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { maintainFlightDeck } = await import('../src/maintenance.js');

function fakeGit(checkout, {
  dirty = false,
  detached = false,
  upstream = 'origin/main',
  remote = 'origin',
  topLevel = checkout,
  counts = ['0\t0'],
  incoming = ['app/models/session.rb'],
  failCommands = [],
} = {}) {
  const calls = [];
  let countIndex = 0;
  return {
    calls,
    run(args) {
      calls.push(args);
      const command = args.join(' ');
      if (failCommands.includes(command)) throw new Error(`failed: ${command}`);
      if (command === 'rev-parse --show-toplevel') return `${topLevel}\n`;
      if (command === 'status --porcelain=v1 --untracked-files=normal') return dirty ? ' M app.rb\n' : '';
      if (command === 'symbolic-ref --quiet --short HEAD') {
        if (detached) throw new Error('detached');
        return 'main\n';
      }
      if (command === 'rev-parse --abbrev-ref --symbolic-full-name @{upstream}') {
        if (!upstream) throw new Error('no upstream');
        return `${upstream}\n`;
      }
      if (command === 'config --get branch.main.remote') return `${remote}\n`;
      if (command === `fetch --quiet ${remote}`) return '';
      if (command === 'rev-list --left-right --count HEAD...@{upstream}') {
        return `${counts[Math.min(countIndex++, counts.length - 1)]}\n`;
      }
      if (command === 'diff --name-only --no-renames -z HEAD @{upstream}') return `${incoming.join('\0')}\0`;
      if (command === 'merge --ff-only @{upstream}') return 'Updating...\n';
      throw new Error(`unexpected git command: ${command}`);
    },
  };
}

function dependencies(checkout, git, syncResult = { outcome: 'ALREADY_CURRENT', evidence: ['Core crew is current.'], changedPaths: [] }) {
  return {
    getProjectImpl: name => name === 'flight-deck' ? { path: checkout, auth_token: 'never expose me' } : null,
    git,
    syncCoreImpl: async () => syncResult,
  };
}

describe('maintainFlightDeck', () => {
  it('fetches and fast-forwards a strictly-behind clean checkout, then invokes core sync', async () => {
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-maintain-checkout-'));
    const git = fakeGit(checkout, { counts: ['0\t2', '0\t0'] });
    const result = await maintainFlightDeck(
      'flight-deck', checkout, 'https://flightdeck.example.test', dependencies(checkout, git),
    );

    assert.equal(result.outcome, 'UPDATED');
    assert.equal(result.checkoutUpdated, true);
    assert.ok(git.calls.some(args => args.join(' ') === 'fetch --quiet origin'));
    assert.ok(git.calls.some(args => args.join(' ') === 'merge --ff-only @{upstream}'));
  });

  it('returns ALREADY_CURRENT when neither checkout nor core changed', async () => {
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-maintain-checkout-'));
    const git = fakeGit(checkout);
    const result = await maintainFlightDeck(
      'flight-deck', checkout, 'https://flightdeck.example.test', dependencies(checkout, git),
    );

    assert.equal(result.outcome, 'ALREADY_CURRENT');
    assert.equal(result.checkoutUpdated, false);
    assert.equal(git.calls.some(args => args[0] === 'merge'), false);
  });

  it('returns UPDATED when only core sync changed', async () => {
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-maintain-checkout-'));
    const git = fakeGit(checkout);
    const deps = dependencies(checkout, git, {
      outcome: 'UPDATED', evidence: ['Managed core updated.'], changedPaths: ['agents/flight-engineer.md'],
    });
    const result = await maintainFlightDeck(
      'flight-deck', checkout, 'https://flightdeck.example.test', deps,
    );

    assert.equal(result.outcome, 'UPDATED');
    assert.equal(result.checkoutUpdated, false);
  });

  it('refuses dirty, detached, missing-upstream, ahead, and diverged checkouts before core sync', async t => {
    const cases = [
      ['dirty', { dirty: true }, /dirty/i],
      ['detached', { detached: true }, /detached/i],
      ['missing upstream', { upstream: null }, /upstream/i],
      ['ahead', { counts: ['1\t0'] }, /ahead/i],
      ['diverged', { counts: ['1\t2'] }, /diverged/i],
    ];

    for (const [name, gitOptions, evidence] of cases) {
      await t.test(name, async () => {
        const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-maintain-checkout-'));
        const git = fakeGit(checkout, gitOptions);
        let syncCalled = false;
        const deps = dependencies(checkout, git);
        deps.syncCoreImpl = async () => { syncCalled = true; return { outcome: 'ALREADY_CURRENT', evidence: [] }; };

        const result = await maintainFlightDeck(
          'flight-deck', checkout, 'https://flightdeck.example.test', deps,
        );

        assert.equal(result.outcome, 'BLOCKED');
        assert.match(result.evidence.join(' '), evidence);
        assert.equal(syncCalled, false);
        assert.equal(git.calls.some(args => args[0] === 'merge'), false);
      });
    }
  });

  it('returns NEEDS_DECISION when the configured project name is unknown', async () => {
    const result = await maintainFlightDeck('other', '/vault', 'https://flightdeck.example.test', {
      getProjectImpl: () => null,
    });
    assert.equal(result.outcome, 'NEEDS_DECISION');
    assert.match(result.evidence.join(' '), /not configured/i);
  });

  it('refuses a configured path that is not the checkout root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-maintain-root-'));
    const checkout = path.join(root, 'nested');
    fs.mkdirSync(checkout);
    const git = fakeGit(checkout, { topLevel: root });
    let syncCalled = false;
    const deps = dependencies(checkout, git);
    deps.syncCoreImpl = async () => { syncCalled = true; return { outcome: 'ALREADY_CURRENT', evidence: [] }; };

    const result = await maintainFlightDeck(
      'flight-deck', checkout, 'https://flightdeck.example.test', deps,
    );

    assert.equal(result.outcome, 'NEEDS_DECISION');
    assert.match(result.evidence.join(' '), /checkout root/i);
    assert.equal(syncCalled, false);
    assert.equal(git.calls.some(args => args[0] === 'fetch'), false);
  });

  it('refuses an unsafe upstream remote before fetch or core sync', async () => {
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-maintain-checkout-'));
    const git = fakeGit(checkout, { remote: '--upload-pack=unsafe' });
    let syncCalled = false;
    const deps = dependencies(checkout, git);
    deps.syncCoreImpl = async () => { syncCalled = true; return { outcome: 'ALREADY_CURRENT', evidence: [] }; };

    const result = await maintainFlightDeck(
      'flight-deck', checkout, 'https://flightdeck.example.test', deps,
    );

    assert.equal(result.outcome, 'NEEDS_DECISION');
    assert.match(result.evidence.join(' '), /remote identity/i);
    assert.equal(syncCalled, false);
    assert.equal(git.calls.some(args => args[0] === 'fetch'), false);
  });

  it('returns BLOCKED without core sync when upstream fetch fails', async () => {
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-maintain-checkout-'));
    const git = fakeGit(checkout, { failCommands: ['fetch --quiet origin'] });
    let syncCalled = false;
    const deps = dependencies(checkout, git);
    deps.syncCoreImpl = async () => { syncCalled = true; return { outcome: 'ALREADY_CURRENT', evidence: [] }; };

    const result = await maintainFlightDeck(
      'flight-deck', checkout, 'https://flightdeck.example.test', deps,
    );

    assert.equal(result.outcome, 'BLOCKED');
    assert.match(result.evidence.join(' '), /fetch failed/i);
    assert.equal(syncCalled, false);
  });

  it('returns BLOCKED without fast-forward or core sync when incoming changes cannot be listed', async () => {
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-maintain-checkout-'));
    const git = fakeGit(checkout, {
      counts: ['0\t1'],
      failCommands: ['diff --name-only --no-renames -z HEAD @{upstream}'],
    });
    let syncCalled = false;
    const deps = dependencies(checkout, git);
    deps.syncCoreImpl = async () => { syncCalled = true; return { outcome: 'ALREADY_CURRENT', evidence: [] }; };

    const result = await maintainFlightDeck(
      'flight-deck', checkout, 'https://flightdeck.example.test', deps,
    );

    assert.equal(result.outcome, 'BLOCKED');
    assert.match(result.evidence.join(' '), /incoming changes could not be listed/i);
    assert.equal(git.calls.some(args => args[0] === 'merge'), false);
    assert.equal(syncCalled, false);
  });

  it('returns BLOCKED without core sync when fast-forward fails', async () => {
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-maintain-checkout-'));
    const git = fakeGit(checkout, {
      counts: ['0\t1'],
      failCommands: ['merge --ff-only @{upstream}'],
    });
    let syncCalled = false;
    const deps = dependencies(checkout, git);
    deps.syncCoreImpl = async () => { syncCalled = true; return { outcome: 'ALREADY_CURRENT', evidence: [] }; };

    const result = await maintainFlightDeck(
      'flight-deck', checkout, 'https://flightdeck.example.test', deps,
    );

    assert.equal(result.outcome, 'BLOCKED');
    assert.match(result.evidence.join(' '), /fast-forwarded safely/i);
    assert.equal(result.checkoutUpdated, false);
    assert.equal(syncCalled, false);
  });

  it('returns BLOCKED without core sync when fast-forward postverification fails', async () => {
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-maintain-checkout-'));
    const git = fakeGit(checkout, { counts: ['0\t1', '0\t1'] });
    let syncCalled = false;
    const deps = dependencies(checkout, git);
    deps.syncCoreImpl = async () => { syncCalled = true; return { outcome: 'ALREADY_CURRENT', evidence: [] }; };

    const result = await maintainFlightDeck(
      'flight-deck', checkout, 'https://flightdeck.example.test', deps,
    );

    assert.equal(result.outcome, 'BLOCKED');
    assert.match(result.evidence.join(' '), /did not leave a clean checkout/i);
    assert.equal(result.checkoutUpdated, true);
    assert.equal(syncCalled, false);
  });

  it('preserves a refusal from core sync, including evidence that a fast-forward already happened', async () => {
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-maintain-checkout-'));
    const git = fakeGit(checkout, { counts: ['0\t1', '0\t0'] });
    const deps = dependencies(checkout, git, {
      outcome: 'BLOCKED', evidence: ['Managed file was locally modified.'], changedPaths: [],
    });
    const result = await maintainFlightDeck(
      'flight-deck', checkout, 'https://flightdeck.example.test', deps,
    );

    assert.equal(result.outcome, 'BLOCKED');
    assert.equal(result.checkoutUpdated, true);
    assert.match(result.evidence.join(' '), /fast-forwarded/i);
    assert.match(result.evidence.join(' '), /locally modified/i);
  });
});

describe('maintainFlightDeck against a real checkout with an upstream', () => {
  const savedEnv = {};
  const isolatedEnv = ['HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'];

  before(() => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-maintain-home-'));
    for (const key of isolatedEnv) savedEnv[key] = process.env[key];
    process.env.HOME = home;
    process.env.GIT_CONFIG_GLOBAL = path.join(home, '.gitconfig');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '[user]\n\tname = Test\n\temail = test@example.test\n');
  });

  after(() => {
    for (const key of isolatedEnv) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  function git(cwd, ...args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }

  function commitFile(cwd, file, content) {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), content);
    git(cwd, 'add', file);
    git(cwd, 'commit', '--quiet', '-m', `Change ${file}`);
  }

  // A bare upstream, the checkout under test tracking it, and a second clone
  // that pushes the incoming commit.
  function checkoutBehindUpstream(incomingFile) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-maintain-real-'));
    const upstream = path.join(root, 'upstream.git');
    const checkout = path.join(root, 'flight-deck');
    const pusher = path.join(root, 'pusher');
    git(root, 'init', '--quiet', '--bare', '-b', 'main', upstream);
    git(root, 'clone', '--quiet', upstream, pusher);
    git(pusher, 'checkout', '--quiet', '-b', 'main');
    commitFile(pusher, 'app/models/session.rb', 'class Session; end\n');
    git(pusher, 'push', '--quiet', '-u', 'origin', 'main');
    git(root, 'clone', '--quiet', upstream, checkout);
    commitFile(pusher, incomingFile, '# incoming\n');
    git(pusher, 'push', '--quiet', 'origin', 'main');
    return { checkout, upstreamHead: git(pusher, 'rev-parse', 'HEAD') };
  }

  function realDependencies(checkout) {
    const deps = {
      syncCalled: false,
      getProjectImpl: name => name === 'flight-deck' ? { path: checkout } : null,
      syncCoreImpl: async () => {
        deps.syncCalled = true;
        return { outcome: 'ALREADY_CURRENT', evidence: ['Core crew is current.'], changedPaths: [] };
      },
    };
    return deps;
  }

  it('returns NEEDS_DECISION and leaves HEAD unchanged when an incoming commit adds a migration', async () => {
    const { checkout } = checkoutBehindUpstream('db/migrate/20261009000000_x.rb');
    const headBefore = git(checkout, 'rev-parse', 'HEAD');
    const deps = realDependencies(checkout);

    const result = await maintainFlightDeck('flight-deck', checkout, 'https://flightdeck.example.test', deps);

    assert.equal(result.outcome, 'NEEDS_DECISION');
    assert.equal(result.checkoutUpdated, false);
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), headBefore);
    assert.equal(git(checkout, 'status', '--porcelain'), '');
    assert.equal(deps.syncCalled, false);
    const evidence = result.evidence.join('\n');
    assert.match(evidence, /Incoming: db\/migrate\/20261009000000_x\.rb/);
    assert.match(evidence, /db:migrate/);
    assert.match(evidence, /restart FlightDeck/);
  });

  it('returns NEEDS_DECISION for incoming Gemfile.lock, package.json, and package-lock.json changes', async t => {
    for (const [file, step] of [
      ['Gemfile.lock', /bundle install/],
      ['package.json', /npm install/],
      ['package-lock.json', /npm install/],
    ]) {
      await t.test(file, async () => {
        const { checkout } = checkoutBehindUpstream(file);
        const headBefore = git(checkout, 'rev-parse', 'HEAD');
        const deps = realDependencies(checkout);

        const result = await maintainFlightDeck('flight-deck', checkout, 'https://flightdeck.example.test', deps);

        assert.equal(result.outcome, 'NEEDS_DECISION');
        assert.equal(git(checkout, 'rev-parse', 'HEAD'), headBefore);
        assert.equal(deps.syncCalled, false);
        assert.ok(result.evidence.includes(`Incoming: ${file}`));
        assert.match(result.evidence.join('\n'), step);
      });
    }
  });

  it('fast-forwards and runs core sync when the incoming commit changes only app code', async () => {
    const { checkout, upstreamHead } = checkoutBehindUpstream('app/controllers/sessions_controller.rb');
    const deps = realDependencies(checkout);

    const result = await maintainFlightDeck('flight-deck', checkout, 'https://flightdeck.example.test', deps);

    assert.equal(result.outcome, 'UPDATED');
    assert.equal(result.checkoutUpdated, true);
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), upstreamHead);
    assert.equal(deps.syncCalled, true);
  });
});
