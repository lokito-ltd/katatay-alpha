import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureMutation, mutationChecks, writeConfig } from '../../../tests/fixtures/workflow/adapter.mjs';
import { InlineStyles, ProgressFile, createRunner, strykerPlugins, widen, widenNameFilter } from './mutate-plugins.mjs';
import { readMutationReport } from '../../evidence/mutation-report.mjs';

describe('the test name filter, widened for Vitest 5', () => {
  // What Stryker builds: escaped names joined by `|`, with a space between a
  // `describe` title and a test title.
  const stryker = /AC0028: buying again Once an order is paid \[AC0028\.1\]|top level/;

  it('matches a test inside a describe, as Vitest 5 names it', () => {
    expect(stryker.test('AC0028: buying again > Once an order is paid [AC0028.1]')).toBe(false);
    expect(widen(stryker).test('AC0028: buying again > Once an order is paid [AC0028.1]')).toBe(true);
  });

  it('still matches a name with no describe, and a space inside a title', () => {
    expect(widen(stryker).test('top level')).toBe(true);
    expect(widen(stryker).test('AC0028: buying again Once an order is paid [AC0028.1]')).toBe(true);
  });

  it('matches nothing the original pattern would not, other than the separator', () => {
    expect(widen(stryker).test('AC0028: buying again > Once an order is unpaid [AC0028.1]')).toBe(false);
    expect(widen(stryker).test('AC0028: buying again >> Once an order is paid [AC0028.1]')).toBe(false);
  });

  it('keeps the flags, and leaves a missing pattern missing', () => {
    expect(widen(/a b/i).flags).toBe('i');
    expect(widen(undefined)).toBeUndefined();
  });

  // The runner sets the pattern afresh before every mutant's run.
  it('widens every pattern set on the config, including one already there', () => {
    const config = { testNamePattern: /a b/ };
    widenNameFilter(config);
    expect(config.testNamePattern.test('a > b')).toBe(true);
    config.testNamePattern = /c d/;
    expect(config.testNamePattern.test('c > d')).toBe(true);
    config.testNamePattern = undefined;
    expect(config.testNamePattern).toBeUndefined();
  });

  // Vitest copies its config to each worker, and a property that does not
  // enumerate is left out of the copy.
  it('keeps the pattern a property that copies, and can be widened again', () => {
    const config = { testNamePattern: /a b/ };
    widenNameFilter(config);
    expect(Object.keys(config)).toContain('testNamePattern');
    expect(() => widenNameFilter(config)).not.toThrow();
  });
});

describe('the runner Stryker is given', () => {
  // A stand-in for Stryker's injector, which builds the upstream runner. Only
  // what `createRunner` touches is here.
  const upstreamRunner = () => {
    const runner = { ctx: null, init: async () => { runner.ctx = { projects: [{ config: {} }, { config: {} }] }; } };
    return { runner, injector: { provideValue: () => ({ injectClass: () => runner }) } };
  };

  it('is the upstream runner, with every project\'s filter widened once Vitest is up', async () => {
    const { runner, injector } = upstreamRunner();
    const created = createRunner(injector);
    expect(created).toBe(runner);
    await created.init();
    for (const { config } of runner.ctx.projects) {
      config.testNamePattern = /suite test/;
      expect(config.testNamePattern.test('suite > test')).toBe(true);
      // Worker threads refuse `process.chdir()`, which some tests here call.
      expect(config.pool).toBe('forks');
    }
  });

  it('is registered under the name the options ask for, beside the ignorer', () => {
    expect(strykerPlugins.map((plugin) => `${plugin.kind}:${plugin.name}`)).toEqual([
      'TestRunner:vitest-describe', 'Ignore:inline-styles', 'Reporter:progress-file',
    ]);
  });
});

describe('the inline style ignorer', () => {
  const attribute = (name) => ({ isJSXAttribute: () => true, node: { name: { name } } });

  it('ignores a JSX style attribute, and says why', () => {
    expect(new InlineStyles().shouldIgnore(attribute('style'))).toMatch(/inline style/);
  });

  it('leaves every other attribute, and anything that is not an attribute, alone', () => {
    expect(new InlineStyles().shouldIgnore(attribute('alt'))).toBeUndefined();
    expect(new InlineStyles().shouldIgnore({ isJSXAttribute: () => false, node: {} })).toBeUndefined();
  });
});

