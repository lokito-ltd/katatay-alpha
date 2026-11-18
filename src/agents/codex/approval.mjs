/**
 * How the operator approves a plan in Codex, and where the approved plan is.
 *
 * Codex has no approval hook. In Plan mode it shows the plan, then asks
 * "Implement this plan?". A capture on 2026-10-29 (see `tests/fixtures/codex/README.md`)
 * showed what each answer sends:
 *
 * - "Yes, implement this plan" sends the prompt `Implement the plan.`, in the
 *   same thread. The plan is in that thread's transcript, as an item of type
 *   `Plan`.
 * - "Yes, clear context and implement" starts a new thread. Its transcript
 *   holds no plan. Its first prompt is a fixed preamble, a blank line, and the
 *   plan.
 * - "No, stay in Plan mode" sends nothing, so nothing is recorded.
 *
 * Only the operator sends a prompt. The agent cannot, so the channel is still
 * theirs. An operator who types `Implement the plan.` by hand is approving
 * too, which is fine.
 *
 * Plain functions, so tests run them in process where coverage sees them.
 */
import { HARNESS_SCHEMA_VERSION } from '../../schema-version.mjs';
import { randomInt } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { completedPlans } from './transcript.mjs';

/** What "Yes, implement this plan" sends. */
export const APPROVAL_PROMPT = 'Implement the plan.';

/** The desktop app's approval includes the plan after this prefix. */
export const EMBEDDED_PLAN_PREFIX = 'PLEASE IMPLEMENT THIS PLAN:';

/** What "Yes, clear context and implement" puts before the plan. */
export const CLEAR_CONTEXT_PREAMBLE = "A previous agent produced the plan below to accomplish the user's task. "
  + 'Implement the plan in a fresh context. Treat the plan as the source of user intent, re-read files as needed, '
  + 'and carry the work through implementation and verification.';

/**
 * Which approval a prompt is: `'same-thread'`, `'clear-context'`, `'embedded-plan'`, or null
 * when it approves nothing.
 *
 * Each phrase must be the whole prompt after removing surrounding punctuation
 * and whitespace. Internal punctuation and spacing remain significant.
 *
 * @param {string} prompt
 */
export function approvalKind(prompt) {
  if (prompt.startsWith(EMBEDDED_PLAN_PREFIX)) return 'embedded-plan';
  if (prompt.startsWith(CLEAR_CONTEXT_PREAMBLE)) return 'clear-context';
  const normalized = prompt.replace(/^[^\p{L}\p{Nd}]+|[^\p{L}\p{Nd}]+$/gu, '').toLowerCase();
  if (['implement the plan', 'implement this plan', 'approve the plan', 'approve this plan',
    'yes, implement this plan', 'yes', 'approved', 'go ahead', 'proceed'].includes(normalized)) return 'same-thread';
  return null;
}

/** A plan as it is written to its file: no blank lines around it, one newline at the end. */
const tidy = (plan) => `${plan.replace(/^\s*\n/, '').trimEnd()}\n`;

/**
 * The plan an embedded or clear-context prompt carries, or null when absent.
 *
 * @param {string} prompt
 */
export function planFromPrompt(prompt) {
  const prefix = prompt.startsWith(EMBEDDED_PLAN_PREFIX) ? EMBEDDED_PLAN_PREFIX : CLEAR_CONTEXT_PREAMBLE;
  const plan = prompt.slice(prefix.length);
  return plan.trim() === '' ? null : tidy(plan);
}

/**
 * The last plan in a transcript, and how many `Plan` items it holds.
 *
 * Codex keeps a thread's transcript as JSON lines. A plan is a line of type
 * `event_msg` whose payload is `item_completed` with an item of type `Plan`,
 * and the plan is in `item.text`. The same plan is also in an assistant
 * message wrapped in `<proposed_plan>` tags, which is a convention of the
 * model's prompt and not read here: the `Plan` item is the structured record.
 *
 * Codex documents the transcript's format as not stable. A line that is not
 * JSON is skipped rather than failing the whole read, so one odd line cannot
 * hide the plan. `plans` lets the caller tell "no plan in this thread" apart
 * from "no item of this shape at all", which is a sign the format changed.
 *
 * @param {string} transcript the file's text
 * @returns {{ plan: string|null, plans: number }}
 */
