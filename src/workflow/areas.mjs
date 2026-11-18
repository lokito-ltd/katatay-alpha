/**
 * Where a reviewer has to look.
 *
 * The operator reviews by hand on the hosting platform, and that review is
 * what actually holds the line. So the places that need their eyes are listed
 * by a tool, from what git recorded, and never by the agent. An agent choosing the list could
 * leave out the one file that mattered, and nothing would show it had.
 *
 * One list, shown in three places: the commit message, the `Stop` hook's
 * message once verification passes, and `state:show`. All three call
 * `reviewAreas` here, so they cannot disagree about what the list holds. They
 * differ only in which files they pass as changed: the commit message passes
 * the staged ones, so it never names a file the commit does not hold.
 *
 * There used to be a second part, "Should look": the tests the triage found
 * failing in its buckets, with "Read the fix". It was
 * dropped on 2026-10-24 at the operator's request. It repeated on every turn
 * until the merge, it named test files whose fix was somewhere else, and the
 * triage already says what broke on the turn it runs and in the change report.
 * A list read every turn is only read while it stays short.
 *
 * `.mjs` because the hook and `state:show` are plain Node and cannot import
 * TypeScript. The high-risk paths are read from `rulebook.mjs`, and nowhere
 * else, so there is one copy of each rule.
 *
 * Which files are high-risk is the project's call, in the `highRisk` list of
 * `.katatay/rulebook.json` (`rulebook.mjs`), each area with the reason a reviewer
 * reads. The referee adds one area of its own, the rulebook, which no rulebook
 * can leave out. The list is policy, so the tests of this file use rulebooks
 * they write themselves, and never assert what this project's list holds:
 * changing a policy should not fail a test of the mechanism. A project's own instructions say what its list holds and why.
 *
 * What a project usually lists, and why each needs a reviewer:
 *
 * - The files that do the watching: the CI definition, the agent's settings,
 *   the git hooks. The guardrails are enforced by the configuration such a
 *   diff edits. Deleting a CI job is conspicuous. Pointing a script at
 *   something harmless reads as refactoring, and the operator's attention is
 *   all that watches it.
 * - The package manifests, which carry install-time lifecycle scripts that run
 *   before any check does, and the configs of the test runners, the type
 *   checker and the other checks, which decide what the checks see. The
 *   2026-10-04 red-team pass added a failing test to the test runner's
 *   exclusions, and took the tests out of what the type checker includes,
 *   which hid 51 type errors. The freeze, the triage, verify, `req:trace` and
 *   CI all passed both times, because nothing they check had changed. Only a
 *   reviewer can see that the checks were narrowed, so the reviewer has to be
 *   told to look.
 * - Database migrations, which every database runs and which can never change
 *   once merged. Nothing checks what a new one does, so review has to read it.
 *   They are an area of their own because the reason differs, and a report
 *   that said a migration changes what does the checking would teach the
 *   operator to skim that reason.
 *
 * The coverage floors are the other way to pass a check without writing a
 * test, which is why the rulebook is always listed: lowering a floor is a
 * one-number edit in a data file. The other is to take code out of what is
 * measured, an exclusion in the coverage tool's config, which the list above
 * covers, or an ignore comment, which `reviewAreas` lists apart.
 */
import { highRiskAreas, requirementsPrefix } from './rulebook.mjs';

/**
 * Requirement files: the acceptance criteria and the invariants.
 *
 * Only the ones that already existed at the baseline are listed. Rewording a
 * requirement, removing a scenario or retiring it takes a promise away, and in
 * CI nothing stops that from merging: the guard hands it to the reviewer
 * rather than failing (see `split` in `guard.ts`). This list is how the
 * reviewer is told. A new requirement file can only add a promise, and the
 * operator already approved it in the plan, so listing it would be noise in a
 * list whose use depends on staying short.
 *
 * It names the file, not the finding. This file is plain Node and cannot
 * import the guard, and the file path is a fact from git like the reasons
 * above. A file listed here for an added scenario, which takes nothing away, is
 * the price of that, and a cheap one: the reviewer reads one diff and moves on.
 */
