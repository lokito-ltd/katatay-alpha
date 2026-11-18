import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { writeConfig } from '../../tests/fixtures/workflow/adapter.mjs';
import { taggedTests } from './tags.js';
import { applyPrediction } from './predicted.js';
import { AdapterError } from '../workflow/adapter.mjs';
import { clearReports, outcomesOf, readTestRun, reportedPathInRepo, reportFiles, runTestCommand, type TestRun } from './test-run.js';

/**
 * The test run, read from the JUnit reports in a fixture repository. The
 * reports are written by hand, so each case says exactly what a runner wrote.
 */
describe('the test run', () => {
  const cwd = process.cwd();
  let root: string;

  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  /** A report holding these test cases, as `<testcase>` elements. */
  const report = (cases: string, name = 'run.xml') => write(`reports/${name}`, `<testsuites><testsuite>${cases}</testsuite></testsuites>`);
  const configure = (testRun: Record<string, unknown> = {}) => writeConfig(root, {
    adapter: { paths: { all: ['**/*.test.{ts,py}'], acceptance: ['a.test.*', 'b.test.ts'] }, run: { command: 'true', reportPaths: ['reports/*.xml'], tagComment: '^\\s*#', ...testRun } },
  });
  const refusal = (read: () => unknown): string => {
    try {
      read();
    } catch (error) {
      expect(error).toBeInstanceOf(AdapterError);
      return (error as Error).message;
    }
    throw new Error('expected a refusal');
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'test-run-')));
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    write('.gitignore', 'reports/\n');
    write('a.test.ts', "it('one', () => {});\n");
    configure();
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  });

  describe('which file a test case is in', () => {
    it('is the file the report names, on the test case or as a property', () => {
      write('b.test.ts', '');
      report('<testcase name="one" file="a.test.ts"/><testcase name="two"><properties><property name="file" value="b.test.ts"/></properties></testcase>');
      expect(readTestRun().cases.map((c) => [c.name, c.file])).toEqual([['one', 'a.test.ts'], ['two', 'b.test.ts']]);
    });

    it('is taken from the root when the report gives it as an absolute path or with ./', () => {
      report(`<testcase name="one" file="${join(root, 'a.test.ts')}"/><testcase name="two" file="./a.test.ts"/>`);
      expect(readTestRun().cases.map((c) => c.file)).toEqual(['a.test.ts', 'a.test.ts']);
    });

    it('reads a path written with backslashes, as a runner on Windows writes it', () => {
      write('sub/b.test.ts', '');
      report('<testcase name="one" file="sub\\b.test.ts"/>');
      expect(readTestRun().cases.map((c) => c.file)).toEqual(['sub/b.test.ts']);
    });

    it('keeps nested paths on Windows and refuses an absolute path on another drive', () => {
      expect(reportedPathInRepo('C:/repo/tests/a.test.ts', 'C:/repo', win32)).toBe('tests/a.test.ts');
      expect(reportedPathInRepo('D:/repo/tests/a.test.ts', 'C:/repo', win32)).toBeNull();
    });

    // A test case that cannot be placed cannot be told apart from one made up.
    it('is refused when the report names a file outside the repository, or one that does not exist', () => {
      report('<testcase name="one" file="../elsewhere.test.ts"/>');
      expect(refusal(() => readTestRun())).toMatch(/"one" names the file \.\.\/elsewhere\.test\.ts, which is outside the repository/);
      report(`<testcase name="one" file="${root}"/>`);
      expect(refusal(() => readTestRun())).toMatch(/"one" names the file .*, which is outside the repository/);
      report('<testcase name="one" file=".."/>');
      expect(refusal(() => readTestRun())).toContain('"one" names the file .., which is outside the repository');
      report('<testcase name="one" file="gone.test.ts"/>');
      expect(refusal(() => readTestRun())).toMatch(/"one" names the file gone\.test\.ts, which does not exist/);
    });

    it('refuses a reported file outside tests.all, even when it exists', () => {
      write('helper.ts', '');
      report('<testcase name="unexpected"><properties><property name="file" value="helper.ts"/></properties></testcase>');
      expect(refusal(() => readTestRun())).toContain('reports/run.xml: "unexpected" names helper.ts, which is outside "tests.paths.all"');
    });

    it('is the one test file that holds the test\'s name, when the report names none', () => {
      write('b.test.ts', "it('two', () => {});\n");
      report('<testcase name="area &gt; two"/>');
      expect(readTestRun().cases.map((c) => c.file)).toEqual(['b.test.ts']);
    });

    it('is refused, naming the test, when no test file holds its name, or several do', () => {
      report('<testcase name="nowhere"/>');
      expect(refusal(() => readTestRun())).toMatch(/the report names no file for "nowhere", and no test file holds its name/);
      write('b.test.ts', "it('one', () => {});\n");
      report('<testcase name="one"/>');
      expect(refusal(() => readTestRun())).toMatch(/the report names no file for "one", and 2 test files hold its name \(a\.test\.ts, b\.test\.ts\)\. Have/);
    });

    it('names only the first five of many files that hold the name', () => {
      for (const n of [1, 2, 3, 4, 5, 6]) write(`t${n}.test.ts`, "it('one', () => {});\n");
      report('<testcase name="one"/>');
      expect(refusal(() => readTestRun())).toContain('and 7 test files hold its name (a.test.ts, t1.test.ts, t2.test.ts, t3.test.ts, t4.test.ts, …). Have the report name its file');
    });

    // An untracked test is still a test: one just written counts before it is
    // staged.
    it('is looked for among untracked test files too, and never among ignored ones', () => {
      write('new.test.ts', "it('fresh', () => {});\n");
      write('reports/old.test.ts', "it('fresh', () => {});\n");
      report('<testcase name="fresh"/>');
      expect(readTestRun().cases.map((c) => c.file)).toEqual(['new.test.ts']);
    });

    it('finds cases from the supplied repository root and ignores tracked files removed from disk', () => {
      write('removed.test.ts', "it('one', () => {});");
      execFileSync('git', ['add', 'removed.test.ts'], { cwd: root });
      rmSync(join(root, 'removed.test.ts'));
      report('<testcase name="one"/>');
      process.chdir(join(root, 'reports'));
      const run = readTestRun(root);
      expect(run.cases.map((c) => c.file)).toEqual(['a.test.ts']);
      expect(run.leftOut).toEqual([]);
    });
  });

  describe('the tags a test case carries', () => {
    it('ignores every tag source in ordinary files but keeps their failures predictable by file', () => {
      write('ordinary.test.ts', '# [AC0404.1]\nworks');
      write('missing.test.ts', 'a lost [INV0404]');
      report(`<testcase file="a.test.ts" name="works [AC0001.1]"/>
        <testcase file="ordinary.test.ts" name="works [AC0001.1]"><failure/></testcase>
        <testcase file="ordinary.test.ts" name="works"><properties>
          <property name="scenario" value="malformed"/><property name="line" value="2"/><property name="endLine" value="2"/>
        </properties></testcase><testcase file="ordinary.test.ts" name="works"/>`);
      const run = readTestRun();
      expect(run.cases.slice(1).map((c) => [c.ids, c.scenarios, c.bare])).toEqual(Array(3).fill([[], [], []]));
      expect(run.leftOut).toEqual([{ file: 'missing.test.ts', ids: [], scenarios: [], bare: [] }]);
      const outcomes = outcomesOf(run);
      const scenario = applyPrediction(['AC0001.1'], outcomes);
      expect(outcomes.filter(scenario.isPredicted).map((c) => c.file)).toEqual(['a.test.ts']);
      for (const file of ['ordinary.test.ts', 'missing.test.ts']) {
        expect(outcomes.filter(applyPrediction([file], outcomes).isPredicted).some((c) => c.failed)).toBe(true);
      }
    });

    it('come from its name when the name holds one', () => {
      report('<testcase name="area &gt; does it [AC0001.2]" file="a.test.ts"/>');
      expect(readTestRun().cases[0]).toMatchObject({ ids: ['AC0001'], scenarios: ['AC0001.2'], bare: [] });
    });

    it('come from the reporter\'s scenario properties when the name holds none', () => {
      report('<testcase name="test_it" file="a.test.ts"><properties><property name="scenario" value="AC0001.2"/><property name="scenario" value="INV0003"/></properties></testcase>');
      expect(readTestRun().cases[0]).toMatchObject({ ids: ['AC0001', 'INV0003'], scenarios: ['AC0001.2'], bare: ['INV0003'] });
    });

    it('come from the comment lines directly above the test, at the line the reporter gives', () => {
      write('a.test.py', '# [AC0001.1]\n# [INV0002]\ndef test_it():\n    pass\n');
      report('<testcase name="test_it" file="a.test.py"><properties><property name="line" value="3"/><property name="endLine" value="4"/></properties></testcase>');
      configure({ tagComment: '^\\s*#' });
      expect(readTestRun().cases[0]).toMatchObject({ scenarios: ['AC0001.1'], bare: ['INV0002'], line: 3, endLine: 4 });
    });

    it('come from the comment above the one line that holds the name, when no line is given', () => {
      write('a.test.py', 'import x\n# [AC0001.1]\ndef test_it():\n    pass\n');
      report('<testcase name="tests/a.test.py::test_it" file="a.test.py"/>');
      expect(readTestRun().cases[0]!.scenarios).toEqual(['AC0001.1']);
    });

    // Only comment lines directly above count, read upward until one is not.
    it('stop at the first line above that is not a comment', () => {
      write('a.test.py', '# [AC0009.1]\nx = 1\n# [AC0001.1]\ndef test_it():\n    pass\n');
      report('<testcase name="test_it" file="a.test.py"/>');
      expect(readTestRun().cases[0]!.scenarios).toEqual(['AC0001.1']);
    });

    // The referee never guesses which line is the test.
    it('are none when the name is on several lines and no line is given', () => {
      write('a.test.py', '# [AC0001.1]\ndef test_it():\n    test_it()\n');
      report('<testcase name="test_it" file="a.test.py"/>');
      expect(readTestRun().cases[0]!.ids).toEqual([]);
    });
  });

  describe('the reporter\'s properties', () => {
    it('give the lines a test spans and whether it is inverted', () => {
      report(`<testcase name="one" file="a.test.ts"><properties>
        <property name="line" value="1"/><property name="endLine" value="1"/><property name="inverted" value="true"/>
      </properties></testcase><testcase name="two" file="a.test.ts"><properties><property name="inverted" value="false"/></properties></testcase>`);
      const [one, two] = readTestRun().cases;
      expect(one).toMatchObject({ line: 1, endLine: 1, inverted: true });
      expect(two!.inverted).toBe(false);
      expect(two).not.toHaveProperty('line');
      expect(two).not.toHaveProperty('endLine');
    });

    it('take a line range of several digits', () => {
      report('<testcase name="one" file="a.test.ts"><properties><property name="line" value="10"/><property name="endLine" value="120"/></properties></testcase>');
      expect(readTestRun().cases[0]).toMatchObject({ line: 10, endLine: 120 });
    });

    it('are refused when malformed, as a broken reporter is the test run failing', () => {
      const withProperties = (properties: string) => report(`<testcase name="one" file="a.test.ts"><properties>${properties}</properties></testcase>`);
      const cases: [string, RegExp][] = [
        ['<property name="line" value="2"/>', /"one" has "line" without "endLine"/],
        ['<property name="endLine" value="2"/>', /"one" has "endLine" without "line"/],
        ['<property name="line" value="x"/><property name="endLine" value="2"/>', /^test run: the test report reports\/run\.xml: "one" has line "x" to "2", which is not a range of lines/],
        ['<property name="line" value="2x"/><property name="endLine" value="3"/>', /line "2x" to "3"/],
        ['<property name="line" value="x2"/><property name="endLine" value="3"/>', /line "x2" to "3"/],
        ['<property name="line" value="1"/><property name="endLine" value="1.5"/>', /line "1" to "1\.5"/],
        ['<property name="line" value="0"/><property name="endLine" value="2"/>', /line "0" to "2"/],
        ['<property name="line" value="5"/><property name="endLine" value="2"/>', /line "5" to "2"/],
        ['<property name="inverted" value="yes"/>', /"inverted" "yes", which is neither true nor false/],
        ['<property name="scenario" value="AC1"/>', /"scenario" "AC1", which is not a requirement or scenario id/],
        ['<property name="line" value="1"/><property name="line" value="2"/><property name="endLine" value="2"/>', /"one" has the property "line" 2 times/],
      ];
      for (const [properties, message] of cases) {
        withProperties(properties);
        expect(refusal(() => readTestRun()), properties).toMatch(message);
      }
    });

    it('uses each passing case as requirement evidence according to its own inverted property', () => {
      report(`<testcase name="one [AC0001.1]" file="a.test.ts"><properties><property name="inverted" value="true"/></properties></testcase>
        <testcase name="two [AC0001.2]" file="a.test.ts"><properties><property name="inverted" value="false"/></properties></testcase>
        <testcase name="three [AC0001.3]" file="a.test.ts"/>`);
      const run = readTestRun();
      expect(run).not.toHaveProperty('reported');
      expect(taggedTests(run).map(test => [test.scenarios, test.notEvidence])).toEqual([
        [['AC0001.1'], 'inverted'], [['AC0001.2'], null], [['AC0001.3'], null],
      ]);
    });
  });

  describe('a test file the report leaves out', () => {
    // A file that failed to load, or that the run never reached. Its tags are
    // found by searching its whole text, because no test case carries them.
    it('is listed with every tag in its text', () => {
      write('b.test.ts', "it('kept [AC0002.1]', () => {});\nconst fixture = 'x [INV0004]';\n");
      report('<testcase name="one" file="a.test.ts"/>');
      expect(readTestRun().leftOut).toEqual([{ file: 'b.test.ts', ids: ['AC0002', 'INV0004'], scenarios: ['AC0002.1'], bare: ['INV0004'] }]);
    });

    it('is any file the test globs match, and nothing else', () => {
      write('notes.md', '[AC0003.1]');
      write('helper.ts', "it('x [AC0003.1]')");
      report('<testcase name="one" file="a.test.ts"/>');
      expect(readTestRun().leftOut).toEqual([]);
    });
  });

  describe('reading the reports', () => {
    it('reads every report the globs match, in order', () => {
      write('b.test.ts', '');
      report('<testcase name="from b" file="b.test.ts"/>', 'b.xml');
      report('<testcase name="from a" file="a.test.ts"/>', 'a.xml');
      write('reports/notes.txt', 'not a report');
      expect(reportFiles()).toEqual(['reports/a.xml', 'reports/b.xml']);
      expect(readTestRun().cases.map((c) => c.name)).toEqual(['from a', 'from b']);
    });

    it('refuses to read the last run when there is no report, and says to run the tests', () => {
      expect(refusal(() => readTestRun())).toMatch(/there is no test report at reports\/\*\.xml\. Run the tests first/);
      configure({ reportPaths: ['reports/*.xml', 'junit.xml'] });
      expect(refusal(() => readTestRun())).toMatch(/there is no test report at reports\/\*\.xml, junit\.xml\./);
    });

    // pytest and gotestsum write one file, named in full.
    it('reads a report named by a path with no wildcard', () => {
      write('junit.xml', '<testsuite><testcase name="one" file="a.test.ts"/></testsuite>');
      configure({ reportPaths: ['junit.xml'] });
      expect(reportFiles()).toEqual(['junit.xml']);
      expect(readTestRun().cases.map((c) => c.name)).toEqual(['one']);
    });

    it('reads each report once when two globs reach it, and never one under .git', () => {
      report('<testcase name="one" file="a.test.ts"/>', 'junit/run.xml');
      write('reports/.git/old.xml', '<testsuite><testcase name="stale" file="a.test.ts"/></testsuite>');
      configure({ reportPaths: ['reports/**/*.xml', 'reports/junit/*.xml'] });
      expect(reportFiles()).toEqual(['reports/junit/run.xml']);
      expect(readTestRun().cases.map((c) => c.name)).toEqual(['one']);
    });

    it('refuses a report that is not JUnit, naming it', () => {
      write('reports/run.xml', '<html/>');
      expect(refusal(() => readTestRun())).toMatch(/a test report could not be read: reports\/run\.xml: the root element is <html>/);
    });
  });

  describe('running the tests', () => {
    it('deletes the reports an earlier run left, then reads what the command wrote, with its exit code', () => {
      report('<testcase name="stale" file="a.test.ts"><failure/></testcase>', 'old.xml');
      configure({ command: `node -e "require('fs').writeFileSync('reports/new.xml', '<testsuite><testcase name=\\"one\\" file=\\"a.test.ts\\"/></testsuite>'); process.exit(3)"` });
      const run = runTestCommand({ shown: false });
      expect(existsSync(join(root, 'reports/old.xml'))).toBe(false);
      expect(run.cases.map((c) => [c.name, c.status])).toEqual([['one', 'passed']]);
      expect(run.exit).toBe(3);
    });

    // A run that could not start is something the change broke, and the
    // triage says what the change broke.
    it('reads a command that wrote no report as every test file left out', () => {
      configure({ command: 'exit 1' });
      mkdirSync(join(root, 'reports'));
      const run = runTestCommand({ shown: false });
      expect(run.cases).toEqual([]);
      expect(run.leftOut.map((f) => f.file)).toEqual(['a.test.ts']);
      expect(run.exit).toBe(1);
    });

    // Reports are output. A glob that reaches a file git would track would
    // delete source.
    it('refuses to delete a report glob\'s match that git tracks or would track', () => {
      write('.gitignore', '');
      report('<testcase name="one" file="a.test.ts"/>');
      expect(refusal(() => clearReports())).toMatch(/"tests\.run\.reportPaths" matches a file git tracks or would track \(reports\/run\.xml\)\. Reports are output/);
      expect(existsSync(join(root, 'reports/run.xml'))).toBe(true);
    });

    it.each([[5, ''], [6, ', …']] as const)('lists up to five filenames when refusing to delete %i reports', (count, suffix) => {
      write('.gitignore', '');
      for (let n = 1; n <= count; n++) report('<testcase name="one" file="a.test.ts"/>', `r${n}.xml`);
      expect(refusal(() => clearReports())).toContain('"tests.run.reportPaths" matches files git tracks or would track '
        + `(reports/r1.xml, reports/r2.xml, reports/r3.xml, reports/r4.xml, reports/r5.xml${suffix}). Reports are output`);
      expect(reportFiles()).toHaveLength(count);
    });

    // Source coverage belongs to the configured command. Removing it first
    // ensures a command that stops measuring cannot leave old evidence behind.
    it('clears source coverage explicitly before the test command runs', () => {
      write('.gitignore', 'reports/\ncoverage/\n');
      write('coverage/lcov.info', 'SF:old.ts\nend_of_record\n');
      configure({ command: 'rm -f coverage/lcov.info && true' });
      runTestCommand({ shown: false });
      expect(existsSync(join(root, 'coverage/lcov.info'))).toBe(false);
      configure({ command: `rm -f coverage/lcov.info && node -e "require('fs').writeFileSync('coverage/lcov.info', 'SF:new.ts')"` });
      runTestCommand({ shown: false });
      expect(readFileSync(join(root, 'coverage/lcov.info'), 'utf8')).toBe('SF:new.ts');
    });

    it('does not delete source coverage, even when git would track it', () => {
      write('coverage/lcov.info', 'SF:a.ts\nend_of_record\n');
      clearReports();
      expect(existsSync(join(root, 'coverage/lcov.info'))).toBe(true);
    });

    // With coverage switched off there is no report, and the file is not the
    // referee's to delete.
    it('leaves the file alone when the rulebook switches coverage off', () => {
      writeConfig(root, { adapter: { paths: { all: ['**/*.test.{ts,py}'], acceptance: ['a.test.*', 'b.test.ts'] }, run: { command: 'true', reportPaths: ['reports/*.xml'], tagComment: '^\\s*#' },  } });
      write('coverage/lcov.info', 'SF:a.ts\nend_of_record\n');
      clearReports();
      expect(existsSync(join(root, 'coverage/lcov.info'))).toBe(true);
    });
  });
});

