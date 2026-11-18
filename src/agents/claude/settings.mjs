/**
 * The settings Claude Code actually applies here, and where they differ from
 * what this repository expects.
 *
 * `registration.mjs` reads one file, `.claude/settings.json`, and asks whether
 * the workflow's hooks are registered in it. Claude Code reads several files
 * and merges them, and the others are outside the repository or outside git:
 *
 * - A hook in `~/.claude/settings.json` runs in this project too. A
 *   `PreToolUse` or `PermissionRequest` hook can answer a permission dialog,
 *   and the plan dialog is one. So a session that added such a hook could
 *   approve its own plans.
 * - `disableAllHooks` in any of them turns off every hook in this repository.
 * - An `env` entry reaches every hook and every check the hooks start. `CI`
 *   there makes `req:guard` hand a reworded requirement to a reviewer who is
 *   not there, where it would otherwise fail.
 *
 * Be clear about how strong this is. It **detects; it does not prevent.** The
 * path hook closed the project's own settings files, and nothing inside a
 * repository can stop a write outside it. The shell is not gated before
 * approval, so the write is possible. What is left is that it stops being
 * silent.
 *
 * And it sees only what a script can read. These reach Claude Code and not
 * this file: `claude --settings`, a policy delivered by MDM or from the
 * claude.ai console, settings an embedding app passes in, and the hooks a
 * plugin registers. A clean report here means the files are clean, not that
 * nothing else is in force.
 *
 * Everything here is a warning and never a failure, for the reason
 * `cli/verify.mjs` gives: only the operator can fix any of it, and a red check
 * would block the change that noticed.
 *
 * One list, shown in three places: `state:verify`, `state:show` with the
 * summary injected each turn, and the `Stop` hook's message once verification
 * passes. All three call `settingsWarnings`, so they cannot disagree. The
 * registration problems go through it as well. They used to be printed only by
 * `state:verify`, and the `Stop` hook discards that command's output when it
 * passes, so on the ordinary path nobody saw them.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import matter from 'gray-matter';
import { packaged } from '../../distribution.mjs';
import { agentCommand } from '../programs.mjs';
import { EXPECTED, HARNESS_ROOT, covers, registrationProblems, scriptOf } from './registration.mjs';
import { INSTRUCTIONS_FILE } from './install-files.mjs';
import { extraHookWarnings } from '../extra-hooks.mjs';
import { CONFIG } from '../../workflow/target.mjs';
import { real } from '../../workflow/places.mjs';
import { plansDir } from '../../workflow/rulebook.mjs';

const PROJECT_SETTINGS = '.claude/settings.json';

/** Whether `path` is `root` or somewhere under it. */
const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
};

/** A string setting from one settings file, or null when that file does not set it. */
function setting(file, key) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))?.[key];
    return typeof value === 'string' && value !== '' ? value : null;
  } catch {
    return null; // absent or unreadable, so this file does not set it
  }
}

/**
 * Where plan mode writes plans, resolved the way Claude Code documents it. The
 * `plansDirectory` setting is read relative to the project root and ignored if
 * it points outside the project. Otherwise the folder is `~/.claude/plans`. The
 * most specific settings file that sets it wins.
 *
 * It decides nothing about which files need a plan: the rulebook's
 * `plans.dir` does. That setting can point anywhere in the project, and the
 * local settings file that sets it is git-ignored, so a session could write it
 * and nothing would show the change. Set to `.`, it once made every Markdown
 * file in the root exempt, `CLAUDE.md` included. It is read only so that
 * `plansFolderWarning` can say when the two differ.
 */
export function plansDirectory(root = process.cwd(), home = homedir()) {
  for (const file of [
    join(root, '.claude', 'settings.local.json'),
    join(root, '.claude', 'settings.json'),
    join(home, '.claude', 'settings.json'),
  ]) {
    const value = setting(file, 'plansDirectory');
    if (value === null) continue;
    const dir = resolve(root, value);
    if (inside(root, dir)) return dir;
  }
  return join(home, '.claude', 'plans');
}

/**
 * Where an organisation's `managed-settings.json` sits on each system. It
 * outranks every other file, and it is the one place a hook can be registered
 * that the operator may not have written either.
 */
const MANAGED = {
  darwin: '/Library/Application Support/ClaudeCode/managed-settings.json',
  win32: 'C:\\Program Files\\ClaudeCode\\managed-settings.json',
};
const MANAGED_ELSEWHERE = '/etc/claude-code/managed-settings.json';

/**
 * The folder Claude Code keeps the user's settings in. `CLAUDE_CONFIG_DIR`
 * moves it, so a check that always read `~/.claude` could be pointed away from
 * the file that matters by setting one variable.
 */
