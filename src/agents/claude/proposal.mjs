/**
 * What the Claude adapter proposes for a new project: the answer to the
 * contract's `defaults` command (see `src/agents/README.md`).
 *
 * `init` asks it once, before any rulebook exists, and writes the answer into
 * the draft rulebook and the operator's to-do list. Nothing reads it after
 * that, because from then on the rulebook is the operator's.
 *
 * It is a plain function so tests can run it in process, where coverage sees
 * it. `defaults.mjs` is the command around it.
 */
import { SETTINGS_FILE, commandFor, hookRegistration as registrationFor } from './registration.mjs';
import { INSTRUCTIONS_FILE } from './install-files.mjs';
import { HARNESS_SCHEMA_VERSION as VERSION } from '../../schema-version.mjs';

/**
 * Claude Code's own configuration, which a session must not write: the
 * project's settings, where the workflow's hooks are registered, the hooks
 * folder, and the operator's own settings, where a hook can be registered
 * that answers the plan dialog. `~` is the home directory.
 */
export const LOCKED = ['.claude/settings.json', '.claude/settings.local.json', '.claude/hooks/**', '~/.claude/settings.json'];

/**
 * Where Claude Code writes plans when nothing sets `plansDirectory`.
 *
 * Always this, never the folder the settings name. `.claude/settings.local.json`
 * is git-ignored and a session can write it, so a proposal read from it could
 * be steered by a file nobody reviews. When the two differ, `check` says so.
 */
export const PLANS_FOLDER = '~/.claude/plans';

/** The hook registrations the workflow needs, as `.claude/settings.json`
 *  holds them. Built from `EXPECTED`, the list `check` measures the settings
 *  against, so what is proposed is what `check` finds nothing wrong with. */
export const hookRegistration = (root = process.cwd()) => registrationFor(root);

/**
 * The whole answer. It is the same for every project, except that the
 * adapter's own scripts are named relative to `root` when the harness sits
 * inside it and absolute otherwise (see `scriptFor`).
 */
export function proposal(root = process.cwd()) {
  return {
    version: VERSION,
    locked: [...LOCKED],
    plansFolder: PLANS_FOLDER,
    instructions: INSTRUCTIONS_FILE,
    commands: { check: commandFor('src/agents/claude/check.mjs', root), install: commandFor('src/agents/claude/install.mjs', root) },
    registration: {
      file: SETTINGS_FILE,
      text: `${JSON.stringify(hookRegistration(root), null, 2)}\n`,
      steps: [
        `Check the hooks merged into ${SETTINGS_FILE}. The file is locked, so a session cannot change them.`,
        'Start a new Claude Code session afterwards, so it loads the new hooks.',
      ],
    },
  };
}
