/**
 * The referee verify: every check a change has to pass, in one command the referee
 * owns.
 *
 * The `Stop` hook runs this, not the agent, and records a receipt only when it
 * passes. It used to be an npm `&&` chain in `package.json`, which only an npm
 * project has, and which a project had to know to fill with the referee's own
 * checks. Now the referee runs its own checks and, at the right points, the
 * pieces the language adapter supplies (see `src/adapters/README.md`). The
 * adapter answers narrow questions and knows nothing of this order.
 *
 * In order, stopping at the first that fails, as the chain did:
 *
 * 1. The catalogue: `req:lint`, `req:guard`.
 * 2. The workflow logbook: `state:verify`, in a process of its own, because it is
 *    plain Node and ends with its own exit code.
 * 3. `compile`. Any error fails, in a test file or not. The triage is where a
 *    test that does not compile counts as a failed test and is sorted; here
 *    the question is only whether everything passes.
 * 4. The tests: the rulebook's test command, read from the JUnit reports it
 *    writes. Then `req:trace`, which reads the same reports, so it comes
 *    after the run.
 * 5. The rulebook's `checks`: the quality chain, including coverage, then the
 *    code chain, each in
 *    the order the rulebook lists it (`checks.mjs`). A check whose
 *    `onFailure` is `block` fails verify unless it comes back clean. One that
 *    reports is printed and verify goes on when it found something, and only
 *    then: a check that broke fails verify whatever its `onFailure` says. A
 *    once-per-plan check that the logbook already holds a run of for this
 *    plan is skipped and said so. So is a check whose rulebook entry says
 *    `skipInCi`, when `CI=true` (`ci.mjs`); `workflow mutate` by hand ignores
 *    that, because it is an explicit request.
 *
 * With `--results <file>`, every check's outcome and text are also written
 * there as JSON, whether verify passed or not. The turn-end hook reads it, to
 * store once-per-plan runs and to put the checks that report into the
 * verified message. Verify itself never writes the logbook: a verify run by
 * hand must not grant anything.
 *
 * A piece the adapter says the language lacks is printed as not checked, in
 * the output and again at the end, so a pass without it does not read as a
 * pass with it.
 *
 * The referee's own checks run in this process. In the machine suite, where the
 * adapter's pieces are stubs, that keeps a verify to one process start.
 *
 * `cli/verify-change.ts` is the command. The steps live here so a test can
 * read them without running them.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runLint } from '../requirements/lint.js';
import { runGuard } from '../requirements/guard.js';
import { currentBranch } from './chain.mjs';
import { STATE_FOLDER } from './folder.mjs';
import { writeJUnitSnapshot } from './junit-snapshot.mjs';
import { writeCoverageSnapshot } from './coverage-snapshot.mjs';
import { mutationReason } from './mutation.mjs';
import { readMutationSnapshot, writeMutationSnapshot } from './mutation-snapshot.mjs';
import { runTrace } from '../evidence/trace.js';
import { compileErrors } from '../evidence/typecheck.js';
import { writeFileSync } from 'node:fs';
import { COMPILE_OFF } from './adapter.mjs';
import { outcomesOf, runTestCommand, type TestRun } from '../evidence/test-run.js';
import { allChecks, readChecks, MUTATION_SWITCHED_OFF, type Check } from './rulebook.mjs';
import { mutate, type Outcome } from '../evidence/mutants.js';
import { survivorReport } from '../evidence/mutation-display.mjs';
import { baselineSha, runCheck } from './checks.mjs';
import { current } from './state.mjs';
import { COVERAGE_SWITCHED_OFF, runCoverageCheck } from './coverage.mjs';
import { TargetError } from './target.mjs';
import { inCi } from './ci.mjs';
import { producerOf, verificationResults } from './verification-results.mjs';
import { mutationReferences } from './result-readers.mjs';

const STATE_VERIFY = fileURLToPath(new URL('./cli/verify.mjs', import.meta.url));

/** How many compile errors and failed tests are printed before "and N more". */
const SHOWN = 40;

interface Step {
  name: string;
  run: () => boolean | Promise<boolean>;
}

/** The referee's steps, in order, by name. The rulebook's checks follow them. */
export const REFEREE_STEPS = ['req:lint', 'req:guard', 'state:verify', 'compile', 'tests', 'req:trace'] as const;

/** Every step a verify of the repository at `root` runs, by name, in order. */
export const verifySteps = (root = process.cwd()): string[] => [...REFEREE_STEPS, ...allChecks(readChecks(root)).map((check) => check.name)];

