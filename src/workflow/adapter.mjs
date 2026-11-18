/**
 * The language adapter: everything the referee asks of the project's language,
 * and the one place that asks it.
 *
 * The referee is everything under `src/` except `src/adapters/`. It knows the
 * workflow, the requirements and the evidence rules, and nothing about how a
 * language runs its tests. When it needs an answer only the language can give,
 * such as which tests exist or which of them failed, it runs a command the
 * operator named in `.katatay/rulebook.json` and reads its output and reports.
 * `src/adapters/README.md` is the contract those commands keep.
 *
 * The rulebook's `tests.paths` and `code.paths` classify files. `tests.run`
 * describes the command and its JUnit output. `code.compile` describes the
 * compiler command and its diagnostics, or is "none".
 *
 * The language's files that review must read, its manifests and the configs of
 * its test runner, are the project's call and not the language's: they are
 * entries in the rulebook's `highRisk` list. Checks such as a lint or the
 * build are the rulebook's `checks`, which the referee runs itself
 * (`checks.mjs`): running a command and reading its exit code needs nothing
 * from the language.
 *
 * The compile step reads its command, pattern and exit codes here. Coverage
 * and mutation belong to the rulebook's quality checks.
 *
 * The path rules are globs, matched by `globToRegExp` in `glob.mjs` rather than
 * a library. The hooks import this module through `frozen.mjs`, and the hooks
 * import nothing from `node_modules`: they run as bare node processes against
 * whatever tree they are spawned in.
 */
