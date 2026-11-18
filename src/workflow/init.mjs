/**
 * `init`: set up a project, new or existing.
 *
 * Either the operator or an agent runs it. The operator answers its
 * questions in the terminal. An agent reads them with `--questions`, fills in
 * what it can, sends the answers as JSON, and asks the operator in chat for
 * the rest. Both routes end in the same checks.
 *
 * Everything is read and checked before anything is written: the answers,
 * each agent adapter's defaults and install answer, and the drafted rulebook,
 * through the same parsers every referee command uses. So a bad answer or an
 * adapter that gives no answer leaves the folder as it was. A rulebook
 * drafted here is then proved: the probe runs its commands and reads what
 * they produce as verify would, and a command that does not pass leaves the
 * folder as it was too (step 34; see `startProbe` and "The probe" in
 * `README.md`). Then, in order:
 * git, the rulebook, the requirements folder, `.gitignore`, the agent's
 * instructions, and the agent's hook registration, so the project is guarded
 * from its first session.
 *
 * Nothing is overwritten, with two exceptions the adapter contract names. A
 * file the adapter marks shared holds the project's own text too, so the
 * workflow's part is appended between marker lines. The hook registration is
 * merged by the adapter into what the project's file holds, and written
 * whole: it is the one locked file `init` writes, because the operator runs
 * `init`.
 *
 * The referee knows no agent. Each adapter comes in as a label and its
 * `defaults` command line, as `cli/init.mjs` reads them.
 */
import { HARNESS_SCHEMA_VERSION } from '../schema-version.mjs';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentDefaults, agentInstall } from './agent.mjs';
import { gitText } from './git.mjs';
import { errorLines, parseCompileExitCodes } from './adapter.mjs';
import { packaged } from '../distribution.mjs';
import { runReferee } from './runtime.mjs';
import { installRequest } from './install.mjs';
import { real } from './places.mjs';
import { STATE_FOLDER, STATE_FOLDER_PATTERN } from './folder.mjs';
import {
  CONFIG, CHECK_TIME_LIMIT, DEFAULT_FOLLOW_UPS, DEFAULT_REQUIREMENTS, coverageMinimumProblems,
  parsePlansDir, parseRequirementsDir, parseRulebook, parseTargetBranch,
} from './rulebook.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** The requirements folder's README and change-file template, as the referee ships them. */
export const CATALOGUE = join(HERE, 'catalogue');

/** The command that starts the referee, wherever this harness is. */
export const WORKFLOW = join(HERE, 'cli', 'workflow.mjs');

/** What `.gitignore` gets, so the referee's local snapshots stay out of git. */
export const IGNORED = `/${STATE_FOLDER}/local/`;

/** The lines a shared file's workflow part sits between. */
export const BEGIN = '<!-- workflow: begin -->';
export const END = '<!-- workflow: end -->';

/** Where the coverage check keeps its analysis. Not asked: no project has needed another. */
export const COVERAGE_OUTPUT = 'reports/checks/coverage.json';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const isTextList = (value) => Array.isArray(value) && value.every(isText);

/** A comma-separated line as a list, empty entries left out. */
const listOf = (text) => text.split(',').map((item) => item.trim()).filter((item) => item !== '');

const yes = (text) => {
  const word = text.trim().toLowerCase();
  if (['y', 'yes', 'on', 'true'].includes(word)) return true;
  if (['n', 'no', 'off', 'false'].includes(word)) return false;
  throw new Error('answer yes or no');
};

const wholeNumber = (text) => {
  const value = Number(text.trim());
  if (!Number.isInteger(value) || value <= 0) throw new Error('answer a whole number above 0');
  return value;
};

/** Keep range keys as typed in the rulebook. The compile runner needs the expanded map only when reading it. */
const exitCodes = (text) => {
  const codes = Object.create(null);
  for (const pair of listOf(text)) {
    const [code, meaning, extra] = pair.split('=').map((part) => part.trim());
    if (!code || !meaning || extra !== undefined) throw new Error('answer exit codes as code=meaning, separated by commas, such as 0=clean, 1-255=errors');
    if (Object.hasOwn(codes, code)) throw new Error(`the answer names ${code} twice`);
    codes[code] = meaning;
  }
  parseCompileExitCodes(codes, (problem) => new Error(problem));
  return codes;
};

