#!/usr/bin/env node
/**
 * The mutation command for TypeScript, wrapping Stryker: reads the referee's
 * request on stdin, runs Stryker on the lines it names, prints what it found
 * as text, and exits by the contract in `src/adapters/README.md`: 0 no
 * survivors, 1 mutants survived, 2 the run proves nothing, 3 it crashed. See
 * `respond` in `stryker.ts`.
 *
 * Named for the tool it wraps. A project that mutates with another tool gets
 * a wrapper of its own, beside this one.
 *
 * `--vitest-config <path>` names the project's Vitest config for mutation
 * runs, and is required. Which tests a run uses, and which it leaves out, is
 * the project's call: this repository's is `vitest.mutate.config.ts`.
 *
 * Stdout is the text and nothing else. Stryker runs in a process of its own
 * (`stryker-process.ts`), and its log goes to stderr: `--verbose` in the
 * request turns all of it on, and without it only its errors are shown. Setting exitCode lets Node drain stdout, even for a report larger than a pipe buffer.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startStryker } from './stryker-process.js';
import { plainReason, respond, strykerOptions, vitestConfigOf } from './stryker.js';
import { reportFileOf } from './stryker-report.js';

const PLUGINS = fileURLToPath(new URL('./mutate-plugins.mjs', import.meta.url));

let config: string;
let reportFile: string;
try {
  config = vitestConfigOf(process.argv.slice(2));
  reportFile = reportFileOf(process.argv.slice(2));
} catch (error) {
  console.error((error as Error).message);
  process.exit(3);
}

process.exitCode = await respond({
  input: readFileSync(0, 'utf8'),
  cwd: process.cwd(),
  reportFile,
  run: (targets, verbose) => {
    const options = strykerOptions(targets, PLUGINS, config, reportFile);
    if (verbose) options.logLevel = 'info';
    return startStryker(options, { cwd: process.cwd(), onFailure: plainReason });
  },
  write: async text => { process.stdout.write(text); },
  fail: (message) => console.error(message),
  warn: (message) => console.error(message),
});
