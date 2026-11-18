import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  answer, exitFor, literal, partial, plainReason, readRequest, removeSandboxes, render, respond, SANDBOXES, STATIC_REASON, strykerOptions,
  strykerTarget, summarise, toMutant, vitestConfigOf, type Answer, type Mutant, type StrykerResult,
} from './stryker.js';
import type { Run } from './stryker-process.js';

/** A run that is only its results: stopping it does nothing but count. */
const runOf = (done: Promise<StrykerResult[]>, stop: () => Promise<void> = async () => {}): Run => ({ done, stop });
import { PROGRESS } from './mutate-plugins.mjs';

describe('the request the referee sends', () => {
  it('is read with its targets and budget', () => {
    const request = readRequest('{ "targets": [{ "file": "a.ts", "lines": [1, 3] }, { "file": "b.ts" }], "budget": 60 }');
    expect(request).toEqual({ targets: [{ file: 'a.ts', lines: [1, 3] }, { file: 'b.ts' }], budget: 60, verbose: false });
    expect(readRequest('{ "targets": [], "budget": null, "verbose": true }').verbose).toBe(true);
    // A change of one line is a range of one.
    expect(readRequest('{ "targets": [{ "file": "a.ts", "lines": [3, 3] }], "budget": null }').targets).toEqual([{ file: 'a.ts', lines: [3, 3] }]);
  });

  // A guessed target list could mutate the wrong code, so a request the referee
  // did not send is a crash.
  it('is refused when it is not what the referee sends', () => {
    for (const text of ['{}', 'null', '{ "targets": "a.ts", "budget": null }']) expect(() => readRequest(text), text).toThrow(/no "targets" list/);
    for (const target of [
      null, {}, { file: '' }, { file: 'a.ts', lines: [3] }, { file: 'a.ts', lines: [1, 2, 3] }, { file: 'a.ts', lines: { 0: 1, 1: 2, length: 2 } },
      { file: 'a.ts', lines: [0, 2] }, { file: 'a.ts', lines: [5, 2] }, { file: 'a.ts', lines: [1, 1.5] },
    ]) {
      expect(() => readRequest(JSON.stringify({ targets: [target], budget: null })), JSON.stringify(target)).toThrow(/a target is not/);
    }
    for (const budget of [undefined, 0, -1, '60']) {
      expect(() => readRequest(JSON.stringify({ targets: [], budget })), String(budget)).toThrow(/"budget" must be/);
    }
  });
});

describe('a target as Stryker reads it', () => {
  it('is a range of lines, or the bare path for a whole file', () => {
    expect(strykerTarget({ file: 'modules/orders/index.ts', lines: [8, 10] })).toBe('modules/orders/index.ts:8-10');
    expect(strykerTarget({ file: 'modules/new.ts' })).toBe('modules/new.ts');
  });

  it('is unchanged when the path holds nothing a glob would read', () => {
    expect(literal('modules/orders/index.ts')).toBe('modules/orders/index.ts');
  });

  // Next's route folders. A glob reads `[id]` as "i or d", and Stryker refuses
  // a range on any path that looks like a glob.
  it('makes each glob character in the path stand for itself, and leaves the range alone', () => {
    expect(strykerTarget({ file: 'app/projects/[id]/(shop)/Buy.tsx', lines: [5, 10] })).toBe('app/projects/[[]id[]]/[(]shop[)]/Buy.tsx:5-10');
    expect(literal('app/a{b}*?.ts')).toBe('app/a[{]b[}][*][?].ts');
  });
});