export const isRequirementFile = (file, prefix = requirementsPrefix()) =>
  file.startsWith(prefix) && /^(acceptance|invariants)\//.test(file.slice(prefix.length));

/**
 * The areas, as `{ must }`, a list of `{ text, items }`.
 *
 * **Must** is the file-based part of what `req:risk` scores HIGH: the rulebook's
 * high-risk areas, one reason each. With them, requirements that existed before
 * this change and were changed by it. It comes from git, so it is a fact about the
 * files, and `changed` decides which files — the branch, or only what is staged.
 * `added` names the ones among them that are new, which only the requirement
 * reason reads. Leaving it out treats every changed file as existing, which
 * errs toward listing too much rather than too little.
 *
 * `ignores` names the files in which this change adds a coverage ignore
 * comment (`addedIgnoreHints` in `frozen.mjs`). Such a comment takes code out
 * of the coverage figure, so a folder can stay above its minimum with less of
 * it tested. Under a reason of its own because the file is usually product
 * code, which no other reason here would list, and because "this changes what
 * does the checking" would not tell the reviewer which line to find.
 *
 * `suppressed` names, by check, the files in which this change adds one of
 * that check's suppression comments (`addedSuppressions` in `frozen.mjs`),
 * such as `// eslint-disable-next-line`. Each silences its check where it
 * sits, with no test failing, so each check gets a reason of its own naming
 * it.
 *
 * `root` is where the rulebook is read from. The callers leave it out and get
 * this repository's; the tests point it at a rulebook of their own.
 *
 * @param {{ changed: string[], added?: string[], ignores?: string[], suppressed?: { name: string, files: string[] }[], root?: string }} input
 */
export function reviewAreas({ changed, added = [], ignores = [], suppressed = [], root = process.cwd() }) {
  const must = [];

  for (const { why, items } of highRiskAreas(changed, root)) must.push({ text: why, items });
  const isNew = new Set(added);
  const prefix = requirementsPrefix(root);
  const requirements = changed.filter((f) => isRequirementFile(f, prefix) && !isNew.has(f));
  if (requirements.length > 0) {
    must.push({ text: 'Agreed requirements. Check that no promise was taken away.', items: requirements });
  }
  if (ignores.length > 0) {
    must.push({ text: 'New coverage ignore comments. Each takes code out of the figure.', items: ignores });
  }
  for (const { name, files } of suppressed) {
    if (files.length > 0) must.push({ text: `New suppressions of the ${name} check. Each silences it where it sits.`, items: files });
  }

  return { must };
}

/**
 * The areas as plain text lines, with nothing at all when there is nothing to
 * say. An empty section would be a line every reader learns to skip, including
 * on the change where it is not empty.
 *
 * A reason is wrapped to fit a 72-column commit body with the indent here. The
 * rulebook writes the reasons, so their length is not this file's to keep short.
 * The skill pastes this output without re-wrapping it, on purpose, so the
 * wrapping has to be right here.
 */
export function renderAreas({ must }, indent = '') {
  const lines = [];
  const width = 72 - indent.length - 2;
  const wrap = (text) => {
    const wrapped = [];
    let line = '';
    for (const word of text.split(/\s+/).filter(Boolean)) {
      if (line !== '' && line.length + 1 + word.length > width) {
        wrapped.push(line);
        line = word;
      } else {
        line = line === '' ? word : `${line} ${word}`;
      }
    }
    return line === '' ? wrapped : [...wrapped, line];
  };
  const section = (title, reasons) => {
    if (reasons.length === 0) return;
    lines.push(`${indent}${title}`);
    for (const { text, items } of reasons) {
      for (const part of wrap(text)) lines.push(`${indent}  ${part}`);
      for (const item of items) lines.push(`${indent}  - ${item}`);
    }
  };
  section('Must look:', must);
  return lines;
}
