import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
