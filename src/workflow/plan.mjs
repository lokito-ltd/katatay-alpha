/** Reads the declarations in the plan the operator is asked to approve. */
import matter from 'gray-matter';
import { entryProblems, parsePrediction } from './plan-declarations.mjs';
export { parsePrediction } from './plan-declarations.mjs';
import { PLAN_KEYS } from './plan-format.mjs';

/**
 * The requirement changes a plan asks the operator to approve, read from its
 * closing `workflow` block (`declarationsOf`):
 *
 * ````markdown
 * ```workflow
 * requirement-changes:
 *   - id: AC0004
 *     status: active
 *     statement: The statement as it will read once the change is made.
 *     scenarios:
 *       - '[AC0004.1] Each scenario as it will read, when the requirement has any.'
 * ```
 * ````
 *
 * Each entry has the shape of a change file's `requirements:` entry: the
 * resulting requirement, stated in full.
 *
 * A renumber names the old id as well, in `renumberedFrom`, and states the
 * requirement under its new id. The guard files a renumber under the old id,
 * because that is the agreed thing being moved, and an entry naming only the
 * new id could never be matched to it. The old id has to be the same type of
 * requirement: an acceptance criterion cannot become an invariant. `on plan-approved` copies them into the
 * `plan_approved` event, and `req:guard`, outside CI, accepts a new, reworded
 * or retired requirement whose result matches one of them exactly.
 *
 * This exists because the operator already approves the new wording when they
 * approve the plan, and before this nothing recorded that in a form the guard
 * could read. Without it, a change that reworded a requirement could never be
 * verified or even committed locally. CI does not read it; there the guard
 * hands the change to the reviewer instead (`split` in `guard.ts`).
 *
 * Only that block counts, because a plan that *discusses* rewording AC0004
 * must not approve it. See `declarationsOf` for why a quoted example cannot
 * reach it. A plan the block cannot be read from approves nothing. A malformed
 * entry is
 * dropped, not repaired. The guard checks each entry again with its own rules,
 * so this list is a first filter and not the authority. The statuses
 * (`LIFECYCLE` in `plan-format.mjs`) are repeated from `STATUSES` in
 * `src/requirements/parse.ts`, which is TypeScript and cannot be imported by
 * a hook that Node runs directly.
 *
 * @param {string} planText the approved plan, as the operator accepted it
 * @returns {{ id: string, renumberedFrom?: string, status: string, statement: string, scenarios: string[] }[]}
 */
export function requirementChangesIn(planText) {
  // A plan with problems declares nothing: `declarationsOf` gives `{}` then.
  const entries = declarationsOf(planText).data?.['requirement-changes'];
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => (entryProblems(entry).length === 0 ? [asChange(entry)] : []));
}

/**
 * A plan's text checked against the format the referee reads (`planFormat` in
 * `plan-format.mjs`), and what it declares.
 *
 * `requirementChangesIn` drops a malformed entry, which suits the guard: it
 * checks every entry again by its own rules. At approval that silence costs
 * the operator. They approve a requirement change, nothing records it, and
 * they learn so only when `req:guard` refuses the change later. So here a
 * malformed entry is a problem with the plan, said while the plan can still be
 * fixed. An unknown key is one too, so a typo such as `testonly: true` cannot
 * quietly declare nothing.
 *
 * Every problem is listed, not just the first, so one round of fixes is enough.
 * Nothing is declared from a plan with problems.
 *
 * @param {string} text the plan, as read from its file
 * @returns {{ problems: string[], testOnly: boolean, requirementChanges: ReturnType<typeof requirementChangesIn>, predictedFailures: string[] }}
 */
export function readPlan(text) {
  const none = (problems) => ({ problems, testOnly: false, requirementChanges: [], predictedFailures: [] });
  const read = declarationsOf(text);
  if (read.problems.length > 0) return none(read.problems);
  const { data, content } = read;
  const problems = [];
  if (content.trim() === '') problems.push('it has no text besides its `workflow` block');
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    problems.push('its `workflow` block is not a list of keys and values');
    return none(problems);
  }
  for (const key of Object.keys(data)) {
    if (!PLAN_KEYS.includes(key)) problems.push(`its \`workflow\` block holds \`${key}\`, which is not a key a plan may hold`);
  }
  const testOnly = data['test-only'];
  if (testOnly !== undefined && typeof testOnly !== 'boolean') {
    problems.push(`\`test-only\` must be true or false, and is ${JSON.stringify(testOnly)}`);
  }
  const entries = data['requirement-changes'];
  if (entries !== undefined && !Array.isArray(entries)) {
    problems.push('`requirement-changes` must be a list');
  } else if (Array.isArray(entries)) {
    entries.forEach((entry, i) => {
      const name = typeof entry?.id === 'string' ? `${entry.id} (entry ${i + 1})` : `entry ${i + 1}`;
      for (const problem of entryProblems(entry)) problems.push(`\`requirement-changes\` ${name}: ${problem}`);
    });
  }
  const predictions = data['predicted-failures'];
  if (predictions !== undefined && predictions !== null && !Array.isArray(predictions)) {
    problems.push('`predicted-failures` must be a list');
  } else if (Array.isArray(predictions)) {
    predictions.forEach((entry, i) => {
      const read = parsePrediction(entry);
      if ('problem' in read) problems.push(`\`predicted-failures\` entry ${i + 1}: ${read.problem}`);
    });
  }
  if (problems.length > 0) return none(problems);
  return {
    problems,
    testOnly: testOnly === true,
    requirementChanges: (entries ?? []).map(asChange),
    predictedFailures: (predictions ?? []).map((entry) => parsePrediction(entry).text),
  };
}

