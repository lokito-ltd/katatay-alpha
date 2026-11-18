import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AdapterError, compileErrorsIn, errorLines, globToRegExp, matchesAcceptance, matchesSlow, matchesTests, matcher, parseAdapter, readAdapter, runCompile,
  runMutate, MUTATE_EXITS,
} from './adapter.mjs';
import { TargetError } from './target.mjs';
import { writeConfig } from '../../tests/fixtures/workflow/adapter.mjs';

/**
 * A section that keeps the contract, with `over` replacing its keys. Written
 * here rather than read from this repository's rulebook, so a change to the
 * project's own values never fails a test of the referee's rules.
 */
const CONTRACT = {
  paths: { all: ['**/*.test.ts'], acceptance: ['**/acceptance/**'], support: ['tests/**'] },
  codePaths: ['**/*.ts'],
  run: { command: 'npm test', reportPaths: ['reports/junit/*.xml'], tagComment: '^\\s*//' },
  compile: { command: 'node compile.mjs', pattern: '^(?<file>[^:\\n]+):(?<line>\\d+): (?<message>.*)$', exitCodes: { 0: 'clean', 1: 'errors' } },
};
const section = (over = {}) => {
  const { paths, run, codePaths, compile } = { ...structuredClone(CONTRACT), ...over };
  return { tests: { paths, run }, code: { paths: codePaths, compile } };
};

const refusal = (adapter) => {
  try {
    parseAdapter(adapter);
  } catch (error) {
    return error;
  }
  throw new Error('expected the section to be refused');
};

describe('a glob', () => {
  it('matches across folders with **, zero folders included', () => {
    const re = globToRegExp('**/*.test.ts');
    expect(re.test('a.test.ts')).toBe(true);
    expect(re.test('src/workflow/a.test.ts')).toBe(true);
    expect(re.test('a.test.tsx')).toBe(false);
  });

  it('keeps * and ? inside one folder', () => {
    expect(globToRegExp('tools/*.ts').test('tools/a.ts')).toBe(true);
    expect(globToRegExp('tools/*.ts').test('tools/x/a.ts')).toBe(false);
    expect(globToRegExp('a?.ts').test('ab.ts')).toBe(true);
    expect(globToRegExp('a?.ts').test('a/.ts')).toBe(false);
  });

  it('takes either side of {a,b}', () => {
    const re = globToRegExp('**/*.test.{ts,tsx,mjs}');
    expect(['a.test.ts', 'a.test.tsx', 'a.test.mjs'].every((file) => re.test(file))).toBe(true);
    expect(re.test('a.test.js')).toBe(false);
  });

  it('matches everything under a folder with a trailing **, and not the folder\'s lookalikes', () => {
    const re = globToRegExp('tests/**');
    expect(re.test('tests/acceptance/support.ts')).toBe(true);
    expect(re.test('testsuite/x.ts')).toBe(false);
    expect(re.test('app/tests/x.ts')).toBe(false);
  });

  // A rule about which files are tests must not depend on a folder's name.
  it('matches dot files and dot folders like any other', () => {
    expect(globToRegExp('**/*.mjs').test('.claude/hooks/protect-paths.mjs')).toBe(true);
  });

  it('takes regular expression characters literally', () => {
    expect(globToRegExp('a.ts').test('aXts')).toBe(false);
    expect(globToRegExp('(x)+.ts').test('(x)+.ts')).toBe(true);
  });

  it('refuses ** that is not a whole folder, and unmatched braces', () => {
    expect(() => globToRegExp('a**')).toThrow(/whole path segment/);
    expect(() => globToRegExp('**a/b')).toThrow(/whole path segment/);
    expect(() => globToRegExp('{a,b')).toThrow(/unmatched "\{"/);
    expect(() => globToRegExp('a}')).toThrow(/unmatched "\}"/);
    expect(() => globToRegExp('')).toThrow(/non-empty/);
  });

  it('matches when any glob in a list does', () => {
    const matches = matcher(['tests/**', '**/*.test.ts']);
    expect(matches('tests/x.sql')).toBe(true);
    expect(matches('a.test.ts')).toBe(true);
    expect(matches('a.ts')).toBe(false);
  });
});

/**
 * Every key is required. A language without a step writes "none", and nothing
 * is left to a default: a key nobody wrote would decide what counts as checked.
 */
