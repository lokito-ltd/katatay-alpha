/**
 * What is wrong with Cursor's setup here, as warnings for the operator.
 *
 * Cursor has no command a check could ask, so its files are read: the
 * project's `.cursor/hooks.json`, the user's `~/.cursor/hooks.json` and the
 * enterprise file for this platform. Cursor runs every hook from every one of
 * them, and also team and plugin hooks, which no file in reach shows. So a
 * clean answer means only that these files hold nothing wrong.
 *
 * A plain function of the files' texts, so every warning can be tested in
 * process. `check.mjs` reads the files and calls it.
 */
import { packaged } from '../../distribution.mjs';
import { agentCommand } from '../programs.mjs';
import { EXPECTED, HOOKS_FILE, harnessCommand, projectCommand } from './registration.mjs';
import { INSTRUCTIONS_FILE } from './install-files.mjs';
import { extraHookWarnings } from '../extra-hooks.mjs';

/**
 * Where Cursor's enterprise hooks file is, by platform, as its documentation
 * names it. Managed by the operator's organisation, outside the repository.
 */
export const ENTERPRISE_FILES = {
  darwin: '/Library/Application Support/Cursor/hooks.json',
  linux: '/etc/cursor/hooks.json',
  win32: 'C:\\ProgramData\\Cursor\\hooks.json',
};

/**
 * Whether a matcher covers a tool, read the way Cursor reads one: a regular
 * expression, where none, `''` and `'*'` match everything. One that is not a
 * valid expression covers nothing.
 */
export function covers(matcher, tool) {
  if (matcher === null || matcher === undefined || matcher === '' || matcher === '*') return true;
  try {
    return new RegExp(matcher).test(tool);
  } catch {
    return false;
  }
}

/** The commands that are the workflow's own registration of `expected`: exactly one of these, never a path that only ends the same way. */
const ownCommands = (expected) => (packaged ? [agentCommand(expected.script)]
  : [projectCommand(expected.script), harnessCommand(expected.script)]);

const isOwn = (entry, expected) => ownCommands(expected).includes(entry?.command);

/**
 * Why an extra hook matters. A stop hook's `followup_message` is sent to the
 * agent as a new prompt, and Build's approval is a prompt, so an extra one
 * could send Build's words on the operator's behalf. A prompt hook sees, and
 * can hold back, every prompt.
 */
const APPROVAL_EVENTS = ['stop', 'subagentStop', 'beforeSubmitPrompt'];

/** The entries of a hooks file, `{ event, entry }` each, or a sentence saying why there are none. */
function entriesOf(text, file) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return `${file} is not JSON (${error.message}), so Cursor runs none of its hooks and what it would run is not known.`;
  }
  const hooks = parsed?.hooks;
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) return [];
  return Object.entries(hooks).flatMap(([event, entries]) => (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry !== null && typeof entry === 'object')
    .map((entry) => ({ event, entry })));
}

/** The warnings about the workflow's own three hooks, in the project's file. */
function ownWarnings(entries) {
  const warnings = [];
  for (const expected of EXPECTED) {
    const own = entries.filter(({ event, entry }) => event === expected.event && isOwn(entry, expected)).map(({ entry }) => entry);
    const name = `the workflow's ${expected.event} hook (${expected.script})`;
    if (own.length === 0) {
      warnings.push(`${HOOKS_FILE} does not register ${name}, so ${expected.consequence}.`);
      continue;
    }
    const missed = expected.matcher.filter((tool) => !own.some((entry) => covers(entry.matcher, tool)));
    if (missed.length > 0) {
      warnings.push(`${name} does not run for ${missed.join(' or ')}, because its matcher is \`${own[0].matcher}\`. For those tools ${expected.consequence}.`);
    }
    if (expected.failClosed && !own.some((entry) => entry.failClosed === true)) {
      warnings.push(`${name} is registered without \`failClosed: true\`, so a crash or a timeout of the hook lets the tool call through.`);
    }
    if (expected.timeout !== undefined && !own.some((entry) => Number.isFinite(entry.timeout) && entry.timeout >= expected.timeout)) {
      warnings.push(`${name} has a timeout under ${expected.timeout} seconds, so Cursor may stop it before it answers.`);
    }
    if (expected.loopLimit === null && !own.some((entry) => entry.loop_limit === null)) {
      warnings.push(`${name} is registered without \`loop_limit: null\`, so Cursor stops sending its follow-ups after a few, and a report for the operator can be lost.`);
    }
  }
  return warnings;
}

/**
 * Every warning, from the texts of the hooks files.
 *
 * `files` maps each file's path to its text, or null when there is no such
 * file. The project's file is the one named `HOOKS_FILE`. `extraHooks` is the
 * adapter's `extraHooks` settings as the referee sends it, or null when the
 * rulebook switches the extra-hooks check off. Off silences only that list.
 *
 * It does not throw. A check that fails while working out a warning would
 * turn into a warning that the check gave no answer, hiding the ones it had.
 *
 * @param {{ files: Record<string, string|null>, extraHooks: { acknowledged: { event: string, matcher?: string, command: string }[] } | null,
 *   instructions: boolean }} where
 * @returns {string[]}
 */
export function setupWarnings({ files, extraHooks, instructions }) {
  const warnings = [];
  if (!instructions) {
    warnings.push(`${INSTRUCTIONS_FILE} is missing, so Cursor starts each chat without the workflow's instructions. `
      + 'Install them with the Cursor adapter\'s install command, as init does.');
  }
  const registrations = [];
  for (const [file, text] of Object.entries(files)) {
    if (text === null) {
      if (file === HOOKS_FILE) warnings.push(...ownWarnings([]));
      continue;
    }
    const entries = entriesOf(text, file);
    if (typeof entries === 'string') {
      warnings.push(entries);
      if (file === HOOKS_FILE) warnings.push(...ownWarnings([]));
      continue;
    }
    if (file === HOOKS_FILE) warnings.push(...ownWarnings(entries));
    for (const { event, entry } of entries) {
      if (file === HOOKS_FILE && EXPECTED.some((expected) => expected.event === event && isOwn(entry, expected))) continue;
      const matcher = typeof entry.matcher === 'string' ? entry.matcher : '';
      const command = typeof entry.command === 'string' ? entry.command : `${entry.type ?? 'unknown'} hook`;
      const acknowledged = extraHooks?.acknowledged ?? [];
      if (acknowledged.some((known) => known.event === event && (known.matcher ?? '') === matcher && known.command === command)) continue;
      registrations.push({ file, layer: undefined, command, event, matcher, affectsApproval: APPROVAL_EVENTS.includes(event) });
    }
  }
  if (extraHooks !== null) {
    warnings.push(...extraHookWarnings(registrations,
      'Cursor sends what a stop hook answers to the agent as a prompt, and a prompt hook sees every prompt, so it could send or hold back Build\'s approval on the operator\'s behalf.'));
  }
  return warnings;
}
