import os from 'node:os';
import fs from 'node:fs';
import { loadConfig } from './config.js';
import { getProject, loadProjects, saveProjects, listProjects } from './registry.js';

function getPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return pkg.version;
  } catch {
    return '0.1.0';
  }
}

export async function registerPilot(serverUrl, projectName, projectConfig) {
  const globalConfig = loadConfig();
  const version = getPackageVersion();
  const maxSessions = globalConfig.max_sessions_per_project || 10;

  const body = {
    pilot: {
      pilot_id: projectConfig.pilot_id,
      machine_id: os.hostname(),
      host: 'localhost',
      port: projectConfig.port,
      version,
      working_directory: projectConfig.path,
      max_sessions: maxSessions,
      security_level: 'standard',
      access_scope: 'global',
      capabilities: {
        max_concurrent_sessions: maxSessions,
        supported_features: ['streaming'],
      },
      environment_variables: {},
      metadata: {
        registered_via: 'pilot-manager',
        manager_version: version,
      },
      allowed_operations: [
        'heartbeat',
        'session_create',
        'command_execute',
        'session_recover',
      ],
    },
  };

  let response;
  try {
    response = await fetch(`${serverUrl}/api/pilot_auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (err.cause?.code === 'ECONNREFUSED' || err.message.includes('fetch failed')) {
      throw new Error(`Cannot reach server at ${serverUrl}. Is it running?`);
    }
    throw err;
  }

  if (response.status === 201) {
    const data = await response.json();
    return {
      pilot_id: data.pilot?.pilot_id,
      auth_token: data.authentication?.api_key,
      token_type: data.authentication?.token_type || 'Bearer',
    };
  }

  if (response.status === 409) {
    const data = await response.json();
    throw new Error(`Already registered: ${data.error || 'pilot_id conflict'}. Use --force to re-register.`);
  }

  const text = await response.text();
  throw new Error(`Registration failed (${response.status}): ${text}`);
}

export async function checkTokenStatus(serverUrl, authToken) {
  let response;
  try {
    response = await fetch(`${serverUrl}/api/pilot_auth/status`, {
      headers: { 'Authorization': `Bearer ${authToken}` },
    });
  } catch {
    return { valid: false, error: 'unreachable' };
  }

  if (response.status === 200) {
    return await response.json();
  }

  return { valid: false };
}

export async function revokeToken(serverUrl, authToken) {
  let response;
  try {
    response = await fetch(`${serverUrl}/api/pilot_auth/revoke`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${authToken}` },
    });
  } catch (err) {
    throw new Error(`Cannot reach server at ${serverUrl}`);
  }

  if (response.status === 200) {
    return true;
  }

  const text = await response.text();
  throw new Error(`Revocation failed (${response.status}): ${text}`);
}

export async function registerProject(name, options = {}) {
  const project = getProject(name);
  if (!project) throw new Error(`Project "${name}" not found in registry`);

  const globalConfig = loadConfig();
  const serverUrl = options.server || globalConfig.server_url;

  const result = await registerPilot(serverUrl, name, project);

  // Save token to registry
  const data = loadProjects();
  data.projects[name].auth_token = result.auth_token;
  data.projects[name].registered_at = new Date().toISOString();
  saveProjects(data);

  return result;
}

export async function deregisterProject(name) {
  const project = getProject(name);
  if (!project) throw new Error(`Project "${name}" not found in registry`);
  if (!project.auth_token) throw new Error(`Project "${name}" has no auth token`);

  const globalConfig = loadConfig();
  await revokeToken(globalConfig.server_url, project.auth_token);

  // Clear token from registry
  const data = loadProjects();
  data.projects[name].auth_token = null;
  delete data.projects[name].registered_at;
  saveProjects(data);
}

export async function registerAll(options = {}) {
  const projects = listProjects();
  const results = [];

  for (const p of projects) {
    try {
      if (p.auth_token && !options.force) {
        results.push({ name: p.name, success: false, skipped: true, error: 'Already registered (use --force)' });
        continue;
      }
      const result = await registerProject(p.name, options);
      results.push({ name: p.name, success: true, ...result });
    } catch (err) {
      results.push({ name: p.name, success: false, error: err.message });
    }
  }

  return results;
}
