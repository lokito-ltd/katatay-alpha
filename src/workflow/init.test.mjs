/**
 * `init`, in process: its questions, how answers are gathered from a person
 * or an agent, the rulebook they make, and what it writes into a folder.
 * The agent adapters are the real ones, started as `init` starts them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gitText } from './git.mjs';
import {
  BEGIN, END, IGNORED, PROBE, WORKFLOW, draftRulebook, gatherAnswers, ignoreSnapshots, init, probeLines, questions, questionsJson,
  repositoryOf, rulebookProblem, startProbe, startedAs,
} from './init.mjs';
import { CONFIG, highRiskAreas, parseRulebook, readConfig } from './rulebook.mjs';
import { HARNESS_SCHEMA_VERSION } from '../schema-version.mjs';

const adapter = (label) => ({ label, command: `node ${JSON.stringify(resolve(`src/agents/${label}/defaults.mjs`))}` });
const BOTH = [adapter('claude'), adapter('codex')];

/** The answers a small Go project gives, the required ones and a few more. */
const ANSWERS = {
  'tests.all': ['**/*_test.go'],
  'tests.acceptance': ['acceptance/**'],
  code: ['**/*.go'],
  'testRun.command': 'gotestsum --junitfile reports/junit/go.xml ./...',
  'testRun.reports': ['reports/junit/*.xml'],
  'testRun.tagComment': '^\\s*//',
};

let root;
let home;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-init-')));
  home = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-init-home-')));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/** A probe that found every command keeping the contract, and records what it was asked. */
function passing() {
  const asked = [];
  const probe = (request) => {
    asked.push(request);
    return { items: [{ name: 'tests', passed: true, lines: ['1 test(s) in 1 file(s), all passing'] }] };
  };
  return { probe, asked };
}

// The real probe runs the project's commands, and these folders have none
// that run. `src/evidence/probe.test.ts` tests it, and the process test
// starts it. Here it is a fake unless a test passes its own.
const run = (options = {}) => init({ root, adapters: BOTH, given: ANSWERS, home, probe: passing().probe, ...options });
const read = (path) => readFileSync(join(root, path), 'utf8');
const gitInit = (where = root) => gitText(['init', '--quiet'], { cwd: where });

/** An `ask` that replies with each of `replies` in turn, and records what it was asked. */
function scripted(replies) {
  const asked = [];
  const ask = async (question) => {
    asked.push(question.id);
    if (replies.length === 0) throw new Error(`asked ${question.id} with no reply left`);
    return replies.shift();
  };
  return { ask, asked };
}

describe('the questions', () => {
  it('are asked in a fixed order, the plans folder defaulting to what the agent proposed', () => {
    const list = questions({ plansFolder: '~/.claude/plans' });
    expect(list.map(({ id }) => id).slice(0, 4)).toEqual(['targetBranch', 'tests.all', 'tests.acceptance', 'tests.slow']);
    expect(list.find(({ id }) => id === 'plans.dir').default).toBe('~/.claude/plans');
    expect(questions().find(({ id }) => id === 'plans.dir').default).toBe('~/.katatay/plans');
  });

  it('are printed for an agent with what each answer is, its default or that it is required, and when it is asked', () => {
    const { about, questions: listed } = questionsJson();
    expect(about).toContain('send the answers as one JSON object keyed by id');
    expect(listed.find(({ id }) => id === 'targetBranch')).toEqual({ id: 'targetBranch', ask: expect.any(String), answer: 'text', default: 'main' });
    expect(listed.find(({ id }) => id === 'tests.all')).toMatchObject({ answer: 'a list of strings', required: true });
    expect(listed.find(({ id }) => id === 'compile.exitCodes').ask).toContain('0=clean, 1-255=errors');
    expect(listed.find(({ id }) => id === 'coverage.command')).toMatchObject({ required: true, when: 'asked when coverage is measured' });
  });
});

