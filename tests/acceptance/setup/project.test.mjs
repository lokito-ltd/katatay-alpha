import { it } from 'vitest';
import { givenAnEmptyFolder, whenKttyRuns, thenItExits } from '../support/ktty.mjs';
import {
  answers,
  rulebookPath,
  givenAProject,
  givenFileContents,
  givenPublishedProject,
  whenInitRuns,
  whenGitRuns,
  whenFileIsRead,
  whenDirectoryIsListed,
  whenJsonIsRead,
} from '../support/project.mjs';
import {
  thenValueIs,
  thenValuesEqual,
  thenTextMatches,
  thenContains,
  thenLengthIs,
  thenTextDoesNotMatch,
  thenPathsExist,
  thenFileContains,
  thenJsonIncludes,
  thenGitPrints,
  thenStderrContains,
  thenStdoutContains,
} from '../support/assertions.mjs';
import { isAbsolute, join } from 'node:path';

it('ktty path prints an absolute folder that holds the TypeScript adapter. [AC0002.1]', () => {
  const folder = givenAnEmptyFolder();

  const run = whenKttyRuns(['path'], { in: folder });
  thenItExits(run, 0);
  thenValueIs(run.stderr, '');
  const path = run.stdout.trimEnd();
  thenValueIs(isAbsolute(path), true);
  const adapterFiles = whenDirectoryIsListed(join(path, 'src/adapters/typescript'));
  thenContains(adapterFiles, 'stryker-child.mjs');
});

it("Init in a repository whose commands pass writes the rulebook, the requirements folder and both agents' files, and exits 0. [AC0004.1]", () => {
  const folder = givenAProject();

  const run = whenInitRuns(folder);
  thenItExits(run, 0);
  thenValueIs(run.stderr, '');
  for (const line of [
    'passed — tests: 1 test(s) in 1 file(s), all passing',
    'kept the git repository',
    'claude: wrote .claude/settings.json',
    'codex: wrote AGENTS.md',
  ])
    thenStdoutContains(run, line);
  const expectedPaths = [
    rulebookPath,
    'requirements/README.md',
    'requirements/changes/TEMPLATE.md',
    '.claude/settings.json',
    '.codex/hooks.json',
    'AGENTS.md',
  ];
  thenPathsExist(folder, expectedPaths, true);
});

it("A project init has set up, committed and pushed is in phase open, and the Claude adapter's check finds no workflow hook missing. [AC0004.2]", () => {
  const folder = givenAProject();

  const initRun = whenInitRuns(folder);
  thenItExits(initRun, 0);
  givenPublishedProject(folder);

  const state = whenKttyRuns(['state', 'show'], { in: folder });
  thenItExits(state, 0);
  thenTextMatches(state.stdout, /^phase\s+open$/m);

  const run = whenKttyRuns(['agent', 'claude', 'check'], {
    in: folder,
    input: JSON.stringify({ version: 1, root: folder.cwd, extraHooks: { acknowledged: [] } }),
  });
  thenItExits(run, 0);
  thenValuesEqual(
    JSON.parse(run.stdout).warnings.filter((w) => /does not run|extra|is missing/.test(w)),
    [],
  );
});

it('A second init on a project it set up changes nothing. [AC0004.3]', () => {
  const folder = givenAProject();

  const initRun = whenInitRuns(folder);
  thenItExits(initRun, 0);
  givenPublishedProject(folder);

  const run = whenInitRuns(folder);
  thenItExits(run, 0);
  thenTextDoesNotMatch(run.stdout, /^- .*\b(wrote|merged|added|started)\b/m);
  thenGitPrints(folder, ['status', '--porcelain'], '');
});

it('Init writes nothing when the test command leaves a test file out of its report. [AC0004.4]', () => {
  const folder = givenAProject();
  givenFileContents(folder, 'tests/other.sh', 'exit 0\n');

  const run = whenInitRuns(folder);
  thenItExits(run, 1);
  thenStderrContains(run, 'init wrote nothing:');
  thenStderrContains(run, 'left out of the report: tests/other.sh');
  thenPathsExist(folder, ['.katatay', '.claude', '.codex', '.agents', 'AGENTS.md', 'requirements'], false);
});

it('Init writes nothing when no test passed. [AC0004.5]', () => {
  const folder = givenAProject('skip');

  const run = whenInitRuns(folder);
  thenItExits(run, 1);
  thenStderrContains(run, 'no test passed (1 skipped)');
  thenPathsExist(folder, ['.katatay', '.claude', '.codex', '.agents', 'AGENTS.md', 'requirements'], false);
});

