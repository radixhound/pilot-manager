import { describe, it, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-manager-cli-home-'));
const originalHome = process.env.HOME;
process.env.HOME = TEST_HOME;

const { run } = await import('../src/cli.js');

const realExit = process.exit;
const realError = console.error;

afterEach(() => {
  process.exit = realExit;
  console.error = realError;
});

after(() => {
  process.env.HOME = originalHome;
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

async function captureRefusal(argv) {
  const output = [];
  console.error = line => output.push(String(line));
  process.exit = code => {
    const error = new Error(`exit ${code}`);
    error.exitCode = code;
    throw error;
  };

  let exitError;
  try {
    await run(argv);
  } catch (error) {
    exitError = error;
  }
  return { exitError, output };
}

describe('managed command exit contract', () => {
  it('returns exit 3 and NEEDS_DECISION when sync-core lacks its target', async () => {
    const { exitError, output } = await captureRefusal(['sync-core']);
    assert.equal(exitError.exitCode, 3);
    assert.equal(output[0], 'NEEDS_DECISION');
  });

  it('returns exit 3 and NEEDS_DECISION when maintain lacks an exact configured project', async () => {
    const { exitError, output } = await captureRefusal([
      'maintain', 'not-configured', '--command-center', '/does/not/matter',
    ]);
    assert.equal(exitError.exitCode, 3);
    assert.equal(output[0], 'NEEDS_DECISION');
    assert.match(output.join(' '), /not configured/i);
  });
});
