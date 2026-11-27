/**
 * The hooks the workflow registers with Cursor, and how `.cursor/hooks.json`
 * holds them.
 *
 * One list, `EXPECTED`, serves both sides: `defaults` proposes it as the
 * registration, and `check` measures the project's file against it. So what
 * is proposed is what `check` finds nothing wrong with.
 *
 * Cursor's file is flat: `{ version: 1, hooks: { <event>: [{ command, ... }] } }`,
 * one entry per hook, with no groups. A capture under Cursor 3.32.10 on
 * 2026-11-26 (see `tests/fixtures/cursor/README.md`) settled the events and
 * tool names below.
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

/** Where the project's hooks are registered. Cursor runs them only in a trusted workspace. */
export const HOOKS_FILE = '.cursor/hooks.json';

/**
 * The Stop hook's limit when the registration names none, in seconds. Cursor's
 * documentation says only "platform default", so this is a guess on the short
 * side: the referee sizes the mutation run to fit what is left.
 */
export const DEFAULT_TIMEOUT = 60;

/**
 * The registrations, each with what stops working without it.
 *
 * `script` is the path from the repository root. Cursor starts project hooks
 * in the project root, so a relative path works there.
 *
 * `matcher` lists the tools the hook must run for. The capture showed every
 * file edit arriving as `Write` with the whole new content, a removal as
 * `Delete`, and a shell call as `Shell`.
 *
 * `failClosed` makes Cursor deny the tool call when the hook crashes or times
 * out. Cursor's default is to let it through.
 *
 * `loopLimit: null` lifts Cursor's cap of five follow-ups per stop hook. The
 * referee refuses a stop only once, and a cap would only cut off a report.
 */
export const EXPECTED = [
  {
    event: 'preToolUse',
    matcher: ['Write', 'Delete', 'Shell'],
    script: 'src/agents/cursor/hooks/pre-tool.mjs',
    timeout: 60,
    failClosed: true,
    consequence: 'edits are no longer held until a plan has been approved, and nothing stops a session writing to .git, the workflow logbook or the files the rulebook locks',
  },
  {
    event: 'beforeSubmitPrompt',
    matcher: [],
    script: 'src/agents/cursor/hooks/user-prompt.mjs',
    // `record` writes the change report, which takes a while on a large change.
    timeout: 60,
    consequence: 'clicking Build records nothing and no change can leave the open phase, and the operator\'s `record` and `reset` are no longer heard',
  },
  {
    event: 'stop',
    matcher: [],
    script: 'src/agents/cursor/hooks/turn-end.mjs',
    // `workflow verify` runs the project's whole suite, and the mutation
    // testing after a first pass needs a few minutes more. The same figure as
    // Claude's and Codex's, for the same reason.
    timeout: 900,
    loopLimit: null,
    consequence: 'the test freeze is off, and nothing runs verify or records that it passed',
  },
];

/** The command for a script inside the project: from the project root, where Cursor starts it. */
export const projectCommand = (script) => `node ${script.split(sep).join('/')}`;

/** The command for a script of a harness that lives outside the project: its absolute path. */
export const harnessCommand = (script) => `node ${JSON.stringify(join(HARNESS_ROOT, script))}`;

/**
 * The command Cursor runs for a script. From the project root when the
 * harness sits inside the project at `root`, as here. By absolute path
 * otherwise, because a project set up from a harness elsewhere has no `src/`.
 */
export const commandFor = (script, root = process.cwd()) => {
  if (packaged) return agentCommand(script);
  return harnessInside(root) ? projectCommand(script) : harnessCommand(script);
};

/** One registration as `.cursor/hooks.json` holds it. */
const entryFor = ({ matcher, script, timeout, failClosed, loopLimit }, root) => ({
  command: commandFor(script, root),
  ...(matcher.length > 0 ? { matcher: matcher.join('|') } : {}),
  ...(timeout === undefined ? {} : { timeout }),
  ...(failClosed === undefined ? {} : { failClosed }),
  ...(loopLimit === undefined ? {} : { loop_limit: loopLimit }),
});

/** The registrations as `.cursor/hooks.json` holds them. */
export function hookRegistration(root = process.cwd()) {
  const hooks = {};
  for (const expected of EXPECTED) {
    hooks[expected.event] ??= [];
    hooks[expected.event].push(entryFor(expected, root));
  }
  return { version: 1, hooks };
}

/**
 * The stop hook's timeout as `.cursor/hooks.json` registers it, in seconds,
 * or the default when the file, the hook or the field is missing.
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
  const script = EXPECTED.find((hook) => hook.event === 'stop').script;
  for (const hook of Array.isArray(registered?.hooks?.stop) ? registered.hooks.stop : []) {
    if (runsScript(hook?.command, script)) {
      return Number.isFinite(hook.timeout) && hook.timeout > 0 ? hook.timeout : DEFAULT_TIMEOUT;
    }
  }
  return DEFAULT_TIMEOUT;
}

/**
 * The project's `.cursor/hooks.json` with the workflow's hooks merged in, as
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
  const hooks = file.hooks !== null && typeof file.hooks === 'object' && !Array.isArray(file.hooks) ? { ...file.hooks } : {};
  for (const expected of EXPECTED) {
    const entries = Array.isArray(hooks[expected.event]) ? hooks[expected.event] : [];
    if (entries.some((hook) => runsScript(hook?.command, expected.script))) continue;
    hooks[expected.event] = [...entries, entryFor(expected, root)];
  }
  return `${JSON.stringify({ version: 1, ...file, hooks }, null, 2)}\n`;
}