/** What a check did in this verify. The unified results are built from it. */
export interface CheckResult {
  name: string;
  chain: string;
  runs: string;
  onFailure: string;
  outcome: 'clean' | 'findings' | 'broken' | 'skipped';
  code: number | null;
  text: string;
  reason: string;
  /** Skipped because the logbook already holds this plan's run of it. */
  ranBefore?: boolean;
  /** Skipped because the rulebook says `skipInCi` and this is CI. */
  skippedInCi?: boolean;
  mutation?: Pick<Outcome, 'outcome' | 'findings' | 'rawReport'>;
  /** Coverage or mutation evidence kept for this verification. */
  snapshots?: { raw: string; analysis: string } | { raw: string; findings: string };
}

/** What the logbook holds of a once-per-plan check's run under this plan. */
type Prior =
  | { event: { seq: number; payload: { treeFingerprint: string } }; result: { evidence: { role: string; snapshot: string }[]; status: string; name: string } }
  | { error: Error };

/**
 * The once-per-plan checks the logbook already holds this plan's run of. Asked
 * only when the rulebook has such a check. Without a logbook to ask, such as a
 * verify by hand where no target is set, none has run, so every check runs.
 *
 * `producerOf` reads the receipts' unified results. A reused result whose
 * producer fails validation is kept as an error, so the step reports it as
 * broken instead of running the check again.
 */
function ranThisPlan(checks: Check[]) {
  const ran = new Map<string, Prior>();
  if (checks.some((check) => check.runs === 'oncePerPlan')) {
    let state;
    try {
      state = current();
    } catch (error) {
      if (!(error instanceof TargetError)) throw error;
      return ran;
    }
    for (const check of checks.filter((check) => check.runs === 'oncePerPlan')) {
      try {
        const producer = producerOf(check.name, state);
        if (producer) ran.set(check.name, producer);
      } catch (error) {
        ran.set(check.name, { error: error as Error });
      }
    }
  }
  return ran;
}

/** Preserve the mutation outcome alongside the check result. Inconclusive
 * runs carry evidence too, but a run that never started consumes no receipt. */
async function mutationCheck(check: Check, deadline: number | undefined,
  publish: (run: { raw: string; status: number; outcome: Outcome['outcome']; report: string;
    findings: NonNullable<Outcome['findings']> }) => { raw: string; findings: string }) {
  let base;
  try { base = baselineSha(); }
  catch { return { outcome: 'broken' as const, code: null, text: '', reason: 'no baseline is available from the plan or the configured target' }; }
  const result = await mutate({ base, cwd: process.cwd(), budget: check.timeLimitSeconds, deadline });
  const { outcome, findings } = result;
  const meaning = { clean: 'clean', survived: 'findings', nothing: 'findings', failed: 'broken', none: 'skipped' } as const;
  if (!findings) return { outcome: meaning[outcome], code: outcome === 'none' ? null : result.code,
    mutation: { outcome }, text: result.lines.join('\n'), reason: outcome === 'failed' ? 'mutation check broke' : result.lines[0]! };
  const reason = mutationReason(outcome, findings);
  const text = [...result.lines, reason].join('\n');
  const mutation = { outcome, findings, ...(result.rawReport === undefined ? {} : { rawReport: result.rawReport + '\n' + reason }) };
  try {
    if (typeof result.standardReport !== 'string') throw new Error('No standard mutation report was returned');
    const snapshots = publish({ raw: result.standardReport, status: result.code, outcome,
      report: mutation.rawReport ?? text, findings });
    return { outcome: meaning[outcome], mutation, code: result.code, text, reason, snapshots };
  } catch (error) {
    return { outcome: 'broken' as const, code: result.code, mutation, text,
      reason: `mutation evidence could not be preserved: ${(error as Error).message}` };
  }
}

/** Keep publication in verify; standalone mutation has no receipt to name it. */
const mutationStep = (check: Check, deadline?: number) =>
  mutationCheck(check, deadline, run => writeMutationSnapshot(currentBranch(), run));

/** The coverage check, keeping what it measured as this verification's
 *  snapshots, so nothing read later depends on the working report. */
const coverageStep = (check: Check) => {
  const branch = currentBranch();
  return runCoverageCheck(check, process.cwd(),
    { publish: (raw: string, analysis: string) => writeCoverageSnapshot(branch, { raw, analysis }) });
};

/** Why a check with `skipInCi` did not run, as verify prints it. */
export const SKIPPED_IN_CI = 'skipped in CI (skipInCi: true)';

