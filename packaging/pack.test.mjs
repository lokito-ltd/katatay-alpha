import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Script } from 'node:vm';

const assets = [
  'src/schemas/rulebook.schema.json', 'src/schemas/plan-approved.schema.json',
  'src/schemas/hooks.schema.json', 'src/agents/contract.json',
  'src/schema-version.mjs', 'src/distribution.mjs', 'src/adapters/skills/ktty-init.md',
  'src/workflow/INSTRUCTIONS.md', 'src/workflow/catalogue/TEMPLATE.md', 'src/workflow/skills/plan-change.md',
  'src/evidence/report.mjs', 'src/requirements/lint.mjs', 'src/agents/codex/hooks/pre-tool.mjs', 'src/katatay/cli.mjs',
];
const sourceOnly = [
  'src/schemas/notes.txt', 'src/schemas/draft.json',
  'src/workflow/cli/probe.test.mjs',
  'src/workflow/notes.md', 'app/private.mjs',
];
// The TypeScript adapter, which projects use from the installed package.
const adapterPrograms = ['src/adapters/typescript/stryker-child.mjs'];
const adapterSourceOnly = [
  'src/adapters/typescript/stryker.test.ts', 'src/adapters/typescript/plugins.test.mjs',
  'src/adapters/typescript/notes.md',
];

let workspace, root, scratch, npm, git;
const text = path => readFileSync(path, 'utf8');
function fixture(path, contents = path) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
}

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'katatay-pack-test-')));
  root = join(workspace, 'checkout');
  // A staged require must not find a missing package by walking up to the checkout.
  scratch = join(workspace, 'temp');
  mkdirSync(scratch);
  fixture('packaging/katatay/package.json', JSON.stringify({ name: 'katatay', bundleDependencies: ['runtime'] }));
  for (const path of ['LICENSE', 'packaging/katatay/README.md', ...assets, ...sourceOnly, ...adapterPrograms, ...adapterSourceOnly]) fixture(path);
  fixture('src/adapters/typescript/reporter.ts', "import { x } from './helper.js';\nexport const n: number = x;\n");
  fixture('src/workflow/cli/probe.ts', 'const count: number = 41; count + 1;');
  fixture('node_modules/runtime/package.json', JSON.stringify({ name: 'runtime', dependencies: { shared: '1', plugin: '1' } }));
  fixture('node_modules/runtime/index.js', 'module.exports = [require("shared"), require("plugin")];');
  fixture('node_modules/runtime/data/default.txt', 'packaged default\n');
  fixture('node_modules/plugin/package.json', JSON.stringify({ name: 'plugin', dependencies: { shared: '2' } }));
  fixture('node_modules/plugin/index.js', 'module.exports = require("shared");');
  for (const [folder, version] of [['node_modules/shared', '1.0.0'], ['node_modules/plugin/node_modules/shared', '2.0.0']]) {
    fixture(folder + '/package.json', JSON.stringify({ name: 'shared', version }));
    fixture(folder + '/index.js', 'module.exports = require("./package.json").version;');
  }
  fixture('node_modules/unrelated/package.json', '{}');
  fixture('node_modules/plugin/node_modules/unrelated/package.json', '{}');

  // Give the build an isolated source tree and inspect its npm invocation
  // before cleanup. The tarball integration test runs the actual npm binary.
  vi.resetModules();
  vi.doMock('node:url', async original => ({ ...await original(), fileURLToPath: () => root }));
  vi.doMock('node:os', async original => ({ ...await original(), tmpdir: () => scratch }));
  // git names the release; npm packs it. Each gets its own fake.
  npm = vi.fn();
  git = vi.fn(() => 'v1.2.3-4-gabc1234\n');
  vi.doMock('node:child_process', async original => ({
    ...await original(),
    execFileSync: (program, ...rest) => (program === 'git' ? git : npm)(program, ...rest),
  }));
});

afterEach(() => {
  vi.doUnmock('node:url');
  vi.doUnmock('node:os');
  vi.doUnmock('node:child_process');
  vi.resetModules();
  rmSync(workspace, { recursive: true, force: true });
});

