import { mutationCommand } from '../../fixtures/workflow/mutation-report.mjs';
/**
 * The machine driven end to end: real hook processes, a real git repository,
 * one phase at a time.
 *
 * These cases exist because the evidence for them did not. The workflow was
 * proved out during implementation with throwaway scripts against temporary
 * repositories, the results were reported, and the scripts were deleted. That
 * left the proof unrepeatable, in a project whose premise is that evidence
 * beats intention. This is that walk, kept.
 *
 * Everything else here tests a function. This tests the thing the operator
 * actually has. The hooks are spawned as processes over their stdin contract,
 * against a fixture repository whose `verify` script is trivial. The hook's
 * code path is identical whether the suite it shells out to is real or not,
 * and a nested run of this suite would cost minutes to prove nothing extra.
 *
 * The process journeys live in tests/machine and tests/hooks. Fast in-process
 * cases beside this file use the same fixture. They were one file until the file became the whole suite's
 * critical path: about seven child processes per case, at 50ms of node startup
 * each before anything of ours runs, and vitest runs a single file's cases in
 * sequence however many cores are idle. Splitting by measured cost rather than
 * by tidiness is what makes the run parallel. Nothing was made cheaper by
 * pretending a hook is a function call — the spawn is the contract under test.
 *
 * The same rule split them again on 2026-10-01, once the end-to-end tests ran
 * its steps at the same time and stopped being the slowest file. Under the load
 * of the whole run these files take about twice what they take alone, and
 * `reporting` (40s), `baseline` (35s) and `recording` (29s) had become the
 * critical path. They are now ten files, none above about fifteen seconds of
 * cases. What the baseline cases share lives in `baselines.mjs`. When a file
 * here is the slowest in the full test run again, split it the same way: by measured
 * time per `describe`, not by topic alone.
 */
import { beforeAll, afterAll, beforeEach, afterEach, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { testResult } from '../../fixtures/workflow/quality-results.mjs';
import { writeJUnitSnapshot } from '../../../src/workflow/junit-snapshot.mjs';
import { writeTriageSnapshot } from '../../../src/workflow/triage-snapshot.mjs';
import { inRoot } from '../../../src/workflow/check-output.mjs';
import { current } from '../../../src/workflow/state.mjs';
import { triaged } from '../../fixtures/workflow/events.mjs';
import { append } from '../../../src/workflow/chain.mjs';
import { payload } from '../../fixtures/claude/payloads.mjs';
import { bareSections, fixtureMutation, mutationChecks, repositoryRulebook } from '../../fixtures/workflow/adapter.mjs';
import { EXPECTED } from '../../../src/agents/claude/registration.mjs';
import { reportSection } from '../../../src/workflow/record.mjs';
import { reportFor } from '../../../src/workflow/checks-report.mjs';
import { analysisSummary } from '../../../src/workflow/checks-analysis.mjs';

/** The fixture rulebook's high-risk list. See where the template is written. */
const FIXTURE_HIGH_RISK = [{ paths: ['guarded/**'], why: 'Guarded. Read them whatever the tests say.' }];

const HOOKS = resolve('src/agents/claude/hooks');
const CLI = resolve('src/workflow/cli');

/**
 * The repository, home and logbook the current case is running against.
 *
 * A plain `let repo` cannot be shared across a module boundary: a test file
 * importing it would bind the value as it stood when the module loaded, which
 * is before any `beforeEach` has run. The helpers below and the cases both go
 * through this one object instead, so they are always talking about the same
 * temporary repository.
 */
export const ctx = { repo: null, home: null, logbook: null, remote: null };

export function fixtureJUnit(xml = '<testsuites/>') {
  return writeJUnitSnapshot('feat/x', [{ name: 'reports/junit/run.xml', bytes: Buffer.from(xml) }], ctx.repo);
}

/**
 * The unified results of a clean pass, as a stubbed verify answers: a tests
 * result naming a real JUnit snapshot, with coverage and mutation skipped.
 * Turn end reads back every snapshot the results name, so the report is kept
 * in the fixture's branch folder like the real one.
 */
export function fixtureChecks(xml = '<testsuites/>') {
  const skipped = name => ({ name, status: 'skipped', reason: 'Not measured by this fixture.', evidence: [], summary: {} });
  return [
    testResult('feat/x', fixtureJUnit(xml), ctx.repo),
    skipped('coverage'), skipped('mutation'),
  ];
}

/** Git in the fixture repository. Refuses to run anywhere else, for the reason
 *  spelled out under `node` below. */
export const git = (...args) => execFileSync('git', args, { cwd: inFixture(), encoding: 'utf8' });

const inFixture = () => {
  if (!ctx.repo) throw new Error('no fixture repository — refusing to run against the real one');
  return ctx.repo;
};

/**
 * A hook or CLI, spawned the way Claude Code spawns it.
 *
 * A home directory of the fixture's own, so the plans folder and user settings
 * the hooks look for are never the real operator's.
 *
 * The repository is refused rather than defaulted when it is missing. A
 * `spawnSync` with `cwd: undefined` inherits this process's directory, which is
 * the repository the suite is running in — so one unset field would point a
 * `turn-end.mjs` at the real `.katatay/` logbook and run the real `npm run
 * verify`, which starts this suite again. That happened while this file was
 * being written, and it cost an afternoon: nested runs, a logbook full of events no
 * turn produced, and failures that looked like a filesystem race.
 */
const node = (script, payload, { repo = ctx.repo, home = ctx.home } = {}) => {
  if (!repo || !home) throw new Error(`no fixture repository to run ${script} in — refusing to inherit the real one`);
  const run = spawnSync('node', [script], {
    cwd: repo, input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, HOME: home },
  });
  if (run.status !== 0) throw new Error(`${script} exited ${run.status}: ${run.stderr}`);
  return run.stdout.trim() === '' ? null : JSON.parse(run.stdout);
};