const userFolder = (home, env) => (typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR !== ''
  ? env.CLAUDE_CONFIG_DIR
  : join(home, '.claude'));

/** A path as the operator would write it: from the repository root when it is
 *  inside, with `~` when it is under the home folder, in full otherwise. */
function shown(path, root, home) {
  if (inside(root, path)) return relative(root, path);
  if (inside(home, path)) return join('~', relative(home, path));
  return path;
}

/**
 * Every settings file that exists, most specific last, each with what it holds.
 *
 * A file that is not JSON is kept, with the error in place of the settings.
 * Claude Code skips a file it cannot parse, so nothing in it is in force. But
 * a file that was readable yesterday and is not today is worth a line, and
 * leaving it out would read as "nothing there".
 *
 * @param {{ root?: string, home?: string, env?: Record<string, string|undefined>, managed?: string }} [where]
 *   `managed` is the managed file's path, for a test that cannot write to a
 *   system folder.
 * @returns {{ file: string, scope: 'managed'|'user'|'project'|'local', settings?: any, error?: string }[]}
 */
export function settingsSources({
  root = process.cwd(), home = homedir(), env = process.env, managed = MANAGED[process.platform] ?? MANAGED_ELSEWHERE,
} = {}) {
  const files = [
    { scope: 'managed', path: managed },
    { scope: 'user', path: join(userFolder(home, env), 'settings.json') },
    { scope: 'project', path: join(root, PROJECT_SETTINGS) },
    { scope: 'local', path: join(root, '.claude', 'settings.local.json') },
  ];
  return files.flatMap(({ scope, path }) => {
    if (!existsSync(path)) return [];
    const file = shown(path, root, home);
    try {
      return [{ file, scope, settings: JSON.parse(readFileSync(path, 'utf8')) }];
    } catch (error) {
      return [{ file, scope, error: error.message }];
    }
  });
}

/** The Markdown files that can declare hooks in a folder of skills or agents:
 *  `skills/<name>/SKILL.md` and `agents/<name>.md`. */
function declaringFiles(folder) {
  const names = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch {
      return []; // no such folder, so nothing declares anything there
    }
  };
  return [
    ...names(join(folder, 'skills')).filter((entry) => entry.isDirectory()).map((entry) => join(folder, 'skills', entry.name, 'SKILL.md')),
    ...names(join(folder, 'agents')).filter((entry) => entry.isFile() && entry.name.endsWith('.md')).map((entry) => join(folder, 'agents', entry.name)),
  ].filter((path) => existsSync(path));
}

/**
 * Hooks declared in the frontmatter of skills and agents, as sources shaped
 * like a settings file that sets nothing but `hooks`.
 *
 * A skill's frontmatter can register hooks, and Claude Code runs them from the
 * moment the skill is used. `.claude/skills/` is not behind the path hook: it
 * holds prose a change may honestly need to edit. So it is a second place a
 * hook can come from inside the repository, and the user's own folder is a
 * third. A hook there is visible in a diff only for the project's files.
 *
 * A file whose frontmatter cannot be parsed declares nothing Claude Code would
 * run, and is left out.
 *
 * @returns {{ file: string, scope: 'skill', settings: { hooks: any } }[]}
 */
export function frontmatterHooks({ root = process.cwd(), home = homedir(), env = process.env } = {}) {
  return [join(root, '.claude'), userFolder(home, env)].flatMap(declaringFiles).flatMap((path) => {
    let hooks;
    try {
      hooks = matter(readFileSync(path, 'utf8')).data?.hooks;
    } catch {
      return [];
    }
    if (hooks === null || typeof hooks !== 'object') return [];
    return [{ file: shown(path, root, home), scope: 'skill', settings: { hooks } }];
  });
}

/**
 * Where Claude Code writes plans, against the rulebook's `plans.dir`. Plan
 * mode writes its plan before the approval dialog, and only files directly in
 * `plans.dir` are written without a plan, so when the two differ the
 * dialog goes out with no plan in it. Nothing when they agree, or when the
 * rulebook cannot say: that is reported where it is read.
 */
export function plansFolderWarning(root = process.cwd(), home = homedir()) {
  let expected;
  try {
    expected = plansDir(root, home);
  } catch {
    return [];
  }
  const actual = plansDirectory(root, home);
  if (real(actual) === real(expected)) return [];
  return [
    `Claude Code writes plans to ${shown(actual, root, home)}, and the rulebook's plans.dir is ${shown(expected, root, home)}. `
    + 'Only files directly in plans.dir are written without a plan, so plan mode cannot write its plan before approval and shows a dialog with no plan in it. '
    + `Set plansDirectory to match, or the operator changes plans.dir in ${CONFIG}.`,
  ];
}