describe('the adapter section', () => {
  it('accepts a section that keeps the contract', () => {
    const adapter = parseAdapter(section());
    expect(adapter.testRun).toEqual({ command: CONTRACT.run.command, reports: CONTRACT.run.reportPaths,
      tagComment: CONTRACT.run.tagComment });
  });

  it('is refused when it is missing, as a TargetError so every entry point refuses alike', () => {
    const error = refusal(undefined);
    expect(error).toBeInstanceOf(AdapterError);
    expect(error).toBeInstanceOf(TargetError);
    expect(error.message).toMatch(/"tests.paths" must be an object/);
  });

  it('identifies the missing code paths when the rulebook has tests but no code section', () => {
    const { tests } = section();
    const error = refusal({ tests });
    expect(error).toBeInstanceOf(AdapterError);
    expect(error.message).toContain('"code.paths" must be a non-empty list of globs');
  });

  it('is refused when any key is missing', () => {
    for (const [parent, key] of [['tests', 'paths'], ['tests', 'run'], ['code', 'paths'], ['code', 'compile']]) {
      const config = section();
      delete config[parent][key];
      expect(refusal(config).message).toContain(`"${parent}.${key}"`);
    }
    const config = section();
    delete config.tests.paths.support;
    expect(refusal(config).message).toContain('"tests.paths.support"');
  });

  it('has no commands section and accepts an explicitly absent compiler', () => {
    expect(parseAdapter(section({ compile: 'none' }))).toMatchObject({ compile: 'none' });
    expect(parseAdapter(section())).not.toHaveProperty('commands');
  });

  // Whoever wrote them believes those commands decide what the tests say, and
  // nothing would run them.
  it('is refused for a test run with a key missing or malformed', () => {
    const run = (over) => refusal(section({ run: { ...CONTRACT.run, ...over } })).message;
    expect(refusal(section({ run: ['npm test'] })).message).toContain('there is no "tests.run"');
    expect(run({ command: '' })).toContain('"tests.run.command" must be the command that runs the tests');
    expect(run({ command: undefined })).toContain('"tests.run.command"');
    expect(run({ reportPaths: [] })).toContain('"tests.run.reportPaths" must be a non-empty list');
    expect(run({ reportPaths: 'reports/*.xml' })).toContain('"tests.run.reportPaths" must be a non-empty list');
    expect(run({ tagComment: '' })).toContain('"tests.run.tagComment" must be a regular expression');
    expect(run({ tagComment: '(' })).toContain('"tests.run.tagComment" is a malformed regular expression');
    expect(run({ reportPaths: ['reports/{a'] })).toMatch(/a glob is malformed/);
  });

  // The referee deletes what the report globs match before each run.
  it('is refused for a report glob that does not start with a folder named in full', () => {
    for (const glob of ['**/*.xml', '*.xml', 'report?.xml', '{a,b}/x.xml']) {
      expect(refusal(section({ run: { ...CONTRACT.run, reportPaths: [glob] } })).message, glob).toContain('must start with a folder named in full');
    }
    for (const glob of ['junit.xml', 'reports/junit/*.xml', 'target/surefire-reports/TEST-*.xml', 'build/test-results/**/*.xml']) {
      expect(parseAdapter(section({ run: { ...CONTRACT.run, reportPaths: [glob] } })).testRun.reports, glob).toEqual([glob]);
    }
  });

  it.each(['reporterFile', 'reportWriter'])('refuses the writer setting tests.run.%s', key => {
    expect(refusal(section({ run: { ...CONTRACT.run, [key]: 'tools/writer.ts' } })).message)
      .toContain(`unknown "tests.run.${key}"`);
  });

  it('is refused for an empty list of test globs, which would empty the freeze', () => {
    expect(refusal(section({ paths: { ...CONTRACT.paths, all: [] } })).message).toContain('"tests.paths.all" must be a non-empty list');
  });

  it('is refused for a malformed glob, rather than matching nothing later', () => {
    expect(refusal(section({ paths: { ...CONTRACT.paths, support: ['tests/{a'] } })).message).toMatch(/a glob is malformed/);
  });

  it('explains the required tests object for null and scalar settings', () => {
    for (const tests of [null, 'glob', 1, false]) {
      const error = refusal(section({ paths: tests }));
      expect(error).toBeInstanceOf(AdapterError);
      expect(error.message).toContain('"tests.paths" must be an object with all, acceptance and support glob lists');
    }
  });

});

