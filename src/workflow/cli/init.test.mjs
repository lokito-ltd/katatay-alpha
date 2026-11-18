/**
 * `workflow.mjs init`, in process: its arguments, where it reads answers
 * from, which folder it sets up, and what it prints.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { USAGE, parseAnswers, parseArguments, run } from './init.mjs';

const CLAUDE = `claude=node ${JSON.stringify(resolve('src/agents/claude/defaults.mjs'))}`;
const ANSWERS = JSON.stringify({
  'tests.all': ['**/*_test.go'], 'tests.acceptance': ['acceptance/**'], code: ['**/*.go'],
  'testRun.command': 'go test ./...', 'testRun.reports': ['reports/junit/*.xml'], 'testRun.tagComment': '^\\s*//',
});

/** A folder made into a repository, as a project is before its commands are proved. */
const repository = (folder) => {
  mkdirSync(folder, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: folder });
  return folder;
};

/** A probe that found the one command it ran keeping the contract. The real
 *  one is tested in `src/evidence/probe.test.ts`. */
const probe = () => ({ items: [{ name: 'tests', passed: true, lines: ['1 test(s) in 1 file(s), all passing'] }] });

let base;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-init-cli-')));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('the arguments', () => {
  it('reads every agent, the project, the answers file and --questions', () => {
    expect(parseArguments(['--agent', 'a=node a.mjs', '--agent', 'b=node b.mjs', '--project', 'p', '--answers', 'x.json', '--questions'])).toEqual({
      adapters: [{ label: 'a', command: 'node a.mjs' }, { label: 'b', command: 'node b.mjs' }], project: 'p', answers: 'x.json', list: true,
      probe: false, expect: undefined,
    });
  });

  it('reads --probe, and the break to look for with it', () => {
    expect(parseArguments(['--probe'])).toEqual({ adapters: [], project: undefined, answers: undefined, list: false, probe: true, expect: undefined });
    expect(parseArguments(['--expect', 'survivors', '--probe'])).toMatchObject({ probe: true, expect: 'survivors' });
  });

  it.each([
    [['--agent', 'node a.mjs'], '--agent needs <label>=<defaults command>, and got "node a.mjs"'],
    [['--agent', 'a='], '--agent needs <label>=<defaults command>, and got "a="'],
    [['--agent', '=node a.mjs'], '--agent needs <label>=<defaults command>, and got "=node a.mjs"'],
    [['--agent', 'a=   '], '--agent needs <label>=<defaults command>, and got "a=   "'],
    [['--agent'], '--agent needs <label>=<defaults command>, and got ""'],
    [['--project'], '--project needs a value'],
    [['--answers', ''], '--answers needs a value'],
    [['--scratch-module'], '--scratch-module needs a value'],
    [['--scratch-module', '--probe'], '--scratch-module needs a value'],
    [['--force'], 'init does not take "--force"'],
    [['--probe', '--expect'], '--expect needs a value'],
    [['--probe', '--expect', 'red'], '--expect takes one of compile-error-in-code, compile-error-in-test, failing-test, below-minimum, survivors, and got "red"'],
    [['--expect', 'survivors'], '--expect needs --probe: a break is only looked for, never set up on'],
  ])('refuses %j', (argv, problem) => {
    expect(parseArguments(argv)).toEqual({ problem });
  });

  it('exits 2 with the usage for arguments it cannot read, or no agent', async () => {
    expect(await run(['--force'])).toEqual({ stderr: `init does not take "--force"\n${USAGE}`, code: 2 });
    expect(await run([], { cwd: base, env: {} })).toEqual({ stderr: `name at least one agent adapter with --agent\n${USAGE}`, code: 2 });
  });
});

describe('the answers', () => {
  it('are one JSON object, and empty text is no answers', () => {
    expect(parseAnswers('', 'stdin')).toEqual({ given: {} });
    expect(parseAnswers('  \n', 'stdin')).toEqual({ given: {} });
    for (const text of ['null', '1', '"x"']) {
      expect(parseAnswers(text, 'stdin'), text).toEqual({ problem: 'the answers in stdin must be one JSON object keyed by question id' });
    }
    expect(parseAnswers('{"targetBranch":"main"}', 'stdin')).toEqual({ given: { targetBranch: 'main' } });
    expect(parseAnswers('[1]', 'stdin')).toEqual({ problem: 'the answers in stdin must be one JSON object keyed by question id' });
    expect(parseAnswers('{', 'x.json').problem).toMatch(/^the answers in x\.json are not JSON/);
  });

  it('that cannot be read stop init with exit 1', async () => {
    expect(await run(['--agent', CLAUDE], { cwd: base, env: {}, stdin: () => '[1]' })).toEqual({ stderr: 'the answers in stdin must be one JSON object keyed by question id', code: 1 });
    expect((await run(['--agent', CLAUDE, '--answers', 'missing.json'], { cwd: base, env: {} })).stderr).toMatch(/^the answers cannot be read: /);
  });
});