describe('gathering the answers', () => {
  it('takes every default when there is no terminal, and leaves out what an earlier answer makes meaningless', async () => {
    const { answers } = await gatherAnswers(ANSWERS, null, { plansFolder: '~/p' });
    expect(answers).toMatchObject({ targetBranch: 'main', 'tests.slow': [], testSupport: [], 'compile.command': 'none',
      'plans.dir': '~/p', 'followUpsFile': 'FOLLOW-UPS.md', 'requirementsDir': 'requirements', highRisk: [], coverage: false, mutation: false });
    expect(answers).not.toHaveProperty('compile.pattern');
    expect(answers).not.toHaveProperty('coverage.command');
    expect(answers).not.toHaveProperty('coverage.minimum');
    expect(answers).not.toHaveProperty('mutation.command');
  });

  it('names every required answer missing with no terminal, and every unknown or misshapen one', async () => {
    const { problems } = await gatherAnswers({ 'tests.all': 'x', nonsense: 1, coverage: true }, null);
    expect(problems).toContain('"nonsense" is not one of init\'s questions');
    expect(problems).toContain('"tests.all" must be a list of strings');
    expect(problems.some((problem) => problem.startsWith('"tests.acceptance" has no answer: '))).toBe(true);
    expect(problems.some((problem) => problem.startsWith('"coverage.command" has no answer: '))).toBe(true);
  });

  it('asks in a terminal only what was not given, and Enter takes the default', async () => {
    const given = { ...ANSWERS };
    delete given['testRun.tagComment'];
    const { ask, asked } = scripted([
      '', // target
      '', // tests.slow
      '', // testSupport
      '//', // testRun.tagComment
      '', // compile.command
      '', // plans.dir
      '', // followUpsFile
      '', // requirementsDir
      '', // highRisk: an empty line ends the list
      'no', // coverage
      'no', // mutation
      '', // checks.codeQuality: an empty line ends the list
      '', // wrappers
    ]);
    const { answers } = await gatherAnswers(given, ask, { plansFolder: '~/p' });
    expect(asked).toEqual(['targetBranch', 'tests.slow', 'testSupport', 'testRun.tagComment', 'compile.command',
      'plans.dir', 'followUpsFile', 'requirementsDir', 'highRisk', 'coverage', 'mutation', 'checks.codeQuality', 'wrappers']);
    expect(answers).toMatchObject({ targetBranch: 'main', 'testRun.tagComment': '//', 'plans.dir': '~/p', highRisk: [], coverage: false,
      'checks.codeQuality': {}, wrappers: [] });
  });

  it('reads lists, yes or no, exit codes, areas and folder minimums from what is typed', async () => {
    const given = { ...ANSWERS };
    const { ask } = scripted([
      'release', 'e2e/**, perf/**', '', 'go vet ./...', '^(?<file>[^:]+):(?<line>\\d+): (?<message>.*)$', '0=clean, 1=errors, 2=broken',
      '', '', '', 'go.mod, go.sum | Dependencies.', '', 'yes', 'cat cover.lcov', 'src/ 80 70', 'cmd/ 50 0', '', 'y', 'gremlins', 'mutation.json', '120',
      'lint | make lint | 0=clean, 1-255=findings', 'build | make | 0=clean, 2=findings', '', 'tools/report.py, tools/mutate.sh',
    ]);
    const { answers } = await gatherAnswers(given, ask, {});
    expect(answers).toMatchObject({
      targetBranch: 'release', 'tests.slow': ['e2e/**', 'perf/**'], 'compile.exitCodes': { 0: 'clean', 1: 'errors', 2: 'broken' },
      highRisk: [{ paths: ['go.mod', 'go.sum'], why: 'Dependencies.' }], coverage: true,
      'coverage.minimum': { 'src/': { lines: 80, branches: 70 }, 'cmd/': { lines: 50, branches: 0 } }, mutation: true, 'mutation.timeLimitSeconds': 120,
      'checks.codeQuality': {
        lint: { command: 'make lint', exitCodes: { 0: 'clean', '1-255': 'findings' } },
        build: { command: 'make', exitCodes: { 0: 'clean', 2: 'findings' } },
      },
      wrappers: ['tools/report.py', 'tools/mutate.sh'],
    });
  });

  it('asks again after a reply it cannot read, and says why', async () => {
    const said = [];
    const { ask } = scripted(['', '', '', '', '', '', '', '', 'maybe', 'no', 'no', '', '']);
    const { answers } = await gatherAnswers(ANSWERS, ask, {}, (line) => said.push(line));
    expect(answers.coverage).toBe(false);
    expect(said).toEqual(['Answer yes or no.']);
  });

  it('asks again when a required question gets an empty reply, and refuses a bad area or minimum line', async () => {
    const said = [];
    const given = { ...ANSWERS };
    delete given.code;
    const { ask } = scripted([
      '', '', '', // target, tests.slow, testSupport
      '', '**/*.go', // code: required, so an empty reply is asked again
      '', '', '', '', // compile.command, plans.dir, followUpsFile, requirementsDir
      'no bar here', '', // highRisk: a line it cannot read, then the end of the list
      'yes', 'cat x', // coverage, coverage.command
      'src', 'src/ 1 0', '', // coverage.minimum: a line it cannot read, one it can, the end
      'no', // mutation
      'lint', 'lint | make lint | 0', '', // checks.codeQuality: two lines it cannot read, then the end of the list
      '', // wrappers
    ]);
    const { answers } = await gatherAnswers(given, ask, {}, (line) => said.push(line));
    expect(answers.code).toEqual(['**/*.go']);
    expect(answers['checks.codeQuality']).toEqual({});
    expect(said[3]).toMatch(/^Answer the check's name, then \| and its command/);
    expect(said[4]).toMatch(/^Answer exit codes as code=meaning/);
    expect(answers.highRisk).toEqual([]);
    expect(answers['coverage.minimum']).toEqual({ 'src/': { lines: 1, branches: 0 } });
    expect(said[0]).toBe('An answer is needed.');
    expect(said[1]).toMatch(/^Answer the paths, separated by commas/);
    expect(said[2]).toMatch(/^Supply the lines and branches minimums/);
  });
});

describe('the rulebook the answers make', () => {
  const proposals = [
    { label: 'one', proposal: { locked: ['.one/**', '~/.shared'], commands: { check: 'node one.mjs', install: 'node i.mjs' } } },
    { label: 'two', proposal: { locked: ['.two/**', '~/.shared'], commands: { check: 'node two.mjs' } } },
  ];

  it('holds the answers and each agent\'s locks and check, and passes the parsers every command uses', async () => {
    const { answers } = await gatherAnswers(ANSWERS, null, { plansFolder: '~/plans' });
    const config = draftRulebook(answers, proposals, ['AGENT.md']);
    expect(config.targetBranch).toBe('origin/main');
    expect(config.code.compile).toBe('none');
    expect(config.code.paths).toEqual(answers.code);
    expect(config.tests.paths.support).toEqual(answers.testSupport);
    expect(config.tests.run).toEqual({ command: answers['testRun.command'], reportPaths: answers['testRun.reports'], tagComment: answers['testRun.tagComment'] });
    expect(questions().map(question => question.id)).not.toContain('testRun.reporter');
    expect(config.agent.lockedPaths).toEqual(['.one/**', '~/.shared', '.two/**']);
    expect(config.agent.adapters).toEqual({
      one: { checkCommand: 'node one.mjs', extraHooks: { check: true, acknowledged: [] } },
      two: { checkCommand: 'node two.mjs', extraHooks: { check: true, acknowledged: [] } },
    });
    expect(config.highRisk).toEqual([{ paths: ['AGENT.md'], why: expect.any(String) }]);
    expect(config.checks).toEqual({ testQuality: { coverage: 'none', mutation: 'none' } });
    expect(rulebookProblem(config, root, home)).toBeNull();
  });

  it('switches coverage and mutation on with their commands, and keeps a target that names its remote', async () => {
    const { answers } = await gatherAnswers({ ...ANSWERS, targetBranch: 'upstream/trunk', 'compile.command': 'go vet ./...', 'compile.pattern': '(?<file>x)(?<message>y)',
      coverage: true, 'coverage.command': 'cat c.lcov', 'coverage.minimum': { 'src/': { lines: 1, branches: 0 } },
      mutation: true, 'mutation.command': 'gremlins', 'mutation.report': 'reports/mutation.json' }, null);
    const config = draftRulebook(answers, proposals);
    expect(config.targetBranch).toBe('upstream/trunk');
    expect(config.code.compile).toEqual({ command: 'go vet ./...', pattern: '(?<file>x)(?<message>y)', exitCodes: { 0: 'clean', 1: 'errors' } });
    expect(config.checks.testQuality.coverage).toEqual({ command: 'cat c.lcov', output: 'reports/checks/coverage.json', minimum: { 'src/': { lines: 1, branches: 0 } } });
    expect(config.checks.testQuality.mutation).toEqual({ command: 'gremlins', output: 'reports/mutation.json', timeLimitSeconds: 300, excludePaths: [] });
    expect(config.highRisk).toEqual([]);
    expect(rulebookProblem(config, root, home)).toBeNull();
  });

  it('is refused with the parser\'s own sentence', async () => {
    const { answers } = await gatherAnswers({ ...ANSWERS, 'testRun.reports': ['*.xml'] }, null);
    expect(rulebookProblem(draftRulebook(answers, proposals), root, home)).toContain('"tests.run.reportPaths" holds "*.xml", which starts with a wildcard');
  });
});

describe('the folder', () => {
  it('is a repository\'s root, no repository, or inside another one', () => {
    expect(repositoryOf(root)).toBe(false);
    gitInit();
    expect(repositoryOf(root)).toBe(true);
    mkdirSync(join(root, 'sub'));
    expect(realpathSync(repositoryOf(join(root, 'sub')))).toBe(root);
  });

  it('gets the snapshots ignored, unless git already ignores them or the project says otherwise', () => {
    gitInit();
    expect(ignoreSnapshots(root)).toBe(`wrote .gitignore, which ignores ${IGNORED}`);
    expect(read('.gitignore')).toBe(`# Local snapshots the workflow's committed events point at\n${IGNORED}\n`);
    expect(ignoreSnapshots(root)).toBe(`kept .gitignore: ${IGNORED} is already ignored`);
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
    expect(ignoreSnapshots(root)).toBe(`added ${IGNORED} to .gitignore`);
    expect(read('.gitignore')).toBe(`node_modules/\n\n# Local snapshots the workflow's committed events point at\n${IGNORED}\n`);
    writeFileSync(join(root, '.gitignore'), 'node_modules/');
    expect(ignoreSnapshots(root)).toBe(`added ${IGNORED} to .gitignore`);
    expect(read('.gitignore')).toBe(`node_modules/\n\n# Local snapshots the workflow's committed events point at\n${IGNORED}\n`);
    writeFileSync(join(root, '.gitignore'), '!/.katatay/local/\n');
    expect(ignoreSnapshots(root)).toBe('kept .gitignore: it already decides about .katatay/local/');
  });

  it.each([
    ['an indented line', 'build/\n   !/.katatay/local/\n'],
    ['a pattern for some files in the folder, with no leading slash', '.katatay/local/*.keep\n'],
  ])('leaves .gitignore alone when %s already mentions the folder', (_, text) => {
    gitInit();
    writeFileSync(join(root, '.gitignore'), text);
    expect(ignoreSnapshots(root)).toBe('kept .gitignore: it already decides about .katatay/local/');
    expect(read('.gitignore')).toBe(text);
  });

  it('is told how workflow is started only when the harness lives outside it', () => {
    expect(startedAs(root)).toBe(`In this project, \`workflow\` is started as \`node ${WORKFLOW}\`.`);
    expect(startedAs(root, join(root, 'a b', 'workflow.mjs'))).toBeNull();
    expect(startedAs(resolve('.'))).toBeNull();
    expect(startedAs(root, '/x y/workflow.mjs')).toBe('In this project, `workflow` is started as `node "/x y/workflow.mjs"`.');
  });
});

describe('setting up a folder', () => {
  it('asks again after a blank first coverage row and writes the corrected minimum', async () => {
    gitInit();
    const messages = [];
    const given = { ...ANSWERS, coverage: true, 'coverage.command': 'cat cover.lcov',
      mutation: true, 'mutation.command': 'gremlins', 'mutation.report': 'reports/mutation.json',
      'mutation.timeLimitSeconds': 120 };
    const minimum = scripted(['', 'src/ 75 0', '']);
    const ask = question => question.id === 'coverage.minimum' ? minimum.ask(question) : '';
    const result = await run({ given, ask, say: line => messages.push(line) });
    expect(result.ok).toBe(true);
    expect(minimum.asked).toHaveLength(3);
    expect(messages).toContainEqual(expect.stringMatching(/at least one folder.*lines.*branches/i));
    const config = readConfig(root);
    expect(config.requirementsDir).toBe('requirements');
    expect(config.checks.testQuality.coverage.minimum).toEqual({ 'src/': { lines: 75, branches: 0 } });
    expect(config.checks.testQuality.mutation.timeLimitSeconds).toBe(120);
  });

  it('proves the commands, then writes the rulebook, the requirements folder and each agent\'s files and hooks, and lists the operator\'s steps', async () => {
    gitInit();
    const { probe, asked } = passing();
    const result = await run({ probe, given: { ...ANSWERS,
      coverage: true, 'coverage.command': 'cat c.lcov', 'coverage.minimum': { 'src/': { lines: 85, branches: 75 } },
      mutation: true, 'mutation.command': 'gremlins', 'mutation.report': 'reports/custom-mutants.json',
    } });
    expect(result.ok).toBe(true);
    expect(result.lines.slice(0, 6)).toEqual(['passed — tests: 1 test(s) in 1 file(s), all passing', 'kept the git repository', `wrote ${CONFIG}`,
      'wrote requirements/README.md', 'wrote requirements/changes/TEMPLATE.md', `wrote .gitignore, which ignores ${IGNORED}`]);
    // The probe was asked about the draft, which is the rulebook then written.
    expect(asked).toEqual([{ root, config: JSON.parse(read(CONFIG)), expect: null }]);
    expect(result.lines).toContain('claude: wrote .claude/settings.json');
    expect(result.lines).toContain('codex: wrote .codex/hooks.json');
    expect(result.lines).toContain('codex: wrote AGENTS.md');
    expect(result.lines).toContain('note: the agents proposed different plans folders (~/.claude/plans, ~/.codex/plans); the rulebook names ~/.claude/plans');
    expect(result.steps[0]).toBe(`Review ${CONFIG}. Only the operator may change it.`);
    expect(result.steps.at(-2)).toContain('Add the remote origin');
    expect(result.steps.at(-1)).toContain('push them to origin/main');

    const config = readConfig(root);
    expect(config.checks.testQuality.coverage.output).toBe('reports/checks/coverage.json');
    expect(config.version).toBe(HARNESS_SCHEMA_VERSION);
    expect(config.checks.testQuality.mutation.output).toBe('reports/custom-mutants.json');
    expect(config.plans.dir).toBe('~/.claude/plans');
    expect(Object.keys(config.agent.adapters)).toEqual(['claude', 'codex']);
    expect(config.highRisk[0].paths).toContain('AGENTS.md');
    expect(read('AGENTS.md').startsWith(`${BEGIN}\n`)).toBe(true);
    expect(read('AGENTS.md').endsWith(`\n${END}\n`)).toBe(true);
    expect(read('AGENTS.md').endsWith(`\n\n${END}\n`)).toBe(false);
    expect(read('.claude/rules/workflow.md')).toContain(`is started as \`node ${WORKFLOW}\``);
    expect(read('.claude/settings.json')).toContain(resolve('src/agents/claude/hooks/pre-tool.mjs'));
    expect(read('requirements/changes/TEMPLATE.md')).toContain('## Departures');
  });

  it.each(['typed', 'supplied'])('writes %s compile ranges as entered', async (source) => {
    const given = { ...ANSWERS, 'compile.command': 'go vet ./...', 'compile.pattern': '(?<file>x)(?<message>y)' };
    const codes = { 0: 'clean', '1-255': 'errors' };
    const input = source === 'typed' ? { given, ask: replying({ 'compile.exitCodes': ['0=clean, 1-255=errors'] }) }
      : { given: { ...given, 'compile.exitCodes': codes } };
    gitInit();
    expect((await run({ ...input, adapters: [adapter('codex')] })).ok).toBe(true);
    expect(parseRulebook(read(CONFIG)).code.compile.exitCodes).toEqual(codes);
  });

  it('refuses overlapping ranges supplied in answers before writing a rulebook', async () => {
    const given = { ...ANSWERS, 'compile.command': 'go vet ./...', 'compile.pattern': '(?<file>x)(?<message>y)',
      'compile.exitCodes': { 0: 'clean', '1-255': 'errors', 255: 'broken' } };
    const result = await run({ given, adapters: [adapter('codex')] });
    expect(result.problems).toEqual([expect.stringContaining('names exit 255 twice')]);
    expect(existsSync(join(root, CONFIG))).toBe(false);
  });

  it('changes nothing when run again', async () => {
    // One adapter: each run of both takes over half a second.
    const claude = { adapters: [adapter('claude')] };
    gitInit();
    await run(claude);
    const before = readdirSync(root, { recursive: true }).filter((path) => !String(path).startsWith('.git/')).sort();
    const again = await run(claude);
    expect(again.ok).toBe(true);
    expect(again.lines.filter((line) => /\b(wrote|merged|added|started)\b/.test(line))).toEqual([]);
    expect(again.lines).toContain('claude: kept .claude/rules/workflow.md, which exists');
    expect(again.lines).toContain('claude: kept .claude/settings.json, which already registers the workflow\'s hooks');
    expect(readdirSync(root, { recursive: true }).filter((path) => !String(path).startsWith('.git/')).sort()).toEqual(before);
  });

  it('keeps what an existing project has, and adds the workflow\'s part to its shared file and its hooks', async () => {
    gitInit();
    writeFileSync(join(root, 'AGENTS.md'), '# Our rules\n');
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ model: 'x' }));
    writeFileSync(join(root, '.claude', 'rules.md'), 'ours');
    const result = await run();
    expect(result.lines).toContain('kept the git repository');
    expect(result.lines).toContain('codex: added the workflow\'s part to AGENTS.md, between its marker lines');
    expect(result.lines).toContain('claude: merged the workflow\'s hooks into .claude/settings.json');
    expect(read('AGENTS.md').startsWith(`# Our rules\n\n${BEGIN}\n`)).toBe(true);
    expect(JSON.parse(read('.claude/settings.json')).model).toBe('x');
    expect((await run({ adapters: [adapter('codex')] })).lines).toContain('codex: kept AGENTS.md, which already has the workflow\'s part');
  });

  it.each([
    [{ branches: 0 }, 'lines'],
    [{ lines: 0 }, 'branches'],
  ])('refuses JSON coverage floors missing %j before writing any file', async (floors, missing) => {
    const result = await run({ given: { ...ANSWERS, coverage: true, 'coverage.command': 'cat cover.lcov',
      'coverage.minimum': { 'src/': floors } } });
    expect(result.ok).toBe(false);
    expect(result.problems).toContainEqual(expect.stringContaining(`the ${missing} minimum`));
    expect(readdirSync(root)).toEqual([]);
  });

  it('uses a rulebook the project already has, and neither asks nor probes', async () => {
    const claude = { adapters: [adapter('claude')] };
    gitInit();
    await run(claude);
    rmSync(join(root, 'requirements'), { recursive: true });
    const result = await run({ ...claude, given: {}, ask: async () => { throw new Error('asked'); }, probe: () => { throw new Error('probed'); } });
    expect(result.ok).toBe(true);
    expect(result.lines).toContain(`kept ${CONFIG}, which exists`);
    expect(result.lines).toContain('wrote requirements/README.md');
  });

  it('refuses an existing rulebook without an agent section before installing files', async () => {
    mkdirSync(join(root, '.katatay'));
    const original = JSON.stringify({ version: 1, plans: { dir: 'plans' } });
    writeFileSync(join(root, CONFIG), original);
    const result = await run({ adapters: [adapter('codex')] });
    expect(result.problems).toEqual([expect.stringContaining('"agent": { "lockedPaths": [], "adapters": { "local": { "checkCommand": "node check.mjs" } } }')]);
    expect(read(CONFIG)).toBe(original);
    expect(readdirSync(root)).toEqual(['.katatay']);
  });

  it('refuses a rulebook it cannot read, and writes nothing', async () => {
    mkdirSync(join(root, '.katatay'));
    writeFileSync(join(root, CONFIG), '{ nope');
    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain(`the project has a ${CONFIG} that cannot be read`);
    expect(readdirSync(root)).toEqual(['.katatay']);
  });

  it.each([
    ['no agent adapter', { adapters: [] }, 'name at least one agent adapter'],
    ['answers that are missing', { given: {} }, '"tests.all" has no answer'],
    ['an answer the parsers refuse', { given: { ...ANSWERS, 'testRun.reports': ['*.xml'] } }, 'starts with a wildcard'],
    ['an adapter that gives no defaults', { adapters: [{ label: 'broken', command: 'exit 3' }] }, 'broken: the agent\'s defaults (`exit 3`) gave no answer'],
  ])('writes nothing for %s', async (_, options, problem) => {
    const result = await run(options);
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain(problem);
    expect(readdirSync(root)).toEqual([]);
  });

  it('writes nothing for a folder that does not exist, or one inside another repository', async () => {
    const missing = await run({ root: join(root, 'missing') });
    expect(missing.ok).toBe(false);
    expect(missing.problems[0]).toContain('does not exist');
    gitInit();
    mkdirSync(join(root, 'sub'));
    const inside = await run({ root: join(root, 'sub') });
    expect(inside.ok).toBe(false);
    expect(inside.problems[0]).toContain('Run init at the repository\'s root');
    expect(readdirSync(join(root, 'sub'))).toEqual([]);
  });

  it('writes nothing when an adapter names no install command, or its install gives no answer', async () => {
    const proposal = { version: 1, locked: [], plansFolder: '~/p', instructions: 'A.md', commands: { check: 'node c.mjs' }, registration: { file: 'h.json', text: '', steps: [] } };
    writeFileSync(join(home, 'defaults.mjs'), `process.stdout.write(${JSON.stringify(JSON.stringify(proposal))});`);
    const fake = { label: 'fake', command: `node ${JSON.stringify(join(home, 'defaults.mjs'))}` };
    expect((await run({ adapters: [fake] })).problems[0]).toBe('fake: its defaults name no "commands.install", so nothing can be installed for it');
    const failing = { ...proposal, commands: { check: 'node c.mjs', install: 'exit 4' } };
    writeFileSync(join(home, 'defaults.mjs'), `process.stdout.write(${JSON.stringify(JSON.stringify(failing))});`);
    expect((await run({ adapters: [fake] })).problems[0]).toContain('fake: the agent\'s install command (`exit 4`) gave no answer');
    expect(existsSync(join(root, '.git'))).toBe(false);
  });
});

