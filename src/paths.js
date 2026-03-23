import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export const CONFIG_DIR = path.join(os.homedir(), '.config', 'claude-pilot-manager');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.yml');
export const PROJECTS_FILE = path.join(CONFIG_DIR, 'projects.yml');
export const ENV_DIR = path.join(CONFIG_DIR, 'env');
export const LOGS_DIR = path.join(CONFIG_DIR, 'logs');
export const LAUNCHD_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');

export function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(ENV_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}
