import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { loadConfig } from './config.js';

// Downloads the packaged "Command Center" seed vault from the FlightDeck server
// and installs it onto this machine. The delivery is staged and atomic: nothing
// touches the target until a downloaded archive has been extracted and verified
// in a temp area, so a corrupt download or a broken vault leaves the target
// exactly as it was.
//
// Platform note: extraction shells out to `tar -xzf`, so this is macOS-only
// (the rest of pilot-manager is already macOS-only via launchd). BSD tar
// preserves symlinks on extraction, which the persona files depend on.

const SEED_PATH = '/seed/command-center.tar.gz';
const VAULT_DIRNAME = 'command-center';

// lstat (not stat) so a symlink — even a dangling one — counts as "exists".
function pathExists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

async function safeText(response) {
  try {
    return (await response.text()).trim();
  } catch {
    return '';
  }
}

// Fetch the seed tarball as a Buffer. Mirrors registrar.js's friendly-error
// vocabulary: ECONNREFUSED → "Cannot reach server"; 404 → "no packaged seed";
// any other non-2xx → status + body.
export async function fetchSeedTarball(serverUrl) {
  const url = `${serverUrl}${SEED_PATH}`;

  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    if (err.cause?.code === 'ECONNREFUSED' || err.message.includes('fetch failed')) {
      throw new Error(`Cannot reach server at ${serverUrl}. Is it running?`);
    }
    throw err;
  }

  if (response.status === 404) {
    throw new Error(
      `Server at ${serverUrl} has not packaged a seed vault (404 at ${SEED_PATH}).\n` +
      `  The FlightDeck server may be too old to ship one, or the seed hasn't been built yet.`
    );
  }

  if (response.status < 200 || response.status >= 300) {
    const body = await safeText(response);
    throw new Error(`Seed download failed (${response.status})${body ? `: ${body}` : ''}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

// An archive may wrap the vault in a top-level `command-center/` directory or
// place the vault contents at its root. Support both; the marker is INDEX.md.
function resolveVaultRoot(extractDir) {
  const wrapped = path.join(extractDir, VAULT_DIRNAME);
  if (fs.existsSync(path.join(wrapped, 'INDEX.md'))) return wrapped;
  if (fs.existsSync(path.join(extractDir, 'INDEX.md'))) return extractDir;
  throw new Error(
    'Seed archive has no INDEX.md at its root — it does not look like a Command Center vault.'
  );
}

// Confirm the extracted tree is a real vault before we move it into place:
// INDEX.md present, and every persona under .claude/personas/ resolves to an
// existing file *within* the vault tree (a downloaded symlink must not point
// outside it). Returns the sorted persona names for the success report.
export function verifyVault(vaultRoot) {
  if (!fs.existsSync(path.join(vaultRoot, 'INDEX.md'))) {
    throw new Error('Seed archive is missing INDEX.md — it does not look like a Command Center vault.');
  }

  const personasDir = path.join(vaultRoot, '.claude', 'personas');
  if (!pathExists(personasDir) || !fs.statSync(personasDir).isDirectory()) {
    throw new Error('Seed archive is missing .claude/personas/ — it does not look like a Command Center vault.');
  }

  const entries = fs.readdirSync(personasDir).filter(f => f.endsWith('.md'));
  if (entries.length === 0) {
    throw new Error('Seed archive has no personas in .claude/personas/.');
  }

  const realRoot = fs.realpathSync(vaultRoot);
  const personas = [];
  for (const entry of entries) {
    const linkPath = path.join(personasDir, entry);

    let resolved;
    try {
      resolved = fs.realpathSync(linkPath);
    } catch {
      throw new Error(`Persona "${entry}" does not resolve — its symlink target is missing.`);
    }

    const rel = path.relative(realRoot, resolved);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Persona "${entry}" escapes the vault tree (resolves to ${resolved}).`);
    }

    personas.push(path.basename(entry, '.md'));
  }

  return personas.sort();
}

// Write the tarball to a temp file, extract it, resolve + verify the vault root.
// Throws (with the temp area handed back for the caller to clean up) on any
// failure. Never writes outside `stageDir`.
function extractAndVerify(tarball, stageDir) {
  const tarPath = path.join(stageDir, 'command-center.tar.gz');
  fs.writeFileSync(tarPath, tarball);

  const extractDir = path.join(stageDir, 'extracted');
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    execSync(`tar -xzf "${tarPath}" -C "${extractDir}"`, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    const detail = err.stderr?.toString().trim() || err.message;
    throw new Error(`Could not extract seed archive (is it a valid .tar.gz?): ${detail}`);
  }

  const vaultRoot = resolveVaultRoot(extractDir);
  const personas = verifyVault(vaultRoot);
  return { vaultRoot, personas };
}

// Orchestrate the whole seed: validate the target, refuse to clobber, download,
// stage + verify, then atomically move into place. `serverUrl` precedence is the
// caller's concern (same as register: --server flag else config.server_url).
export async function seedCommandCenter(targetRoot, serverUrl) {
  const absRoot = path.resolve(targetRoot);
  if (!fs.existsSync(absRoot) || !fs.statSync(absRoot).isDirectory()) {
    throw new Error(`Target root "${absRoot}" is not an existing directory.`);
  }

  const dest = path.join(absRoot, VAULT_DIRNAME);
  if (pathExists(dest)) {
    throw new Error(`Refusing to overwrite existing path "${dest}". Move or remove it, then retry.`);
  }

  const tarball = await fetchSeedTarball(serverUrl);

  // Stage under the target root (not os.tmpdir) so the final move is an atomic,
  // same-filesystem rename rather than a cross-device copy that could fail
  // half-written. mkdtemp gives us a collision-free hidden dir alongside dest.
  const stageDir = fs.mkdtempSync(path.join(absRoot, '.pilot-seed-'));
  try {
    const { vaultRoot, personas } = extractAndVerify(tarball, stageDir);

    // Re-check right before the move: the window since the first check is where
    // a racing writer could have created dest.
    if (pathExists(dest)) {
      throw new Error(`Refusing to overwrite existing path "${dest}" (it appeared during download).`);
    }

    fs.renameSync(vaultRoot, dest);
    return { dest, personas };
  } finally {
    // Success or failure, the staging dir is disposable. On success the vault
    // has already been renamed out of it; on failure the target was never
    // touched. force:true tolerates the "already moved" case.
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}