describe('test file categories', () => {
  it('classifies acceptance and speed independently inside the set of test files', () => {
    const root = mkdtempSync(join(tmpdir(), 'categories-'));
    try {
      const tests = { all: ['**/*.spec'], acceptance: ['proof/**'], slow: ['**/perf/**'] };
      writeConfig(root, { adapter: { paths: tests } });
      const classify = (file) => [matchesTests(file, root), matchesAcceptance(file, root), matchesSlow(file, root)];
      expect(classify('x.spec')).toEqual([true, false, false]);
      expect(classify('proof/x.spec')).toEqual([true, true, false]);
      expect(classify('perf/x.spec')).toEqual([true, false, true]);
      expect(classify('proof/perf/x.spec')).toEqual([true, true, true]);
      expect(classify('proof/perf/helper')).toEqual([false, false, false]);
      writeConfig(root, { adapter: { paths: { ...tests, slow: undefined } } });
      expect(classify('proof/perf/x.spec')).toEqual([true, true, false]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('each key of the adapter section, broken alone', () => {
  const broken = (over) => refusal(section(over)).message;

  it('refuses a section that is not an object, and a config that is not one either', () => {
    for (const adapter of [null, 'x', 5, []]) expect(refusal(adapter).message, JSON.stringify(adapter)).toMatch(/"tests.paths" must be an object/);
    expect(() => parseAdapter(null)).toThrow(AdapterError);
    expect(() => parseAdapter(undefined)).toThrow(AdapterError);
  });

  it('says where the operator can read what the section needs', () => {
    expect(refusal(undefined).message).toMatch(/The operator sets the "tests" and "code" sections\. See src\/adapters\/README\.md\.$/);
  });

  it('refuses a glob list that is not a list of non-empty strings', () => {
    for (const value of ['**/*.ts', { a: 1 }, ['**/*.ts', 5], ['**/*.ts', ''], null]) {
      expect(broken({ codePaths: value })).toContain('"code.paths" must be');
      expect(broken({ paths: { ...CONTRACT.paths, support: value } })).toContain('"tests.paths.support" must be');
    }
  });

  it('takes an empty list where there may be none, and only there', () => {
    expect(() => parseAdapter(section({ paths: { ...CONTRACT.paths, support: [] } }))).not.toThrow();
    expect(broken({ codePaths: [] })).toContain('"code.paths" must be a non-empty list');
  });

  it('requires all and acceptance globs, and checks each slow glob when supplied', () => {
    for (const key of ['all', 'acceptance']) {
      for (const value of [undefined, null, [], 'x', ['']]) {
        expect(broken({ paths: { ...CONTRACT.paths, [key]: value } })).toContain(`"tests.paths.${key}" must be a non-empty list`);
      }
    }
    for (const slow of [null, 'x', [1], ['']]) {
      expect(broken({ paths: { ...CONTRACT.paths, slow } })).toContain('"tests.paths.slow" must be a list');
    }
    expect(broken({ paths: { ...CONTRACT.paths, smoke: [] } })).toContain('unknown "tests.paths.smoke"');
  });

  it('has no slow files when the slow list is omitted or empty', () => {
    for (const tests of [CONTRACT.paths, { ...CONTRACT.paths, slow: [] }]) {
      expect(parseAdapter(section({ paths: tests })).tests.slow).toEqual([]);
    }
  });

  it('refuses a malformed glob in every list it reads', () => {
    for (const over of [{ paths: { ...CONTRACT.paths, all: ['{a'] } }, { codePaths: ['a**'] }, { paths: { ...CONTRACT.paths, support: ['a}'] } }, { paths: { ...CONTRACT.paths, acceptance: ['{x'] } }, { paths: { ...CONTRACT.paths, slow: ['{x'] } }]) {
      expect(broken(over), JSON.stringify(over)).toMatch(/a glob is malformed/);
    }
  });
});

describe('a glob, at its edges', () => {
  it('refuses a glob that is not a string', () => {
    expect(() => globToRegExp(5)).toThrow(/non-empty string/);
    expect(() => globToRegExp(undefined)).toThrow(/non-empty string/);
  });

  // A comma means "or" only inside braces.
  it('takes a comma outside braces literally', () => {
    expect(globToRegExp('a,b').test('a,b')).toBe(true);
    expect(globToRegExp('a,b').test('a')).toBe(false);
  });
});

describe('reading the section at the edges', () => {
  let root;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-adapter-edges-')));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses a config that is not JSON', () => {
    mkdirSync(join(root, '.katatay'), { recursive: true });
    writeFileSync(join(root, '.katatay/rulebook.json'), '{ not json');
    expect(() => readAdapter(root)).toThrow(/is not readable as JSON/);
  });

  it('reports a blank test command as a configuration error with no timeout', async () => {
    writeConfig(root, { adapter: { run: { ...CONTRACT.run, command: ' ' } } });
    // The error factory is defined at module load. Import the public reader
    // and its error class together while this test is active under mutation.
    vi.resetModules();
    const reader = await import('./adapter.mjs');
    let failure;
    try { reader.readAdapter(root); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(reader.AdapterError);
    expect(failure.timedOut).toBe(false);
    expect(failure.message).toContain('"tests.run.command" must be the command that runs the tests');
    expect(failure.message).toContain('The operator sets the "tests" and "code" sections.');
  });

  // The rulebook's own problems reach this module as the rulebook's errors.
  // Every caller that stops on an `AdapterError` stops on these too.
  it('refuses a missing config, a config of another version and one that is not JSON as an AdapterError, keeping the rulebook\'s words', () => {
    const attempt = () => { try { readAdapter(root); } catch (error) { return error; } throw new Error('expected a refusal'); };
    expect(attempt()).toBeInstanceOf(AdapterError);
    expect(attempt().message).toMatch(/there is no \.katatay\/rulebook\.json/);
    mkdirSync(join(root, '.katatay'), { recursive: true });
    writeFileSync(join(root, '.katatay/rulebook.json'), JSON.stringify({ baseline: 'origin/main' }));
    expect(attempt()).toBeInstanceOf(AdapterError);
    expect(attempt().message).toMatch(/must specify "version"/);
    writeFileSync(join(root, '.katatay/rulebook.json'), '{ not json');
    expect(attempt()).toBeInstanceOf(AdapterError);
    expect(attempt().message).toMatch(/is not readable as JSON/);
  });

  // A failure that is not about the rulebook's contents is not dressed up as one.
  it('lets a failure to read the file through as it is', () => {
    mkdirSync(join(root, '.katatay/rulebook.json'), { recursive: true });
    let failure;
    try { readAdapter(root); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(AdapterError);
    expect(failure.code).toBe('EISDIR');
  });

  // Kept while the file is unchanged, so the freeze, which asks once per
  // file, does not parse it each time; read again once it changes, whatever
  // the change.
  it('keeps the parsed section while the file is unchanged, and reads it again when its size or time changes', () => {
    writeConfig(root);
    const first = readAdapter(root);
    expect(readAdapter(root)).toBe(first);

    const path = join(root, '.katatay/rulebook.json');
    const text = readFileSync(path, 'utf8');
    const { mtime } = statSync(path);
    writeFileSync(path, text.replace('"targetBranch": "origin/main"', '"targetBranch": "origin/next"'));
    utimesSync(path, mtime, mtime);
    expect(readAdapter(root)).not.toBe(first);

    const second = readAdapter(root);
    writeFileSync(path, text);
    utimesSync(path, new Date(mtime.getTime() + 5000), new Date(mtime.getTime() + 5000));
    expect(readAdapter(root)).not.toBe(second);
  });

});

describe('the lines kept from a failed command', () => {
  // A crash names its cause on the first line and then prints a stack; the
  // last lines of the stack say only where it happened.
  it('keeps the first line and the last ones when there are more than it keeps', () => {
    expect(errorLines('Error: the cause\n  at a\n  at b\n  at c\n  at d\n  at e', 4)).toBe('Error: the cause\n…\n  at c\n  at d\n  at e');
  });

  it('keeps every line when there are few enough, and drops blank ones', () => {
    expect(errorLines('one\n\ntwo\n')).toBe('one\ntwo');
    expect(errorLines('a\nb\nc\nd\ne')).toBe('a\nb\nc\nd\ne');
  });

  it('is empty for nothing', () => {
    expect(errorLines('')).toBe('');
    expect(errorLines(null)).toBe('');
    expect(errorLines(undefined)).toBe('');
  });
});

/**
 * The compile step: the rulebook's command, a pattern for its errors, and what
 * each exit code means. See "Compile" in `src/adapters/README.md`.
 */
describe('the compile step in the rulebook', () => {
  const compile = (over) => ({ ...CONTRACT.compile, ...over });
  const broken = (value) => refusal(section({ compile: value })).message;

  it('takes a command, a pattern and what each exit code means', () => {
    expect(parseAdapter(section()).compile).toEqual(CONTRACT.compile);
    const crashes = compile({ exitCodes: { 0: 'clean', 1: 'errors', 2: 'broken', 255: 'broken' } });
    expect(parseAdapter(section({ compile: crashes })).compile.exitCodes).toEqual(crashes.exitCodes);
  });

  it('includes both endpoints of each compile range and leaves gaps unlisted', async () => {
    // Exercise the parser from module load, including its exported function binding.
    vi.resetModules();
    const adapter = await import('./adapter.mjs');
    const ranges = compile({ exitCodes: { '0-1': 'clean', '252-254': 'errors', '255-255': 'broken' } });
    expect(adapter.parseAdapter(section({ compile: ranges })).compile.exitCodes)
      .toEqual({ 0: 'clean', 1: 'clean', 252: 'errors', 253: 'errors', 254: 'errors', 255: 'broken' });
  });

  it('refuses overlapping compile entries even when they assign the same meaning', () => {
    for (const overlap of [{ 2: 'broken' }, { '2-4': 'errors' }]) {
      const error = refusal(section({ compile: compile({ exitCodes: { 0: 'clean', '1-2': 'errors', ...overlap } }) }));
      expect(error).toBeInstanceOf(AdapterError);
      expect(error.message).toContain('"code.compile.exitCodes" names exit 2 twice');
    }
  });

  it('is refused when it is neither an entry nor none', () => {
    for (const value of [undefined, null, 'tsc', [], 5]) expect(broken(value), JSON.stringify(value)).toContain('there is no "code.compile"');
  });

  it('is refused without a command', () => {
    for (const command of [undefined, '', '   ', 5]) expect(broken(compile({ command })), JSON.stringify(command)).toContain('"code.compile.command" must be');
  });

  it('is refused for a pattern that is missing, malformed, or lacks the file or the message', () => {
    for (const pattern of [undefined, '', 5]) expect(broken(compile({ pattern })), JSON.stringify(pattern)).toContain('"code.compile.pattern" must be');
    expect(broken(compile({ pattern: '(?<file>' }))).toContain('"code.compile.pattern" is a malformed regular expression');
    expect(broken(compile({ pattern: '^(?<path>\\S+): (?<message>.*)$' }))).toContain('has no named group "file"');
    expect(broken(compile({ pattern: '^(?<file>\\S+): (?<text>.*)$' }))).toContain('has no named group "message"');
    // The line is optional: a compiler that names no line still names a file.
    expect(() => parseAdapter(section({ compile: compile({ pattern: '^(?<file>\\S+): (?<message>.*)$' }) }))).not.toThrow();
  });

  // A list said which codes were fine and not what each meant, so it is
  // refused rather than read as a guess.
  it('is refused for exit codes that are not a map of code to meaning', () => {
    for (const exitCodes of [undefined, null, [0, 1], 'clean']) {
      expect(broken(compile({ exitCodes })), JSON.stringify(exitCodes)).toContain('"code.compile.exitCodes" must map each exit code, or a range such as "1-255", to what it means: clean, errors, broken');
    }
  });

  it('is refused for a key that is not an exit code, or a meaning it does not know', () => {
    for (const key of ['-1', '256', '1.5', 'one', '01', '', '3-1', '1-256', '1-', '01-2']) {
      expect(broken(compile({ exitCodes: { 0: 'clean', 1: 'errors', [key]: 'broken' } })), key).toContain(`names ${JSON.stringify(key)}, which is not an exit code from 0 to 255`);
    }
    for (const meaning of ['findings', 'failed', 'crash', 'Clean', 0, null]) {
      expect(broken(compile({ exitCodes: { 0: 'clean', 1: 'errors', 2: meaning } })), JSON.stringify(meaning))
        .toContain(`says "2" means ${JSON.stringify(meaning)}, which is not one of clean, errors, broken`);
    }
    expect(() => parseAdapter(section({ compile: compile({ exitCodes: { 0: 'clean', 255: 'errors' } }) }))).not.toThrow();
  });

  // Without a code for each, a clean run and a run with errors look the same.
  // Whoever wrote it believes that command decides what compiles, and nothing
  // would run it.

  it('is refused without a code that means clean, or one that means errors', () => {
    expect(broken(compile({ exitCodes: { 1: 'errors' } }))).toContain('has no code that means "clean"');
    expect(broken(compile({ exitCodes: { 0: 'clean', 2: 'broken' } }))).toContain('has no code that means "errors"');
  });
});

describe('reading a compiler\'s output', () => {
  const ONE_LINE = { pattern: CONTRACT.compile.pattern };

  it('reads the file, the line and the message of each error, and nothing else', () => {
    expect(compileErrorsIn('a.ts:3: bad\nFound 2 errors.\nb.test.ts:7: worse\n', ONE_LINE, '/repo')).toEqual([
      { file: 'a.ts', line: 3, message: 'bad' },
      { file: 'b.test.ts', line: 7, message: 'worse' },
    ]);
  });

  it('gives line 0 when the pattern has no line', () => {
    expect(compileErrorsIn('a.ts: error: x\n', { pattern: '^(?<file>\\S+): error: (?<message>.*)$' }, '/repo')).toEqual([{ file: 'a.ts', line: 0, message: 'x' }]);
  });

  // A pattern loose enough to catch something that is not a line number
  // places the error in its file and no closer, rather than at a line NaN.
  it('gives line 0 when what the line group caught is not a whole number', () => {
    const pattern = '^(?<file>[^:\\n]+):(?<line>[^:\\n]*): (?<message>.*)$';
    expect(compileErrorsIn('a.ts:12: x\nb.ts:3x: y\nc.ts:x3: z\nd.ts:: w\n', { pattern }, '/repo').map((e) => e.line)).toEqual([12, 0, 0, 0]);
  });

  it('trims the file and the message it caught', () => {
    expect(compileErrorsIn('  a.ts :3:  bad   \n', { pattern: '^(?<file>[^:\\n]+):(?<line>\\d+):(?<message>.*)$' }, '/repo'))
      .toEqual([{ file: 'a.ts', line: 3, message: 'bad' }]);
  });

  // rustc's default format puts the message on one line and the file on the next.
  it('reads a pattern that spans lines', () => {
    const output = 'error[E0425]: cannot find value `x`\n  --> src/main.rs:2:5\n   |\n';
    const pattern = '^error(?:\\[E\\d+\\])?: (?<message>.*)\\n\\s*--> (?<file>[^:\\n]+):(?<line>\\d+)';
    expect(compileErrorsIn(output, { pattern }, '/repo')).toEqual([{ file: 'src/main.rs', line: 2, message: 'cannot find value `x`' }]);
  });

  it('strips colour codes and reads \\r\\n as a line end', () => {
    expect(compileErrorsIn('\x1b[31ma.ts\x1b[0m:3: bad\r\nb.ts:4: worse\r\n', ONE_LINE, '/repo')).toEqual([
      { file: 'a.ts', line: 3, message: 'bad' },
      { file: 'b.ts', line: 4, message: 'worse' },
    ]);
  });

  it('makes paths relative to the repository root with /, and keeps one outside it as printed', () => {
    const output = './a.ts:1: x\nsrc\\b.ts:2: y\n/repo/c.ts:3: z\n/elsewhere/d.ts:4: w\n/repo:5: v\n';
    // The root itself is no file inside it, so it is kept as printed.
    expect(compileErrorsIn(output, ONE_LINE, '/repo').map((e) => e.file)).toEqual(['a.ts', 'src/b.ts', 'c.ts', '/elsewhere/d.ts', '/repo']);
  });

  // On macOS a temporary folder is /var/… to one tool and /private/var/… to another.
  it('takes an absolute path under the root\'s real path as inside the repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'workflow-compile-paths-'));
    try {
      const printed = `${join(realpathSync(root), 'src', 'a.ts')}:1: x\n`;
      expect(compileErrorsIn(printed, ONE_LINE, root).map((e) => e.file)).toEqual(['src/a.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a match with no file, which no one can place', () => {
    expect(() => compileErrorsIn('oops\n', { pattern: '^(?<file>x)?(?<message>oops)$' }, '/repo'))
      .toThrow(/matched "oops" without a file\. Every error needs one, so the referee can tell an error in a test from one in the implementation/);
    expect(() => compileErrorsIn('  oops\n', { pattern: '^(?<file> *)(?<message>oops)$' }, '/repo')).toThrow(/matched " {2}oops" without a file/);
  });
});

describe('running the compile step', () => {
  let root;
  const node = (code) => `node -e ${JSON.stringify(code)}`;
  const configure = (command, exitCodes = CONTRACT.compile.exitCodes) =>
    writeConfig(root, { adapter: { compile: { ...CONTRACT.compile, command, exitCodes } } });

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-compile-')));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('gives the errors the pattern finds when the exit code means errors', () => {
    configure(node('console.log("a.ts:3: bad"); console.log("Found 1 error."); process.exitCode = 1'));
    expect(runCompile({ root })).toEqual({ errors: [{ file: 'a.ts', line: 3, message: 'bad' }] });
  });

  it('reports a compiler diagnostic when the process exits inside an errors range', () => {
    configure(node('console.log("a.ts:3: bad"); process.exitCode = 17'), { 0: 'clean', '1-255': 'errors' });
    expect(runCompile({ root })).toEqual({ errors: [{ file: 'a.ts', line: 3, message: 'bad' }] });
  });

  it('gives no errors when the exit code means clean', () => {
    configure(node('console.log("all good")'));
    expect(runCompile({ root })).toEqual({ errors: [] });
  });

  // javac, rustc and go print their errors to stderr; tsc and mypy to stdout.
  it('reads stderr as well as stdout', () => {
    configure(node('console.log("a.ts:1: out"); console.error("b.ts:2: err"); process.exitCode = 1'));
    expect(runCompile({ root }).errors.map((e) => e.file)).toEqual(['a.ts', 'b.ts']);
  });

  it('runs from the repository root', () => {
    writeFileSync(join(root, 'out.txt'), 'here.ts:1: x\n');
    configure(node('process.stdout.write(require("fs").readFileSync("out.txt", "utf8")); process.exitCode = 1'));
    expect(runCompile({ root }).errors.map((e) => e.file)).toEqual(['here.ts']);
  });

  it('refuses when the exit code means clean and the pattern finds errors anyway', () => {
    configure(node('console.log("a.ts:3: bad")'));
    expect(() => runCompile({ root })).toThrow(/exited with 0, which means clean, and "code\.compile\.pattern" found 1 error\(s\).*disagree/s);
  });

  // tsc exits 1 for a type error, and also for a project it cannot find.
  it('refuses when the exit code means errors and the pattern finds none, and shows what the compiler said', () => {
    configure(node('console.log("error TS5058: The specified path does not exist"); process.exitCode = 1'));
    const run = () => runCompile({ root });
    expect(run).toThrow(AdapterError);
    expect(run).toThrow(/exited with 1, which means it found errors, and "code\.compile\.pattern" matched none/);
    expect(run).toThrow(/error TS5058: The specified path does not exist/);
    expect(run).toThrow(/Either the pattern does not fit what the compiler prints, or the compiler broke and exited with the same code/);
  });

  // A compiler can print far more than a pipe's default buffer, and one cut
  // off there would be read as a broken compiler. The stub sets its exit code
  // rather than calling `process.exit`, which drops stdout not yet written to
  // a pipe: under a full run's load that lost 2,100 of these lines.
  it('reads every error of a long output', () => {
    configure(node('for (let i = 1; i <= 20000; i++) console.log("src/file" + i + ".ts:" + i + ": an error long enough to fill the buffer"); process.exitCode = 1'));
    const { errors } = runCompile({ root });
    expect(errors).toHaveLength(20000);
    expect(errors.at(-1)).toEqual({ file: 'src/file20000.ts', line: 20000, message: 'an error long enough to fill the buffer' });
  });

  it('refuses a code the rulebook says means broken', () => {
    configure(node('console.error("internal error"); process.exitCode = 2'), { 0: 'clean', 1: 'errors', 2: 'broken' });
    expect(() => runCompile({ root })).toThrow(/exited with 2, which "code\.compile\.exitCodes" says means broken.*\n.*internal error/s);
  });

  // Exit 2 and exit 134 are the same to the referee when neither is listed.
  it('refuses a code the rulebook does not list, as broken', () => {
    configure(node('console.log("a.ts:3: bad"); process.exitCode = 7'));
    const run = () => runCompile({ root });
    expect(run).toThrow(AdapterError);
    expect(run).toThrow(/exited with 7, which "code\.compile\.exitCodes" does not list, so it means broken\. That is the compiler failing, not a result/);
  });

  it('adds nothing after the reason when the compiler printed nothing', () => {
    configure(node('process.exit(7)'));
    expect(() => runCompile({ root })).toThrow(/so nothing was concluded from it\.$/);
  });

  it('refuses a command stopped by a signal', () => {
    configure('kill -KILL $$');
    expect(() => runCompile({ root })).toThrow(/was stopped by SIGKILL/);
  });

  it('gives null when the language has no compile step', () => {
    writeConfig(root, { adapter: { compile: 'none' } });
    expect(runCompile({ root })).toBeNull();
  });
});

describe('running the mutation command', () => {
  let root;
  const node = (code) => `node -e ${JSON.stringify(code)}`;
  let command;
  const configure = (value) => { command = value; };
  const request = { targets: [{ file: 'src/[id]/page.ts', lines: [1, 2] }], budget: 30, verbose: false };
  const run = (options = {}) => runMutate({ command, root, input: request, keepErrors: true, ...options });
  const thrown = async (act) => {
    try {
      await act();
    } catch (error) {
      return error;
    }
    throw new Error('expected it to throw');
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-mutate-')));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads 0 as clean, 1 as survived and 2 as nothing, with the text it printed', async () => {
    for (const [code, outcome] of [[0, 'clean'], [1, 'survived'], [2, 'nothing']]) {
      configure(node(`console.log("it said ${code}\\n"); process.exitCode = ${code}`));
      expect(await run(), String(code)).toEqual({ outcome, text: `it said ${code}` });
    }
    expect(MUTATE_EXITS).toEqual({ 0: 'clean', 1: 'survived', 2: 'nothing' });
  });

  // The paths would need shell quoting as arguments.
  it('gives the command the request on stdin, as JSON', async () => {
    configure(node('process.stdout.write(require("fs").readFileSync(0, "utf8"))'));
    expect(JSON.parse((await run()).text)).toEqual(request);
  });

  it('runs from the repository root', async () => {
    writeFileSync(join(root, 'here.txt'), 'found\n');
    configure(node('process.stdout.write(require("fs").readFileSync("here.txt", "utf8"))'));
    expect((await run()).text).toBe('found');
  });

  it('is refused with any other exit code, as a crash, with the end of its errors', async () => {
    configure(node('console.log("x"); console.error("it broke"); process.exitCode = 3'));
    const error = await thrown(() => run());
    expect(error).toBeInstanceOf(AdapterError);
    expect(error.message).toContain('exited with 3, which means it crashed');
    expect(error.message.split('\n').at(-1)).toBe('it broke');
  });

  // Node exits 1 on an uncaught error, which would read as "mutants survived".
  it('is refused when it printed nothing, whatever its code', async () => {
    for (const code of [0, 1, 2]) {
      configure(node(`console.error("died"); process.exitCode = ${code}`));
      expect((await thrown(() => run())).message, String(code)).toContain(`exited with ${code} and printed nothing`);
    }
    configure(node('console.log("   \\n")'));
    expect((await thrown(() => run())).message).toContain('printed nothing');
  });

  it('is refused when a signal stopped it', async () => {
    configure('kill -TERM $$');
    expect((await thrown(() => run())).message).toContain('was stopped by SIGTERM');
  });

  it('accepts a command that finishes within its budget even if it closes stdin early', async () => {
    configure(node('setTimeout(() => console.log("finished"), 50)'));
    expect(await run({ input: 'x'.repeat(2_000_000), timeout: 5 })).toEqual({ outcome: 'clean', text: 'finished' });
  });

  it('reports a startup failure when the working directory disappeared', async () => {
    configure('echo result');
    await expect(run({ root: join(root, 'missing') })).rejects.toThrow(/could not be run.*ENOENT/);
  });

  it('does not capture stderr in the returned error when the caller wants live diagnostics', async () => {
    configure(node('console.error("live-only"); process.exit(4)'));
    const error = await thrown(() => run({ keepErrors: false }));
    expect(error.message).toContain('exited with 4');
    expect(error.message).not.toMatch(/\nlive-only/);
  });
});
