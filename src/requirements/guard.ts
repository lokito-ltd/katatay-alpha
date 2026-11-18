import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import matter from 'gray-matter';
import { checksum } from './checksum.js';
import {
  loadCatalogue, parseRequirement, scenarioText, STATUSES,
  type Requirement, type Scenario, type Status,
} from './parse.js';
import { carriedGrants, current } from '../workflow/state.mjs';
import { target } from '../workflow/target.mjs';
import { fetchTargetInCi } from '../workflow/baseline.mjs';
import { inCi } from '../workflow/ci.mjs';
import { gitText } from '../workflow/git.mjs';
import { requirementsDir, requirementsPrefix } from '../workflow/rulebook.mjs';
import { REPORT_HEADING } from '../workflow/record.mjs';

export type Severity =
  /** No approval can permit this. The lifecycle offers another route. */
  | 'forbidden'
  /**
   * Permitted, but a human has to see it. Locally that means a plan the
   * operator approved stating the result. In CI it means the reviewer, who is
   * told to read it. See `split` below.
   */
  | 'needs-approval';

export interface Violation {
  id: string;
  severity: Severity;
  message: string;
  /**
   * Set on every finding about a renumbered requirement: the id it has now.
   * `id` stays the old one, because that is the agreed requirement being moved
   * and the one the reviewer has to look up. A plan approval needs both to
   * match it; see `planApproves` in `evaluate`.
   */
  renumberedTo?: string;
}

/**
 * Every status change needs a human, except promoting an `accepted` requirement
 * to `active`. That move adds obligation. Every other one removes obligation,
 * or restores something that was removed, and a human decides those.
 *
 * Retirement is why the rule is this strict. It is the strongest weakening an
 * agent can make: the statement is left exactly as it was, so the text looks
 * untouched, and the obligation is gone. It can also be laundered. Adding a
 * weak requirement costs nothing, and pointing a strong one at it as
 * `supersededBy` retires the strong one behind a trail that looks legitimate.
 */
export function transitionNeedsApproval(before: Status, after: Status): boolean {
  if (before === after) return false;
  return !(before === 'accepted' && after === 'active');
}

function describeTransition(before: Status, after: Status): string {
  if (after === 'superseded' || after === 'withdrawn') {
    return `retired without approval: ${before} → ${after}`;
  }
  if (before === 'superseded' || before === 'withdrawn') {
    return `resurrected: ${before} → ${after}`;
  }
  return `status moved backwards: ${before} → ${after}`;
}

export interface GuardInput {
  /** Catalogue on the target branch. null when main has no commits yet. */
  main: Requirement[] | null;
  branch: Requirement[];
  /** Requirement ids accounted for by change files new on this branch. */
  accountedFor: Set<string>;
  /**
   * Requirement changes the operator approved in plan mode, as the resulting
   * requirement in full. Empty in CI. See `approvedInPlanFor` below.
   */
  approvedInPlan?: RecordedRequirement[];
  /**
   * Requirement changes the operator approved in the plans of the other
   * changes this branch carries, not yet in the target. They approve, and
   * unlike `approvedInPlan` they never account for a change: each of those
   * changes has to have its own change file. Empty in CI. See
   * `approvedElsewhereFor` below.
   */
  approvedElsewhere?: RecordedRequirement[];
  /**
   * Whether a plan approval also accounts for a change, standing in for its
   * change file. True outside CI until the operator types `record`, and false
   * in the run that records the change. See `planAccountsFor` below.
   */
  planAccounts?: boolean;
}

/**
 * The lifecycle rules, as a pure function. Everything that touches git lives in
 * the CLI below, so these rules can be exercised against synthetic branch/main
 * pairs.
 */
