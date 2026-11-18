import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { givenAGitRepository, whenKttyRuns } from './ktty.mjs';

export const answers = {
  'tests.all': ['tests/**'], 'tests.acceptance': ['acceptance/**'], code: ['src/**'],
  'testRun.command': 'sh run-tests.sh', 'testRun.reports': ['reports/junit.xml'], 'testRun.tagComment': '^#',
};
export const rulebookPath = '.katatay/rulebook.json';
export const planFile = 'plans/change.md';
export const completePlan = ['Why', 'What', 'How', 'Requirements', 'Predicted failures', 'Test delta']
  .map(heading => '## ' + heading + '\n\n' + (['Requirements', 'Predicted failures'].includes(heading) ? 'None.' : 'Concrete content.') + '\n').join('\n');

export const whenGitRuns = (folder, ...args) => execFileSync('git', args, { ...folder, encoding: 'utf8', stdio: 'pipe' }).trimEnd();
export function givenFileContents(folder, path, data) {
  mkdirSync(dirname(join(folder.cwd, path)), { recursive: true });
  writeFileSync(join(folder.cwd, path), data);
}
export const whenFileIsRead = (folder, path, encoding = 'utf8') => readFileSync(join(folder.cwd, path), encoding);
export const whenDirectoryIsListed = directory => readdirSync(directory);
export const whenFileIsRemoved = (folder, path) => rmSync(join(folder.cwd, path));
export const whenJsonIsRead = (folder, path) => JSON.parse(whenFileIsRead(folder, path));
export const exists = (folder, path) => existsSync(join(folder.cwd, path));

export function givenAProject(result = 'pass') {
  const folder = givenAGitRepository();
  givenFileContents(folder, '.gitignore', 'reports/\n');
  givenFileContents(folder, 'src/add.sh', 'echo 4\n');
  givenFileContents(folder, 'tests/add.sh', 'test "$(sh src/add.sh)" = 4\n');
  givenFileContents(folder, 'run-tests.sh', [
    'mkdir -p reports',
    'if sh tests/add.sh; then detail=""; code=0; else detail="<failure/>"; code=1; fi',
    'if test -f skip; then detail="<skipped/>"; code=0; fi',
    'echo "<testsuites><testsuite name=\\"math\\"><testcase name=\\"adds\\" file=\\"tests/add.sh\\">$detail</testcase></testsuite></testsuites>" > reports/junit.xml',
    'exit "$code"', '',
  ].join('\n'));
  if (result === 'fail') givenFileContents(folder, 'src/add.sh', 'echo 5\n');
  if (result === 'skip') givenFileContents(folder, 'skip', '');
  return folder;
}
export const whenInitRuns = (folder, args = [], input = answers) =>
  whenKttyRuns(['init', ...args], { in: folder, input: JSON.stringify(input) });

export function givenPublishedProject(folder, target = 'main') {
  const remote = join(dirname(folder.cwd), 'remote.git');
  whenGitRuns(folder, 'init', '--quiet', '--bare', remote);
  whenGitRuns(folder, 'remote', 'add', 'origin', remote);
  whenGitRuns(folder, 'add', '-A');
  whenGitRuns(folder, 'commit', '-qm', 'Initial project');
  whenGitRuns(folder, 'push', '--quiet', 'origin', 'HEAD:refs/heads/' + target);
}

// Supply public project inputs directly for rulebook and plan cases. Init itself
// is exercised separately. Only the public CLI advances the fixture's workflow.
export function givenAWorkingBranch(target = 'main') {
  const folder = givenAProject();
  givenFileContents(folder, '.gitignore', 'reports/\n.katatay/local/\nplans/\n');
  givenFileContents(folder, rulebookPath, JSON.stringify({
    version: 1, targetBranch: 'origin/' + target, plans: { dir: 'plans' }, highRisk: [],
    tests: { paths: { all: answers['tests.all'], acceptance: answers['tests.acceptance'], support: [] },
      run: { command: answers['testRun.command'], reportPaths: answers['testRun.reports'], tagComment: '^#' } },
    code: { paths: answers.code, compile: 'none' },
    agent: { lockedPaths: ['private/**'], adapters: { fixture: { checkCommand: `printf '%s\\n' '{"version":1,"warnings":[]}'` } } },
    checks: { requireAnalysis: false, testQuality: { coverage: 'none', mutation: 'none' } },
  }));
  givenPublishedProject(folder, target);
  whenGitRuns(folder, 'switch', '-qc', 'work');
  givenFileContents(folder, planFile, completePlan);
  return folder;
}
export function givenRulebookChanges(folder, update) {
  const book = whenJsonIsRead(folder, rulebookPath);
  update(book);
  givenFileContents(folder, rulebookPath, JSON.stringify(book));
}
export function whenEventsAreRead(folder, branch = 'work') {
  const dir = '.katatay/state/' + branch;
  if (!exists(folder, dir)) return [];
  return readdirSync(join(folder.cwd, dir)).sort().map(file => whenJsonIsRead(folder, join(dir, file)));
}
// Appends an event the way the referee writes one: the next seq, linked to
// the bytes of the event before it. For states the public commands reach only
// rarely, such as a baseline move that names the commit it moves from.
export function givenAnEventIsAppended(folder, event, payload, branch = 'work') {
  const dir = '.katatay/state/' + branch;
  const files = readdirSync(join(folder.cwd, dir)).sort();
  const prev = createHash('sha256').update(readFileSync(join(folder.cwd, dir, files.at(-1)))).digest('hex');
  const seq = files.length + 1;
  const record = { version: 1, seq, prev, ts: new Date().toISOString(), event, payload };
  givenFileContents(folder, join(dir, String(seq).padStart(4, '0') + '__' + event + '.json'), JSON.stringify(record, null, 2) + '\n');
}