it('Init writes nothing in a folder that is not a git repository, and says to run git init. [AC0004.6]', () => {
  const folder = givenAnEmptyFolder();

  const run = whenInitRuns(folder);
  thenItExits(run, 1);
  thenStderrContains(run, 'is not a git repository');
  thenStderrContains(run, 'Run `git init`');
  const entries = whenDirectoryIsListed(folder.cwd);
  thenValuesEqual(entries, []);
});

it('Init writes nothing when a required question has no answer, and names each question. [AC0004.7]', () => {
  const folder = givenAProject();

  const run = whenInitRuns(folder, [], {});
  thenItExits(run, 1);
  for (const id of Object.keys(answers)) thenStderrContains(run, '"' + id + '" has no answer');
  thenPathsExist(folder, ['.katatay', '.claude', '.codex', '.agents', 'AGENTS.md', 'requirements'], false);
});

it("Init keeps an existing AGENTS.md and appends the workflow's part between marker lines. [AC0005.1]", () => {
  const folder = givenAProject();
  givenFileContents(folder, 'AGENTS.md', '# Our rules\n\nBe kind.\n');

  const initRun = whenInitRuns(folder);
  thenItExits(initRun, 0);
  const instructions = whenFileIsRead(folder, 'AGENTS.md');
  thenTextMatches(
    instructions,
    /^# Our rules\n\nBe kind\.\n\n<!-- workflow: begin -->\n[\s\S]+<!-- workflow: end -->\s*$/,
  );
});

it('Init keeps existing Claude settings and hooks and adds its own hooks beside them. [AC0005.2]', () => {
  const folder = givenAProject();
  const custom = { hooks: [{ type: 'command', command: 'echo done' }] };
  givenFileContents(
    folder,
    '.claude/settings.json',
    JSON.stringify({ model: 'ours', hooks: { Stop: [custom] } }),
  );

  const initRun = whenInitRuns(folder);
  thenItExits(initRun, 0);
  const settings = whenJsonIsRead(folder, '.claude/settings.json');
  thenValueIs(settings.model, 'ours');
  thenValuesEqual(settings.hooks.Stop[0], custom);
  thenLengthIs(settings.hooks.Stop, 2);
  thenContains(settings.hooks.Stop[1].hooks[0].command, 'turn-end');
});

it("Init on a shared file that already holds the workflow's markers adds nothing. [AC0005.3]", () => {
  const folder = givenAProject();
  const marked = 'Before\n<!-- workflow: begin -->\nExisting text\n<!-- workflow: end -->\nAfter\n';
  givenFileContents(folder, 'AGENTS.md', marked);

  const initRun = whenInitRuns(folder);
  thenItExits(initRun, 0);
  thenFileContains(folder, 'AGENTS.md', marked);
});

it('Init with --questions prints each question with its id, and its default where it has one, and exits 0. [AC0006.1]', () => {
  const folder = givenAnEmptyFolder();

  const run = whenInitRuns(folder, ['--questions']);
  thenItExits(run, 0);
  const questions = JSON.parse(run.stdout).questions;
  thenValuesEqual(
    questions.map((q) => q.id).sort(),
    [
      'targetBranch',
      'tests.all',
      'tests.acceptance',
      'tests.slow',
      'testSupport',
      'code',
      'testRun.command',
      'testRun.reports',
      'testRun.tagComment',
      'compile.command',
      'compile.pattern',
      'compile.exitCodes',
      'plans.dir',
      'followUpsFile',
      'requirementsDir',
      'highRisk',
      'coverage',
      'coverage.command',
      'coverage.minimum',
      'mutation',
      'mutation.command',
      'mutation.report',
      'mutation.timeLimitSeconds',
      'checks.codeQuality',
      'wrappers',
    ].sort(),
  );
  const defaults = Object.fromEntries(questions.filter((q) => 'default' in q).map((q) => [q.id, q.default]));
  thenValuesEqual(defaults, {
    targetBranch: 'main',
    'tests.slow': [],
    testSupport: [],
    'compile.command': 'none',
    'compile.exitCodes': { 0: 'clean', 1: 'errors' },
    'plans.dir': '~/.claude/plans',
    followUpsFile: 'FOLLOW-UPS.md',
    requirementsDir: 'requirements',
    highRisk: [],
    coverage: false,
    mutation: false,
    'mutation.timeLimitSeconds': 300,
    'checks.codeQuality': {},
    wrappers: [],
  });
});

