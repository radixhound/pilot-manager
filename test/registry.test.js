import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Override config dir for tests
const TEST_DIR = path.join(os.tmpdir(), `pilot-manager-test-${Date.now()}`);
const origHome = process.env.HOME;

// We need to patch paths before importing modules.
// The modules use os.homedir() which reads HOME env var.
process.env.HOME = TEST_DIR;
fs.mkdirSync(path.join(TEST_DIR, '.config', 'claude-pilot-manager', 'env'), { recursive: true });

const { loadConfig, saveConfig, resolveEnvVars } = await import('../src/config.js');
const { addProject, removeProject, listProjects, getProject, nextAvailablePort, loadProjects, saveProjects } = await import('../src/registry.js');

describe('Config', () => {
  beforeEach(() => {
    // Clean config between tests
    const configFile = path.join(TEST_DIR, '.config', 'claude-pilot-manager', 'config.yml');
    if (fs.existsSync(configFile)) fs.unlinkSync(configFile);
  });

  it('returns defaults when no config file exists', () => {
    const config = loadConfig();
    assert.equal(config.server_url, 'http://localhost:3000');
    assert.equal(config.base_port, 3601);
    assert.equal(config.auto_restart, true);
    assert.equal(config.log_level, 'info');
    assert.equal(config.max_sessions_per_project, 10);
  });

  it('saves and loads config', () => {
    saveConfig({ server_url: 'https://example.com', base_port: 4000, auto_restart: false, log_level: 'debug', max_sessions_per_project: 5 });
    const config = loadConfig();
    assert.equal(config.server_url, 'https://example.com');
    assert.equal(config.base_port, 4000);
    assert.equal(config.auto_restart, false);
  });
});

describe('Registry', () => {
  beforeEach(() => {
    const configFile = path.join(TEST_DIR, '.config', 'claude-pilot-manager', 'config.yml');
    const projectsFile = path.join(TEST_DIR, '.config', 'claude-pilot-manager', 'projects.yml');
    if (fs.existsSync(configFile)) fs.unlinkSync(configFile);
    if (fs.existsSync(projectsFile)) fs.unlinkSync(projectsFile);
  });

  it('starts with empty project list', () => {
    const projects = listProjects();
    assert.equal(projects.length, 0);
  });

  it('adds a project', () => {
    // Use a temp dir as the project path
    const tmpProject = path.join(TEST_DIR, 'my-project');
    fs.mkdirSync(tmpProject, { recursive: true });

    const result = addProject('my-project', tmpProject);
    assert.equal(result.port, 3601);
    assert.equal(result.pilot_id, 'my-project-pilot');
    assert.equal(result.auth_token, null);

    const projects = listProjects();
    assert.equal(projects.length, 1);
    assert.equal(projects[0].name, 'my-project');
  });

  it('auto-assigns incrementing ports', () => {
    const tmp1 = path.join(TEST_DIR, 'proj-1');
    const tmp2 = path.join(TEST_DIR, 'proj-2');
    const tmp3 = path.join(TEST_DIR, 'proj-3');
    fs.mkdirSync(tmp1, { recursive: true });
    fs.mkdirSync(tmp2, { recursive: true });
    fs.mkdirSync(tmp3, { recursive: true });

    addProject('proj-1', tmp1);
    addProject('proj-2', tmp2);
    addProject('proj-3', tmp3);

    const projects = listProjects();
    assert.equal(projects[0].port, 3601);
    assert.equal(projects[1].port, 3602);
    assert.equal(projects[2].port, 3603);
  });

  it('finds gaps in port assignment', () => {
    const tmp1 = path.join(TEST_DIR, 'gap-1');
    const tmp2 = path.join(TEST_DIR, 'gap-2');
    fs.mkdirSync(tmp1, { recursive: true });
    fs.mkdirSync(tmp2, { recursive: true });

    addProject('gap-1', tmp1); // port 3601
    addProject('gap-2', tmp2); // port 3602
    removeProject('gap-1');    // frees 3601

    const next = nextAvailablePort();
    assert.equal(next, 3601);
  });

  it('removes a project', () => {
    const tmp = path.join(TEST_DIR, 'remove-me');
    fs.mkdirSync(tmp, { recursive: true });

    addProject('remove-me', tmp);
    assert.equal(listProjects().length, 1);

    removeProject('remove-me');
    assert.equal(listProjects().length, 0);
  });

  it('throws when adding duplicate name', () => {
    const tmp = path.join(TEST_DIR, 'dup');
    fs.mkdirSync(tmp, { recursive: true });

    addProject('dup', tmp);
    assert.throws(() => addProject('dup', tmp), /already exists/);
  });

  it('throws when removing non-existent project', () => {
    assert.throws(() => removeProject('nope'), /not found/);
  });

  it('gets a single project', () => {
    const tmp = path.join(TEST_DIR, 'single');
    fs.mkdirSync(tmp, { recursive: true });

    addProject('single', tmp);
    const project = getProject('single');
    assert.equal(project.path, tmp);
    assert.equal(project.port, 3601);
  });

  it('accepts custom port', () => {
    const tmp = path.join(TEST_DIR, 'custom-port');
    fs.mkdirSync(tmp, { recursive: true });

    const result = addProject('custom-port', tmp, { port: 9999 });
    assert.equal(result.port, 9999);
  });
});

describe('Environment Variables', () => {
  it('resolves env vars with project config', () => {
    const projectConfig = {
      path: '/some/path',
      port: 3601,
      auth_token: 'test-token',
      extra_env: { CUSTOM_VAR: 'custom-value' },
    };
    const globalConfig = {
      server_url: 'http://localhost:3000',
    };

    const env = resolveEnvVars('test-project', projectConfig, globalConfig);
    assert.equal(env.CLAUDE_DAEMON_PORT, '3601');
    assert.equal(env.CLAUDE_WORKING_DIR, '/some/path');
    assert.equal(env.CLAUDE_AUTH_TOKEN, 'test-token');
    assert.equal(env.CLAUDE_DAEMON_MODE, 'actioncable');
    assert.equal(env.CLAUDE_RAILS_URL, 'http://localhost:3000');
    assert.equal(env.CUSTOM_VAR, 'custom-value');
  });

  it('reads env files', () => {
    const envDir = path.join(TEST_DIR, '.config', 'claude-pilot-manager', 'env');
    fs.writeFileSync(path.join(envDir, '_default.env'), 'DEFAULT_KEY=default_val\n# comment\n');
    fs.writeFileSync(path.join(envDir, 'myproj.env'), 'PROJECT_KEY=proj_val\n');

    const env = resolveEnvVars('myproj', { path: '/tmp', port: 3601 }, {});
    assert.equal(env.DEFAULT_KEY, 'default_val');
    assert.equal(env.PROJECT_KEY, 'proj_val');

    // Cleanup
    fs.unlinkSync(path.join(envDir, '_default.env'));
    fs.unlinkSync(path.join(envDir, 'myproj.env'));
  });
});

// Restore HOME
after(() => {
  process.env.HOME = origHome;
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});
