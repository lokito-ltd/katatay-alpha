/**
 * How `stryker-child.mjs` ends: it sends its answer, waits for its log to
 * leave, then exits.
 *
 * The child's stdout and stderr are pipes to `stryker-process.ts`, and Node
 * writes to a pipe asynchronously on macOS and Linux. When the pipe is full,
 * because the parent is slow to read, the rest of the log waits in a queue
 * inside this process, and `process.exit` throws that queue away. The lost
 * lines are the end of Stryker's log, the part that explains a failure. Under
 * load in CI, a run that printed 250 lines delivered only 176. So the exit
 * waits until both streams have handed over everything written before it.
 *
 * An empty write's callback runs only after every earlier write on the same
 * stream has been handed over, so it marks the point where the queue is empty.
 *
 * `proc` is the process, so a test can pass a stand-in.
 */

/** Settles once everything written to `stream` so far has been handed over. */
const flushed = (stream) => new Promise((resolve) => { stream.write('', resolve); });

/**
 * Sends `answer`, `{ results }` or `{ error }`, then exits once the answer is
 * sent and stdout and stderr are empty: 0 for results, 1 for an error.
 */
export function answerAndExit(answer, proc = process) {
  proc.send(answer, async () => {
    await Promise.all([flushed(proc.stdout), flushed(proc.stderr)]);
    proc.exit(answer.error === undefined ? 0 : 1);
  });
}