/** `paths, more paths | why` as one high-risk area. */
const area = (text) => {
  const bar = text.indexOf('|');
  if (bar < 0) throw new Error('answer the paths, separated by commas, then | and the reason');
  // Refused here rather than by the rulebook check at the end, which would
  // throw away every answer typed before it.
  const paths = listOf(text.slice(0, bar));
  if (paths.length === 0) throw new Error('answer at least one path before |');
  const why = text.slice(bar + 1).trim();
  if (why === '') throw new Error('answer the reason after |');
  return { paths, why };
};

/** `folder/ lines branches` as one folder's coverage minimum. */
const minimumLine = (text) => {
  const [folder, lines, branches] = text.trim().split(/\s+/);
  if (lines === undefined) throw new Error('supply the lines and branches minimums, such as src/ 80 70');
  if (branches === undefined) throw new Error('supply the branches minimum after the lines minimum, such as src/ 80 70');
  const floors = { lines: Number(lines), branches: Number(branches) };
  const problems = coverageMinimumProblems({ [folder]: floors }, 'coverage.minimum');
  if (problems.length) throw new Error(problems.join(' ').replace(/\.$/, ''));
  return [folder, floors];
};

/**
 * `name | command | 0=clean, 1=findings` as one check. Only the line's shape
 * is read here. What a check may hold is the rulebook parser's to say, and it
 * says it when the drafted rulebook is checked.
 */
const checkLine = (text) => {
  const [name, command, codes, extra] = text.split('|').map((part) => part.trim());
  if (!name || !command || !codes || extra !== undefined) {
    throw new Error('answer the check\'s name, then | and its command, then | and its exit codes, such as lint | make lint | 0=clean, 1=findings');
  }
  const exitCodes = {};
  for (const pair of listOf(codes)) {
    const [code, meaning, more] = pair.split('=').map((part) => part.trim());
    if (!code || !meaning || more !== undefined) throw new Error('answer exit codes as code=meaning, separated by commas, such as 0=clean, 1=findings');
    exitCodes[code] = meaning;
  }
  return [name, { command, exitCodes }];
};

const KINDS = {
  text: { read: (text) => text.trim(), accepts: isText, shape: 'text' },
  list: { read: listOf, accepts: (value) => Array.isArray(value) && value.every((item) => typeof item === 'string'), shape: 'a list of strings' },
  yesno: { read: yes, accepts: (value) => typeof value === 'boolean', shape: 'true or false' },
  number: { read: wholeNumber, accepts: (value) => Number.isInteger(value) && value > 0, shape: 'a whole number above 0' },
  exitCodes: { read: exitCodes, accepts: (value) => isObject(value), shape: 'an object of exit code to meaning' },
  // Asked one item per line in a terminal, until an empty line.
  areas: { read: area, repeat: true, accepts: (value) => Array.isArray(value) && value.every(isObject), shape: 'a list of { paths, why }' },
  minimum: { read: minimumLine, repeat: true, entries: true, accepts: (value) => isObject(value), shape: 'an object of folder to { lines, branches }' },
  checks: { read: checkLine, repeat: true, entries: true, accepts: (value) => isObject(value) && Object.values(value).every(isObject),
    shape: 'an object of check name to { command, exitCodes }, with onFailure, runs, timeLimitSeconds and suppressions where wanted' },
};

const on = (id) => (answers) => answers[id] === true;
const compiles = (answers) => answers['compile.command'] !== 'none';

/**
 * The questions, in the order they are asked. `when` leaves a question out
 * when an earlier answer makes it meaningless, and says so in `--questions`.
 * A question with a default is never missing: in a terminal, Enter takes it,
 * and with no terminal it is taken as it is.
 *
 * @param {{ plansFolder?: string }} [proposed] what the agent adapters proposed
 */
