#!/usr/bin/env node
/**
 * The probe: runs a rulebook's commands and says whether each keeps the
 * adapter contract, before `init` writes that rulebook.
 *
 * `init` checks only the shape of its answers. A test command that leaves
 * half the test files out of its report, or a compile pattern that matches
 * nothing, used to be found at the first triage, after the project was
 * guarded and its rulebook locked. So the commands are run here first, in
 * verify's order, and read with the readers verify uses: what passes here is
 * what verify will accept.
 *
 * Every item must pass. There is no "not proved": a project with no test
 * yet gets a first passing test before it is set up, so that the first
 * change starts from commands known to work.
 *
 * With `expect`, the probe proves the opposite: that the commands can fail.
 * Whoever sets the project up breaks one thing, and the probe passes only
 * when it sees exactly that break, at the item concerned, and stops there. A
 * command that always exits 0 would pass every item above and none of these.
 *
 * Nothing here forces the states to be asked for. Before `init` has run the
 * project has no hooks, so nothing can hold an agent to an order. The
 * operator sees each result, and their review of the rulebook stays the gate.
 *
 * Started by `init` through `../workflow/runtime.mjs`, with
 * `{ root, config?, expect?, scratchModule? }` on stdin, because `init` is plain JavaScript
 * and cannot load this file. It answers `{ items, refused? }` on stdout.
 * `config` is a drafted rulebook, read through `withDraftConfig`; without it
 * the project's own rulebook is read.
 */
import { existsSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NONE, errorLines, matcher, matchesReport, readAdapter, runCompile, runMutate } from '../workflow/adapter.mjs';
import { checkedOutput } from '../workflow/check-output.mjs';
import { executeCheck, placeholdersIn } from '../workflow/checks.mjs';
import { checkCoverage, renderFolders } from '../workflow/coverage.mjs';
import { gitText } from '../workflow/git.mjs';
import { parseLcov } from '../workflow/lcov.mjs';
import { MARGIN } from '../workflow/mutation.mjs';
import { readChecks, withDraftConfig } from '../workflow/rulebook.mjs';
import { readMutationReport } from './mutation-report.mjs';
import { PROBE_STATES } from './probe-states.mjs';
import { outcomesOf, runTestCommand } from './test-run.js';

/** One command's result: what was run, whether it kept the contract, and why. */
export interface Item {
  name: string;
  passed: boolean;
  lines: string[];
}

/** The probe's answer. `refused` is set when the state asked for cannot be
 *  probed, because its item is switched off. */
export interface Probed {
  items: Item[];
  refused?: string;
}

export type State = 'compile-error-in-code' | 'compile-error-in-test' | 'failing-test' | 'below-minimum' | 'survivors';

/** How many names a line lists before it says there are more. */
const SHOWN = 5;

const some = (names: string[]): string => `${names.slice(0, SHOWN).join(', ')}${names.length > SHOWN ? `, and ${names.length - SHOWN} more` : ''}`;
const said = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The files git knows or would track, that exist. */
const knownFiles = (root: string): string[] =>
  [...new Set(gitText(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root }).split('\0'))]
    .filter((file) => file !== '' && existsSync(join(root, file)));

/** Why `expect` cannot be probed under this rulebook, or null. */
function refusal(expect: State, off: { compile: boolean; coverage: boolean; mutation: boolean }): string | null {
  if (expect.startsWith('compile-') && off.compile) return `${expect} cannot be probed: "code.compile" is "${NONE}"`;
  if (expect === 'below-minimum' && off.coverage) return `${expect} cannot be probed: "checks.testQuality.coverage" is "none"`;
  if (expect === 'survivors' && off.mutation) return `${expect} cannot be probed: "checks.testQuality.mutation" is "none"`;
  return null;
}

/**
 * Probes the rulebook `readConfig(root)` gives.
 *
 * Stops at the first item that fails, because each later one reads what the
 * earlier ones produce: coverage reads the test run's report, and mutation
 * is only worth its minutes on a green suite.
 */