export function evaluate(input: GuardInput): Violation[] {
  const { main, branch, accountedFor, approvedInPlan = [], approvedElsewhere = [], planAccounts = false } = input;
  if (main === null) return []; // baseline: nothing exists to protect yet

  const violations: Violation[] = [];
  const mainById = new Map(main.map((r) => [r.id, r]));
  const branchById = new Map(branch.map((r) => [r.id, r]));

  // A plan approval covers a requirement only as it now stands on the branch.
  // It is checked against the result rather than the edit, so a statement
  // edited again after the operator approved it no longer matches, and needs
  // approving again.
  //
  // A renumber is covered only by an entry that names both ids: the new one as
  // its `id`, and the old one as `renumberedFrom`. An entry naming only the new
  // id has not said what it is moving, and an entry that names an old id does
  // not cover an ordinary change. Otherwise `{ id: AC0009, renumberedFrom:
  // AC0001 }` could be read as approving a rewording of an AC0001 that is still
  // there.
  //
  // The same test decides what the plan approves and what it accounts for, so
  // the two can never disagree about what the plan covers. Approvals carried
  // in from other changes are held to the same test.
  const covers = (approvals: RecordedRequirement[]) => (id: string, from: string | undefined): boolean => {
    const now = branchById.get(id);
    return now !== undefined && approvals.some(
      (a) => a.id === id && a.renumberedFrom === from &&
        a.status === now.status && checksum(a.statement) === now.checksum &&
        sameScenarios(a.scenarios, now.scenarios),
    );
  };
  const planCovers = covers(approvedInPlan);
  const carriedCovers = covers(approvedElsewhere);

  // Before `record`, the approved plan accounts for a change it states
  // exactly, so the change file can be written once the outcome is known.
  // The plan already holds the change to the
  // text the operator approved, which is everything an early change file
  // could have checked. The record itself still demands the file: the run
  // that records a change passes `planAccounts: false`, and CI never reads
  // the plan at all.
  const accounted = (id: string, from?: string): boolean =>
    accountedFor.has(id) || (planAccounts && planCovers(id, from));
  const orInPlan = planAccounts ? ', and the approved plan does not list it as it now reads' : '';

  // The new ids of renumbers. Each is judged as a renumber below, so the walk
  // over new requirements at the end leaves it out.
  const renumberTargets = new Set<string>();

  for (const before of main) {
    const after = branchById.get(before.id);

    if (after) {
      const { findings, changed } = compare(before, after);
      violations.push(...findings);
      // Every modification must be recorded, whether or not it needed approval —
      // including a retirement, which changes no checksum and would otherwise
      // leave no trace in the change log at all.
      if (changed && !accounted(before.id)) {
        violations.push({
          id: before.id,
          severity: 'forbidden',
          message: `changed but no change file on this branch accounts for it${orInPlan}`,
        });
      }
      continue;
    }

    // The id left the catalogue. A requirement carrying the same statement
    // under a new id is a renumber; anything else is a deletion.
    const renamedTo = branch.find((r) => r.checksum === before.checksum && !mainById.has(r.id));
    if (!renamedTo) {
      violations.push({
        id: before.id,
        severity: 'forbidden',
        message: `deleted. Requirements are never deleted — set status to superseded or withdrawn instead`,
      });
      continue;
    }

    // A renumber is a change on its own, and it can carry others with it. The
    // pair was found by its statement, so the statement cannot differ, but a
    // scenario or the status can. Each is reported as it would be without the
    // renumber. Otherwise a reviewer in CI would read only "id changed" while a
    // scenario quietly went away. The new requirement's scenarios are put back
    // under the old id first, so `AC0009.2` is compared with `AC0001.2` and the
    // finding names the scenario main had.
    const renumberedTo = renamedTo.id;
    renumberTargets.add(renumberedTo);
    const asBefore = {
      ...renamedTo,
      scenarios: renamedTo.scenarios.map((s) => ({ ...s, id: s.id.replace(`${renumberedTo}.`, `${before.id}.`) })),
    };
    violations.push(
      {
        id: before.id,
        severity: 'needs-approval',
        message: `id changed ${before.id} → ${renumberedTo}, and ${before.id} exists on main`,
        renumberedTo,
      },
      ...compare(before, asBefore).findings.map((v) => ({ ...v, renumberedTo })),
    );
    // Always recorded, under the new id: a change file states the requirement
    // as it now is, and the old id is no longer in the catalogue to state.
    if (!accounted(renumberedTo, before.id)) {
      violations.push({
        id: before.id,
        severity: 'forbidden',
        message: `renumbered to ${renumberedTo}, but no change file on this branch accounts for ${renumberedTo}${orInPlan}`,
        renumberedTo,
      });
    }
  }

  // A requirement the target does not hold yet. It needs approving as it
  // reads, like a rewording. Otherwise a weak new requirement could land
  // unseen, and a strong one could then be superseded by it: the supersede
  // needs approval, but the operator would approve it without having read the
  // wording that replaces it. It is recorded like any other change, so the
  // change file, or until `record` the plan, has to account for it.
  for (const after of branch) {
    if (mainById.has(after.id) || renumberTargets.has(after.id)) continue;
    violations.push({ id: after.id, severity: 'needs-approval', message: 'added as a new requirement' });
    if (!accounted(after.id)) {
      violations.push({
        id: after.id,
        severity: 'forbidden',
        message: `added but no change file on this branch accounts for it${orInPlan}`,
      });
    }
  }

  // A change this branch carries in from another one was approved in that
  // change's plan, so its approval clears the finding here as well. It does
  // not account for the change: that change's own change file has to, and
  // `accounted` above reads only this branch's plan. So a carried-in change
  // that was approved and never written up still fails.
  const approvedFor = (id: string, from: string | undefined): boolean =>
    planCovers(id, from) || carriedCovers(id, from);
  const planApproves = (v: Violation): boolean =>
    v.renumberedTo === undefined ? approvedFor(v.id, undefined) : approvedFor(v.renumberedTo, v.id);
  return violations.filter((v) => v.severity === 'forbidden' || !planApproves(v));
}