export const hook = (name, payload = {}, where) => node(join(HOOKS, name), payload, where);

/**
 * A referee moment, started as an agent adapter starts it: `workflow.mjs on
 * <moment>` with JSON on stdin. Refused without a fixture repository, for the
 * reason `node` above gives. Returns the exit code and stderr as well as the
 * answer, because a refusal of bad input is part of the contract.
 *
 * `input` is sent as it is, so a string reaches the command as raw text.
 */
export const on = (moment, input) => {
  const repo = inFixture();
  const run = spawnSync('node', [join(CLI, 'workflow.mjs'), 'on', moment], {
    cwd: repo,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, HOME: ctx.home },
  });
  return { status: run.status, stderr: run.stderr, answer: run.status === 0 ? JSON.parse(run.stdout) : null };
};
export const cli = (name, ...args) => spawnSync('node', [join(CLI, name), ...args], { cwd: inFixture(), encoding: 'utf8', env: { ...process.env, HOME: ctx.home } });
/** The analysis report of a receipt, read in the fixture as `record` reads
 * it: from its unified results. */
function fixtureReport(receipt, where) {
  const cwd = process.cwd();
  const home = process.env.HOME;
  process.chdir(where.repo);
  try {
    process.env.HOME = where.home;
    return reportFor(receipt, current().live);
  } finally {
    process.chdir(cwd);
    process.env.HOME = home;
  }
}

/** The summary every fixture analysis with entries opens with. */
export const FIXTURE_SUMMARY = 'Summary: The fixture analysis accounts for each measured gap and limit.';