export async function probe({ root, expect = null, scratchModule }: { root: string; expect?: State | null; scratchModule?: string }): Promise<Probed> {
  const adapter = readAdapter(root);
  const checks = readChecks(root);
  const coverage = checks.testQuality.find((check: { name: string }) => check.name === 'coverage');
  const mutation = checks.testQuality.find((check: { name: string }) => check.name === 'mutation');
  if (expect !== null) {
    const refused = refusal(expect, { compile: adapter.compile === NONE, coverage: !coverage, mutation: !mutation });
    if (refused !== null) return { items: [], refused };
  }

  const isTest = matcher(adapter.tests.all);
  const isSupport = matcher(adapter.testSupport);
  const isCode = matcher(adapter.code);
  const items: Item[] = [];
  const done = (name: string, passed: boolean, ...lines: string[]): Probed => {
    items.push({ name, passed, lines });
    return { items };
  };

  // ---------------------------------------------------------------- compile
  if (adapter.compile !== NONE) {
    let errors: { file: string; line: number; message: string }[];
    try {
      errors = runCompile({ root })!.errors;
    } catch (error) {
      return done('compile', false, said(error));
    }
    const shown = errors.slice(0, SHOWN).map((error) => `${error.file}:${error.line} ${error.message}`);
    const inCode = errors.filter((error) => !isTest(error.file));
    if (expect === 'compile-error-in-code') {
      return inCode.length > 0
        ? done('compile', true, `the pattern read ${errors.length} error(s), ${inCode.length} in code`, ...shown)
        : done('compile', false, errors.length === 0 ? 'expected an error in a code file, and compile was clean'
          : 'expected an error in a code file, and every error read is in a test file', ...shown);
    }
    if (expect === 'compile-error-in-test') {
      return errors.length > 0 && inCode.length === 0
        ? done('compile', true, `the pattern read ${errors.length} error(s), all in test files`, ...shown)
        : done('compile', false, errors.length === 0 ? 'expected an error in a test file, and compile was clean'
          : `expected errors in test files only, and ${inCode.length} are in code`, ...shown);
    }
    if (errors.length > 0) return done('compile', false, `${errors.length} error(s)`, ...shown);
    items.push({ name: 'compile', passed: true, lines: ['clean'] });
  }

  // ------------------------------------------------------------------ tests
  const testFiles = knownFiles(root).filter((file) => isTest(file));
  if (testFiles.length === 0) {
    return done('tests', false, `no file matches "tests.paths.all" (${adapter.tests.all.join(', ')}). Write a first passing test, so the test command can be proved`);
  }
  let run;
  try {
    run = runTestCommand({ root, shown: false });
  } catch (error) {
    return done('tests', false, said(error));
  }
  const strays = knownFiles(root).filter((file) => matchesReport(file, root));
  if (strays.length > 0) {
    return done('tests', false, `git does not ignore the reports the command wrote (${some(strays)}). Reports are output: add their folder to .gitignore`);
  }
  if (run.cases.length === 0) {
    return done('tests', false, `\`${adapter.testRun.command}\` wrote no test in a report at ${adapter.testRun.reports.join(', ')} (it exited ${run.exit})`);
  }
  if (run.leftOut.length > 0) {
    return done('tests', false, `left out of the report: ${some(run.leftOut.map(({ file }) => file))}. A test file the report leaves out counts as failed to load. `
      + 'Make the command report it, or narrow "tests.paths.all"');
  }
  const failed = outcomesOf(run).filter((outcome) => outcome.failed);
  const counted = `${run.cases.length} test(s) in ${new Set(run.cases.map(({ file }) => file)).size} file(s)`;
  if (expect === 'failing-test') {
    const tests = run.cases.filter(({ status }) => status === 'failed');
    return tests.length > 0
      ? done('tests', true, `${counted}, ${tests.length} failed`, ...tests.slice(0, SHOWN).map(({ file, name }) => `${file}: ${name}`))
      : done('tests', false, `expected a failed test, and none of ${counted} failed`);
  }
  if (failed.length > 0) {
    return done('tests', false, `${failed.length} failed of ${counted}`, ...failed.slice(0, SHOWN).map(({ file, title }) => `${file}: ${title}`));
  }
  const passed = run.cases.filter(({ status }) => status === 'passed').length;
  const skipped = run.cases.length - passed;
  if (passed === 0) return done('tests', false, `${counted}, no test passed (${skipped} skipped)`);
  const summary = skipped === 0 ? 'all passing' : `${passed} passed, ${skipped} skipped`;
  items.push({ name: 'tests', passed: true, lines: [`${counted}, ${summary}`] });

  // --------------------------------------------------------------- coverage
  if (coverage) {
    let stdout = '';
    const result = executeCheck(coverage, { root, baseline: () => '', capture: (out: string) => { stdout = out; } });
    if (result.outcome !== 'clean') return done('coverage', false, result.reason, errorLines(result.text));
    let measured;
    try {
      const answer = parseLcov(stdout, root, 'coverage command stdout');
      const report = Object.fromEntries(answer.files.map((entry: { file: string }) => [entry.file, entry]));
      // The code under the measured folders, as `codeFiles` in
      // `../workflow/coverage.mjs` lists it, asked of this root's rulebook.
      const roots = [...new Set(Object.keys(coverage.minimum!).map((folder) => `${folder.split('/')[0]}/`))];
      const files = knownFiles(root).filter((file) => roots.some((folder) => file.startsWith(folder)) && isCode(file) && !isTest(file));
      measured = checkCoverage({ report, minimum: coverage.minimum!, files });
    } catch (error) {
      return done('coverage', false, said(error));
    }
    const { folders, failures } = measured;
    const below = folders.flatMap((folder: { lines: { measured: number; minimum: number }; branches: { measured: number; minimum: number } }) =>
      [folder.lines, folder.branches]).filter((kind: { measured: number; minimum: number }) => kind.measured < kind.minimum).length;
    if (expect === 'below-minimum') {
      return below > 0 && failures.length === below
        ? done('coverage', true, 'the report is complete and a folder is below its minimum', ...failures)
        : done('coverage', false, below === 0 ? 'expected a folder below its minimum, and every folder meets it'
          : 'expected only a folder below its minimum, and the report has other problems', ...renderFolders(folders), ...failures);
    }
    if (failures.length > 0) return done('coverage', false, ...renderFolders(folders), ...failures);
    items.push({ name: 'coverage', passed: true, lines: renderFolders(folders) });
  }

  // --------------------------------------------------------------- mutation
  if (mutation) {
    if (!scratchModule) return done('mutation', false, 'supply --scratch-module <file> with the project-relative path of the tested scratch module');
    if (isAbsolute(scratchModule) || scratchModule.split(/[\\/]/).includes('..')) {
      return done('mutation', false, '--scratch-module must name a file inside the project by its relative path');
    }
    const file = normalize(scratchModule).split(sep).join('/');
    const excluded = matcher(mutation.exclude!);
    if (!isCode(file) || isTest(file) || isSupport(file) || excluded(file)) {
      return done('mutation', false, `--scratch-module ${file} must match the project's code paths and be outside tests, test support and mutation exclusions`);
    }
    const path = join(realpathSync(root), file);
    if (!knownFiles(root).includes(file) || realpathSync(path) !== path || !statSync(path).isFile()) {
      return done('mutation', false, `--scratch-module ${file} must be a regular file Git tracks or would track, with no symbolic links in its path`);
    }
    let answer;
    let findings;
    try {
      rmSync(checkedOutput(mutation.report!, root), { force: true });
      answer = await runMutate({
        command: mutation.command, root, input: { targets: [{ file }], budget: mutation.timeLimitSeconds, verbose: false },
        timeout: mutation.timeLimitSeconds + MARGIN, keepErrors: true,
      });
      findings = readMutationReport(join(root, mutation.report!), answer.outcome);
    } catch (error) {
      return done('mutation', false, said(error));
    }
    const { counts } = findings;
    const counted = `${counts.total} mutant(s): ${counts.caught} caught, ${counts.survived} survived`;
    if (expect === 'survivors') {
      const survivors = findings.survivors.filter((survivor) => survivor.file === file);
      if (answer.outcome === 'survived' && survivors.length === 0) return done('mutation', false, `the report contains no confirmed survivor in ${file}`, counted);
      return answer.outcome === 'survived'
        ? done('mutation', true, counted, ...survivors.slice(0, SHOWN).map((survivor) =>
          `${survivor.file}:${survivor.location.start.line} ${survivor.mutator}`))
        : done('mutation', false, `expected a surviving mutant, and the command's outcome was ${answer.outcome}`, counted);
    }
    if (answer.outcome === 'nothing') {
      return done('mutation', false, 'the command exited 2: the run checked nothing', errorLines(answer.text));
    }
    items.push({ name: 'mutation', passed: true, lines: [counted] });
  }

  // ----------------------------------------------------------- other checks
  // The remaining checks have no failing state: what a lint or a build
  // objects to is the tool's own business. They are run once, here.
  const files = knownFiles(root);
  for (const check of [...checks.testQuality, ...checks.codeQuality]) {
    if (check === coverage || check === mutation) continue;
    let result;
    try {
      result = executeCheck(check, {
        root,
        // `{baseline}` is the commit a change is measured from. A project
        // being set up has no change yet, so its newest commit stands in.
        baseline: () => (placeholdersIn(check.command).baseline ? gitText(['rev-parse', 'HEAD'], { cwd: root }).trim() : ''),
        files: () => files,
      });
    } catch (error) {
      return done(check.name, false, `could not be run: ${said(error)}`);
    }
    const passed = result.outcome === 'clean' || (result.outcome === 'findings' && check.onFailure === 'report');
    if (!passed) return done(check.name, false, result.reason, errorLines(result.text));
    items.push({ name: check.name, passed: true, lines: [result.reason] });
  }
  return { items };
}

