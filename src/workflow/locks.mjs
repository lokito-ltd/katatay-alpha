/**
 * The locks: the files no tool call may write, and the folder nothing may be
 * deleted from. The referee decides every lock. The agent adapter only says
 * which files a tool call writes, or passes the shell line as it is.
 *
 * Three kinds of lock, and nothing else:
 *
 * - The referee's own: `.katatay/`, which holds the logbook and the rulebook,
 *   and `.git/`, which holds what git runs on the operator's machine. Fixed
 *   here, because a rulebook that could drop them could unlock itself.
 * - The agent's own config, from the rulebook's `agent.lockedPaths`. Each agent
 *   keeps its settings and hooks somewhere else, so the list is the rulebook's.
 * - No delete under the rulebook's requirements folder. Writing there is the
 *   honest path, and blocking it made an approved change impossible to apply.
 *   Deleting there is never right: a requirement leaves only by becoming
 *   `superseded` or `withdrawn`, and change files are append-only history.
 *
 * These lived in the Claude adapter's own hook (`protect-paths.mjs`) as fixed
 * patterns, so the rulebook's `agent.lockedPaths` was never enforced, the delete
 * protection said `requirements/` whatever the rulebook named, and a second
 * agent would have had to copy the whole hook.
 *
 * This prevents drift. It is not security. It does not stop a determined
 * agent, another tool, or a person in an editor. The checks that hold are the
 * ones after the fact: the logbook's links, `req:guard`, git, and review. The
 * code here is as editable as the rest of `src/` until the harness is
 * packaged, and `src/` is not on the rulebook's high-risk list while the
 * harness is being built, so only a reviewer reading the diff sees an edit to
 * it.
 *
 * Pure: no file is read here. The caller resolves symlinks first (`real` in
 * `places.mjs`), so two spellings of one file meet the same lock.
 */
import { basename, isAbsolute, relative, resolve, dirname } from 'node:path';
import { globToRegExp } from './glob.mjs';
import { STATE_FOLDER } from './folder.mjs';

// The sentences the agent is shown when a lock denies a write.
const WORKFLOW = 'The workflow logbook records what the operator granted and what verification actually found. A session able to write there could grant itself a passing verify, which is the one thing this machinery exists to prevent. It is append-only, written by the workflow alone, and reading it is always fine. The rulebook beside it is the operator\'s.';
const GITDIR = 'The .git directory is outside the review loop. Hooks and config there run on the operator\'s machine at commit and push time and appear in no diff, so a change here survives a review that reads every line of the branch. Ask the operator.';
const AGENT = 'The rulebook locks this file as the agent\'s own configuration. Editing it from inside a session would let an agent switch off its own constraints.';
const nodelete = (folder) => `Requirements are never deleted and change files are append-only history, so removing or renaming under ${folder}/ is never right. Write, edit and add there freely. Leave removal to the operator.`;

/**
 * The referee's own locks. `why` is the short reason the rulebook's refusal
 * names (`checkGating` in `rulebook.mjs`); `reason` is what the agent is shown.
 */
export const REFEREE_LOCKS = [
  { glob: `${STATE_FOLDER}/**`, why: 'it holds the logbook and the rulebook', reason: WORKFLOW },
  { glob: '.git/**', why: 'it holds what git runs on the operator\'s machine', reason: GITDIR },
];

/** The referee's locks and the rulebook's `agent.lockedPaths`, as one list. */
export const locksFor = (agentLocked) => [
  ...REFEREE_LOCKS,
  ...agentLocked.map((glob) => ({ glob, why: 'the rulebook locks it as the agent\'s own', reason: AGENT })),
];

/**
 * A lock as a test of absolute paths. A relative entry is from the repository
 * root, `~/` is the home folder, and an absolute one is itself. The glob part
 * is matched against the path relative to where the lock starts, so a root
 * with `*` or `{` in its name is never read as a glob.
 *
 * - `matches`: the path is locked.
 * - `holdsDirectly`: the path is the folder a locked file sits directly in.
 *   `**` there stands for any. `checkGating` asks it of the plans folder.
 * - `covers`: the path is locked, or is the locked folder itself, so
 *   `rm -rf .git` meets `.git/**`.
 */