/** Submit through the real command. The fixture has no compiler. Callers supply the analysis of any findings their case creates. */
export function submitFixtureAnalysis(entries = '', where = ctx) {
  const file = readdirSync(where.logbook).filter(f => f.endsWith('__verified.json')).sort().at(-1);
  const receipt = JSON.parse(readFileSync(join(where.logbook, file), 'utf8'));
  const report = fixtureReport(receipt, where);
  const limits = [{ name: 'coverage', ...report.coverage }, { name: 'mutation', ...report.mutation }, ...report.checks]
    .flatMap(check => [
      ...(['skipped', 'partial', 'deferred', 'unavailable'].includes(check.status) ?
        [`Limit ${check.name} [${check.status}]\nImpact: ${check.reason.replace(/\s+/g, ' ')}`] : []),
      ...(check.treeFingerprint ? [`Limit ${check.name} [reused]\nImpact: Evidence comes from ${check.treeFingerprint}.`] : []),
    ]);
  const body = [...limits, entries].filter(Boolean);
  const input = body.length ? [FIXTURE_SUMMARY, ...body].join('\n\n') : 'All reported checks completed without findings.';
  const run = submitText(receipt.seq, input, where);
  expect(run.status, run.stderr).toBe(0);
  // The command prints the operator's compact summary, linking to the event
  // it just appended, and never the analysis itself.
  const event = readdirSync(where.logbook).filter(f => f.endsWith('__checks_analysis.json')).sort().at(-1);
  const link = relative(where.repo, join(where.logbook, event));
  expect(run.stdout).toBe(analysisSummary({ text: input, seq: receipt.seq, link }) + '\n');
  return input;
}

export function submitText(seq, input, where = ctx) {
  if (!where.repo || !where.home) throw new Error('missing fixture repository');
  return spawnSync(process.execPath, [join(CLI, 'workflow.mjs'), 'checks-analysis', String(seq)], {
    cwd: where.repo, input, encoding: 'utf8', env: { ...process.env, HOME: where.home },
  });
}
export const show = () => cli('show.mjs').stdout;
export const phase = () => /^phase\s+(\w+)$/m.exec(show())[1];
export const events = () => (existsSync(ctx.logbook) ? readdirSync(ctx.logbook).sort() : []);
/** Measure the receipt against the same repository the referee will read. */
export function verifiedPayload(results, repo = ctx.repo) {
  const { treeFingerprint, implementationFingerprint, testFingerprint, baseline, rulebookFingerprint } = inRoot(repo, current);
  return { treeFingerprint, implementationFingerprint, testFingerprint, baseline, rulebookFingerprint, results };
}

/** Append an event to the fixture's logbook as the referee would, so a test
 *  that otherwise only starts processes stays out of mutation runs. */
export const appendEvent = (event, eventPayload) => append(ctx.logbook, event, eventPayload, 'feat/x');

/**
 * A change file the record step accepts, for the change the operator just
 * declared: it opens with the `## Report` section built from the summary the
 * last `declared` event stored, and says `None.` under `## Departures`. The
 * summary comes from the real report run in the fixture, so a case cannot
 * know it in advance; reading it back is what the agent does too.
 */
export const reportedChangeFile = (title = 'X') => {
  const declared = events().filter((e) => e.endsWith('__declared.json')).at(-1);
  if (declared === undefined) throw new Error('reportedChangeFile: nothing has been declared yet');
  const { summary } = JSON.parse(readFileSync(join(ctx.logbook, declared), 'utf8')).payload;
  return `---\n---\n\n# ${title}\n\n${reportSection(summary)}\n\n## Departures\n\nNone.\n`;
};

/**
 * A payload as Claude Code actually sends it, with only the values this case is
 * about changed.
 *
 * Every case below used to hand-write its payload. That is how the previous
 * acceptance check passed its tests while matching nothing Claude Code sends:
 * the hook and the payload had the same author, so they agreed with each other
 * and with nothing else. The fixtures were captured from a live session —
 * `tests/fixtures/claude/README.md` says how — and the envelope around the overridden values
 * is the real one, fields nothing reads included.
 */
export const sent = (fixture, overrides = {}, into = ctx) =>
  payload(fixture, overrides, { home: into.home, repo: into.repo });

export const prompt = (text) => hook('user-prompt.mjs', sent('user-prompt-submit', { prompt: text }));

export const stop = (overrides = {}) => hook('turn-end.mjs', sent('stop', overrides));

/**
 * An edit being attempted. Claude Code always sends `file_path` absolute, so a
 * relative path here is resolved rather than passed through: the cases read
 * better naming `source.txt`, and the hook must still see what it would really
 * get.
 */