describe('the outcomes of a run', () => {
  const run = (over: Partial<TestRun>): TestRun => ({ cases: [], leftOut: [], exit: 0, ...over });
  const testCase = { file: 'a.test.ts', name: 'one [AC0001.1]', message: null, ids: ['AC0001'], scenarios: ['AC0001.1'], bare: [], inverted: false };

  it('gives one outcome per test case, a failure with its message', () => {
    expect(outcomesOf(run({ cases: [
      { ...testCase, status: 'passed', line: 1, endLine: 3 },
      { ...testCase, status: 'failed', message: 'boom' },
      { ...testCase, status: 'skipped' },
      { ...testCase, status: 'failed', message: null },
      { ...testCase, status: 'passed', message: 'only a failure gives its message as a reason' },
    ] }))).toStrictEqual([
      { file: 'a.test.ts', title: 'one [AC0001.1]', ids: ['AC0001'], scenarios: ['AC0001.1'], failed: false, line: 1, endLine: 3 },
      { file: 'a.test.ts', title: 'one [AC0001.1]', ids: ['AC0001'], scenarios: ['AC0001.1'], failed: true, reason: 'boom' },
      { file: 'a.test.ts', title: 'one [AC0001.1]', ids: ['AC0001'], scenarios: ['AC0001.1'], failed: false },
      { file: 'a.test.ts', title: 'one [AC0001.1]', ids: ['AC0001'], scenarios: ['AC0001.1'], failed: true },
      { file: 'a.test.ts', title: 'one [AC0001.1]', ids: ['AC0001'], scenarios: ['AC0001.1'], failed: false },
    ]);
  });

  it('gives a file the report left out one failure for the whole file, with its tags, that never ran', () => {
    expect(outcomesOf(run({ leftOut: [{ file: 'b.test.ts', ids: ['AC0002'], scenarios: ['AC0002.3'], bare: [] }] }))).toEqual([{
      file: 'b.test.ts', title: '(the whole file)', ids: ['AC0002'], scenarios: ['AC0002.3'], failed: true, wholeFile: true,
      reason: 'the test report leaves it out: it failed to load, or the run never reached it', didNotRun: true,
    }]);
  });

  // An unhandled error after the last test: the exit says the run failed.
  it('adds one failure when the command exited non-zero and nothing in the report failed', () => {
    expect(outcomesOf(run({ cases: [{ ...testCase, status: 'passed' }], exit: 1 })).filter((o) => o.failed)).toEqual([{
      file: '(the test run)', title: 'the test command failed outside any test', ids: [], scenarios: [], failed: true,
      reason: 'it exited 1, and no test in the report failed',
    }]);
    expect(outcomesOf(run({ exit: 'SIGKILL' })).map((o) => o.reason)).toEqual(['stopped by SIGKILL, and no test in the report failed']);
  });

  it('adds nothing for a failed exit the report already explains, or a run read without running it', () => {
    expect(outcomesOf(run({ cases: [{ ...testCase, status: 'failed' }], exit: 1 }))).toHaveLength(1);
    expect(outcomesOf(run({ leftOut: [{ file: 'b.test.ts', ids: [], scenarios: [], bare: [] }], exit: 1 }))).toHaveLength(1);
    expect(outcomesOf(run({ cases: [{ ...testCase, status: 'passed' }], exit: null }))).toHaveLength(1);
  });
});
