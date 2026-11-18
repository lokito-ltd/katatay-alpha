#!/usr/bin/env node
/**
 * `workflow verify`, and what the `Stop` hook runs: the referee verify. See
 * `../referee-verify.ts` for what it runs and why.
 */
import { runVerify } from '../referee-verify.js';

process.exitCode = await runVerify(process.argv.slice(2));