it('Init with --questions writes nothing. [AC0006.2]', () => {
  const folder = givenAnEmptyFolder();

  const initRun = whenInitRuns(folder, ['--questions']);
  thenItExits(initRun, 0);
  const entries = whenDirectoryIsListed(folder.cwd);
  thenValuesEqual(entries, []);
});

it('Answers sent as one JSON object on stdin are used, and a question with a default may be left out. [AC0006.3]', () => {
  const folder = givenAProject();

  const initRun = whenInitRuns(folder, [], { ...answers, requirementsDir: 'catalogue' });
  thenItExits(initRun, 0);
  thenJsonIncludes(folder, rulebookPath, { requirementsDir: 'catalogue', targetBranch: 'origin/main' });
  thenPathsExist(folder, ['catalogue/README.md'], true);
});

it('A probe prints each item and exits 0 when every item passed. [AC0007.1]', () => {
  const folder = givenAProject();

  const run = whenInitRuns(folder, ['--probe']);
  thenItExits(run, 0);
  thenValueIs(
    run.stdout,
    'Probed ' + folder.cwd + ':\n- passed — tests: 1 test(s) in 1 file(s), all passing\n',
  );
  thenPathsExist(folder, ['.katatay', '.claude', '.codex', '.agents', 'AGENTS.md', 'requirements'], false);
});

it('A probe exits 1 when an item failed. [AC0007.2]', () => {
  const folder = givenAProject('fail');

  const run = whenInitRuns(folder, ['--probe']);
  thenItExits(run, 1);
  thenStdoutContains(run, 'FAILED — tests: 1 failed of 1 test(s) in 1 file(s)');
  thenPathsExist(folder, ['.katatay', '.claude', '.codex', '.agents', 'AGENTS.md', 'requirements'], false);
});

it("A probe in a set-up project probes the project's own rulebook. [AC0007.3]", () => {
  const folder = givenAProject();

  const initRun = whenInitRuns(folder);
  thenItExits(initRun, 0);
  givenPublishedProject(folder);
  givenFileContents(folder, 'src/add.sh', 'echo 5\n');

  const run = whenInitRuns(folder, ['--probe'], {});
  thenItExits(run, 1);
  thenStdoutContains(run, 'FAILED — tests: 1 failed of 1 test(s) in 1 file(s)');
  const changes = whenGitRuns(folder, 'status', '--porcelain');
  thenValueIs(changes.trim(), 'M src/add.sh');
});

it('A probe told to expect a break exits 0 when it finds that break at the item concerned. [AC0007.4]', () => {
  const folder = givenAProject('fail');

  const run = whenInitRuns(folder, ['--probe', '--expect', 'failing-test']);
  thenItExits(run, 0);
  thenStdoutContains(run, 'passed — tests: 1 test(s) in 1 file(s), 1 failed');
  thenPathsExist(folder, ['.katatay', '.claude', '.codex', '.agents', 'AGENTS.md', 'requirements'], false);
});

it('A probe told to expect a break exits 1 when it finds none. [AC0007.5]', () => {
  const folder = givenAProject();

  const run = whenInitRuns(folder, ['--probe', '--expect', 'failing-test']);
  thenItExits(run, 1);
  thenStdoutContains(
    run,
    'FAILED — tests: expected a failed test, and none of 1 test(s) in 1 file(s) failed',
  );
  thenPathsExist(folder, ['.katatay', '.claude', '.codex', '.agents', 'AGENTS.md', 'requirements'], false);
});

it('A probe told to expect a break whose item the rulebook switches off exits 2. [AC0007.6]', () => {
  const folder = givenAProject();

  const run = whenInitRuns(folder, ['--probe', '--expect', 'survivors']);
  thenItExits(run, 2);
  thenValueIs(run.stderr, 'survivors cannot be probed: "checks.testQuality.mutation" is "none"\n');
  thenPathsExist(folder, ['.katatay', '.claude', '.codex', '.agents', 'AGENTS.md', 'requirements'], false);
});

it('Expecting a break without probing is refused with exit 2, and nothing is written. [AC0007.7]', () => {
  const folder = givenAProject();

  const run = whenInitRuns(folder, ['--expect', 'failing-test']);
  thenItExits(run, 2);
  thenStderrContains(run, '[--probe [--expect <state>]]');
  thenPathsExist(folder, ['.katatay', '.claude', '.codex', '.agents', 'AGENTS.md', 'requirements'], false);
});