export function questions({ plansFolder } = {}) {
  return [
    { id: 'targetBranch', kind: 'text', default: 'main', ask: 'Which branch do changes merge into? A branch name such as main means origin/main.' },
    { id: 'tests.all', kind: 'list', ask: 'Which globs find every test file?' },
    { id: 'tests.acceptance', kind: 'list', ask: 'Which globs find the acceptance tests, the ones that prove requirements?' },
    { id: 'tests.slow', kind: 'list', default: [], ask: 'Which globs find the slow tests, left out of quick runs and mutation? None is fine.' },
    { id: 'testSupport', kind: 'list', default: [], ask: 'Which globs find test support files, such as fixtures and helpers? They are frozen with the tests.' },
    { id: 'code', kind: 'list', ask: 'Which globs find the code: what coverage measures and mutation changes?' },
    { id: 'testRun.command', kind: 'text', ask: 'What command runs every test and writes JUnit XML reports?' },
    { id: 'testRun.reports', kind: 'list', ask: 'Which globs find the JUnit reports it writes? Each starts with a folder named in full.' },
    { id: 'testRun.tagComment', kind: 'text', ask: 'What regular expression matches a comment line in a test file, where a scenario tag can sit above a test?' },
    { id: 'compile.command', kind: 'text', default: 'none', ask: 'What command compiles or type-checks the code, tests included? none if the language has no such step.' },
    { id: 'compile.pattern', kind: 'text', when: compiles, whenText: 'asked when there is a compile command', ask: 'What regular expression reads one error from its output, with named groups file and message, and optionally line?' },
    { id: 'compile.exitCodes', kind: 'exitCodes', when: compiles, whenText: 'asked when there is a compile command', default: { 0: 'clean', 1: 'errors' }, ask: 'Which exit codes mean clean, errors or broken? Enter codes or ranges, for example 0=clean, 1-255=errors.' },
    { id: 'plans.dir', kind: 'text', default: plansFolder ?? `~/${STATE_FOLDER}/plans`, ask: 'Where are plan files written? ~ is the home folder.' },
    { id: 'followUpsFile', kind: 'text', default: DEFAULT_FOLLOW_UPS, ask: 'Which file holds the follow-ups, work parked for later?' },
    { id: 'requirementsDir', kind: 'text', default: DEFAULT_REQUIREMENTS, ask: 'Which folder holds the requirements?' },
    { id: 'highRisk', kind: 'areas', default: [], ask: 'Which files are high-risk, so a reviewer must read every change to them? One area per line: paths separated by commas, then | and the reason. An empty line ends the list.' },
    { id: 'coverage', kind: 'yesno', default: false, ask: 'Is test coverage measured?' },
    { id: 'coverage.command', kind: 'text', when: on('coverage'), whenText: 'asked when coverage is measured', ask: 'What command prints the coverage report as LCOV?' },
    { id: 'coverage.minimum', kind: 'minimum', when: on('coverage'), whenText: 'asked when coverage is measured', ask: 'Give minimums for at least one folder. On each line enter the folder ending in /, its lines minimum and its branches minimum, such as src/ 80 70. Press Enter after the last folder.' },
    { id: 'mutation', kind: 'yesno', default: false, ask: 'Is mutation testing run on the lines a change touches?' },
    { id: 'mutation.command', kind: 'text', when: on('mutation'), whenText: 'asked when mutation testing is run', ask: 'What command runs it?' },
    { id: 'mutation.report', kind: 'text', when: on('mutation'), whenText: 'asked when mutation testing is run', ask: 'Which file does it write its standard mutation report to?' },
    { id: 'mutation.timeLimitSeconds', kind: 'number', when: on('mutation'), whenText: 'asked when mutation testing is run', default: CHECK_TIME_LIMIT, ask: 'How many seconds may it run?' },
    // Asked last, so the scripts and answer files written before them still read.
    { id: 'checks.codeQuality', kind: 'checks', default: {}, ask: 'Which other checks does verify run, such as a lint or the build? One per line: its name, then | and its command, then | and its exit codes, such as lint | make lint | 0=clean, 1=findings. An empty line ends the list.' },
    { id: 'wrappers', kind: 'list', default: [], ask: 'Which files in this project were written to make a tool keep the contract, such as a test reporter or a mutation wrapper? Give paths from the project\'s root. Neither the file nor a directory along its path may be a symbolic link. They are listed as high-risk, so a reviewer reads every change to them.' },
  ];
}

