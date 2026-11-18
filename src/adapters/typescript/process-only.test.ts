import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { importsOf, isSupport, processOnly, processOnlyTests, type Layout } from './process-only.js';

const MACHINE_TEST = 'tools/workflow/machine/x.test.mjs';

/** A project's layout, given to the rule as its mutation config gives it:
 *  a machine suite whose harness sits beside its tests, and fixtures. */
const LAYOUT: Layout = { tests: ['**/*.test.{ts,tsx,mjs}'], support: ['tools/workflow/machine/*', '**/fixtures/**'] };

describe('a test file that reaches the code only through processes', () => {
  it('imports nothing but the harness, its helpers, the fixtures, vitest and node', () => {
    expect(processOnly([
      "import { describe, expect, it } from 'vitest';",
      "import { join } from 'node:path';",
      "import {\n  ctx, machineFixture,\n} from './harness.mjs';",
      "import { read } from './baselines.mjs';",
      "import { repositoryRulebook } from '../fixtures/adapter.mjs';",
    ].join('\n'), MACHINE_TEST, LAYOUT)).toBe(true);
  });

  // The Codex journey sits beside its adapter, and starts the hooks through
  // the machine harness.
  it('is one wherever it sits, reaching the harness and the fixtures from its own folder', () => {
    const journey = 'tools/agents/codex/journey.test.mjs';
    expect(processOnly([
      "import { spawnSync } from 'node:child_process';",
      "import { ctx } from '../../workflow/machine/harness.mjs';",
      "import { payload } from './fixtures/payloads.mjs';",
    ].join('\n'), journey, LAYOUT)).toBe(true);
    expect(processOnly("import { spawnSync } from 'node:child_process';", 'tools/agents/codex/check.test.mjs', LAYOUT)).toBe(true);
  });

  // That part of it can catch a mutant, so it stays in.
  it('is not one when it imports code under test, statically or dynamically', () => {
    expect(processOnly("import { ctx } from './harness.mjs';\nimport { onPrompt } from '../moments/prompt.mjs';", MACHINE_TEST, LAYOUT)).toBe(false);
    expect(processOnly("import { ctx } from './harness.mjs';\nconst m = await import('../state.mjs');", MACHINE_TEST, LAYOUT)).toBe(false);
    expect(processOnly("import '../moments/io.mjs';", MACHINE_TEST, LAYOUT)).toBe(false);
    expect(processOnly("export { x } from '../state.mjs';", MACHINE_TEST, LAYOUT)).toBe(false);
    expect(processOnly("import { spawnSync } from 'node:child_process';\nimport { usage } from './workflow.mjs';", 'tools/workflow/cli/workflow.test.mjs', LAYOUT)).toBe(false);
  });

  // A computed path could be anything.
  it('is not one when it imports a path it computes', () => {
    expect(importsOf('const m = await import(path);')).toContain('<computed>');
    expect(processOnly("import { ctx } from './harness.mjs';\nawait import(join(dir, 'x.mjs'));", MACHINE_TEST, LAYOUT)).toBe(false);
  });

  // `spawnSync(process.execPath, ['--import', TSX, VERIFY])` starts a
  // TypeScript file. Read as an import, it kept a process-only file in.
  it('reads an argument that names --import as no import', () => {
    expect(importsOf("spawnSync(process.execPath, ['--import', TSX, VERIFY], { cwd: root, encoding: 'utf8' });")).toEqual([]);
    expect(importsOf("import './setup.mjs';\nimport 'x';")).toEqual(['./setup.mjs', 'x']);
  });

  // Missed, a bare import of code under test would leave the file out.
  it('reads a bare import that is indented, or written with no space before its path', () => {
    expect(importsOf("if (on) {\n  import '../state.mjs';\n}")).toEqual(['../state.mjs']);
    expect(importsOf("import'../state.mjs';")).toEqual(['../state.mjs']);
  });
});

