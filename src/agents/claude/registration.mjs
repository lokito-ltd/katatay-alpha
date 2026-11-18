/**
 * Which hooks `.claude/settings.json` has to register, and what is missing.
 *
 * Everything the workflow claims rests on that file. The phase gate, the path
 * protection, the approval recorder and the turn-end verify are all registered
 * there and nowhere else, and nothing checked that they still were. On
 * 2026-09-17 the file was replaced by hand while a temporary capture hook was
 * being added, and every hook went with it — all off at once, silently. The
 * only sign was a `Write` in the `open` phase that should have been denied and
 * was not.
 *
 * Whatever reports this must not be one of the hooks that just vanished, so it
 * is read by `workflow state verify` rather than by a hook. See `cli/verify.mjs`
 * for why it warns instead of failing.
 *
 * This file is a manifest, so it can rot: a hook added and not recorded here
 * is reported as an extra one (see `settings.mjs`), and a hook renamed in both
 * places at once warns falsely until someone updates it. Both are visible, and
 * neither can stop the work that fixes them. An automated comparison against
 * the live file would catch the rot and would also be the deadlock — see
 * `cli/verify.mjs`.
 */
import { packaged } from '../../distribution.mjs';
import { agentCommand, runsScript } from '../programs.mjs';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The folder the paths in `EXPECTED` start from: the harness's own root,
 * three folders above this file. In the repository the harness is built in,
 * that is the project root, so the paths read as they always have.
 */
export const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/**
 * The path a project's configuration names one of this adapter's scripts by.
 * Relative to the project when the harness sits inside it, so a checkout of
 * the repository the harness is built in still reads `src/...`. Absolute
 * otherwise: a project set up from a harness that lives elsewhere has no
 * `src/` of its own.
 *
 * @param {string} script the path from the harness's root
 * @param {string} root the project root
 */
export function scriptFor(script, root = process.cwd()) {
  const where = join(HARNESS_ROOT, script);
  const inside = relative(real(root), real(where));
  return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside) ? inside.split(sep).join('/') : where;
}

/** The command line for a script, as `node <path>`, quoted when the path holds a space. */
export const commandFor = (script, root = process.cwd()) => {
  if (packaged) return agentCommand(script);
  const path = scriptFor(script, root);
  return `node ${/\s/.test(path) ? JSON.stringify(path) : path}`;
};

/** The script a `node <path>` command line runs, without `node` and without quotes. */
export const scriptOf = (command) => command.trim().replace(/^node\s+/, '').replace(/^"(.*)"$/, '$1');

/**
 * The registrations this repository needs. `matcher` lists the tools the hook
 * must run for, not the exact string: an operator may reorder an alternation or
 * add a tool of their own, and neither of those is a problem.
 */
export const EXPECTED = [
  {
    event: 'PreToolUse',
    matcher: ['Edit', 'Write', 'NotebookEdit', 'Bash', 'ExitPlanMode'],
    command: 'src/agents/claude/hooks/pre-tool.mjs',
    consequence: 'edits are no longer held until a plan has been approved, and nothing stops a session writing to .git, the workflow logbook or the files the rulebook locks',
  },
  {
    event: 'UserPromptSubmit',
    matcher: [],
    command: 'src/agents/claude/hooks/user-prompt.mjs',
    consequence: 'the operator\'s `record` and `reset` are no longer heard, and no phase is injected',
  },
  {
    event: 'PostToolUse',
    matcher: ['ExitPlanMode'],
    command: 'src/agents/claude/hooks/post-tool.mjs',
    consequence: 'approving a plan records nothing, so no change can leave the open phase',
  },
  {
    event: 'Stop',
    matcher: [],
    command: 'src/agents/claude/hooks/turn-end.mjs',
    // `workflow verify` runs the project's whole suite, and the mutation
    // testing after a pass needs a few minutes more. See `mutationSummary` in
    // the hook. The figure was sized in the repository the harness was built
    // in, where verify took most of 300 seconds.
    timeout: 900,
    consequence: 'the test freeze is off, and nothing runs verify or records that it passed',
  },
];