/** The questions as `--questions` prints them, for an agent to read. */
export function questionsJson(proposed) {
  return {
    about: 'Ask the operator each question that cannot be answered from the project, then send the answers as one JSON object keyed by id, on stdin or with --answers <file>. A question with a default may be left out.',
    questions: questions(proposed).map((question) => ({
      id: question.id,
      ask: question.ask,
      answer: KINDS[question.kind].shape,
      ...(question.default === undefined ? { required: true } : { default: question.default }),
      ...(question.whenText === undefined ? {} : { when: question.whenText }),
    })),
  };
}

/**
 * The answers, from what was given and what could be asked.
 *
 * `given` is the parsed JSON answers, keyed by question id. `ask(question)`
 * asks one question in a terminal and resolves to the line typed, or is
 * null when there is no terminal. A given answer is never asked again.
 * Returns `{ answers }`, or `{ problems }` naming each answer that is the
 * wrong shape, unknown, or required and missing.
 *
 * @param {Record<string, unknown>} given
 * @param {((question: object) => Promise<string>) | null} ask
 * @param {{ plansFolder?: string }} [proposed]
 * @param {(line: string) => void} [say] where a terminal reply that cannot be read is explained
 */
export async function gatherAnswers(given, ask, proposed = {}, say = () => {}) {
  const list = questions(proposed);
  const problems = [];
  const known = new Set(list.map(({ id }) => id));
  for (const id of Object.keys(given)) if (!known.has(id)) problems.push(`"${id}" is not one of init's questions`);
  const answers = {};
  for (const question of list) {
    if (question.when && !question.when(answers)) continue;
    const kind = KINDS[question.kind];
    if (Object.hasOwn(given, question.id)) {
      const value = given[question.id];
      if (!kind.accepts(value)) problems.push(`"${question.id}" must be ${kind.shape}`);
      else {
        if (question.kind === 'minimum') problems.push(...coverageMinimumProblems(value, question.id));
        answers[question.id] = value;
      }
      continue;
    }
    if (ask === null) {
      if (question.default !== undefined) answers[question.id] = question.default;
      else problems.push(`"${question.id}" has no answer: ${question.ask}`);
      continue;
    }
    answers[question.id] = kind.repeat ? await askRepeated(question, ask, say) : await askOnce(question, ask, say);
  }
  return problems.length > 0 ? { problems } : { answers };
}

async function askOnce(question, ask, say) {
  const kind = KINDS[question.kind];
  for (;;) {
    const reply = (await ask(question)).trim();
    if (reply === '' && question.default !== undefined) return question.default;
    if (reply === '') {
      say('An answer is needed.');
      continue;
    }
    try {
      return kind.read(reply);
    } catch (error) {
      say(`${error.message[0].toUpperCase()}${error.message.slice(1)}.`);
    }
  }
}

async function askRepeated(question, ask, say) {
  const kind = KINDS[question.kind];
  const items = [];
  for (;;) {
    const reply = (await ask(question)).trim();
    if (reply === '') {
      if (items.length || question.default !== undefined) break;
      say('Coverage needs at least one folder with lines and branches minimums, such as src/ 80 70.');
      continue;
    }
    try {
      items.push(kind.read(reply));
    } catch (error) {
      say(`${error.message[0].toUpperCase()}${error.message.slice(1)}.`);
    }
  }
  if (items.length === 0 && question.default !== undefined) return question.default;
  return kind.entries ? Object.fromEntries(items) : items;
}

/** `main` as `origin/main`; a name that already says its remote stays as it is. */
const remoteBranchOf = (target) => (target.includes('/') ? target : `origin/${target}`);

/**
 * The rulebook the answers and the adapters' proposals make, as an object.
 *
 * @param {Record<string, any>} answers from `gatherAnswers`
 * @param {{ label: string, proposal: { locked: string[], commands: { check: string } } }[]} adapters
 * @param {string[]} installed the paths of the instruction files the adapters install
 */
