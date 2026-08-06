import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-manager-core-home-'));
const originalHome = process.env.HOME;
process.env.HOME = TEST_HOME;

const {
  MANAGED_CORE_ENTRIES,
  fetchCoreManifest,
  managedCoreStatePath,
  syncManagedCore,
  validateCoreManifest,
} = await import('../src/core-sync.js');
const { MANAGED_CORE_STATE_DIR } = await import('../src/paths.js');

const SERVER = 'https://flightdeck.example.test';

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function finalizeManifest(entries) {
  const sorted = [...entries].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  for (const entry of sorted) {
    entry.sha256 = sha256(entry.content);
    entry.version = `sha256:${entry.sha256}`;
  }
  const releaseMaterial = sorted
    .map(entry => `${entry.path}\0${entry.kind}\0${entry.sha256}\n`)
    .join('');
  return {
    schema_version: 1,
    release_version: `sha256:${sha256(releaseMaterial)}`,
    entries: sorted,
  };
}

function manifest(version = 'one') {
  const symlinkTargets = {
    '.claude/personas/chief-of-staff.md': '../../agents/chief-of-staff.md',
    '.claude/personas/flight-engineer.md': '../../agents/flight-engineer.md',
    '.claude/personas/persona-architect.md': '../../agents/persona-architect.md',
    '.claude/personas/quartermaster.md': '../../agents/quartermaster.md',
  };
  return finalizeManifest(MANAGED_CORE_ENTRIES.map(definition => ({
    path: definition.path,
    kind: definition.kind,
    content: definition.kind === 'symlink'
      ? symlinkTargets[definition.path]
      : `# ${definition.path}\n\nrelease ${version}\n`,
  })));
}

