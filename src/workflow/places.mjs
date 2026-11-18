/**
 * The files the rulebook says are written without a plan, in every phase: the
 * Markdown files directly in `plans.dir`, and `followUpsFile`.
 *
 * The referee decides this, and not the agent adapter, because both come from
 * the rulebook, and an adapter that read the rulebook would have to copy the
 * referee's rules about it: how a path there is resolved, and which shapes are
 * refused (`checkGating` in `rulebook.mjs`). A second agent's adapter would
 * copy them again. The adapter says only what its agent alone knows, such as
 * where Claude keeps its memory notes, as `exempt`.
 *
 * Plans, because an agent writes its plan before the operator sees the
 * approval dialog. The follow-ups file, because parking work for later should
 * not wait on a plan. Neither grants anything.
 *
 * Only files directly in the plans folder, and only Markdown. A subfolder is
 * ordinary work, and a plans folder inside the repository would otherwise
 * exempt code that sits there.
 *
 * When the rulebook cannot be read, only the default follow-ups file is
 * exempt. The referee has no plans folder to fall back to: which folder an
 * agent writes plans to is the agent's own fact. No approval is recorded
 * while the rulebook is refused, so a plan written then could not be approved
 * anyway, and the agent can still park a follow-up and tell the operator.
 *
 * This allows; it does not protect. `on write` checks the locks before it
 * (`locks.mjs`), and `checkGating` refuses a plans folder or follow-ups file
 * that a lock reaches.
 */
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { DEFAULT_FOLLOW_UPS, followUpsFile, plansDir } from './rulebook.mjs';

/**
 * A path with symlinks resolved, so two spellings of one file compare equal,
 * and a plan-shaped link to something else is that something else. On macOS
 * the temporary folder is reached as `/var` and resolves to `/private/var`.
 * The file may not exist yet, and nor may its folder, so the nearest folder
 * that exists is resolved and the rest appended. Resolving only the parent
 * left a plan in a missing folder spelled one way and the folder the other.
 */
export function real(path) {
  const rest = [];
  let at = path;
  for (;;) {
    try {
      return join(realpathSync(at), ...rest);
    } catch {
      const up = dirname(at);
      if (up === at) return path;
      rest.unshift(basename(at));
      at = up;
    }
  }
}

/** The exempt places from the rulebook, or only the default follow-ups file
 *  when it cannot be read. */
function places(root, home) {
  try {
    return { followUps: resolve(root, followUpsFile(root)), plans: plansDir(root, home) };
  } catch {
    return { followUps: resolve(root, DEFAULT_FOLLOW_UPS), plans: null };
  }
}

/**
 * Whether writing `path` needs no plan because the rulebook says so.
 *
 * @param {unknown} path as the agent sent it: absolute, or from the repository root
 * @param {string} [root]
 * @param {string} [home]
 */
export function isRulebookExempt(path, root = process.cwd(), home = homedir()) {
  if (typeof path !== 'string' || path === '') return false;
  const target = real(resolve(root, path));
  const { followUps, plans } = places(root, home);
  if (target === real(followUps)) return true;
  return plans !== null && isPlanIn(target, plans);
}

/**
 * Whether `path` is a plan file: a Markdown file directly in the rulebook's
 * plans folder, symlinks resolved. The write gate and `on plan-approved` both
 * ask this, so a file the agent may write without a plan and a file an
 * approval may name are the same files.
 *
 * Throws when the rulebook cannot be read, unlike `isRulebookExempt`: an
 * approval needs the folder, and there is no folder to fall back to.
 *
 * @param {string} path absolute, or from the repository root
 * @param {string} [root]
 * @param {string} [home]
 */
export function inPlansFolder(path, root = process.cwd(), home = homedir()) {
  return isPlanIn(real(resolve(root, path)), plansDir(root, home));
}

const isPlanIn = (target, plans) => extname(target) === '.md' && dirname(target) === real(plans);
