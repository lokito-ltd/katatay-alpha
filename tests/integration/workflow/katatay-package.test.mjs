import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { payload as claudePayload } from '../../fixtures/claude/payloads.mjs';
import { payload as codexPayload } from '../../fixtures/codex/payloads.mjs';

const repo = resolve('.');
const read = path => readFileSync(path, 'utf8');
let suite, temp, systemBin, archive;

beforeAll(() => {
  suite = realpathSync(mkdtempSync(join(tmpdir(), 'katatay-release-')));
  // Into a folder of its own: the Packaging acceptance tests build at the same time.
  const built = join(suite, 'dist');
  execFileSync('npm', ['run', 'pack:katatay'], {
    cwd: repo, env: { ...process.env, KATATAY_PACK_DESTINATION: built, npm_config_cache: join(suite, 'build-cache') }, stdio: 'pipe',
  });
  archive = join(built, readdirSync(built).find(name => name.endsWith('.tgz')));
  // Expose only the runtime, package manager, Git and POSIX utilities to the consumer.
  // An npm script normally inherits the source checkout's node_modules/.bin.
  systemBin = join(suite, 'system-bin');
  mkdirSync(systemBin);
  symlinkSync(process.execPath, join(systemBin, 'node'));
  for (const name of ['npm', 'git']) {
    const file = process.env.PATH.split(delimiter).map(dir => join(dir, name)).find(existsSync);
    symlinkSync(realpathSync(file), join(systemBin, name));
  }
});
afterAll(() => rmSync(suite, { recursive: true, force: true }));
beforeEach(() => { temp = mkdtempSync(join(suite, 'trial-')); });
afterEach(() => rmSync(temp, { recursive: true, force: true }));

function machine(label) {
  const prefix = join(temp, label, 'npm prefix');
  const home = join(temp, label, 'user home');
  mkdirSync(home, { recursive: true });
  return { prefix, home, env: {
    PATH: [join(prefix, 'bin'), systemBin, '/usr/bin', '/bin'].join(delimiter), HOME: home,
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid', GIT_CONFIG_NOSYSTEM: '1',
  } };
}

function run({ env }, cwd, command, args, { status = 0, input } = {}) {
  const result = spawnSync(command, args, { cwd, env, input, encoding: 'utf8' });
  if (result.error) throw result.error;
  expect(result.status, result.stdout + result.stderr).toBe(status);
  return { stdout: result.stdout, stderr: result.stderr };
}

function install(host, status = 0) {
  return run(host, temp, 'npm', ['install', '--global', '--prefix', host.prefix, '--offline', '--foreground-scripts',
    `--allow-scripts=file:${archive}`, archive], { status });
}

function createProject(host, project) {
  mkdirSync(join(project, 'src'), { recursive: true });
  mkdirSync(join(project, 'tests'));
  run(host, project, 'git', ['init', '-qb', 'main']);
  writeFileSync(join(project, '.gitignore'), 'reports/\n');
  writeFileSync(join(project, 'src/sum.sh'), 'echo 4\n');
  writeFileSync(join(project, 'tests/sum.sh'), 'test "$(sh src/sum.sh)" = 4\n');
  writeFileSync(join(project, 'test.sh'), `mkdir -p reports
if sh tests/sum.sh; then failure=''; result=0; else failure='<failure message="wrong sum"/>'; result=1; fi
echo "<testsuites><testsuite name='math'><testcase file='tests/sum.sh' name='sum'>$failure</testcase></testsuite></testsuites>" > reports/junit.xml
exit "$result"
`);
  const answers = join(temp, 'answers.json');
  writeFileSync(answers, JSON.stringify({
    'tests.all': ['tests/*.sh'], 'tests.acceptance': ['acceptance/**'], code: ['src/**'],
    'testRun.command': 'sh test.sh', 'testRun.reports': ['reports/junit.xml'], 'testRun.tagComment': '^#',
  }));
  return answers;
}