/**
 * Whether the workflow's instructions are installed where Claude Code reads
 * them. A setup without them is incomplete, as one without the hooks is: the
 * hooks would still gate every write, and the agent would meet each rule only
 * when it was refused. Only existence is checked. The text is the project's,
 * and may be reworded.
 */
export function instructionsWarning(root = process.cwd()) {
  if (existsSync(join(root, INSTRUCTIONS_FILE))) return [];
  return [
    `${INSTRUCTIONS_FILE} is missing, so Claude Code starts each session without the workflow's instructions. `
    + 'Install them with the Claude adapter\'s install command, as init does.',
  ];
}

/** What a handler runs, as one string. A command hook has a command. The other
 *  kinds have a URL or a prompt, and failing those, only a kind. */
const identityOf = (hook) => hook?.command ?? hook?.url ?? hook?.prompt ?? `type ${hook?.type ?? 'unknown'}`;

/**
 * Whether a registration is one of the workflow's own.
 *
 * Only in `.claude/settings.json`, which is where they are registered, and
 * only when the command is the script's path, alone or after `node`: from the
 * project root, or absolute where the harness sits outside the project, as
 * `init` registers it there. Exactly that path, never one ending in it, so a
 * look-alike script in another folder is still extra.
 * `registrationProblems` matches more loosely, on the path appearing anywhere
 * in the command, because it asks whether the hook runs at all. Asked here,
 * that looseness would let `node other.mjs # src/workflow/hooks/gate.mjs`
 * pass as expected. A command written some third way is reported as extra,
 * which costs the operator one entry in the acknowledged list.
 */
const isExpected = (scope, event, command) => scope === 'project'
  && EXPECTED.some((expected) => expected.event === event
    && (packaged ? command === agentCommand(expected.command)
      : [expected.command, join(HARNESS_ROOT, expected.command)].includes(scriptOf(command))));

/** The events whose hooks can decide a permission dialog for the operator. */
const ANSWERS_DIALOGS = ['PreToolUse', 'PermissionRequest'];

/**
 * Names in a settings file's `env` that change what the hooks and the checks
 * run or read, each with what it does. An `env` entry is applied to Claude
 * Code's own process, so it reaches every hook, and through the `Stop` hook
 * every script `workflow verify` starts. A variable exported in the shell tool
 * does not reach that far, which is why the settings file is the route worth
 * watching.
 */
const WATCHED_ENV = [
  {
    test: (name) => name === 'CI',
    consequence: 'set to `true`, the tools take the session for a CI job, where `req:guard` no longer fails on a reworded or retired requirement and prints it for a reviewer instead, and verify skips every check whose rulebook entry says `skipInCi`, mutation included',
  },
  {
    test: (name) => name.startsWith('GIT_'),
    consequence: 'git may read its repository, index or configuration from somewhere else, so the freeze, the baseline and the tree fingerprint can be about another tree',
  },
  {
    test: (name) => name === 'NODE_OPTIONS',
    consequence: 'node loads whatever it names into every hook and every check before they run',
  },
  {
    test: (name) => name === 'PATH',
    consequence: 'the hooks find `git` and `node` through it, so each can be replaced by another program',
  },
  {
    test: (name) => name === 'HOME' || name === 'CLAUDE_CONFIG_DIR',
    consequence: 'it moves where the user settings, the plans folder and the locks under ~ are looked for, so this check and the referee read a different place',
  },
];

/**
 * Where the settings differ from what this repository expects, as plain
 * sentences. Empty means the files a script can read hold nothing unexpected.
 *
 * `sources` come from `settingsSources` and `frontmatterHooks`. With
 * `extraHooks` false, the hooks that are not the workflow's own are not
 * listed. Switching hooks off is still reported, because that says the
 * workflow is not running.
 *
 * @param {{ file: string, scope: string, settings?: any, error?: string }[]} sources
 * @param {{ acknowledged?: { event: string, matcher: string, command: string }[], extraHooks?: boolean }} [options]
 * @returns {string[]}
 */