describe('the options Stryker runs with', () => {
  const options = strykerOptions(['modules/a.ts:1-2'], '/repo/src/adapters/typescript/mutate-plugins.mjs', 'project.mutate.config.ts');

  it('runs the fixed Vitest runner and the style ignorer, from the plugins file', () => {
    expect(options).toMatchObject({
      testRunner: 'vitest-describe',
      plugins: ['/repo/src/adapters/typescript/mutate-plugins.mjs'],
      ignorers: ['inline-styles'],
      mutate: ['modules/a.ts:1-2'],
    });
  });

  // Static mutants did 80% of the test runs on the change that measured them.
  it('skips static mutants, and reports through the progress file', () => {
    expect(options).toMatchObject({ ignoreStatic: true, reporters: ['progress-file', 'json'] });
  });

  // Which tests a run uses is the project's call, in the config it names.
  it('runs the project\'s Vitest config, only the tests related to the mutated files, per mutant', () => {
    expect(options).toMatchObject({
      vitest: { configFile: 'project.mutate.config.ts', related: true },
      coverageAnalysis: 'perTest',
    });
  });

  // With logging off, a failed first pass said only "Something went wrong",
  // and the reason went nowhere. The log goes to stderr, never the answer.
  it('logs its errors, and writes no log file', () => {
    expect(options).toMatchObject({ logLevel: 'error', fileLogLevel: 'off' });
  });

  // Stryker's tsconfig step calls TypeScript's JavaScript API, which
  // TypeScript 7 does not have. It is skipped only when the file is missing.
  it('points Stryker at a tsconfig that does not exist', () => {
    expect(existsSync(options.tsconfigFile as string)).toBe(false);
  });

  // Inside the repository, so tests that run git still find it; Stryker never
  // copies `.git` into the sandbox.
  it('keeps the sandbox in a folder git ignores', () => {
    const ignored = execFileSync('git', ['check-ignore', `${options.tempDirName as string}/sandbox-x/a.ts`], { encoding: 'utf8' });
    expect(ignored.trim()).not.toBe('');
  });
});

const result = (status: string, extra: Partial<StrykerResult> = {}): StrykerResult => ({
  fileName: '/repo/modules/orders/index.ts',
  location: { start: { line: 10 } },
  mutatorName: 'ConditionalExpression',
  replacement: 'true',
  status,
  testsCompleted: status === 'NoCoverage' ? 0 : 3,
  ...extra,
});

describe('a Stryker result, in the contract\'s words', () => {
  const statusOf = (r: StrykerResult) => toMutant(r, '/repo')?.status;

  it('says caught for a killed mutant, and for one that made a test hang', () => {
    expect([statusOf(result('Killed')), statusOf(result('Timeout'))]).toEqual(['caught', 'caught']);
  });

  it('says unreached, broke and survived where Stryker does', () => {
    expect(statusOf(result('NoCoverage'))).toBe('unreached');
    expect([statusOf(result('CompileError')), statusOf(result('RuntimeError'))]).toEqual(['broke', 'broke']);
    expect(statusOf(result('Survived'))).toBe('survived');
  });

  // The trial: Stryker's Vitest runner skipped every test inside a `describe`,
  // and called each mutant it could not test a survivor.
  it('never calls a mutant no test ran against a survivor', () => {
    expect(statusOf(result('Survived', { testsCompleted: 0 }))).toBe('notRun');
    expect(statusOf(result('Survived', { testsCompleted: undefined }))).toBe('notRun');
  });

  // A static mutant is code a test could have checked, and was not; an inline
  // style is code no test of behaviour should.
  it('says skipped, with why, for a static mutant, and leaves a skipped style out', () => {
    expect(toMutant(result('Ignored', { statusReason: 'Static mutant (and "ignoreStatic" was enabled)' }), '/repo'))
      .toMatchObject({ status: 'skipped', reason: STATIC_REASON });
    expect(toMutant(result('Ignored', { statusReason: 'An inline style changes how a page looks, which no behaviour test checks.' }), '/repo')).toBeNull();
    expect(toMutant(result('Ignored'), '/repo')).toBeNull();
  });

  it('gives the file from the repository root, the line, the mutator and the replacement', () => {
    expect(toMutant(result('Survived'), '/repo/')).toEqual({
      file: 'modules/orders/index.ts', line: 10, mutator: 'ConditionalExpression', replacement: 'true', status: 'survived',
    });
    expect(toMutant(result('Killed', { replacement: undefined }), '/repo')?.replacement).toBe('');
  });

  it('crashes on a status it does not know, rather than guess', () => {
    expect(() => toMutant(result('Pending'), '/repo')).toThrow(/a status this adapter does not know: Pending/);
  });

  it('gives each status a word the text knows', () => {
    const mutants = ['Killed', 'Timeout', 'Survived', 'NoCoverage', 'RuntimeError', 'CompileError'].map((s) => toMutant(result(s), '/repo'));
    mutants.push(toMutant(result('Ignored', { statusReason: 'Static mutant' }), '/repo'));
    expect(mutants.map((m) => m?.status)).toEqual(['caught', 'caught', 'survived', 'unreached', 'broke', 'broke', 'skipped']);
  });
});