describe('the questions', () => {
  it('print as JSON, with the first agent\'s plans folder as the default', async () => {
    const printed = await run(['--questions', '--agent', CLAUDE], { cwd: base, env: {} });
    expect(printed.code).toBe(0);
    const questions = JSON.parse(printed.stdout).questions;
    expect(questions.find(({ id }) => id === 'plans.dir').default).toBe('~/.claude/plans');
    expect(questions.find(({ id }) => id === 'requirementsDir').default).toBe('requirements');
    expect(questions.find(({ id }) => id === 'mutation.timeLimitSeconds').default).toBe(300);
    expect(questions.find(({ id }) => id === 'coverage.minimum')).toMatchObject({
      required: true, when: 'asked when coverage is measured',
      ask: expect.stringMatching(/at least one folder/i), answer: expect.stringMatching(/lines, branches/),
    });
    const defaults = await run(['--questions']);
    expect(defaults.code).toBe(0);
    expect(JSON.parse(defaults.stdout).questions.find(({ id }) => id === 'plans.dir').default).toBe('~/.katatay/plans');
  });

  it('say why when the agent gives no defaults', async () => {
    expect(await run(['--questions', '--agent', 'x=exit 3'], { cwd: base, env: {} })).toEqual({ stderr: 'x: the agent\'s defaults (`exit 3`) gave no answer: it exited with 3.', code: 1 });
  });
});

describe('setting up', () => {
  it('sets up the folder npm was started from, reading a relative answers file from there too', async () => {
    const project = repository(join(base, 'project'));
    writeFileSync(join(project, 'answers.json'), ANSWERS);
    const printed = await run(['--agent', CLAUDE, '--answers', 'answers.json'], { cwd: '/', env: { INIT_CWD: project }, probe });
    expect(printed.code).toBe(0);
    expect(printed.stdout.split('\n')[0]).toBe(`Set up ${project}:`);
    expect(printed.stdout).toContain('- passed — tests: 1 test(s) in 1 file(s), all passing');
    expect(printed.stdout).toContain('- wrote .katatay/rulebook.json');
    expect(printed.stdout).toContain('\n\nSteps only the operator can take:\n  1. Review .katatay/rulebook.json.');
  });

  it('sets up --project, read from the working directory, with the answers on stdin, and asks nothing when there is no terminal', async () => {
    repository(join(base, 'p'));
    const printed = await run(['--agent', CLAUDE, '--project', 'p'], { cwd: base, env: {}, stdin: () => ANSWERS, probe });
    expect(printed.code).toBe(0);
    expect(printed.stdout.split('\n')[0]).toBe(`Set up ${join(base, 'p')}:`);
  });

  it('asks in a terminal without reading stdin', async () => {
    repository(join(base, 'p'));
    const asked = [];
    const replies = { 'tests.all': '**/*_test.go', 'tests.acceptance': 'acceptance/**', code: '**/*.go', 'testRun.command': 'go test ./...',
      'testRun.reports': 'reports/junit/*.xml', 'testRun.tagComment': '//', coverage: 'no', mutation: 'no' };
    const ask = async (question) => {
      asked.push(question.id);
      return replies[question.id] ?? '';
    };
    const printed = await run(['--agent', CLAUDE, '--project', 'p'], { cwd: base, env: {}, ask, probe, stdin: () => { throw new Error('read stdin'); } });
    expect(printed.code).toBe(0);
    expect(asked).toContain('tests.all');
  });

  it('asks in a terminal only what the answers file leaves out, and copes with no say', async () => {
    repository(join(base, 'p'));
    writeFileSync(join(base, 'answers.json'), ANSWERS);
    const asked = [];
    const replies = { coverage: ['maybe', 'no'] };
    const ask = async (question) => {
      asked.push(question.id);
      return replies[question.id]?.shift() ?? '';
    };
    const printed = await run(['--agent', CLAUDE, '--project', 'p', '--answers', 'answers.json'], { cwd: base, env: {}, ask, probe });
    expect(printed.code).toBe(0);
    expect(asked).not.toContain('tests.all');
    expect(asked.filter((id) => id === 'coverage')).toHaveLength(2);
  });

  it('prints what is wrong and writes nothing when init refuses', async () => {
    mkdirSync(join(base, 'p'));
    const printed = await run(['--agent', CLAUDE, '--project', 'p'], { cwd: base, env: {}, stdin: () => '{}' });
    expect(printed.code).toBe(1);
    expect(printed.stderr.split('\n')[0]).toBe('init wrote nothing:');
    expect(printed.stderr).toContain('- "tests.all" has no answer: ');
    expect(readdirSync(join(base, 'p'))).toEqual([]);
  });
});

