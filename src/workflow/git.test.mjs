import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitLines, gitText } from './git.mjs';

let empty;

// A repository with no commits: `HEAD` names nothing, so asking about it fails
// the way the fixtures and a fresh clone make it fail.
beforeEach(() => {
  empty = mkdtempSync(join(tmpdir(), 'workflow-git-helper-'));
  gitText(['init', '--quiet'], { cwd: empty });
});

afterEach(() => {
  rmSync(empty, { recursive: true, force: true });
});

/** What `run` writes to stderr, still passed on to the real stream. */
const stderrDuring = (run) => {
  const noise = [];
  const real = process.stderr.write;
  process.stderr.write = function (chunk, ...rest) {
    noise.push(String(chunk));
    return real.call(this, chunk, ...rest);
  };
  try {
    run();
  } finally {
    process.stderr.write = real;
  }
  return noise.join('');
};

const failureOf = (run) => {
  try {
    run();
  } catch (failure) {
    return failure;
  }
  throw new Error('expected the git call to fail');
};

describe('running git', () => {
  it('prints nothing when git fails', () => {
    const noise = stderrDuring(() => failureOf(() => gitText(['rev-parse', 'HEAD'], { cwd: empty })));
    expect(noise).toBe('');
  });

  // A caller that lets the error reach the operator has to say what went
  // wrong. Discarding stderr would leave only "Command failed".
  it("keeps git's message inside the error it throws", () => {
    const failure = failureOf(() => gitText(['rev-parse', 'HEAD'], { cwd: empty }));
    expect(failure.message).toMatch(/ambiguous argument 'HEAD'/);
    expect(failure.stderr).toMatch(/^fatal: /);
  });

  // `revParse` in `tree.mjs` reads what git could resolve from stdout, even
  // when it exits non-zero.
  it('still hands back stdout when git fails', () => {
    const failure = failureOf(() => gitText(['rev-parse', 'HEAD'], { cwd: empty }));
    expect(failure.stdout).toBe('HEAD\n');
  });

  it("passes the caller's options through", () => {
    expect(gitText(['rev-parse', '--show-toplevel'], { cwd: empty }).trim()).toBe(realpathSync(empty));
  });

  it('splits the output into its non-empty lines', () => {
    expect(gitLines(['config', '--list', '--local'], { cwd: empty }).every((line) => line !== '')).toBe(true);
    expect(gitLines(['ls-files'], { cwd: empty })).toEqual([]);
  });
});

// What makes the helper a rule rather than a habit. A module that runs git
// itself chooses its own stderr handling again, which is how
// `fatal: ambiguous argument 'HEAD'` reached every triage after one call had
// been made quiet. The TypeScript tools count too: they import from this
// directory already. Test files and their support code build fixtures with
// git, and should fail loudly, so they are not counted.
describe('the tool modules', () => {
  const TOOLS = dirname(dirname(fileURLToPath(import.meta.url)));
  // The adapters are not the referee, but they run git too, and the same
  // reason holds for them. The agent adapter's folder is the second one.
  const TREES = ['workflow', 'evidence', 'requirements', 'adapters', 'agents'];
  const SUPPORT = ['machine', 'fixtures'];
  const RUNS_GIT = /\b(exec|execFile|execSync|execFileSync|spawn|spawnSync)\(\s*['"`]git\b/;

  const modules = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return SUPPORT.includes(entry.name) ? [] : modules(path);
      return /\.(mjs|ts)$/.test(entry.name) && !/\.test\.(mjs|ts)$/.test(entry.name) ? [path] : [];
    });
  const all = () => TREES.flatMap((tree) => modules(join(TOOLS, tree))).map((path) => relative(TOOLS, path));

  // Modules that start a program other than git, each for its own reason.
  // Matching only calls that name git would miss one made through a renamed
  // import, so starting any program at all is what needs a place on this list.
  const STARTS_OTHER_PROGRAMS = [
    'agents/claude/hooks/referee.mjs', // node, to start the referee's moment commands
    'agents/codex/hooks/referee.mjs', // node, the same, for the Codex hooks
    'agents/cursor/hooks/referee.mjs', // node, the same, for the Cursor hooks
    'agents/init.mjs', // node, to start the referee's init with every adapter
    'agents/codex/app-server.mjs', // codex, to ask its app server about hooks and settings
    'workflow/agent.mjs', // the shell, for the command the agent section names
    'workflow/runtime.mjs', // node, for every file of the referee's own that is started
    'workflow/adapter.mjs', // the shell, for the commands the adapter section names
    'workflow/checks.mjs', // the shell, for each check's command the rulebook names
    'workflow/referee-verify.ts', // node, for state:verify
    'evidence/test-run.ts', // the shell, for the test command the rulebook names
    'adapters/typescript/stryker-process.ts', // node, for Stryker in a process tree it can stop
  ];
  const CHILD_PROCESS = /['"]node:child_process['"]|['"]child_process['"]/;

  it('run git only through git.mjs', () => {
    const offenders = all()
      .filter((path) => path !== 'workflow/git.mjs')
      .filter((path) => {
        const source = readFileSync(join(TOOLS, path), 'utf8');
        return RUNS_GIT.test(source) || (CHILD_PROCESS.test(source) && !STARTS_OTHER_PROGRAMS.includes(path));
      });
    expect(offenders).toEqual([]);
  });

  // Without this, a pattern that matched nothing, or a walk that found
  // nothing, would pass on every tree.
  it('are found by the check above', () => {
    expect(all()).toEqual(expect.arrayContaining([
      'workflow/git.mjs', 'workflow/tree.mjs', 'agents/claude/hooks/turn-end.mjs', 'workflow/cli/areas.mjs',
      'evidence/report.ts', 'requirements/guard.ts', 'requirements/renumber.ts',
    ]));
    expect(all().some((path) => /\.test\.|machine\/|fixtures\//.test(path))).toBe(false);
    expect(RUNS_GIT.test(readFileSync(join(TOOLS, 'workflow/git.mjs'), 'utf8'))).toBe(true);
    expect(all()).toEqual(expect.arrayContaining(STARTS_OTHER_PROGRAMS));
  });
});
