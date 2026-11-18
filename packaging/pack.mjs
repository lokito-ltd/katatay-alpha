import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-api';

const root = fileURLToPath(new URL('../', import.meta.url));
const stage = mkdtempSync(join(tmpdir(), 'katatay-pack-'));
// Tests that build the tarball name a folder of their own, so two test files
// building at once never write the same archive. An environment variable,
// because a test imports this module inside a Vitest worker, where
// process.argv holds Vitest's own arguments.
const dest = process.env.KATATAY_PACK_DESTINATION || join(root, 'dist');

function stageFile(path, target = path) {
  const source = join(root, path);
  const output = join(stage, target.replace(/\.ts$/, '.js'));
  mkdirSync(dirname(output), { recursive: true });
  if (path.endsWith('.ts')) {
    const built = ts.transpileModule(readFileSync(source, 'utf8'), {
      fileName: path, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    });
    writeFileSync(output, built.outputText);
  } else copyFileSync(source, output);
}

function stagePrograms(folder) {
  for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) {
      stagePrograms(path);
    } else if (/\.(mjs|ts)$/.test(entry.name) && !entry.name.includes('.test.')) stageFile(path);
    else if (folder === 'src/workflow/skills' || folder === 'src/workflow/catalogue' || path === 'src/workflow/INSTRUCTIONS.md') stageFile(path);
  }
}

function stageDependencies() {
  const release = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8'));
  const modules = join(root, 'node_modules');
  const copied = new Set();

  function copyDependency(name, parent, requiredBy) {
    // Use Node's lookup order, bounded to the checkout. Looking up the
    // directory also works for packages that don't export package.json.
    const locations = createRequire(join(parent, 'package.json')).resolve.paths(name);
    const source = locations
      .filter(dir => dir === modules || dir.startsWith(modules + sep))
      .map(dir => join(dir, name))
      .find(dir => existsSync(join(dir, 'package.json')));
    if (!source) throw new Error(`Missing installed dependency ${name} required by ${requiredBy}`);
    if (copied.has(source)) return;
    copied.add(source);

    // Preserve hoisting and nested versions. Each nested dependency gets
    // copied by its own visit, so unrelated packages stay out of the stage.
    cpSync(source, join(stage, relative(root, source)), {
      recursive: true, filter: path => basename(path) !== 'node_modules',
    });
    const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      copyDependency(dependency, source, manifest.name);
    }
  }

  for (const name of release.bundleDependencies) copyDependency(name, root, release.name);
}

try {
  stageFile('packaging/katatay/package.json', 'package.json');
  stageFile('packaging/katatay/README.md', 'README.md');
  // Apache 2.0 asks anyone who redistributes the work to pass the licence on,
  // and the tarball is a redistribution. npm packs a LICENSE at the root.
  stageFile('LICENSE');
  for (const folder of ['workflow', 'requirements', 'evidence', 'agents', 'katatay']) stagePrograms(`src/${folder}`);
  // Projects use the TypeScript adapter from the installed package: `ktty path`.
  stagePrograms('src/adapters/typescript');
  for (const file of ['src/schema-version.mjs', 'src/distribution.mjs', 'src/adapters/skills/ktty-init.md']) stageFile(file);
  for (const name of readdirSync(join(root, 'src/schemas'))) {
    if (name.endsWith('.schema.json')) stageFile('src/schemas/' + name);
  }
  stageFile('src/agents/contract.json');
  stageDependencies();
  mkdirSync(dest, { recursive: true });
  execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', dest, '--quiet'], { cwd: stage, stdio: 'inherit' });
} finally {
  rmSync(stage, { recursive: true, force: true });
}
