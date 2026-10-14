import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

// Isolate config/registry under a temp HOME (same approach as registry.test.js)
// so loadConfig() inside registerPilot reads defaults, not the real machine.
const TEST_DIR = path.join(os.tmpdir(), `pilot-manager-registrar-test-${process.pid}`);
process.env.HOME = TEST_DIR;
fs.mkdirSync(path.join(TEST_DIR, '.config', 'claude-pilot-manager'), { recursive: true });

const { gitRemoteFor, registerPilot, registerProject } = await import('../src/registrar.js');
const { addProject } = await import('../src/registry.js');

// Build a throwaway git repo with the given origin and return its path.
function makeRepo(remote) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-repo-'));
  execSync('git init -q', { cwd: dir });
  if (remote) execSync(`git remote add origin ${remote}`, { cwd: dir });
  return dir;
}

describe('gitRemoteFor', () => {
  it('returns the origin URL for a repo that has one', () => {
    const dir = makeRepo('git@github.com:radixhound/rad-project.git');
    try {
      assert.equal(gitRemoteFor(dir), 'git@github.com:radixhound/rad-project.git');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns "" for a git repo with no origin remote', () => {
    const dir = makeRepo(null);
    try {
      assert.equal(gitRemoteFor(dir), '');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns "" for a directory that is not a git repo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-plain-'));
    try {
      assert.equal(gitRemoteFor(dir), '');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('registerPilot payload', () => {
  const realFetch = global.fetch;
  let captured;

  beforeEach(() => {
    captured = null;
    global.fetch = async (url, opts) => {
      captured = { url, body: JSON.parse(opts.body) };
      return {
        status: 201,
        json: async () => ({
          pilot: { pilot_id: 'p1' },
          authentication: { api_key: 'tok_abc', token_type: 'Bearer' },
        }),
      };
    };
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('includes the project git remote so the server can create the Repo', async () => {
    const dir = makeRepo('git@github.com:radixhound/rad-project.git');
    try {
      await registerPilot('http://localhost:3000', 'rad-project', {
        pilot_id: 'rad-project-pilot',
        port: 3601,
        path: dir,
      });
      assert.equal(captured.url, 'http://localhost:3000/api/pilot_auth/register');
      assert.equal(captured.body.pilot.git_remote, 'git@github.com:radixhound/rad-project.git');
      assert.equal(captured.body.pilot.working_directory, dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends an empty git_remote (not undefined) when there is no origin', async () => {
    const dir = makeRepo(null);
    try {
      await registerPilot('http://localhost:3000', 'no-origin', {
        pilot_id: 'no-origin-pilot',
        port: 3602,
        path: dir,
      });
      assert.equal(captured.body.pilot.git_remote, '');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('registerProject --force', () => {
  const realFetch = global.fetch;
  let calls;

  beforeEach(() => {
    calls = [];
    const projectsFile = path.join(TEST_DIR, '.config', 'claude-pilot-manager', 'projects.yml');
    if (fs.existsSync(projectsFile)) fs.unlinkSync(projectsFile);
    addProject('forced', path.join(TEST_DIR, 'forced'));
    const data = fs.readFileSync(projectsFile, 'utf8').replace('auth_token: null', 'auth_token: old-token');
    fs.writeFileSync(projectsFile, data);
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('registers without revoking the stored token first', async () => {
    global.fetch = async (url, opts) => {
      calls.push({ url, method: opts?.method, body: opts?.body && JSON.parse(opts.body) });
      return {
        status: 201,
        json: async () => ({
          pilot: { pilot_id: 'forced-pilot' },
          authentication: { api_key: 'new-token', token_type: 'Bearer' },
        }),
      };
    };
    const result = await registerProject('forced', { server: 'http://localhost:3000', force: true });
    assert.deepEqual(calls.map(c => c.url), ['http://localhost:3000/api/pilot_auth/register']);
    assert.equal(calls[0].body.force, true);
    assert.equal(result.auth_token, 'new-token');
  });

  it('makes no revoke call when the server refuses with machine_conflict', async () => {
    const message = "Pilot 'forced-pilot' is registered to machine 'mini', but this request came from 'studio'.";
    global.fetch = async (url, opts) => {
      calls.push({ url, method: opts?.method });
      return { status: 422, text: async () => JSON.stringify({ error: message, reason: 'machine_conflict' }) };
    };
    await assert.rejects(
      registerProject('forced', { server: 'http://localhost:3000', force: true }),
      err => err.message === message,
    );
    assert.ok(!calls.some(c => c.url.endsWith('/revoke')), JSON.stringify(calls));
  });
});

describe('registerPilot 422 machine_conflict', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('surfaces the server error text as is, with no --force hint', async () => {
    const message = "Pilot 'p-pilot-mini' is registered to machine 'mini', but this request came from 'studio'. " +
      '(--force does not override this)';
    global.fetch = async () => ({
      status: 422,
      text: async () => JSON.stringify({ error: message, reason: 'machine_conflict' }),
    });
    await assert.rejects(
      registerPilot('http://localhost:3000', 'p', { pilot_id: 'p-pilot-mini', port: 3601, path: TEST_DIR }),
      err => {
        assert.equal(err.message, message);
        assert.doesNotMatch(err.message, /Use --force/);
        return true;
      },
    );
  });

  it('keeps the generic message for other 422s', async () => {
    global.fetch = async () => ({ status: 422, text: async () => '{"errors":["bad"]}' });
    await assert.rejects(
      registerPilot('http://localhost:3000', 'p', { pilot_id: 'p', port: 3601, path: TEST_DIR }),
      /Registration failed \(422\): \{"errors":\["bad"\]\}/,
    );
  });
});
