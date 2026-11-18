/**
 * What is wrong with Codex's setup here, as warnings for the operator.
 *
 * Codex is asked, not its files read. Its app server answers `hooks/list`
 * with every hook from every layer (user, project, plugin, managed), each
 * with where it came from, whether it is enabled, and whether it is trusted.
 * It answers `config/read` with the settings in force after every layer is
 * merged. Reading `config.toml` and the `hooks.json` files directly would mean
 * parsing TOML, finding every layer, and recomputing the hash Codex trusts a
 * hook by, and each of those is Codex's to change.
 *
 * A plain function of those two answers, so every warning can be tested in
 * process with a captured answer. `check.mjs` asks Codex and calls it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { dirname, join } from 'node:path';
import { packaged } from '../../distribution.mjs';
import { agentCommand } from '../programs.mjs';
import { EXPECTED, HOOKS_FILE, harnessCommand, projectCommand } from './registration.mjs';
import { INSTRUCTIONS_FILE } from './install-files.mjs';
import { extraHookWarnings } from '../extra-hooks.mjs';

/** `preToolUse` as the rulebook and the docs spell it: `PreToolUse`. */
const pascal = (event) => event.charAt(0).toUpperCase() + event.slice(1);

/**
 * Whether a matcher covers a tool, read the way Codex reads one: a regular
 * expression, where none, `''` and `'*'` match everything. One that is not a
 * valid expression covers nothing, since Codex could not use it either.
 */
export function covers(matcher, tool) {
  if (matcher === null || matcher === undefined || matcher === '' || matcher === '*') return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(tool);
  } catch {
    return false;
  }
}

/**
 * Whether a hook from `hooks/list` is the workflow's own registration of
 * `expected`: in the worktree or its main checkout, or managed by the
 * operator's organisation, which a session cannot edit either. A user's own
 * copy of the command counts as extra, because the user layer is where a hook
 * nobody reviews would be added.
 *
 * The command is the one `commandFor` registers: from the git root, or the
 * script's absolute path where the harness sits outside the project. Exactly
 * one of those, never a path that only ends the same way.
 */
const isOwn = (hook, expected, projectFiles) => (hook.isManaged === true || (hook.source === 'project' && projectFiles.includes(hook.sourcePath)))
  && pascal(hook.eventName) === expected.event
  && (packaged ? hook.command === agentCommand(expected.script)
    : [projectCommand(expected.script), harnessCommand(expected.script)].includes(hook.command));

function worktreeConfigurationWarning(loadedFile, worktreeFile) {
  const read = path => JSON.parse(readFileSync(path, 'utf8'));
  const source = `Codex loaded project hooks from ${loadedFile}, the main checkout’s registration.`;
  try {
    if (isDeepStrictEqual(read(loadedFile), read(worktreeFile))) return null;
    return `${source} The worktree registration at ${worktreeFile} differs.`;
  } catch (error) {
    return `${source} Could not compare it with ${worktreeFile}: ${error.message}`;
  }
}

/** What a trust status means for whether the hook runs, or null when it runs. */
const UNTRUSTED = {
  untrusted: 'has not been trusted, so Codex skips it. The operator trusts it in `/hooks`',
  modified: 'changed after it was trusted, so Codex skips it until the operator trusts it again in `/hooks`',
};

/** The warnings about the workflow's own three hooks. */
function ownWarnings(hooks, projectFiles) {
  const warnings = [];
  for (const expected of EXPECTED) {
    const own = hooks.filter((hook) => isOwn(hook, expected, projectFiles));
    const name = `the workflow's ${expected.event} hook (${expected.script})`;
    if (own.length === 0) {
      warnings.push(`${HOOKS_FILE} does not register ${name}, so ${expected.consequence}.`);
      continue;
    }
    if (!own.some((hook) => hook.enabled)) {
      warnings.push(`${name} is disabled in Codex's \`/hooks\`, so ${expected.consequence}.`);
      continue;
    }
    const running = own.filter((hook) => hook.enabled);
    const trust = running.find((hook) => !(hook.trustStatus in UNTRUSTED)) ?? running[0];
    if (trust.trustStatus in UNTRUSTED) {
      warnings.push(`${name} ${UNTRUSTED[trust.trustStatus]}. Until then ${expected.consequence}.`);
      continue;
    }
    const missed = expected.matcher.filter((tool) => !running.some((hook) => covers(hook.matcher, tool)));
    if (missed.length > 0) {
      warnings.push(`${name} does not run for ${missed.join(' or ')}, because its matcher is \`${trust.matcher}\`. For those tools ${expected.consequence}.`);
    }
  }
  return warnings;
}