export function lockTest(entry, root, home) {
  let base;
  let glob;
  if (entry === '~' || entry.startsWith('~/')) {
    base = home;
    glob = entry.slice(2);
  } else if (isAbsolute(entry)) {
    base = '/';
    glob = entry.slice(1);
  } else {
    base = root;
    glob = entry;
  }
  // A path at `base` itself is tested too, as the empty path. `**` matches no
  // folder at all as well as any number, so `~/**/settings.json` locks
  // `~/settings.json`, and a plans folder at `~` holds that file directly.
  const within = (pattern, folderToo = false) => {
    if (pattern === '') return (path) => path === base;
    const regex = globToRegExp(pattern);
    return (path) => {
      const rel = relative(base, path);
      if (rel.startsWith('..')) return false;
      return regex.test(rel) || (folderToo && rel !== '' && regex.test(`${rel}/`));
    };
  };
  const folder = dirname(glob);
  return {
    matches: within(glob),
    holdsDirectly: within(folder === '.' ? '' : folder),
    covers: within(glob, true),
  };
}

// ------------------------------------------------------------- shell commands

/**
 * Heredoc bodies are content, and the shell never runs them as a command.
 * Commit messages, plans and change files quote the paths they describe, and
 * writing one of those does not operate on a locked path.
 */
const stripHeredocs = (command) =>
  command.replace(/<<-?\s*(["']?)(\w+)\1[\s\S]*?^\2$/gm, '<<HEREDOC');

const SEPARATOR = /\n|;|&&|\|\||\||&/;

/** Where a redirect writes. `2>&1` has no target here, because `&` ends one. */
const REDIRECT_TARGET = />>?\|?\s*(["']?)([^\s"'|;&<>()]+)\1/g;

/** Commands that write or remove the paths they name. */
const WRITE_VERBS = new Set(['rm', 'mv', 'cp', 'tee', 'truncate']);

/** Commands that remove or rename the paths they name. `git rm` and `git mv`
 *  count, because the verb is a word of its own there too. */
const DELETE_VERBS = new Set(['rm', 'rmdir', 'mv']);

const unquote = (token) => token.replace(/^["']+|["']+$/g, '');

/** The words of a segment, quotes taken off, and a command named by its path
 *  (`/bin/rm`) read as its name. */
const words = (segment) => segment.split(/\s+/).map(unquote).filter((word) => word !== '');

const isSedInPlace = (list) => {
  const at = list.findIndex((word) => basename(word) === 'sed');
  return at !== -1 && list.slice(at + 1).some((word) => /^-[a-zA-Z]*i/.test(word) || word.startsWith('--in-place'));
};

/** A word of a command as an absolute path: from the root, or from home for `~`. */
function pathOf(word, root, home) {
  if (word === '~') return home;
  if (word.startsWith('~/')) return resolve(home, word.slice(2));
  return resolve(root, word);
}

/**
 * The lock rules for one repository.
 *
 * @param {{ root: string, home: string, agentLocked: string[], requirements: string }} where
 *   `root` and `home` with symlinks resolved; `agentLocked` the rulebook's
 *   list; `requirements` the requirements folder from the root, no trailing slash.
 */
export function lockRules({ root, home, agentLocked, requirements }) {
  const locks = locksFor(agentLocked).map((lock) => ({ ...lock, test: lockTest(lock.glob, root, home) }));
  const tree = lockTest(`${requirements}/**`, root, home);
  const noDelete = nodelete(requirements);

  const lockedReason = (path) => locks.find((lock) => lock.test.covers(path))?.reason ?? null;

  /**
   * A shell segment, read with rule b and nothing cleverer: a redirect into a
   * locked path, or a write verb in the same segment as a locked path, or a
   * delete verb in the same segment as a path under the requirements folder.
   * A segment is judged alone, because a locked path in one part of a command
   * line says nothing about what another part changes.
   */
  function segmentReason(segment) {
    for (const match of segment.matchAll(REDIRECT_TARGET)) {
      const reason = lockedReason(pathOf(match[2], root, home));
      if (reason) return reason;
    }
    const list = words(segment);
    const names = list.map((word) => basename(word));
    const paths = list.filter((word) => !word.startsWith('-')).map((word) => pathOf(word, root, home));
    if (names.some((name) => WRITE_VERBS.has(name)) || isSedInPlace(list)) {
      for (const path of paths) {
        const reason = lockedReason(path);
        if (reason) return reason;
      }
    }
    if (names.some((name) => DELETE_VERBS.has(name)) && paths.some((path) => tree.covers(path))) return noDelete;
    return null;
  }

  return {
    /**
     * Why this write is locked, or null. `path` is absolute, with symlinks
     * resolved.
     * @param {{ path: string, delete: boolean }} write
     */
    forWrite({ path, delete: removes }) {
      return lockedReason(path) ?? (removes && tree.covers(path) ? noDelete : null);
    },

    /**
     * Why this shell command is locked, or null.
     * @param {string} command
     */
    forCommand(command) {
      for (const segment of stripHeredocs(command).split(SEPARATOR)) {
        const reason = segmentReason(segment);
        if (reason) return reason;
      }
      return null;
    },
  };
}
