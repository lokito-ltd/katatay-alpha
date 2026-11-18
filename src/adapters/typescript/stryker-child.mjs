/**
 * Runs one Stryker run, in a process of its own, for `stryker-process.ts`.
 *
 * Stryker has no way to cancel a run, and its workers are child processes
 * that outlive a cut-off. Run here, the whole run is one process tree, which
 * `stryker-mutate.ts` can stop and wait for at the budget before it deletes Stryker's
 * folder. Run in `stryker-mutate.ts` itself, the delete raced the workers still
 * writing there, and failed.
 *
 * The options arrive as the first message on the IPC channel, and the answer
 * goes back the same way: `{ results }` or `{ error }`. Not on stdout, because
 * Stryker's own log goes there, and `stryker-process.ts` passes it to stderr.
 * The process exits only once that log has left: see `stryker-answer.mjs`.
 */
import { importFromProject } from './project-modules.mjs';
import { answerAndExit } from './stryker-answer.mjs';

// The project's own Stryker, not one beside this file: see `project-modules.mjs`.
// `stryker-process.ts` starts this process in the project's directory.
const { Stryker } = await importFromProject('@stryker-mutator/core');

/** The fields of a result `stryker.ts` reads, so the message stays small. */
const kept = (r) => ({
  fileName: r.fileName,
  location: { start: { line: r.location.start.line } },
  mutatorName: r.mutatorName,
  replacement: r.replacement,
  status: r.status,
  testsCompleted: r.testsCompleted,
  statusReason: r.statusReason,
});

process.once('message', async (options) => {
  let answer;
  try {
    answer = { results: (await new Stryker(options).runMutationTest()).map(kept) };
  } catch (error) {
    answer = { error: error instanceof Error ? error.message : String(error) };
  }
  answerAndExit(answer);
});