export function settingsDifferences(sources, { acknowledged = [], extraHooks = true } = {}) {
  const differences = [];
  const isAcknowledged = (event, matcher, command) =>
    acknowledged.some((known) => known.event === event && known.matcher === matcher && known.command === command);

  for (const { file, scope, settings, error } of sources) {
    if (error !== undefined) {
      // The project's own file is already reported, with the list of what
      // stopped being registered, by `registrationWarnings` below.
      if (scope !== 'project') differences.push(`${file} could not be read as JSON (${error}), so what it sets cannot be checked.`);
      continue;
    }
    if (settings === null || typeof settings !== 'object') continue;

    if (settings.disableAllHooks === true) {
      differences.push(`${file} sets disableAllHooks, which turns off every hook in this repository: the phase gate, the path protection, the approval recorder and the turn-end verify.`);
    }
    // Only a managed file can set this, and it does to the project's hooks
    // what `disableAllHooks` does: they stop running, with nothing printed.
    if (settings.allowManagedHooksOnly === true) {
      differences.push(`${file} sets allowManagedHooksOnly, so Claude Code runs no hook from this repository's settings.`);
    }

    const registrations = [];
    const hooks = extraHooks && settings.hooks !== null && typeof settings.hooks === 'object' ? settings.hooks : {};
    for (const [event, entries] of Object.entries(hooks)) {
      for (const entry of Array.isArray(entries) ? entries : []) {
        const matcher = typeof entry?.matcher === 'string' ? entry.matcher : '';
        for (const hook of Array.isArray(entry?.hooks) ? entry.hooks : []) {
          const command = String(identityOf(hook));
          if (isExpected(scope, event, command) || isAcknowledged(event, matcher, command)) continue;
          const affectsApproval = ANSWERS_DIALOGS.includes(event) && covers(matcher, 'ExitPlanMode');
          registrations.push({ file, command, event, matcher, affectsApproval });
        }
      }
    }

    differences.push(...extraHookWarnings(registrations,
      "It runs for ExitPlanMode and can answer the plan dialog, so it could approve a plan on the operator's behalf."));

    const env = settings.env !== null && typeof settings.env === 'object' ? settings.env : {};
    for (const name of Object.keys(env)) {
      const watched = WATCHED_ENV.find((entry) => entry.test(name));
      if (watched) differences.push(`${file} sets ${name} in env: ${watched.consequence}.`);
    }
  }
  return differences;
}

/**
 * What is missing from `.claude/settings.json`, including the file itself.
 *
 * A missing file is the loudest version of the same finding and not a separate
 * kind of problem: that is exactly what happened on 2026-09-17. So it is
 * followed by the whole list, and not left as one line. "The file is gone" is
 * a fact about the filesystem. What the operator needs is which parts of the
 * workflow stopped working, and that is the same list as any other way of
 * losing them.
 */
export function registrationWarnings(root = process.cwd()) {
  const path = join(root, PROJECT_SETTINGS);
  if (!existsSync(path)) {
    return [`there is no ${PROJECT_SETTINGS}, so nothing below is registered:`, ...registrationProblems({})];
  }
  try {
    return registrationProblems(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    return [
      `${PROJECT_SETTINGS} could not be read as JSON (${error.message}), so Claude Code is registering nothing from it:`,
      ...registrationProblems({}),
    ];
  }
}

/**
 * Every warning about the settings in force, for whoever prints them.
 *
 * It does not throw. Its caller is the `check` command, which the referee asks
 * from inside the turn's own commands, and a check that fails while working
 * out a warning would turn into a warning that the check gave no answer,
 * hiding the warnings it did have.
 *
 * `extraHooks` is the adapter's `extraHooks` settings as the referee sends it in
 * the check's request: the hooks the operator has said are theirs, or null when
 * the rulebook switches the extra-hooks check off. The referee parses that
 * section, and a section it refuses is its own warning, so it is not read
 * here. Reporting every extra hook is only useful while the report is short:
 * an operator with a hook of their own would otherwise get the same warning on
 * every turn, and learn to skip the line on the turn it names one they did not
 * write.
 *
 * @param {{ root?: string, home?: string, env?: Record<string, string|undefined>, managed?: string,
 *   extraHooks?: { acknowledged: { event: string, matcher?: string, command: string }[] } | null }} [where]
 * @returns {string[]}
 */
export function settingsWarnings(where = {}) {
  const { root = process.cwd(), home = homedir(), extraHooks = { acknowledged: [] } } = where;
  try {
    const acknowledged = (extraHooks?.acknowledged ?? []).map(({ event, matcher = '', command }) => ({ event, matcher, command }));
    return [
      ...registrationWarnings(root),
      ...settingsDifferences([...settingsSources(where), ...frontmatterHooks(where)], { acknowledged, extraHooks: extraHooks !== null }),
      ...plansFolderWarning(root, home),
      ...instructionsWarning(root),
    ];
  } catch (error) {
    return [`the settings Claude Code applies could not be checked (${error.message}).`];
  }
}
