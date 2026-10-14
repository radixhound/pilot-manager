import fs from 'node:fs';
import os from 'node:os';
import yaml from 'js-yaml';
import { PROJECTS_FILE, ensureConfigDir } from './paths.js';
import { loadConfig } from './config.js';

function loadRaw() {
  if (!fs.existsSync(PROJECTS_FILE)) {
    return { projects: {} };
  }
  const raw = fs.readFileSync(PROJECTS_FILE, 'utf8');
  const parsed = yaml.load(raw);
  if (!parsed || !parsed.projects) return { projects: {} };
  return parsed;
}

function saveRaw(data) {
  ensureConfigDir();
  const tmp = PROJECTS_FILE + '.tmp';
  fs.writeFileSync(tmp, yaml.dump(data, { lineWidth: -1 }));
  fs.renameSync(tmp, PROJECTS_FILE);
}

export function loadProjects() {
  return loadRaw();
}

export function saveProjects(data) {
  saveRaw(data);
}

export function getProject(name) {
  const data = loadRaw();
  return data.projects[name] || null;
}

export function listProjects() {
  const data = loadRaw();
  return Object.entries(data.projects).map(([name, config]) => ({
    name,
    ...config,
  }));
}

export function nextAvailablePort() {
  const config = loadConfig();
  const basePort = config.base_port || 3601;
  const projects = listProjects();
  const usedPorts = new Set(projects.map(p => p.port));

  let port = basePort;
  while (usedPorts.has(port)) {
    port++;
  }
  return port;
}

// The daemon puts the pilot id into `/cable?pilot_id=` without encoding it,
// so anything outside the URL-unreserved set becomes `-`.
function urlSafe(part) {
  return String(part).replace(/[^A-Za-z0-9._~-]/g, '-');
}

function currentUsername() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER || process.env.LOGNAME || 'user';
  }
}

// Every new pilot id is minted here: `<name>-pilot-<hostname>-<user>`.
// The user part keeps two macOS users on one Mac (or two Macs sharing a
// hostname) from colliding. Ids already in projects.yml are never rewritten.
export function mintPilotId(name, { hostname = os.hostname(), username = currentUsername() } = {}) {
  return `${name}-pilot-${urlSafe(hostname)}-${urlSafe(username)}`;
}

export function addProject(name, projectPath, options = {}) {
  const data = loadRaw();

  if (data.projects[name]) {
    throw new Error(`Project "${name}" already exists in registry`);
  }

  const port = options.port || nextAvailablePort();

  data.projects[name] = {
    path: projectPath,
    port,
    pilot_id: mintPilotId(name),
    auth_token: null,
    auto_restart: true,
    extra_env: {},
  };

  saveRaw(data);
  return data.projects[name];
}

export function removeProject(name) {
  const data = loadRaw();
  if (!data.projects[name]) {
    throw new Error(`Project "${name}" not found in registry`);
  }
  delete data.projects[name];
  saveRaw(data);
}