export function whenHookRuns(folder, name, fields, env = {}) {
  return whenKttyRuns(['on', name], { in: folder, input: JSON.stringify({ version: 1, ...fields }), env });
}
export const whenPlanIsPresented = (folder, file = planFile) => whenHookRuns(folder, 'plan-presented', { planFile: file });
export const whenPlanIsApproved = (folder, file = planFile) => whenHookRuns(folder, 'plan-approved', { planFile: file });
export const whenTurnEnds = (folder, fields = {}, env = {}) =>
  whenHookRuns(folder, 'turn-end', { stopRefusedBefore: false, secondsLeft: 300, ...fields }, env);
export const messages = answer => answer.messages.map(item => item.text).join('\n');
export const block = yaml => '\n```workflow\n' + yaml + '\n```\n';

// Writes and commands an agent proposes, as the write moment receives them.
export const whenAWriteIsProposed = (folder, paths, deletes = []) => whenHookRuns(folder, 'write', {
  writes: [...paths.map(path => ({ path, delete: false })), ...deletes.map(path => ({ path, delete: true }))], command: null,
});
export const whenACommandIsProposed = (folder, command) => whenHookRuns(folder, 'write', { writes: [], command });
export const whenStateIsShown = folder => whenKttyRuns(['state', 'show'], { in: folder });
export const whenTriageRuns = folder => whenKttyRuns(['triage'], { in: folder });
export const whenRiskIsAssessed = folder => whenKttyRuns(['req', 'risk'], { in: folder });
export const whenPathIsRemoved = (folder, path) => rmSync(join(folder.cwd, path), { recursive: true });
export const givenAFolder = (folder, path) => mkdirSync(join(folder.cwd, path), { recursive: true });
export const givenASymbolicLink = (folder, link, target) => symlinkSync(target, join(folder.cwd, link));

// Commits the working branch and pushes it to the target, so what it holds
// becomes the baseline of the next approval.
export function givenTheTargetHolds(folder, message = 'Publish') {
  whenGitRuns(folder, 'add', '-A');
  whenGitRuns(folder, 'commit', '-qm', message);
  whenGitRuns(folder, 'push', '--quiet', 'origin', 'HEAD:main');
}

// A suite whose test command reports exactly the given cases. Each case is
// { file, name, fails, missing }: `fails` is true or the failure's message, and a
// missing case's file exists and is left out of the report, as when it failed
// to load. The command fails when any case fails.
const failure = fails => fails === true ? '<failure/>' : fails ? `<failure message="${fails}"/>` : '';
export function givenTheSuiteReports(folder, cases) {
  for (const file of new Set(cases.map(item => item.file))) {
    givenFileContents(folder, file, cases.filter(item => item.file === file).map(item => '# ' + item.name + '\n').join(''));
  }
  const testcases = cases.filter(item => !item.missing).map(item =>
    `<testcase name="${item.name}" file="${item.file}">${failure(item.fails)}</testcase>`).join('');
  givenFileContents(folder, 'suite/junit.xml', `<testsuites><testsuite name="suite">${testcases}</testsuite></testsuites>\n`);
  givenRulebookChanges(folder, book => {
    book.tests.paths.all = ['tests/**', 'acceptance/**'];
    book.tests.run.command = 'mkdir -p reports && cp suite/junit.xml reports/junit.xml && ! grep -q "<failure" suite/junit.xml';
  });
}

// Wraps the test command so each start appends a line to an ignored file.
export function givenTheTestCommandCountsItsRuns(folder, marker = 'reports/test-command-starts') {
  givenRulebookChanges(folder, book => {
    book.tests.run.command = 'mkdir -p reports && echo start >> ' + marker + ' && ' + book.tests.run.command;
  });
  return marker;
}

export function givenAChangeFile(folder, path, title, summary) {
  givenFileContents(folder, path, ['---', '---', '', '# ' + title, '', '## Report', '', '```text', ...summary, '```', '',
    '## Departures', '', 'None.', ''].join('\n'));
}

// Replaces the fixture's one test with the given suite, all passing unless a
// case says otherwise, and publishes it as the baseline.
export function givenAPublishedSuite(folder, cases) {
  rmSync(join(folder.cwd, 'tests/add.sh'));
  givenTheSuiteReports(folder, cases);
  givenTheTargetHolds(folder, 'Suite');
}

export function givenAPlanPredicting(folder, entries) {
  const lines = entries.map(entry => '  - ' + JSON.stringify(entry));
  givenFileContents(folder, planFile, completePlan + block(['predicted-failures:', ...lines].join('\n')));
}
