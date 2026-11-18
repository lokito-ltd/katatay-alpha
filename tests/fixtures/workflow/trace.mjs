/**
 * The git commands a piece of code starts, for the tests that count them.
 *
 * What the workflow's reads of git cost is almost entirely the starting of git
 * processes, about 10ms each, and not the work they do. So the number of
 * processes is the thing worth holding down, and it is exact where a timing is
 * not: a test that counts them fails the moment a call that was merged is split
 * apart again, on any machine, however loaded.
 *
 * `GIT_TRACE` names a file every git process appends a line to as it starts.
 * The code under test inherits it through `process.env`, as every
 * `execFileSync` here does. A value set by whoever ran the suite is put back
 * afterwards, so measuring the suite with `GIT_TRACE` still works.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** @returns {string[]} each git command started, without the leading `git ` */
export function gitCommandsDuring(run) {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-trace-'));
  const file = join(dir, 'trace.log');
  const before = process.env.GIT_TRACE;
  process.env.GIT_TRACE = file;
  try {
    run();
  } finally {
    if (before === undefined) delete process.env.GIT_TRACE;
    else process.env.GIT_TRACE = before;
  }
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  rmSync(dir, { recursive: true, force: true });
  return lines.filter((line) => line.includes('trace: built-in: git ')).map((line) => line.replace(/^.*trace: built-in: git /, ''));
}