it('hands npm runnable JavaScript, release metadata, the licence, adapter assets and only distributable project files', async () => {
  let stage;
  npm.mockImplementation((program, args, { cwd }) => {
    stage = cwd;
    expect(program).toBe('npm');
    expect(args[0]).toBe('pack');
    expect(args).toContain('--ignore-scripts');
    expect(args[args.indexOf('--pack-destination') + 1]).toBe(join(root, 'dist'));
    expect(text(join(stage, 'node_modules/runtime/data/default.txt'))).toBe('packaged default\n');
    expect(JSON.parse(text(join(stage, 'node_modules/shared/package.json'))).version).toBe('1.0.0');
    expect(text(join(stage, 'node_modules/plugin/node_modules/shared/index.js')))
      .toBe(text(join(root, 'node_modules/plugin/node_modules/shared/index.js')));
    expect(createRequire(join(stage, 'package.json'))('runtime')).toEqual(['1.0.0', '2.0.0']);
    expect(existsSync(join(stage, 'node_modules/unrelated'))).toBe(false);
    expect(existsSync(join(stage, 'node_modules/plugin/node_modules/unrelated'))).toBe(false);
    expect(JSON.parse(text(join(stage, 'package.json'))))
      .toEqual({ ...JSON.parse(text(join(root, 'packaging/katatay/package.json'))), version: '1.2.3+4.gabc1234' });
    expect(text(join(stage, 'README.md'))).toBe('packaging/katatay/README.md');
    expect(text(join(stage, 'LICENSE'))).toBe('LICENSE');
    expect(new Script(text(join(stage, 'src/workflow/cli/probe.js'))).runInNewContext()).toBe(42);
    for (const path of assets) expect(text(join(stage, path))).toBe(path);
    for (const path of ['src/workflow/cli/probe.ts', ...sourceOnly]) {
      expect(existsSync(join(stage, path)), path).toBe(false);
    }
  });
  await import('./pack.mjs');
  expect(npm).toHaveBeenCalledOnce();
  expect(existsSync(stage)).toBe(false);
  expect(existsSync(join(root, 'node_modules'))).toBe(true);
});

it('stamps the release git describes for the checkout into the packed manifest', async () => {
  git.mockReturnValue('v0.2.0-0-gabc1234\n');
  let manifest, written;
  npm.mockImplementation((_program, _args, { cwd }) => {
    written = text(join(cwd, 'package.json'));
    manifest = JSON.parse(written);
  });
  await import('./pack.mjs');
  expect(git).toHaveBeenCalledOnce();
  expect(git).toHaveBeenCalledWith('git', ['describe', '--tags', '--match', 'v*', '--long', '--dirty'], expect.objectContaining({ cwd: root }));
  expect(manifest.version).toBe('0.2.0');
  expect(manifest.name).toBe('katatay');
  expect(written).toBe(`${JSON.stringify(manifest, null, 2)}\n`);
});

it('refuses to pack a checkout with no release tag before npm runs, and cleans its staging directory', async () => {
  git.mockImplementation(() => { throw new Error('fatal: No names found, cannot describe anything.'); });
  await expect(import('./pack.mjs')).rejects.toThrow(
    `Katatay cannot tell its release: git found no v* tag in ${root}. Fetch the tags with 'git fetch --tags'.`,
  );
  expect(npm).not.toHaveBeenCalled();
  expect(readdirSync(scratch)).toEqual([]);
  expect(existsSync(join(root, 'dist'))).toBe(false);
});

it('packs into the folder KATATAY_PACK_DESTINATION names, and creates it', async () => {
  const destination = join(workspace, 'own folder');
  vi.stubEnv('KATATAY_PACK_DESTINATION', destination);
  onTestFinished(() => vi.unstubAllEnvs());
  npm.mockImplementation((_program, args) => {
    expect(args[args.indexOf('--pack-destination') + 1]).toBe(destination);
    expect(existsSync(destination)).toBe(true);
  });
  await import('./pack.mjs');
  expect(npm).toHaveBeenCalledOnce();
  expect(existsSync(join(root, 'dist'))).toBe(false);
});

it('propagates a packaging error and cleans its staging directory on failure', async () => {
  let stage;
  npm.mockImplementation((_program, _args, { cwd }) => {
    stage = cwd;
    throw new Error('npm could not write the archive');
  });
  await expect(import('./pack.mjs')).rejects.toThrow('npm could not write the archive');
  expect(npm).toHaveBeenCalledOnce();
  expect(existsSync(stage)).toBe(false);
  expect(existsSync(join(root, 'src/workflow/cli/probe.ts'))).toBe(true);
});

