import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { cruise, type ICruiseResult } from 'dependency-cruiser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The boundary rules in `.dependency-cruiser.cjs` still fire.
 *
 * `npm run boundaries` cannot prove that on its own. When dependency-cruiser
 * has no parser for TypeScript it skips every .ts file, reports "0 modules
 * cruised" and exits 0, so a broken setup reads as a clean tree. That happens
 * if `@swc/core` is missing, if its binary is not there for the platform, or
 * if `parser` in the config stops naming it. Each case below then comes back
 * with no violations, and this file fails.
 *
 * The planted files are written to a temporary folder and cruised with the
 * repository's own config, so a loosened rule fails here too. The folder has
 * its own `node_modules` with stand-ins for the language tools, so their
 * imports resolve to `node_modules/vitest/...`, as they do in the repository. A
 * link to the repository's real `node_modules` does not work: dependency-cruiser
 * follows it out of the folder, and the paths no longer start with
 * `node_modules/`.
 */

const root = resolve(import.meta.dirname, '../..');
const { forbidden, options } = createRequire(join(root, 'package.json'))('./.dependency-cruiser.cjs');

async function cruiseIn(baseDir: string, paths: string[]): Promise<ICruiseResult> {
  const { output } = await cruise(paths, {
    ...options,
    ruleSet: { forbidden },
    validate: true,
    baseDir,
  });
  return output as ICruiseResult;
}

/** One line per violation: the rule, the importing file and the imported one, packages by name. */
function violations(result: ICruiseResult): string[] {
  const named = (path: string) => path.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1] ?? path;
  return result.summary.violations.map((v) => `${v.rule.name}: ${v.from} → ${named(v.to)}`).sort();
}

const planted: Record<string, string> = {
  'tsconfig.json': '{ "compilerOptions": { "module": "ESNext", "moduleResolution": "bundler" } }',
  // The workflow's referee, and the language tools it may not reach. See
  // `referee-is-language-free`.
  'src/evidence/direct.ts': "import ts from 'typescript-api';\nexport const t = ts;\n",
  'src/requirements/indirect.ts': "import { tool } from '../adapters/typescript/tool';\nexport const i = tool;\n",
  'src/adapters/typescript/tool.ts': "import { it } from 'vitest';\nexport const tool = it;\n",
  'src/workflow/fine.mjs': "import { ok } from './plain.mjs';\nexport const fine = ok;\n",
  'src/workflow/plain.mjs': 'export const ok = 1;\n',
  'src/workflow/plain.test.mjs': "import { it } from 'vitest';\nexport const t = it;\n",
  'tests/support/machine/harness.mjs': "import { it } from 'vitest';\nexport const h = it;\n",
  // The agent adapter, which the referee may not reach, and the machine suite and
  // the adapter itself, which may. See `referee-is-agent-free`.
  'src/workflow/direct-agent.mjs': "import { hook } from '../agents/claude/hook.mjs';\nexport const d = hook;\n",
  'src/requirements/indirect-agent.ts': "import { hook } from '../agents/claude/hook.mjs';\nexport const i = hook;\n",
  'src/agents/claude/hook.mjs': "import { deep } from './deep.mjs';\nimport { ok } from '../../workflow/plain.mjs';\nexport const hook = deep + ok;\n",
  'src/agents/claude/deep.mjs': 'export const deep = 1;\n',
  'tests/support/machine/uses-agent.mjs': "import { hook } from '../../agents/claude/hook.mjs';\nexport const u = hook;\n",
  'src/workflow/uses-agent.test.mjs': "import { hook } from '../agents/claude/hook.mjs';\nexport const t = hook;\n",
  'src/evidence/mutants.ts': "import { Stryker } from '@stryker-mutator/core';\nexport const m = Stryker;\n",
  // A mutation sandbox: a copy of the repository, which breaks the rules as
  // the repository's own files would, and holds type files the parser cannot
  // read. Neither may count. See `exclude` in `.dependency-cruiser.cjs`.
  '.stryker-tmp/sandbox-x/src/evidence/direct.ts': "import ts from 'typescript-api';\nexport const t = ts;\n",
  '.stryker-tmp/sandbox-x/node_modules/chalk/index.d.ts': 'export const colors: readonly string[];\n',
  'node_modules/typescript-api/package.json': '{ "name": "typescript-api", "main": "index.js" }',
  'node_modules/typescript-api/index.js': 'export default {};\n',
  'node_modules/vitest/package.json': '{ "name": "vitest", "main": "index.js" }',
  'node_modules/vitest/index.js': 'export const it = () => {};\n',
  'node_modules/@stryker-mutator/core/package.json': '{ "name": "@stryker-mutator/core", "main": "index.js" }',
  'node_modules/@stryker-mutator/core/index.js': 'export const Stryker = {};\n',
};