/**
 * Why an extra hook matters. A `Stop` hook's block reason is sent to Codex as
 * a new prompt, and the approval is a prompt, so an extra one could send the
 * approval text on the operator's behalf. Whether Codex runs the prompt hook
 * for such a prompt was not captured, so the warning says "could".
 */
const APPROVAL_EVENTS = ['Stop', 'SubagentStop', 'UserPromptSubmit'];

/** The warnings about hooks that are not the workflow's own. */
function extraWarnings(hooks, projectFiles, acknowledged) {
  const registrations = [];
  for (const hook of hooks) {
    if (EXPECTED.some((expected) => isOwn(hook, expected, projectFiles))) continue;
    const event = pascal(hook.eventName);
    const matcher = hook.matcher ?? '';
    const command = hook.command ?? `${hook.handlerType ?? 'unknown'} handler`;
    if (acknowledged.some((known) => known.event === event && (known.matcher ?? '') === matcher && known.command === command)) continue;
    registrations.push({ file: hook.sourcePath, layer: hook.source, command, event, matcher,
      affectsApproval: APPROVAL_EVENTS.includes(event) });
  }
  return extraHookWarnings(registrations,
    "Codex sends what it answers as a prompt, or alongside one, so it could send the plan approval text on the operator's behalf.");
}

/** What Codex reads of a repository's `AGENTS.md` files when its settings name no limit. */
export const DEFAULT_DOC_MAX_BYTES = 32 * 1024;

/**
 * Codex reads the `AGENTS.md` files from the repository root down to its
 * working folder, and stops at `project_doc_max_bytes` for all of them
 * together. Past that, it silently drops the rest of the text, and the
 * workflow's instructions come last in the root file.
 *
 * For each `AGENTS.md`, the files Codex would load together with it are the
 * ones in its folder and every folder above it. A warning for each such set
 * over the limit. Only the repository's own files count: global files,
 * override files and fallback names are Codex's to manage.
 *
 * When Codex's settings could not be read (`known: false`), the limit Codex
 * uses is not known. The default is then only a yardstick: on 2026-11-04 it
 * warned that a 33,328-byte AGENTS.md was cut off, while the user's settings
 * raised the limit to 65,536. So the warning says the limit is unknown.
 *
 * @param {{ path: string, bytes: number }[]} files paths from the root
 * @param {unknown} limit the settings' `project_doc_max_bytes`
 * @param {{ known?: boolean }} [options] whether the settings were read
 * @returns {string[]}
 */
export function docSizeWarnings(files, limit, { known = true } = {}) {
  const max = known && Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_DOC_MAX_BYTES;
  const folder = (path) => (dirname(path) === '.' ? '' : `${dirname(path)}/`);
  const above = (inner, outer) => inner.startsWith(outer);
  return files.flatMap((file) => {
    const loaded = files.filter((other) => above(folder(file.path), folder(other.path)))
      .sort((a, b) => folder(a.path).length - folder(b.path).length);
    const total = loaded.reduce((sum, other) => sum + other.bytes, 0);
    if (total <= max) return [];
    const what = loaded.length === 1
      ? `\`${file.path}\` is ${total} bytes`
      : `The AGENTS.md files Codex loads together in \`${folder(file.path)}\` (${loaded.map((other) => `\`${other.path}\``).join(', ')}) come to ${total} bytes`;
    if (!known) {
      return [`${what}, over Codex's default \`project_doc_max_bytes\` of ${max}. Codex's settings could not be read, so the limit it uses is not known. `
        + `If it is the default, Codex misses the last ${total - max} bytes of its instructions, the workflow's included. `
        + `Check that \`project_doc_max_bytes\` in \`~/.codex/config.toml\` is at least ${total}.`];
    }
    return [`${what}, over Codex's \`project_doc_max_bytes\` of ${max}. Codex reads only the first ${max} bytes, so it misses the last ${total - max} bytes of its instructions, the workflow's included. `
      + `Raise \`project_doc_max_bytes\` in \`~/.codex/config.toml\` to at least ${total}, then restart Codex.`];
  });
}

