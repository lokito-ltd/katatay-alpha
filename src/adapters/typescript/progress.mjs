/**
 * Where the progress reporter in `mutate-plugins.mjs` writes each result,
 * relative to the directory Stryker runs in. Inside its temp folder, which git
 * ignores.
 *
 * A module of its own, so `stryker.ts` can read the file without loading the
 * plugins, and with them Stryker, into the process that starts the run.
 */
export const PROGRESS = '.stryker-tmp/progress.jsonl';
