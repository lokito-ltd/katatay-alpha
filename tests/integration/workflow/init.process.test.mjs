/** The probe program's own stdin and output protocol. Public init journeys live in tests/acceptance/setup. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const LAUNCHER = resolve('src/agents/init.mjs');

// A project small enough to need no tool: its "test runner" is a shell script
// that writes the report `junit.xml` holds. `init` runs it for real, through
// the probe program, before it writes anything.
const ANSWERS = JSON.stringify({
  'tests.all': ['tests/**'], 'tests.acceptance': ['acceptance/**'], code: ['src/**'],
  'testRun.command': 'sh run-tests.sh', 'testRun.reports': ['reports/junit/*.xml'], 'testRun.tagComment': '^\\s*#',
});
const junit = (...cases) => `<testsuites><testsuite name="s">${cases.join('')}</testsuite></testsuites>`;
const PASSING = '<testcase name="adds" file="tests/app_test.sh"/>';
const FAILING = '<testcase name="adds" file="tests/app_test.sh"><failure message="expected 2"/></testcase>';

let base;
let project;
let home;
let env;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-init-process-')));
  project = join(base, 'project');
  home = join(base, 'home');
  mkdirSync(project);
  mkdirSync(home);
  // The operator's own settings stay out of it, and npm's folder too.
  env = { ...process.env, HOME: home };
  delete env.INIT_CWD;
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const init = (...args) => spawnSync(process.execPath, [LAUNCHER, ...args], { cwd: project, env, input: ANSWERS, encoding: 'utf8' });
const write = (path, text) => {
  mkdirSync(join(project, path, '..'), { recursive: true });
  writeFileSync(join(project, path), text);
};

/** A repository with one code file, one test file and a test command that reports `cases`. */
function hello(...cases) {
  execFileSync('git', ['init', '--quiet'], { cwd: project });
  write('.gitignore', 'reports/\n');
  write('src/app.sh', 'echo $((1 + 1))\n');
  write('tests/app_test.sh', '# adds\n');
  write('junit.xml', junit(...cases));
  write('run-tests.sh', 'mkdir -p reports/junit && cp junit.xml reports/junit/r.xml\n');
}

describe('the probe program over stdin', () => {
  const program = resolve('src/evidence/probe.ts');
  const loader = import.meta.resolve('tsx');
  const probe = (input) => spawnSync(process.execPath, ['--import', loader, program], {
    cwd: project, env, input, encoding: 'utf8',
  });

  it.each([
    ['{', /^probe: the request is not JSON \(.+\)\n$/],
    ['{}', /^probe: the request names no "root"\n$/],
    ['{"root":".","expect":"red"}', /^probe: "expect" is "red", which is not one of .+\n$/],
  ])('rejects invalid input %s on stderr and exits 2 without a result', (input, diagnostic) => {
    const run = probe(input);
    expect(run.stderr).toMatch(diagnostic);
    expect(run.stdout).toBe('');
    expect(run.status).toBe(2);
  });

  it('returns a complete failed item as JSON and suppresses the test runner’s progress output', () => {
    hello(PASSING);
    expect(init().status).toBe(0);
    write('junit.xml', junit(FAILING));
    write('run-tests.sh', 'echo "runner progress"\nmkdir -p reports/junit && cp junit.xml reports/junit/r.xml\nexit 1\n');
    const run = probe(JSON.stringify({ root: project }));
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout.endsWith('\n')).toBe(true);
    expect(JSON.parse(run.stdout)).toEqual({ items: [
      { name: 'tests', passed: false, lines: ['1 failed of 1 test(s) in 1 file(s)', 'tests/app_test.sh: adds'] },
    ] });
  });
});
