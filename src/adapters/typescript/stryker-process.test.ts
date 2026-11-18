/**
 * Stryker in a process tree that can be stopped. The real Stryker is never
 * started here: a stand-in child plays it, with a grandchild for its workers.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { killTree, startStryker } from './stryker-process.js';

/** The real child's way to answer and exit, for the stand-ins to share. */
const ANSWER = pathToFileURL(join(import.meta.dirname, 'stryker-answer.mjs')).href;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const until = async (check: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe('killing the run', () => {
  it('signals the whole process group', () => {
    const calls: [number, string][] = [];
    killTree(1234, (pid, signal) => { calls.push([pid, signal]); });
    expect(calls).toEqual([[-1234, 'SIGKILL']]);
  });

  // The run may end on its own between the budget and the kill.
  it('is not an error when the group is already gone', () => {
    const gone = Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    expect(() => killTree(1234, () => { throw gone; })).not.toThrow();
    const denied = Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    expect(() => killTree(1234, () => { throw denied; })).toThrow('EPERM');
  });
});

describe('a run in its own process tree', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stryker-process-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A stand-in for `stryker-child.mjs`. `body` runs on the options message,
   *  and ends the way the real child does, with `answerAndExit`. */
  const child = (body: string): string => {
    const script = join(dir, 'child.mjs');
    writeFileSync(script, `
      import { spawn } from 'node:child_process';
      import { renameSync, writeFileSync } from 'node:fs';
      import { answerAndExit } from '${ANSWER}';
      process.once('message', async (options) => { ${body} });
    `);
    return script;
  };
  const onFailure = (message: string, log: string) => `${message} | ${log}`;

  it('answers with the results the run sends back, and passes the options on', async () => {
    const script = child("answerAndExit({ results: [{ status: 'Killed', given: options.mutate }] });");
    const run = startStryker({ mutate: ['a.ts:1-2'] }, { cwd: dir, onFailure, script });
    expect(await run.done).toEqual([{ status: 'Killed', given: ['a.ts:1-2'] }]);
  });

  // Stryker's error, with its log, so the reason reaches the reader.
  it('fails with the error the run sends back, and what it logged', async () => {
    const script = child("console.log('ERROR Initial test run timed out!'); answerAndExit({ error: 'Something went wrong' });");
    const run = startStryker({}, { cwd: dir, onFailure, script });
    await expect(run.done).rejects.toThrow('Something went wrong | ERROR Initial test run timed out!');
  });

  // Stryker can log a great deal before it fails; only the end explains it.
  // The stand-in exits the way the real child does. When it exited straight
  // after answering, lines still queued for the pipe were lost, and under load
  // in CI this kept 176 lines instead of 200: see `stryker-answer.mjs`.
  it('keeps only the last 200 lines of the log for the failure', async () => {
    const script = child("for (let i = 1; i <= 250; i++) console.log('line ' + i); answerAndExit({ error: 'boom' });");
    const failure = await startStryker({}, { cwd: dir, onFailure, script }).done.catch((error: Error) => error.message);
    const log = String(failure).split(' | ')[1]!.split('\n');
    expect(log).toHaveLength(200);
    expect(log[0]).toBe('line 51');
    expect(log.at(-1)).toBe('line 250');
  });

  // A pipe hands output over in pieces that can end mid-line or mid-character.
  // The pauses make each write arrive as a chunk of its own.
  it('joins a line that arrives in pieces, and keeps a last line with no newline', async () => {
    const script = child(`
      const pause = () => new Promise((resolve) => setTimeout(resolve, 50));
      const euro = Buffer.from('€');
      process.stdout.write('li'); await pause();
      process.stdout.write('ne 1\\nprice 5'); await pause();
      process.stdout.write(euro.subarray(0, 1)); await pause();
      process.stdout.write(euro.subarray(1)); await pause();
      process.stdout.write('\\nlast');
      answerAndExit({ error: 'boom' });
    `);
    const failure = await startStryker({}, { cwd: dir, onFailure, script }).done.catch((error: Error) => error.message);
    expect(failure).toBe('boom | line 1\nprice 5€\nlast');
  });

  // The budget can run out just as the run ends on its own.
  it('stops a run that has already ended without killing anything', async () => {
    const script = child("answerAndExit({ results: [] });");
    const run = startStryker({}, { cwd: dir, onFailure, script });
    await run.done;
    await expect(run.stop()).resolves.toBeUndefined();
  });

  it('fails when the run ends without answering', async () => {
    const run = startStryker({}, { cwd: dir, onFailure, script: child('process.exit(7);') });
    await expect(run.done).rejects.toThrow(/Stryker's process ended with 7 before it answered/);
  });

  // The workers are the reason for the whole file: stopped with the run, and
  // gone before `stop` settles, so the folder can be deleted after it.
  it('stops the run and its workers, and settles once they are gone', async () => {
    const pids = join(dir, 'pids');
    const script = child(`
      const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      writeFileSync('pids.tmp', JSON.stringify([process.pid, worker.pid]));
      renameSync('pids.tmp', 'pids');
      setInterval(() => {}, 1000);
    `);
    const run = startStryker({}, { cwd: dir, onFailure, script });
    run.done.catch(() => {});
    let leader: number, worker: number;
    try {
      await until(() => existsSync(pids));
      [leader, worker] = JSON.parse(readFileSync(pids, 'utf8')) as [number, number];
      expect(alive(leader)).toBe(true);
      expect(alive(worker)).toBe(true);
    } finally {
      await run.stop();
    }
    expect(alive(leader)).toBe(false);
    await until(() => !alive(worker));
  });
});
