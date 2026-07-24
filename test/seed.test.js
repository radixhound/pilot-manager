import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

// Isolate config/registry under a temp HOME (same approach as registrar.test.js)
// so loadConfig()/persistServerUrl() read defaults, not the real machine.
const TEST_DIR = path.join(os.tmpdir(), `pilot-manager-seed-test-${process.pid}`);
const origHome = process.env.HOME;
process.env.HOME = TEST_DIR;
fs.mkdirSync(path.join(TEST_DIR, '.config', 'claude-pilot-manager'), { recursive: true });

const { fetchSeedTarball, seedCommandCenter, verifyVault } = await import('../src/seed.js');
const { loadConfig, persistServerUrl } = await import('../src/config.js');
const { addProject } = await import('../src/registry.js');
const { run } = await import('../src/cli.js');

const PERSONAS = ['optimus-prime', 'indiana-jones', 'sherlock-holmes'];

// Build a Command Center vault fixture on disk, tar+gzip it, and return the
// archive bytes as an ArrayBuffer (what a real fetch().arrayBuffer() yields).
// The three personas are symlinks into personas/<name>/<name>.md so the tests
// can prove symlinks survive the tar round-trip. Options let a test corrupt one
// symlink (breakSymlink) or point it outside the tree (escapeSymlink).
function buildVaultTarball({ wrap = true, breakSymlink = false, escapeSymlink = false } = {}) {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-seed-src-'));
  const vault = wrap ? path.join(src, 'command-center') : src;
  fs.mkdirSync(path.join(vault, '.claude', 'personas'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'INDEX.md'), '# Command Center\n');

  PERSONAS.forEach((name, i) => {
    const realDir = path.join(vault, 'personas', name);
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, `${name}.md`), `# ${name}\n`);

    let target;
    if (escapeSymlink && i === 0) {
      target = '/etc/hosts'; // absolute → escapes the vault tree
    } else if (breakSymlink && i === 0) {
      target = path.join('..', '..', 'personas', name, 'missing.md');
    } else {
      target = path.join('..', '..', 'personas', name, `${name}.md`);
    }
    fs.symlinkSync(target, path.join(vault, '.claude', 'personas', `${name}.md`));
  });

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-seed-tar-'));
  const tarPath = path.join(outDir, 'seed.tar.gz');
  execSync(`tar -czf "${tarPath}" -C "${src}" "${wrap ? 'command-center' : '.'}"`);
  const buf = fs.readFileSync(tarPath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  fs.rmSync(src, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
  return ab;
}

// Install a fake global.fetch for the duration of one test.
function mockFetch(fn) {
  global.fetch = fn;
}

// Count leftover staging dirs so tests can assert "no partial writes".
function stagingDirs(root) {
  return fs.readdirSync(root).filter(n => n.startsWith('.pilot-seed-'));
}

const realFetch = global.fetch;
let targetRoot;

beforeEach(() => {
  targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-seed-target-'));
  const configFile = path.join(TEST_DIR, '.config', 'claude-pilot-manager', 'config.yml');
  const projectsFile = path.join(TEST_DIR, '.config', 'claude-pilot-manager', 'projects.yml');
  if (fs.existsSync(configFile)) fs.unlinkSync(configFile);
  if (fs.existsSync(projectsFile)) fs.unlinkSync(projectsFile);
});

afterEach(() => {
  global.fetch = realFetch;
  fs.rmSync(targetRoot, { recursive: true, force: true });
});

after(() => {
  process.env.HOME = origHome;
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('fetchSeedTarball error vocabulary', () => {
  it('explains a 404 as "server has not packaged a seed"', async () => {
    mockFetch(async () => ({ status: 404, text: async () => 'Not Found' }));
    await assert.rejects(
      fetchSeedTarball('http://localhost:3000'),
      /has not packaged a seed vault/
    );
  });

  it('translates ECONNREFUSED into "Cannot reach server"', async () => {
    mockFetch(async () => {
      const err = new Error('fetch failed');
      err.cause = { code: 'ECONNREFUSED' };
      throw err;
    });
    await assert.rejects(
      fetchSeedTarball('http://localhost:9999'),
      /Cannot reach server at http:\/\/localhost:9999/
    );
  });

  it('reports status + body on other non-2xx responses', async () => {
    mockFetch(async () => ({ status: 500, text: async () => 'boom' }));
    await assert.rejects(
      fetchSeedTarball('http://localhost:3000'),
      /Seed download failed \(500\): boom/
    );
  });
});

describe('verifyVault', () => {
  it('rejects a symlink that resolves outside the vault tree', () => {
    // Extract a fixture whose first persona escapes to /etc/hosts, then verify.
    const ab = buildVaultTarball({ escapeSymlink: true });
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-verify-'));
    fs.writeFileSync(path.join(work, 's.tar.gz'), Buffer.from(ab));
    execSync(`tar -xzf "${path.join(work, 's.tar.gz')}" -C "${work}"`);
    try {
      assert.throws(() => verifyVault(path.join(work, 'command-center')), /escapes the vault tree/);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});

describe('seedCommandCenter — happy path', () => {
  it('lands the vault, keeps persona symlinks intact, and reports personas', async () => {
    mockFetch(async () => ({ status: 200, arrayBuffer: async () => buildVaultTarball() }));

    const { dest, personas } = await seedCommandCenter(targetRoot, 'http://localhost:3000');

    assert.equal(dest, path.join(targetRoot, 'command-center'));
    assert.deepEqual(personas, [...PERSONAS].sort());
    assert.ok(fs.existsSync(path.join(dest, 'INDEX.md')));

    // Symlinks survived the tar round-trip AND still resolve to real files.
    for (const name of PERSONAS) {
      const link = path.join(dest, '.claude', 'personas', `${name}.md`);
      assert.ok(fs.lstatSync(link).isSymbolicLink(), `${name} should still be a symlink`);
      const resolved = fs.realpathSync(link);
      assert.ok(resolved.startsWith(fs.realpathSync(dest)), `${name} should resolve within the vault`);
      assert.equal(fs.readFileSync(resolved, 'utf8'), `# ${name}\n`);
    }

    // Staging dir was cleaned up.
    assert.deepEqual(stagingDirs(targetRoot), []);
  });

  it('accepts an archive whose vault contents sit at the root (no wrapper dir)', async () => {
    mockFetch(async () => ({ status: 200, arrayBuffer: async () => buildVaultTarball({ wrap: false }) }));
    const { dest } = await seedCommandCenter(targetRoot, 'http://localhost:3000');
    assert.ok(fs.existsSync(path.join(dest, 'INDEX.md')));
    assert.deepEqual(stagingDirs(targetRoot), []);
  });
});

describe('seedCommandCenter — refuse to clobber', () => {
  it('aborts before any download when the target already exists, leaving it untouched', async () => {
    const dest = path.join(targetRoot, 'command-center');
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(dest, 'sentinel.txt'), 'do not touch');

    let fetched = false;
    mockFetch(async () => { fetched = true; return { status: 200, arrayBuffer: async () => new ArrayBuffer(0) }; });

    await assert.rejects(
      seedCommandCenter(targetRoot, 'http://localhost:3000'),
      /Refusing to overwrite existing path/
    );

    assert.equal(fetched, false, 'must not download when refusing to clobber');
    assert.equal(fs.readFileSync(path.join(dest, 'sentinel.txt'), 'utf8'), 'do not touch');
    assert.deepEqual(stagingDirs(targetRoot), []);
  });

  it('refuses when the target is a symlink, not just a real dir', async () => {
    const dest = path.join(targetRoot, 'command-center');
    fs.symlinkSync('/tmp', dest);
    mockFetch(async () => ({ status: 200, arrayBuffer: async () => buildVaultTarball() }));
    await assert.rejects(seedCommandCenter(targetRoot, 'http://localhost:3000'), /Refusing to overwrite/);
    assert.deepEqual(stagingDirs(targetRoot), []);
  });
});

describe('seedCommandCenter — atomicity', () => {
  it('leaves the target untouched (and cleans staging) when the tarball is corrupt', async () => {
    mockFetch(async () => ({
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode('this is not a gzip stream').buffer,
    }));

    await assert.rejects(
      seedCommandCenter(targetRoot, 'http://localhost:3000'),
      /Could not extract seed archive/
    );

    assert.ok(!fs.existsSync(path.join(targetRoot, 'command-center')), 'no partial vault');
    assert.deepEqual(stagingDirs(targetRoot), [], 'staging dir cleaned up');
  });

  it('rejects a valid archive that is not a vault (missing INDEX.md), untouched target', async () => {
    // A tarball of an empty dir → extracts fine, but fails verification.
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-empty-'));
    fs.mkdirSync(path.join(src, 'command-center'));
    fs.writeFileSync(path.join(src, 'command-center', 'README.md'), 'no index here\n');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-empty-tar-'));
    execSync(`tar -czf "${path.join(outDir, 's.tar.gz')}" -C "${src}" command-center`);
    const buf = fs.readFileSync(path.join(outDir, 's.tar.gz'));
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });

    mockFetch(async () => ({ status: 200, arrayBuffer: async () => ab }));
    await assert.rejects(seedCommandCenter(targetRoot, 'http://localhost:3000'), /INDEX\.md/);
    assert.ok(!fs.existsSync(path.join(targetRoot, 'command-center')));
    assert.deepEqual(stagingDirs(targetRoot), []);
  });

  it('rejects a vault whose persona symlink is broken', async () => {
    mockFetch(async () => ({ status: 200, arrayBuffer: async () => buildVaultTarball({ breakSymlink: true }) }));
    await assert.rejects(seedCommandCenter(targetRoot, 'http://localhost:3000'), /does not resolve/);
    assert.ok(!fs.existsSync(path.join(targetRoot, 'command-center')));
    assert.deepEqual(stagingDirs(targetRoot), []);
  });
});

describe('seedCommandCenter — target validation', () => {
  it('rejects a target root that does not exist', async () => {
    mockFetch(async () => ({ status: 200, arrayBuffer: async () => buildVaultTarball() }));
    await assert.rejects(
      seedCommandCenter(path.join(targetRoot, 'nope'), 'http://localhost:3000'),
      /is not an existing directory/
    );
  });
});

describe('persistServerUrl (register/seed --server bug fix)', () => {
  it('writes config when the URL differs and returns true', () => {
    assert.equal(loadConfig().server_url, 'http://localhost:3000');
    assert.equal(persistServerUrl('http://real-server:3000'), true);
    assert.equal(loadConfig().server_url, 'http://real-server:3000');
  });

  it('is a no-op (returns false) when the URL already matches', () => {
    persistServerUrl('http://real-server:3000');
    assert.equal(persistServerUrl('http://real-server:3000'), false);
  });
});

describe('CLI persists --server', () => {
  it('register --server saves server_url to config (was used for the call only)', async () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-proj-'));
    addProject('demo', proj);
    // Confirm a never-configured machine starts at the localhost default.
    assert.equal(loadConfig().server_url, 'http://localhost:3000');

    mockFetch(async () => ({
      status: 201,
      json: async () => ({ pilot: { pilot_id: 'p1' }, authentication: { api_key: 'tok_abc' } }),
    }));

    await run(['register', 'demo', '--server', 'http://real-server:3000']);

    assert.equal(loadConfig().server_url, 'http://real-server:3000');
    fs.rmSync(proj, { recursive: true, force: true });
  });

  it('seed --server saves server_url to config and delivers the vault', async () => {
    mockFetch(async () => ({ status: 200, arrayBuffer: async () => buildVaultTarball() }));
    await run(['seed', targetRoot, '--server', 'http://real-server:3000']);

    assert.equal(loadConfig().server_url, 'http://real-server:3000');
    assert.ok(fs.existsSync(path.join(targetRoot, 'command-center', 'INDEX.md')));
  });

  it('seed does NOT persist --server when the seed fails (atomic: no config mutation)', async () => {
    // A failing seed (bad target root) must leave config at its default — the
    // --server is only remembered once a vault has actually been delivered.
    const before = loadConfig().server_url;
    mockFetch(async () => ({ status: 200, arrayBuffer: async () => buildVaultTarball() }));

    const realExit = process.exit;
    process.exit = () => { throw new Error('exit'); }; // seed calls process.exit(1) on failure
    try {
      await run(['seed', path.join(targetRoot, 'missing'), '--server', 'http://should-not-persist:3000']);
    } catch { /* expected: our exit stub throws */ }
    finally { process.exit = realExit; }

    assert.equal(loadConfig().server_url, before);
  });
});