/**
 * An `ask` that replies from `replies`, a list per question id, and with an
 * empty line once a question's list runs out: Enter, or the end of a list.
 */
function replying(replies) {
  const left = Object.fromEntries(Object.entries(replies).map(([id, lines]) => [id, [...lines]]));
  return async (question) => left[question.id]?.shift() ?? '';
}

/** The answers and what was said, with `replies` typed for the questions ANSWERS leaves open. */
async function typed(replies, given = ANSWERS) {
  const said = [];
  const gathered = await gatherAnswers(given, replying(replies), {}, (line) => said.push(line));
  return { ...gathered, said };
}

describe('reading what is typed', () => {
  // The rulebook check at the end refuses an area with no paths or no reason,
  // and then every answer typed before it is lost. So the line is refused here.
  it('asks again for a high-risk line with no paths or no reason, and keeps the good one', async () => {
    const { answers, said } = await typed({ highRisk: ['| reason', 'go.mod |', 'go.mod | Dependencies.', ''] });
    expect(said).toEqual(['Answer at least one path before |.', 'Answer the reason after |.']);
    expect(answers.highRisk).toEqual([{ paths: ['go.mod'], why: 'Dependencies.' }]);
  });

  it('drops empty entries from a list', async () => {
    expect((await typed({ 'tests.slow': ['e2e/**, , perf/**,'] })).answers['tests.slow']).toEqual(['e2e/**', 'perf/**']);
  });

  it.each([['y', true], ['yes', true], ['on', true], ['true', true], ['n', false], ['no', false], ['off', false], ['false', false], ['YES', true]])(
    'reads %s as %s', async (word, value) => {
      expect((await typed({ coverage: [word], 'coverage.command': ['cat x'], 'coverage.minimum': ['src/ 1 0'] })).answers.coverage).toBe(value);
    },
  );

  it('asks again for a time limit that is not a whole number above 0', async () => {
    const { answers, said } = await typed({ mutation: ['yes'], 'mutation.command': ['m'], 'mutation.report': ['m.json'], 'mutation.timeLimitSeconds': ['abc', '0', '-5', '60'] });
    expect(answers['mutation.timeLimitSeconds']).toBe(60);
    expect(said).toEqual(['Answer a whole number above 0.', 'Answer a whole number above 0.', 'Answer a whole number above 0.']);
  });

  it('reads exit codes with spaces around them, and asks again for a pair with no code or no meaning', async () => {
    const compile = { 'compile.command': ['go vet ./...'], 'compile.pattern': ['(?<file>x)(?<message>y)'] };
    const spaced = await typed({ ...compile, 'compile.exitCodes': ['0 = clean, 1-255 = errors'] });
    expect(spaced.said).toEqual([]);
    expect(spaced.answers['compile.exitCodes']).toEqual({ 0: 'clean', '1-255': 'errors' });
    const { answers, said } = await typed({ ...compile, 'compile.exitCodes': ['0clean', '0=', '=clean', '0=clean, 1=errors'] });
    expect(answers['compile.exitCodes']).toEqual({ 0: 'clean', 1: 'errors' });
    expect(said).toHaveLength(3);
    expect(said[0]).toMatch(/^Answer exit codes as code=meaning/);
  });

  it('asks again for repeated keys, overlapping ranges or extra meanings in a typed answer', async () => {
    const given = { ...ANSWERS, 'compile.command': 'go vet ./...', 'compile.pattern': '(?<file>x)(?<message>y)' };
    const { answers, said } = await typed({ 'compile.exitCodes': [
      '0=clean, 1=errors, 1=broken', '0=clean, 1-2=errors, 2-3=errors', '0=clean, 1=errors=broken', '0=clean, 1-255=errors',
    ] }, given);
    expect(said).toEqual([expect.stringContaining('names 1 twice'), expect.stringContaining('names exit 2 twice'), expect.stringContaining('code=meaning')]);
    expect(answers['compile.exitCodes']).toEqual({ 0: 'clean', '1-255': 'errors' });
  });

  it('explains missing floors and accepts a corrected row with zero lines and branches', async () => {
    const { answers, said } = await typed({ coverage: ['yes'], 'coverage.command': ['cat x'], 'coverage.minimum': ['src/  80   70', 'cmd/ 50 0', 'lib/', 'lib/ 80', 'lib/ 0 0'] });
    expect(answers['coverage.minimum']).toEqual({ 'src/': { lines: 80, branches: 70 }, 'cmd/': { lines: 50, branches: 0 }, 'lib/': { lines: 0, branches: 0 } });
    expect(said[0]).toMatch(/lines and branches minimums/);
    expect(said[1]).toMatch(/branches minimum after the lines minimum/);
    expect(said).toHaveLength(2);
  });

  it('reads a reply of spaces as Enter: the default, or the end of a list', async () => {
    const { answers, said } = await typed({ targetBranch: ['   '], highRisk: ['   '] });
    expect(answers.targetBranch).toBe('main');
    expect(answers.highRisk).toEqual([]);
    expect(said).toEqual([]);
  });

  it('explains an out-of-range branches floor and accepts the corrected row', async () => {
    const { answers, said } = await typed({ coverage: ['yes'], 'coverage.command': ['cat cover.lcov'],
      'coverage.minimum': ['src/ 40 101', 'src/ 40 0'] });
    expect(said).toEqual([expect.stringMatching(/src\/: the branches minimum .*0 to 100 .*101/i)]);
    expect(answers['coverage.minimum']).toEqual({ 'src/': { lines: 40, branches: 0 } });
  });
});

