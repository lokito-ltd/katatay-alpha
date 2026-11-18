import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMutate } from '../../../src/workflow/adapter.mjs';

describe('running the mutation command', () => {
  let root;
  const node = (code) => `node -e ${JSON.stringify(code)}`;
  let command;
  const configure = (value) => { command = value; };
  const request = { targets: [{ file: 'src/[id]/page.ts', lines: [1, 2] }], budget: 30, verbose: false };
  const run = (options = {}) => runMutate({ command, root, input: request, keepErrors: true, ...options });
  const thrown = async (act) => {
    try {
      await act();
    } catch (error) {
      return error;
    }
    throw new Error('expected it to throw');
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-mutate-')));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('is stopped at the backstop, and says it ran out of time', async () => {
    configure(node('process.on("SIGTERM", () => {}); setTimeout(() => require("fs").writeFileSync("outlived-referee", "yes"), 1500)') + ' | cat');
    const error = await thrown(() => run({ timeout: 0.5 }));
    expect(error.timedOut).toBe(true);
    expect(error.message).toContain('was still running after 0.5 seconds');
    await new Promise(resolve => setTimeout(resolve, 1600));
    expect(existsSync(join(root, 'outlived-referee'))).toBe(false);
  });
});
