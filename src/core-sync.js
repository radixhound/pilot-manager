import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { MANAGED_CORE_STATE_DIR, ensureConfigDir } from './paths.js';

const MANIFEST_PATH = '/seed/core-crew/manifest.json';
const STATE_SCHEMA_VERSION = 1;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const VERSION_PATTERN = /^sha256:[0-9a-f]{64}$/;

export const MANAGED_CORE_ENTRIES = Object.freeze([
  { path: '.claude/personas/chief-of-staff.md', kind: 'symlink' },
  { path: '.claude/personas/flight-engineer.md', kind: 'symlink' },
  { path: '.claude/personas/persona-architect.md', kind: 'symlink' },
  { path: '.claude/personas/quartermaster.md', kind: 'symlink' },
  { path: '.claude/skills/flightdeck-managed-maintenance/SKILL.md', kind: 'file' },
  { path: '.claude/skills/repository-onboarding/SKILL.md', kind: 'file' },
  { path: 'agents/chief-of-staff.md', kind: 'file' },
  { path: 'agents/flight-engineer.md', kind: 'file' },
  { path: 'agents/persona-architect.md', kind: 'file' },
  { path: 'agents/quartermaster.md', kind: 'file' },
]);

class CoreSyncRefusal extends Error {
  constructor(outcome, message) {
    super(message);
    this.name = 'CoreSyncRefusal';
    this.outcome = outcome;
  }
}