describe('reading answers given as JSON', () => {
  const problemsFor = async (given) => (await gatherAnswers({ ...ANSWERS, ...given }, null)).problems ?? [];
  const compile = { 'compile.command': 'go vet ./...', 'compile.pattern': '(?<file>x)(?<message>y)' };

  it('requires at least one folder in a JSON coverage minimum', async () => {
    const problems = await problemsFor({ coverage: true, 'coverage.command': 'cat cover.lcov', 'coverage.minimum': {} });
    expect(problems).toEqual([expect.stringMatching(/coverage\.minimum.*nothing to check against/i)]);
  });

  it('reports every invalid JSON floor while gathering answers', async () => {
    const result = await gatherAnswers({ ...ANSWERS, coverage: true, 'coverage.command': 'cat cover.lcov',
      'coverage.minimum': { 'src/': { branches: 0 }, 'lib/': { lines: 0 }, 'pkg/': { lines: 80, branches: 100.1 } },
    }, null);
    expect(result).toEqual({ problems: [
      expect.stringMatching(/src\/: the lines minimum .*undefined/),
      expect.stringMatching(/lib\/: the branches minimum .*undefined/),
      expect.stringMatching(/pkg\/: the branches minimum .*100\.1/),
    ] });
  });

  it.each([['"x"', 'x'], ['a list', ['0=clean']], ['null', null]])('refuses exit codes given as %s', async (_, value) => {
    expect(await problemsFor({ ...compile, 'compile.exitCodes': value })).toEqual(['"compile.exitCodes" must be an object of exit code to meaning']);
  });

  it.each([['a number', 1], ['spaces', '  '], ['nothing', '']])('refuses text given as %s', async (_, value) => {
    expect(await problemsFor({ targetBranch: value })).toEqual(['"targetBranch" must be text']);
  });

  it('refuses a list holding something that is not text, true or false as text, and a time limit of 0', async () => {
    expect(await problemsFor({ 'tests.all': ['a', 1] })).toEqual(['"tests.all" must be a list of strings']);
    expect(await problemsFor({ coverage: 'yes' })).toEqual(['"coverage" must be true or false']);
    expect(await problemsFor({ mutation: true, 'mutation.command': 'm', 'mutation.report': 'm.json', 'mutation.timeLimitSeconds': 0 }))
      .toEqual(['"mutation.timeLimitSeconds" must be a whole number above 0']);
    expect(await problemsFor({ mutation: true, 'mutation.command': 'm', 'mutation.report': 'm.json', 'mutation.timeLimitSeconds': 120 })).toEqual([]);
  });

  it('refuses high-risk areas that are not { paths, why }, and minimums that are not an object', async () => {
    expect(await problemsFor({ highRisk: ['go.mod'] })).toEqual(['"highRisk" must be a list of { paths, why }']);
    expect(await problemsFor({ highRisk: [{ paths: ['go.mod'], why: 'x' }] })).toEqual([]);
    expect(await problemsFor({ coverage: true, 'coverage.command': 'c', 'coverage.minimum': [] })).toEqual(['"coverage.minimum" must be an object of folder to { lines, branches }']);
  });
});

