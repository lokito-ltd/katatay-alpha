import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import type { Reporter, TestCase, TestModule, Vitest } from 'vitest/node';
// Types only: the compiler itself is the project's, loaded in `onInit`.
import type ts from 'typescript-api';
import { typescriptFromProject } from './project-modules.mjs';

/**
 * The project's test command loads this Vitest reporter to write JUnit XML.
 * See "The report writer" in `src/adapters/README.md` for the properties
 * the referee reads from each case.
 *
 * It writes the report itself rather than adding to Vitest's own JUnit
 * reporter, which gets two things wrong for the referee:
 *
 * - After a `beforeAll` that throws, the tests it kept from running are
 *   written as passed, with no `<skipped>`: a test that never ran would count
 *   as evidence.
 * - A file that fails to load is written as one failed test named after the
 *   file. The referee would read that as a test with no tags, and lose every
 *   tag the file's tests carry.
 *
 * So here a test that did not run is skipped, and a module that failed with
 * no failed test, a file that failed to load or a hook that threw, is left
 * out of the report. The referee reads a test file the report leaves out as
 * one that failed to load: one failure for the whole file, carrying every tag
 * in its text, as the triage has always counted it.
 *
 * Each test case carries:
 *
 * - `name`: the full name, the groups in front joined by ` > `, as Vitest
 *   gives it. The referee lets the group names fall away when it compares a
 *   name with its scenario.
 * - `file`: the test file, from the repository root.
 * - the properties `line` and `endLine`: the lines the test spans, so the
 *   referee can tell which test a compile error sits in. Vitest gives the
 *   start when the project's Vitest config sets `includeTaskLocation`; the end
 *   is read from the syntax (`scanTests`). Left out, both, when the two cannot
 *   be matched.
 * - the property `inverted` on every case. It is `true` for a test marked
 *   `.fails`, which passes only when its body fails, and `false` otherwise.
 *
 * The file it writes is named by the environment variable `JUNIT_REPORT`,
 * which the project's test command sets for each run. Without it the reporter
 * throws: a run whose report went nowhere would read as every file left out.
 *
 * Unhandled errors are not written. Vitest exits non-zero for them, and the
 * referee counts a non-zero exit with no failed test as a failure of its own.
 */
export default class JUnitReporter implements Reporter {
  private root = process.cwd();

  onInit(vitest: Vitest): void {
    this.root = vitest.config.root;
    // Loaded here, before any test runs, so a project without the compiler
    // API stops at once with the reason. Later, in `scanTests`, the error
    // would be caught and every test's lines quietly left out.
    const found = loadTypeScript();
    process.stderr.write(`vitest-junit-reporter: TypeScript ${found.version} from ${found.name}\n`);
  }

  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    const out = process.env.JUNIT_REPORT;
    if (!out) throw new Error('vitest-junit-reporter: JUNIT_REPORT names no file to write the report to');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, junitXml(modules.map((module) => this.moduleReport(module))));
  }

  private moduleReport(module: TestModule): ModuleReport {
    const file = relative(this.root, module.moduleId).split('\\').join('/');
    const tests = [...module.children.allTests()];
    let spans: TestSpan[] = [];
    try {
      spans = scanTests(file, readFileSync(module.moduleId, 'utf8'));
    } catch {
      // A file that cannot be read gives no line ranges. Its tests are still
      // reported; a compile error in it then fails the whole file.
    }
    return {
      file,
      included: included(module.state(), tests.some((test) => test.result().state === 'failed')),
      cases: tests.map((test) => caseOf(test, file, spans)),
    };
  }
}

export interface CaseReport {
  name: string;
  file: string;
  status: 'passed' | 'failed' | 'skipped';
  message?: string;
  line?: number;
  endLine?: number;
  inverted: boolean;
}

export interface ModuleReport {
  file: string;
  included: boolean;
  cases: CaseReport[];
}

/**
 * Whether a module goes into the report. One that failed with no failed test
 * failed outside every test: it did not load, or a hook threw. One still
 * queued or pending never ran. Both are left out, so the referee counts the
 * whole file as failed with every tag in it.
 */
export function included(state: string, anyTestFailed: boolean): boolean {
  if (state === 'passed' || state === 'skipped') return true;
  return state === 'failed' && anyTestFailed;
}