/**
 * What changed between a requirement on main and the same requirement on the
 * branch, as the findings that need approval, and whether anything changed at
 * all. Whether a change file accounts for it is the caller's question, because
 * a renumber answers it under a different id.
 */
function compare(before: Requirement, after: Requirement): { findings: Violation[]; changed: boolean } {
  const findings: Violation[] = [];
  const statementChanged = before.checksum !== after.checksum;
  const statusChanged = before.status !== after.status;
  const { weakened, changed: scenariosChanged } = scenarioChanges(before.scenarios, after.scenarios);

  if (statementChanged && before.status === 'active') {
    findings.push({
      id: before.id,
      severity: 'needs-approval',
      message: `statement of an active requirement was reworded (${before.checksum} → ${after.checksum})`,
    });
  }

  // A scenario added to an active requirement adds obligation, like
  // `accepted → active`, so it is free. One removed or reworded takes a
  // promise away, exactly as rewording the statement does.
  if (weakened.length > 0 && before.status === 'active') {
    findings.push({
      id: before.id,
      severity: 'needs-approval',
      message: `scenarios of an active requirement were removed or reworded: ${weakened.join(', ')}`,
    });
  }

  if (statusChanged && transitionNeedsApproval(before.status, after.status)) {
    findings.push({
      id: before.id,
      severity: 'needs-approval',
      message: describeTransition(before.status, after.status),
    });
  }

  return { findings, changed: statementChanged || statusChanged || scenariosChanged };
}

export interface RecordedRequirement {
  id: string;
  /**
   * The id the requirement had on main, when this records a renumber. See
   * `requirementChangesIn` in `src/workflow/plan.mjs`.
   */
  renumberedFrom?: string;
  status: Status;
  statement: string;
  /** Every scenario, as `[AC0009.2] text`. Absent or empty for a requirement that has none. */
  scenarios?: string[];
}

/**
 * How a requirement's scenarios moved between main and the branch.
 *
 * `weakened` names each scenario main had that the branch no longer has in the
 * same words: removed, or reworded. `changed` is true for any difference at
 * all, an added scenario included, because every change is recorded even when
 * it needs no approval.
 */
export function scenarioChanges(before: Scenario[], after: Scenario[]): { weakened: string[]; changed: boolean } {
  const afterById = new Map(after.map((s) => [s.id, s]));
  const weakened = before.filter((s) => afterById.get(s.id)?.checksum !== s.checksum).map((s) => s.id);
  return { weakened, changed: weakened.length > 0 || after.length !== before.length };
}

/**
 * Whether a record lists exactly the scenarios the requirement has: every one,
 * in the same words, and nothing else. The order is not compared, because ids
 * are identity and never order.
 */
export function sameScenarios(recorded: string[] = [], actual: Scenario[]): boolean {
  if (recorded.length !== actual.length) return false;
  const actualById = new Map(actual.map((s) => [s.id, s.text]));
  const seen = new Set<string>();
  return recorded.every((line) => {
    const match = /^\[((?:AC|INV)\d{4}\.\d+)\]\s+([\s\S]+)$/.exec(line);
    // Each id once: a record naming one scenario twice could otherwise stand
    // in for a scenario it left out.
    if (match === null || seen.has(match[1]!)) return false;
    seen.add(match[1]!);
    return actualById.get(match[1]!) === scenarioText(match[2]!);
  });
}