describe('the questions\' words', () => {
  it('are there for every question, and say when a question is asked wherever it depends on another', () => {
    for (const { id, ask } of questions()) expect(ask.trim(), id).not.toBe('');
    for (const { id, when } of questionsJson().questions) expect(when === undefined || when.trim() !== '', id).toBe(true);
    expect(questionsJson().questions.filter(({ when }) => when !== undefined).map(({ id }) => id)).toEqual([
      'compile.pattern', 'compile.exitCodes', 'coverage.command', 'coverage.minimum', 'mutation.command', 'mutation.report', 'mutation.timeLimitSeconds',
    ]);
  });
});

describe('every section of the drafted rulebook', () => {
  const proposals = [{ label: 'one', proposal: { locked: ['.one/**'], commands: { check: 'node one.mjs' } } }];
  const draft = async (given, adapters = proposals) => draftRulebook((await gatherAnswers({ ...ANSWERS, ...given }, null)).answers, adapters);

  it('refuses the same malformed report path in a draft and an existing rulebook', async () => {
    const config = await draft({});
    config.tests.run.reportPaths = ['**/*.xml'];
    const problem = rulebookProblem(config, root, home);
    expect(problem).toContain('"tests.run.reportPaths" holds "**/*.xml"');

    mkdirSync(join(root, '.katatay'));
    const original = JSON.stringify(config);
    writeFileSync(join(root, CONFIG), original);
    const result = await run({ adapters: [adapter('codex')] });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([`the project has a ${CONFIG} that cannot be read: ${problem}`]);
    expect(read(CONFIG)).toBe(original);
    expect(readdirSync(root)).toEqual(['.katatay']);
  });

  it('checks home-relative plans against an absolute lock in both init reads', async () => {
    const config = await draft({});
    config.plans.dir = '~/plans';
    config.agent.lockedPaths = [join(home, 'plans', 'locked.md')];
    const overlap = rulebookProblem(config, root, home);
    expect(overlap).toContain('overlaps the lock');
    expect(overlap).toContain(config.agent.lockedPaths[0]);

    mkdirSync(join(root, '.katatay'));
    writeFileSync(join(root, CONFIG), JSON.stringify(config));
    const result = await run({ adapters: [adapter('codex')] });
    expect(result.problems).toEqual([`the project has a ${CONFIG} that cannot be read: ${overlap}`]);
    expect(readdirSync(root)).toEqual(['.katatay']);
  });

  it('names the missing target branch and shows how to repair the draft', async () => {
    const config = await draft({});
    delete config.targetBranch;
    expect(rulebookProblem(config, root, home)).toContain('no "targetBranch" key, as in { "version": 1, "targetBranch": "origin/main" }');
  });

  it('holds the slow tests, the follow-ups file and the requirements folder as answered', async () => {
    const config = await draft({ 'tests.slow': ['e2e/**'], 'followUpsFile': 'TODO.md', 'requirementsDir': 'specs/' });
    expect(config.tests.paths.slow).toEqual(['e2e/**']);
    expect(config.followUpsFile).toBe('TODO.md');
    expect(config.requirementsDir).toBe('specs/');
  });

  it.each([
    ['a target with no branch', { targetBranch: 'origin/' }, 'which is not <remote>/<branch>'],
    ['a high-risk area with no paths', { highRisk: [{ paths: [], why: 'x' }] }, '"highRisk[0]".paths must be a non-empty list of globs'],
    ['a mutation report inside .katatay', { mutation: true, 'mutation.command': 'm', 'mutation.report': '.katatay/m.json' }, '"checks.testQuality.mutation.output" must be one repository-relative output file'],
    ['a plans folder with a backslash', { 'plans.dir': 'a\\b' }, '"plans.dir" is "a\\\\b", which is not a folder'],
    ['the project root as the plans folder', { 'plans.dir': '.' }, 'plans'],
    ['a requirements folder outside the project', { 'requirementsDir': '../outside' }, 'which is not a folder inside the repository'],
  ])('is checked: %s is refused', async (_, given, problem) => {
    expect(rulebookProblem(await draft(given), root, home)).toContain(problem);
  });

  it('is checked: a follow-ups file the parser refuses', async () => {
    expect(rulebookProblem(await draft({ 'followUpsFile': 'a\\b' }), root, home)).toContain('followUpsFile');
  });

  it('is checked: an agent with a blank label, and one locking a malformed glob', async () => {
    expect(rulebookProblem(await draft({}, [{ label: ' ', proposal: proposals[0].proposal }]), root, home)).toContain('"agent.adapters" must name each agent');
    expect(rulebookProblem(await draft({}, [{ label: 'one', proposal: { ...proposals[0].proposal, locked: ['a/{b'] } }]), root, home)).toContain('agent.lockedPaths');
  });
});