function responseFor(body, { status = 200, contentType = 'application/json' } = {}) {
  const bytes = typeof body === 'string'
    ? Buffer.from(body, 'utf8')
    : Buffer.from(JSON.stringify(body), 'utf8');
  return {
    status,
    headers: { get: name => name.toLowerCase() === 'content-type' ? contentType : null },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

function installTarget(vault, entry) {
  const target = path.join(vault, entry.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (entry.kind === 'symlink') fs.symlinkSync(entry.content, target);
  else fs.writeFileSync(target, entry.content);
}

let vault;

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-manager-core-vault-'));
});

afterEach(() => {
  fs.rmSync(vault, { recursive: true, force: true });
});

after(() => {
  process.env.HOME = originalHome;
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('managed-core manifest validation', () => {
  it('accepts only the exact content-addressed version 1 contract', () => {
    const candidate = manifest();
    assert.deepEqual(validateCoreManifest(candidate), candidate);
  });

  it('refuses a changed entry hash, entry version, or release digest', () => {
    const badHash = manifest();
    badHash.entries[5].sha256 = '0'.repeat(64);
    assert.throws(() => validateCoreManifest(badHash), /content hash/i);

    const badVersion = manifest();
    badVersion.entries[5].version = `sha256:${'0'.repeat(64)}`;
    assert.throws(() => validateCoreManifest(badVersion), /entry version/i);

    const badRelease = manifest();
    badRelease.release_version = `sha256:${'0'.repeat(64)}`;
    assert.throws(() => validateCoreManifest(badRelease), /release version/i);
  });

  it('refuses an unknown, duplicate, unsorted, or unsafe managed path', () => {
    const unknown = manifest();
    unknown.entries[0].path = '../outside.md';
    assert.throws(() => validateCoreManifest(unknown), /managed path/i);

    const duplicate = manifest();
    duplicate.entries[1].path = duplicate.entries[0].path;
    assert.throws(() => validateCoreManifest(duplicate), /managed path/i);

    const unsorted = manifest();
    [unsorted.entries[0], unsorted.entries[1]] = [unsorted.entries[1], unsorted.entries[0]];
    assert.throws(() => validateCoreManifest(unsorted), /sorted/i);
  });

  it('refuses unsupported kinds, non-scalar UTF-8 content, and escaping symlinks', () => {
    const badKind = manifest();
    badKind.entries[5].kind = 'directory';
    assert.throws(() => validateCoreManifest(badKind), /kind/i);

    const badUnicode = manifest();
    badUnicode.entries[5].content = '\ud800';
    assert.throws(() => validateCoreManifest(badUnicode), /UTF-8/i);

    const validPair = manifest();
    validPair.entries[5].content = 'Flight Engineer \ud83d\ude80\n';
    assert.doesNotThrow(() => validateCoreManifest(finalizeManifest(validPair.entries)));

    const escaping = manifest();
    const link = escaping.entries.find(entry => entry.kind === 'symlink');
    link.content = '../../../../outside.md';
    finalizeManifest(escaping.entries);
    assert.throws(() => validateCoreManifest(escaping), /escapes/i);
  });

  it('decodes the HTTP response as strict UTF-8 JSON', async () => {
    const bytes = Buffer.from([0xff, 0xfe, 0xfd]);
    const fetchImpl = async () => ({
      status: 200,
      headers: { get: () => 'application/json' },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });

    await assert.rejects(fetchCoreManifest(SERVER, { fetchImpl }), /UTF-8/i);
  });
});

describe('syncManagedCore', () => {
  it('installs only missing allowlisted entries, records hashed ownership, and returns UPDATED', async () => {
    fs.writeFileSync(path.join(vault, 'user-note.md'), 'mine\n');
    const incoming = manifest();
    const result = await syncManagedCore(vault, SERVER, {
      fetchImpl: async () => responseFor(incoming),
    });

    assert.equal(result.outcome, 'UPDATED');
    assert.equal(result.changedPaths.length, MANAGED_CORE_ENTRIES.length);
    assert.equal(fs.readFileSync(path.join(vault, 'user-note.md'), 'utf8'), 'mine\n');
    for (const entry of incoming.entries) {
      const target = path.join(vault, entry.path);
      if (entry.kind === 'symlink') assert.equal(fs.readlinkSync(target), entry.content);
      else assert.equal(fs.readFileSync(target, 'utf8'), entry.content);
    }

    const statePath = managedCoreStatePath(vault, SERVER);
    const stateText = fs.readFileSync(statePath, 'utf8');
    const state = JSON.parse(stateText);
    assert.equal(state.schema_version, 1);
    assert.equal(state.release_version, incoming.release_version);
    assert.equal(Object.keys(state.entries).length, MANAGED_CORE_ENTRIES.length);
    assert.doesNotMatch(path.basename(statePath), /flightdeck|command-center/i);
    assert.doesNotMatch(stateText, /flightdeck\.example\.test/);
  });

  it('returns ALREADY_CURRENT on a repeated no-change run without rewriting state', async () => {
    const incoming = manifest();
    const fetchImpl = async () => responseFor(incoming);
    await syncManagedCore(vault, SERVER, { fetchImpl });
    const statePath = managedCoreStatePath(vault, SERVER);
    const before = fs.statSync(statePath).mtimeMs;

    const result = await syncManagedCore(vault, SERVER, { fetchImpl });

    assert.equal(result.outcome, 'ALREADY_CURRENT');
    assert.deepEqual(result.changedPaths, []);
    assert.equal(fs.statSync(statePath).mtimeMs, before);
  });

  it('adopts identical existing content without rewriting it', async () => {
    const incoming = manifest();
    incoming.entries.forEach(entry => installTarget(vault, entry));
    const target = path.join(vault, 'agents', 'flight-engineer.md');
    const before = fs.statSync(target).mtimeMs;

    const result = await syncManagedCore(vault, SERVER, {
      fetchImpl: async () => responseFor(incoming),
    });

    assert.equal(result.outcome, 'ALREADY_CURRENT');
    assert.equal(fs.statSync(target).mtimeMs, before);
    assert.ok(fs.existsSync(managedCoreStatePath(vault, SERVER)));
  });

  it('returns NEEDS_DECISION and makes no mutation for unowned differing content', async () => {
    const incoming = manifest();
    const target = path.join(vault, 'agents', 'flight-engineer.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '# local flight engineer\n');

    const result = await syncManagedCore(vault, SERVER, {
      fetchImpl: async () => responseFor(incoming),
    });

    assert.equal(result.outcome, 'NEEDS_DECISION');
    assert.match(result.evidence.join(' '), /flight-engineer\.md/);
    assert.equal(fs.readFileSync(target, 'utf8'), '# local flight engineer\n');
    assert.equal(fs.existsSync(path.join(vault, 'agents', 'chief-of-staff.md')), false);
    assert.equal(fs.existsSync(managedCoreStatePath(vault, SERVER)), false);
  });

  it('updates content only when the destination still matches retained ownership state', async () => {
    const first = manifest('one');
    const second = manifest('two');
    await syncManagedCore(vault, SERVER, { fetchImpl: async () => responseFor(first) });

    const result = await syncManagedCore(vault, SERVER, {
      fetchImpl: async () => responseFor(second),
    });

    assert.equal(result.outcome, 'UPDATED');
    assert.equal(
      fs.readFileSync(path.join(vault, 'agents', 'flight-engineer.md'), 'utf8'),
      second.entries.find(entry => entry.path === 'agents/flight-engineer.md').content,
    );
  });

  it('converges on retry after application stops between atomic path renames', async () => {
    const incoming = manifest();
    const realRename = fs.renameSync;
    let vaultRenames = 0;
    fs.renameSync = (source, destination) => {
      if (source.includes(`${path.sep}.pilot-core-`) && ++vaultRenames === 2) {
        throw new Error('simulated interruption');
      }
      return realRename(source, destination);
    };

    let interrupted;
    try {
      interrupted = await syncManagedCore(vault, SERVER, {
        fetchImpl: async () => responseFor(incoming),
      });
    } finally {
      fs.renameSync = realRename;
    }

    assert.equal(interrupted.outcome, 'BLOCKED');
    assert.equal(fs.existsSync(managedCoreStatePath(vault, SERVER)), false);
    assert.equal(fs.existsSync(path.join(vault, incoming.entries[0].path)), true);

    const retried = await syncManagedCore(vault, SERVER, {
      fetchImpl: async () => responseFor(incoming),
    });
    assert.equal(retried.outcome, 'UPDATED');
    assert.ok(fs.existsSync(managedCoreStatePath(vault, SERVER)));
  });

  it('adopts the verified incoming set on retry when ownership-state rename failed', async () => {
    const incoming = manifest();
    const statePath = managedCoreStatePath(vault, SERVER);
    const realRename = fs.renameSync;
    fs.renameSync = (source, destination) => {
      if (destination === statePath) throw new Error('simulated state-save failure');
      return realRename(source, destination);
    };

    let interrupted;
    try {
      interrupted = await syncManagedCore(vault, SERVER, {
        fetchImpl: async () => responseFor(incoming),
      });
    } finally {
      fs.renameSync = realRename;
    }

    assert.equal(interrupted.outcome, 'BLOCKED');
    assert.equal(fs.existsSync(statePath), false);
    for (const entry of incoming.entries) {
      assert.equal(fs.existsSync(path.join(vault, entry.path)), true);
    }

    const retried = await syncManagedCore(vault, SERVER, {
      fetchImpl: async () => responseFor(incoming),
    });
    assert.equal(retried.outcome, 'ALREADY_CURRENT');
    assert.ok(fs.existsSync(statePath));
  });

  it('returns BLOCKED before writes when a managed destination was locally modified', async () => {
    const first = manifest('one');
    const second = manifest('two');
    await syncManagedCore(vault, SERVER, { fetchImpl: async () => responseFor(first) });
    const modified = path.join(vault, 'agents', 'flight-engineer.md');
    const untouched = path.join(vault, 'agents', 'chief-of-staff.md');
    fs.writeFileSync(modified, '# local edit\n');

    const result = await syncManagedCore(vault, SERVER, {
      fetchImpl: async () => responseFor(second),
    });

    assert.equal(result.outcome, 'BLOCKED');
    assert.match(result.evidence.join(' '), /locally modified/i);
    assert.equal(fs.readFileSync(modified, 'utf8'), '# local edit\n');
    assert.equal(
      fs.readFileSync(untouched, 'utf8'),
      first.entries.find(entry => entry.path === 'agents/chief-of-staff.md').content,
    );
  });

  it('refuses deletion and type ambiguity after ownership was established', async () => {
    const incoming = manifest();
    const fetchImpl = async () => responseFor(incoming);
    await syncManagedCore(vault, SERVER, { fetchImpl });
    fs.unlinkSync(path.join(vault, 'agents', 'flight-engineer.md'));

    const deleted = await syncManagedCore(vault, SERVER, { fetchImpl });
    assert.equal(deleted.outcome, 'BLOCKED');
    assert.match(deleted.evidence.join(' '), /deleted/i);

    fs.mkdirSync(path.join(vault, 'agents', 'flight-engineer.md'));
    const wrongType = await syncManagedCore(vault, SERVER, { fetchImpl });
    assert.equal(wrongType.outcome, 'BLOCKED');
    assert.match(wrongType.evidence.join(' '), /type|locally modified/i);
  });

  it('validates the complete manifest before any write and reports server unavailability as BLOCKED', async () => {
    const invalid = manifest();
    invalid.entries.pop();
    const invalidResult = await syncManagedCore(vault, SERVER, {
      fetchImpl: async () => responseFor(invalid),
    });
    assert.equal(invalidResult.outcome, 'NEEDS_DECISION');
    assert.equal(fs.existsSync(path.join(vault, 'agents')), false);

    const unavailable = await syncManagedCore(vault, SERVER, {
      fetchImpl: async () => responseFor({ error: 'unavailable' }, { status: 500 }),
    });
    assert.equal(unavailable.outcome, 'BLOCKED');
  });

  it('refuses identity-valid ownership state behind a symlinked state directory before vault mutation', async () => {
    const first = manifest('one');
    const second = manifest('two');
    await syncManagedCore(vault, SERVER, { fetchImpl: async () => responseFor(first) });

    const managedPath = path.join(vault, 'agents', 'flight-engineer.md');
    const statePath = managedCoreStatePath(vault, SERVER);
    const validState = fs.readFileSync(statePath);
    const attackDirectory = fs.mkdtempSync(path.join(TEST_HOME, 'managed-core-attack-'));
    fs.writeFileSync(path.join(attackDirectory, path.basename(statePath)), validState);
    fs.rmSync(MANAGED_CORE_STATE_DIR, { recursive: true });
    fs.symlinkSync(attackDirectory, MANAGED_CORE_STATE_DIR);

    try {
      const result = await syncManagedCore(vault, SERVER, {
        fetchImpl: async () => responseFor(second),
      });

      assert.equal(result.outcome, 'BLOCKED');
      assert.match(result.evidence.join(' '), /state directory/i);
      assert.equal(
        fs.readFileSync(managedPath, 'utf8'),
        first.entries.find(entry => entry.path === 'agents/flight-engineer.md').content,
      );
    } finally {
      fs.unlinkSync(MANAGED_CORE_STATE_DIR);
      fs.rmSync(attackDirectory, { recursive: true, force: true });
      fs.mkdirSync(MANAGED_CORE_STATE_DIR, { recursive: true });
    }
  });
});
