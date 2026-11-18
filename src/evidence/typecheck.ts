import { isFrozen } from '../workflow/frozen.mjs';
import { runCompile } from '../workflow/adapter.mjs';
import { scenariosOfFile, tagsOfFile } from './tags.js';
import type { TestRun } from './test-run.js';
import type { TestOutcome } from './risk.js';

/**
 * A test file that no longer compiles is a failing test.
 *
 * The triage used to refuse on any type error. That was meant to stop it
 * reporting on a half-written implementation, and for errors in the
 * implementation it still does. But when a change alters a public contract
 * (a function turns async, a field is renamed), the tests written against the
 * old contract stop compiling. That is not an unfinished implementation. It is
 * the plainest evidence there is that the change reached those tests, which is
 * what the triage exists to sort. Refusing on it deadlocked the workflow: the
 * tests are frozen until the triage runs, and the triage would not run until
 * the tests were changed. Found making a function async, 2026-09-23.
 *
 * A runner that strips types without checking them, as Vitest does, still
 * runs those tests, and they usually fail at runtime too. Not always: a test that compares two promises
 * where it used to compare two projects passes by luck. The type error is then
 * the only signal, which is why a test counts as failed on either.
 *
 * The rule is the referee's, and holds for every language. The errors come from
 * the compiler's own output: the rulebook's `code.compile` names the
 * command, such as `tsc`, javac or mypy, the pattern that finds each error, and
 * what its exit codes mean (`runCompile` in `adapter.mjs`). Which
 * test an error sits in comes from the line ranges the reporter adds to the test
 * report. A language with no static check says `"compile": "none"`, and then
 * a test file that cannot load still fails: the report leaves it out, and a
 * file left out is a failure. See `src/adapters/README.md`.
 */

export interface TypeError {
  file: string;
  line: number;
  message: string;
}

/**
 * The compile errors, or `null` when the rulebook says the language has no
 * static check (`"compile": "none"`). Callers say so wherever they would have
 * used the answer. A compiler that broke throws an `AdapterError`.
 */
export function compileErrors(): TypeError[] | null {
  const answer = runCompile() as { errors: TypeError[] } | null;
  return answer === null ? null : answer.errors;
}

/**
 * Split by the same rule the freeze uses. An error in a frozen file is a test
 * result. Any other error means the implementation is not finished, and it can
 * be fixed now.
 *
 * Frozen, not only test files. Support code under `tests/`, such as
 * `tests/acceptance/support.ts`, is frozen until the triage runs. An error
 * there sent to "not finished" would make the triage refuse over a file nobody
 * may edit yet: the same deadlock this file's header describes. A support file
 * has no tests of its own, so `withCompileFailures` reports it as one failing
 * "(the whole file)".
 */
export function splitErrors(errors: TypeError[]): { inTests: TypeError[]; elsewhere: TypeError[] } {
  const inTests = errors.filter((e) => isFrozen(e.file));
  return { inTests, elsewhere: errors.filter((e) => !inTests.includes(e)) };
}

const DOES_NOT_COMPILE = 'does not compile';

/**
 * Marks as failed every test a type error sits inside.
 *
 * - Inside a test's lines, from the `line` and `endLine` the reporter gave: every
 *   outcome with those same lines. A test under `describe.each` runs once per
 *   case and fails once per case, because the error is in all of them. The
 *   innermost test wins when one sits inside another.
 * - Outside any test, such as a broken import, or in a file whose outcomes
 *   carry no line ranges: every test in the file.
 * - In a file with no outcomes at all, such as test support code, which holds
 *   no tests: one failure for the file, carrying every id its tests carry in
 *   the run. Without this the file would vanish from the report, which is the
 *   one outcome a triage must never have.
 */
export function withCompileFailures(tests: TestOutcome[], errors: TypeError[], run: TestRun): TestOutcome[] {
  const byFile = new Map<string, TypeError[]>();
  for (const error of errors) byFile.set(error.file, [...(byFile.get(error.file) ?? []), error]);

  const broken = new Set<TestOutcome>();
  const extra: TestOutcome[] = [];

  for (const [file, fileErrors] of byFile) {
    const inFile = tests.filter((t) => t.file === file);
    if (inFile.length === 0) {
      extra.push({
        file, title: '(the whole file)', ids: tagsOfFile(run, file), scenarios: scenariosOfFile(run, file),
        failed: true, reason: DOES_NOT_COMPILE, wholeFile: true,
      });
      continue;
    }
    for (const error of fileErrors) {
      const inner = inFile
        .filter((t) => t.line !== undefined && t.endLine !== undefined && t.line <= error.line && error.line <= t.endLine)
        .sort((a, b) => a.endLine! - a.line! - (b.endLine! - b.line!))[0];
      const hit = inner ? inFile.filter((t) => t.line === inner.line && t.endLine === inner.endLine) : [];
      // No test around the error: the whole file, so an error is never
      // dropped for want of a match.
      for (const t of hit.length > 0 ? hit : inFile) broken.add(t);
    }
  }

  return [
    ...tests.map((t) => (broken.has(t) ? { ...t, failed: true, reason: DOES_NOT_COMPILE } : t)),
    ...extra,
  ];
}
