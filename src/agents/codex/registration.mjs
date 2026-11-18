/**
 * The hooks the workflow registers with Codex, and how `.codex/hooks.json`
 * holds them.
 *
 * One list, `EXPECTED`, serves both sides: `defaults` proposes it as the
 * registration, and `check` measures what Codex reports against it. So what is
 * proposed is what `check` finds nothing wrong with.
 */

import { packaged } from '../../distribution.mjs';
import { agentCommand, runsScript } from '../programs.mjs';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The folder the scripts in `EXPECTED` start from: the harness's own root,
 * three folders above this file. In the repository the harness is built in,
 * that is the project root.
 */
export const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** Whether the harness sits inside the project at `root`, as it does in the repository it is built in. */
export const harnessInside = (root = process.cwd()) => {
  const inside = relative(real(root), real(HARNESS_ROOT));
  return inside === '' || (!inside.startsWith('..') && !isAbsolute(inside));
};

/** Where the project's hooks are registered. Codex reads it only once the project's `.codex/` is trusted. */
export const HOOKS_FILE = '.codex/hooks.json';

/** Codex's own limit for a hook, in seconds, when the registration sets none. */
export const DEFAULT_TIMEOUT = 600;

/**
 * The registrations, each with what stops working without it.
 *
 * `script` is the path from the repository root. Codex starts a hook in the
 * session's working directory, which may be a subfolder, so the command
 * resolves the script from the git root, as Codex's own documentation does
 * for repository hooks.
 *
 * `matcher` lists the tools the hook must run for. Codex calls the shell tool
 * `Bash`, its unified exec tool too, and the patch tool `apply_patch`.
 */
export const EXPECTED = [
  {
    event: 'PreToolUse',
    matcher: ['apply_patch', 'Bash'],
    script: 'src/agents/codex/hooks/pre-tool.mjs',
    consequence: 'edits are no longer held until a plan has been approved, and nothing stops a session writing to .git, the workflow logbook or the files the rulebook locks',
  },
  {
    event: 'UserPromptSubmit',
    matcher: [],
    script: 'src/agents/codex/hooks/user-prompt.mjs',
    // Codex otherwise cuts each `additionalContext` to about 2,500 tokens and
    // saves the rest to a file, and the change report at `record` is longer.
    additionalContextLimit: 0,
    consequence: 'approving a plan records nothing and no change can leave the open phase, and the operator\'s `record` and `reset` are no longer heard',
  },
  {
    event: 'Stop',
    matcher: [],
    script: 'src/agents/codex/hooks/turn-end.mjs',
    // `workflow verify` runs the project's whole suite, and the mutation
    // testing after a first pass needs a few minutes more. The same figure as
    // Claude's, for the same reason.
    timeout: 900,
    consequence: 'the test freeze is off, and nothing runs verify or records that it passed',
  },
];

/** The command for a script inside the project: from the git root, through the shell Codex starts it in. */
export const projectCommand = (script) => `node "$(git rev-parse --show-toplevel)/${script.split(sep).join('/')}"`;

/** The command for a script of a harness that lives outside the project: its absolute path. */
export const harnessCommand = (script) => `node ${JSON.stringify(join(HARNESS_ROOT, script))}`;

/**
 * The command Codex runs for a script. From the git root when the harness
 * sits inside the project at `root`, as here. By absolute path otherwise,
 * because a project set up from a harness elsewhere has no `src/`.
 */
export const commandFor = (script, root = process.cwd()) => {
  if (packaged) return agentCommand(script);
  return harnessInside(root) ? projectCommand(script) : harnessCommand(script);
};

/** The registrations as `.codex/hooks.json` holds them. */
export function hookRegistration(root = process.cwd()) {
  const hooks = {};
  for (const { event, matcher, script, timeout, additionalContextLimit } of EXPECTED) {
    hooks[event] ??= [];
    hooks[event].push({
      ...(matcher.length > 0 ? { matcher: matcher.join('|') } : {}),
      hooks: [{
        type: 'command',
        command: commandFor(script, root),
        ...(timeout === undefined ? {} : { timeout }),
        ...(additionalContextLimit === undefined ? {} : { additionalContextLimit }),
      }],
    });
  }
  return { description: packaged ? 'Katatay project hooks.' : 'The workflow\'s hooks. See src/agents/README.md.', hooks };
}

/**
 * The Stop hook's timeout as `.codex/hooks.json` registers it, in seconds, or
 * Codex's default when the file, the hook or the field is missing.
 *
 * The turn end hands what is left of it to the referee, which sizes the
 * mutation run to fit: a hook that overruns is stopped, and its whole message
 * is lost.
 *
 * @param {string|null} text the file's contents, or null when it cannot be read
 */
export function stopTimeout(text) {
  let registered;
  try {
    registered = JSON.parse(text ?? 'null');
  } catch {
    return DEFAULT_TIMEOUT;
  }
  const script = EXPECTED.find((hook) => hook.event === 'Stop').script;
  for (const group of Array.isArray(registered?.hooks?.Stop) ? registered.hooks.Stop : []) {
    for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
      if (runsScript(hook?.command, script)) {
        return Number.isFinite(hook.timeout) && hook.timeout > 0 ? hook.timeout : DEFAULT_TIMEOUT;
      }
    }
  }
  return DEFAULT_TIMEOUT;
}

/**
 * The project's `.codex/hooks.json` with the workflow's hooks merged in, as
 * the whole file's text. `init` writes it.
 *
 * Every key the file already has is kept. A hook is added only for an event
 * where nothing runs its script yet, so a second run adds nothing, and a hook
 * the operator changed stays theirs. What is still wrong after the merge is
 * `check`'s to report.
 *
 * Throws when the existing text is not a JSON object: merging into a file
 * that cannot be read would throw its contents away.
 *
 * @param {string|null} text the file's contents, or null when there is none
 * @param {string} [root] the project root
 */
export function mergedHooks(text, root = process.cwd()) {
  let file = {};
  if (text !== null) {
    try {
      file = JSON.parse(text);
    } catch (error) {
      throw new Error(`${HOOKS_FILE} is not JSON (${error.message}), so the workflow's hooks cannot be merged into it`);
    }
    if (file === null || typeof file !== 'object' || Array.isArray(file)) {
      throw new Error(`${HOOKS_FILE} is not a JSON object, so the workflow's hooks cannot be merged into it`);
    }
  }
  const wanted = hookRegistration(root);
  const hooks = file.hooks !== null && typeof file.hooks === 'object' && !Array.isArray(file.hooks) ? file.hooks : {};
  for (const { event, script } of EXPECTED) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    const runs = groups.some((group) => (Array.isArray(group?.hooks) ? group.hooks : [])
      .some((hook) => runsScript(hook?.command, script)));
    if (runs) continue;
    const entry = wanted.hooks[event].find((group) => group.hooks.some((hook) => hook.command === commandFor(script, root)));
    hooks[event] = [...groups, entry];
  }
  return `${JSON.stringify({ description: wanted.description, ...file, hooks }, null, 2)}\n`;
}
