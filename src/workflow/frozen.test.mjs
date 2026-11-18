import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addedFiles, addedIgnoreHints, addedSuppressions, branchChanges, describeFreeze, frozenChanges, implementationChanges, isCode, isFrozen, isTest } from './frozen.mjs';
import { configureTarget, markTarget } from '../../tests/fixtures/workflow/target.mjs';
import { repositoryRulebook, writeConfig } from '../../tests/fixtures/workflow/adapter.mjs';
import { gitCommandsDuring } from '../../tests/fixtures/workflow/trace.mjs';

/**
 * The freeze in words, as the messages give it. The words come from the
 * rulebook, so a project that keeps its fixtures elsewhere is told its own
 * rule rather than this repository's `tests/`.
 */
describe('the freeze in words', () => {
  let dir;
  let cwd;
  beforeEach(() => {
    cwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'freeze-words-'));
    process.chdir(dir);
  });
  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it('names the rulebook\'s test and test support globs', () => {
    writeConfig(dir, { adapter: { paths: { all: ['test_*.py', '*_test.py'], acceptance: ['**/acceptance/**'], support: ['conftest.py', 'testdata/**'] } } });
    expect(describeFreeze()).toBe('Every test file (`test_*.py`, `*_test.py`) and every test support file (`conftest.py`, `testdata/**`) are frozen until the triage has run.');
  });

  it('names only the test files when the rulebook lists no test support', () => {
    writeConfig(dir, { adapter: { paths: { all: ['*_test.go'], acceptance: ['**/acceptance/**'], support: [] } } });
    expect(describeFreeze()).toBe('Every test file (`*_test.go`) is frozen until the triage has run.');
  });

});

/**
 * What the freeze covers, by the rulebook: every test file and every test
 * support file. Read from a rulebook the test writes, so a
 * change to this repository's own globs never fails a test of the rule.
 *
 * Found by the 2026-10-04 red-team pass. Editing a schema fixture during
 * implementation turned a real regression green, and nothing noticed, because
 * the freeze knew only test files.
 */
describe('what the freeze covers', () => {
  let dir;
  let cwd;
  beforeEach(() => {
    cwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'freeze-covers-'));
    process.chdir(dir);
  });
  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  const RUN = { command: 'pytest && python tools/report.py', reportPaths: ['reports/junit.xml'], tagComment: '^\\s*#' };
  const configure = (extraSupport = []) => writeConfig(dir, {
    adapter: { paths: { all: ['**/test_*.py'], acceptance: ['**/acceptance/**'], support: ['testdata/**', 'conftest.py', ...extraSupport] },
      codePaths: ['**/*.py'], run: RUN },
  });

  it('covers every test file the rulebook\'s globs match, wherever it is', () => {
    configure();
    expect(isTest('pkg/test_a.py')).toBe(true);
    expect(isFrozen('pkg/test_a.py')).toBe(true);
    expect(isTest('pkg/a.py')).toBe(false);
    expect(isFrozen('pkg/a.py')).toBe(false);
  });

  it('covers every test support file, test or not', () => {
    configure();
    expect(isFrozen('testdata/schema.sql')).toBe(true);
    expect(isFrozen('conftest.py')).toBe(true);
    expect(isTest('conftest.py')).toBe(false);
  });

  // The reporter writes the test report, so it decides what a test proves as
  // much as the test does.
  it('freezes a report writer listed in test support by its exact path', () => {
    configure(['tools/report.py']);
    expect(isFrozen('tools/report.py')).toBe(true);
    expect(isFrozen('tools/report.pyc')).toBe(false);
    expect(isFrozen('other/tools/report.py')).toBe(false);
    expect(isFrozen('tools/other.py')).toBe(false);
  });

  it('leaves a writer mentioned only in the command editable', () => {
    configure();
    expect(isFrozen('tools/report.py')).toBe(false);
  });

  it('counts as code what the rulebook\'s code globs match', () => {
    configure();
    expect(isCode('pkg/a.py')).toBe(true);
    expect(isCode('pkg/a.md')).toBe(false);
  });
});