/**
 * Whether a matcher covers a tool, read the way Claude Code reads one. There
 * are three forms, and which applies depends on the characters in it:
 *
 * - absent, empty or `*`: every tool;
 * - only letters, digits, `_`, `-`, spaces, `,` and `|`: a name, or a list of
 *   names separated by `|` or `,`, each matched whole;
 * - anything else: a JavaScript regular expression, unanchored, so `Exit.*`
 *   covers `ExitPlanMode`, and `Edit.*` covers `NotebookEdit` as well as `Edit`.
 *
 * It used to split on `|` and stop there. That was enough to check that this
 * repository's own hooks were registered, because they are written as plain
 * lists. It is not enough to ask what somebody else's hook covers: a matcher
 * of `Exit.*` or `Bash,ExitPlanMode` read as covering nothing, and the hook
 * behind it is one that can answer the plan dialog.
 *
 * A matcher that is not a valid expression covers nothing. Claude Code cannot
 * run a hook on a pattern it cannot compile either.
 */
export const covers = (matcher, tool) => {
  if (!matcher || matcher === '*') return true;
  if (/^[A-Za-z0-9_\-\s,|]+$/.test(matcher)) {
    return matcher.split(/[|,]/).map((part) => part.trim()).includes(tool);
  }
  try {
    return new RegExp(matcher).test(tool);
  } catch {
    return false;
  }
};

/** Every command registered for an event, with the entry that registered it. */
const registeredFor = (settings, event) =>
  (settings?.hooks?.[event] ?? []).flatMap((entry) =>
    (entry.hooks ?? []).map((hook) => ({ entry, hook })));

/** Claude Code's timeout for a command hook that names none, in seconds. */
export const DEFAULT_TIMEOUT = 60;

/**
 * How long Claude Code gives the hook that runs `command` on `event`, in
 * seconds: the longest of the registrations that run it, or `undefined` when
 * none does.
 *
 * The turn-end hook asks, to know how much time is left for mutation testing
 * once verify has passed. A hook that overruns is killed, and the message it
 * was about to give is lost with it.
 */
export function hookTimeout(settings, event, command) {
  const found = registeredFor(settings, event).filter(({ hook }) => runsScript(hook.command, command));
  return found.length === 0 ? undefined : Math.max(...found.map(({ hook }) => hook.timeout ?? DEFAULT_TIMEOUT));
}

/**
 * What is wrong with these settings, as plain sentences. Empty means nothing is.
 *
 * Extra hooks are not reported here. This answers one question, whether the
 * hooks the workflow needs are registered, and `settingsDifferences` in
 * `settings.mjs` answers the other. They used to go unreported altogether, on
 * the reasoning that registering more is the operator's business. It is, but a
 * hook is also the one thing that can answer the plan dialog for the operator,
 * and the operator says which extra hooks are theirs in `.katatay/rulebook.json`.
 */
export function registrationProblems(settings) {
  const problems = [];

  for (const { event, matcher, command, timeout, consequence } of EXPECTED) {
    // Matched on the script path rather than the whole command line, because
    // `node <path>` is a convention and not part of what is being checked.
    const found = registeredFor(settings, event).filter(({ hook }) => runsScript(hook.command, command));

    if (found.length === 0) {
      problems.push(`${event} does not run ${command} — ${consequence}.`);
      continue;
    }

    const uncovered = matcher.filter((tool) => !found.some(({ entry }) => covers(entry.matcher, tool)));
    if (uncovered.length > 0) {
      const impact = uncovered.length === 1 && uncovered[0] === 'ExitPlanMode' && event === 'PreToolUse'
        ? 'plans are not checked before the approval dialog; add ExitPlanMode to the matcher and start a new session' : consequence;
      problems.push(`${event} runs ${command}, but not for ${uncovered.join(', ')} — ${impact}.`);
    }

    // A hook that runs the suite and is killed partway through reports a
    // failure that never happened, which is worse than not running at all.
    if (timeout !== undefined) {
      const longest = hookTimeout(settings, event, command);
      if (longest < timeout) {
        problems.push(
          `${event} runs ${command} with a ${longest}-second timeout; it runs the whole suite and mutation testing, and needs at least ${timeout}.`,
        );
      }
    }
  }

  return problems;
}

