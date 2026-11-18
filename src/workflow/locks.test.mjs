/**
 * The lock rules, decided in process. The conformance suite in
 * `tests/acceptance/locks/` and `tests/acceptance/invariants/` drives the same
 * rules through `ktty`, the Claude hook included.
 *
 * Many cases came from the Claude path-protection hook's own tests, which
 * these rules replace. The ones about git commands, `cd` and quoted text are
 * gone with the rules that read them: rule b names a locked path together with
 * a write marker, and nothing cleverer (see "Decisions" in
 * `src/agents/README.md`). What it lets through is pinned here too, so a
 * later change to it is a decision someone sees.
 */
import { describe, expect, it } from 'vitest';
import { REFEREE_LOCKS, lockRules, lockTest, locksFor } from './locks.mjs';

const ROOT = '/repo';
const HOME = '/home/me';
const AGENT = ['.claude/settings.json', '.claude/settings.local.json', '.claude/hooks/**', '~/.claude/settings.json', '/etc/agent/config.toml'];

const rules = (requirements = 'requirements') => lockRules({ root: ROOT, home: HOME, agentLocked: AGENT, requirements });
const write = (path, removes = false, requirements) => rules(requirements).forWrite({ path: path.startsWith('/') ? path : `${ROOT}/${path}`, delete: removes });
const bash = (command, requirements) => rules(requirements).forCommand(command);

describe('the referee\'s own locks', () => {
  it('lock the logbook, the rulebook and the git directory, whatever the rulebook says', () => {
    expect(REFEREE_LOCKS.map((lock) => lock.glob)).toEqual(['.katatay/**', '.git/**']);
    const bare = lockRules({ root: ROOT, home: HOME, agentLocked: [], requirements: 'requirements' });
    expect(bare.forWrite({ path: `${ROOT}/.katatay/state/b/0001__verified.json`, delete: false })).toMatch(/workflow logbook/);
    expect(bare.forWrite({ path: `${ROOT}/.katatay/rulebook.json`, delete: false })).toMatch(/workflow logbook/);
    expect(bare.forWrite({ path: `${ROOT}/.git/config`, delete: false })).toMatch(/outside the review loop/);
  });

  it('leave the neighbouring paths alone', () => {
    for (const path of ['.gitignore', '.gitlab-ci.yml', '.githooks/pre-commit', '.katatayx/a', 'docs/.katatay.md', '.claude/skills/plan-change/SKILL.md']) {
      expect(write(path), path).toBeNull();
    }
  });
});

describe('the rulebook\'s agent.lockedPaths', () => {
  it('locks each entry, relative, under ~ and absolute', () => {
    for (const path of ['.claude/settings.json', '.claude/settings.local.json', '.claude/hooks/a.mjs', `${HOME}/.claude/settings.json`, '/etc/agent/config.toml']) {
      expect(write(path), path).toMatch(/switch off its own constraints/);
    }
  });

  it('locks nothing a project relative entry does not name, and nothing outside its base', () => {
    expect(write(`${HOME}/.claude/settings.local.json`)).toBeNull();
    expect(write('/elsewhere/.claude/settings.json')).toBeNull();
    expect(write(`${HOME}/.claude/projects/x/memory/a.md`)).toBeNull();
  });

  it('carry the rulebook\'s reason for the refusal, and the agent\'s reason for the agent', () => {
    const [, , agent] = locksFor(['.claude/settings.json']);
    expect(agent).toMatchObject({ glob: '.claude/settings.json', why: 'the rulebook locks it as the agent\'s own' });
    expect(agent.reason).toMatch(/switch off its own constraints/);
  });
});