export const attempt = (file, tool = 'Write') =>
  hook('pre-tool.mjs', sent('pre-tool-use-write', {
    tool_name: tool,
    tool_input: { file_path: isAbsolute(file) ? file : join(ctx.repo, file) },
  }));

export const planFile = (name = 'a-plan.md', home = ctx.home) => join(home, '.claude/plans', name);

/**
 * `rev` merged into the target on the server, and fetched, as the operator's
 * merge on the hosting platform and their next fetch would leave it.
 */
export const publish = (rev = 'HEAD') => {
  git('push', '--quiet', '--force', 'origin', `${rev}:refs/heads/main`);
  git('fetch', '--quiet', 'origin');
};

/**
 * The operator approving a plan in plan mode.
 *
 * Only `tool_response` carries anything the hook reads. The captured payload's
 * `tool_input` is `{ _targetMode: 'default' }` — Claude Code does not send the
 * plan file's path there, and never sent the draft at all.
 */
export const approvePlan = ({ plan = '# Plan\n\nChange source.txt.', file, where = ctx } = {}) => {
  const path = file ?? planFile('a-plan.md', where.home);
  // The plan is written where the approval says it is. Claude Code has already
  // saved it by the time it shows the dialog, so a fixture that records a path
  // to a file that was never there is simulating something that cannot happen —
  // and `state:show` now reads that file back to report drift, so the pretence
  // stopped being harmless. A `plan: null` case is an approval that carried no
  // text, which records nothing, so there is nothing to write.
  if (typeof plan === 'string') {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, plan);
  }
  return hook('post-tool.mjs', sent('post-tool-use-exit-plan-mode', {
    tool_response: { plan, filePath: path },
  }, where), where);
};

/**
 * The triage, recorded the way the CLI records it.
 *
 * The event is appended directly rather than by running `workflow triage` in the
 * fixture. The real command runs a TypeScript entry point, a full suite and a
 * typecheck against a catalogue this repository does not have, and none of that
 * would exercise a line of the hooks under test here. What the hooks care about
 * is that the event exists and what it carries. The command's own preconditions
 * are proved where they live.
 */
export function triage({ list, predicted = { failed: 0, total: 0 },
  overPredicted = { count: 0, total: predicted.failed, tests: [] },
  notRun = { predicted: [], unpredicted: list?.unlisted ?? [] },
  surprise = { failed: notRun.unpredicted.length, total: notRun.unpredicted.length, failures: [] }, ...payload } = {}, logbook = ctx.logbook) {
  const repo = resolve(logbook, '../../..');
  const { treeFingerprint, implementationFingerprint } = inRoot(repo, current);
  const identities = list ?? { tests: [], unlisted: [...notRun.predicted, ...notRun.unpredicted].sort() };
  const report = { predicted, surprise, overPredicted, notRun };
  const snapshot = writeTriageSnapshot('feat/x', identities, report, repo);
  return append(logbook, 'triaged', triaged({ treeFingerprint, implementationFingerprint, ...payload, ...snapshot }), 'feat/x');
}

/**
 * The fixture's test outcomes: a file in the tree that the fixture's test
 * command, `junit-stub.mjs`, turns into the JUnit report the referee reads.
 * Verify passes when no outcome in it failed. In the tree, not in the config, because the tree fingerprint leaves
 * `.katatay/` out: a case that turns verify green again has to change the
 * tree, or the hook would say verify still fails on the same tree and not run
 * it, as it should.
 */
const OUTCOMES = 'outcomes.json';
const passingOutcomes = { outcomes: [] };
// The file is one the fixture always holds: the referee refuses a report
// that names a file which does not exist.
const failingOutcomes = { outcomes: [{ file: 'source.txt', title: 'a test failed', failed: true }] };

/** The fixture's test command, by its absolute path, because a fixture
 *  repository has no `tools/` of its own. */
const JUNIT_STUB = fileURLToPath(new URL('./junit-stub.mjs', import.meta.url));

