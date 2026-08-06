import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { maintainFlightDeck } = await import('../src/maintenance.js');

function fakeGit(checkout, { dirty = false, detached = false, upstream = 'origin/main', counts = ['0\t0'] } = {}) {
  const calls = [];
  let countIndex = 0;
  return {
    calls,
    run(args) {
      calls.push(args);
      const command = args.join(' ');
      if (command === 'rev-parse --show-toplevel') return `${checkout}\n`;
      if (command === 'status --porcelain=v1 --untracked-files=normal') return dirty ? ' M app.rb\n' : '';
      if (command === 'symbolic-ref --quiet --short HEAD') {
        if (detached) throw new Error('detached');
        return 'main\n';
      }
      if (command === 'rev-parse --abbrev-ref --symbolic-full-name @{upstream}') {
        if (!upstream) throw new Error('no upstream');
        return `${upstream}\n`;
      }
      if (command === 'config --get branch.main.remote') return 'origin\n';
      if (command === 'fetch --quiet origin') return '';
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