it('identifies a missing transitive dependency and the package that needs it', async () => {
  rmSync(join(root, 'node_modules/shared'), { recursive: true });
  await expect(import('./pack.mjs')).rejects.toThrow('Missing installed dependency shared required by runtime');
  expect(npm).not.toHaveBeenCalled();
  expect(readdirSync(scratch)).toEqual([]);
});

it('rejects a dependency installed only in the parent of the checkout', async () => {
  fixture('node_modules/runtime/package.json', JSON.stringify({ name: 'runtime', dependencies: { 'parent-only': '1' } }));
  fixture('../node_modules/parent-only/package.json', JSON.stringify({ name: 'parent-only', version: '1.0.0' }));
  const fromRuntime = createRequire(join(root, 'node_modules/runtime/index.js'));
  expect(fromRuntime.resolve('parent-only/package.json')).toBe(join(workspace, 'node_modules/parent-only/package.json'));
  await expect(import('./pack.mjs')).rejects.toThrow('Missing installed dependency parent-only required by runtime');
  expect(npm).not.toHaveBeenCalled();
});

it('rejects a dependency available only through NODE_PATH inside the checkout', async () => {
  fixture('node_modules/runtime/package.json', JSON.stringify({ name: 'runtime', dependencies: { 'vendor-only': '1' } }));
  fixture('vendor/vendor-only/package.json', JSON.stringify({ name: 'vendor-only', version: '1.0.0' }));
  vi.stubEnv('NODE_PATH', join(root, 'vendor'));
  try {
    // Node caches NODE_PATH at startup. Refresh its search paths in this worker.
    Module._initPaths();
    const fromRuntime = createRequire(join(root, 'node_modules/runtime/index.js'));
    expect(fromRuntime.resolve('vendor-only/package.json')).toBe(join(root, 'vendor/vendor-only/package.json'));
    await expect(import('./pack.mjs')).rejects.toThrow('Missing installed dependency vendor-only required by runtime');
    expect(npm).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
    Module._initPaths();
  }
});

it('uses the hoisted package when a nearer directory has no manifest', async () => {
  fixture('node_modules/runtime/node_modules/shared/README.md', 'Incomplete install');
  npm.mockImplementation((_program, _args, { cwd }) => {
    const fromRuntime = createRequire(join(cwd, 'node_modules/runtime/index.js'));
    expect(fromRuntime.resolve('shared/package.json')).toBe(join(cwd, 'node_modules/shared/package.json'));
    expect(fromRuntime('shared')).toBe('1.0.0');
  });
  await import('./pack.mjs');
  expect(npm).toHaveBeenCalledOnce();
});

it('packages dependencies that refer back to an already visited package', async () => {
  fixture('node_modules/plugin/package.json', JSON.stringify({ name: 'plugin', dependencies: { runtime: '1', shared: '2' } }));
  npm.mockImplementation((_program, _args, { cwd }) => {
    const fromRuntime = createRequire(join(cwd, 'node_modules/runtime/index.js'));
    const fromPlugin = createRequire(fromRuntime.resolve('plugin'));
    expect(fromPlugin.resolve('runtime')).toBe(join(cwd, 'node_modules/runtime/index.js'));
    expect(fromPlugin('shared')).toBe('2.0.0');
  });
  await import('./pack.mjs');
  expect(npm).toHaveBeenCalledOnce();
});

it('ships the TypeScript adapter\'s programs, its TypeScript as JavaScript, without its tests', async () => {
  let staged;
  npm.mockImplementation((_program, _args, { cwd }) => {
    staged = {
      programs: adapterPrograms.map(path => text(join(cwd, path))),
      reporter: text(join(cwd, 'src/adapters/typescript/reporter.js')),
      left: ['src/adapters/typescript/reporter.ts', ...adapterSourceOnly, 'src/adapters/typescript/stryker.test.js']
        .filter(path => existsSync(join(cwd, path))),
    };
  });
  await import('./pack.mjs');
  expect(staged.programs).toEqual(adapterPrograms);
  expect(staged.reporter).toContain("import { x } from './helper.js';");
  expect(staged.reporter).not.toContain(': number');
  expect(staged.left).toEqual([]);
});