/**
 * The fixture's adapter section: this repository's own path rules, so the
 * cases write `.ts` and `.mjs` tests and code as the repository does, with
 * every command a stub. The referee verify runs its own checks for real against
 * the fixture, and these answer for the language. `compile` and `coverage`
 * say the language has none, which the referee prints as not checked.
 * `setCoverage` switches coverage on.
 *
 * `mutate` says it found no mutants, and exits 0, which reads as none surviving. The referee asks it only when a
 * change touches code, and most cases change `source.txt`, which is not code,
 * so for them the referee says there is nothing to mutate without asking.
 * `setMutate` puts another answer in its place.
 */
const { tests, code } = repositoryRulebook();
export const FIXTURE_ADAPTER = {
  tests: {
    // The stub commands read their outcomes and coverage from these files.
    paths: { ...tests.paths, support: [...tests.paths.support, 'outcomes.json', 'coverage.lcov'] },
    run: {
      command: `node ${JSON.stringify(JUNIT_STUB)}`,
      reportPaths: ['reports/junit/*.xml'],
      tagComment: '^\\s*//',
    },
  },
  code: { paths: code.paths, compile: 'none' },
};

/**
 * The project settings a working repository has: every hook the workflow
 * needs, registered.
 *
 * The fixture had no `.claude/` at all, which was harmless while only
 * `state:verify` read the settings back. `state:show`, the turn summary and
 * the verified message print the same warnings now, so a fixture without the
 * file would say "nothing is registered" in every case, and the cases that
 * check the machine has nothing to warn about could not be told from the ones
 * where it does.
 *
 * Written from the manifest and not copied from this repository's own
 * `.claude/settings.json`. No session may repair that file, so a case that
 * failed when it lost a hook would turn `workflow verify` red with nothing the
 * agent could do. `registration.test.mjs` says the same of its own cases.
 */
export const REGISTERED = {
  hooks: Object.fromEntries(
    [...new Set(EXPECTED.map(({ event }) => event))].map((event) => [
      event,
      EXPECTED.filter((expected) => expected.event === event).map(({ matcher, command, timeout }) => ({
        ...(matcher.length > 0 ? { matcher: matcher.join('|') } : {}),
        hooks: [{ type: 'command', command: `node ${command}`, ...(timeout === undefined ? {} : { timeout }) }],
      })),
    ]),
  ),
};

/** The fixture operator's own settings, in the fixture's home folder. */
export const userSettings = (settings, home = ctx.home) => {
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude/settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
};

export const setVerify = (passes, repo = ctx.repo) =>
  writeFileSync(join(repo, OUTCOMES), `${JSON.stringify(passes ? passingOutcomes : failingOutcomes)}\n`);

