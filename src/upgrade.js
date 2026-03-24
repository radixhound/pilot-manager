import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { resolveDaemonEntry } from './launchd.js';

const DAEMON_PACKAGE = '@radnine/claude-session-daemon';

export function getInstalledDaemonVersion() {
  const entry = resolveDaemonEntry();
  if (!entry) return null;

  try {
    const pkgPath = path.resolve(entry, '..', '..', 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      return pkg.version;
    }
  } catch {
    // ignore
  }
  return null;
}

export function getLatestDaemonVersion() {
  try {
    return execSync(`npm view ${DAEMON_PACKAGE} version`, { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(`Cannot fetch latest version of ${DAEMON_PACKAGE} from npm`);
  }
}

export function upgradeDaemon(targetVersion) {
  const spec = targetVersion ? `${DAEMON_PACKAGE}@${targetVersion}` : `${DAEMON_PACKAGE}@latest`;

  try {
    execSync(`npm install -g ${spec}`, { encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    throw new Error(`npm install -g ${spec} failed: ${err.message}`);
  }

  // Return the version that was actually installed
  return getInstalledDaemonVersion();
}