describe('a lock on a folder', () => {
  it('covers the folder itself', () => {
    expect(write('.git')).toMatch(/outside the review loop/);
    expect(write('.katatay')).toMatch(/workflow logbook/);
    expect(write('.claude/hooks')).toMatch(/switch off its own constraints/);
    expect(bash('rm -rf .git')).toMatch(/outside the review loop/);
  });

  // Only the folder itself and what is under it. `rm -rf .` would take the
  // logbook too, and reading the shell for that is the cleverness rule b
  // leaves out.
  it('does not cover a folder above it', () => {
    expect(write('.claude')).toBeNull();
    expect(bash('rm -rf .')).toBeNull();
  });

  it('says what checkGating asks: whether a path is locked, or is the folder a locked file sits directly in', () => {
    const lock = lockTest('.claude/hooks/*.mjs', ROOT, HOME);
    expect(lock.matches(`${ROOT}/.claude/hooks/a.mjs`)).toBe(true);
    expect(lock.matches(`${ROOT}/.claude/hooks`)).toBe(false);
    expect(lock.holdsDirectly(`${ROOT}/.claude/hooks`)).toBe(true);
    expect(lock.holdsDirectly(`${ROOT}/.claude`)).toBe(false);
    expect(lockTest('~/**/settings.json', ROOT, HOME).holdsDirectly(HOME)).toBe(true);
  });
});

describe('the requirements folder', () => {
  it('may be written', () => {
    expect(write('requirements/acceptance/AC0001__a.md')).toBeNull();
    expect(bash('echo x > requirements/acceptance/AC0001__a.md')).toBeNull();
  });

  it('may not have anything deleted from it, the folder itself included', () => {
    expect(write('requirements/changes/0001__x.md', true)).toMatch(/never deleted/);
    expect(write('requirements', true)).toMatch(/removing or renaming under requirements\/ is never right/);
  });

  it('is the folder the rulebook names, and not a fixed one', () => {
    expect(write('specs/AC0001.md', true, 'specs')).toMatch(/under specs\/ is never right/);
    expect(write('requirements/AC0001.md', true, 'specs')).toBeNull();
    expect(bash('rm specs/AC0001.md', 'specs')).toMatch(/never deleted/);
    expect(bash('rm requirements/AC0001.md', 'specs')).toBeNull();
  });

  it('denies a shell removal or rename, however the path is spelled, git rm and git mv included', () => {
    for (const command of [
      'rm requirements/changes/0001__x.md',
      'rm ./requirements/changes/0001__x.md',
      `rm ${ROOT}/requirements/changes/0001__x.md`,
      'rm -rf requirements',
      'rmdir requirements/changes',
      'mv requirements/acceptance/AC0001__a.md /tmp/a.md',
      '/bin/rm requirements/x.md',
      'git rm requirements/x.md',
      'git mv requirements/a.md requirements/b.md',
    ]) {
      expect(bash(command), command).toMatch(/never deleted/);
    }
  });

  it('does not mistake an unrelated tree for it', () => {
    expect(bash('rm docs/requirements/notes.md')).toBeNull();
    expect(bash('rm /tmp/scratch.md')).toBeNull();
  });
});

