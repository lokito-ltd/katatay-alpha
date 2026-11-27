/**
 * How the operator approves a plan in Cursor, and where the approved plan is.
 *
 * Cursor has no approval hook. In Plan mode the agent proposes a plan with
 * `CreatePlan`, and Cursor saves it to `~/.cursor/plans/<slug>_<hash>.plan.md`
 * with YAML frontmatter (`name`, `overview`, `todos`, `isProject`) before the
 * plan's text. The operator can edit that text in Cursor's plan editor. When
 * they click Build, Cursor sends a fixed prompt. A capture under Cursor 3.32.10
 * on 2026-11-26 (see `tests/fixtures/cursor/README.md`) showed it:
 *
 *   Implement the plan as specified, it is attached for your reference. Do
 *   NOT edit the plan file itself. …
 *
 * with `composer_mode: "agent"` and no attachments, so the prompt does not
 * say which plan. The conversation's transcript names it: the newest
 * `CreatePlan` there carries the plan's `name` and the text the agent
 * proposed. The saved file with that name holds the text as the operator
 * left it, edits included.
 *
 * Only the operator sends a prompt. The agent cannot, and the stop hook's
 * follow-ups never start with Build's words, so the channel is still theirs.
 * Cursor later rewrites the todo statuses in its saved file, which is why the
 * plan is copied at approval and never read from Cursor's file again.
 *
 * Plain functions, so tests run them in process where coverage sees them.
 */
import { HARNESS_SCHEMA_VERSION } from '../../schema-version.mjs';
import { randomInt } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { BUILD_WORDS } from './install-files.mjs';
import { latestPlan } from './transcript.mjs';

/** Whether a prompt is the one Build sends. Its first sentence, exactly, at the start. */
export const isBuild = (prompt) => typeof prompt === 'string' && prompt.startsWith(BUILD_WORDS);

/** Where Cursor saves the plans it proposes. */
export const cursorPlans = (home = homedir()) => join(home, '.cursor', 'plans');

/** A plan as it is written to its file: no blank lines around it, one newline at the end. */
export const tidy = (plan) => `${plan.replace(/^\s*\n/, '').trimEnd()}\n`;

/** A YAML scalar as Cursor writes one: plain, double-quoted or single-quoted. */
function scalar(text) {
  const value = text.trim();
  if (value.startsWith('"')) {
    try { return JSON.parse(value); } catch { return null; }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}

/**
 * A saved plan file's `name` and the text after its frontmatter, or null when
 * it does not open with frontmatter.
 *
 * @param {string} text the file's contents
 * @returns {{ name: string|null, body: string } | null}
 */
export function savedPlan(text) {
  const normalized = text.replaceAll('\r\n', '\n');
  if (!normalized.startsWith('---\n')) return null;
  const end = normalized.indexOf('\n---\n', 3);
  if (end === -1) return null;
  const front = normalized.slice(4, end);
  const line = front.split('\n').find((candidate) => candidate.startsWith('name:'));
  return { name: line === undefined ? null : scalar(line.slice('name:'.length)), body: normalized.slice(end + '\n---\n'.length) };
}

/**
 * The saved plan Build approved: among the files in Cursor's plans folder
 * whose `name` is the proposed plan's, the newest one whose text is still
 * the proposed text, else the newest one, which holds the operator's edits.
 * Null when none has that name.
 *
 * @param {{ name: string, plan: string|null }} proposed the newest `CreatePlan`
 * @param {{ list: () => string[], read: (path: string) => string, modified: (path: string) => number }} files
 */
export function matchingSavedPlan(proposed, files) {
  const candidates = [];
  for (const path of files.list()) {
    let saved;
    try {
      saved = savedPlan(files.read(path));
    } catch {
      continue;
    }
    if (saved === null || saved.name !== proposed.name || saved.body.trim() === '') continue;
    candidates.push({ path, body: saved.body, modified: files.modified(path) });
  }
  candidates.sort((a, b) => b.modified - a.modified);
  const unchanged = proposed.plan === null ? undefined : candidates.find((candidate) => tidy(candidate.body) === tidy(proposed.plan));
  return unchanged ?? candidates[0] ?? null;
}

/**
 * Words for a plan file's name. Claude Code names its plan files with three
 * random words, such as `flickering-exploring-valley.md`, and the contract
 * asks the other adapters to do the same, so plans from every agent look
 * alike in the folder.
 */
const WORDS = [
  ['amber', 'brisk', 'calm', 'deft', 'eager', 'fair', 'gentle', 'hazel', 'ivory', 'jolly', 'keen', 'lucid', 'mellow', 'nimble', 'olive', 'plain', 'quiet', 'rapid', 'steady', 'tidy'],
  ['building', 'carving', 'drifting', 'folding', 'gliding', 'humming', 'joining', 'knitting', 'leaning', 'mending', 'nesting', 'planting', 'rowing', 'sorting', 'tending', 'turning', 'walking', 'weaving', 'winding', 'yielding'],
  ['anchor', 'bridge', 'cedar', 'delta', 'ember', 'fern', 'grove', 'harbor', 'island', 'lantern', 'meadow', 'orchard', 'pebble', 'river', 'saddle', 'thistle', 'valley', 'willow', 'cove', 'ridge'],
];

/**
 * A new file directly in `folder`, named with three random words. A name
 * already taken is drawn again, so an earlier plan is never overwritten: each
 * approval has a file of its own.
 *
 * @param {string} folder absolute
 * @param {{ pick?: (n: number) => number, exists?: (path: string) => boolean }} [options] for tests
 */
export function newPlanFile(folder, { pick = randomInt, exists = existsSync } = {}) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const name = WORDS.map((words) => words[pick(words.length)]).join('-');
    const path = join(folder, `${name}.md`);
    if (!exists(path)) return path;
  }
  for (let n = 2; ; n += 1) {
    const path = join(folder, `plan-${n}.md`);
    if (!exists(path)) return path;
  }
}