describe('the progress reporter', () => {
  it('writes the plan, counting only mutants that will be reported on, then a line per mutant', () => {
    const dir = mkdtempSync(join(tmpdir(), 'progress-'));
    try {
      const path = join(dir, 'nested/progress.jsonl');
      const reporter = new ProgressFile(path);
      reporter.onMutationTestingPlanReady({ mutantPlans: [
        { plan: 'Run', mutant: {} },
        { plan: 'EarlyResult', mutant: { status: 'NoCoverage' } },
        { plan: 'EarlyResult', mutant: { status: 'NoCoverage' } },
        { plan: 'EarlyResult', mutant: { status: 'Ignored' } },
      ] });
      reporter.onMutantTested({ id: '1', status: 'Killed' });
      reporter.onMutantTested({ id: '2', status: 'Survived' });
      expect(readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line))).toEqual([
        { planned: 3 },
        { result: { id: '1', status: 'Killed' } },
        { result: { id: '2', status: 'Survived' } },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The real thing: the referee's mutate command, running this adapter's Stryker
 * wrapper, on a fixture repository small enough to run in seconds. It is the
 * only test that shows the referee, the exit-code contract, Stryker, the two
 * plugins and Vitest 5 work together, which none of them proves alone.
 *
 * The fixture's tests sit inside a `describe`, so without the fixed filter no
 * mutant could be caught. Tried on 2026-10-17 with Stryker's own runner: the
 * report said it ran no test against 4 mutants and showed nothing. No test asks
 * about exactly ten, so `n > 10` turned into `n >= 10` must survive. The
 * badge's inline style holds mutants the ignorer must leave out.
 */
describe('workflow mutate, through the TypeScript adapter, on a fixture repository', () => {
  const repo = process.cwd();
  let root;
  let run;

  const write = (path, source) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  };
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'mutate-'));
    symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'));
    write('package.json', '{ "type": "module" }\n');
    write('.gitignore', 'node_modules\n.stryker-tmp\nreports/\n');
    write('mutate.config.ts', "export default { test: { include: ['modules/**/*.test.{ts,tsx}'] } };\n");
    // Mutation asks the adapter section which files are code and which are
    // tests, and refuses without one. Its mutation command is this
    // repository's wrapper, named by absolute path, since the fixture has no
    // `tools/` of its own, given the fixture's own Vitest config.
    const tsx = join(repo, 'node_modules/tsx/dist/cli.mjs');
    writeConfig(root, { fields: { checks: mutationChecks(fixtureMutation({
      command: `node ${tsx} ${join(repo, 'src/adapters/typescript/stryker-mutate.ts')} --vitest-config mutate.config.ts`,
    })) } });
    write('modules/flag.ts', 'export const flag = (n: number) => 0;\n');
    write('modules/flag.test.ts', [
      "import { describe, expect, it } from 'vitest';",
      "import { flag } from './flag';",
      "import { badge } from './badge';",
      "describe('the flag', () => {",
      "  it('is up above ten', () => { expect(flag(11)).toBe(1); });",
      "  it('is down at zero', () => { expect(flag(0)).toBe(0); });",
      "  it('has a badge', () => { expect(badge().props.children).toBe('up'); });",
      '});',
      '',
    ].join('\n'));
    git('init', '--quiet');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('add', '-A');
    git('commit', '--quiet', '-m', 'base');
    write('modules/flag.ts', 'export const flag = (n: number) => (n > 10 ? 1 : 0);\n');
    write('modules/badge.tsx', "export const badge = () => <b style={{ color: 'red', margin: 0 }}>up</b>;\n");
    // The test worker's own variables would make the Vitest that Stryker
    // starts think it is a worker of this run.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')));
    run = spawnSync(process.execPath, [join(repo, 'node_modules/tsx/dist/cli.mjs'), join(repo, 'src/evidence/mutate.ts'), '--base', 'HEAD'], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
  }, 120_000);

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('catches what the tests inside a describe catch, lists what they miss, and exits 1', () => {
    expect(run.stdout.trim().split('\n')).toEqual([
      'Mutation testing on the lines this change added or changed:',
      '  Mutants survived: a test reached each one and none failed. For',
      '  each, write the test it shows is missing, or leave it if the',
      '  mutant changes nothing anyone could observe.',
      '',
      '  4 mutants: 3 caught, 1 survived.',
      '  2 more skipped: code that runs when a file loads.',
      '',
      'Survivors by line:',
      'modules/flag.ts:1',
      '  export const flag = (n: number) => (n > 10 ? 1 : 0);',
      '    EqualityOperator → n >= 10',
    ]);
    expect(run.status).toBe(1);
  });

  // The badge has mutants outside its `style` too, which the tests catch, so
  // the badge is reached; none of those inside the `style` is counted.
  it('leaves the mutants inside an inline style out altogether', () => {
    expect(run.stdout).not.toContain('modules/badge.tsx');
    expect(run.stdout).toContain('4 mutants');
  });

  // Each `() => …` is built when its file loads, so replacing the whole
  // function is a static mutant: Stryker would reload everything and run every
  // related test for it. Skipped, and counted so nobody reads it as checked.
  it('skips static mutants, and says how many', () => {
    expect(run.stdout).toContain('2 more skipped: code that runs when a file loads.');
  });

  it('removes its sandbox afterwards', () => {
    expect(spawnSync('ls', ['-a', root], { encoding: 'utf8' }).stdout).not.toContain('.stryker-tmp');
  });

  it('writes a native standard report whose counts and survivor agree with the referee', () => {
    const report = join(root, fixtureMutation().output);
    const findings = readMutationReport(report, 'survived');
    expect(findings.counts).toMatchObject({ caught: 3, survived: 1 });
    expect(findings.survivors).toMatchObject([{ file: 'modules/flag.ts', location: { start: { line: 1 } },
      mutator: 'EqualityOperator', replacement: 'n >= 10' }]);
    expect(run.stdout).toContain('3 caught, 1 survived');
  });
});
