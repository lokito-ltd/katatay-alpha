import { it } from 'vitest';
import { join } from 'node:path';
import { thenItExits, thenItPrintsLines } from '../support/ktty.mjs';
import {
  thenValueIs, thenValuesEqual, thenContains, thenTextMatches, thenStderrContains,
} from '../support/assertions.mjs';
import {
  givenAFile,
  givenAMachine,
  givenAProjectWithItsOwnPackages,
  givenKatatayInstalled,
  givenTheReleaseTarball,
  whenAFileIsRead,
  whenAPathIsChecked,
  whenAPathIsResolved,
  whenInstalledKttyRuns,
  whenNpmInstalls,
  whenTheProjectRuns,
  whenTheTarballIsListed,
  whenTheTarballManifestIsRead,
} from '../support/package.mjs';

// Each case installs a real package, and some run the project's own tools.
const INSTALL = 60_000;

it('The tarball installs with npm without the network, its one runtime dependency bundled. [AC0074.1]', () => {
  const tarball = givenTheReleaseTarball();
  const machine = givenAMachine();

  const install = whenNpmInstalls(machine, tarball);

  thenItExits(install, 0);
  const manifest = whenTheTarballManifestIsRead(tarball);
  thenValuesEqual(manifest.dependencies, { 'gray-matter': '4.0.3' });
  thenValuesEqual(manifest.bundleDependencies, ['gray-matter']);
  const installed = join(machine.prefix, 'lib/node_modules/katatay/node_modules/gray-matter/package.json');
  thenValueIs(whenAPathIsChecked(installed), true, installed);
}, INSTALL);

it('The install puts the same ktty-init skill in the Claude Code and Codex user skill folders. [AC0074.2]', () => {
  const tarball = givenTheReleaseTarball();
  const machine = givenAMachine();

  const install = whenNpmInstalls(machine, tarball);

  thenItExits(install, 0);
  const claude = whenAFileIsRead(join(machine.home, '.claude/skills/ktty-init/SKILL.md'));
  const codex = whenAFileIsRead(join(machine.home, '.codex/skills/ktty-init/SKILL.md'));
  thenContains(claude, 'name: ktty-init');
  thenValueIs(codex, claude);
}, INSTALL);

it('With CLAUDE_CONFIG_DIR and CODEX_HOME set, the install puts the ktty-init skill under those folders. [AC0074.3]', () => {
  const tarball = givenTheReleaseTarball();
  const machine = givenAMachine();
  const claudeConfig = join(machine.root, 'claude config');
  const codexHome = join(machine.root, 'codex home');
  const configured = { ...machine, env: { ...machine.env, CLAUDE_CONFIG_DIR: claudeConfig, CODEX_HOME: codexHome } };

  const install = whenNpmInstalls(configured, tarball);

  thenItExits(install, 0);
  thenContains(whenAFileIsRead(join(claudeConfig, 'skills/ktty-init/SKILL.md')), 'name: ktty-init');
  thenContains(whenAFileIsRead(join(codexHome, 'skills/ktty-init/SKILL.md')), 'name: ktty-init');
  thenValueIs(whenAPathIsChecked(join(machine.home, '.claude/skills/ktty-init/SKILL.md')), false);
  thenValueIs(whenAPathIsChecked(join(machine.home, '.codex/skills/ktty-init/SKILL.md')), false);
}, INSTALL);

it('Reinstalling the same release over its own ktty-init skills succeeds and leaves them unchanged. [AC0074.4]', () => {
  const tarball = givenTheReleaseTarball();
  const machine = givenAMachine();
  givenKatatayInstalled(machine, tarball);
  const claudeSkill = join(machine.home, '.claude/skills/ktty-init/SKILL.md');
  const codexSkill = join(machine.home, '.codex/skills/ktty-init/SKILL.md');
  const before = [whenAFileIsRead(claudeSkill), whenAFileIsRead(codexSkill)];

  const reinstall = whenNpmInstalls(machine, tarball);

  thenItExits(reinstall, 0);
  thenValuesEqual([whenAFileIsRead(claudeSkill), whenAFileIsRead(codexSkill)], before);
}, INSTALL);

it('A different ktty-init skill already in a user skill folder is kept, and the install fails, naming that file. [AC0074.5]', () => {
  const tarball = givenTheReleaseTarball();
  const machine = givenAMachine();
  const ownSkill = join(machine.home, '.codex/skills/ktty-init/SKILL.md');
  givenAFile(ownSkill, 'my own setup skill');

  const install = whenNpmInstalls(machine, tarball);

  thenItExits(install, 1);
  thenStderrContains(install, ownSkill);
  thenValueIs(whenAFileIsRead(ownSkill), 'my own setup skill');
}, INSTALL);

it('The installed ktty version prints the release in the package. [AC0074.6]', () => {
  const tarball = givenTheReleaseTarball();
  const machine = givenAMachine();
  givenKatatayInstalled(machine, tarball);
  const release = whenTheTarballManifestIsRead(tarball).version;

  const version = whenInstalledKttyRuns(machine, ['version']);

  thenItExits(version, 0);
  thenItPrintsLines(version, [`Katatay ${release}`, /^Schema \d+$/]);
}, INSTALL);

