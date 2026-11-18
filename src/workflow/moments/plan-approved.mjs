#!/usr/bin/env node
/**
 * `on plan-approved`: the operator approved a plan.
 *
 * In:  `{ version, planFile: string }`. `planFile` names the plan the operator
 *      approved: a Markdown file directly in the rulebook's `plans.dir`,
 *      which the agent adapter has made sure holds the approved text, with any
 *      edits the operator made before approving.
 * Out: `{ version, recorded, messages }`. `recorded` says whether the
 *      approval was recorded. Recorded, the first message is `approved`, and
 *      news (`info`), inherited work (`warning`) and a test-only change's
 *      `run_triage` follow. Not recorded, it is one message: `refused` when the
 *      plan or the branch has to change, `stop` when only the operator can fix
 *      what is wrong.
 *
 * This is the only way a change gets permission to start. The agent adapter
 * calls it only when the operator has approved: approving a plan is a click
 * the agent cannot make on its own behalf, and it costs the operator nothing,
 * because they were making it anyway. How the adapter knows the click
 * happened is its own business (see `src/agents/claude/hooks/post-tool.mjs`).
 *
 * Every approval is recorded, not just the first. Plans change mid-change, and
 * the latest approved plan is the one that counts. A revised plan sends the
 * change back to `implementing`, because the work it adds has not been triaged.
 *
 * Two approvals are refused instead, and the operator is told why:
 *
 * - One on the target branch itself. Changes are measured from the target and
 *   merge into it, so a change made on it has nothing to be measured from, and
 *   the target never holds a live logbook. Nothing is appended, for that reason.
 * - A second plan on a branch whose change is already recorded. A branch holds
 *   one change until it merges or the operator resets it. This refusal also
 *   leaves the logbook untouched.
 *
 * The plan is read from the file, never from the request. An agent that has
 * no plan text to hand over, only a file it wrote, approves the same way, and
 * the file the logbook names is the file the hash was taken from. In order:
 *
 * - The file has to be a plan file, by the rule the write gate uses
 *   (`inPlansFolder` in `places.mjs`), and has to be readable. Otherwise the
 *   answer is `stop`: the adapter chose the file, and only whoever maintains
 *   it can fix that. No plan file means no approval.
 * - The plan has to follow the format (`readPlan` in `plan.mjs`). Otherwise
 *   the answer is `refused`, with every problem and the format, because the
 *   plan can be fixed and presented again.
 *
 * The first approval of a change pins its baseline: where `HEAD` meets the
 * target, asked of the server when it answers (see `baseline.mjs`). A revision
 * keeps the baseline in force, moved or not, because it is the same change.
 */
import { homedir } from 'node:os';
import { current, approvedPlanSummary } from '../state.mjs';
import { append, sha256 } from '../chain.mjs';
import { readPlan } from '../plan.mjs';
import { planFormat } from '../plan-format.mjs';
import { readPlanFile } from '../plan-file.mjs';
import { approvedPlans, publishSnapshot } from '../local-snapshot.mjs';
import { pinBaseline, unmergedWork } from '../baseline.mjs';
import { command } from '../commands.mjs';
import { RECORDED_PLAN_GUIDANCE, REPLAN_PENDING } from '../phase.mjs';
import { serve, versionShape } from './io.mjs';
import { answer, message } from './messages.mjs';

export const SHAPE = { version: versionShape, planFile: 'string' };

/** Not recorded, and why: `refused` or `stop`, both for the operator. */
const notRecorded = (code, text) => answer({ recorded: false }, [message(code, 'operator', text)]);

/**
 * @param {{ planFile: string }} input
 * @param {{ root?: string, home?: string }} [where] for tests; the repository
 *   is the working directory otherwise
 */