/** Replace the command run by the fixture's mutation quality check. */
export const setMutate = (command, repo = ctx.repo) => {
  const path = join(repo, '.katatay/rulebook.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.checks.testQuality.mutation = command === 'none' ? 'none' : { ...(typeof config.checks.testQuality.mutation === 'object' ? config.checks.testQuality.mutation : fixtureMutation()), command };
  writeFileSync(path, `${JSON.stringify(config)}\n`);
};

/** Where the fixture's coverage report goes, under the folder its
 *  `.gitignore` already leaves out, and the lcov file its test command copies
 *  there on every run. */
export const COVERAGE_REPORT = 'reports/coverage.info';
export const COVERAGE_SOURCE = 'coverage.lcov';

/**
 * An lcov report: for each file, lines 1 to `total`, each run once except
 * those in `uncovered`, and no branches.
 *
 * @param {Record<string, { total: number, uncovered: number[] }>} files
 */
export const lcovOf = (files) => Object.entries(files).map(([file, { total, uncovered }]) => [
  `SF:${file}`,
  ...Array.from({ length: total }, (_, i) => `DA:${i + 1},${uncovered.includes(i + 1) ? 0 : 1}`),
  `LF:${total}`,
  `LH:${total - uncovered.length}`,
  'end_of_record',
].join('\n')).join('\n') + '\n';

/**
 * The fixture's coverage switched on, with this repository's ignore patterns,
 * and `files` as its report.
 *
 * The test command deletes the source report before every run, so the report
 * has to come from that run, as a real one does. It copies `coverage.lcov` from the tree into place after the
 * fixture's own stub, whatever the stub's exit, so a failing run still leaves
 * a report. Every file lands under `modules/`, which gets a minimum of 0, so
 * the folder check inside verify passes and only the report on the new lines
 * has anything to say. Called again, it replaces the report.
 *
 * @param {Record<string, { total: number, uncovered: number[] }>} files
 */
export const setCoverage = (files, repo = ctx.repo) => {
  const path = join(repo, '.katatay/rulebook.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.checks.testQuality = { ...config.checks.testQuality, coverage: { ...repositoryRulebook().checks.testQuality.coverage, command: `cat ${COVERAGE_REPORT}`, output: 'reports/checks/coverage.json', minimum: { 'modules/': { lines: 0, branches: 0 } } } };
  const copy = `require('fs').mkdirSync('reports', { recursive: true }); require('fs').copyFileSync('${COVERAGE_SOURCE}', '${COVERAGE_REPORT}')`;
  config.tests.run.command = `rm -f ${COVERAGE_REPORT} && (${FIXTURE_ADAPTER.tests.run.command}; node -e "${copy}")`;
  writeFileSync(path, `${JSON.stringify(config)}\n`);
  writeFileSync(join(repo, COVERAGE_SOURCE), lcovOf(files));
};

// The trailing `--` is for the arguments npm appends: the record step runs
// `req:guard -- --record`, and without it node reads `--record` as an option of
// its own and refuses it. A stub that fails prints what it was given, so a test
// can see the flag arrive.
export const setGuard = (passes, repo = ctx.repo) =>
  setScript('req:guard', passes
    ? `${PASSES} --`
    : 'node -e "console.log(\'a record was false, given:\', ...process.argv.slice(1));process.exit(1)" --', repo);

/**
 * A repository copied onto a fresh directory, retried once if it fails.
 *
 * `cpSync` is not reliable against a git repository that was committed to a
 * moment earlier. Measured on this machine, Node 26 and macOS: copying a
 * freshly built fixture failed about 15 times in 100, always inside
 * `.git/objects`, always `ENOENT` on a path the copy had just been walking.
 * Which object directories exist depends on the commit's hashes, so the
 * failure moved from run to run and read like a filesystem race rather than
 * anything the suite was doing.
 *
 * The destination is wiped before each retry, because a half-finished copy
 * leaves read-only loose object files behind and the second attempt then fails
 * `EACCES` on those instead. Two attempts after a wipe succeeded 80 times out
 * of 80, and cost 2ms over the plain call. `cp -R` was equally reliable and
 * twice as slow, and would have put a shell utility in the middle of a suite
 * that already spawns enough processes.
 */
const copyRepository = (from, to) => {
  for (let attempt = 1; ; attempt++) {
    try {
      cpSync(from, to, { recursive: true });
      return;
    } catch (failure) {
      if (attempt === 3) throw failure;
      rmSync(to, { recursive: true, force: true });
      mkdirSync(to, { recursive: true });
    }
  }
};

/**
 * The fixture repository, built once and copied per case.
 *
 * Every case still gets a repository of its own — its own working tree, its own
 * logbook, its own history — because they commit, append to the logbook, and in one
 * case forge an event. Sharing one and cleaning up between cases would put a
 * leak between them, in the suite whose whole job is guarding the workflow.
 *
 * What is shared is the building. `git init`, two `config`s, a `checkout` and
 * the first commit are six processes that produce a byte-identical result every
 * time, and they ran once per case. `cpSync` copies the working tree and `.git`
 * together in one library call: nothing inside `.git` here holds an absolute
 * path, so a copied repository needs no repair. The hooks are still spawned as
 * real processes, which is the part these cases exist to cover.
 */
const buildBase = (template, remote) => {
  const run = (...args) => execFileSync('git', args, { cwd: template, encoding: 'utf8' });
  run('init', '--quiet');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  run('checkout', '--quiet', '-b', 'feat/x');
  // Passing test outcomes are committed rather than written over the copy. A
  // case starts from a clean tree, and several of them turn on exactly that.
  // No scripts: the hooks start the referee's own files, not npm.
  writeFileSync(join(template, 'package.json'), `${JSON.stringify({ name: 'fixture', scripts: {} }, null, 2)}\n`);
  writeFileSync(join(template, OUTCOMES), `${JSON.stringify(passingOutcomes)}\n`);
  // The reports the test command writes are output, as in this repository.
  // The referee refuses to delete a report git would track.
  writeFileSync(join(template, '.gitignore'), '/reports/\n/.katatay/local/\n');
  writeFileSync(join(template, 'source.txt'), 'original\n');
  // The setting every workflow script refuses to run without. See `target.mjs`.
  mkdirSync(join(template, '.katatay'), { recursive: true });
  // Its own high-risk list, not this repository's: which files are high-risk
  // is the operator's policy, and the cases test what the hooks do with a list.
  // A case that needs a file review must read writes one under `guarded/`.
  writeFileSync(join(template, '.katatay/rulebook.json'), `${JSON.stringify({ ...bareSections(), checks: mutationChecks(fixtureMutation({ command: mutationCommand('0 mutants.') })), highRisk: FIXTURE_HIGH_RISK, ...FIXTURE_ADAPTER })}\n`);
  // Committed, like the manifest: a case starts from a clean tree.
  mkdirSync(join(template, '.claude'), { recursive: true });
  writeFileSync(join(template, '.claude/settings.json'), `${JSON.stringify(REGISTERED, null, 2)}\n`);
  // The workflow's instructions, installed, for the same reason as the hooks:
  // the adapter's check warns when the file is missing, and a case that checks
  // there is nothing to warn about needs a setup that is complete.
  mkdirSync(join(template, '.claude/rules'), { recursive: true });
  writeFileSync(join(template, '.claude/rules/workflow.md'), '# The workflow\n');
  run('add', '-A');
  run('commit', '--quiet', '-m', 'base');
  // A real server for the fixture: a bare repository whose `main` is the base
  // commit. The hooks fetch from it and ask it with `ls-remote`, so the server
  // path is exercised as it runs against a real one, only without the network. The
  // URL is absolute, so every copy of the template talks to the same one.
  execFileSync('git', ['init', '--quiet', '--bare', remote]);
  run('remote', 'add', 'origin', remote);
  run('push', '--quiet', 'origin', 'feat/x:main');
  run('fetch', '--quiet', 'origin');
};

/**
 * A template with a plan already approved, for the cases that need one in force
 * and are about something else.
 *
 * Thirty-nine cases began with a plain `approvePlan()`. Each one spawned
 * `post-tool.mjs`, which reads the state, fetches from the server and takes a
 * merge-base, and did the same thing every time. It is walked once here, with
 * the same real hook, and copied. The baseline it pins is the base commit, as a
 * fresh approval in a fresh copy would pin it.
 *
 * Cases about approving still approve for themselves: the approval route is
 * still walked wherever it is the subject. So are cases about the plan file.
 * The logbook records the path of the plan that was approved, and here that path is
 * in the template's home, not the case's, so `planFile()` would name a
 * different file from the one the logbook points at.
 */
const buildApproved = (template, home) => {
  approvePlan({ where: { repo: template, home, logbook: join(template, '.katatay/state/feat_x') } });
};

/**
 * A second template, already approved, triaged and verified.
 *
 * Half the declaration cases start from a verified tree and are about what
 * happens next. Reaching it costs two `git checkout`s, an approval hook, a
 * `stop` that shells out to `workflow verify`, and a `show` — about 0.75s,
 * repeated identically per case. It is built here by running those same real
 * processes once, and the copies are byte-identical, so the verification
 * receipt — which is keyed to a fingerprint of the tree — stays valid in every
 * copy. The route to `verified` is still walked case by case where that route
 * is what the case is about.
 *
 * Its home directory outlives the build, because the logbook records the path of
 * the plan that was approved and `state:show` prints it.
 */
const buildVerified = (template, home) => {
  const run = (...args) => execFileSync('git', args, { cwd: template, encoding: 'utf8' });
  // A `main` for change files to be new against.
  run('checkout', '--quiet', '-b', 'main');
  run('checkout', '--quiet', 'feat/x');
  const where = { repo: template, home, logbook: join(template, '.katatay/state/feat_x') };
  approvePlan({ where });
  triage({}, where.logbook);
  hook('turn-end.mjs', sent('stop', {}, where), where);
  submitFixtureAnalysis('', where);
};

/**
 * The approved template, while a test file that asked for one is running. Kept
 * at module level, like `ctx`, so `approvedChange` below can be imported on its
 * own.
 */
const templates = { approved: null };

/**
 * The case's repository replaced by a copy of a template, pointed at the case's
 * own server. The copy points at the template's.
 */
const fromTemplate = (template) => {
  rmSync(ctx.repo, { recursive: true, force: true });
  mkdirSync(ctx.repo, { recursive: true });
  copyRepository(template, ctx.repo);
  git('remote', 'set-url', 'origin', ctx.remote);
};

/**
 * A change with a plan approved and nothing else done, as `approvePlan()` would
 * leave it. For a test file registered with `machineFixture({ approved: true })`.
 */
export const approvedChange = () => {
  if (!templates.approved) throw new Error('no approved template — register the file with machineFixture({ approved: true })');
  fromTemplate(templates.approved);
};

/**
 * Registers the fixture for a test file. Called once at the top of each.
 *
 * `verified: true` also builds the verified template above, which only the
 * declaration cases need — it costs a second repository and a handful of
 * processes, and building it for files that never copy it would give back what
 * the split won. `approved: true` builds the approved template, for the same
 * reason only where it is used.
 */
export function machineFixture({ verified = false, approved = false } = {}) {
  let base;
  let remote;
  let verifiedTemplate;
  let verifiedHome;
  let approvedTemplate;
  let approvedHome;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'machine-template-'));
    remote = mkdtempSync(join(tmpdir(), 'machine-remote-'));
    buildBase(base, remote);
    if (verified) {
      verifiedTemplate = mkdtempSync(join(tmpdir(), 'machine-verified-'));
      verifiedHome = mkdtempSync(join(tmpdir(), 'machine-verified-home-'));
      copyRepository(base, verifiedTemplate);
      buildVerified(verifiedTemplate, verifiedHome);
    }
    if (approved) {
      approvedTemplate = mkdtempSync(join(tmpdir(), 'machine-approved-'));
      approvedHome = mkdtempSync(join(tmpdir(), 'machine-approved-home-'));
      copyRepository(base, approvedTemplate);
      buildApproved(approvedTemplate, approvedHome);
      templates.approved = approvedTemplate;
    }
  });

  afterAll(() => {
    templates.approved = null;
    for (const dir of [base, remote, verifiedTemplate, verifiedHome, approvedTemplate, approvedHome]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    ctx.repo = mkdtempSync(join(tmpdir(), 'machine-'));
    ctx.home = mkdtempSync(join(tmpdir(), 'machine-home-'));
    ctx.logbook = join(ctx.repo, '.katatay/state/feat_x');
    copyRepository(base, ctx.repo);
    // A server of its own, because a case that publishes to it would otherwise
    // leave its events on the next case's target, where they read as merged.
    ctx.remote = `${mkdtempSync(join(tmpdir(), 'machine-server-'))}/server.git`;
    execFileSync('git', ['clone', '--quiet', '--bare', remote, ctx.remote]);
    git('remote', 'set-url', 'origin', ctx.remote);
  });

  // Guarded, because a `beforeEach` that threw leaves nothing to remove and
  // `rmSync(null)` would bury that first failure under a second one.
  afterEach(() => {
    for (const dir of [ctx.repo, ctx.home, ctx.remote && join(ctx.remote, '..')]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
    ctx.repo = ctx.home = ctx.logbook = ctx.remote = null;
  });

  /**
   * A change approved, triaged and verified, ready for the operator's word:
   * the template above, copied. The guard is the real one, so a case that
   * wants it to fail writes a change file it refuses.
   */
  return () => {
    fromTemplate(verifiedTemplate);
    expect(phase()).toBe('verified');
  };
}