interface ProbeRequest {
  root: string;
  config?: unknown;
  expect: State | null;
  scratchModule?: string;
}

/** What the program was asked on stdin, or the problem with it. */
export function parseRequest(text: string): ProbeRequest | { problem: string } {
  let request;
  try {
    request = JSON.parse(text);
  } catch (error) {
    return { problem: `the request is not JSON (${said(error)})` };
  }
  if (request === null || typeof request !== 'object' || typeof request.root !== 'string') return { problem: 'the request names no "root"' };
  const expect = request.expect ?? null;
  if (expect !== null && !PROBE_STATES.includes(expect)) return { problem: `"expect" is ${JSON.stringify(expect)}, which is not one of ${PROBE_STATES.join(', ')}` };
  if (request.scratchModule !== undefined && typeof request.scratchModule !== 'string') return { problem: 'scratchModule must be a project-relative file path' };
  return { root: request.root, ...(request.config === undefined ? {} : { config: request.config }), expect, scratchModule: request.scratchModule };
}

/** The probe for one request: a drafted rulebook when it carries one. */
export async function answer(request: ProbeRequest): Promise<Probed> {
  const ask = () => probe(request);
  try {
    return request.config === undefined ? await ask() : await withDraftConfig(request.root, request.config, ask);
  } catch (error) {
    // The rulebook itself was refused, or git gave no answer: nothing ran.
    return { items: [{ name: 'rulebook', passed: false, lines: [said(error)] }] };
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const request = parseRequest(readFileSync(0, 'utf8'));
  if ('problem' in request) {
    process.stderr.write(`probe: ${request.problem}\n`);
    process.exit(2);
  }
  const probed = await answer(request);
  process.stdout.write(`${JSON.stringify(probed)}\n`, () => process.exit(0));
}