function refusal(outcome, message) {
  return { outcome, evidence: [message], changedPaths: [] };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function digestIdentity(value) {
  return `sha256:${sha256(Buffer.from(value, 'utf8'))}`;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireExactKeys(value, keys, label) {
  if (!isPlainObject(value)) throw new CoreSyncRefusal('NEEDS_DECISION', `${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new CoreSyncRefusal('NEEDS_DECISION', `${label} has an unsupported schema.`);
  }
}

function containsUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function assertUtf8String(value, label) {
  if (typeof value !== 'string' || containsUnpairedSurrogate(value)) {
    throw new CoreSyncRefusal('NEEDS_DECISION', `${label} must contain valid UTF-8 text.`);
  }
}

function safeManagedPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('\\')) {
    return false;
  }
  if (path.posix.isAbsolute(value) || path.posix.normalize(value) !== value) return false;
  const components = value.split('/');
  return components.every(component => component !== '' && component !== '.' && component !== '..');
}

function validateSymlinkTarget(entry) {
  const target = entry.content;
  if (target.length === 0 || target.includes('\0') || path.posix.isAbsolute(target)) {
    throw new CoreSyncRefusal(
      'NEEDS_DECISION',
      `Managed symlink "${entry.path}" must have a non-empty relative target.`,
    );
  }

  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entry.path), target));
  if (resolved === '..' || resolved.startsWith('../') || path.posix.isAbsolute(resolved)) {
    throw new CoreSyncRefusal('NEEDS_DECISION', `Managed symlink "${entry.path}" escapes the vault.`);
  }
}

export function validateCoreManifest(candidate) {
  requireExactKeys(candidate, ['schema_version', 'release_version', 'entries'], 'Managed-core manifest');
  if (candidate.schema_version !== 1) {
    throw new CoreSyncRefusal(
      'NEEDS_DECISION',
      `Managed-core schema version ${String(candidate.schema_version)} is not supported.`,
    );
  }
  if (!VERSION_PATTERN.test(candidate.release_version)) {
    throw new CoreSyncRefusal('NEEDS_DECISION', 'Managed-core release version is invalid.');
  }
  if (!Array.isArray(candidate.entries)) {
    throw new CoreSyncRefusal('NEEDS_DECISION', 'Managed-core entries must be an array.');
  }

  const paths = candidate.entries.map((entry, index) => {
    requireExactKeys(entry, ['path', 'kind', 'version', 'sha256', 'content'], `Managed-core entry ${index + 1}`);
    if (!safeManagedPath(entry.path)) {
      throw new CoreSyncRefusal('NEEDS_DECISION', `Managed path at entry ${index + 1} is unsafe.`);
    }
    return entry.path;
  });

  if (new Set(paths).size !== paths.length) {
    throw new CoreSyncRefusal('NEEDS_DECISION', 'Managed paths must be unique.');
  }
  const sortedPaths = [...paths].sort();
  if (paths.some((managedPath, index) => managedPath !== sortedPaths[index])) {
    throw new CoreSyncRefusal('NEEDS_DECISION', 'Managed-core entries must be sorted by path.');
  }
  const expectedPaths = MANAGED_CORE_ENTRIES.map(entry => entry.path);
  if (paths.length !== expectedPaths.length || paths.some((managedPath, index) => managedPath !== expectedPaths[index])) {
    throw new CoreSyncRefusal('NEEDS_DECISION', 'Managed paths do not match the schema version 1 allowlist.');
  }

  candidate.entries.forEach((entry, index) => {
    const expected = MANAGED_CORE_ENTRIES[index];
    if (entry.kind !== expected.kind || !['file', 'symlink'].includes(entry.kind)) {
      throw new CoreSyncRefusal('NEEDS_DECISION', `Managed entry "${entry.path}" has an unsupported kind.`);
    }
    assertUtf8String(entry.content, `Managed entry "${entry.path}" content`);
    if (!HASH_PATTERN.test(entry.sha256)) {
      throw new CoreSyncRefusal('NEEDS_DECISION', `Managed entry "${entry.path}" has an invalid SHA-256.`);
    }
    const contentHash = sha256(Buffer.from(entry.content, 'utf8'));
    if (entry.sha256 !== contentHash) {
      throw new CoreSyncRefusal('NEEDS_DECISION', `Managed entry "${entry.path}" content hash does not match.`);
    }
    if (entry.version !== `sha256:${contentHash}`) {
      throw new CoreSyncRefusal('NEEDS_DECISION', `Managed entry "${entry.path}" entry version does not match.`);
    }
    if (entry.kind === 'symlink') validateSymlinkTarget(entry);
  });

  const releaseMaterial = candidate.entries
    .map(entry => `${entry.path}\0${entry.kind}\0${entry.sha256}\n`)
    .join('');
  const releaseVersion = `sha256:${sha256(Buffer.from(releaseMaterial, 'utf8'))}`;
  if (candidate.release_version !== releaseVersion) {
    throw new CoreSyncRefusal('NEEDS_DECISION', 'Managed-core release version does not match its entries.');
  }

  return candidate;
}

export function canonicalServerIdentity(serverUrl) {
  let parsed;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new CoreSyncRefusal('NEEDS_DECISION', 'FlightDeck server URL is invalid.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new CoreSyncRefusal(
      'NEEDS_DECISION',
      'FlightDeck server URL must be HTTP(S) and must not contain credentials, query parameters, or a fragment.',
    );
  }
  const pathname = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${pathname}`;
}

function canonicalVaultPath(vaultPath) {
  const resolved = path.resolve(vaultPath);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new CoreSyncRefusal('BLOCKED', `Command Center path "${resolved}" is not available.`);
  }
  if (!stat.isDirectory()) {
    throw new CoreSyncRefusal('BLOCKED', `Command Center path "${resolved}" is not a directory.`);
  }
  return fs.realpathSync(resolved);
}

export function managedCoreStatePath(vaultPath, serverUrl) {
  const canonicalVault = canonicalVaultPath(vaultPath);
  const serverIdentity = canonicalServerIdentity(serverUrl);
  const key = sha256(Buffer.from(`${canonicalVault}\0${serverIdentity}`, 'utf8'));
  return path.join(MANAGED_CORE_STATE_DIR, `${key}.json`);
}

export async function fetchCoreManifest(serverUrl, { fetchImpl = global.fetch } = {}) {
  const serverIdentity = canonicalServerIdentity(serverUrl);
  let response;
  try {
    response = await fetchImpl(`${serverIdentity}${MANIFEST_PATH}`);
  } catch (error) {
    if (error instanceof CoreSyncRefusal) throw error;
    throw new CoreSyncRefusal('BLOCKED', 'Cannot reach the FlightDeck managed-core endpoint.');
  }

  if (!response || response.status < 200 || response.status >= 300) {
    const status = response?.status ? ` (HTTP ${response.status})` : '';
    throw new CoreSyncRefusal('BLOCKED', `FlightDeck managed-core endpoint is unavailable${status}.`);
  }
  const contentType = response.headers?.get?.('content-type');
  if (contentType && !contentType.toLowerCase().startsWith('application/json')) {
    throw new CoreSyncRefusal('NEEDS_DECISION', 'Managed-core response is not JSON.');
  }

  let bytes;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch {
    throw new CoreSyncRefusal('BLOCKED', 'Could not read the managed-core response.');
  }
  if (bytes.length > MAX_MANIFEST_BYTES) {
    throw new CoreSyncRefusal('NEEDS_DECISION', 'Managed-core response exceeds the supported size.');
  }

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CoreSyncRefusal('NEEDS_DECISION', 'Managed-core response is not valid UTF-8.');
  }

  let candidate;
  try {
    candidate = JSON.parse(text);
  } catch {
    throw new CoreSyncRefusal('NEEDS_DECISION', 'Managed-core response is not valid JSON.');
  }
  return validateCoreManifest(candidate);
}

function stateFor(manifest, canonicalVault, serverIdentity) {
  const entries = {};
  for (const entry of manifest.entries) {
    entries[entry.path] = { kind: entry.kind, sha256: entry.sha256 };
  }
  return {
    schema_version: STATE_SCHEMA_VERSION,
    vault_identity: digestIdentity(canonicalVault),
    server_identity: digestIdentity(serverIdentity),
    release_version: manifest.release_version,
    entries,
  };
}

function validateState(candidate, expectedIdentity) {
  requireExactKeys(
    candidate,
    ['schema_version', 'vault_identity', 'server_identity', 'release_version', 'entries'],
    'Managed-core ownership state',
  );
  if (candidate.schema_version !== STATE_SCHEMA_VERSION ||
      candidate.vault_identity !== expectedIdentity.vault_identity ||
      candidate.server_identity !== expectedIdentity.server_identity ||
      !VERSION_PATTERN.test(candidate.release_version)) {
    throw new CoreSyncRefusal('NEEDS_DECISION', 'Managed-core ownership state has an unsupported identity or version.');
  }
  requireExactKeys(candidate.entries, MANAGED_CORE_ENTRIES.map(entry => entry.path), 'Managed-core ownership entries');
  for (const definition of MANAGED_CORE_ENTRIES) {
    const entry = candidate.entries[definition.path];
    requireExactKeys(entry, ['kind', 'sha256'], `Ownership entry "${definition.path}"`);
    if (entry.kind !== definition.kind || !HASH_PATTERN.test(entry.sha256)) {
      throw new CoreSyncRefusal('NEEDS_DECISION', `Ownership entry "${definition.path}" is invalid.`);
    }
  }
  return candidate;
}

function loadState(statePath, expectedIdentity) {
  let stat;
  try {
    stat = fs.lstatSync(statePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new CoreSyncRefusal('BLOCKED', 'Managed-core ownership state cannot be inspected.');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new CoreSyncRefusal('NEEDS_DECISION', 'Managed-core ownership state is not a regular file.');
  }
  try {
    return validateState(JSON.parse(fs.readFileSync(statePath, 'utf8')), expectedIdentity);
  } catch (error) {
    if (error instanceof CoreSyncRefusal) throw error;
    throw new CoreSyncRefusal('NEEDS_DECISION', 'Managed-core ownership state is invalid JSON.');
  }
}

function destinationState(targetPath) {
  let stat;
  try {
    stat = fs.lstatSync(targetPath);
  } catch (error) {
    if (error.code === 'ENOENT') return { kind: 'missing', sha256: null };
    throw new CoreSyncRefusal('BLOCKED', `Managed path "${targetPath}" cannot be inspected.`);
  }

  if (stat.isSymbolicLink()) {
    return { kind: 'symlink', sha256: sha256(fs.readlinkSync(targetPath, { encoding: 'buffer' })) };
  }
  if (stat.isFile()) {
    return { kind: 'file', sha256: sha256(fs.readFileSync(targetPath)) };
  }
  return { kind: 'other', sha256: null };
}

function sameDestination(left, right) {
  return left.kind === right.kind && left.sha256 === right.sha256;
}

function inspectAncestors(canonicalVault, managedPath) {
  const components = path.posix.dirname(managedPath).split('/').filter(component => component !== '.');
  let current = canonicalVault;
  for (const component of components) {
    current = path.join(current, component);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new CoreSyncRefusal('BLOCKED', `Managed parent for "${managedPath}" cannot be inspected.`);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return current;
    }
  }
  return null;
}

function preflight(canonicalVault, manifest, state) {
  const changes = [];
  const snapshots = new Map();

  for (const entry of manifest.entries) {
    const unsafeParent = inspectAncestors(canonicalVault, entry.path);
    if (unsafeParent) {
      throw new CoreSyncRefusal(
        state ? 'BLOCKED' : 'NEEDS_DECISION',
        `Managed path "${entry.path}" has a symlink or non-directory parent; no content was changed.`,
      );
    }

    const targetPath = path.join(canonicalVault, entry.path);
    const current = destinationState(targetPath);
    snapshots.set(entry.path, current);
    const previous = state?.entries?.[entry.path];

    if (current.kind === 'missing') {
      if (previous) {
        throw new CoreSyncRefusal(
          'BLOCKED',
          `Managed path "${entry.path}" was deleted after the last applied release; no content was changed.`,
        );
      }
      changes.push(entry);
      continue;
    }

    if (current.kind === entry.kind && current.sha256 === entry.sha256) continue;

    if (!previous) {
      throw new CoreSyncRefusal(
        'NEEDS_DECISION',
        `Existing path "${entry.path}" differs from FlightDeck content and has no ownership record; no content was changed.`,
      );
    }
    if (previous.kind !== entry.kind) {
      throw new CoreSyncRefusal(
        'NEEDS_DECISION',
        `Managed path "${entry.path}" has an ambiguous type transition; no content was changed.`,
      );
    }
    if (current.kind !== previous.kind || current.sha256 !== previous.sha256) {
      throw new CoreSyncRefusal(
        'BLOCKED',
        `Managed path "${entry.path}" was locally modified or changed type; no content was changed.`,
      );
    }
    changes.push(entry);
  }

  return { changes, snapshots };
}

function stageChanges(canonicalVault, changes) {
  const stageDir = fs.mkdtempSync(path.join(canonicalVault, '.pilot-core-'));
  try {
    for (const entry of changes) {
      const stagedPath = path.join(stageDir, entry.path);
      fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
      if (entry.kind === 'symlink') fs.symlinkSync(entry.content, stagedPath);
      else fs.writeFileSync(stagedPath, Buffer.from(entry.content, 'utf8'), { mode: 0o644 });
    }
  } catch (error) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    throw new CoreSyncRefusal('BLOCKED', 'Managed-core content could not be staged on the target filesystem.');
  }
  return stageDir;
}

