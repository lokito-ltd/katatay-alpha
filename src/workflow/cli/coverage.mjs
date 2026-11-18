#!/usr/bin/env node
/**
 * `workflow coverage` — no folder's test coverage is below its minimum.
 *
 * Runs the quality coverage command, checks its LCOV against the minimums,
 * and saves its analysis at output. It does not run the test suite.
 * `workflow verify` runs it straight after the test command, and a CI job
 * should do the same. See `../coverage.mjs` for what is compared and what
 * fails.
 */
import { coverageCheck } from '../coverage.mjs';

const { ok, lines } = coverageCheck();
for (const line of lines) (ok ? console.log : console.error)(`coverage: ${line}`);
process.exit(ok ? 0 : 1);