describe('a git that refuses', () => {
  // Root can write anywhere, so the folder below would not refuse it.
  it.skipIf(process.getuid?.() === 0)('stops init with git\'s own words when git init fails', async () => {
    // Only a project that already has a rulebook is given a repository by
    // init: a drafted one is refused without, before git is started.
    gitInit();
    expect((await run({ adapters: [adapter('claude')] })).ok).toBe(true);
    rmSync(join(root, '.git'), { recursive: true });
    chmodSync(root, 0o555);
    try {
      const result = await run({ adapters: [adapter('claude')] });
      expect(result.ok).toBe(false);
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0]).toMatch(/^git init failed: \S/);
      expect(result.problems[0]).not.toContain('Command failed');
      expect(result.problems[0]).not.toContain('undefined');
      expect(result.problems[0]).toBe(result.problems[0].trimEnd());
    } finally {
      chmodSync(root, 0o755);
    }
  });
});

describe('the other checks and the wrapper files', () => {
  const proposals = [{ label: 'one', proposal: { locked: ['.one/**'], commands: { check: 'node one.mjs' } } }];
  const drafted = async (given) => draftRulebook((await gatherAnswers({ ...ANSWERS, ...given }, null)).answers, proposals);

  it('are asked last, each with a default', () => {
    const list = questions();
    expect(list.slice(-2).map(({ id }) => id)).toEqual(['checks.codeQuality', 'wrappers']);
    expect(list.slice(-2).map((question) => question.default)).toEqual([{}, []]);
    expect(questionsJson().questions.find(({ id }) => id === 'checks.codeQuality').ask).toContain('lint | make lint | 0=clean, 1=findings');
  });

  it('refuses checks that are not an object of objects, as JSON', async () => {
    const problems = async (value) => (await gatherAnswers({ ...ANSWERS, 'checks.codeQuality': value }, null)).problems;
    expect(await problems([])).toEqual([expect.stringMatching(/^"checks\.codeQuality" must be an object of check name to \{ command, exitCodes \}/)]);
    expect(await problems({ lint: 'make lint' })).toEqual([expect.stringContaining('"checks.codeQuality" must be')]);
    expect(await problems({ lint: { command: 'make lint', exitCodes: { 0: 'clean', 1: 'findings' } } })).toBeUndefined();
  });

  it('go into the rulebook as the code-quality chain and one high-risk area', async () => {
    const lint = { command: 'make lint', exitCodes: { 0: 'clean', 1: 'findings' }, onFailure: 'report' };
    const config = await drafted({ 'checks.codeQuality': { lint }, wrappers: ['tools/report.py', 'tools/mutate.sh'],
      highRisk: [{ paths: ['go.mod'], why: 'Dependencies.' }] });
    expect(config.checks).toEqual({ testQuality: { coverage: 'none', mutation: 'none' }, codeQuality: { lint } });
    expect(config.highRisk).toEqual([
      { paths: ['go.mod'], why: 'Dependencies.' },
      { paths: ['tools/report.py', 'tools/mutate.sh'], why: expect.stringMatching(/decide what a check reports/) },
    ]);
    expect(rulebookProblem(config, root, home)).toBeNull();
  });

  it('leave the rulebook as it was when there are none', async () => {
    const config = await drafted({});
    expect(config.checks).toEqual({ testQuality: { coverage: 'none', mutation: 'none' } });
    expect(config.highRisk).toEqual([]);
  });

  it('refuse a malformed check in the parser\'s own words', async () => {
    const config = await drafted({ 'checks.codeQuality': { lint: { command: 'make lint', exitCodes: { 0: 'clean' } } } });
    expect(rulebookProblem(config, root, home)).toContain('checks.codeQuality.lint');
  });

  it.each([
    ['is not a file', 'tools/report.py', '"wrappers" names tools/report.py, which is not a file in the project'],
    ['is a folder', 'tools', '"wrappers" names tools, which is not a file in the project'],
    ['ends at a dot', 'tools/.', '"wrappers" names tools/., which is not a file in the project'],
    ['ends at a separator', 'tools/', '"wrappers" names tools/, which is not a file in the project'],
    ['is absolute', '/usr/local/bin/report.py', '"wrappers" names /usr/local/bin/report.py, which is not a path inside the project.'],
    ['leaves the project', '../shared/report.py', '"wrappers" names ../shared/report.py, which is not a path inside the project.'],
    ['leaves the project halfway', 'tools/../../report.py', '"wrappers" names tools/../../report.py, which is not a path inside the project.'],
  ])('refuse a wrapper that %s, before the probe and before anything is written', async (_, path, problem) => {
    gitInit();
    mkdirSync(join(root, 'tools'));
    const before = readdirSync(root).sort();
    const result = await run({ given: { ...ANSWERS, wrappers: [path] }, probe: () => { throw new Error('probed'); } });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([expect.stringContaining(problem)]);
    expect(readdirSync(root).sort()).toEqual(before);
  });

  it('say a wrapper outside the project belongs in its repository', async () => {
    gitInit();
    const result = await run({ given: { ...ANSWERS, wrappers: ['/abs/a.py', '../b.py'] } });
    expect(result.problems).toHaveLength(2);
    expect(result.problems[0]).toContain('A wrapper is kept in the project\'s own repository');
  });

  it.each([
    ['a link to a local file', 'report.py', 'tools/link.py', 'tools/link.py', 'file'],
    ['a dangling link', 'missing.py', 'tools/link.py', 'tools/link.py', 'file'],
    ['a linked directory', 'tools', 'linked-tools', 'linked-tools/report.py', 'dir'],
    ['a linked directory after redundant separators', 'tools', 'linked-tools', './linked-tools//report.py', 'dir'],
  ])('refuse %s and name the first linked component before probing', async (_, target, link, wrapper, type) => {
    gitInit();
    mkdirSync(join(root, 'tools'));
    writeFileSync(join(root, 'tools', 'report.py'), '# reporter\n');
    symlinkSync(target, join(root, link), type);
    const { probe, asked } = passing();
    const result = await run({ given: { ...ANSWERS, wrappers: [wrapper] }, probe });
    expect(result).toEqual({ ok: false, problems: [`"wrappers" names ${wrapper}, but ${link} is a symbolic link`] });
    expect(asked).toHaveLength(0);
    expect(existsSync(join(root, '.katatay'))).toBe(false);
  });

  it.each(['tools/report.py', './tools//report.py'])('accept a regular wrapper at %s and mark it high-risk', async (wrapper) => {
    gitInit();
    mkdirSync(join(root, 'tools'));
    writeFileSync(join(root, 'tools', 'report.py'), '# reporter\n');
    const result = await run({ given: { ...ANSWERS, wrappers: [wrapper] }, adapters: [adapter('codex')] });
    expect(result.ok).toBe(true);
    expect(highRiskAreas(['tools/report.py'], root).map(area => area.items)).toEqual([['tools/report.py']]);
  });
});