/**
 * The requirements a change file records, read from its frontmatter.
 *
 * Each entry states the resulting requirement in full: id, status, and the
 * statement itself. It does not describe the edit that produced it. An entry
 * reading "reworded for clarity" makes no sense on its own, because a reader
 * has to find the previous version first, and a record nobody can read alone is
 * not worth keeping. The transition is left out because the guard can work it
 * out — it holds both main and the branch.
 *
 * Stating the statement also means the fingerprint is computed here instead of
 * copied in by hand, so a stale checksum cannot happen at all.
 *
 * Prose is not read. A cross-reference in the body — "protects AC0001", "see
 * [[INV0002]]" — is commentary. If it counted, an incidental mention would
 * satisfy the strongest rule in this file.
 */
export function recordedIn(markdown: string): RecordedRequirement[] {
  let data: Record<string, unknown>;
  try {
    ({ data } = matter(markdown) as { data: Record<string, unknown> });
  } catch {
    return []; // malformed frontmatter records nothing, and the accounting rule will say so
  }
  return wellFormed(data.requirements);
}

/**
 * The entries that state a requirement completely: an id, a status from the
 * lifecycle, a statement, and its scenarios when it has any, each written as
 * the AC file writes it: `[AC0009.2] text`. Anything else is dropped rather
 * than guessed at.
 * Plan approvals are already validated by the logbook reader.
 */
export function wellFormed(entries: unknown): RecordedRequirement[] {
  if (!Array.isArray(entries)) return [];

  const records: RecordedRequirement[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, renumberedFrom, status, statement, scenarios = [] } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || !/^(AC|INV)\d{4}$/.test(id)) continue;
    if (renumberedFrom !== undefined && !sameKind(renumberedFrom, id)) continue;
    if (typeof status !== 'string' || !STATUSES.includes(status as Status)) continue;
    if (typeof statement !== 'string' || statement.trim() === '') continue;
    if (!Array.isArray(scenarios) || !scenarios.every((s) => typeof s === 'string')) continue;
    records.push({
      id,
      ...(renumberedFrom === undefined ? {} : { renumberedFrom: renumberedFrom as string }),
      status: status as Status,
      statement: statement.trim(),
      scenarios: scenarios.map((s: string) => s.trim()),
    });
  }
  return records;
}

/**
 * Whether `from` is a well-formed id of the same type as `to`, and a different
 * one. A renumber cannot turn an acceptance criterion into an invariant;
 * `req:renumber` refuses that too. Repeated in `src/workflow/plan.mjs`, which
 * Node runs directly and cannot import TypeScript.
 */
function sameKind(from: unknown, to: string): from is string {
  if (typeof from !== 'string' || !/^(AC|INV)\d{4}$/.test(from) || from === to) return false;
  return from.replace(/\d+$/, '') === to.replace(/\d+$/, '');
}

/**
 * Whether the record tells the truth about the branch it ships with.
 *
 * This is separate from `evaluate`, which only asks whether a changed
 * requirement was named somewhere. Here the question is whether what was
 * written down matches what was done. The two compare different things — one
 * main against the branch, the other the record against the branch — so keeping
 * them apart means neither has to know how the other decides.
 *
 * Every violation here is `forbidden`, because no approval can make a false
 * record true. A change file that misdescribes its own change does more harm
 * than one that says nothing, because a reader takes it as evidence.
 */
export function recordFidelity(
  recorded: RecordedRequirement[],
  branch: Requirement[],
): Violation[] {
  const branchById = new Map(branch.map((r) => [r.id, r]));
  const violations: Violation[] = [];

  for (const entry of recorded) {
    const actual = branchById.get(entry.id);
    if (!actual) {
      violations.push({
        id: entry.id,
        severity: 'forbidden',
        message: `is recorded in a change file but does not exist in the catalogue on this branch`,
      });
      continue;
    }
    if (actual.status !== entry.status) {
      violations.push({
        id: entry.id,
        severity: 'forbidden',
        message: `is recorded as ${entry.status} but the catalogue says ${actual.status}`,
      });
    }
    if (checksum(entry.statement) !== actual.checksum) {
      violations.push({
        id: entry.id,
        severity: 'forbidden',
        message: `has a statement in its change file that is not the statement in the catalogue`,
      });
    }
    // A renumber recorded while the old id is still in the catalogue did not
    // happen, whatever the record says.
    if (entry.renumberedFrom !== undefined && branchById.has(entry.renumberedFrom)) {
      violations.push({
        id: entry.id,
        severity: 'forbidden',
        message: `is recorded as renumbered from ${entry.renumberedFrom}, but ${entry.renumberedFrom} is still in the catalogue on this branch`,
      });
    }
    // In full means every scenario too. A record that left one out would read
    // as though the requirement never promised it.
    if (!sameScenarios(entry.scenarios, actual.scenarios)) {
      violations.push({
        id: entry.id,
        severity: 'forbidden',
        message: `has scenarios in its change file that are not the scenarios in the catalogue — list every one, as the AC file writes it`,
      });
    }
  }
  return violations;
}

