/**
 * Stryker in a process tree of its own, which can be stopped.
 *
 * Stryker has no way to cancel a run. Its test runners are child processes,
 * and when `stryker-mutate.ts` ran Stryker in its own process and exited at the
 * budget, those workers kept running in `.stryker-tmp/`, and the delete that
 * followed failed under them. So the run is started here, in
 * `stryker-child.mjs`, as the leader of a process group. At the budget the
 * whole group is killed, and the run is waited for, before anything is
 * deleted.
 *
 * Stryker's log goes to the child's stdout and stderr. Both are passed to this
 * process's stderr, never to its stdout, which is the answer, and the tail is
 * kept to explain a failure.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { StrykerResult } from './stryker.js';

const CHILD = fileURLToPath(new URL('./stryker-child.mjs', import.meta.url));

/** A run under way: `done` settles with the results, and `stop` ends the run
 *  and every process it started, settling once they have exited. */
export interface Run {
  done: Promise<StrykerResult[]>;
  stop: () => Promise<void>;
}

/** Lines of Stryker's log kept for explaining a failure. */
const KEPT_LINES = 200;

/**
 * Kills `pid` and every process under it.
 *
 * The run is started as a process group's leader, so a signal to the negative
 * pid reaches the whole group, the workers included. That is how macOS and
 * Linux work, and they are the only systems this runs on: Windows is not
 * supported.
 *
 * A group already gone is not an error: the run may have ended on its own
 * between the budget and the kill.
 */
export function killTree(
  pid: number,
  kill: (pid: number, signal: NodeJS.Signals) => void = (p, signal) => process.kill(p, signal),
): void {
  try {
    kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/**
 * Starts Stryker with `options` in `cwd`. `log` collects what Stryker printed,
 * for `plainReason` in `stryker.ts`. `script` is the child to run, so a test
 * can start a stand-in.
 */
export function startStryker(
  options: Record<string, unknown>,
  { cwd, onFailure, script = CHILD }: {
    cwd: string;
    /** Turns Stryker's error and its log into the message thrown. */
    onFailure: (message: string, log: string) => string;
    script?: string;
  },
): Run {
  const child: ChildProcess = fork(script, [], {
    cwd,
    // A group of its own, so one signal reaches the workers too.
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const lines: string[] = [];
  const add = (found: string[]) => {
    lines.push(...found.filter((l) => l.trim() !== ''));
    if (lines.length > KEPT_LINES) lines.splice(0, lines.length - KEPT_LINES);
  };
  // A chunk can end in the middle of a line, or of a character: a pipe hands
  // output over in pieces of its own size. Splitting each chunk alone kept
  // the halves as two lines, and under load CI saw the 200 kept lines start
  // twelve lines early. So each stream decodes as UTF-8 and holds its
  // unfinished last line until the rest arrives, or until the stream ends.
  const keep = (stream: NodeJS.ReadableStream) => {
    let partial = '';
    stream.setEncoding('utf8');
    stream.on('data', (text: string) => {
      process.stderr.write(text);
      const found = (partial + text).split('\n');
      partial = found.pop()!;
      add(found);
    });
    stream.on('end', () => {
      add([partial]);
      partial = '';
    });
  };
  // Both exist: `stdio` above pipes them.
  keep(child.stdout!);
  keep(child.stderr!);

  // `close` and not `exit`: it comes after the streams and the IPC channel are
  // done, so the answer, if one was sent, has arrived by then.
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  // If this process exits first, the group must not outlive it.
  const cleanup = () => { if (child.exitCode === null && child.signalCode === null) killTree(child.pid!); };
  process.once('exit', cleanup);

  let answer: { results?: StrykerResult[]; error?: string } | undefined;
  child.once('message', (message) => { answer = message as typeof answer; });
  child.send(options);

  const done = closed.then(({ code, signal }) => {
    process.off('exit', cleanup);
    if (answer?.results !== undefined) return answer.results;
    const message = answer?.error ?? `Stryker's process ended with ${code ?? signal} before it answered`;
    throw new Error(onFailure(message, lines.join('\n')));
  });
  return {
    done,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) killTree(child.pid!);
      await closed;
    },
  };
}
