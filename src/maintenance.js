import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getProject } from './registry.js';
import { syncManagedCore } from './core-sync.js';

const SUCCESS_OUTCOMES = new Set(['UPDATED', 'ALREADY_CURRENT']);
const REFUSAL_OUTCOMES = new Set(['BLOCKED', 'NEEDS_DECISION']);

const defaultGit = {
  run(args, cwd) {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  },
};

function result(outcome, evidence, checkoutUpdated = false) {
  return { outcome, evidence, checkoutUpdated };
}

function runGit(git, args, cwd, failureMessage) {
  try {
    return git.run(args, cwd).trim();
  } catch {
    const error = new Error(failureMessage);
    error.isMaintenanceRefusal = true;
    throw error;
  }
}

function canonicalDirectory(directory) {
  try {
    if (!fs.statSync(directory).isDirectory()) return null;
    return fs.realpathSync(directory);
  } catch {
    return null;
  }
}

function parseAheadBehind(output) {
  const match = output.match(/^(\d+)\s+(\d+)$/);
  if (!match) return null;
  return { ahead: Number(match[1]), behind: Number(match[2]) };
}

function inspectAndUpdateCheckout(projectPath, git) {
  const canonicalProject = canonicalDirectory(path.resolve(projectPath));
  if (!canonicalProject) {
    return result('BLOCKED', ['Configured FlightDeck checkout is not an available directory.']);
  }

  let topLevel;
  try {
    topLevel = runGit(git, ['rev-parse', '--show-toplevel'], canonicalProject, 'Configured FlightDeck path is not a Git checkout.');
  } catch (error) {
    return result('BLOCKED', [error.message]);
  }
  const canonicalTopLevel = canonicalDirectory(topLevel);
  if (!canonicalTopLevel) {
    return result('BLOCKED', ['Configured FlightDeck Git root is not available.']);
  }
  if (canonicalTopLevel !== canonicalProject) {
    return result(
      'NEEDS_DECISION',
      ['Configured FlightDeck project path is not the checkout root; target identity is ambiguous.'],
    );
  }

  let status;
  try {
    status = runGit(
      git,
      ['status', '--porcelain=v1', '--untracked-files=normal'],
      canonicalProject,
      'FlightDeck working-tree state could not be inspected.',
    );
  } catch (error) {
    return result('BLOCKED', [error.message]);
  }
  if (status !== '') {
    return result('BLOCKED', ['FlightDeck working tree is dirty; no Git update or core sync was attempted.']);
  }

  let branch;
  try {
    branch = runGit(
      git,
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      canonicalProject,
      'FlightDeck checkout is detached; an attached branch is required.',
    );
  } catch (error) {
    return result('BLOCKED', [error.message]);
  }

  let fastForwardCompleted = false;
  try {
    runGit(
      git,
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      canonicalProject,
      'FlightDeck branch has no configured upstream.',
    );
  } catch (error) {
    return result('BLOCKED', [error.message]);
  }

  let remote;
  try {
    remote = runGit(
      git,
      ['config', '--get', `branch.${branch}.remote`],
      canonicalProject,
      'FlightDeck branch has no configured upstream remote.',
    );
  } catch (error) {
    return result('BLOCKED', [error.message]);
  }
  if (!remote || remote.startsWith('-') || !/^[A-Za-z0-9._/-]+$/.test(remote)) {
    return result('NEEDS_DECISION', ['FlightDeck upstream remote identity is ambiguous.']);
  }

  try {
    runGit(git, ['fetch', '--quiet', remote], canonicalProject, 'FlightDeck upstream fetch failed.');
  } catch (error) {
    return result('BLOCKED', [error.message]);
  }

  let counts;
  try {
    counts = parseAheadBehind(runGit(
      git,
      ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'],
      canonicalProject,
      'FlightDeck upstream relationship could not be inspected.',
    ));
  } catch (error) {
    return result('BLOCKED', [error.message]);
  }
  if (!counts) {
    return result('BLOCKED', ['FlightDeck upstream relationship returned an unsupported result.']);
  }
  if (counts.ahead > 0 && counts.behind > 0) {
    return result('BLOCKED', ['FlightDeck checkout has diverged from its upstream; no Git update or core sync was attempted.']);
  }
  if (counts.ahead > 0) {
    return result('BLOCKED', ['FlightDeck checkout is locally ahead of its upstream; no Git update or core sync was attempted.']);
  }
  if (counts.behind === 0) {
    return result('ALREADY_CURRENT', ['FlightDeck checkout is already at its upstream commit.']);
  }

  try {
    runGit(
      git,
      ['merge', '--ff-only', '@{upstream}'],
      canonicalProject,
      'FlightDeck checkout could not be fast-forwarded safely.',
    );
    fastForwardCompleted = true;
    const after = parseAheadBehind(runGit(
      git,
      ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'],
      canonicalProject,
      'FlightDeck fast-forward result could not be verified.',
    ));
    const afterStatus = runGit(
      git,
      ['status', '--porcelain=v1', '--untracked-files=normal'],
      canonicalProject,
      'FlightDeck working tree could not be verified after fast-forward.',
    );
    if (!after || after.ahead !== 0 || after.behind !== 0 || afterStatus !== '') {
      return result('BLOCKED', ['FlightDeck fast-forward did not leave a clean checkout at its upstream commit.'], true);
    }
  } catch (error) {
    return result('BLOCKED', [error.message], fastForwardCompleted);
  }

  return result('UPDATED', ['FlightDeck checkout fast-forwarded to its upstream commit.'], true);
}

export async function maintainFlightDeck(projectName, commandCenterPath, serverUrl, dependencies = {}) {
  const getProjectImpl = dependencies.getProjectImpl || getProject;
  const git = dependencies.git || defaultGit;
  const syncCoreImpl = dependencies.syncCoreImpl || syncManagedCore;

  const project = getProjectImpl(projectName);
  if (!project) {
    return result('NEEDS_DECISION', [`FlightDeck project "${projectName}" is not configured in Pilot Manager.`]);
  }
  if (!project.path || typeof project.path !== 'string') {
    return result('NEEDS_DECISION', [`FlightDeck project "${projectName}" has no unambiguous checkout path.`]);
  }

  const checkout = inspectAndUpdateCheckout(project.path, git);
  if (REFUSAL_OUTCOMES.has(checkout.outcome)) return checkout;

  let core;
  try {
    core = await syncCoreImpl(commandCenterPath, serverUrl);
  } catch {
    return result(
      'BLOCKED',
      [...checkout.evidence, 'Managed-core sync failed without a governed outcome.'],
      checkout.checkoutUpdated,
    );
  }
  if (!core || (!SUCCESS_OUTCOMES.has(core.outcome) && !REFUSAL_OUTCOMES.has(core.outcome))) {
    return result(
      'BLOCKED',
      [...checkout.evidence, 'Managed-core sync returned an unsupported outcome.'],
      checkout.checkoutUpdated,
    );
  }
  if (REFUSAL_OUTCOMES.has(core.outcome)) {
    return result(core.outcome, [...checkout.evidence, ...(core.evidence || [])], checkout.checkoutUpdated);
  }

  const outcome = checkout.outcome === 'UPDATED' || core.outcome === 'UPDATED'
    ? 'UPDATED'
    : 'ALREADY_CURRENT';
  return result(outcome, [...checkout.evidence, ...(core.evidence || [])], checkout.checkoutUpdated);
}