/**
 * What the freeze actually reads.
 *
 * `isTest` above says what a test is. This says which of them this branch
 * has touched, and it is the half that decides whether a turn is blocked and
 * whether `workflow triage` will run. The machine cases cover the freeze end to
 * end, but every one of them touches a test the same way — by writing a new
 * file — so a `frozenChanges` blind to deletions or to commits on the branch
 * would pass all of them.
 *
 * Against a real repository rather than a stubbed git, because the whole
 * function is four git invocations and what is being checked is that they
 * answer together.
 */
describe('which frozen files this branch has touched', () => {
  let repo;
  let cwd;

  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  const write = (file, body) => writeFileSync(join(repo, file), body);

  /** A repository holding one test and one source file, committed, and by
   *  default on the target. `frozenChanges` with no baseline compares against
   *  the target's remote-tracking ref, which `markTarget` points here. */
  const start = ({ onTarget = true } = {}) => {
    repo = mkdtempSync(join(tmpdir(), 'workflow-frozen-'));
    execFileSync('git', ['init', '--quiet', '--initial-branch', 'work'], { cwd: repo });
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    configureTarget(repo);
    writeConfig(repo, { fields: { checks: { testQuality: { mutation: 'none', coverage: repositoryRulebook().checks.testQuality.coverage } } } });
    write('kept.test.mjs', 'it("kept", () => {});\n');
    write('impl.mjs', 'export const x = 1;\n');
    git('add', 'kept.test.mjs', 'impl.mjs');
    git('commit', '--quiet', '-m', 'base');
    if (onTarget) markTarget(repo);
    process.chdir(repo);
  };

  beforeEach(() => {
    cwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it('reports a test the branch has committed', () => {
    start();
    git('checkout', '--quiet', '-b', 'feat/x');
    write('kept.test.mjs', 'it("kept", () => {});\n// committed on the branch\n');
    git('commit', '--quiet', '-am', 'edit the test');
    expect(frozenChanges()).toEqual(['kept.test.mjs']);
  });

  it('reports a test edited and not yet committed', () => {
    start();
    write('kept.test.mjs', 'it("kept", () => {});\n// not committed\n');
    expect(frozenChanges()).toEqual(['kept.test.mjs']);
  });

  // Untracked counts, and it is the case that matters most: writing a new test
  // beside the code it covers is the thing the freeze exists to stop, and `git
  // diff` never mentions a file git has not been told about.
  // `git update-index --skip-worktree` tells git to act as if a file has not
  // changed. Every diff then leaves it out, and so did the freeze while a diff
  // was all it asked.
  it('reports a test edited while marked skip-worktree, which no diff shows', () => {
    start();
    git('update-index', '--skip-worktree', 'kept.test.mjs');
    write('kept.test.mjs', 'it("kept", () => {});\n// hidden from git\n');
    expect(git('diff', '--name-only', 'HEAD')).toBe('');
    expect(git('status', '--porcelain', '--', 'kept.test.mjs')).toBe('');
    expect(frozenChanges()).toEqual(['kept.test.mjs']);
  });

  // The older flag, meant for slow filesystems, hides an edit the same way.
  it('reports a test edited while marked assume-unchanged', () => {
    start();
    git('update-index', '--assume-unchanged', 'kept.test.mjs');
    write('kept.test.mjs', 'it("kept", () => {});\n// hidden from git\n');
    expect(git('diff', '--name-only', 'HEAD')).toBe('');
    expect(frozenChanges()).toEqual(['kept.test.mjs']);
  });

  it('reports a fixture under tests/ edited while marked skip-worktree', () => {
    start();
    mkdirSync(join(repo, 'tests/acceptance'), { recursive: true });
    write('tests/acceptance/support.ts', 'export const seed = 1;\n');
    git('add', '-A');
    git('commit', '--quiet', '-m', 'support code');
    markTarget(repo);
    git('update-index', '--skip-worktree', 'tests/acceptance/support.ts');
    write('tests/acceptance/support.ts', 'export const seed = 2;\n');
    expect(frozenChanges()).toEqual(['tests/acceptance/support.ts']);
  });

  it('reports a test deleted while marked skip-worktree', () => {
    start();
    git('update-index', '--skip-worktree', 'kept.test.mjs');
    rmSync(join(repo, 'kept.test.mjs'));
    expect(git('diff', '--name-only', 'HEAD')).toBe('');
    expect(frozenChanges()).toEqual(['kept.test.mjs']);
  });

  // The flag is not the offence. A marked file that still holds what the
  // baseline holds has not been touched.
  it('says nothing about a marked test that was not edited', () => {
    start();
    git('update-index', '--skip-worktree', 'kept.test.mjs');
    expect(frozenChanges()).toEqual([]);
  });

  it('leaves a hidden edit to the implementation out of the freeze', () => {
    start();
    git('update-index', '--skip-worktree', 'impl.mjs');
    write('impl.mjs', 'export const x = 2;\n');
    expect(frozenChanges()).toEqual([]);
  });

  // Contents are compared with the baseline the change is measured from, as
  // the diff is. A test the target gained since is not this change's.
  it('compares contents with the baseline it is given', () => {
    start();
    const base = git('rev-parse', 'HEAD').trim();
    write('kept.test.mjs', 'it("kept", () => {});\n// the target moved on\n');
    git('commit', '--quiet', '-am', 'the target edits the test');
    markTarget(repo);
    git('update-index', '--skip-worktree', 'kept.test.mjs');
    expect(frozenChanges()).toEqual([]);
    expect(frozenChanges(base)).toEqual(['kept.test.mjs']);
  });

  // Each file listed once, whichever of the two ways found it.
  it('lists a file once when the diff and the contents both report it', () => {
    start();
    write('kept.test.mjs', 'it("kept", () => {});\n// plainly edited\n');
    write('new.test.mjs', 'it("new", () => {});\n');
    expect(frozenChanges()).toEqual(['kept.test.mjs', 'new.test.mjs']);
  });

  it('reports a test that git has never been told about', () => {
    start();
    write('brand-new.test.mjs', 'it("new", () => {});\n');
    expect(frozenChanges()).toEqual(['brand-new.test.mjs']);
  });

  it('reports a deleted test', () => {
    start();
    rmSync(join(repo, 'kept.test.mjs'));
    expect(frozenChanges()).toEqual(['kept.test.mjs']);
  });

  it('reports a fixture and support code under tests/, not only tests', () => {
    start();
    mkdirSync(join(repo, 'tests/acceptance/fixtures'), { recursive: true });
    write('tests/acceptance/fixtures/schema.sql', 'create table x (id int);\n');
    write('tests/acceptance/support.ts', 'export const y = 1;\n');
    expect(frozenChanges()).toEqual(['tests/acceptance/fixtures/schema.sql', 'tests/acceptance/support.ts']);
  });

  it('leaves the implementation out of it, tracked or not', () => {
    start();
    write('impl.mjs', 'export const x = 2;\n');
    write('untracked.mjs', 'export const y = 3;\n');
    expect(frozenChanges()).toEqual([]);
  });

  // The comparison is against the target, not against the last commit. A test
  // changed on the target itself is history, not this change.
  it('says nothing about a test already committed on the target', () => {
    start();
    write('kept.test.mjs', 'it("kept", () => {});\n// on the target\n');
    git('commit', '--quiet', '-am', 'edit on the target');
    markTarget(repo);
    expect(frozenChanges()).toEqual([]);
  });

  // A target never fetched must not throw. The freeze then has nothing to
  // compare against and says so by saying nothing.
  it('answers nothing, rather than throwing, when the target has never been fetched', () => {
    start({ onTarget: false });
    expect(frozenChanges()).toEqual([]);
  });

  // The baseline, not the target as it stands. A test the target gained after
  // the branch was cut, and merged into the branch, is not this change's.
  it('measures from the baseline it is given, not from the target as it stands', () => {
    start();
    const baseline = git('rev-parse', 'HEAD').trim();
    git('checkout', '--quiet', '-b', 'feat/x');
    write('kept.test.mjs', 'it("kept", () => {});\n// this change\n');
    git('commit', '--quiet', '-am', 'edit on the branch');
    // Anyone could point the ref at the branch itself. Measured from the ref
    // the freeze would see nothing; measured from the pinned baseline it does.
    markTarget(repo);
    expect(frozenChanges()).toEqual([]);
    expect(frozenChanges(baseline)).toEqual(['kept.test.mjs']);
  });

  // The review areas list an existing requirement that changed and leave a new
  // one out, so this has to tell the two apart whichever way the new file
  // arrived: committed, staged, or not yet known to git.
  it('lists files new since the baseline, and leaves modified and deleted ones out', () => {
    start();
    git('checkout', '--quiet', '-b', 'feat/x');
    write('committed.mjs', 'export const a = 1;\n');
    git('add', 'committed.mjs');
    git('commit', '--quiet', '-m', 'a new file');
    write('staged.mjs', 'export const b = 1;\n');
    git('add', 'staged.mjs');
    write('untracked.mjs', 'export const c = 1;\n');
    write('impl.mjs', 'export const x = 2;\n');
    rmSync(join(repo, 'kept.test.mjs'));
    // The fixture's own `.katatay/rulebook.json` is untracked too, so it is new
    // as well; only the files this case wrote are checked.
    expect(addedFiles().filter((f) => f.endsWith('.mjs')).sort()).toEqual(['committed.mjs', 'staged.mjs', 'untracked.mjs']);
  });

  it('lists only what the index adds when asked about the staged commit', () => {
    start();
    write('staged.mjs', 'export const b = 1;\n');
    write('impl.mjs', 'export const x = 2;\n');
    git('add', 'staged.mjs', 'impl.mjs');
    write('untracked.mjs', 'export const c = 1;\n');
    expect(addedFiles(null, { staged: true })).toEqual(['staged.mjs']);
  });

  /**
   * Both lists from one diff. `changedFiles` and `addedFiles` are now read out
   * of it, so comparing with them would prove nothing. These compare with the
   * git commands the two lists used to be built from, run separately here.
   */
  describe('changed and added, from one diff', () => {
    const lines = (...args) => git(...args).split('\n').filter(Boolean);
    const sorted = (list) => [...new Set(list)].sort();
    const asTwoCalls = (base) => {
      const untracked = lines('ls-files', '--others', '--exclude-standard');
      return {
        changed: sorted([...lines('diff', '--name-only', base), ...lines('diff', '--name-only'), ...untracked]),
        added: sorted([...lines('diff', '--name-only', '--diff-filter=A', base), ...untracked]),
      };
    };
    const asOneCall = (base) => {
      const { changed, added } = branchChanges(base);
      return { changed: sorted(changed), added: sorted(added) };
    };

    // A rename is the line `--name-status` writes differently: it names both
    // paths. Only the new one is reported, as `--name-only` reports it, and it
    // does not count as added, as `--diff-filter=A` does not count it.
    it('gives what the separate diffs gave, renames included', () => {
      start();
      const base = git('rev-parse', 'HEAD').trim();
      git('checkout', '--quiet', '-b', 'feat/x');
      write('impl.mjs', `${'export const x = 1;\n'.repeat(20)}`);
      git('commit', '--quiet', '-am', 'a file worth following');
      const followed = git('rev-parse', 'HEAD').trim();
      git('mv', 'impl.mjs', 'moved.mjs');
      write('committed.mjs', 'export const a = 1;\n');
      git('add', '-A');
      git('commit', '--quiet', '-m', 'a rename and a new file');
      write('kept.test.mjs', 'it("kept", () => {});\n// edited\n');
      write('untracked.mjs', 'export const c = 1;\n');
      expect(asOneCall(followed)).toEqual(asTwoCalls(followed));
      expect(asOneCall(base)).toEqual(asTwoCalls(base));
      expect(asOneCall(followed).changed).toContain('moved.mjs');
    });

    // Given the baseline, as every caller gives it. Without one, finding the
    // target asks git which remotes exist, which is not this function's cost.
    it('asks git three times for both lists', () => {
      start();
      const base = git('rev-parse', 'HEAD').trim();
      write('impl.mjs', 'export const x = 2;\n');
      expect(gitCommandsDuring(() => branchChanges(base))).toHaveLength(3);
    });

    // The check that the base exists now runs only when the diff fails. A
    // base that is not there must still answer empty, not throw.
    it('answers nothing against a base that does not exist, rather than throwing', () => {
      start({ onTarget: false });
      write('impl.mjs', 'export const x = 2;\n');
      expect(branchChanges().added).not.toContain('impl.mjs');
      expect(branchChanges().changed).toContain('impl.mjs');
      expect(branchChanges('0'.repeat(40)).changed).toContain('impl.mjs');
    });
  });

  /**
   * A coverage ignore comment takes code out of the coverage figure, so a
   * folder can stay above its minimum with less of it tested. The review areas
   * name the files that gain one, and this is where they are found.
   */
  describe('files that gain a coverage ignore comment', () => {
    const hinted = (hint = '/* v8 ignore next */') => `export const x = 1;\n${hint}\nexport const y = () => 2;\n`;
    const found = (options = {}) => addedIgnoreHints({ ...branchChanges(), ...options });

    it('finds one added to a tracked file and not yet committed', () => {
      start();
      write('impl.mjs', hinted());
      expect(found()).toEqual(['impl.mjs']);
    });

    it('finds one the branch has committed', () => {
      start();
      git('checkout', '--quiet', '-b', 'feat/x');
      write('impl.mjs', hinted());
      git('commit', '--quiet', '-am', 'ignore a line');
      expect(found()).toEqual(['impl.mjs']);
    });

    // `git diff` never mentions a file git has not been told about, and a new
    // module is as good a place for one as an old one.
    it('finds one in a file git has never been told about', () => {
      start();
      write('brand-new.ts', hinted());
      expect(found()).toEqual(['brand-new.ts']);
    });

    it('finds one in a file the branch added and committed', () => {
      start();
      git('checkout', '--quiet', '-b', 'feat/x');
      write('brand-new.ts', hinted());
      git('add', 'brand-new.ts');
      git('commit', '--quiet', '-m', 'a new module');
      expect(found()).toEqual(['brand-new.ts']);
    });

    // It was reviewed when it merged. Listing it again on every change that
    // touches the file would teach the reviewer to skip the reason.
    it('leaves out a comment that was already there at the baseline', () => {
      start();
      git('checkout', '--quiet', '-b', 'feat/x');
      write('impl.mjs', hinted());
      git('commit', '--quiet', '-am', 'ignore a line');
      markTarget(repo);
      write('impl.mjs', `${hinted()}export const z = 3;\n`);
      // The file has changed. What it gained is not an ignore comment.
      expect(branchChanges().changed).toContain('impl.mjs');
      expect(found()).toEqual([]);
    });

    it('leaves out a change that removes one', () => {
      start();
      git('checkout', '--quiet', '-b', 'feat/x');
      write('impl.mjs', hinted());
      git('commit', '--quiet', '-am', 'ignore a line');
      markTarget(repo);
      write('impl.mjs', 'export const x = 1;\nexport const y = () => 2;\n');
      expect(found()).toEqual([]);
    });

    it('leaves out ordinary edits, and words that only look alike', () => {
      start();
      write('impl.mjs', 'export const x = 2;\n// ignore the next line\nexport const v8 = "ignored";\n');
      expect(found()).toEqual([]);
    });

    // Coverage is measured over code. In a document the words do nothing.
    it('leaves out a file coverage does not measure', () => {
      start();
      write('NOTES.md', 'Write `/* v8 ignore next */` to skip a line.\n');
      write('data.json', '{ "hint": "v8 ignore next" }\n');
      expect(found()).toEqual([]);
    });

    // Coverage does not measure tests, so a comment in one hides nothing. A
    // test that held `'v8 ignore'` as test data used to be listed for it.
    it('leaves out a test file the branch changes', () => {
      start();
      write('kept.test.mjs', hinted());
      write('impl.mjs', hinted());
      expect(found()).toEqual(['impl.mjs']);
    });

    it('leaves out a test file git has never been told about', () => {
      start();
      write('new.test.mjs', hinted());
      write('brand-new.ts', hinted());
      expect(found()).toEqual(['brand-new.ts']);
    });

    // A test support file is not a test. Coverage measures the code among
    // them, so a comment there can hide something.
    it('still finds one in a test support file that is code', () => {
      start();
      writeConfig(repo, { adapter: { paths: { support: ['support/**'] } }, fields: { checks: { testQuality: { mutation: 'none', coverage: repositoryRulebook().checks.testQuality.coverage } } } });
      mkdirSync(join(repo, 'support'));
      write('support/helper.mjs', hinted());
      expect(found()).toEqual(['support/helper.mjs']);
    });

    // A line of code that begins with `++` shows in a patch as `+++`, which is
    // also how a patch names the file. It must not be taken for one.
    it('is not thrown by an added line that starts with ++', () => {
      start();
      write('impl.mjs', 'let n = 0;\n++n; /* b/other.mjs */\n/* v8 ignore next */\nexport const x = n;\n');
      expect(found()).toEqual(['impl.mjs']);
    });

    describe('for a commit message', () => {
      it('reads what is staged, and nothing that is not', () => {
        start();
        write('impl.mjs', hinted());
        write('other.mjs', hinted());
        git('add', 'other.mjs');
        expect(addedIgnoreHints({ staged: true })).toEqual(['other.mjs']);
      });

      it('leaves out a staged test file', () => {
        start();
        write('kept.test.mjs', hinted());
        write('new.test.mjs', hinted());
        write('impl.mjs', hinted());
        git('add', 'kept.test.mjs', 'new.test.mjs', 'impl.mjs');
        expect(addedIgnoreHints({ staged: true })).toEqual(['impl.mjs']);
      });

      // The index holds the file as the commit will. The working tree may
      // have moved on.
      it('reads a staged new file from the index, not from disk', () => {
        start();
        write('brand-new.ts', 'export const a = 1;\n');
        git('add', 'brand-new.ts');
        write('brand-new.ts', hinted());
        expect(addedIgnoreHints({ added: ['brand-new.ts'], staged: true })).toEqual([]);
      });
    });

    // The added files are read from the list the caller already has, so the
    // review areas cost one more git process and not two.
    it('asks git once', () => {
      start();
      const base = git('rev-parse', 'HEAD').trim();
      write('impl.mjs', hinted());
      write('brand-new.ts', hinted());
      const { added } = branchChanges(base);
      let files;
      expect(gitCommandsDuring(() => { files = addedIgnoreHints({ base, added }); })).toHaveLength(1);
      expect(files).toEqual(['brand-new.ts', 'impl.mjs']);
    });

    it('answers nothing against a base that does not exist, rather than throwing', () => {
      start({ onTarget: false });
      write('impl.mjs', hinted());
      expect(addedIgnoreHints()).toEqual([]);
    });

    // How the comment is spelt is the language's business, so the patterns
    // are the coverage entry's. A Python project's `pragma: no cover` is found once
    // its config says so, and JavaScript's spellings mean nothing there.
    it('finds the spellings the coverage entry lists, whatever the language', () => {
      start();
      writeConfig(repo, { adapter: {
        codePaths: ['**/*.py'],
      }, fields: { checks: { testQuality: { mutation: 'none', coverage: { ...repositoryRulebook().checks.testQuality.coverage, suppressions: ['pragma:\\s*no cover'] } } } } });
      write('impl.py', 'x = 1\nif debug:  # pragma: no cover\n    pass\n');
      write('other.py', '# v8 ignore next\ny = 2\n');
      expect(found()).toEqual(['impl.py']);
    });

    // With no coverage figure to keep up, an ignore comment dodges nothing.
    it('finds none when the rulebook switches coverage off', () => {
      start();
      writeConfig(repo, { fields: { checks: { testQuality: { mutation: 'none', coverage: 'none' } } } });
      write('impl.mjs', hinted());
      expect(repositoryRulebook().checks.testQuality.coverage).toHaveProperty('command');
      expect(found()).toEqual([]);
    });
  });

  /**
   * A check's suppression comment, such as `eslint-disable`, silences the
   * check where it sits with no test failing. The review areas name the file
   * under the check, and this is where they are found.
   */
  describe('files that gain a check\'s suppression comment', () => {
    const LINT = { name: 'lint', suppressions: ['eslint-disable'] };
    const SCAN = { name: 'scan', suppressions: ['#\\s*nosec\\b', 'nosemgrep'] };
    const found = (checks, options = {}) => addedSuppressions({ ...branchChanges(), checks, ...options });

    it('finds each check\'s comments, by check, in the order the checks are given', () => {
      start();
      write('impl.mjs', 'export const x = 1; // eslint-disable-line\n');
      write('job.ts', 'run(cmd); // nosemgrep\n');
      expect(found([SCAN, LINT])).toEqual([{ name: 'scan', files: ['job.ts'] }, { name: 'lint', files: ['impl.mjs'] }]);
    });

    // A lint reads tests too, so a comment there silences it there. Coverage
    // is the one rule that leaves tests out, because it does not measure them.
    it('finds one in a test file, unlike coverage', () => {
      start();
      write('kept.test.mjs', '// eslint-disable-next-line\nit("kept", () => {});\n');
      expect(found([LINT])).toEqual([{ name: 'lint', files: ['kept.test.mjs'] }]);
    });

    it('leaves out a comment that was already there at the baseline, and a file that is not code', () => {
      start();
      write('impl.mjs', '// eslint-disable-next-line\nexport const x = 1;\n');
      git('commit', '--quiet', '-am', 'a reviewed suppression');
      markTarget(repo);
      write('impl.mjs', '// eslint-disable-next-line\nexport const x = 2;\n');
      write('notes.md', 'eslint-disable is how to silence it\n');
      expect(found([LINT])).toEqual([]);
    });

    it('lists no check that gained none, and asks git nothing when no check has suppressions', () => {
      start();
      write('impl.mjs', 'export const x = 2;\n');
      expect(found([LINT, SCAN])).toEqual([]);
      const changes = branchChanges();
      expect(gitCommandsDuring(() => { expect(addedSuppressions({ ...changes, checks: [{ name: 'build', suppressions: [] }] })).toEqual([]); })).toHaveLength(0);
    });

    it('reads a staged file for a commit message, and nothing that is not staged', () => {
      start();
      write('impl.mjs', 'x; // eslint-disable-line\n');
      write('other.mjs', 'y; // eslint-disable-line\n');
      git('add', 'other.mjs');
      expect(addedSuppressions({ staged: true, checks: [LINT] })).toEqual([{ name: 'lint', files: ['other.mjs'] }]);
    });

    it('reads the checks from the rulebook when none are given', () => {
      start();
      writeConfig(repo, { fields: { checks: { testQuality: { mutation: 'none', coverage: 'none' }, codeQuality: { lint: { command: 'lint', exitCodes: { 0: 'clean', 1: 'findings' }, suppressions: ['eslint-disable'] } } } } });
      write('impl.mjs', 'x; // eslint-disable-line\n');
      expect(addedSuppressions({ ...branchChanges() })).toEqual([{ name: 'lint', files: ['impl.mjs'] }]);
    });
  });
});

/**
 * Whether there is an implementation for a triage to be about.
 *
 * "Nothing broke" and "nothing was implemented" print the same numbers, so this
 * is the only thing that can tell them apart. The bookkeeping has to come out:
 * the workflow logbook gains an event on every turn, and the change file is written
 * after the work is finished.
 */
describe('which changed files are implementation', () => {
  it('reports source files, sorted', () => {
    expect(implementationChanges(['tools/b.mjs', 'app/a.tsx'])).toEqual(['app/a.tsx', 'tools/b.mjs']);
  });

  it('leaves out the tests, whatever they are written in', () => {
    expect(implementationChanges(['a.test.ts', 'b.test.tsx', 'c.test.mjs'])).toEqual([]);
  });

  it('leaves out everything under tests/, which is frozen like the tests', () => {
    expect(implementationChanges(['tests/support/app-server.ts', 'tests/acceptance/fixtures/schema/x.sql'])).toEqual([]);
  });

  it('leaves out the machine\'s own bookkeeping', () => {
    expect(implementationChanges([
      '.katatay/state/feat_x/0001__plan_approved.json',
      'FOLLOW-UPS.md',
      'requirements/changes/20260101T000000.000Z__a-change.md',
    ])).toEqual([]);
  });

  // The template is tooling, not history: editing it changes how every later
  // change file is written. `tree.mjs` draws the same line for the fingerprint.
  it('counts the change-file template, which is tooling', () => {
    expect(implementationChanges(['requirements/changes/TEMPLATE.md'])).toEqual(['requirements/changes/TEMPLATE.md']);
  });

  // A requirement is what the product must do. Editing one is the most
  // consequential thing a change can do, and it is certainly not a test.
  it('counts a requirement', () => {
    expect(implementationChanges(['requirements/acceptance/AC0001.md'])).toEqual(['requirements/acceptance/AC0001.md']);
  });

  it('keeps the implementation when tests changed alongside it', () => {
    expect(implementationChanges(['src/workflow/frozen.mjs', 'src/workflow/frozen.test.mjs'])).toEqual(['src/workflow/frozen.mjs']);
  });
});