describe('boundaries', () => {
  let dir: string;
  let found: string[];

  beforeAll(async () => {
    // The real path, because on macOS the temporary folder is reached through
    // a link (`/var` is `/private/var`). dependency-cruiser resolves imports to
    // the real path and writes it relative to the folder it was given, so every
    // import would come out as `../../../private/var/...` and match no rule.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'katatay-boundaries-')));
    for (const [path, text] of Object.entries(planted)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    found = violations(await cruiseIn(dir, ['.']));
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads nothing inside a mutation sandbox', () => {
    expect(found.filter((line) => line.includes('.stryker-tmp'))).toEqual([]);
  });

  it('refuses the referee importing a language tool', () => {
    expect(found).toContain('referee-is-language-free: src/evidence/direct.ts → typescript-api');
  });

  // The referee's mutation code asks the adapter's `mutate` piece. Stryker is the
  // adapter's business.
  it('refuses the referee\'s mutation code importing the mutation tool', () => {
    expect(found).toContain('referee-is-language-free: src/evidence/mutants.ts → @stryker-mutator/core');
  });

  // The adapter is where the language belongs, and the referee reaching it would
  // carry the language in with it.
  it('refuses the referee importing the adapter, and what the adapter imports', () => {
    expect(found).toContain('referee-is-language-free: src/requirements/indirect.ts → src/adapters/typescript/tool.ts');
    expect(found).toContain('referee-is-language-free: src/requirements/indirect.ts → vitest');
  });

  // The agent adapter is where Claude Code belongs. The referee asks it through
  // the commands the rulebook names, and reaching it by import would carry the
  // agent in. What the adapter reaches is refused too.
  it('refuses the referee importing the agent adapter, and what the adapter imports', () => {
    expect(found).toContain('referee-is-agent-free: src/workflow/direct-agent.mjs → src/agents/claude/hook.mjs');
    expect(found).toContain('referee-is-agent-free: src/requirements/indirect-agent.ts → src/agents/claude/hook.mjs');
    expect(found).toContain('referee-is-agent-free: src/requirements/indirect-agent.ts → src/agents/claude/deep.mjs');
  });

  // The cases above are each found. This is the other direction: everything
  // the rules allow stays allowed, so the list is exactly what was planted to
  // fail. A test, the machine suite's harness and the adapter itself may all
  // import a language tool.
  // The mutation files may not any more: they were the rule's one named
  // exception until Stryker moved into the adapter.
  it('allows nothing more and refuses nothing else', () => {
    expect(found).toEqual(
      [
        'referee-is-agent-free: src/requirements/indirect-agent.ts → src/agents/claude/deep.mjs',
        'referee-is-agent-free: src/requirements/indirect-agent.ts → src/agents/claude/hook.mjs',
        'referee-is-agent-free: src/workflow/direct-agent.mjs → src/agents/claude/deep.mjs',
        'referee-is-agent-free: src/workflow/direct-agent.mjs → src/agents/claude/hook.mjs',
        'referee-is-language-free: src/evidence/direct.ts → typescript-api',
        'referee-is-language-free: src/evidence/mutants.ts → @stryker-mutator/core',
        'referee-is-language-free: src/requirements/indirect.ts → src/adapters/typescript/tool.ts',
        'referee-is-language-free: src/requirements/indirect.ts → vitest',
      ].sort(),
    );
  });

  // A tree that is cruised with no parser has no TypeScript in it at all. The
  // planted cases catch that; this catches it on the repository itself, where
  // `npm run boundaries` runs.
  it("reads the repository's own TypeScript, imports included", async () => {
    const result = await cruiseIn(root, ['src/requirements']);
    const guard = result.modules.find((m) => m.source === 'src/requirements/guard.ts');
    expect(guard?.dependencies.map((d) => d.resolved)).toContain('src/requirements/checksum.ts');
  });
});