it('The installed ktty path prints the folder the package is installed in. [AC0074.7]', () => {
  const tarball = givenTheReleaseTarball();
  const machine = givenAMachine();
  givenKatatayInstalled(machine, tarball);

  const path = whenInstalledKttyRuns(machine, ['path']);

  thenItExits(path, 0);
  thenValueIs(path.stdout, `${join(whenAPathIsResolved(machine.prefix), 'lib/node_modules/katatay')}\n`);
}, INSTALL);

it('The tarball holds the programs, the agent instructions, the skills, the schemas and the TypeScript adapter. [AC0075.1]', () => {
  const tarball = givenTheReleaseTarball();

  const entries = whenTheTarballIsListed(tarball);

  for (const entry of [
    'package/src/katatay/cli.mjs',
    'package/src/workflow/cli/workflow.mjs',
    'package/src/agents/claude/hooks/pre-tool.mjs',
    'package/src/agents/codex/hooks/pre-tool.mjs',
    'package/src/agents/contract.json',
    'package/src/workflow/INSTRUCTIONS.md',
    'package/src/workflow/skills/plan-change.md',
    'package/src/workflow/catalogue/TEMPLATE.md',
    'package/src/adapters/skills/ktty-init.md',
    'package/src/schemas/rulebook.schema.json',
    'package/src/schemas/hooks.schema.json',
    'package/src/schemas/plan-approved.schema.json',
    'package/src/adapters/typescript/vitest-junit-reporter.js',
    'package/src/adapters/typescript/stryker-mutate.js',
    'package/src/adapters/typescript/process-only.js',
  ]) thenContains(entries, entry);
});

it('The tarball holds no tests, fixtures or machine harness. [AC0075.2]', () => {
  const tarball = givenTheReleaseTarball();

  const entries = whenTheTarballIsListed(tarball);

  thenValuesEqual(entries.filter((entry) => /^package\/(tests|\.katatay|\.git|requirements)\//.test(entry)
    || /^package\/src\/.*(\.ts$|\.test\.|\/fixtures\/|\/machine\/)/.test(entry)), []);
});

it('The tarball bundles neither TypeScript nor Stryker. [AC0075.3]', () => {
  const tarball = givenTheReleaseTarball();

  const entries = whenTheTarballIsListed(tarball);

  thenValuesEqual(entries.filter((entry) => /^package\/node_modules\/(typescript|typescript-api|@stryker-mutator)\//.test(entry)), []);
});

it('The TypeScript adapter\'s JUnit reporter runs from the install with the project\'s own TypeScript. [AC0075.4]', () => {
  const tarball = givenTheReleaseTarball();
  const machine = givenAMachine();
  givenKatatayInstalled(machine, tarball);
  const project = givenAProjectWithItsOwnPackages(machine, {
    'package.json': '{ "type": "module" }\n',
    'vitest.config.mjs': "export default { test: { includeTaskLocation: true, maxWorkers: 1, fileParallelism: false, include: ['*.test.ts'] } };\n",
    'sum.test.ts': "import { expect, it } from 'vitest';\nit('adds', () => {\n  expect(1 + 1).toBe(2);\n});\n",
  });

  const run = whenTheProjectRuns(machine, project,
    'node node_modules/vitest/vitest.mjs run --reporter "$(ktty path)/src/adapters/typescript/vitest-junit-reporter.js"',
    { env: { JUNIT_REPORT: 'reports/junit.xml' } });

  thenItExits(run, 0);
  thenTextMatches(run.stderr, /vitest-junit-reporter: TypeScript 6\.\d+\.\d+ from typescript-api/);
  thenTextMatches(whenAFileIsRead(join(project, 'reports/junit.xml')),
    /<testcase name="adds"[^>]*>\s*<properties>\s*<property name="line" value="2"\/>\s*<property name="endLine" value="4"\/>/);
}, INSTALL);

it('The TypeScript adapter\'s mutation program runs from the install with the project\'s own Stryker. [AC0075.5]', () => {
  const tarball = givenTheReleaseTarball();
  const machine = givenAMachine();
  givenKatatayInstalled(machine, tarball);
  const project = givenAProjectWithItsOwnPackages(machine, {
    'package.json': '{ "type": "module" }\n',
    '.gitignore': 'reports/\n.stryker-tmp/\n',
    'vitest.config.mjs': "export default { test: { maxWorkers: 1, fileParallelism: false, include: ['*.test.mjs'] } };\n",
    'sum.mjs': 'export function sum(a, b) {\n  return a + b;\n}\n',
    'sum.test.mjs': "import { expect, it } from 'vitest';\nimport { sum } from './sum.mjs';\nit('adds', () => {\n  expect(sum(2, 3)).toBe(5);\n});\n",
  });

  const run = whenTheProjectRuns(machine, project,
    'node "$(ktty path)/src/adapters/typescript/stryker-mutate.js" --vitest-config vitest.config.mjs',
    { input: JSON.stringify({ targets: [{ file: 'sum.mjs', lines: [1, 3] }], budget: null }) });

  thenItExits(run, 0);
  const report = JSON.parse(whenAFileIsRead(join(project, 'reports/mutation/mutation.json')));
  const statuses = report.files['sum.mjs'].mutants.map((mutant) => mutant.status);
  thenValueIs(statuses.length > 0, true, JSON.stringify(statuses));
  thenValuesEqual(statuses.filter((status) => status !== 'Killed'), []);
}, 120_000);