/** One check as a step of verify. */
const checkStep = (check: Check, ranBefore: ReturnType<typeof ranThisPlan>, results: CheckResult[], deadline?: number): Step => ({
  name: check.name,
  run: async () => {
    const about = { name: check.name, chain: check.chain, runs: check.runs, onFailure: check.onFailure };
    // Decided before anything about the check is set up: the once-per-plan
    // reuse reads the logbook, `runCheck` clears the check's output file, and
    // mutation clears its report. A skip leaves all of them as they were.
    // Mutation's skip carries the outcome `none`, the one a run that did not
    // happen has, so the turn-end hook treats it as a deferral: the plan's run
    // is still to come, and the receipt carries a skip reason instead of a run.
    if (check.skipInCi && inCi()) {
      const reason = SKIPPED_IN_CI;
      console.log(`${check.name} — ${reason}`);
      results.push({ ...about, outcome: 'skipped', code: null, text: '', reason, skippedInCi: true,
        ...(check.name === 'mutation' ? { mutation: { outcome: 'none' as const } } : {}) });
      return true;
    }
    if (check.runs === 'oncePerPlan' && ranBefore.has(check.name)) {
      const reason = 'skipped: it runs once per plan, and ran on an earlier tree';
      const prior = ranBefore.get(check.name)!;
      let text = '';
      const broken = (seq: number | undefined, error: Error) => {
        const reason = `${check.name}: ${seq === undefined ? '' : `verification ${seq}: `}${error.message}. `
          + `Restore the exact evidence in ${STATE_FOLDER}/local/ or ask the operator to reset the workflow.`;
        console.error(reason);
        results.push({ ...about, outcome: 'broken', code: null, text: '', reason });
        return false;
      };
      if ('error' in prior) return broken(undefined, prior.error);
      if (check.name === 'mutation') {
        // The producer's result names the run's evidence. Reading it here
        // shows the earlier report, and a lost snapshot breaks the step.
        try {
          const run = readMutationSnapshot(currentBranch(), mutationReferences(prior.result));
          text = survivorReport(run.report, run.findings.survivors, process.cwd());
        } catch (error) {
          return broken(prior.event.seq, error as Error);
        }
      }
      console.log(`${check.name} — ${reason}`);
      if (text) console.log(text);
      results.push({ ...about, outcome: 'skipped', code: null, text, reason, ranBefore: true });
      return true;
    }
    const result = check.name === 'mutation' ? await mutationStep(check, deadline)
      : check.name === 'coverage' ? coverageStep(check) : runCheck(check);
    results.push({ ...about, ...result });
    const passes = result.outcome === 'clean' || result.outcome === 'skipped';
    // `report` lets findings through and nothing else. A broken check
    // checked nothing, so a pass after it would claim more than was checked.
    const reports = check.onFailure === 'report' && result.outcome === 'findings';
    const say = passes || reports ? console.log : console.error;
    if (result.text) say(result.text);
    say(`${check.name} — ${result.reason}${!passes && reports ? '; it reports only, so verify goes on' : ''}`);
    return passes || reports;
  },
});

/** The steps, with what each runs. `unchecked` collects what the adapter says
 *  the language lacks. */
const listed = (lines: string[]): string[] =>
  lines.length > SHOWN ? [...lines.slice(0, SHOWN), `… and ${lines.length - SHOWN} more`] : lines;

interface VerificationRun {
  junitReports?: { name: string; snapshot: string }[];
  tests?: TestRun;
  unified?: ReturnType<typeof verificationResults>;
  diagnostic?: string;
}

const refereeSteps = (unchecked: string[], evidence: VerificationRun): Step[] => [
  { name: 'req:lint', run: () => runLint() },
  { name: 'req:guard', run: () => runGuard([]) },
  {
    name: 'state:verify',
    run: () => spawnSync(process.execPath, [STATE_VERIFY], { stdio: ['ignore', 'inherit', 'inherit'] }).status === 0,
  },
  {
    name: 'compile',
    run: () => {
      const errors = compileErrors();
      if (errors === null) {
        unchecked.push(COMPILE_OFF);
        console.log(`compile — ${COMPILE_OFF}`);
        return true;
      }
      if (errors.length === 0) {
        console.log('compile — no errors');
        return true;
      }
      console.error(`compile — ${errors.length} error(s)`);
      evidence.diagnostic = errors.map(e => `${e.file}:${e.line} ${e.message}`).join('\n');
      for (const line of listed(errors.map((e) => `  ${e.file}:${e.line} ${e.message}`))) console.error(line);
      return false;
    },
  },
  {
    name: 'tests',
    run: () => {
      let reportCount = 0;
      const branch = currentBranch();
      const run = runTestCommand({ capture: reports => {
        evidence.junitReports = writeJUnitSnapshot(branch, reports);
        reportCount = reports.length;
      } });
      evidence.tests = run;
      const outcomes = outcomesOf(run);
      const failed = outcomes.filter((o) => o.failed);
      if (!reportCount && !failed.length) {
        console.error('tests — the test command produced no JUnit report');
        return false;
      }
      if (failed.length === 0) {
        console.log(`tests — ${outcomes.length} ran, none failed`);
        return true;
      }
      evidence.diagnostic = [`tests — ${failed.length} of ${outcomes.length} failed`,
        ...listed(failed.map((o) => `  ${o.file} — ${o.title}${o.reason ? ` (${o.reason})` : ''}`))].join('\n');
      console.error(evidence.diagnostic);
      return false;
    },
  },
  { name: 'req:trace', run: () => runTrace(evidence.tests!) },
];