/**
 * Every warning, from Codex's two answers.
 *
 * `hooksList` and `config` are the `result` of `hooks/list` and `config/read`,
 * or a sentence saying why there is none. Without `hooks/list` nothing about
 * the hooks is known, and that is the warning. Silence would read as a setup
 * with nothing wrong.
 *
 * `extraHooks` is the adapter's `extraHooks` settings as the referee sends it:
 * the hooks the operator has said are theirs, or null when the rulebook
 * switches the extra-hooks check off. Off silences only that list. Missing,
 * disabled and untrusted workflow hooks are still warned about.
 *
 * It does not throw. A check that fails while working out a warning would
 * turn into a warning that the check gave no answer, hiding the ones it had.
 *
 * `docs` are the repository's `AGENTS.md` files with their sizes, as
 * `check.mjs` lists them. None means no size warning.
 *
 * @param {{ root: string, mainCheckout?: string, hooksList: object|string, config: object|string,
 *   extraHooks: { acknowledged: { event: string, matcher?: string, command: string }[] } | null,
 *   instructions?: boolean, docs?: { path: string, bytes: number }[] }} where
 * @returns {string[]}
 */
export function setupWarnings({ root, mainCheckout = root, hooksList, config, extraHooks, instructions = existsSync(join(root, INSTRUCTIONS_FILE)), docs = [] }) {
  const warnings = [];
  if (!instructions) {
    warnings.push(`${INSTRUCTIONS_FILE} is missing, so Codex starts each session without the workflow's instructions. `
      + 'Install them with the Codex adapter\'s install command, as init does.');
  }

  const settings = typeof config === 'string' ? {} : (config?.config ?? {});
  if (typeof config === 'string') {
    warnings.push(`Codex's settings could not be read (${config}), so whether it has hooks switched off is not known.`);
  }
  warnings.push(...docSizeWarnings(docs, settings.project_doc_max_bytes, { known: typeof config !== 'string' }));
  if (settings.features?.hooks === false) {
    warnings.push('Codex\'s settings set `[features] hooks = false`, which turns off every hook: the phase gate, the path protection, the approval recorder and the turn-end verify.');
  }

  const entries = typeof hooksList === 'string' || !Array.isArray(hooksList?.data) ? [] : hooksList.data;
  const entry = entries.find((candidate) => candidate?.cwd === root);
  const hooks = (Array.isArray(entry?.hooks) ? entry.hooks : []).filter((hook) => hook !== null && typeof hook === 'object');

  const worktreeFile = join(root, HOOKS_FILE);
  const mainFile = join(mainCheckout, HOOKS_FILE);
  const projectFiles = [worktreeFile, mainFile];
  if (mainFile !== worktreeFile && hooks.some(hook => hook.source === 'project' && hook.sourcePath === mainFile)) {
    const warning = worktreeConfigurationWarning(mainFile, worktreeFile);
    if (warning) warnings.push(warning);
  }

  // Managed hooks still run under this switch, so it matters only when one
  // of the workflow's hooks is not managed, which is every setup `defaults`
  // proposes. One managed hook is not enough: the others still do not run.
  const allManaged = EXPECTED.every((expected) => hooks.some((hook) => hook.isManaged === true && isOwn(hook, expected, projectFiles)));
  if (settings.allow_managed_hooks_only === true && !allManaged) {
    warnings.push('Codex\'s settings set `allow_managed_hooks_only`, so Codex runs no hook from this repository: the workflow\'s hooks are not managed.');
  }

  if (typeof hooksList === 'string') {
    warnings.push(`Codex could not be asked about its hooks (${hooksList}), so nothing is known about whether the workflow's hooks run.`);
    return warnings;
  }
  if (entry === undefined) {
    warnings.push('Codex answered `hooks/list` with nothing for this repository, so nothing is known about whether the workflow\'s hooks run.');
    return warnings;
  }
  for (const warning of Array.isArray(entry.warnings) ? entry.warnings : []) warnings.push(`Codex reports about its hooks: ${warning}`);
  for (const error of Array.isArray(entry.errors) ? entry.errors : []) {
    warnings.push(`Codex could not load hooks from ${error?.path ?? 'a file'}: ${error?.message ?? 'no reason given'}`);
  }
  warnings.push(...ownWarnings(hooks, projectFiles));
  if (extraHooks !== null) warnings.push(...extraWarnings(hooks, projectFiles, extraHooks?.acknowledged ?? []));
  return warnings;
}
