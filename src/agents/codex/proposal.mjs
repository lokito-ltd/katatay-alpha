/**
 * What the Codex adapter proposes for a new project: the answer to the
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
 * A command the referee starts in the project root: the script's path from
 * there, or its absolute path where the harness sits outside the project.
 * Not the hooks' form, which resolves the git root through Codex's shell.
 */
const plain = (script, root) => {
  const command = commandFor(script, root);
  return command.includes('$(git rev-parse') ? `node ${script}` : command;
};

/**
 * Codex's own configuration, which a session must not write. `~` is the home
 * directory.
 *
 * - `.codex/**`: the project's hooks and settings. Changing a hook there also
 *   switches it off, because Codex skips a hook whose definition no longer
 *   matches the hash it was trusted by.
 * - `~/.codex/config.toml`: the operator's settings, where hooks can be
 *   switched off and hook trust is kept.
 * - `~/.codex/hooks.json`: the operator's hooks, where one can be added that
 *   runs on every prompt.
 * - `~/.codex/sessions/**`: the transcripts. An approval reads the approved
 *   plan from the thread's transcript, so a session that could rewrite its
 *   own could change the text the operator's approval records.
 *
 * Codex's sandbox keeps `.git` and `.codex` read-only as well. That is a
 * second layer, not a replacement: the sandbox is the operator's to switch
 * off, and these locks hold whatever it is set to.
 */
export const LOCKED = ['.codex/**', '~/.codex/config.toml', '~/.codex/hooks.json', '~/.codex/sessions/**'];

/**
 * Where plans go when the operator has no other place in mind. Codex itself
 * keeps no plan files: the prompt hook writes one for each approval, into
 * whatever folder the rulebook names.
 */
export const PLANS_FOLDER = '~/.codex/plans';

/**
 * The whole answer. It is the same for every project, except that the
 * adapter's own scripts are named from the git root when the harness sits
 * inside the project at `root`, and by absolute path otherwise.
 */
export function proposal(root = process.cwd()) {
  return {
    version: VERSION,
    locked: [...LOCKED],
    plansFolder: PLANS_FOLDER,
    instructions: INSTRUCTIONS_FILE,
    commands: { check: plain('src/agents/codex/check.mjs', root), install: plain('src/agents/codex/install.mjs', root) },
    registration: {
      file: HOOKS_FILE,
      text: `${JSON.stringify(hookRegistration(root), null, 2)}\n`,
      steps: [
        `Check the hooks merged into ${HOOKS_FILE}. The file is locked, so a session cannot change them.`,
        'Start Codex in the project, and trust the project when Codex asks. Codex reads no hooks from an untrusted project.',
        'Open `/hooks` in Codex and trust the three workflow hooks. Codex skips a hook until it is trusted, and again whenever it changes.',
      ],
    },
  };
}
