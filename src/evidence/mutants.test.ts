import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mutant, mutationCommand, reportOf, writeReport } from '../../tests/fixtures/workflow/mutation-report.mjs';
import { AdapterError } from '../workflow/adapter.mjs';
import { fixtureMutation, mutationChecks, writeConfig } from '../../tests/fixtures/workflow/adapter.mjs';
import {
  BACKSTOP_SECONDS, EXIT, HEADING, changedTargets, mutate, mutationTargets,
  type Answer, type Request,
} from './mutants.js';

/** A `git diff -U0` of one file, with the hunk headers given. */
const diffOf = (file: string, ...hunks: string[]) =>
  [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, ...hunks.map((h) => `${h}\n+changed`)].join('\n');

/**
 * A rulebook of the tests' own. Which files mutation skips is the operator's
 * policy, and these cases test what the skip list does, so they never read
 * this repository's list.
 */
const SKIPPING = mkdtempSync(join(tmpdir(), 'mutants-skip-'));
writeConfig(SKIPPING, {
  fields: {
    highRisk: [{ paths: ['guarded/**'], why: 'Guarded.' }],
    checks: mutationChecks(fixtureMutation({ excludePaths: ['runner.config.ts', 'helpers/**'] })),
  },
});
afterAll(() => rmSync(SKIPPING, { recursive: true, force: true }));
const targets = (diff: string, untracked: string[] = []) => mutationTargets(diff, untracked, SKIPPING);

describe('the lines to mutate, from the diff against the baseline', () => {
  it('names each run of added or changed lines', () => {
    const diff = diffOf('modules/orders/index.ts', '@@ -8,0 +8,3 @@', '@@ -50 +52 @@');
    expect(targets(diff)).toEqual([
      { file: 'modules/orders/index.ts', lines: [8, 10] },
      { file: 'modules/orders/index.ts', lines: [52, 52] },
    ]);
  });

  // With no context lines, an added line is `+` and its text. Code that holds a
  // hunk header as text must not be read as one.
  it('reads a hunk header only at the start of a line', () => {
    const diff = [diffOf('modules/a.ts', '@@ -1,0 +1,2 @@'), "+const header = 'x @@ -5 +9 @@';"].join('\n');
    expect(targets(diff)).toEqual([{ file: 'modules/a.ts', lines: [1, 2] }]);
  });

  it('reads line numbers and counts of more than one digit', () => {
    expect(targets(diffOf('modules/a.ts', '@@ -100,0 +120,12 @@'))).toEqual([{ file: 'modules/a.ts', lines: [120, 131] }]);
  });

  // A hunk that only deleted lines leaves nothing new to plant a bug in.
  it('gives nothing for a hunk that only deleted lines', () => {
    expect(targets(diffOf('modules/orders/index.ts', '@@ -20,4 +19,0 @@'))).toEqual([]);
  });

  it('gives nothing for a deleted file', () => {
    const diff = ['diff --git a/modules/a.ts b/modules/a.ts', '--- a/modules/a.ts', '+++ /dev/null', '@@ -1,3 +0,0 @@'].join('\n');
    expect(targets(diff)).toEqual([]);
  });

  it('never mutates a test, or anything under tests/', () => {
    const diff = [diffOf('modules/orders/store.test.ts', '@@ -1 +1 @@'), diffOf('src/workflow/mutation.test.mjs', '@@ -1 +1 @@')].join('\n');
    expect(targets(diff, ['tests/support/server.ts'])).toEqual([]);
  });

  // Which files are code is the adapter's `code` globs, wherever they sit.
  // It used to be the folders `modules/`, `app/` and `tools/`, this
  // repository's layout.
  it('mutates only code, by the adapter\'s rule, wherever it sits', () => {
    const diff = [
      diffOf('modules/storage/migrations/0010.sql', '@@ -1 +1 @@'),
      diffOf('requirements/acceptance/AC0001.md', '@@ -1 +1 @@'),
      diffOf('next.config.ts', '@@ -1 +1 @@'),
      diffOf('app/projects/[id]/Buy.tsx', '@@ -1 +1 @@'),
      diffOf('src/workflow/mutation.mjs', '@@ -1 +1 @@'),
    ].join('\n');
    expect(targets(diff).map((t) => t.file)).toEqual(['next.config.ts', 'app/projects/[id]/Buy.tsx', 'src/workflow/mutation.mjs']);
  });

  // They decide how the tests run, or exist only to run tests. A mutant there
  // would be planted in the thing measuring it, or would say nothing about the
  // product. Which files those are is the rulebook's call.
  it('never mutates the files the rulebook skips, tracked or not', () => {
    const diff = [
      diffOf('runner.config.ts', '@@ -1 +1 @@'),
      diffOf('helpers/harness.mjs', '@@ -1 +1 @@'),
      diffOf('modules/a.ts', '@@ -1 +1 @@'),
    ].join('\n');
    expect(targets(diff, ['helpers/new-helper.mjs'])).toEqual([{ file: 'modules/a.ts', lines: [1, 1] }]);
  });

  // A file review must read is still code that tests reach. Only the skip
  // list keeps a file out.
  it('still mutates a file in a high-risk area', () => {
    expect(targets(diffOf('guarded/check.mjs', '@@ -1 +1 @@'))).toEqual([{ file: 'guarded/check.mjs', lines: [1, 1] }]);
  });

  // `git diff` never mentions a file git has not been told about, and a new
  // module is the code that most needs its tests checked.
  it('mutates an untracked code file whole', () => {
    expect(targets('', ['modules/new/index.ts', 'modules/new/index.test.ts', 'notes.md'])).toEqual([{ file: 'modules/new/index.ts' }]);
  });
});