describe('a shell command, read with rule b', () => {
  it('is denied when a redirect lands on a locked path', () => {
    expect(bash('echo "{}" > .claude/settings.json')).toMatch(/switch off its own constraints/);
    expect(bash(`echo '{"disableAllHooks": true}' >> .claude/settings.local.json`)).toMatch(/switch off its own constraints/);
    expect(bash('echo x>.katatay/x')).toMatch(/workflow logbook/);
    expect(bash('echo x > ~/.claude/settings.json')).toMatch(/switch off its own constraints/);
  });

  it('is denied when a write verb sits in one segment with a locked path', () => {
    for (const command of [
      'echo "{}" | tee .claude/settings.local.json',
      'cp /tmp/lower.json .katatay/rulebook.json',
      'sed -i "" "s/93.9/10.0/" .katatay/rulebook.json',
      'sed -Ei "s/a/b/" .claude/settings.json',
      'mv .katatay/rulebook.json .katatay/config.old',
      'rm .katatay/state/branch/0001__verified.json',
      'truncate -s 0 .git/config',
      'rm "/repo/.git/HEAD"',
    ]) {
      expect(bash(command), command).not.toBeNull();
    }
  });

  // A harmless redirect in the segment does not stop the verbs being read.
  it('is denied when a write verb and a locked path share a segment with a redirect elsewhere', () => {
    expect(bash('rm .katatay/x > /tmp/log')).toMatch(/workflow logbook/);
  });

  // `-i` is sed's in-place flag. Elsewhere, and inside sed's script, it is not.
  it('is left alone when it only reads a locked path', () => {
    for (const command of [
      'cat .katatay/rulebook.json', 'git log -- .katatay', 'ls .git', 'grep -n x .claude/settings.json',
      'ls -li .katatay/state', 'sed -n "s/a-bi/x/p" .katatay/rulebook.json',
    ]) {
      expect(bash(command), command).toBeNull();
    }
  });

  // `2>&1` writes to a stream, not a file. Read as a redirect into a path
  // named `&1`, or as a write marker on its own, it would deny most commands.
  it('does not read a stream redirect as a write to a path', () => {
    expect(bash('ls .katatay/state 2>&1 | head')).toBeNull();
    expect(bash('git log 2>&1 | tee /tmp/log')).toBeNull();
    expect(bash('ls .git 2>/dev/null')).toBeNull();
  });

  // A locked path in one part of a command line says nothing about what
  // another part changes.
  it('judges each segment alone', () => {
    expect(bash('cat .katatay/rulebook.json && rm /tmp/x')).toBeNull();
    expect(bash('cat .katatay/rulebook.json; echo x > /tmp/y')).toBeNull();
    expect(bash('cat /tmp/a | tee .katatay/x')).toMatch(/workflow logbook/);
    expect(bash('ls\nrm .git/config')).toMatch(/outside the review loop/);
  });

  // Commit messages, plans and change files quote the paths they describe.
  it('reads a heredoc body as content, not as a command', () => {
    expect(bash("cat > notes.md <<'EOF'\nrm requirements/acceptance/AC0001__a.md\nEOF")).toBeNull();
    expect(bash('git commit -F - <<EOF\nrm .katatay/x > .git/config\nEOF')).toBeNull();
  });

  // The body ends only at a line that is the delimiter and nothing else, so
  // a line that merely holds it does not end the body early.
  it('ends a heredoc only at a line that is exactly its delimiter', () => {
    expect(bash("cat > notes.md <<'EOF'\nsee NOT_EOF\nrm .katatay/x\nEOF")).toBeNull();
    expect(bash("cat > notes.md <<'EOF'\nEOF_LATER\nrm .katatay/x\nEOF")).toBeNull();
    expect(bash("cat > notes.md << 'EOF'\nrm .katatay/x\nEOF")).toBeNull();
  });

  it('still reads what follows a heredoc', () => {
    expect(bash("cat > notes.md <<'EOF'\nnothing\nEOF\nrm .katatay/x")).toMatch(/workflow logbook/);
  });

  // Blunt in both directions: a marker word anywhere in the segment counts,
  // quoted or not.
  it('denies text that only mentions a write together with a locked path', () => {
    expect(bash('grep "rm .katatay/x" notes.md')).toMatch(/workflow logbook/);
    expect(bash('echo rm .git/config')).toMatch(/outside the review loop/);
  });

  // What rule b leaves to the checks after the fact: the logbook's links,
  // req:guard, git and review.
  it('lets through what names no locked path, or no marker', () => {
    for (const command of [
      'git config core.hooksPath .evil',
      'git clean -fd',
      'git checkout -- .',
      'git checkout main -- .katatay/rulebook.json',
      'git reset --hard',
      'git stash -u',
      'cd .git && rm config',
      'dd if=/dev/zero of=.git/config',
      'perl -pi -e "s/a/b/" .katatay/rulebook.json',
    ]) {
      expect(bash(command), command).toBeNull();
    }
  });
});