function applyChanges(canonicalVault, stageDir, changes, snapshots) {
  for (const entry of changes) {
    const targetPath = path.join(canonicalVault, entry.path);
    if (!sameDestination(destinationState(targetPath), snapshots.get(entry.path))) {
      throw new CoreSyncRefusal(
        'BLOCKED',
        `Managed path "${entry.path}" changed during synchronization; no staged content was applied.`,
      );
    }
  }

  for (const entry of changes) {
    const targetPath = path.join(canonicalVault, entry.path);
    if (inspectAncestors(canonicalVault, entry.path)) {
      throw new CoreSyncRefusal(
        'BLOCKED',
        `Managed parent for "${entry.path}" changed during synchronization; no staged content was applied.`,
      );
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    if (inspectAncestors(canonicalVault, entry.path)) {
      throw new CoreSyncRefusal(
        'BLOCKED',
        `Managed parent for "${entry.path}" became unsafe during synchronization; no staged content was applied.`,
      );
    }
  }

  for (const entry of changes) {
    const targetPath = path.join(canonicalVault, entry.path);
    if (inspectAncestors(canonicalVault, entry.path)) {
      throw new CoreSyncRefusal(
        'BLOCKED',
        `Managed parent for "${entry.path}" changed during synchronization; reconciliation stopped.`,
      );
    }
    if (!sameDestination(destinationState(targetPath), snapshots.get(entry.path))) {
      throw new CoreSyncRefusal(
        'BLOCKED',
        `Managed path "${entry.path}" changed during synchronization; reconciliation stopped.`,
      );
    }
    fs.renameSync(path.join(stageDir, entry.path), targetPath);
  }
}

function verifyApplied(canonicalVault, manifest) {
  for (const entry of manifest.entries) {
    const current = destinationState(path.join(canonicalVault, entry.path));
    if (current.kind !== entry.kind || current.sha256 !== entry.sha256) {
      throw new CoreSyncRefusal(
        'BLOCKED',
        `Managed path "${entry.path}" could not be verified after application; ownership state was not advanced.`,
      );
    }
  }
}

function saveState(statePath, state, previousState) {
  const serialized = `${JSON.stringify(state, null, 2)}\n`;
  if (previousState && JSON.stringify(previousState) === JSON.stringify(state)) return;

  ensureConfigDir();
  fs.mkdirSync(MANAGED_CORE_STATE_DIR, { recursive: true, mode: 0o700 });
  const stateDirectoryStat = fs.lstatSync(MANAGED_CORE_STATE_DIR);
  if (stateDirectoryStat.isSymbolicLink() || !stateDirectoryStat.isDirectory()) {
    throw new CoreSyncRefusal('NEEDS_DECISION', 'Managed-core state directory is not a regular directory.');
  }
  const temporary = `${statePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, statePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export async function syncManagedCore(vaultPath, serverUrl, options = {}) {
  let stageDir;
  try {
    const canonicalVault = canonicalVaultPath(vaultPath);
    const serverIdentity = canonicalServerIdentity(serverUrl);
    const manifest = await fetchCoreManifest(serverIdentity, options);
    const identity = {
      vault_identity: digestIdentity(canonicalVault),
      server_identity: digestIdentity(serverIdentity),
    };
    const statePath = managedCoreStatePath(canonicalVault, serverIdentity);
    const state = loadState(statePath, identity);
    const { changes, snapshots } = preflight(canonicalVault, manifest, state);

    if (changes.length > 0) {
      stageDir = stageChanges(canonicalVault, changes);
      applyChanges(canonicalVault, stageDir, changes, snapshots);
    }
    verifyApplied(canonicalVault, manifest);

    const nextState = stateFor(manifest, canonicalVault, serverIdentity);
    saveState(statePath, nextState, state);

    if (changes.length > 0) {
      return {
        outcome: 'UPDATED',
        evidence: [
          `Managed core release ${manifest.release_version} applied.`,
          `${changes.length} managed path(s) installed or updated.`,
        ],
        changedPaths: changes.map(entry => entry.path),
        releaseVersion: manifest.release_version,
      };
    }
    return {
      outcome: 'ALREADY_CURRENT',
      evidence: [`Managed core release ${manifest.release_version} is already current.`],
      changedPaths: [],
      releaseVersion: manifest.release_version,
    };
  } catch (error) {
    if (error instanceof CoreSyncRefusal) return refusal(error.outcome, error.message);
    return refusal('BLOCKED', 'Managed-core synchronization failed before ownership state could be advanced.');
  } finally {
    if (stageDir) fs.rmSync(stageDir, { recursive: true, force: true });
  }
}