/** The rulebook, where the referee reads it. */
export const RULEBOOK = '.katatay/rulebook.json';

/**
 * The plans folder the rulebook names, absolute: `{ folder }`, or
 * `{ problem }` saying why it cannot be known.
 *
 * The adapter may read the rulebook (see `../README.md`). It reads only this
 * key. Whether the folder is a valid place for plans is the referee's to
 * decide, when it is asked to record the approval.
 *
 * @param {string} root the repository
 * @param {string} [home]
 */
export function plansDir(root, home = homedir()) {
  let rulebook;
  try {
    rulebook = JSON.parse(readFileSync(join(root, RULEBOOK), 'utf8'));
  } catch (error) {
    return { problem: `${RULEBOOK} could not be read (${error.code ?? error.message})` };
  }
  const folder = rulebook?.plans?.dir;
  if (typeof folder !== 'string' || folder.trim() === '') return { problem: `${RULEBOOK} names no \`plans.dir\`` };
  if (folder === '~') return { folder: home };
  if (folder.startsWith('~/')) return { folder: join(home, folder.slice(2)) };
  return { folder: isAbsolute(folder) ? folder : resolve(root, folder) };
}

/** What the operator and the agent are told when an approval cannot be recorded. */
const notRecorded = (why) => ({
  context: `The operator clicked Build, but ${why}, so no approval was recorded and the current workflow state is unchanged. Tell the operator.`,
});

/**
 * Writes `plan` to a new file in the rulebook's plans folder: `{ file }`, or
 * `{ problem }`.
 *
 * @param {string} plan
 * @param {string} root
 * @param {string} home
 * @param {{ write: (path: string, text: string) => void, makeFolder: (path: string) => void, exists?: (path: string) => boolean }} world
 */
export function savePlan(plan, root, home, world) {
  const where = plansDir(root, home);
  if ('problem' in where) return { problem: `the plans folder is not known: ${where.problem}` };
  let file;
  try {
    world.makeFolder(where.folder);
    file = newPlanFile(where.folder, world.exists === undefined ? {} : { exists: world.exists });
    world.write(file, tidy(plan));
  } catch (error) {
    return { problem: `the plan could not be written to ${file ?? where.folder} (${error.code ?? error.message})` };
  }
  return { file };
}

/**
 * Records a Build: finds the plan, writes it to a new file in the plans
 * folder, and asks the referee (`on plan-approved`) to record it.
 *
 * Returns `{ context, warning? }`: what the agent is told, and a note the
 * operator must see. When the plan cannot be found or written, the referee is
 * not asked: no plan file means no approval, and the referee would only say
 * so less precisely.
 *
 * Everything that touches the world is passed in, so tests can run this in
 * process. The hook passes the real file functions and `ask`.
 *
 * @param {{ transcriptPath: unknown, root: string, home?: string }} approval
 * @param {{ read: (path: string) => string, write: (path: string, text: string) => void,
 *   makeFolder: (path: string) => void, exists?: (path: string) => boolean,
 *   list: () => string[], modified: (path: string) => number,
 *   ask: (input: object) => { answer: object } | { problem: string },
 *   answer: (result: object) => { context: string } }} world
 */
export function recordBuild({ transcriptPath, root, home = homedir() }, world) {
  if (typeof transcriptPath !== 'string' || transcriptPath === '') {
    return notRecorded('Cursor sent no `transcript_path`, and the plan Build approves is named in the conversation\'s transcript');
  }
  let transcript;
  try {
    transcript = world.read(transcriptPath);
  } catch (error) {
    return notRecorded(`the transcript ${transcriptPath} could not be read (${error.code ?? error.message})`);
  }
  const { latest, count } = latestPlan(transcript);
  if (latest === null) {
    return notRecorded(count === 0
      ? 'this conversation holds no plan proposed with `CreatePlan`. Present one in Plan mode first'
      : 'the newest plan in this conversation could not be read');
  }
  if (latest.name === null && latest.plan === null) return notRecorded('the newest plan in this conversation has no name and no text');

  const saved = latest.name === null ? null : matchingSavedPlan(latest, world);
  let warning;
  let plan;
  if (saved !== null) {
    plan = saved.body;
  } else if (latest.plan !== null && latest.plan.trim() !== '') {
    plan = latest.plan;
    warning = `Cursor's saved copy of the plan "${latest.name ?? 'without a name'}" was not found in ~/.cursor/plans, so the approval was recorded from the text the agent proposed. `
      + 'Edits made in Cursor\'s plan editor before Build are not in it. If there were any, revise the plan and build it again.';
  } else {
    return notRecorded(`neither Cursor's saved copy nor the transcript holds the text of the plan "${latest.name}"`);
  }

  const written = savePlan(plan, root, home, world);
  if ('problem' in written) return notRecorded(written.problem);
  const recorded = world.answer(world.ask({ version: HARNESS_SCHEMA_VERSION, planFile: written.file }));
  return warning === undefined ? recorded : { ...recorded, warning };
}