describe('proving the commands', () => {
  const codex = () => ({ adapters: [adapter('codex')] });
  const failing = () => ({ items: [
    { name: 'compile', passed: true, lines: ['clean'] },
    { name: 'tests', passed: false, lines: ['left out of the report: a_test.go.', 'two\nlines'] },
  ] });

  it('writes nothing when a command does not pass, and names the item', async () => {
    gitInit();
    const before = readdirSync(root);
    const result = await run({ ...codex(), probe: failing });
    expect(result).toEqual({ ok: false, problems: [
      'a command does not keep the workflow\'s contract:\npassed — compile: clean\nFAILED — tests: left out of the report: a_test.go.\n    two\n    lines',
    ] });
    expect(readdirSync(root)).toEqual(before);
  });

  it('refuses a folder with no repository before the probe starts, and does not start one', async () => {
    const result = await run({ ...codex(), probe: () => { throw new Error('probed'); } });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([expect.stringMatching(/is not a git repository, so its commands cannot be proved.*Run `git init` there first$/)]);
    expect(readdirSync(root)).toEqual([]);
  });

  it('says so when the probe gave no answer', async () => {
    gitInit();
    const result = await run({ ...codex(), probe: () => ({ problem: 'the probe gave no answer: it exited with 1.' }) });
    expect(result).toEqual({ ok: false, problems: ['the probe gave no answer: it exited with 1.'] });
    expect(existsSync(join(root, CONFIG))).toBe(false);
  });

  it('only probes when asked to, and writes nothing whether the items passed or not', async () => {
    gitInit();
    const before = readdirSync(root);
    const { probe, asked } = passing();
    expect(await run({ ...codex(), probe, probeOnly: true })).toEqual({ ok: true, probed: ['passed — tests: 1 test(s) in 1 file(s), all passing'] });
    expect(asked[0].config.tests.run.command).toBe(ANSWERS['testRun.command']);
    expect(await run({ ...codex(), probe: failing, probeOnly: true })).toEqual({ ok: false, probed: probeLines(failing().items) });
    expect(readdirSync(root)).toEqual(before);
  });

  it('passes the break to look for on to the probe, and says when it cannot be looked for', async () => {
    gitInit();
    const { probe, asked } = passing();
    await run({ ...codex(), probe, probeOnly: true, expect: 'failing-test' });
    expect(asked[0].expect).toBe('failing-test');
    const refused = await run({ ...codex(), probeOnly: true, expect: 'survivors', probe: () => ({ items: [], refused: 'survivors cannot be probed' }) });
    expect(refused).toEqual({ ok: false, refused: true, problems: ['survivors cannot be probed'] });
  });

  it('probes the project\'s own rulebook when it has one, and only when asked to', async () => {
    gitInit();
    expect((await run(codex())).ok).toBe(true);
    const { probe, asked } = passing();
    expect((await run({ ...codex(), given: {}, probe, probeOnly: true })).ok).toBe(true);
    // No draft is sent: the probe reads the file.
    expect(asked).toEqual([{ root, expect: null }]);
  });

  it('refuses to probe an existing rulebook in a folder with no repository', async () => {
    gitInit();
    expect((await run(codex())).ok).toBe(true);
    rmSync(join(root, '.git'), { recursive: true });
    const result = await run({ ...codex(), probeOnly: true, probe: () => { throw new Error('probed'); } });
    expect(result.problems[0]).toContain('is not a git repository');
  });
});