describe('test support, as the rule reads it', () => {
  it('is a file beside the machine tests that is not a test, or anything in a fixtures folder', () => {
    expect(isSupport('./harness.mjs', MACHINE_TEST, LAYOUT)).toBe(true);
    expect(isSupport('../../workflow/machine/baselines.mjs', 'tools/agents/codex/journey.test.mjs', LAYOUT)).toBe(true);
    expect(isSupport('./fixtures/payloads.mjs', 'tools/agents/codex/journey.test.mjs', LAYOUT)).toBe(true);
  });

  it('is never a test, a module elsewhere, a package, or a path outside the repository', () => {
    expect(isSupport('./deciding.test.mjs', MACHINE_TEST, LAYOUT)).toBe(false);
    expect(isSupport('../chain.mjs', MACHINE_TEST, LAYOUT)).toBe(false);
    expect(isSupport('vitest', MACHINE_TEST, LAYOUT)).toBe(false);
    expect(isSupport('../../fixtures/a.mjs', 'x.test.mjs', LAYOUT)).toBe(false);
  });

  // The paths are the project's: the adapter names none of its own.
  it('is only what the layout names, and never a test even when the layout covers it', () => {
    const none: Layout = { tests: LAYOUT.tests, support: [] };
    expect(isSupport('./harness.mjs', MACHINE_TEST, none)).toBe(false);
    expect(isSupport('./fixtures/a.mjs', 'x.test.mjs', none)).toBe(false);
    const wide: Layout = { tests: LAYOUT.tests, support: ['lib/**'] };
    expect(isSupport('./helper.mjs', 'lib/x.test.mjs', wide)).toBe(true);
    expect(isSupport('./other.test.mjs', 'lib/x.test.mjs', wide)).toBe(false);
  });
});

describe('the test files listed in a repository', () => {
  let root: string | undefined;
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  const put = (file: string, body: string) => {
    mkdirSync(join(root!, dirname(file)), { recursive: true });
    writeFileSync(join(root!, file), body);
  };

  it('are read from every folder, and never from dependencies, build output or sandboxes', () => {
    root = mkdtempSync(join(tmpdir(), 'process-only-'));
    const onlyNode = "import { spawnSync } from 'node:child_process';\n";
    for (const file of ['a/one.test.mjs', 'b/c/two.test.ts', 'node_modules/p/three.test.mjs', '.stryker-tmp/s/four.test.mjs', '.next/five.test.ts']) put(file, onlyNode);
    put('a/code.test.mjs', "import { x } from './x.mjs';\n");
    expect(processOnlyTests(LAYOUT, root)).toEqual(['a/one.test.mjs', 'b/c/two.test.ts']);
  });
});

/** This repository's own layout, as `vitest.mutate.config.ts` gives it: the
 *  machine harness and its helpers under `tests/support/`, and fixtures. */
const REPOSITORY: Layout = {
  tests: ['**/*.test.{ts,tsx,mjs}'],
  support: ['tests/support/machine/*', 'tests/support/workflow/**', '**/fixtures/**'],
};

describe('the tests left out of mutation runs', () => {
  // Without this, a pattern that matched nothing would leave every test in,
  // and one that matched everything would leave the in-process ones out.
  it('are every test that starts processes, in any folder, and never one that calls code in process', () => {
    const left = processOnlyTests(REPOSITORY);
    expect(left).toEqual(expect.arrayContaining([
      'tests/machine/recording.test.mjs',
      'tests/machine/drifting.test.mjs',
      'tests/machine/reporting-at-record.test.mjs',
      'tests/hooks/codex/journey.test.mjs',
      'tests/hooks/codex/check.test.mjs',
      'tests/hooks/claude/io.test.mjs',
      'tests/integration/workflow/referee-verify.process.test.mjs',
      'tests/integration/workflow/io.process.test.mjs',
      'tests/integration/workflow/workflow.process.test.mjs',
    ]));
    for (const kept of [
      'src/workflow/moments/deciding.test.mjs',
      'src/workflow/moments/reporting-gathered.test.mjs',
      'src/workflow/referee-verify.test.mjs',
      'src/workflow/moments/io.test.mjs',
      'src/workflow/cli/workflow.test.mjs',
      'src/workflow/frozen.test.mjs',
    ]) expect(left).not.toContain(kept);
  });
});