export function onPlanApproved({ planFile }, { root = process.cwd(), home = homedir() } = {}) {
  try {
    const state = current();

    if (state.broken) {
      return notRecorded('stop', `The plan was approved, but the workflow state chain is broken (${state.broken}), so the approval was not recorded. Stop and tell the operator.`);
    }
    const file = readPlanFile(planFile, root, home);
    if (file.problem) return notRecorded('stop', `The plan was approved, but not recorded: ${file.problem}`
      + (file.kind === 'location'
        ? ', so the approval does not name a plan the workflow can read. The agent adapter chose that file. Edits stay blocked. Stop and tell the operator.'
        : '. No plan file means no approval, so edits stay blocked. Stop and tell the operator.'));
    const read = readPlan(file.text);
    if (read.problems.length > 0) {
      return notRecorded(
        'refused',
        `The plan was approved, but not recorded: the plan in ${file.path} does not follow the plan format.\n\n`
          + read.problems.map((p) => `- ${p[0].toUpperCase()}${p.slice(1)}.`).join('\n')
          + `\n\n${planFormat(file.folder)}\n\nFix the plan, then present it again.`,
      );
    }
    // The approval hash and snapshot identify the exact bytes handed over.
    const proposal = sha256(file.bytes);
    if (state.branch === state.target.branch) {
      return notRecorded(
        'refused',
        `The plan was approved, but not recorded: this is ${state.target.branch}, the branch changes merge into. `
          + 'A change is made on a branch of its own. Create one, then present the plan again.',
      );
    }
    // Repeating an approval is not a revision. Preserve the existing grant
    // and its snapshot, even when an adapter hands over another input file.
    if (state.grant?.payload.proposal === proposal) {
      return answer({ recorded: false }, [message('info', 'agent',
        `This plan is already approved. ${state.replan ? REPLAN_PENDING : `Work continues in ${state.phase}; no new approval was recorded.`}\n${approvedPlanSummary(state, root)}`)]);
    }
    if (state.live.some((e) => e.event === 'recorded')) {
      return notRecorded(
        'refused',
        'The plan was approved, but not recorded: this branch already holds a recorded change, and a branch holds one change until it merges. '
          + RECORDED_PLAN_GUIDANCE + ' A fix to the recorded change needs no new plan: edit, and it goes back to converging.',
      );
    }

    const replacing = state.grant !== null;
    // Only the first approval pins a baseline. Revisions keep the one in force.
    const pinned = replacing ? null : pinBaseline(state.target);
    const baseline = replacing ? state.baseline : pinned?.sha;
    if (!baseline) {
      return notRecorded(
        'stop',
        `The plan was approved, but not recorded: ${state.target.name} has never been fetched and the server did not answer, `
          + 'so there is no baseline to measure the change from. Fetch it, then present the plan again.',
      );
    }
    // Declarations the operator made by approving the plan: read from the
    // closing `workflow` block of the file, which holds the text they approved. See
    // `requirementChangesIn` for what the guard does with the changes. The
    // predictions are read from the snapshot when triage or risk needs them.
    const { testOnly, requirementChanges } = read;
    const planSnapshot = publishSnapshot(state.branch, approvedPlans, file.bytes, root);
    const grant = append(state.dir, 'plan_approved', {
      proposal,
      testOnly,
      requirementChanges,
      planSnapshot,
      baseline,
    }, state.branch, state.entries.length);
    // Only on the first plan of a change. Later, the branch's own work is
    // exactly what this would list. It reads the working tree, so an edit made
    // before the approval is named whether or not it was committed.
    const inherited = replacing ? [] : unmergedWork(baseline);
    const approved = [
      replacing
        ? 'Plan approval recorded. It replaces the earlier approved plan on this branch, and the change is back to implementing: this plan has not been triaged, so the tests are frozen again. Revert any test written since the baseline before running `' + command('triage') + '`.'
        : 'Plan approval recorded. Edits are now permitted.',
      // Said on the turn it starts mattering. The order is the opposite of
      // the usual one, and an agent that follows the usual one writes the
      // tests first and meets the freeze.
      requirementChanges.length > 0
        ? `The plan approves requirement changes, which req:guard now accepts locally when the catalogue matches them exactly: ${requirementChanges.map((r) => r.id).join(', ')}.`
        : null,
    ].filter(Boolean).join(' ');
    return answer({ recorded: true }, [
      message('approved', 'agent', `${approved}\n${approvedPlanSummary({ branch: state.branch, grant }, root)}`),
      pinned?.source === 'fallback'
        ? message('info', 'agent', `The server did not answer, so the baseline was taken from ${state.target.name} as last fetched. It is checked against the server before the change can be recorded.`)
        : null,
      inherited.length > 0
        ? message('warning', 'operator', `This branch already changes ${inherited.length} file(s) that are not on ${state.target.name}: ${inherited.slice(0, 5).join(', ')}${inherited.length > 5 ? ', …' : ''}. `
          + 'A change is one branch, and a branch cut from another unmerged branch is not supported: that work, committed or not, counts as this change\'s. Tell the operator.')
        : null,
      testOnly
        ? message('run_triage', 'agent', 'The plan declares this change test-only. Run `' + command('triage') + '` now, before writing anything: '
          + 'it has to find the suite green, because a new test landing on top of an existing failure is much harder to sort out afterwards.')
        : null,
    ].filter(Boolean));
  } catch (error) {
    // This is the only route to permission, so failing quietly would leave
    // the operator approving plans that nothing records.
    return notRecorded('stop', `The plan was approved, but the workflow hook failed to record it: ${error.message}`);
  }
}

await serve(import.meta.url, 'plan-approved', SHAPE, onPlanApproved);
