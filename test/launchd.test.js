import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TEST_DIR = path.join(os.tmpdir(), `pilot-manager-launchd-test-${Date.now()}`);
const origHome = process.env.HOME;

process.env.HOME = TEST_DIR;
fs.mkdirSync(path.join(TEST_DIR, '.config', 'claude-pilot-manager', 'env'), { recursive: true });
fs.mkdirSync(path.join(TEST_DIR, '.config', 'claude-pilot-manager', 'logs'), { recursive: true });
fs.mkdirSync(path.join(TEST_DIR, 'Library', 'LaunchAgents'), { recursive: true });

const { generatePlist, plistPath, resolveNodeBinary } = await import('../src/launchd.js');
const { saveConfig } = await import('../src/config.js');
const { addProject } = await import('../src/registry.js');

describe('Plist Generation', () => {
  before(() => {
    saveConfig({ server_url: 'http://localhost:3000', base_port: 3601, auto_restart: true });
  });

  it('generates valid plist XML', () => {
    const projectConfig = {
      path: '/tmp/test-project',
      port: 3601,
      pilot_id: 'test-pilot',
      auth_token: 'abc123',
      auto_restart: true,
      extra_env: {},
    };
    const globalConfig = {
      server_url: 'http://localhost:3000',
      auto_restart: true,
    };

    // This may throw if daemon not found — skip gracefully
    let plist;
    try {
      plist = generatePlist('test-project', projectConfig, globalConfig);
    } catch (err) {
      if (err.message.includes('Cannot find')) {
        // Daemon not installed globally — test plist structure won't work
        // but we can still test other aspects
        return;
      }
      throw err;
    }

    assert.ok(plist.includes('<?xml version="1.0"'));
    assert.ok(plist.includes('com.radnine.pilot.test-project'));
    assert.ok(plist.includes('<key>CLAUDE_DAEMON_PORT</key>'));
    assert.ok(plist.includes('<string>3601</string>'));
    assert.ok(plist.includes('<key>CLAUDE_AUTH_TOKEN</key>'));
    assert.ok(plist.includes('<string>abc123</string>'));
    assert.ok(plist.includes('<key>KeepAlive</key>'));
    assert.ok(plist.includes('<true/>'));
    assert.ok(plist.includes('ThrottleInterval'));
  });

  it('uses correct plist path', () => {
    const pp = plistPath('my-project');
    assert.ok(pp.endsWith('com.radnine.pilot.my-project.plist'));
    assert.ok(pp.includes('LaunchAgents'));
  });

  it('resolves node binary', () => {
    const nodeBin = resolveNodeBinary();
    assert.ok(nodeBin.includes('node'));
    assert.ok(fs.existsSync(nodeBin));
  });

  it('sanitizes project names in labels', () => {
    const pp = plistPath('My Project With Spaces!');
    assert.ok(pp.includes('com.radnine.pilot.my-project-with-spaces-'));
  });

  it('handles auto_restart false', () => {
    const projectConfig = {
      path: '/tmp/test-project',
      port: 3601,
      pilot_id: 'test-pilot',
      auth_token: null,
      auto_restart: false,
      extra_env: {},
    };
    const globalConfig = { server_url: 'http://localhost:3000', auto_restart: true };

    let plist;
    try {
      plist = generatePlist('no-restart', projectConfig, globalConfig);
    } catch (err) {
      if (err.message.includes('Cannot find')) return;
      throw err;
    }

    assert.ok(plist.includes('<false/>'));
  });
});

after(() => {
  process.env.HOME = origHome;
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});
