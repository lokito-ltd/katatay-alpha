/**
 * What the Cursor adapter proposes for a new project: the answer to the
 * contract's `defaults` command (see `src/agents/README.md`).
 *
 * `init` asks it once, before any rulebook exists, and writes the answer into
 * the draft rulebook and the operator's to-do list. Nothing reads it after
 * that, because from then on the rulebook is the operator's.
 *
 * A plain function, so tests run it in process where coverage sees it.
 * `defaults.mjs` is the command around it.
 */
import { HOOKS_FILE, commandFor, hookRegistration } from './registration.mjs';
import { INSTRUCTIONS_FILE } from './install-files.mjs';
import { HARNESS_SCHEMA_VERSION as VERSION } from '../../schema-version.mjs';

/**
 * Cursor's own configuration, which a session must not write. `~` is the home
 * directory.
 *
 * - `.cursor/hooks.json`, `.cursor/hooks/**`: the project's hooks, and where
 *   Cursor's documentation suggests keeping hook scripts.
 * - `~/.cursor/hooks.json`: the operator's hooks, where one can be added that
 *   runs on every prompt.
 * - `~/.cursor/plans/**`: the plans Cursor saves. An approval reads the
 *   approved text from there, so a session that could rewrite one could
 *   change what the operator's Build records.
 * - `~/.cursor/projects/**`: the conversation transcripts, which name the
 *   plan Build approves.
 *
 * The project's rules under `.cursor/rules/` are the project's own text and
 * stay writable, as Claude Code's `.claude/rules/` do.
 */
export const LOCKED = ['.cursor/hooks.json', '.cursor/hooks/**', '~/.cursor/hooks.json', '~/.cursor/plans/**', '~/.cursor/projects/**'];

/**
 * Where plans go when the operator has no other place in mind. Not Cursor's
 * own `~/.cursor/plans`: that folder is locked, and its files open with
 * frontmatter the referee refuses. The prompt hook writes each approved plan
 * here without it.
 */
export const PLANS_FOLDER = '~/.cursor/katatay-plans';

/**
 * A command the referee starts in the project root: the script's path from
 * there, or its absolute path where the harness sits outside the project.
 */
const plain = (script, root) => commandFor(script, root);

/**
 * The whole answer. It is the same for every project, except that the
 * adapter's own scripts are named from the project root when the harness sits
 * inside the project at `root`, and by absolute path otherwise.
 */
export function proposal(root = process.cwd()) {
  return {
    version: VERSION,
    locked: [...LOCKED],
    plansFolder: PLANS_FOLDER,
    instructions: INSTRUCTIONS_FILE,
    commands: { check: plain('src/agents/cursor/check.mjs', root), install: plain('src/agents/cursor/install.mjs', root) },
    registration: {
      file: HOOKS_FILE,
      text: `${JSON.stringify(hookRegistration(root), null, 2)}\n`,
      steps: [
        `Check the hooks merged into ${HOOKS_FILE}. The file is locked, so a session cannot change them.`,
        'Open the project in Cursor and trust the workspace when Cursor asks. Cursor runs no project hook in an untrusted workspace.',
        'Open the Hooks tab in Cursor\'s settings and check that the three workflow hooks are listed with no errors.',
      ],
    },
  };
}