describe('the probe program', () => {
  const started = (run) => {
    const calls = [];
    const start = (...args) => {
      calls.push(args);
      return run;
    };
    return { start, calls };
  };

  it('is a file the referee has', () => {
    expect(existsSync(PROBE)).toBe(true);
  });

  it('is started in the project with the request on stdin, and its answer is read from stdout', () => {
    const items = [{ name: 'tests', passed: true, lines: [] }];
    const { start, calls } = started({ status: 0, stdout: JSON.stringify({ items }), stderr: 'noise from the tests' });
    const request = { root, config: { version: 1 }, expect: 'survivors', scratchModule: 'src/scratch.go' };
    expect(startProbe(request, start)).toEqual({ items });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(PROBE);
    expect(calls[0][1]).toEqual([]);
    expect(calls[0][2]).toMatchObject({ cwd: root, encoding: 'utf8', input: JSON.stringify(request) });
  });

  it('asks about no break unless one is named, and hands a refusal on', () => {
    const { start, calls } = started({ status: 0, stdout: JSON.stringify({ items: [], refused: 'no' }), stderr: '' });
    expect(startProbe({ root }, start)).toEqual({ items: [], refused: 'no' });
    expect(JSON.parse(calls[0][2].input)).toEqual({ root, expect: null });
  });

  it.each([
    ['could not be started', { error: new Error('spawn ENOENT'), status: null, stdout: '', stderr: '' }, 'the probe gave no answer: it could not be started (spawn ENOENT).'],
    ['exited non-zero', { status: 2, stdout: '', stderr: 'probe: the request names no "root"\n' }, 'the probe gave no answer: it exited with 2.\nprobe: the request names no "root"'],
    ['was stopped', { status: null, signal: 'SIGKILL', stdout: '', stderr: '' }, 'the probe gave no answer: it was stopped by SIGKILL.'],
    ['answered with no items', { status: 0, stdout: '{"item":[]}', stderr: '' }, 'the probe gave no answer: its answer holds no "items".'],
    ['answered null', { status: 0, stdout: 'null', stderr: '' }, 'the probe gave no answer: its answer holds no "items".'],
  ])('says why when it %s', (_, run, problem) => {
    expect(startProbe({ root }, started(run).start)).toEqual({ problem });
  });

  it('says why when its answer is not JSON', () => {
    const { problem } = startProbe({ root }, started({ status: 0, stdout: 'oops', stderr: '' }).start);
    expect(problem).toMatch(/^the probe gave no answer: its answer is not JSON \(.+\)\.$/);
  });

  it('prints an item as its result and first line, and the rest indented', () => {
    expect(probeLines([
      { name: 'compile', passed: true, lines: ['clean'] },
      { name: 'lint', passed: true, lines: [] },
      { name: 'tests', passed: false, lines: ['2 failed', 'a_test.go: adds\nb_test.go: subtracts', 'c'] },
    ])).toEqual(['passed — compile: clean', 'passed — lint', 'FAILED — tests: 2 failed', '    a_test.go: adds', '    b_test.go: subtracts', '    c']);
  });
});