/**
 * How long Claude Code gives the turn-end hook, read from the project's
 * settings text. Text that is missing or not JSON gives the default, which is
 * the cautious answer: too little time means no run, never an overrun. The
 * referee's `nextMutation` takes the number and knows nothing of where it came
 * from.
 *
 * @param {string|null} settingsText
 */
export function stopTimeout(settingsText) {
  try {
    return hookTimeout(JSON.parse(settingsText ?? ''), 'Stop', 'src/agents/claude/hooks/turn-end.mjs') ?? DEFAULT_TIMEOUT;
  } catch {
    return DEFAULT_TIMEOUT;
  }
}

/** The hook registrations the workflow needs, as `.claude/settings.json`
 *  holds them, with each script named as `scriptFor` names it for `root`. */
export function hookRegistration(root = process.cwd()) {
  const hooks = {};
  for (const { event, matcher, command, timeout } of EXPECTED) {
    hooks[event] ??= [];
    hooks[event].push({
      ...(matcher.length > 0 ? { matcher: matcher.join('|') } : {}),
      hooks: [{ type: 'command', command: commandFor(command, root), ...(timeout === undefined ? {} : { timeout }) }],
    });
  }
  return { hooks };
}

/** Where the project's settings are, from its root. */
export const SETTINGS_FILE = '.claude/settings.json';

/**
 * The project's settings with the workflow's hooks merged in, as the whole
 * file's text. `init` writes it.
 *
 * Every key the file already has is kept. A hook is added only for an event
 * where nothing runs its script yet, so a second run adds nothing, and a
 * registration the operator changed, such as a longer timeout, stays theirs.
 * What is still wrong after the merge, such as a matcher missing a tool, is
 * `check`'s to report.
 *
 * `plansDirectory` is set only when the plans folder is inside the project.
 * Claude Code ignores a `plansDirectory` outside it and writes plans to
 * `~/.claude/plans` (see `plansDirectory` in `settings.mjs`), so setting one
 * there would say something Claude Code does not do.
 *
 * Throws when the existing text is not a JSON object: merging into a file
 * that cannot be read would throw its contents away.
 *
 * @param {string|null} text the file's contents, or null when there is none
 * @param {{ root?: string, plansFolder?: string, home?: string }} [options]
 */
export function mergedSettings(text, { root = process.cwd(), plansFolder, home = homedir() } = {}) {
  let settings = {};
  if (text !== null) {
    try {
      settings = JSON.parse(text);
    } catch (error) {
      throw new Error(`${SETTINGS_FILE} is not JSON (${error.message}), so the workflow's hooks cannot be merged into it`);
    }
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error(`${SETTINGS_FILE} is not a JSON object, so the workflow's hooks cannot be merged into it`);
    }
  }
  const wanted = hookRegistration(root).hooks;
  const hooks = settings.hooks !== null && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks) ? settings.hooks : {};
  for (const { event, command } of EXPECTED) {
    // On the script path, as `registrationProblems` matches: an absolute
    // path holds the relative one too.
    if (registeredFor({ hooks }, event).some(({ hook }) => runsScript(hook.command, command))) continue;
    const entry = wanted[event].find((candidate) => candidate.hooks.some((hook) => hook.command === commandFor(command, root)));
    hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] : []), entry];
  }
  const merged = { ...settings, hooks };
  if (plansFolder !== undefined) {
    const folder = plansFolder === '~' || plansFolder.startsWith('~/') ? join(home, plansFolder.slice(1)) : resolve(root, plansFolder);
    const inside = relative(real(root), real(folder));
    if (inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)) merged.plansDirectory = inside.split(sep).join('/');
  }
  return `${JSON.stringify(merged, null, 2)}\n`;
}