it('initializes from PATH and still checks the project and runs both hooks after the first installation is removed', () => {
  const first = machine('first');
  install(first);
  const project = join(temp, 'original project');
  const answers = createProject(first, project);
  const init = ['init', '--project', project, '--answers', answers];
  const questions = JSON.parse(run(first, temp, 'ktty', ['init', '--questions']).stdout);
  expect(questions.questions.map(question => question.id)).toContain('testRun.command');
  expect(run(first, temp, 'ktty', [...init, '--probe']).stdout).toContain('all passing');
  expect(existsSync(join(project, '.katatay/rulebook.json'))).toBe(false);

  mkdirSync(join(project, '.claude'));
  writeFileSync(join(project, '.claude/settings.json'), JSON.stringify({ model: 'existing setting' }));
  run(first, temp, 'ktty', init);
  expect(JSON.parse(read(join(project, '.claude/settings.json'))).model).toBe('existing setting');
  for (const path of ['AGENTS.md', '.claude/rules/workflow.md']) expect(read(join(project, path))).toContain('ktty verify');
  const adapters = JSON.parse(read(join(project, '.katatay/rulebook.json'))).agent.adapters;
  for (const name of ['claude', 'codex']) expect(adapters[name].checkCommand).toBe(`ktty agent ${name} check`);
  const git = (...args) => run(first, project, 'git', args).stdout;
  git('add', '.');
  for (const path of git('ls-files', '-z').split('\0').filter(Boolean)) {
    for (const location of [repo, temp]) expect(read(join(project, path)), path).not.toContain(location);
  }
  const remote = join(temp, 'origin.git');
  git('init', '--bare', '-q', remote);
  git('remote', 'add', 'origin', remote);
  git('commit', '-qm', 'Initial setup');
  git('push', '-q', 'origin', 'main');
  git('switch', '-qc', 'working');
  run(first, project, 'ktty', ['init', '--answers', answers]);
  expect(git('status', '--porcelain')).toBe('');

  const second = machine('second');
  install(second);
  const moved = join(temp, 'moved project');
  renameSync(project, moved);
  rmSync(dirname(first.prefix), { recursive: true });
  const ktty = (...args) => run(second, moved, 'ktty', args).stdout;
  expect(ktty('verify')).toContain('tests — 1 ran, none failed');
  for (const [args, message] of [
    [['req', 'lint'], 'catalogue OK'], [['req', 'guard'], 'no protected requirement'],
    [['req', 'trace'], 'every active requirement has evidence'], [['req', 'risk'], '\nRisk: LOW\n'],
    [['report'], 'Change report preview'],
  ]) expect(ktty(...args)).toContain(message);
  expect(run(second, moved, 'ktty', ['req', 'renumber'], { status: 2 }).stderr).toBe("Usage: ktty req renumber <fromId> <toId>.\nRun 'ktty help' for usage.\n");

  const paths = { repo: moved, home: second.home };
  for (const [file, input] of [
    ['.claude/settings.json', claudePayload('pre-tool-use-write', {}, paths)],
    ['.codex/hooks.json', codexPayload('pre-tool-use-apply-patch', {}, paths)],
  ]) {
    const command = JSON.parse(read(join(moved, file))).hooks.PreToolUse[0].hooks[0].command;
    const { stdout } = run(second, moved, 'sh', ['-c', command], { input: JSON.stringify(input) });
    expect(JSON.parse(stdout).hookSpecificOutput).toMatchObject({
      permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('No plan has been approved'),
    });
  }
  writeFileSync(join(moved, 'src/sum.sh'), 'echo 5\n');
  expect(ktty('init', '--probe', '--expect', 'failing-test')).toContain('1 failed');
  const failed = run(second, moved, 'ktty', ['verify'], { status: 1 });
  expect(failed.stdout + failed.stderr).toContain('tests/sum.sh — sum (wrong sum)');
}, 60_000);
