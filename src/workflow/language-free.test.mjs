/**
 * The referee starts only what it is allowed to start, and names no tool.
 *
 * The referee reaches the outside in three ways: `git`, its own Node running its
 * own files, and the commands the rulebook names (see `src/adapters/README.md`
 * and `src/VISION.md`). The `referee-is-language-free` rule in
 * `.dependency-cruiser.cjs` stops it importing a compiler or a test runner.
 * These tests stop the other way back in, which no import graph sees: starting
 * a program, and printing a tool's name.
 *
 * Before the split, `risk.ts` ran `npx vitest` and `typecheck.ts` ran `npm run
 * typecheck`. The old check looked for `npx` and `tsc` but not `npm`, so a
 * call to `workflow req guard` stayed in the `Stop` hook until the split was
 * finished. Now every program a referee file starts is listed here, by file,
 * and any other fails.
 */
import { describe, expect, it } from 'vitest';
import { code, referee, withoutComments } from '../../tests/fixtures/workflow/referee-code.mjs';
import { installRequest } from './install.mjs';

/**
 * Every program the referee may start, by file, as the first argument of the call
 * reads in the source. Each is one of the three ways in.
 */
const MAY_START = {
  'workflow/git.mjs': ["'git'"], // git
  'workflow/runtime.mjs': ['program'], // its own Node, running its own files
  'workflow/referee-verify.ts': ['process.execPath'], // its own Node, for the workflow logbook check
  'workflow/agent.mjs': ['line'], // the one command the rulebook names for the agent adapter, through a shell
  'workflow/adapter.mjs': ['command', 'compile.command'], // the commands the rulebook names, the compile command among them, through a shell
  'workflow/checks.mjs': ['line'], // a check's command the rulebook names, its placeholders filled in, through a shell
  'evidence/test-run.ts': ['testRun.command'], // the test command the rulebook names, through a shell
};

/**
 * Where a tool's name may appear in code, and why. Nowhere else may it.
 */
const MAY_NAME_A_TOOL = {
  'workflow/runtime.mjs': 'the one place that knows the referee loads its TypeScript through `tsx`',
  'workflow/commands.mjs': 'the one place that says how a message names a command',
};

const TOOL_NAME = /\b(?:npm|npx|pnpm|yarn|tsx|tsc|vitest|stryker)\b/;
const STARTS_A_PROGRAM = /(?<![.\w])(?:exec|execFile|execSync|execFileSync|spawn|spawnSync)\(\s*([^\s,)]+)/g;
const IMPORTS_CHILD_PROCESS = /['"](?:node:)?child_process['"]/;

const programsStartedBy = (source) => [...source.matchAll(STARTS_A_PROGRAM)].map((match) => match[1]);

describe('the referee', () => {
  it('starts only the programs it is allowed to start', () => {
    const started = Object.fromEntries(referee().map((path) => [path, programsStartedBy(code(path))]).filter(([, programs]) => programs.length > 0));
    expect(started).toEqual(Object.fromEntries(Object.entries(MAY_START).map(([path, programs]) => [path, expect.arrayContaining(programs)])));
    for (const [path, programs] of Object.entries(started)) {
      expect(programs.every((program) => MAY_START[path].includes(program)), `${path} starts ${programs.join(', ')}`).toBe(true);
    }
  });

  it('imports the means to start a program only where it may', () => {
    const offenders = referee().filter((path) => IMPORTS_CHILD_PROCESS.test(code(path)) && !(path in MAY_START));
    expect(offenders).toEqual([]);
  });

  it('names no tool in its code, outside the files that may', () => {
    const offenders = referee().filter((path) => !(path in MAY_NAME_A_TOOL) && TOOL_NAME.test(code(path)));
    expect(offenders).toEqual([]);
  });

  // A project's own instructions say how its tools are started. The text the
  // referee ships goes to every project, in any language.
  it('names no tool in the instructions and skills it ships', () => {
    const { instructions, skills } = installRequest();
    const offenders = [['workflow/INSTRUCTIONS.md', instructions], ...skills.map(({ name, prompt }) => [`workflow/skills/${name}.md`, prompt])]
      .filter(([, text]) => TOOL_NAME.test(text)).map(([path, text]) => `${path}: ${text.match(TOOL_NAME)[0]}`);
    expect(offenders).toEqual([]);
    expect(skills).toHaveLength(3);
  });

  // Without these, a pattern that matched nothing, or a walk that found
  // nothing, would pass on every tree.
  it('is found by the checks above, and they find what they look for', () => {
    expect(referee()).toEqual(expect.arrayContaining([
      'workflow/adapter.mjs', 'workflow/referee-verify.ts', 'workflow/runtime.mjs', 'workflow/commands.mjs', 'workflow/agent.mjs', 'workflow/hooks/gate.mjs',
      'evidence/risk.ts', 'evidence/typecheck.ts', 'evidence/mutants.ts', 'evidence/mutate.ts',
    ]));
    expect(referee().some((path) => /\.test\.|machine\/|fixtures\/|adapters\//.test(path))).toBe(false);
    expect(Object.keys(MAY_START).concat(Object.keys(MAY_NAME_A_TOOL)).every((path) => referee().includes(path))).toBe(true);
    for (const call of ["spawn('npx', ['vitest'])", "execFileSync('npm', ['run'])", 'execSync(`vitest run`)']) {
      expect(programsStartedBy(call).length, call).toBe(1);
    }
    expect(programsStartedBy('spawnSync(process.execPath, [file])')).toEqual(['process.execPath']);
    expect(TOOL_NAME.test(withoutComments("run('npm', ['test'])"))).toBe(true);
    expect(TOOL_NAME.test(withoutComments("run('git') // not npm"))).toBe(false);
    expect(TOOL_NAME.test(withoutComments('/** loaded through tsx */\nconst a = 1;'))).toBe(false);
    expect(TOOL_NAME.test(withoutComments('  // npm run x\nconst a = 1;'))).toBe(false);
  });
});
