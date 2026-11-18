// Steps for the Packaging scenarios: build the checkout's release tarball,
// install it into a throwaway machine, and run what the install left behind.
//
// These steps check the package, not a `ktty` already on the path, so they
// ignore KTTY_BIN.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { onTestFinished } from 'vitest';

const checkout = resolve(import.meta.dirname, '../../..');
let built;

// Built once per test file, into a folder of its own: another test file may
// build at the same time, and `dist/` would be shared.
export function givenTheReleaseTarball() {
  if (built) return built;
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'katatay-release-')));
  process.on('exit', () => rmSync(folder, { recursive: true, force: true }));
  execFileSync('npm', ['run', 'pack:katatay'], {
    cwd: checkout, stdio: 'pipe',
    env: { ...process.env, KATATAY_PACK_DESTINATION: folder, npm_config_cache: join(folder, 'build-cache') },
  });
  const [name] = readdirSync(folder).filter((file) => file.endsWith('.tgz'));
  built = join(folder, name);
  return built;
}

// A machine with nothing installed: an empty global npm prefix, an empty home
// folder, and on PATH only the prefix's bin, Node, npm, git and the system
// folders. An npm script would otherwise inherit the checkout's
// node_modules/.bin. `env` adds to its environment, such as CLAUDE_CONFIG_DIR.
export function givenAMachine({ env = {} } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'katatay-machine-')));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const prefix = join(root, 'npm prefix');
  const home = join(root, 'user home');
  const tools = join(root, 'system bin');
  for (const folder of [home, tools]) mkdirSync(folder);
  symlinkSync(process.execPath, join(tools, 'node'));
  for (const name of ['npm', 'git']) {
    const file = process.env.PATH.split(delimiter).map((dir) => join(dir, name)).find(existsSync);
    symlinkSync(realpathSync(file), join(tools, name));
  }
  return {
    root, prefix, home,
    env: {
      PATH: [join(prefix, 'bin'), tools, '/usr/bin', '/bin'].join(delimiter), HOME: home,
      npm_config_cache: join(root, 'npm cache'),
      GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
      ...env,
    },
  };
}

export function givenAFile(path, contents) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, contents);
}

// A project that brings its own Vitest, TypeScript and Stryker: this
// checkout's node_modules, linked. `files` maps a path in the project to its
// contents.
export function givenAProjectWithItsOwnPackages(machine, files) {
  const project = join(machine.root, 'typescript project');
  mkdirSync(project);
  symlinkSync(join(checkout, 'node_modules'), join(project, 'node_modules'));
  for (const [path, contents] of Object.entries(files)) givenAFile(join(project, path), contents);
  return project;
}

function run(machine, command, args, { cwd = machine.root, input, env = {} } = {}) {
  const { status, stdout, stderr, error } = spawnSync(command, args, {
    cwd, input, env: { ...machine.env, ...env }, encoding: 'utf8',
  });
  if (error) throw error;
  return { status, stdout, stderr };
}

// Installs offline: the machine's npm cache is empty, so whatever the package
// needs has to be inside the tarball.
export function whenNpmInstalls(machine, tarball) {
  return run(machine, 'npm', ['install', '--global', '--prefix', machine.prefix, '--offline', '--foreground-scripts',
    `--allow-scripts=file:${tarball}`, tarball]);
}

// For a scenario about what the install left behind: an install that fails
// here is a broken fixture, and says why.
export function givenKatatayInstalled(machine, tarball) {
  const install = whenNpmInstalls(machine, tarball);
  if (install.status !== 0) throw new Error(`npm install exited ${install.status}:\n${install.stdout}${install.stderr}`);
}

export function whenInstalledKttyRuns(machine, args) {
  return run(machine, 'ktty', args);
}

// `command` is a shell command, run in `project` with the machine's PATH, so
// it can use `$(ktty path)` as a project's own configuration would.
export function whenTheProjectRuns(machine, project, command, { input, env } = {}) {
  return run(machine, 'sh', ['-c', command], { cwd: project, input, env });
}

export function whenTheTarballIsListed(tarball) {
  return execFileSync('tar', ['-tf', tarball], { encoding: 'utf8' }).trim().split('\n');
}

export function whenTheTarballManifestIsRead(tarball) {
  return JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }));
}

export function whenAFileIsRead(path) {
  return readFileSync(path, 'utf8');
}

export function whenAPathIsResolved(path) {
  return realpathSync(path);
}

export function whenAPathIsChecked(path) {
  return existsSync(path);
}
