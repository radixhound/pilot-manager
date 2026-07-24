import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';
import { CONFIG_FILE, ENV_DIR, ensureConfigDir } from './paths.js';

const DEFAULTS = {
  server_url: 'http://localhost:3000',
  base_port: 3601,
  auto_restart: true,
  log_level: 'info',
  max_sessions_per_project: 10,
};

export function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    return { ...DEFAULTS };
  }
  const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  const parsed = yaml.load(raw) || {};
  return { ...DEFAULTS, ...parsed };
}

export function saveConfig(config) {
  ensureConfigDir();
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, yaml.dump(config, { lineWidth: -1 }));
  fs.renameSync(tmp, CONFIG_FILE);
}

// Persist an explicitly-chosen server URL so a later `install` bakes the right
// CLAUDE_RAILS_URL into the daemon's plist. Without this, `register --server X`
// used X only for the one API call while config kept the default localhost, so
// the installed daemon pointed at the wrong server. Returns true if the file
// changed (nothing to write when the URL already matches).
export function persistServerUrl(url) {
  const config = loadConfig();
  if (config.server_url === url) return false;
  config.server_url = url;
  saveConfig(config);
  return true;
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const env = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    env[key] = value;
  }
  return env;
}

export function resolveEnvVars(projectName, projectConfig, globalConfig) {
  const env = {};

  // 1. Load default env
  Object.assign(env, parseEnvFile(path.join(ENV_DIR, '_default.env')));

  // 2. Load project-specific env
  Object.assign(env, parseEnvFile(path.join(ENV_DIR, `${projectName}.env`)));

  // 3. Merge inline extra_env from projects.yml
  if (projectConfig.extra_env) {
    for (const [k, v] of Object.entries(projectConfig.extra_env)) {
      env[k] = String(v);
    }
  }

  // 4. Set fixed vars
  // launchd provides a minimal PATH — inherit the user's PATH so the daemon
  // can find `claude`, `node`, `git`, and other tools it spawns.
  // Always include ~/.local/bin (Claude CLI default install location).
  if (!env.PATH) {
    env.PATH = process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  }
  const localBin = path.join(os.homedir(), '.local', 'bin');
  if (!env.PATH.split(':').includes(localBin)) {
    env.PATH = `${localBin}:${env.PATH}`;
  }
  env.HOME = os.homedir();
  env.CLAUDE_DAEMON_PORT = String(projectConfig.port);
  env.CLAUDE_WORKING_DIR = projectConfig.path;
  env.CLAUDE_DAEMON_ID = projectConfig.pilot_id;
  if (projectConfig.auth_token) {
    env.CLAUDE_AUTH_TOKEN = projectConfig.auth_token;
  }
  env.CLAUDE_DAEMON_MODE = 'actioncable';
  if (globalConfig.server_url) {
    env.CLAUDE_RAILS_URL = globalConfig.server_url;
  }

  return env;
}