/**
 * The records `recordFidelity` judges: for each requirement, the entries in the
 * newest change file that records it.
 *
 * A change file states a requirement as it stood when that change finished. A
 * branch can carry several unmerged change files that record the same
 * requirement at different times, as an integration branch does when several
 * feature branches have merged into it. Only the newest of those can match the
 * catalogue. The older ones were true when written and are history now, the
 * same as a change file already on the target. Judging them against today's
 * catalogue reported each one as a false record.
 *
 * Nothing in the catalogue can hide behind an older record, because the newest
 * record of the same requirement still has to match it. What is given up is a
 * check on the older record itself, which today's catalogue could not answer
 * anyway.
 *
 * Newest is latest by filename. A change file is named for the UTC time it was
 * written, so sorting by name sorts by time, whatever order the directory
 * listing gives.
 *
 * The newest file's entries for a requirement are all kept, not only its last
 * one. Keeping one entry per requirement would let a second entry in the same
 * file hide a false first one.
 */
export function newestRecords(files: { path: string; markdown: string }[]): RecordedRequirement[] {
  const newest = new Map<string, RecordedRequirement[]>();
  // Two files never share a path, so there is no tie to return 0 for.
  const oldestFirst = [...files].sort((a, b) => (a.path < b.path ? -1 : 1));
  for (const file of oldestFirst) {
    const inThisFile = new Map<string, RecordedRequirement[]>();
    for (const entry of recordedIn(file.markdown)) {
      inThisFile.set(entry.id, [...(inThisFile.get(entry.id) ?? []), entry]);
    }
    for (const [id, entries] of inThisFile) newest.set(id, entries);
  }
  return [...newest.values()].flat();
}

export const DEPARTURES_HEADING = '## Departures';

/**
 * Whether a change file says how the outcome differed from the plan it was
 * approved under.
 *
 * The plan is a working document and is never committed. Once a change is
 * merged, the change file is the only place a reviewer could learn that
 * something was done differently from what the operator agreed to. With no
 * section for it, a change file with nothing to report and one where nobody was
 * ever asked read exactly the same.
 *
 * This checks presence, not truth. Nothing can check that a list of departures
 * is complete: the plan is not in the repository, and intent cannot be read by
 * a machine. What it does buy is small and still worth having. Leaving the
 * section out stops being possible, so a reviewer who reads `None.` knows
 * somebody was asked the question.
 *
 * Every violation here is `forbidden`. An approval permits a requirement to
 * change. It should not also permit the account of the change to be silent, which is a rule about the shape of the record rather than about
 * any requirement.
 *
 * The `id` field carries the filename here rather than a requirement id. It is
 * only a label in the output, and a second violation type carrying one string
 * would make every caller handle two shapes for nothing.
 */