export function draftRulebook(answers, adapters, installed = []) {
  const lockedPaths = [...new Set(adapters.flatMap(({ proposal }) => proposal.locked))];
  const compile = answers['compile.command'] === 'none' ? 'none' : {
    command: answers['compile.command'],
    pattern: answers['compile.pattern'],
    exitCodes: answers['compile.exitCodes'],
  };
  const coverage = answers.coverage ? {
    command: answers['coverage.command'],
    output: COVERAGE_OUTPUT,
    minimum: answers['coverage.minimum'],
  } : 'none';
  const mutation = answers.mutation ? {
    command: answers['mutation.command'],
    output: answers['mutation.report'],
    timeLimitSeconds: answers['mutation.timeLimitSeconds'],
    excludePaths: [],
  } : 'none';
  const codeQuality = answers['checks.codeQuality'];
  const wrappers = answers.wrappers.map((path) => normalize(path).split(sep).join('/'));
  return {
    version: HARNESS_SCHEMA_VERSION,
    targetBranch: remoteBranchOf(answers.targetBranch),
    tests: {
      paths: { all: answers['tests.all'], acceptance: answers['tests.acceptance'], slow: answers['tests.slow'], support: answers.testSupport },
      run: {
        command: answers['testRun.command'],
        reportPaths: answers['testRun.reports'],
        tagComment: answers['testRun.tagComment'],
      },
    },
    code: { paths: answers.code, compile },
    agent: {
      lockedPaths,
      adapters: Object.fromEntries(adapters.map(({ label, proposal }) => [label, {
        checkCommand: proposal.commands.check,
        extraHooks: { check: true, acknowledged: [] },
      }])),
    },
    plans: { dir: answers['plans.dir'] },
    followUpsFile: answers.followUpsFile,
    highRisk: [
      ...answers.highRisk,
      // A wrapper decides what the referee sees of a tool's run.
      ...(wrappers.length === 0 ? [] : [{ paths: wrappers, why: 'These make a tool keep the workflow\'s contract, so they decide what a check reports. Read every change to them.' }]),
      ...(installed.length === 0 ? [] : [{ paths: installed, why: 'These tell the agent how to work here. Read every change to them.' }]),
    ],
    checks: { testQuality: { coverage, mutation }, ...(Object.keys(codeQuality).length === 0 ? {} : { codeQuality }) },
    requirementsDir: answers.requirementsDir,
  };
}

/**
 * Why `config` cannot be the project's rulebook, or null. The same parsers
 * every referee command reads it with, so a rulebook `init` writes is one
 * they accept.
 */
export function rulebookProblem(config, root, home = homedir()) {
  try {
    parseRulebook(JSON.stringify(config), root, home);
    return null;
  } catch (error) {
    return error.message;
  }
}

/**
 * Git's answer in `root`: `{ ok: true, out }`, or `{ ok: false, error }`
 * when it exits non-zero. Here a failure is often an ordinary answer: no
 * repository yet, a path git does not ignore, a remote it does not know.
 */
const git = (root, args) => {
  try {
    return { ok: true, out: gitText(args, { cwd: root }) };
  } catch (error) {
    return { ok: false, error: String(error.stderr ?? error.message).trim() };
  }
};

/** Whether `root` is a repository's root: `true`, `false` for no repository, or the root it sits inside. */
export function repositoryOf(root) {
  const run = git(root, ['rev-parse', '--show-toplevel']);
  if (!run.ok) return false;
  const top = run.out.trim();
  return real(top) === real(root) ? true : top;
}

/** The workflow's part of a shared file, between its marker lines. */
const sharedPart = (text) => `${BEGIN}\n${text.trimEnd()}\n${END}\n`;

/**
 * Writes one file only if it is missing. Returns what was done, as a line
 * for the report.
 */
function writeMissing(root, path, text) {
  const where = join(root, path);
  if (existsSync(where)) return `kept ${path}, which exists`;
  mkdirSync(dirname(where), { recursive: true });
  writeFileSync(where, text);
  return `wrote ${path}`;
}

/**
 * A shared file: written when missing, its workflow part appended when not.
 * The part sits between its marker lines either way, so a later run finds it
 * and adds nothing.
 */
function writeShared(root, path, text) {
  const where = join(root, path);
  if (!existsSync(where)) {
    mkdirSync(dirname(where), { recursive: true });
    writeFileSync(where, sharedPart(text));
    return `wrote ${path}`;
  }
  const existing = readFileSync(where, 'utf8');
  if (existing.includes(BEGIN)) return `kept ${path}, which already has the workflow's part`;
  writeFileSync(where, `${existing.trimEnd()}\n\n${sharedPart(text)}`);
  return `added the workflow's part to ${path}, between its marker lines`;
}