/**
 * Runs every step, stopping at the first that fails, and returns the exit
 * code: 0 when all passed. A missing or failing adapter is a refusal, said as
 * one.
 */
export async function runVerify(args: string[] = []): Promise<number> {
  const at = args.indexOf('--results');
  const resultsFile = at === -1 ? null : args[at + 1];
  if (at !== -1 && !resultsFile) {
    console.error('verify: refused — --results needs the file to write the checks\' results to');
    return 1;
  }
  const evidence: VerificationRun = resultsFile
    ? { unified: verificationResults(currentBranch(), [], REFEREE_STEPS) } : {};
  const results: CheckResult[] = [];
  try {
    const index = args.indexOf('--deadline');
    const deadline = index < 0 ? undefined : Number(args[index + 1]);
    if (deadline !== undefined && !Number.isFinite(deadline)) throw new TargetError('--deadline needs an absolute time in milliseconds');
    return await verify(results, evidence, deadline, Boolean(resultsFile));
  } catch (error) {
    // The adapter failed, or is not configured, or the target is not. Any of
    // them is a refusal: nothing can be said about the change.
    if (!(error instanceof TargetError)) throw error;
    console.error(`verify: refused — ${error.message}`);
    return 1;
  } finally {
    // The unified results are the whole answer: every step's result and the
    // snapshots its evidence was published to.
    if (resultsFile) writeFileSync(resultsFile, `${JSON.stringify({ results: evidence.unified!.results })}\n`);
  }
}

async function verify(results: CheckResult[], evidence: VerificationRun, deadline?: number, collect = false): Promise<number> {
  const unchecked: string[] = [];
  const checks = allChecks(readChecks());
  if (collect) evidence.unified = verificationResults(currentBranch(), checks, REFEREE_STEPS);
  const ranBefore = ranThisPlan(checks);
  if (!checks.some((check) => check.name === 'coverage')) unchecked.push(COVERAGE_SWITCHED_OFF);
  if (!checks.some((check) => check.name === 'mutation')) unchecked.push(MUTATION_SWITCHED_OFF);
  const builtinSteps = refereeSteps(unchecked, evidence).map(step => ({
    ...step, run: async () => {
      const before = unchecked.length;
      evidence.diagnostic = undefined;
      let passed;
      try { passed = await step.run(); }
      catch (error) {
        // Capture precedes parsing: even malformed JUnit belongs to this
        // failed run, and its published copies must remain reachable.
        evidence.unified?.fail(step.name, error, evidence);
        throw error;
      }
      const termination = step.name === 'tests' ? evidence.tests?.exit : null;
      const reason = typeof termination === 'string' ? `Test command stopped by ${termination}.` : unchecked.slice(before).join('\n');
      const captured = evidence.unified?.record({ name: step.name, onFailure: 'block',
        outcome: !passed ? 'findings' : reason && step.name !== 'tests' ? 'skipped' : 'clean',
        reason: reason || (passed ? 'Check passed.' : 'Check failed.'), text: evidence.diagnostic ?? '' },
      { ...evidence, limitations: unchecked.slice(before) });
      if (captured === false) {
        console.error(`verify: could not preserve ${step.name} evidence: ${evidence.unified!.problem(step.name)}`);
        return false;
      }
      return passed;
    },
  }));
  const all = [...builtinSteps, ...checks.map(check => {
    const step = checkStep(check, ranBefore, results, deadline);
    return { ...step, run: async () => {
      let passed;
      try { passed = await step.run(); }
      catch (error) { evidence.unified?.fail(step.name, error); throw error; }
      const captured = evidence.unified?.record(results.at(-1)!, {});
      if (captured === false) {
        console.error(`verify: could not preserve ${step.name} evidence: ${evidence.unified!.problem(step.name)}`);
        return false;
      }
      return passed;
    } };
  })];
  if (all.map((step) => step.name).join() !== verifySteps().join()) throw new Error('verify: the steps run differ from the steps named');
  for (const step of all) {
    if (!await step.run()) {
      console.error(`\nverify: failed at ${step.name}.`);
      return 1;
    }
  }
  console.log(`\nverify: every step passed (${all.map((s) => s.name).join(', ')}).`);
  for (const line of unchecked) console.log(`verify: ${line}`);
  return 0;
}