export function planFromTranscript(transcript) {
  let plan = null;
  let plans = 0;
  for (const { item } of completedPlans(transcript)) {
    plans += 1;
    // A newer unusable plan must not silently approve an older valid one.
    plan = typeof item.text === 'string' && item.text.trim() !== '' ? tidy(item.text) : null;
  }
  return { plan, plans };
}

/**
 * Words for a plan file's name. Claude Code names its plan files with three
 * random words, such as `flickering-exploring-valley.md`, and the contract
 * asks the Codex adapter to do the same, so plans from both agents look
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
  // 8,000 names, all taken, or a `pick` that always draws the same one. A
  // number on the end still gives a file of its own.
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
const notRecorded = (why) => {
  const text = `The operator approved a plan, but ${why}, so no approval was recorded and the current workflow state is unchanged. Tell the operator.`;
  return { context: text, operator: text };
};

/**
 * Records an approval: finds the plan, writes it to a new file in the plans
 * folder, and asks the referee (`on plan-approved`) to record it.
 *
 * Returns `{ context, operator }` as `forPlanApproved` in
 * `hooks/translate.mjs` does, for the prompt hook to show. When the plan
 * cannot be found or written, the referee is not asked: no plan file means
 * no approval, and the referee would only say so less precisely.
 *
 * Everything that touches the world is passed in, so tests can run this in
 * process. The hook passes the real file functions and `ask`.
 *
 * @param {{ kind: 'same-thread'|'clear-context'|'embedded-plan', prompt: string, transcriptPath: unknown, root: string, home?: string }} approval
 * @param {{ read: (path: string) => string, write: (path: string, text: string) => void,
 *   makeFolder: (path: string) => void, exists?: (path: string) => boolean,
 *   ask: (input: object) => { answer: object } | { problem: string },
 *   answer: (result: object) => { context: string, operator: string } }} world
 */
export function recordApproval({ kind, prompt, transcriptPath, root, home = homedir() }, world) {
  let plan = kind === 'same-thread' ? null : planFromPrompt(prompt);
  if (plan === null) {
    if (kind === 'clear-context') return notRecorded('the prompt that starts the new thread carries no plan after Codex\'s preamble');
    if (typeof transcriptPath !== 'string' || transcriptPath === '') {
      return notRecorded('Codex sent no `transcript_path`, and the plan is read from the thread\'s transcript');
    }
    let transcript;
    try {
      transcript = world.read(transcriptPath);
    } catch (error) {
      return notRecorded(`the transcript ${transcriptPath} could not be read (${error.code ?? error.message})`);
    }
    const found = planFromTranscript(transcript);
    if (found.plan === null) {
      if (found.plans > 0) return notRecorded('the latest completed Plan item has empty or malformed content');
      // A plan shown in the thread but not recorded as a `Plan` item means
      // Codex changed how it keeps plans, not that there was none.
      return notRecorded(transcript.includes('<proposed_plan>')
        ? 'the transcript shows a `<proposed_plan>` block and holds no `Plan` item, so Codex may have changed how it records plans. '
          + 'Recapture the fixtures under `tests/fixtures/codex/` following the README there'
        : 'this thread\'s transcript holds no plan. Present one in Plan mode first');
    }
    plan = found.plan;
  }

  const where = plansDir(root, home);
  if ('problem' in where) return notRecorded(`the plans folder is not known: ${where.problem}`);
  let file;
  try {
    world.makeFolder(where.folder);
    file = newPlanFile(where.folder, world.exists === undefined ? {} : { exists: world.exists });
    world.write(file, plan);
  } catch (error) {
    return notRecorded(`the approved plan could not be written to ${file ?? where.folder} (${error.code ?? error.message})`);
  }
  return world.answer(world.ask({ version: HARNESS_SCHEMA_VERSION, planFile: file }));
}