/** A well-formed entry, as the logbook and the guard keep it. */
const asChange = ({ id, renumberedFrom, status, statement, scenarios = [] }) => ({
  id,
  ...(renumberedFrom === undefined ? {} : { renumberedFrom }),
  status,
  statement: statement.trim(),
  scenarios: scenarios.map((s) => s.trim()),
});

/** The label of the one block a plan declares in. */
const LABEL = 'workflow';

/**
 * What a plan declares, from the fenced block labelled `workflow` that closes
 * it, and the rest of the plan:
 *
 * ````markdown
 * # The plan
 *
 * Why, what and how.
 *
 * ```workflow
 * test-only: true
 * ```
 * ````
 *
 * The declarations used to open the plan as `---` frontmatter. The operator
 * reads the plan in the approval dialog, and that put machine input, often a
 * long list of test names, ahead of the reasons for the change.
 *
 * A plan that only *quotes* a declaration, to explain the format, must declare
 * nothing. Three rules keep that true:
 *
 * - Only the last top-level fenced block can count, and only when nothing but
 *   whitespace follows it. An example in the middle of a plan is followed by
 *   more text.
 * - It must be labelled `workflow`. An example uses another label, such as
 *   `yaml`. An example inside a longer fence is not a top-level block at all.
 * - A `workflow` block anywhere else is a problem, not something silently
 *   skipped, so a plan that meant to declare is told where the block goes.
 *
 * What is left open: a plan that ends on a `workflow` block it meant as an
 * example declares what the example says. The label is the declaration, and
 * the format's description says to use another one for examples.
 *
 * A plan that still opens with `---` frontmatter is a problem too. Read as
 * declaring nothing, a test-only plan or a list of predictions would be lost
 * without anyone being told.
 *
 * A plan without a `workflow` block declares nothing, and has no problem.
 *
 * @param {string | null | undefined} text the plan
 * @returns {{ problems: string[], data: unknown, content: string }} `data` is
 *   the block's YAML, `{}` when there is no block or there are problems;
 *   `content` is the plan without the block
 */
export function declarationsOf(text) {
  const source = text ?? '';
  const lines = source.split(/\r?\n/);
  const problems = [];
  if (/^---/.test(lines[0] ?? '')) {
    problems.push(`it opens with \`---\` frontmatter, which is no longer read: its declarations go in a \`${LABEL}\` block at its end`);
  }
  const ours = fencedBlocks(lines).filter((block) => block.label === LABEL);
  const last = ours.at(-1);
  const closing = last !== undefined && last.closed && lines.slice(last.end + 1).every((line) => line.trim() === '');
  if (ours.length > (closing ? 1 : 0)) {
    problems.push(`a plan holds one \`${LABEL}\` block, at its end: the last thing in the file, closed by its own fence`);
  }
  if (!closing) return { problems, data: {}, content: source };

  const body = lines.slice(last.start + 1, last.end);
  // The body is read as frontmatter between two `---` lines, and `gray-matter`
  // ends frontmatter at the first line that starts with `---`. Such a line
  // would cut the block short, and what follows would be dropped unread.
  if (body.some((line) => line.startsWith('---'))) {
    problems.push(`a line in the \`${LABEL}\` block starts with \`---\`, which would end the YAML there`);
  }
  if (problems.length > 0) return { problems, data: {}, content: source };

  let data;
  try {
    // Opened by a plain `---`, so `gray-matter` reads YAML. Its `---js` block,
    // which it runs with `eval`, and `---json` can only be asked for on the
    // opening line, which is always this one. A line in the body that tries is
    // refused above.
    //
    // The options are what keep `gray-matter`'s cache off. Called without any,
    // it caches the text before parsing it, so YAML that threw once is
    // returned from the cache the next time, as if it had read cleanly.
    ({ data } = matter(`---\n${body.join('\n')}\n---\n`, { language: 'yaml' }));
  } catch (error) {
    return { problems: [`its \`${LABEL}\` block cannot be read: ${String(error?.message ?? error).split('\n')[0]}`], data: {}, content: source };
  }
  return { problems, data, content: lines.slice(0, last.start).join('\n') };
}

/**
 * The top-level fenced code blocks, as CommonMark defines them. A fence opens
 * with up to three spaces, then three or more backticks or tildes, then the
 * label, which is the first word after it. It closes on a line of the same
 * character, at least as many of them, and nothing else. A block never closed
 * runs to the end of the file. A line inside a block is never a fence of its
 * own, which is what keeps an example inside a longer fence from counting.
 *
 * @param {string[]} lines
 * @returns {{ label: string, start: number, end: number, closed: boolean }[]}
 *   `start` and `end` are the indexes of the fence lines
 */
export function fencedBlocks(lines) {
  const blocks = [];
  let open = null;
  lines.forEach((line, i) => {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open === null) {
      if (fence === null) return;
      const [, marks, info] = fence;
      // A backtick fence's label may not hold a backtick, or ```` ```x``` ````
      // inline would open a block.
      if (marks[0] === '`' && info.includes('`')) return;
      open = { char: marks[0], size: marks.length, label: info.trim().split(/\s+/)[0], start: i };
    } else if (fence !== null && fence[1][0] === open.char && fence[1].length >= open.size && fence[2].trim() === '') {
      blocks.push({ ...open, end: i, closed: true });
      open = null;
    }
  });
  if (open !== null) blocks.push({ ...open, end: lines.length - 1, closed: false });
  return blocks;
}
