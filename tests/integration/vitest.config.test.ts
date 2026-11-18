/**
 * What coverage is measured over.
 *
 * `npm run coverage:check` holds each folder to a minimum, and the cheapest way
 * to stay above one is to measure less. These cases pin what is measured, so an
 * `exclude` entry that takes code out of the figure fails here instead of
 * passing as a tidier report. The config is a guardrail path as well, so review
 * is told to read the edit. This is the part a machine can check.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import picomatch from 'picomatch';
import { describe, expect, it } from 'vitest';
import config from '../../vitest.config.js';
import { isTest } from '../../src/workflow/frozen.mjs';
import { readChecks } from '../../src/workflow/rulebook.mjs';

const coverage = config.test?.coverage as { include?: string[]; exclude?: string[]; enabled?: boolean; reporter?: string[]; reportsDirectory?: string };

// As vitest matches them: paths from the root, dotfiles included.
const included = picomatch(coverage.include ?? [], { dot: true });
const excluded = picomatch(coverage.exclude ?? [], { dot: true });
const measured = (file: string) => included(file) && !excluded(file);

/** Every file under tools/ that is on disk and not ignored, tracked or not:
 *  a new file counts before it is committed. */
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'src'], { encoding: 'utf8' })
  .split('\n')
  .filter((file) => file !== '' && existsSync(file));

const CODE = /\.[cm]?[jt]sx?$/;

describe('what coverage measures', () => {
  it('measures every code file under tools/ that is not a test', () => {
    const code = files.filter((file) => CODE.test(file) && !isTest(file));
    expect(code.length).toBeGreaterThan(50);
    expect(code.filter((file) => !measured(file))).toEqual([]);
  });

  it('leaves out the tests', () => {
    const tests = files.filter((file) => isTest(file));
    expect(tests.length).toBeGreaterThan(20);
    expect(tests.filter(measured)).toEqual([]);
  });

  // Not code, so there is nothing in them for a test to run. The Markdown
  // also fails to parse, which fills the run's output with errors. CSS and SQL
  // stay in the exclude list for a project that adds them; tools/ has none.
  it('leaves out what is not code: JSON and Markdown', () => {
    const other = files.filter((file) => !CODE.test(file));
    expect(other.map((file) => file.split('.').at(-1)).filter((ext, i, all) => all.indexOf(ext) === i).sort()).toEqual(['json', 'md']);
    expect(other.filter(measured)).toEqual([]);
  });

  it('leaves nothing else out', () => {
    expect(coverage.exclude).toEqual(['**/*.test.*', '**/*.json', '**/*.css', '**/*.sql', '**/*.md']);
  });
});

describe('where the coverage report goes', () => {
  // The coverage command supplies LCOV to the referee. Vitest's `lcovonly`
  // reporter writes `lcov.info` into the reports folder, so the command must
  // read that file. Only a full report says which lines no test ran.
  it('is the lcov file the coverage command reads', () => {
    expect(coverage.reporter).toEqual(['lcovonly']);
    const entry = readChecks().testQuality.find((check) => check.name === 'coverage');
    expect(entry?.command).toBe(`cat ${join(coverage.reportsDirectory ?? '', 'lcov.info')}`);
  });

  // `npm test`, the rulebook's test command, which verify runs, passes
  // `--coverage` to the fast tests' run. The triage runs each project apart, and `test:fast`
  // runs one. Switched on here, each would overwrite the report with the
  // figures of a different run.
  it('is not switched on in the config, so only a full run with coverage writes it', () => {
    expect(coverage.enabled).toBeUndefined();
  });
});

/**
 * How long the fast tests' setup may take. On a busy machine a `beforeAll`
 * ran past Vitest's default of 10 seconds, failing verify on tests that pass
 * alone.
 */
describe('the fast tests\' setup', () => {
  const fast = (config.test?.projects ?? []).find((project) =>
    typeof project === 'object' && project !== null && (project as { test?: { name?: string } }).test?.name === 'fast') as
    { test: { hookTimeout?: number; setupFiles?: string[] } } | undefined;

  it('may take 30 seconds, not the default 10', () => {
    expect(fast?.test.hookTimeout).toBe(30_000);
  });

  // See `tests/support/outside-ci.ts`. Under CI its own test notices it is
  // gone; locally there is no `CI` to remove, so this is what notices.
  it('runs every test as if outside CI, whatever the runner sets', () => {
    expect(fast?.test.setupFiles).toContain('tests/support/outside-ci.ts');
  });
});

describe('the slow tests\' scheduling', () => {
  type Project = { test: { name: string; sequence?: { groupOrder?: number; concurrent?: boolean };
    testTimeout?: number; maxConcurrency?: number; fileParallelism?: boolean; include?: string[] } };
  const projects = (config.test?.projects ?? []).filter((project): project is Project =>
    typeof project === 'object' && project !== null && 'test' in project);
  const project = (name: string) => projects.find(project => project.test.name === name)!.test;

  it('runs the slow process tests in their own group while keeping parallelism within it', () => {
    const slow = project('slow');
    expect(slow.sequence?.groupOrder).toBe(1);
    expect(slow.fileParallelism).not.toBe(false);
    expect(slow.include).toContain('tests/hooks/codex/journey.test.mjs');
  });

  it('retains the existing timeouts and fast project scheduling', () => {
    expect(project('slow').testTimeout).toBe(30_000);
    expect(project('fast').sequence?.groupOrder).toBeUndefined();
  });

  // Vitest's default is one worker fewer than the CPU count, which timed the
  // slow process tests out under load. See the config for the measurement.
  it('runs the slow process tests on fewer workers than Vitest would by default', () => {
    const workers = (project('slow') as { maxWorkers?: number }).maxWorkers;
    expect(workers).toBeGreaterThanOrEqual(1);
    expect(workers).toBeLessThan(Math.max(availableParallelism() - 1, 2));
  });
});
