// Fixture steps for verify's checks: ordinary rulebook checks, coverage and
// mutation. Each check's command reads its answer from an ignored file the
// test writes, so a case can change what a check says without changing the
// tree, the way a cause outside the tree would.
import { thenHookReplies } from './ktty.mjs';
import {
  exists,
  givenFileContents,
  givenRulebookChanges,
  whenFileIsRead,
  whenPlanIsApproved,
  whenTriageRuns,
} from './project.mjs';
import { thenItExits, whenKttyRuns } from './ktty.mjs';

// Every check command appends its name here when it starts.
export const startsFile = 'reports/check-starts';
const answer = name => 'reports/answers/' + name;

// What an ordinary check prints and the code it exits with.
export function givenACheckAnswers(folder, name, { exit = 0, text = '' }) {
  givenFileContents(folder, answer(name) + '.exit', String(exit));
  givenFileContents(folder, answer(name) + '.out', text);
}

// An ordinary check in the given chain. The command logs its start, prints its
// answer and exits with it. `fields` adds or replaces rulebook keys.
export function givenACheck(folder, chain, name, fields = {}) {
  givenACheckAnswers(folder, name, { exit: 0 });
  givenRulebookChanges(folder, book => {
    book.checks[chain] ??= {};
    book.checks[chain][name] = {
      command: `echo ${name} >> ${startsFile}; cat ${answer(name)}.out; exit "$(cat ${answer(name)}.exit)"`,
      exitCodes: { 0: 'clean', 1: 'findings' },
      ...fields,
    };
  });
}

// The names of the checks that started, in order, or [] when none did.
export const whenCheckStartsAreRead = folder =>
  exists(folder, startsFile) ? whenFileIsRead(folder, startsFile).trim().split('\n').filter(Boolean) : [];

// LCOV for the given files: each { file, lines: { [line]: hits }, branches: [hit, ...] }.
export function lcov(files) {
  return files.map(({ file, lines = {}, branches = [] }) => [
    'TN:', 'SF:' + file,
    ...branches.map((hits, i) => `BRDA:1,0,${i},${hits}`),
    `BRF:${branches.length}`, `BRH:${branches.filter(hits => hits > 0).length}`,
    ...Object.entries(lines).map(([line, hits]) => `DA:${line},${hits}`),
    `LF:${Object.keys(lines).length}`, `LH:${Object.values(lines).filter(hits => hits > 0).length}`,
    'end_of_record',
  ].join('\n')).join('\n') + '\n';
}

export const coverageOutput = 'reports/checks/coverage.json';

// What the coverage command prints: the LCOV text given.
export function givenTheCoverageReport(folder, text) {
  givenFileContents(folder, answer('lcov.info'), text);
}

// Coverage switched on, printing the report `givenTheCoverageReport` wrote.
export function givenCoverage(folder, minimum = { 'src/': { lines: 50, branches: 50 } }) {
  givenTheCoverageReport(folder, lcov([{ file: 'src/add.sh', lines: { 1: 1 } }]));
  givenRulebookChanges(folder, book => {
    book.checks.testQuality.coverage = {
      command: `echo coverage >> ${startsFile}; cat ${answer('lcov.info')}`,
      output: coverageOutput, minimum,
    };
  });
}

export const mutationOutput = 'reports/mutation/mutation.json';
export const requestsFile = 'reports/mutation-requests';

// A mutation command: logs its start and the request it read on stdin, then
// does what reports/answers/mutation.json says: { text, exit, report, sleep },
// where report is the standard report to write, 'invalid', or absent for none.
const mutateScript = `const fs = require('fs');
const request = fs.readFileSync(0, 'utf8');
fs.mkdirSync('reports/mutation', { recursive: true });
fs.appendFileSync('${startsFile}', 'mutation\\n');
fs.appendFileSync('${requestsFile}', JSON.stringify(JSON.parse(request)) + '\\n');
const answer = JSON.parse(fs.readFileSync('${answer('mutation.json')}', 'utf8'));
const finish = () => {
  if (answer.report === 'invalid') fs.writeFileSync('${mutationOutput}', '{"schemaVersion":"1.0","files":7}');
  else if (answer.report) fs.writeFileSync('${mutationOutput}', JSON.stringify(answer.report));
  if (answer.text) console.log(answer.text);
  if (answer.error) console.error(answer.error);
  process.exitCode = answer.exit;
};
if (answer.sleep) setTimeout(finish, answer.sleep * 1000); else finish();
`;

// A standard mutation report for src/add.sh: one mutant per status given.
export function mutationReport(statuses, source = 'echo $((2 + 2))\n') {
  return {
    schemaVersion: '1.0', thresholds: { high: 80, low: 60 },
    files: {
      'src/add.sh': {
        language: 'shell', source,
        mutants: statuses.map((status, i) => ({
          id: String(i + 1), mutatorName: 'ArithmeticOperator', replacement: '2 - 2',
          location: { start: { line: 1, column: 9 }, end: { line: 1, column: 14 } },
          status, testsCompleted: 1,
        })),
      },
    },
  };
}

export function givenTheMutationAnswer(folder, answerFields) {
  givenFileContents(folder, answer('mutation.json'), JSON.stringify(answerFields));
}

// Mutation switched on, answering clean with one killed mutant.
export function givenMutation(folder, fields = {}) {
  givenFileContents(folder, 'mutate.js', mutateScript);
  givenTheMutationAnswer(folder, { text: '1 mutant: 1 caught, 0 survived.', exit: 0, report: mutationReport(['Killed']) });
  givenRulebookChanges(folder, book => {
    book.checks.testQuality.mutation = { command: 'node mutate.js', output: mutationOutput, excludePaths: [], timeLimitSeconds: 10, ...fields };
  });
}

// The requests the mutation command read, one per run.
export const whenMutationRequestsAreRead = folder =>
  exists(folder, requestsFile) ? whenFileIsRead(folder, requestsFile).trim().split('\n').map(line => JSON.parse(line)) : [];

// The approved plan, a change to the implementation that keeps the suite
// green, and its triage: the change is converging.
export function givenAConvergingChange(folder, source = 'echo $((2 + 2))\n') {
  thenHookReplies(whenPlanIsApproved(folder), 0);
  givenFileContents(folder, 'src/add.sh', source);
  thenItExits(whenTriageRuns(folder), 0);
}

export const whenVerifyRuns = (folder, args = [], env = {}) => whenKttyRuns(['verify', ...args], { in: folder, env });
export const whenCoverageRuns = (folder, env = {}) => whenKttyRuns(['coverage'], { in: folder, env });
export const whenMutateRuns = (folder, args = [], env = {}) => whenKttyRuns(['mutate', ...args], { in: folder, env });
export const whenChecksAnalysisIsSubmitted = (folder, args, text) =>
  whenKttyRuns(['checks-analysis', ...args], { in: folder, input: text });

// The codes of a hook answer's messages, in order.
export const codesOf = answer => answer.messages.map(message => message.code);
// The text of the answer's message with this code, or undefined.
export const textOf = (answer, code) => answer.messages.find(message => message.code === code)?.text;
// The summary's prose wraps at 76 columns; read it unwrapped.
export const unwrapped = text => text.replace(/\n(?!\n)/g, ' ');
