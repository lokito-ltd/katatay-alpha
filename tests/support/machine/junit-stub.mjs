#!/usr/bin/env node
/**
 * The machine fixture's test command: it writes the JUnit report the referee
 * reads, from `outcomes.json` in the fixture's tree, without running anything.
 *
 * `outcomes.json` holds `{ "outcomes": [{ "file", "title", "failed" }] }`.
 * Each outcome becomes a test case. Every test file in the tree that no
 * outcome names gets one passing case too, so that a case which writes a test
 * file does not see it counted as failed to load, which is what the referee
 * makes of a test file the report leaves out. The exit is 1 when an outcome
 * failed, as a runner's is.
 *
 * In the tree and not in the rulebook for the reason `OUTCOMES` in
 * `harness.mjs` gives: the tree fingerprint leaves `.katatay/` out.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const TEST = /\.test\.(?:ts|tsx|mjs)$/;
const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const { outcomes } = existsSync('outcomes.json') ? JSON.parse(readFileSync('outcomes.json', 'utf8')) : { outcomes: [] };
const named = new Set(outcomes.map((o) => o.file));
const testFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n')
  .filter((file) => TEST.test(file) && existsSync(file) && !named.has(file));

const cases = [
  ...outcomes.map((o) => `  <testcase name="${escape(o.title)}" file="${escape(o.file)}">${o.failed ? '<failure message="failed"/>' : ''}</testcase>`),
  ...testFiles.map((file) => `  <testcase name="passes" file="${escape(file)}"/>`),
];
mkdirSync('reports/junit', { recursive: true });
writeFileSync('reports/junit/run.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${cases.join('\n')}\n</testsuites>\n`);
process.exitCode = outcomes.some((o) => o.failed) ? 1 : 0;