describe('the answer', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stryker-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const ask = (budget: number | null, run: (targets: string[]) => Promise<StrykerResult[]>, stop?: () => Promise<void>) =>
    answer({ request: { targets: [{ file: 'modules/a.ts', lines: [1, 1] }], budget }, cwd: root, run: (targets) => runOf(run(targets), stop) });
  const killed = (): StrykerResult => ({ ...result('Killed'), fileName: join(root, 'modules/a.ts') });

  it('gives Stryker the targets in its syntax, and counts every mutant but the skipped ones as planned', async () => {
    let given: string[] = [];
    const said = await ask(null, async (targets) => {
      given = targets;
      return [killed(), killed(), { ...killed(), status: 'Ignored', statusReason: 'Static mutant' }];
    });
    expect(given).toEqual(['modules/a.ts:1-1']);
    expect(said).toMatchObject({ planned: 2, stopped: false, noTests: false });
    expect(said.mutants.map((m) => m.status)).toEqual(['caught', 'caught', 'skipped']);
  });

  // An inline style changes how a page looks, which no behaviour test checks.
  it('leaves out a mutant an ignorer skipped, from the list and the count', async () => {
    const said = await ask(null, async () => [killed(), { ...killed(), status: 'Ignored', statusReason: 'An inline style changes how a page looks.' }]);
    expect(said).toMatchObject({ planned: 1 });
    expect(said.mutants.map((m) => m.status)).toEqual(['caught']);
  });

  // Stryker throws when no fast test imports any changed file. Coverage says
  // the same thing, so it is an answer and not a failure.
  it('says no test reaches the code when Stryker finds no test to run', async () => {
    const said = await ask(null, async () => { throw new Error('No tests were executed. Stryker will exit prematurely.'); });
    expect(said).toEqual({ planned: 0, stopped: false, noTests: true, mutants: [] });
  });

  it('crashes when Stryker fails any other way', async () => {
    await expect(ask(null, async () => { throw new Error('Please correct these configuration errors'); })).rejects.toThrow(/configuration errors/);
  });

  // What the progress reporter wrote by the time the budget ran out.
  const progressed = (planned: number, results: StrykerResult[]) => {
    mkdirSync(dirname(join(root, PROGRESS)), { recursive: true });
    writeFileSync(join(root, PROGRESS), [{ planned }, ...results.map((r) => ({ result: r }))].map((e) => JSON.stringify(e)).join('\n') + '\n');
  };

  it('stops at its budget and gives what it checked by then', async () => {
    const said = await ask(0.05, () => { progressed(5, [killed()]); return new Promise<StrykerResult[]>(() => {}); });
    expect(said).toMatchObject({ planned: 5, stopped: true, noTests: false });
    expect(said.mutants).toHaveLength(1);
  });

  // Stryker's workers keep writing until they are stopped. Read before that,
  // the file could gain lines after the answer, and the folder could not be
  // deleted under them.
  it('stops the run, and waits for it, before reading what it checked', async () => {
    let stops = 0;
    const said = await ask(0.02, () => new Promise<StrykerResult[]>(() => {}), async () => {
      stops += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      progressed(3, [killed(), killed()]);
    });
    expect(stops).toBe(1);
    expect(said).toMatchObject({ planned: 3, stopped: true });
    expect(said.mutants).toHaveLength(2);
  });

  // A real run that is killed ends with no answer, so its `done` rejects as
  // soon as the kill lands. That rejection used to win the race against the
  // cut-off, and the run read as a crash: on 2026-10-23 it threw away what
  // the run had checked in its whole time limit.
  it('answers with what it checked when the stopped run then fails, as a killed run does', async () => {
    let fail: (error: Error) => void = () => {};
    const said = await ask(0.02, () => new Promise<StrykerResult[]>((_, reject) => { fail = reject; }), async () => {
      progressed(4, [killed(), killed(), killed()]);
      fail(new Error("Stryker's process ended with SIGKILL before it answered"));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(said).toMatchObject({ planned: 4, stopped: true, noTests: false });
    expect(said.mutants).toHaveLength(3);
  });

  it('does not stop a run that finishes inside its budget', async () => {
    let stops = 0;
    await ask(60, async () => [killed()], async () => { stops += 1; });
    expect(stops).toBe(0);
  });

  it('crashes when the run cannot be stopped', async () => {
    await expect(ask(0.02, () => new Promise<StrykerResult[]>(() => {}), async () => { throw new Error('kill failed'); }))
      .rejects.toThrow('kill failed');
  });

  // A file left by an earlier run would be read as this run's progress.
  it('starts every run with no progress file', async () => {
    progressed(7, [killed(), killed()]);
    const said = await ask(0.05, () => new Promise<StrykerResult[]>(() => {}));
    expect(said).toEqual({ planned: 0, stopped: true, noTests: false, mutants: [] });
  });

  it('reads nothing from a missing progress file', () => {
    expect(partial(root)).toEqual({ planned: 0, stopped: true, noTests: false, mutants: [] });
  });

  /** A run that takes a little real time, so a timer set too short wins. */
  const slow = () => new Promise<StrykerResult[]>((resolve) => setTimeout(() => resolve([killed()]), 30));

  it('answers a run that finishes inside its budget in full', async () => {
    expect((await ask(60, slow)).stopped).toBe(false);
  });

  it('sets no limit when the budget is null', async () => {
    expect((await ask(null, slow)).stopped).toBe(false);
  });

  // A run that fails after the budget answered must not crash the process
  // before the answer is printed.
  it('ignores a run that fails after the budget has answered', async () => {
    const handler = vi.fn();
    process.on('unhandledRejection', handler);
    try {
      let fail: (error: Error) => void = () => {};
      const said = await ask(0.02, () => new Promise<StrykerResult[]>((_, reject) => { fail = reject; }));
      fail(new Error('too late'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(said.stopped).toBe(true);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', handler);
    }
  });

  // A timer left behind would hold the process open for the rest of the budget.
  it('leaves no timer behind once the run is over', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await ask(60, async () => [killed()]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the mutation command, short of the process', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'respond-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const respondTo = async (
    input: string,
    run: (targets: string[], verbose: boolean) => Promise<StrykerResult[]>,
    rm?: typeof rmSync,
  ) => {
    const written: string[] = [];
    const failed: string[] = [];
    const warned: string[] = [];
    const code = await respond({
      input,
      cwd: root,
      run: (targets, verbose) => runOf(run(targets, verbose)),
      write: (t) => { written.push(t); },
      fail: (m) => { failed.push(m); },
      warn: (m) => { warned.push(m); },
      ...(rm && { rm }),
    });
    return { code, written, failed, warned };
  };
  const request = (over = {}) => JSON.stringify({ targets: [{ file: 'modules/a.ts', lines: [2, 3] }], budget: null, ...over });
  const at = (status: string): StrykerResult => ({ ...result(status), fileName: join(root, 'modules/a.ts') });

  it('writes what it found as text, and exits 0 when every mutant was caught', async () => {
    const said = await respondTo(request(), async () => [at('Killed')]);
    expect(said).toEqual({ code: 0, written: ['1 mutant: 1 caught, 0 survived.\n'], failed: [], warned: [] });
  });

  it('exits 1 when a mutant survived, and lists it', async () => {
    const said = await respondTo(request(), async () => [at('Killed'), at('Survived')]);
    expect(said.code).toBe(1);
    expect(said.written[0]).toContain('- modules/a.ts:10 ConditionalExpression → true');
  });

  it('exits 2 when no test imports the changed code', async () => {
    const said = await respondTo(request(), async () => { throw new Error('No tests were executed.'); });
    expect(said.code).toBe(2);
    expect(said.written[0]).toContain('No test imports the code this change added or changed');
  });

  it('passes the targets and verbose on to Stryker', async () => {
    const seen: [string[], boolean][] = [];
    await respondTo(request({ verbose: true }), async (targets, verbose) => { seen.push([targets, verbose]); return []; });
    await respondTo(request(), async (targets, verbose) => { seen.push([targets, verbose]); return []; });
    expect(seen).toEqual([[['modules/a.ts:2-3'], true], [['modules/a.ts:2-3'], false]]);
  });

  // A crash is a refusal: nothing on stdout, the reason on stderr, exit 3.
  // Not 1, which means mutants survived.
  it('writes nothing, says why and exits 3 when the request cannot be read', async () => {
    const said = await respondTo('not json', async () => []);
    expect(said).toMatchObject({ code: 3, written: [] });
    expect(said.failed).toHaveLength(1);
  });

  it('writes nothing, says why and exits 3 when Stryker fails', async () => {
    const said = await respondTo(request(), async () => { throw new Error('Please correct these configuration errors'); });
    expect(said).toEqual({ code: 3, written: [], failed: ['Please correct these configuration errors'], warned: [] });
  });

  // Each sandbox is a copy of the repository, and Stryker keeps one after a
  // run that fails.
  it('removes the sandbox whether the run succeeded or failed', async () => {
    for (const run of [async () => [], async () => { throw new Error('boom'); }]) {
      mkdirSync(join(root, SANDBOXES, 'sandbox-1'), { recursive: true });
      await respondTo(request(), run);
      expect(existsSync(join(root, SANDBOXES))).toBe(false);
    }
  });

  // On 2026-10-22 a failed delete exited with a crash after the answer was
  // written, and the referee threw the answer away.
  it('keeps the text and its exit code when the sandbox cannot be removed, and warns', async () => {
    const stuck = (() => { throw new Error('ENOTEMPTY: directory not empty'); }) as unknown as typeof rmSync;
    const said = await respondTo(request(), async () => [at('Killed')], stuck);
    expect(said.code).toBe(0);
    expect(said.written).toHaveLength(1);
    expect(said.failed).toEqual([]);
    expect(said.warned).toEqual([`mutate: could not remove ${SANDBOXES}/ (ENOTEMPTY: directory not empty). It is gitignored, and the next run replaces it.`]);
  });
});

describe('the project\'s Vitest config, from the arguments', () => {
  it('is the path after --vitest-config', () => {
    expect(vitestConfigOf(['--vitest-config', 'vitest.mutate.config.ts'])).toBe('vitest.mutate.config.ts');
    expect(vitestConfigOf(['--other', 'x', '--vitest-config', 'a.ts'])).toBe('a.ts');
    expect(vitestConfigOf(['--verbose', '--vitest-config', 'b.ts'])).toBe('b.ts');
  });

  // Without the flag, no other argument is taken for the path.
  it('takes nothing for the path when the flag is missing', () => {
    expect(() => vitestConfigOf(['a.ts'])).toThrow(/--vitest-config <path>/);
  });

  // A default would be one project's layout.
  it('is required', () => {
    for (const argv of [[], ['--vitest-config'], ['--vitest-config', ''], ['--vitest-config', '--verbose']]) {
      expect(() => vitestConfigOf(argv), JSON.stringify(argv)).toThrow(/name the project's Vitest config for mutation runs, as --vitest-config <path>/);
    }
  });
});

const mutant = (status: Mutant['status'], extra: Partial<Mutant> = {}): Mutant => ({
  file: 'modules/orders/index.ts',
  line: 10,
  mutator: 'ConditionalExpression',
  replacement: 'true',
  status,
  ...(status === 'skipped' ? { reason: 'code that runs when a file loads' } : {}),
  ...extra,
});
const found = (mutants: Mutant[], over: Partial<Answer> = {}): Answer => ({ planned: mutants.length, stopped: false, noTests: false, mutants, ...over });

describe('what a run found, counted', () => {
  it('counts caught, survived, unreached and broken mutants', () => {
    const summary = summarise([
      mutant('caught'), mutant('caught'), mutant('survived'), mutant('unreached'), mutant('broke'), mutant('broke'),
    ]);
    expect(summary).toMatchObject({ total: 6, caught: 2, unreached: 1, errors: 2, unproven: 0, skipped: {} });
    expect(summary.survived).toEqual([
      { file: 'modules/orders/index.ts', line: 10, mutator: 'ConditionalExpression', replacement: 'true' },
    ]);
  });

  // A skipped mutant is code a test could have checked, and was not.
  it('counts skipped mutants apart, by their reason, and leaves them out of the total', () => {
    const summary = summarise([
      mutant('caught'), mutant('skipped'), mutant('skipped'), mutant('skipped', { reason: 'too slow' }),
    ]);
    expect(summary).toMatchObject({ total: 1, caught: 1, skipped: { 'code that runs when a file loads': 2, 'too slow': 1 } });
  });

  it('counts a mutant no test ran against apart, never as a survivor', () => {
    const summary = summarise([mutant('notRun'), mutant('notRun')]);
    expect(summary.survived).toEqual([]);
    expect(summary).toMatchObject({ total: 2, unproven: 2 });
  });

  it('lists survivors by file and line, with a long replacement on one short line', () => {
    const summary = summarise([
      mutant('survived', { file: 'tools/b.ts', line: 3 }),
      mutant('survived', { line: 20, replacement: '{\n  return   undefined;\n}' + ' x'.repeat(40) }),
      mutant('survived', { line: 4 }),
    ]);
    expect(summary.survived.map((s) => `${s.file}:${s.line}`)).toEqual(['modules/orders/index.ts:4', 'modules/orders/index.ts:20', 'tools/b.ts:3']);
    const long = summary.survived[1]?.replacement ?? '';
    expect(long.startsWith('{ return undefined; } x')).toBe(true);
    expect(long).toHaveLength(50);
    expect(long.endsWith('…')).toBe(true);
  });

  // Fifty characters fit; only a longer one is cut. Spaces at either end go.
  it('keeps a replacement of exactly fifty characters whole, and trims its ends', () => {
    const fifty = 'y'.repeat(50);
    const [whole, trimmed] = summarise([mutant('survived', { replacement: fifty }), mutant('survived', { line: 11, replacement: '\n  x \t' })]).survived;
    expect(whole?.replacement).toBe(fifty);
    expect(trimmed?.replacement).toBe('x');
  });
});

describe('the exit code for what a run found', () => {
  it('is 0 when every mutant a test reached was caught', () => {
    expect(exitFor(found([mutant('caught'), mutant('unreached'), mutant('skipped')]))).toBe(0);
  });

  it('is 1 when a mutant survived', () => {
    expect(exitFor(found([mutant('caught'), mutant('survived')]))).toBe(1);
  });

  // The survivors it found are real, whatever it did not reach.
  it('is 1 when a run cut off at its budget found a survivor', () => {
    expect(exitFor(found([mutant('survived')], { planned: 9, stopped: true }))).toBe(1);
  });

  // It found none, and says nothing of the rest.
  it('is 2 when a run cut off at its budget found no survivor', () => {
    expect(exitFor(found([mutant('caught')], { planned: 9, stopped: true }))).toBe(2);
    expect(exitFor(found([], { planned: 9, stopped: true }))).toBe(2);
  });

  // A run that tested nothing must not read as clean.
  it('is 2 when no test imports the changed code', () => {
    expect(exitFor(found([], { noTests: true }))).toBe(2);
  });

  // A list that is mostly false alarms is a list nobody reads, so one mutant
  // no test ran against voids the whole run, survivors included.
  it('is 2 when a mutant tests reach ran no test, survivors or not', () => {
    expect(exitFor(found([mutant('caught'), mutant('survived'), mutant('notRun')]))).toBe(2);
  });

  it('is 2 when no mutant was caught or survived', () => {
    expect(exitFor(found([mutant('unreached'), mutant('broke'), mutant('skipped')]))).toBe(2);
    expect(exitFor(found([]))).toBe(2);
  });
});

describe('what a run found, as text', () => {
  it('gives the counts, then each survivor', () => {
    expect(render(found([mutant('caught'), mutant('caught'), mutant('survived'), mutant('unreached')]), null)).toEqual([
      '4 mutants: 2 caught, 1 survived, 1 reached by no test.',
      'Survived:',
      '- modules/orders/index.ts:10 ConditionalExpression → true',
    ]);
  });

  it('says only the counts when nothing survived', () => {
    expect(render(found([mutant('caught')]), null)).toEqual(['1 mutant: 1 caught, 0 survived.']);
  });

  it('says how many it skipped, and why, as Stryker gave the reason', () => {
    const said = render(found([mutant('caught'), mutant('skipped', { reason: 'too slow' }), mutant('skipped'), mutant('skipped', { reason: 'too slow' })]), null);
    // In the order of the reasons, not the order the mutants came in.
    expect(said.slice(1)).toEqual(['1 more skipped: code that runs when a file loads.', '2 more skipped: too slow.']);
  });

  // A partial report must never read as a whole one.
  it('says when it covers only part of the mutants, and how much', () => {
    expect(render(found([mutant('caught'), mutant('survived')], { planned: 9, stopped: true }), 180).slice(0, 2)).toEqual([
      'Stopped at its 180-second limit, so this covers part of them.',
      '2 of 9 mutants: 1 caught, 1 survived.',
    ]);
  });

  it('says a run that stopped before checking anything shows nothing', () => {
    expect(render(found([mutant('skipped')], { planned: 5, stopped: true }), 60).join(' ')).toContain('did not finish within 60 seconds, before any mutant was');
  });

  it('counts mutants that broke the code outright apart, and says no test caught any', () => {
    expect(render(found([mutant('broke')]), null)).toEqual([
      '1 mutant: 0 caught, 0 survived, 1 broke the code outright.',
      'No test caught or let through any of them, so this run proves nothing.',
    ]);
  });

  it('says it shows nothing when any mutant that tests reach ran no test, and lists no survivor', () => {
    const said = render(found([mutant('caught'), mutant('survived'), mutant('notRun')]), null).join(' ');
    expect(said).toContain('No test ran against 1 mutant that tests reach');
    expect(said).not.toContain('Survived:');
  });

  it('says no test imports the code when none does', () => {
    expect(render(found([], { noTests: true }), null).join(' ')).toContain('No test imports the code this change added or changed');
  });

  it('keeps every line of its own under 70 characters, so it reads indented', () => {
    const lines = [
      ...render(found([mutant('caught'), mutant('survived'), mutant('broke')], { planned: 900, stopped: true }), 240),
      ...render(found([mutant('notRun')]), null),
      ...render(found([], { noTests: true }), null),
      ...render(found([], { planned: 5, stopped: true }), 240),
    ];
    for (const line of lines.filter((l) => !l.startsWith('- '))) expect(line.length, line).toBeLessThan(72);
  });
});

describe('removing the sandbox', () => {
  // A process that has just exited can still hold a file open for a moment.
  it('retries before it gives up', () => {
    const calls: unknown[] = [];
    const rm = ((path: string, options: unknown) => { calls.push([path, options]); }) as unknown as typeof rmSync;
    expect(removeSandboxes('/repo', rm)).toBeNull();
    expect(calls).toEqual([[join('/repo', SANDBOXES), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }]]);
  });
});

describe('removing the sandbox, when the delete throws something that is not an Error', () => {
  it('still says why', () => {
    const odd = (() => { throw 'EBUSY'; }) as unknown as typeof rmSync;
    expect(removeSandboxes('/repo', odd)).toBe(`mutate: could not remove ${SANDBOXES}/ (EBUSY). It is gitignored, and the next run replaces it.`);
  });
});

describe('why a run failed, in plain words', () => {
  // Stryker's error says only "Something went wrong"; the reason is in its log.
  it('names a first pass that ran out of time, from the log', () => {
    const said = plainReason('Something went wrong in the initial test run', 'ERROR DryRunExecutor Initial test run timed out!');
    expect(said).toMatch(/^Stryker's first pass over the tests, before any mutant is planted, ran past Stryker's own time limit\./);
    expect(said).toMatch(/\n\(Stryker: Something went wrong in the initial test run\)$/);
  });

  it('names a test that failed in the first pass', () => {
    expect(plainReason('There were failed tests in the initial test run.', '')).toMatch(/^A test failed in Stryker's first pass/);
  });

  it('names a test file that could not run in the first pass', () => {
    const said = plainReason('Something went wrong in the initial test run', 'One or more tests resulted in an error:\n\tSyntaxError');
    expect(said).toMatch(/^A test file could not run in Stryker's first pass/);
  });

  it('passes any other failure on as Stryker said it', () => {
    expect(plainReason('Please correct these configuration errors', 'whatever')).toBe('Please correct these configuration errors');
  });
});