/**
 * `.gitignore` gets `/.katatay/local/`, unless git already ignores that
 * folder or the file already says something about it, such as a `!` line
 * that keeps it tracked. The project's own policy wins.
 */
export function ignoreSnapshots(root) {
  const probe = git(root, ['check-ignore', '-q', '--no-index', `${STATE_FOLDER}/local/snapshot`]);
  if (probe.ok) return `kept .gitignore: ${IGNORED} is already ignored`;
  const where = join(root, '.gitignore');
  const existing = existsSync(where) ? readFileSync(where, 'utf8') : '';
  if (new RegExp(`(^|\\n)\\s*!?/?${STATE_FOLDER_PATTERN}/local\\b`).test(existing)) return `kept .gitignore: it already decides about ${STATE_FOLDER}/local/`;
  const lead = existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`;
  writeFileSync(where, `${lead}${lead === '' ? '' : '\n'}# Local snapshots the workflow's committed events point at\n${IGNORED}\n`);
  return existing === '' ? `wrote .gitignore, which ignores ${IGNORED}` : `added ${IGNORED} to .gitignore`;
}

/**
 * The sentence the installed instructions get when the harness lives outside
 * the project, saying how `workflow` is started there. Null when the harness
 * sits inside it: that project's own instructions say how, as they do in the
 * repository the harness is built in.
 */
export function startedAs(root, workflow = WORKFLOW) {
  if (packaged) return 'In this project, run workflow commands with `ktty`. For example, run `ktty verify`. The Schema line of `ktty version` is the rulebook version.';
  const inside = relative(real(root), real(workflow));
  if (!inside.startsWith('..') && !isAbsolute(inside)) return null;
  return `In this project, \`workflow\` is started as \`node ${/\s/.test(workflow) ? JSON.stringify(workflow) : workflow}\`.`;
}

/** The path is already relative and contains no parent segments. Inspect
 * each component before descending so even a link to a local file is seen. */
function wrapperProblem(root, path) {
  const parts = path.split(sep === '/' ? '/' : /[\\/]/);
  let at = root;
  for (const [index, part] of parts.entries()) {
    const last = index === parts.length - 1;
    if (part === '' || part === '.') {
      if (last) break;
      continue;
    }
    at = join(at, part);
    const stat = lstatSync(at, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) return `"wrappers" names ${path}, but ${relative(root, at)} is a symbolic link`;
    if (last && stat?.isFile()) return null;
    if (!stat?.isDirectory()) break;
  }
  return `"wrappers" names ${path}, which is not a file in the project`;
}

/** The program that runs a rulebook's commands and reads what they produce. */
export const PROBE = join(HERE, '..', 'evidence', 'probe.ts');

/**
 * Asks the probe about the project at `root`: `{ items }`, `{ refused }` when
 * the state asked for cannot be probed, or `{ problem }` when the program
 * gave no answer.
 *
 * The probe is a program of its own because it reads the test run with the
 * referee's TypeScript, which this file cannot load. Its stderr carries the
 * project's own test and tool output, which is dropped unless the program
 * itself failed: each item already says why it did not pass.
 *
 * @param {{ root: string, config?: object, expect?: string | null, scratchModule?: string }} asked
 *   `config` is a drafted rulebook; without it the project's own is read
 * @returns {{ items: { name: string, passed: boolean, lines: string[] }[], refused?: string } | { problem: string }}
 */