export function departuresRecorded(files: { path: string; markdown: string }[]): Violation[] {
  const violations: Violation[] = [];
  for (const { path, markdown } of files) {
    const body = bodyOf(markdown);
    // Split on the heading, then read to the next one. An empty section is the
    // same omission as a missing one, dressed up to look answered.
    const after = body.split(new RegExp(`^${DEPARTURES_HEADING}\\s*$`, 'm'))[1];
    if (after === undefined) {
      violations.push({
        id: basename(path),
        severity: 'forbidden',
        message: `has no \`${DEPARTURES_HEADING}\` section — say how the outcome differed from the approved plan, or \`None.\``,
      });
      continue;
    }
    if ((after.split(/^##\s/m)[0] ?? '').trim() === '') {
      violations.push({
        id: basename(path),
        severity: 'forbidden',
        message: `has an empty \`${DEPARTURES_HEADING}\` section — write \`None.\` if nothing departed from the plan`,
      });
    }
  }
  return violations;
}

/** A change file's body, without its frontmatter. */
function bodyOf(markdown: string): string {
  try {
    return (matter(markdown) as { content: string }).content;
  } catch {
    return markdown; // malformed frontmatter; the headings are still findable
  }
}

/**
 * Whether this change's change file opens with the declared report summary.
 *
 * At `record` the report summary is kept in the `declared` event (see `reportSection` in
 * `src/workflow/record.mjs`). The change file is what survives the merge, so
 * those lines go at its top, under `## Report`, where a reviewer reads them
 * first. The agent writes the file, so the lines are compared with the ones
 * the harness stored rather than taken on trust: a summary rewritten to look
 * better than the measured result is refused.
 *
 * Only the newest of the new change files is checked. Its name starts with a
 * UTC timestamp, and this change's file is written after `record`, so it is
 * always the newest. Older new files belong to changes this branch carries,
 * each declared against its own summary.
 *
 * `declared` is the payload of the live `declared` event for this tree, or
 * null when there is none, and then there is nothing to compare with.
 *
 * Run only by the record step (`--record`), outside CI. CI cannot trust the
 * logbook, and change files merged before this rule have no such section.
 */
export function reportRecorded(
  files: { path: string; markdown: string }[],
  declared: Record<string, any> | null,
): Violation[] {
  if (declared === null || files.length === 0) return [];
  const newest = [...files].sort((a, b) => (basename(a.path) < basename(b.path) ? -1 : 1)).at(-1)!;
  const id = basename(newest.path);
  const refuse = (message: string): Violation[] => [{ id, severity: 'forbidden', message }];
  const body = bodyOf(newest.markdown);

  const first = body.match(/^##\s.*$/m)?.[0].trim();
  if (first !== REPORT_HEADING) {
    return refuse(`does not open with a \`${REPORT_HEADING}\` section — put it first, before \`## Why\`, as the record context gave it`);
  }

  const section = (body.split(new RegExp(`^${REPORT_HEADING}\\s*$`, 'm'))[1] ?? '').split(/^##\s/m)[0] ?? '';
  const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  const summary: string[] = declared.summary;
  const block = section.match(/^```[^\n]*\n([\s\S]*?)^```/m);
  const want = summary.map((l) => l.trim()).filter((l) => l !== '');
  if (block === null) {
    return refuse(`has no text block in its \`${REPORT_HEADING}\` section — it holds the report's summary lines, as declared:\n${want.map((l) => `      ${l}`).join('\n')}`);
  }
  const got = lines(block[1] ?? '');
  if (got.join('\n') === want.join('\n')) return [];
  return refuse(`has a \`${REPORT_HEADING}\` section that differs from the summary the operator declared on — it must read, word for word:\n${want.map((l) => `      ${l}`).join('\n')}`);
}

// ---------------------------------------------------------------- CLI

function git(args: string[]): string {
  return gitText(args);
}

/**
 * The ref this branch is compared against: the target's remote-tracking ref,
 * from `.katatay/rulebook.json`. The guard compares the whole branch with it,
 * because the merge request carries the whole branch.
 */
export const targetRef = (): string => target().ref;

export function refExists(ref: string = targetRef()): boolean {
  try {
    git(['rev-parse', '--verify', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The catalogue as it stands at `ref`, read straight out of git. The target by
 * default; the change report passes the change's baseline, so it counts only
 * what this change altered.
 */
export function loadCatalogueAt(ref: string = targetRef()): Requirement[] {
  // The pathspec keeps git to the folder, so every path begins with the prefix.
  const prefix = requirementsPrefix();
  const listed = git(['ls-tree', '-r', ref, '--name-only', '--', prefix])
    .split('\n')
    .filter((p) => /^(acceptance|invariants)\/.+\.md$/.test(p.slice(prefix.length)));

  return listed.map((path) =>
    parseRequirement(basename(path), git(['show', `${ref}:${path}`]), path),
  );
}

/**
 * Change files that do not exist on main: the ones this branch is adding.
 *
 * Both checks below read exactly this set, so it is loaded once. A change file
 * already on main is history, and a rule written today must not turn a merged
 * record into a violation.
 */
export function loadNewChangeFiles(): { path: string; markdown: string }[] {
  const dir = join(requirementsDir(), 'changes');
  if (!existsSync(dir)) return [];
  const ref = targetRef();
  const onMain = new Set(
    refExists(ref)
      ? git(['ls-tree', '-r', ref, '--name-only', '--', dir]).split('\n').filter(Boolean)
      : [],
  );
  return readdirSync(dir)
    .map((filename) => join(dir, filename))
    .filter((path) => !onMain.has(path) && path.endsWith('.md') && basename(path) !== 'TEMPLATE.md')
    .map((path) => ({ path, markdown: readFileSync(path, 'utf8') }));
}

/**
 * The requirement changes the operator approved with the plan this branch is
 * working under, or none in CI.
 *
 * The approval is recorded in the workflow logbook by `post-tool.mjs`, when the
 * operator accepts the plan in plan mode. Outside CI it is the approval for
 * this branch's own change, and `approvedElsewhereFor` gives the approvals of
 * the other changes it carries. Without it, a change that rewords a
 * requirement could not be verified by the `Stop` hook or committed past the
 * pre-commit hook.
 *
 * CI never reads it. The logbook is a file on the branch, and a session can write
 * to it through the shell, so in CI it would prove nothing. CI hands those
 * findings to the reviewer instead; see `split`. The platform is the
 * authority, and this is convenience for the local loop. CI systems set `CI`
 * on every job, and only `CI=true` counts as CI (`inCi` in `ci.mjs`). Any
 * other value is local, where the guard is stricter.
 *
 * Only the latest approval in the live epoch counts, the same one the phase is
 * folded from. A plan revised and approved again replaces what the earlier one
 * approved.
 *
 * The logbook is read only when it is going to be used. A CI job checks out a
 * detached commit, where there is no branch to find a logbook for.
 */
export function approvedInPlanFor(
  env: Record<string, string | undefined>,
  grant: () => { payload: Record<string, any> } | null,
): RecordedRequirement[] {
  if (inCi(env)) return [];
  const held = grant();
  return held ? held.payload.requirementChanges : [];
}

/**
 * The requirement changes the operator approved in the plans of the other
 * changes this branch carries, or none in CI.
 *
 * A branch can gather several changes before they reach the target. Measured
 * against the target, it then shows every requirement those changes reworded,
 * and each was approved in its own change's plan, not in this branch's. Each
 * change's logbook travels with the branch, so its approval is still readable.
 * `carriedGrants` in `state.mjs` says which logbooks count and why.
 *
 * CI never reads them, for the reason it never reads this branch's own: a
 * logbook is a file on the branch.
 *
 * The logbooks are read only when they are going to be used, as above.
 */
export function approvedElsewhereFor(
  env: Record<string, string | undefined>,
  grants: () => { payload: Record<string, any> }[],
): RecordedRequirement[] {
  if (inCi(env)) return [];
  return grants().flatMap((held) => held.payload.requirementChanges);
}

/** The flag the run that records a change passes. */
export const RECORD_FLAG = '--record';

/**
 * Whether the approved plan may stand in for a change file. It may outside CI,
 * until the operator types `record`.
 *
 * A change that edits or adds a requirement would otherwise need its change
 * file before `workflow verify` could pass, while the change file is written
 * after `record`. So the file was written early, before anyone knew how the
 * change would turn out, and its Departures section was written twice.
 *
 * The record step in `src/agents/claude/hooks/turn-end.mjs` passes `--record`,
 * and then only a change file accounts for a change, as before. That run is
 * the one that matters: nothing reaches `recorded` without it passing. Leaving
 * the flag off cannot be used to skip anything there, because the hook always
 * passes it. A flag rather than the phase, because telling `declared` from
 * `verified` means fingerprinting the whole tree, and the guard has no other
 * use for that.
 *
 * In CI the plan is never read, so this is false there whatever the flag.
 */
export function planAccountsFor(env: Record<string, string | undefined>, argv: string[]): boolean {
  return !inCi(env) && !argv.includes(RECORD_FLAG);
}

/**
 * Which findings fail the guard, and which go to the reviewer.
 *
 * Outside CI every finding fails. A `needs-approval` one has already had its
 * chance: the plan approvals, this branch's and those carried in from the
 * other changes it holds, were checked in `evaluate`, and what is left is a
 * change to a requirement nobody approved. That is the check that stops a
 * session quietly weakening a requirement before the operator sees the branch.
 *
 * In CI a `needs-approval` finding does not fail. There used to be an approval
 * trailer for it, a line in the merge request description, but anyone who
 * could edit the description could write that line, so it proved nothing about
 * who had approved. What holds the line is the protected branch and the
 * operator merging by hand. So CI's job is to make sure the reviewer reads the
 * change, and approving it is the hosting platform's: its merge request
 * approvals where the plan has them, and the merge itself otherwise. The same files are listed
 * under "Must look" in the commit message, by `areas.mjs`.
 *
 * A `forbidden` finding fails everywhere. No approval could permit it, so
 * there is nothing for a reviewer to decide.
 */
export function split(
  violations: Violation[],
  env: Record<string, string | undefined>,
): { failing: Violation[]; forReview: Violation[] } {
  if (!inCi(env)) return { failing: violations, forReview: [] };
  return {
    failing: violations.filter((v) => v.severity === 'forbidden'),
    forReview: violations.filter((v) => v.severity === 'needs-approval'),
  };
}

/**
 * What a failing guard prints, heading first. In `workflow verify` the guard
 * runs straight after the lint, and its details used to come before its own
 * heading. They sat under `req:lint — catalogue OK` and read as a lint problem
 * on a catalogue that had just been called fine.
 */
export function failureReport(failing: Violation[]): string[] {
  const lines = [
    `req:guard — ${failing.length} violation(s)`,
    ...failing.map((v) => `  ${v.id}: ${v.message}`),
  ];
  if (failing.some((v) => v.severity === 'needs-approval')) {
    lines.push(
      '',
      '  A plan the operator approved may approve these, by listing each one as it',
      "  will read under `requirement-changes:` in the plan's closing `workflow` block.",
      '  A renumber is listed under its new id, with the old one as `renumberedFrom`.',
    );
  }
  return lines;
}

/**
 * The check as `workflow req guard` runs it, and as the referee verify runs it.
 * Prints what it found, and returns whether it passed. `args` are the
 * command-line arguments, where `--record` asks for the change file only.
 */
export function runGuard(args: string[], env: Record<string, string | undefined> = process.env): boolean {
  // In CI, against the server's branch rather than whatever the clone holds.
  // CI as `env` says, like every other CI decision here, so a caller that
  // says "not in CI" is not fetched for because the process happens to be.
  // A fetch that fails is refused in one line naming the target, like the
  // missing ref below. It used to escape as an uncaught error, and Node
  // printed a stack trace where the reader needed one sentence.
  try {
    fetchTargetInCi(target(), env);
  } catch (error) {
    console.error(`req:guard — ${(error as Error).message}`);
    return false;
  }
  // Without the target there is nothing to measure this branch from, so
  // refuse and say why. The guard used to carry on: every change file looked
  // new, including ones merged long before the Departures rule, and the output
  // listed each of those as a violation without naming the missing target.
  // Passing instead would let any protected requirement change unchecked. The
  // plan approval refuses for the same reason, and CI fails its fetch above.
  if (!refExists()) {
    console.error(`req:guard — the target ${target().name} is not here, so this branch has nothing to compare against. Push the target branch, or fetch it, and run again.`);
    return false;
  }
  const branch = loadCatalogue();
  const changeFiles = loadNewChangeFiles();
  // Every record accounts for a change, but only the newest record of each
  // requirement has to match the catalogue. See `newestRecords`.
  const recorded = changeFiles.flatMap((file) => recordedIn(file.markdown));
  const violations = [
    ...evaluate({
      main: refExists() ? loadCatalogueAt() : null,
      branch,
      accountedFor: new Set(recorded.map((r) => r.id)),
      approvedInPlan: approvedInPlanFor(env, () => current().grant),
      approvedElsewhere: approvedElsewhereFor(env, () => carriedGrants()),
      planAccounts: planAccountsFor(env, args),
    }),
    ...recordFidelity(newestRecords(changeFiles), branch),
    ...departuresRecorded(changeFiles),
    ...(!inCi(env) && args.includes(RECORD_FLAG) ? reportRecorded(changeFiles, current().declaration?.payload ?? null) : []),
  ];

  const { failing, forReview } = split(violations, env);

  if (forReview.length > 0) {
    console.log(`req:guard — a reviewer must read these before merging:`);
    for (const v of forReview) console.log(`  ${v.id}: ${v.message}`);
    console.log('');
  }
  if (failing.length > 0) {
    for (const line of failureReport(failing)) console.error(line);
    return false;
  }
  console.log(forReview.length > 0
    ? `req:guard — ${forReview.length} change(s) for the reviewer, nothing forbidden`
    : 'req:guard — no protected requirement was changed without approval');
  return true;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain && !runGuard(process.argv.slice(2))) process.exit(1);