import { spawn, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { CONFIG, TargetError, readAdapterSettings } from './rulebook.mjs';
import { matcher } from './glob.mjs';
import { AdapterError, NONE } from './adapter-settings.mjs';

export { globToRegExp, matcher } from './glob.mjs';
export { AdapterError, COMPILE_MEANINGS, NONE, literalFolder, parseAdapter, parseCompileExitCodes } from './adapter-settings.mjs';

/**
 * The lines of a failed command's stderr worth keeping: all of them when there
 * are `count` or fewer, and otherwise the first and the last `count - 1`.
 *
 * The first line is kept because a crash usually names its cause there and
 * then prints a stack, and the last lines of a stack say only where it
 * happened. The last lines are kept because a command that logs as it goes
 * says how it ended there.
 *
 * @param {string | null | undefined} text
 * @param {number} [count]
 * @returns {string}
 */
export function errorLines(text, count = 5) {
  const lines = (text ?? '').trim().split('\n').filter((l) => l.trim() !== '');
  if (lines.length <= count) return lines.join('\n');
  return [lines[0], '…', ...lines.slice(-(count - 1))].join('\n');
}

/**
 * The parsed test and code settings at `root`, or an `AdapterError` explaining the refusal.
 *
 * @param {string} [root]
 */
export function readAdapter(root = process.cwd()) {
  try {
    return readAdapterSettings(root);
  } catch (error) {
    throw error instanceof TargetError ? new AdapterError(error.message) : error;
  }
}

/** The line the referee prints where it would have used a piece the config says
 *  this language lacks. */
export const COMPILE_OFF = `not checked: compile (the adapter says "${NONE}" in ${CONFIG})`;

// ------------------------------------------------------------- mutation

/**
 * What an exit code of the mutation command means. See `runMutate`.
 *
 * - `clean`: no mutant survived, by the tool's own account. That is the
 *   tool's word, never proof that the tests catch every mutant.
 * - `survived`: mutants survived.
 * - `nothing`: the run proves nothing, such as no test reaching the lines,
 *   a mutant that tests reach running no test, or a run that stopped at its
 *   time limit before it checked anything.
 *
 * Any other code means the command crashed.
 */
export const MUTATE_EXITS = { 0: 'clean', 1: 'survived', 2: 'nothing' };

/**
 * Runs the mutation command and returns how its run ended, with the text it
 * printed. The caller handles an explicitly disabled check.
 *
 * The command runner reads the exit code (see
 * `MUTATE_EXITS`) and passes the text on, so a language needs only a wrapper
 * around its mutation tool, and no translator into the referee's words.
 *
 * The question still goes on stdin as JSON, `{ targets, budget, verbose }`:
 * the lines this change touched and the time limit are the referee's choice,
 * and paths such as `src/[id]/(group)/page.tsx` would need shell quoting as
 * arguments.
 *
 * Thrown as the command failing, an `AdapterError`:
 *
 * - an exit code `MUTATE_EXITS` does not list, or a signal;
 * - nothing on stdout, whatever the code. The command always says what it
 *   found. A Node process that dies on an uncaught error exits 1, which would
 *   otherwise read as "mutants survived", and prints only to stderr;
 * - still running at `timeout` seconds, the backstop, with `timedOut` set. The
 *   command is told its budget and keeps it itself.
 *
 * `keepErrors` holds stderr back and puts its first and last lines in the
 * error.
 *
 * @param {{ command: string, root?: string, input: unknown, timeout?: number, keepErrors?: boolean }} options
 * @returns {Promise<{ outcome: 'clean' | 'survived' | 'nothing', text: string }>}
 */
export async function runMutate({ command, root = process.cwd(), input, timeout, keepErrors = false }) {
  // Commands may be shell pipelines. Stop the whole group at the hard limit
  // so a child cannot keep running or write a stale report after a retry.
  const child = spawn(command, { shell: true, detached: true, cwd: root, stdio: ['pipe', 'pipe', keepErrors ? 'pipe' : 'inherit'] });
  let problem;
  const stop = () => {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') problem = error.message; }
  };
  // Keep the same output bound as the other adapter commands.
  const collect = (stream) => {
    const chunks = [];
    let size = 0;
    stream?.on('data', chunk => {
      size += chunk.length;
      if (size <= 512 * 1024 * 1024) chunks.push(chunk);
      else if (!problem) { problem = 'output exceeded 512 MiB'; stop(); }
    });
    return chunks;
  };
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  child.on('error', error => { problem = error.message; });
  child.stdin.on('error', error => { if (error.code !== 'EPIPE') problem = error.message; });
  child.stdin.end(JSON.stringify(input));
  let late = false;
  const timer = timeout === undefined ? null : setTimeout(() => {
    late = true;
    stop();
  }, timeout * 1000);
  const [status, signal] = await new Promise(resolve => child.once('close', (code, signal) => resolve([code, signal])));
  clearTimeout(timer);
  const errors = Buffer.concat(stderr).toString();
  if (keepErrors) process.stderr.write(errors);
  const said = errorLines(errors);
  const failed = (why) => new AdapterError(`adapter: mutate (\`${command}\`) ${why}. That is the command failing, not a result, so nothing was concluded from it.${said ? `\n${said}` : ''}`);
  if (late) throw Object.assign(failed(`was still running after ${timeout} seconds, and was stopped`), { timedOut: true });
  if (problem) throw failed(`could not be run (${problem})`);
  if (status === null) throw failed(`was stopped by ${signal}`);
  const outcome = MUTATE_EXITS[status];
  if (outcome === undefined) throw failed(`exited with ${status}, which means it crashed: only 0, 1 and 2 are results`);
  const text = Buffer.concat(stdout).toString().replace(/\s+$/, '');
  if (text === '') throw failed(`exited with ${status} and printed nothing, so it died before it could say what it found`);
  return { outcome, text };
}

// ------------------------------------------------------------- compile

/** The escape sequences a terminal reads as colours and cursor moves. Some
 *  compilers print them even into a pipe, and they would sit inside a file
 *  name or a message. */
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/**
 * A path as a compiler printed it, made into a path from the repository root
 * with `/`, where it can be. `\` becomes `/`, a leading `./` is dropped, and
 * an absolute path under the root becomes relative. The root is also tried as
 * its real path, because on macOS a temporary folder is `/var/…` to one tool
 * and `/private/var/…` to another.
 *
 * A path outside the repository is kept as printed. It is not a test file, so
 * an error there counts as the implementation being unfinished, which is the
 * safe reading: the triage refuses rather than classify around it.
 *
 * @param {string} printed
 * @param {string} root
 */
export function repositoryPath(printed, root) {
  let file = printed.trim().split('\\').join('/');
  while (file.startsWith('./')) file = file.slice(2);
  if (!isAbsolute(file)) return file;
  const roots = [root];
  try {
    roots.push(realpathSync(root));
  } catch {
    // A root that cannot be resolved is compared as given.
  }
  for (const base of roots) {
    const inside = relative(base, file).split('\\').join('/');
    if (inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)) return inside;
  }
  return file;
}

/**
 * The errors a compile command's output holds, by the rulebook's pattern.
 * Exported so the reading is tested apart from any command.
 *
 * The pattern runs over the whole output with the `g` and `m` flags. `^` and
 * `$` then match at each line, so a one-line pattern reads one error per line,
 * and a pattern that spans lines still works, for a compiler that prints the
 * message on one line and the file on the next. Colour codes are stripped and
 * `\r\n` read as `\n` first.
 *
 * `line` is 0 when the pattern has no `line` group, or it did not match: the
 * error is then placed in its file and no closer, which fails every test the
 * file holds. A match with no file is the pattern being wrong, and is thrown,
 * because the referee cannot tell whether that error is in a test.
 *
 * @param {string} output
 * @param {{ pattern: string }} compile
 * @param {string} root
 * @returns {{ file: string, line: number, message: string }[]}
 */
export function compileErrorsIn(output, compile, root) {
  const text = output.replace(ANSI, '').replace(/\r\n/g, '\n');
  return [...text.matchAll(new RegExp(compile.pattern, 'gm'))].map((match) => {
    const { file, line, message } = match.groups ?? {};
    if (typeof file !== 'string' || file.trim() === '') {
      throw new AdapterError(`compile: "code.compile.pattern" matched ${JSON.stringify(match[0])} without a file. `
        + 'Every error needs one, so the referee can tell an error in a test from one in the implementation');
    }
    return {
      file: repositoryPath(file, root),
      line: /^\d+$/.test(line ?? '') ? Number(line) : 0,
      message: (message ?? '').trim(),
    };
  });
}