export function startProbe({ root, config, expect = null, scratchModule }, start = runReferee) {
  const run = start(PROBE, [], {
    cwd: root, input: JSON.stringify({ root, config, expect, scratchModule }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024,
  });
  const failed = (why) => {
    const said = errorLines(run.stderr);
    return { problem: `the probe gave no answer: ${why}.${said ? `\n${said}` : ''}` };
  };
  if (run.error) return failed(`it could not be started (${run.error.message})`);
  if (run.status !== 0) return failed(run.status === null ? `it was stopped by ${run.signal}` : `it exited with ${run.status}`);
  try {
    const answer = JSON.parse(run.stdout);
    if (!Array.isArray(answer?.items)) return failed('its answer holds no "items"');
    return answer;
  } catch (error) {
    return failed(`its answer is not JSON (${error.message})`);
  }
}

/** The probe's items as lines: each item's result and first line, then the rest indented. */
export const probeLines = (items) => items.flatMap(({ name, passed, lines }) => [
  `${passed ? 'passed' : 'FAILED'} — ${name}${lines.length > 0 ? `: ${lines[0]}` : ''}`,
  ...lines.slice(1).flatMap((line) => line.split('\n')).map((line) => `    ${line}`),
]);

/**
 * Sets up the project at `root`.
 *
 * A rulebook `init` drafts is written only after the probe has run its
 * commands and every one passed. A rulebook the project already has is not
 * probed: `init` did not draft it and does not write it.
 *
 * With `probeOnly`, the probe is all that happens, on the draft or on the
 * project's own rulebook, and nothing is written: `{ ok, probed }`, the
 * items as lines. `expect` names the one break the probe must see.
 *
 * @param {{
 *   root: string,
 *   adapters: { label: string, command: string }[],
 *   given?: Record<string, unknown>,
 *   ask?: ((question: object) => Promise<string>) | null,
 *   say?: (line: string) => void,
 *   home?: string,
 *   scratchModule?: string,
 * }} options
 * @returns {Promise<{ ok: true, lines: string[], steps: string[] } | { ok: false, problems: string[] }>}
 */
export async function init({ root, adapters, given = {}, ask = null, say = () => {}, home = homedir(), probe = startProbe, probeOnly = false, expect = null, scratchModule }) {
  if (adapters.length === 0) return { ok: false, problems: ['name at least one agent adapter, so the project is guarded'] };
  if (!existsSync(root)) return { ok: false, problems: [`${root} does not exist`] };
  const repository = repositoryOf(root);
  if (typeof repository === 'string') {
    return { ok: false, problems: [`${root} is inside the repository at ${repository}. Run init at the repository's root`] };
  }

  // Every agent's proposal first: the plans folder's default comes from them.
  const proposals = [];
  for (const { label, command } of adapters) {
    const asked = agentDefaults(command, root);
    if ('none' in asked) return { ok: false, problems: [`${label}: ${asked.none}`] };
    proposals.push({ label, proposal: asked.proposal });
  }
  const plansFolders = [...new Set(proposals.map(({ proposal }) => proposal.plansFolder))];

  const rulebookFile = join(root, CONFIG);
  const existing = existsSync(rulebookFile);
  let config;
  let plansFolder;
  if (existing) {
    try {
      config = parseRulebook(readFileSync(rulebookFile, 'utf8'), root, home);
      plansFolder = parsePlansDir(config);
    } catch (error) {
      return { ok: false, problems: [`the project has a ${CONFIG} that cannot be read: ${error.message}`] };
    }
  } else {
    const gathered = await gatherAnswers(given, ask, { plansFolder: plansFolders[0] }, say);
    if ('problems' in gathered) return { ok: false, problems: gathered.problems };
    // Glue that makes a tool keep the contract is the project's own code,
    // committed with it. A wrapper anywhere else is missing from every other
    // clone, and nobody reviewing the project can read it.
    const outside = gathered.answers.wrappers.filter((path) => isAbsolute(path) || path.split(/[\\/]/).includes('..'));
    if (outside.length > 0) {
      return { ok: false, problems: outside.map((path) => `"wrappers" names ${path}, which is not a path inside the project. A wrapper is kept in the project's own repository, so write it there and name it from the project's root`) };
    }
    const problems = gathered.answers.wrappers.map((path) => wrapperProblem(root, path)).filter(Boolean);
    if (problems.length > 0) return { ok: false, problems };
    plansFolder = gathered.answers['plans.dir'];
    config = { answers: gathered.answers };
  }

  // Each adapter's files, asked before anything is written.
  const startLine = startedAs(root);
  const base = installRequest();
  const request = { ...base, instructions: startLine === null ? base.instructions : `${base.instructions.trimEnd()}\n\n${startLine}\n`, plansFolder };
  const installs = [];
  for (const { label, proposal } of proposals) {
    // The install command is the adapter's to name, in its defaults.
    if (typeof proposal.commands.install !== 'string') return { ok: false, problems: [`${label}: its defaults name no "commands.install", so nothing can be installed for it`] };
    const asked = agentInstall(proposal.commands.install, request, {
      root, home, locked: proposal.locked, registrationFile: proposal.registration.file,
    });
    installs.push({ label, proposal, asked });
  }
  for (const { label, asked } of installs) if ('none' in asked) return { ok: false, problems: [`${label}: ${asked.none}`] };

  if (!existing) {
    const installed = installs.flatMap(({ asked }) => asked.files.map(({ path }) => path));
    config = draftRulebook(config.answers, proposals, installed);
    const problem = rulebookProblem(config, root, home);
    if (problem !== null) return { ok: false, problems: [problem] };
  }

  // The commands, run before anything is written. Every refusal above comes
  // first, so a bad answer never costs a run of the test suite.
  const proved = [];
  if (!existing || probeOnly) {
    if (repository === false) {
      return { ok: false, problems: [`${root} is not a git repository, so its commands cannot be proved: the probe tells the project's files from ignored output by asking git. Run \`git init\` there first`] };
    }
    const asked = probe({ root, ...(existing ? {} : { config }), expect, scratchModule });
    if ('problem' in asked) return { ok: false, problems: [asked.problem] };
    if (asked.refused !== undefined) return { ok: false, refused: true, problems: [asked.refused] };
    const passed = asked.items.every((item) => item.passed);
    if (probeOnly) return { ok: passed, probed: probeLines(asked.items) };
    if (!passed) return { ok: false, problems: [`a command does not keep the workflow's contract:\n${probeLines(asked.items).join('\n')}`] };
    proved.push(...probeLines(asked.items));
  }

  const lines = [...proved];
  if (repository === false) {
    const run = git(root, ['init', '--quiet']);
    if (!run.ok) return { ok: false, problems: [`git init failed: ${run.error}`] };
    lines.push('started a git repository');
  } else {
    lines.push('kept the git repository');
  }
  lines.push(existing ? `kept ${CONFIG}, which exists` : writeMissing(root, CONFIG, `${JSON.stringify(config, null, 2)}\n`));

  const folder = parseRequirementsDir(config);
  lines.push(writeMissing(root, `${folder}/README.md`, readFileSync(join(CATALOGUE, 'README.md'), 'utf8')));
  lines.push(writeMissing(root, `${folder}/changes/TEMPLATE.md`, readFileSync(join(CATALOGUE, 'TEMPLATE.md'), 'utf8')));
  lines.push(ignoreSnapshots(root));

  const steps = [`Review ${CONFIG}. Only the operator may change it.`];
  for (const { label, proposal, asked } of installs) {
    for (const file of asked.files) lines.push(`${label}: ${(file.shared ? writeShared : writeMissing)(root, file.path, file.text)}`);
    const where = join(root, asked.registration.path);
    const before = existsSync(where) ? readFileSync(where, 'utf8') : null;
    if (before === asked.registration.text) {
      lines.push(`${label}: kept ${asked.registration.path}, which already registers the workflow's hooks`);
    } else {
      mkdirSync(dirname(where), { recursive: true });
      writeFileSync(where, asked.registration.text);
      lines.push(`${label}: ${before === null ? 'wrote' : 'merged the workflow\'s hooks into'} ${asked.registration.path}`);
    }
    steps.push(...proposal.registration.steps.map((step) => `${label}: ${step}`));
  }
  if (plansFolders.length > 1) {
    lines.push(`note: the agents proposed different plans folders (${plansFolders.join(', ')}); the rulebook names ${plansFolder}`);
  }
  const target = parseTargetBranch(config);
  if (!git(root, ['remote', 'get-url', target.remote]).ok) {
    steps.push(`Add the remote ${target.remote} (git remote add ${target.remote} <url>). The workflow measures every change from ${target.name}, and refuses to run until git knows it.`);
  }
  steps.push(`Commit these files and push them to ${target.name}, so the first change has a baseline to be measured from.`);
  return { ok: true, lines, steps };
}