describe('probing', () => {
  const failed = () => ({ items: [
    { name: 'compile', passed: true, lines: ['clean'] },
    { name: 'tests', passed: false, lines: ['left out of the report: a_test.go', 'narrow the glob'] },
  ] });
  const argv = ['--agent', CLAUDE, '--project', 'p', '--probe'];

  it('prints each item and writes nothing, exiting 0 when every one passed', async () => {
    const project = repository(join(base, 'p'));
    const before = readdirSync(project);
    const printed = await run(argv, { cwd: base, env: {}, stdin: () => ANSWERS, probe });
    expect(printed).toEqual({ stdout: `Probed ${project}:\n- passed — tests: 1 test(s) in 1 file(s), all passing`, code: 0 });
    expect(readdirSync(project)).toEqual(before);
  });

  it('exits 1 when an item did not pass', async () => {
    const project = repository(join(base, 'p'));
    const printed = await run(argv, { cwd: base, env: {}, stdin: () => ANSWERS, probe: failed });
    expect(printed).toEqual({
      stdout: `Probed ${project}:\n- passed — compile: clean\n- FAILED — tests: left out of the report: a_test.go\n-     narrow the glob`, code: 1,
    });
    expect(readdirSync(project)).toEqual(['.git']);
  });

  it('passes the break to look for on, and no break without --expect', async () => {
    repository(join(base, 'p'));
    const asked = [];
    const recording = (request) => {
      asked.push(request.expect);
      return probe();
    };
    await run([...argv, '--expect', 'below-minimum'], { cwd: base, env: {}, stdin: () => ANSWERS, probe: recording });
    await run(argv, { cwd: base, env: {}, stdin: () => ANSWERS, probe: recording });
    expect(asked).toEqual(['below-minimum', null]);
  });

  it('forwards the scratch module in explicit and automatic probes and keeps it out of the rulebook', async () => {
    const project = repository(join(base, 'p'));
    const paths = [];
    const recording = ({ scratchModule }) => {
      paths.push(scratchModule);
      return probe();
    };
    const args = ['--agent', CLAUDE, '--project', 'p', '--scratch-module', 'src/scratch.go'];
    const io = { cwd: base, env: {}, stdin: () => ANSWERS, probe: recording };
    expect((await run([...args, '--probe'], io)).code).toBe(0);
    expect((await run(args, io)).code).toBe(0);
    expect(paths).toEqual(['src/scratch.go', 'src/scratch.go']);
    expect(readFileSync(join(project, '.katatay/rulebook.json'), 'utf8')).not.toContain('src/scratch.go');
  });

  it('exits 2 for a break whose item is switched off', async () => {
    repository(join(base, 'p'));
    const printed = await run([...argv, '--expect', 'survivors'], {
      cwd: base, env: {}, stdin: () => ANSWERS, probe: () => ({ items: [], refused: 'survivors cannot be probed: "checks.testQuality.mutation" is "none"' }),
    });
    expect(printed).toEqual({ stderr: 'survivors cannot be probed: "checks.testQuality.mutation" is "none"', code: 2 });
  });

  it('says a command did not pass when setting up, and writes nothing', async () => {
    const project = repository(join(base, 'p'));
    const printed = await run(['--agent', CLAUDE, '--project', 'p'], { cwd: base, env: {}, stdin: () => ANSWERS, probe: failed });
    expect(printed.code).toBe(1);
    expect(printed.stderr).toContain('init wrote nothing:\n- a command does not keep the workflow\'s contract:\npassed — compile: clean\nFAILED — tests: left out of the report: a_test.go');
    expect(readdirSync(project)).toEqual(['.git']);
  });

  it('refuses a folder that is not a repository', async () => {
    mkdirSync(join(base, 'p'));
    const printed = await run(argv, { cwd: base, env: {}, stdin: () => ANSWERS, probe });
    expect(printed.code).toBe(1);
    expect(printed.stderr).toContain('is not a git repository');
  });

  it('is named in the usage', () => {
    expect(USAGE).toContain('[--probe [--expect <state>]]');
  });
});