/**
 * Runs the compile command and returns the errors it found, or `null` when the
 * rulebook says the language has no such step.
 *
 * What the exit code means comes from the rulebook's `exitCodes`, and decides
 * what the output is:
 *
 * - `clean`: no errors. The pattern matching anything anyway means the exit
 *   codes and the pattern disagree, and one of them is wrong. That is thrown,
 *   because the referee cannot tell which.
 * - `errors`: the errors are read with the pattern. The pattern matching
 *   nothing is thrown. The compiler said it printed errors and none were
 *   found, so the pattern is wrong or the compiler broke and used the same
 *   code: tsc exits 1 for a type error and also for a project it cannot find.
 * - `broken`, or a code the rulebook does not list: thrown.
 *
 * Everything thrown is an `AdapterError`, so the triage refuses and verify
 * fails, as for any adapter that failed. A compiler that broke must never read
 * as a clean one. The error carries the first and last lines of the output.
 *
 * stdout and stderr are both read, stdout first: tsc and mypy print errors to
 * stdout, javac, rustc and go to stderr.
 *
 * @param {{ root?: string }} [options]
 * @returns {{ errors: { file: string, line: number, message: string }[] } | null}
 */
export function runCompile({ root = process.cwd() } = {}) {
  const { compile } = readAdapter(root);
  if (compile === NONE) return null;

  const run = spawnSync(compile.command, {
    shell: true,
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 512 * 1024 * 1024,
  });
  const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  const failed = (problem) => {
    const said = errorLines(output);
    return new AdapterError(`compile (\`${compile.command}\`) ${problem}. That is the compiler failing, not a result, so nothing was concluded from it.${said ? `\n${said}` : ''}`);
  };

  if (run.error) throw failed(`could not be started (${run.error.message})`);
  if (run.status === null) throw failed(`was stopped by ${run.signal}`);
  const meaning = compile.exitCodes[String(run.status)];
  if (meaning === undefined) throw failed(`exited with ${run.status}, which "code.compile.exitCodes" does not list, so it means broken`);
  if (meaning === 'broken') throw failed(`exited with ${run.status}, which "code.compile.exitCodes" says means broken`);

  const errors = compileErrorsIn(output, compile, root);
  if (meaning === 'clean' && errors.length > 0) {
    throw failed(`exited with ${run.status}, which means clean, and "code.compile.pattern" found ${errors.length} error(s) in its output. `
      + 'The exit codes and the pattern disagree, and one of them is wrong');
  }
  if (meaning === 'errors' && errors.length === 0) {
    throw failed(`exited with ${run.status}, which means it found errors, and "code.compile.pattern" matched none in its output. `
      + 'Either the pattern does not fit what the compiler prints, or the compiler broke and exited with the same code');
  }
  return { errors };
}

// ------------------------------------------------------------- the path rules

/**
 * Matchers for the path rules, from the repository the process runs in. Built
 * once per parsed section, because `isFrozen` runs for every file git lists.
 */
const rules = new WeakMap();

function rulesOf(adapter) {
  let held = rules.get(adapter);
  if (!held) {
    held = {
      test: matcher(adapter.tests.all),
      acceptance: matcher(adapter.tests.acceptance),
      slow: matcher(adapter.tests.slow),
      frozen: matcher(adapter.testSupport),
      report: matcher(adapter.testRun.reports),
      code: matcher(adapter.code),
    };
    rules.set(adapter, held);
  }
  return held;
}

/** Whether a file holds tests, by the config's `tests.paths.all` globs.
 *  @param {string} file a path from the repository root */
export const matchesTests = (file, root = process.cwd()) => rulesOf(readAdapter(root)).test(file);

export function matchesAcceptance(file, root = process.cwd()) {
  const rules = rulesOf(readAdapter(root));
  return rules.test(file) && rules.acceptance(file);
}

export function matchesSlow(file, root = process.cwd()) {
  const rules = rulesOf(readAdapter(root));
  return rules.test(file) && rules.slow(file);
}

/** Compile the freeze classifier once for a whole working-tree measurement. */
export function frozenFileMatcher(root = process.cwd()) {
  const rules = rulesOf(readAdapter(root));
  return file => rules.test(file) || rules.frozen(file);
}

export const matchesFrozen = (file) => rulesOf(readAdapter()).frozen(file);

/** Whether a file is one of the test reports, by the config's
 *  `tests.run.reportPaths` globs. */
export const matchesReport = (file, root = process.cwd()) => rulesOf(readAdapter(root)).report(file);

/** Whether a file is code, by the config's `code.paths` globs. */
export const matchesCode = (file) => rulesOf(readAdapter()).code(file);