describe('the lines to mutate, in a real repository', () => {
  let root: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  const write = (path: string, source: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mutants-'));
    git('init', '--quiet');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    write('modules/a.ts', 'one\ntwo\nthree\n');
    write('app/projects/[id]/page.tsx', 'one\n');
    writeFileSync(join(root, '.gitignore'), 'reports/\n');
    writeConfig(root, { fields: { checks: mutationChecks() } });
    git('add', '-A');
    git('commit', '--quiet', '-m', 'base');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('takes the working tree against the base, committed or not, with new files whole', () => {
    write('modules/a.ts', 'one\nTWO\nthree\nfour\n');
    write('app/projects/[id]/page.tsx', 'ONE\n');
    write('modules/b.ts', 'new\n');
    expect(changedTargets('HEAD', root)).toEqual([
      { file: 'app/projects/[id]/page.tsx', lines: [1, 1] },
      { file: 'modules/a.ts', lines: [2, 2] },
      { file: 'modules/a.ts', lines: [4, 4] },
      { file: 'modules/b.ts' },
    ]);
  });

  // `color.diff = always` would put escape codes in the hunk headers, and the
  // two prefix settings would change the `+++ b/` the parser looks for.
  it('reads the diff the same way whatever the user\'s diff settings', () => {
    git('config', 'color.diff', 'always');
    git('config', 'diff.mnemonicPrefix', 'true');
    write('modules/a.ts', 'one\nTWO\nthree\n');
    expect(changedTargets('HEAD', root)).toEqual([{ file: 'modules/a.ts', lines: [2, 2] }]);
    git('config', 'diff.noprefix', 'true');
    expect(changedTargets('HEAD', root)).toEqual([{ file: 'modules/a.ts', lines: [2, 2] }]);
  });

  it('drops a file that is not on disk', () => {
    rmSync(join(root, 'modules/a.ts'));
    expect(changedTargets('HEAD', root)).toEqual([]);
  });
});

describe('workflow mutate, in process', () => {
  let root: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mutate-'));
    git('init', '--quiet');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    mkdirSync(join(root, 'modules'));
    writeFileSync(join(root, 'modules/a.ts'), 'one\n');
    writeFileSync(join(root, '.gitignore'), 'reports/\n');
    writeConfig(root, { fields: { checks: mutationChecks() } });
    git('add', '-A');
    git('commit', '--quiet', '-m', 'base');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const changed = () => writeFileSync(join(root, 'modules/a.ts'), 'two\n');
  const answered = (over: Partial<Answer> = {}): Answer => ({ outcome: 'clean', text: '1 mutant: 1 caught, 0 survived.', ...over });
  /** A stub mutation command that records what it was asked. */
  const recording = (reply: Answer | (() => Answer)) => {
    const asked: { request: Request; timeout: number | undefined }[] = [];
    const ask = (request: Request, timeout: number | undefined) => {
      asked.push({ request, timeout });
      const answer = typeof reply === 'function' ? reply() : reply;
      const mutants = answer.outcome === 'nothing' ? [] : [mutant('Killed')];
      if (answer.outcome === 'survived') mutants.push(mutant('Survived', { id: '2' }));
      writeReport(root, mutants);
      return answer;
    };
    return { asked, ask };
  };

  it('refuses without a baseline, and says how to give one', async () => {
    const outcome = await mutate({ base: null, cwd: root, ask: recording(answered()).ask });
    expect(outcome).toMatchObject({ code: 3, outcome: 'failed' });
    expect(outcome.lines.join(' ')).toContain('--base <sha>');
  });

  // Optional, like coverage and apart from it: the operator's `"none"` in the
  // config switches it off, and the report says so rather than staying quiet.
  it('says it was not checked, and asks nothing, when the rulebook says none', async () => {
    writeConfig(root, { fields: { checks: { testQuality: { mutation: 'none', coverage: 'none' } } } });
    changed();
    expect(changedTargets('HEAD', root)).toEqual([]);
    const { asked, ask } = recording(answered());
    const outcome = await mutate({ base: 'HEAD', cwd: root, ask });
    expect(asked).toEqual([]);
    expect(outcome).toEqual({ code: 0, outcome: 'none', lines: ['Mutation testing: not checked: mutation (checks.testQuality.mutation is "none").'] });
  });

  it('asks nothing when the change touches no code', async () => {
    const { asked, ask } = recording(answered());
    const outcome = await mutate({ base: 'HEAD', cwd: root, ask });
    expect(asked).toEqual([]);
    expect(outcome).toEqual({ code: 0, outcome: 'none', lines: [expect.stringContaining('nothing to mutate')] });
  });

  // A clean exit is the tool's word, which the referee cannot check.
  it('gives the command the changed lines, and words a clean run as the tool\'s own account', async () => {
    changed();
    const { asked, ask } = recording(answered());
    const outcome = await mutate({ base: 'HEAD', cwd: root, ask });
    expect(asked).toEqual([{ request: { targets: [{ file: 'modules/a.ts', lines: [1, 1] }], budget: null, verbose: false }, timeout: undefined }]);
    expect(outcome).toEqual({
      code: 0,
      outcome: 'clean',
      standardReport: JSON.stringify(reportOf([mutant('Killed')])),
      findings: expect.objectContaining({ counts: expect.objectContaining({ caught: 1, survived: 0 }) }),
      lines: [
        HEADING,
        '  The tool reports no surviving mutant. That is its account, not',
        '  proof that the tests catch every mutant.',
        '',
        '  1 mutant: 1 caught, 0 survived.',
      ],
    });
  });

  it('says mutants survived, asks for the missing tests, and passes the tool\'s text on', async () => {
    changed();
    const text = '2 mutants: 1 caught, 1 survived.\n\nSurvived:\n- modules/a.ts:1 EqualityOperator → a !== b';
    const outcome = await mutate({ base: 'HEAD', cwd: root, ask: recording(answered({ outcome: 'survived', text })).ask });
    expect(outcome.code).toBe(1);
    expect(outcome.outcome).toBe('survived');
    expect(outcome.lines[1]).toBe('  Mutants survived: a test reached each one and none failed. For');
    // Blank lines stay blank rather than two spaces.
    expect(outcome.lines.slice(-6)).toEqual(['  2 mutants: 1 caught, 1 survived.', '', 'Survivors by line:',
      'modules/a.ts:1', '  a === b', '    EqualityOperator → a !== b']);
    expect(outcome.lines).not.toContain('  Survived:');
  });

  // A line of spaces is blank, and left blank rather than indented.
  it('passes a line of only spaces on as a blank line', async () => {
    changed();
    const outcome = await mutate({ base: 'HEAD', cwd: root, ask: recording(answered({ text: 'a\n   \nb' })).ask });
    expect(outcome.lines.slice(-3)).toEqual(['  a', '', '  b']);
  });

  // Without a stub, it runs the command the rulebook names, from the root.
  it('runs the rulebook\'s mutation command when no stub is given', async () => {
    writeConfig(root, { fields: { checks: mutationChecks(fixtureMutation({ command: mutationCommand('it ran here', 1, [mutant('Survived')]) })) } });
    changed();
    const outcome = await mutate({ base: 'HEAD', cwd: root });
    expect(outcome).toMatchObject({ code: 1, outcome: 'survived' });
    expect(outcome.lines).toContain('  it ran here');
    expect(outcome.lines.at(-1)).toBe('    EqualityOperator → a !== b');
  });

  it('says a run that proves nothing proves nothing, and how to see more', async () => {
    changed();
    const outcome = await mutate({ base: 'HEAD', cwd: root, ask: recording(answered({ outcome: 'nothing', text: 'No test imports the code.' })).ask });
    expect(outcome).toEqual({ code: 2, outcome: 'nothing', standardReport: JSON.stringify(reportOf()), findings: expect.objectContaining({ counts: expect.objectContaining({ total: 0 }) }), lines: [
      HEADING,
      '  The run proves nothing this time. The tool says why below; run',
      '  `workflow mutate` by hand to see more.',
      '',
      '  No test imports the code.',
    ] });
  });

  it('exits as the command did for each way a run ends, and 3 for a failure', () => {
    expect(EXIT).toEqual({ clean: 0, none: 0, survived: 1, nothing: 2, failed: 3 });
  });

  it('keeps every line of its own under 72 characters, so it reads indented', async () => {
    changed();
    for (const answer of ['clean', 'survived', 'nothing'] as const) {
      const { lines } = await mutate({ base: 'HEAD', cwd: root, ask: recording(answered({ outcome: answer, text: 'x' })).ask });
      for (const line of lines) expect(line.length, line).toBeLessThan(72);
    }
  });

  it('reserves twenty seconds plus the entire configured limit when the check is reached', async () => {
    changed();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const { ask, asked } = recording(answered());
      const args = { base: 'HEAD', cwd: root, ask, budget: 240 };
      expect(await mutate({ ...args, deadline: now + 260_000 - 1 })).toMatchObject({
        outcome: 'none', lines: [expect.stringContaining('240 seconds for the run and 20 seconds in reserve')],
      });
      expect(asked).toHaveLength(0);
      expect((await mutate({ ...args, deadline: now + 260_000 })).outcome).toBe('clean');
      expect(asked).toHaveLength(1);
    } finally { clock.mockRestore(); }
  });

  it('passes verbose on and shows the raw tool list after the grouped findings', async () => {
    changed();
    const raw = ['2 mutants: 1 caught, 1 survived.', 'Survived:', '- modules/a.ts:1 EqualityOperator → a !== b'];
    const { asked, ask } = recording(answered({ outcome: 'survived', text: raw.join('\n') }));
    const { lines } = await mutate({ base: 'HEAD', cwd: root, verbose: true, ask });
    expect(asked[0]?.request.verbose).toBe(true);
    expect(lines.slice(lines.indexOf('Survivors by line:'))).toEqual([
      'Survivors by line:', 'modules/a.ts:1', '  a === b', '    EqualityOperator → a !== b',
      '', 'Raw mutation command output:', ...raw.map(line => '  ' + line),
    ]);
  });

  // The command keeps the budget itself. The referee's timeout only catches
  // one that hangs, and it is shorter than the hook's own on this command.
  it('tells the command its budget, held to the cap, and stops it a little after', async () => {
    changed();
    const { asked, ask } = recording(answered());
    await mutate({ base: 'HEAD', cwd: root, budget: 60, ask });
    await mutate({ base: 'HEAD', cwd: root, budget: 10_000, ask });
    const cap = fixtureMutation().timeLimitSeconds;
    expect(asked.map(({ request, timeout }) => [request.budget, timeout])).toEqual([
      [60, 60 + BACKSTOP_SECONDS],
      [cap, cap + BACKSTOP_SECONDS],
    ]);
    expect(BACKSTOP_SECONDS).toBeLessThan(10);
  });

  // The cap is the project's call, in the rulebook, and not a constant here.
  it('holds the budget to the rulebook\'s time limit', async () => {
    writeConfig(root, { fields: { checks: mutationChecks(fixtureMutation({ timeLimitSeconds: 90 })) } });
    changed();
    const { asked, ask } = recording(answered());
    await mutate({ base: 'HEAD', cwd: root, budget: 10_000, ask });
    expect(asked.map(({ request }) => request.budget)).toEqual([90]);
  });


  it('keeps the command diagnostic in the result when a worker crashes', async () => {
    changed();
    writeConfig(root, { fields: { checks: mutationChecks(fixtureMutation({ command: 'echo worker-diagnostic >&2; exit 4' })) } });
    const result = await mutate({ base: 'HEAD', cwd: root });
    expect(result).toMatchObject({ outcome: 'failed', code: 3 });
    expect(result.lines).toContain('  worker-diagnostic');
  });

  it('sets no limit for a budget that is not a positive number', async () => {
    changed();
    const { asked, ask } = recording(answered());
    for (const budget of [Number.NaN, 0, -5, undefined, Number.POSITIVE_INFINITY]) await mutate({ base: 'HEAD', cwd: root, budget, ask });
    expect(asked.map(({ request, timeout }) => [request.budget, timeout])).toEqual(Array(5).fill([null, undefined]));
  });

  it('says it failed, and why, when the command fails', async () => {
    changed();
    const outcome = await mutate({ base: 'HEAD', cwd: root, ask: recording(() => { throw new AdapterError('adapter: mutate exited with 7.\nPlease correct these configuration errors'); }).ask });
    expect(outcome).toEqual({ code: 3, outcome: 'failed', lines: [
      'Mutation testing failed before it could say anything:',
      '  adapter: mutate exited with 7.',
      '  Please correct these configuration errors',
    ] });
  });

  // Stopped by the referee's backstop, the run ran out of time; it did not
  // break, and it proves nothing.
  it('says the run ran past its limit and was stopped, when the backstop stopped it', async () => {
    changed();
    const late = Object.assign(new AdapterError('adapter: mutate was still running after 65 seconds, and was stopped.'), { timedOut: true });
    const outcome = await mutate({ base: 'HEAD', cwd: root, budget: 60, ask: recording(() => { throw late; }).ask });
    expect(outcome).toMatchObject({ code: 3, outcome: 'failed' });
    expect(outcome.lines.join(' ')).toContain('was still running after 65 seconds');
  });

  // Only the command failing is reported. Anything else is a bug here, and
  // is thrown rather than dressed up as a report.
  it('throws anything that is not the command failing', async () => {
    changed();
    await expect(mutate({ base: 'HEAD', cwd: root, ask: recording(() => { throw new TypeError('a bug'); }).ask })).rejects.toThrow('a bug');
  });

  // The hook reads the report through a pipe. The report used to be written
  // with `fs.writeSync` just before the exit, which on a pipe that does not
  // block stops at the pipe's 64 KB buffer. The adapter's answer was cut there
  // on the first real run.
  it('prints the whole report through a pipe, however long the tool\'s text, and exits as the command did', () => {
    changed();
    const many = 'for (let i = 1; i <= 3000; i++) console.log("- modules/a.ts:" + i + " EqualityOperator → a !== b");';
    writeConfig(root, { fields: { checks: mutationChecks(fixtureMutation({ command: mutationCommand('', 1, [mutant('Survived')], many) })) } });
    const cli = join(process.cwd(), 'src/evidence/mutate.ts');
    const said = spawnSync(process.execPath, [join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'), cli, '--base', 'HEAD', '--verbose'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    expect(said.status).toBe(1);
    expect(said.stdout.length).toBeGreaterThan(64 * 1024);
    expect(said.stdout).toContain('Survivors by line:\nmodules/a.ts:1\n  a === b\n    EqualityOperator → a !== b\n\nRaw mutation command output:');
    expect(said.stdout.endsWith('  - modules/a.ts:3000 EqualityOperator → a !== b\n')).toBe(true);
  });

  it('removes a stale report and fails the run if the command supplies none', async () => {
    changed();
    writeReport(root, [mutant('Survived')]);
    const answer = await mutate({ base: 'HEAD', cwd: root, ask: () => answered() });
    expect(answer).toMatchObject({ outcome: 'failed', code: 3 });
    expect(answer.lines.join('\n')).toContain('Mutation report failed');
    expect(answer.lines.join('\n')).toContain('1 mutant: 1 caught, 0 survived.');
    expect(answer).not.toHaveProperty('findings');
  });

  it('stores complete survivor evidence with counts from the report', async () => {
    changed();
    const output = 'reports/custom/mutants.json';
    writeConfig(root, { fields: { checks: mutationChecks(fixtureMutation({ output })) } });
    const result = await mutate({ base: 'HEAD', cwd: root, ask: recording(answered({ outcome: 'survived' })).ask });
    expect(result.findings).toMatchObject({ counts: { caught: 1, survived: 1 },
      survivors: [{ file: 'modules/a.ts', id: '2', location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
        mutator: 'EqualityOperator', replacement: 'a !== b' }] });
    expect(result.standardReport).toBe(readFileSync(join(root, output), 'utf8'));
    expect(existsSync(join(root, '.katatay/local'))).toBe(false);
  });

  it('preserves the original standard report formatting without publishing snapshots', async () => {
    changed();
    const report = JSON.stringify(reportOf([mutant('Killed')]), null, 2) + '\n';
    const result = await mutate({ base: 'HEAD', cwd: root, ask: () => {
      writeReport(root, []);
      writeFileSync(join(root, 'reports/mutation/mutation.json'), report);
      return answered();
    } });
    expect(result.standardReport).toBe(report);
    expect(result.findings?.counts.caught).toBe(1);
    expect(existsSync(join(root, '.katatay/local'))).toBe(false);
  });

  it('keeps the specific validation error and the command text when a report is invalid', async () => {
    changed();
    const result = await mutate({ base: 'HEAD', cwd: root, ask: () => {
      writeReport(root, [mutant('unknown')]);
      return answered({ text: 'the tool finished' });
    } });
    expect(result).toMatchObject({ code: 3, outcome: 'failed' });
    expect(result.lines).toContain('  invalid or duplicate mutant in modules/a.ts');
    expect(result.lines.at(-1)).toBe('  the tool finished');
  });

  it('fails with the report error when the report cannot be removed', async () => {
    changed();
    const path = join(root, fixtureMutation().output);
    mkdirSync(path, { recursive: true });
    const { ask, asked } = recording(answered());
    const result = await mutate({ base: 'HEAD', cwd: root, ask });
    expect(result).toMatchObject({ code: 3, outcome: 'failed' });
    expect(result.lines[0]).toContain('could not be cleared');
    expect(asked).toEqual([]);
  });

  // The hook asks for JSON, and stores the outcome beside the report.
  it('gives the outcome with the lines when asked for JSON', () => {
    changed();
    writeConfig(root, { fields: { checks: mutationChecks(fixtureMutation({ command: mutationCommand('nothing reached', 2) })) } });
    const cli = join(process.cwd(), 'src/evidence/mutate.ts');
    const said = spawnSync(process.execPath, [join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'), cli, '--base', 'HEAD', '--json'], { cwd: root, encoding: 'utf8' });
    expect(said.status).toBe(2);
    const answer = JSON.parse(said.stdout);
    expect(answer.outcome).toBe('nothing');
    expect(answer.lines.at(-1)).toBe('  nothing reached');
  });

  it('prints complete structured findings through a pipe larger than 64 KB', () => {
    changed();
    const path = fixtureMutation().output;
    writeFileSync(join(root, 'mutation-command.cjs'), `
      const fs = require('fs');
      const path = require('path');
      const report = ${JSON.stringify(reportOf([mutant('Survived')]))};
      const file = report.files['modules/a.ts'];
      file.mutants = Array.from({ length: 3000 }, (_, i) => ({ ...file.mutants[0], id: String(i) }));
      fs.mkdirSync(path.dirname(${JSON.stringify(path)}), { recursive: true });
      fs.writeFileSync(${JSON.stringify(path)}, JSON.stringify(report));
      console.log('3000 survived');
      process.exitCode = 1;
    `);
    writeConfig(root, { fields: { checks: mutationChecks(fixtureMutation({ command: 'node mutation-command.cjs' })) } });
    const cli = join(process.cwd(), 'src/evidence/mutate.ts');
    const said = spawnSync(process.execPath, [join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'), cli, '--base', 'HEAD', '--json'],
      { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    expect(said.status).toBe(1);
    expect(said.stdout.length).toBeGreaterThan(64 * 1024);
    const findings = JSON.parse(said.stdout).findings;
    expect(findings.counts.survived).toBe(3000);
    expect(findings.survivors).toHaveLength(3000);
    expect(new Set(findings.survivors.map((s: { id: string }) => s.id)).size).toBe(3000);
  });
});