/** One test as a case of the report. Pure but for what Vitest hands it. */
export function caseOf(test: Pick<TestCase, 'fullName' | 'location' | 'options' | 'result'>, file: string, spans: TestSpan[]): CaseReport {
  const result = test.result();
  const status = result.state === 'passed' ? 'passed' : result.state === 'failed' ? 'failed' : 'skipped';
  const span = test.location ? spans.find((s) => s.line === test.location!.line) : undefined;
  const message = result.state === 'failed' ? result.errors?.[0]?.message : undefined;
  return {
    name: test.fullName,
    file,
    status,
    ...(message ? { message } : {}),
    ...(span ? { line: span.line, endLine: span.endLine } : {}),
    inverted: test.options.fails === true,
  };
}

/** Text safe inside an XML attribute: the characters XML 1.0 forbids are
 *  dropped, and the five with a meaning are escaped. */
export const attribute = (text: string): string =>
  text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;')
    .replace(/\t/g, '&#9;');

/** The report, as JUnit XML: one `<testsuite>` per module included. */
export function junitXml(modules: ModuleReport[]): string {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<testsuites>'];
  for (const module of modules.filter((m) => m.included)) {
    lines.push(`  <testsuite name="${attribute(module.file)}" file="${attribute(module.file)}" tests="${module.cases.length}">`);
    for (const c of module.cases) {
      const properties = [
        ...(c.line === undefined ? [] : [['line', String(c.line)], ['endLine', String(c.endLine)]]),
        ['inverted', String(c.inverted)],
      ];
      lines.push(`    <testcase name="${attribute(c.name)}" classname="${attribute(c.file)}" file="${attribute(c.file)}">`);
      lines.push('      <properties>');
      for (const [name, value] of properties) lines.push(`        <property name="${name}" value="${attribute(value!)}"/>`);
      lines.push('      </properties>');
      if (c.status === 'failed') lines.push(`      <failure message="${attribute(c.message ?? 'failed')}"/>`);
      if (c.status === 'skipped') lines.push('      <skipped/>');
      lines.push('    </testcase>');
    }
    lines.push('  </testsuite>');
  }
  lines.push('</testsuites>', '');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The lines each test spans, for the `line` and `endLine` properties.
//
// The referee decides which test a compile error sits inside from line
// ranges. Vitest reports where a test starts and not where it ends, so the
// end is read from the syntax here.
//
// This used to be `tests.ts`, and before that the whole of the adapter's
// `listTests`: every test and group with its title and whether it may not
// run. The referee reads those from the test report now, so only the line
// ranges are left, and they moved in here so the reporter is one file.


export interface TestSpan {
  /** 1-based. The line the call starts on, which is what Vitest reports as a
   *  test's location, and the line it ends on. */
  line: number;
  endLine: number;
}

const RUNNERS = new Set(['it', 'test']);

type Loaded = { ts: typeof ts; name: string; version: string };
let loaded: Loaded | undefined;

/**
 * The project's TypeScript compiler API, from the directory Vitest runs in
 * (`project-modules.mjs`), and not from Katatay's own folder. Loaded once.
 */
function loadTypeScript(): Loaded {
  return (loaded ??= typescriptFromProject() as Loaded);
}

/**
 * Leftmost identifier of a callee, so `it.each(...)` and `test.skip(...)` are
 * recognised alongside plain `it(...)`.
 */
export function calleeRoot(expression: ts.Expression): string | null {
  const { ts: api } = loadTypeScript();
  let node: ts.Expression = expression;
  while (api.isPropertyAccessExpression(node) || api.isCallExpression(node)) {
    node = node.expression;
  }
  return api.isIdentifier(node) ? node.text : null;
}

/**
 * Every test call in a file, by the lines it spans, read from the syntax.
 *
 * One entry per outermost runner call. In `it.each(table)('title', fn)` the
 * inner `it.each(table)` is part of the same test, so it is not listed again.
 * Its line is where `it.each` starts, which is where Vitest says the test is.
 * Groups, `describe`, are not listed: a compile error sits in a test, and one
 * outside every test fails the whole file.
 */
export function scanTests(file: string, source: string): TestSpan[] {
  const { ts: api } = loadTypeScript();
  const found: TestSpan[] = [];
  const sourceFile = api.createSourceFile(file, source, api.ScriptTarget.Latest, true);
  const lineOf = (pos: number) => sourceFile.getLineAndCharacterOfPosition(pos).line + 1;

  const visit = (node: ts.Node): void => {
    if (api.isCallExpression(node) && !api.isCallExpression(node.parent) && RUNNERS.has(calleeRoot(node.expression) ?? '')) {
      found.push({ line: lineOf(node.getStart(sourceFile)), endLine: lineOf(node.getEnd()) });
    }
    api.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}
