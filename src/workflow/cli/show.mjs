#!/usr/bin/env node
/** `workflow state show` — where this change stands, and what happens next. */
import { current, approvedPlanSummary, savedWarnings } from '../state.mjs';
import { reviewSuppressions, branchChanges } from '../frozen.mjs';
import { renderAreas, reviewAreas } from '../areas.mjs';
import { TargetError } from '../target.mjs';
import { agentWarnings } from '../agent.mjs';
import { readAgentAdapters, parseExtraHooks } from '../rulebook.mjs';
import { readBaseline } from '../phase.mjs';

import { triageEvidence } from '../triage-snapshot.mjs';
import { triageReport } from '../triage-summary.mjs';

let state;
try {
  state = current();
} catch (error) {
  if (!(error instanceof TargetError)) throw error;
  console.error(`state: refused — ${error.message}`);
  process.exit(1);
}

console.log(`branch     ${state.branch}`);
console.log(`phase      ${state.phase}`);
console.log(`because    ${state.why}`);
console.log(`logbook    ${state.dir} (${state.entries.length} event${state.entries.length === 1 ? '' : 's'})`);
// About this change's own events. When every event here is one the target
// already holds, there is nothing of this change's to commit, and "not
// committed yet" would be wrong about files git does hold.
const allMerged = state.entries.length > 0 && state.merged === state.entries.length;
console.log(`saved      ${state.saved.committed
  ? `committed at ${state.saved.sha} — git would notice if any were changed or deleted`
  : allMerged
    ? `nothing of this change's to commit yet — every event here is already in ${state.target.name}`
    : 'not committed yet — if these files were deleted, nothing would notice'}`);
// Only when there are some. A logbook with nothing merged is the ordinary case, and
// a line saying so every time is a line nobody reads on the run that matters.
if (state.merged > 0) {
  const all = state.merged === state.entries.length;
  console.log(`merged     ${state.merged} of them already in ${state.target.name} — ${all
    ? 'a finished change. Work on this branch name from here is a new change.'
    : 'a finished change, so they grant nothing. The rest are this one.'}`);
}
if (state.broken) console.log(`BROKEN     ${state.broken}`);
for (const warning of savedWarnings(state)) console.log(`WARNING    ${warning}`);
// What the agent adapter says is wrong with the agent's setup, such as hooks
// missing from its settings or switched off. Before the plan and the triage, because a hook that is off or a stranger
// answering the plan dialog changes how far everything below can be trusted.
for (const warning of agentWarnings()) console.log(`WARNING    ${warning}`);
// An explicitly disabled check is silent about extra hooks. Tell the
// operator which agents have that setting.
try {
  for (const [name, adapter] of Object.entries(readAgentAdapters())) {
    if (!parseExtraHooks(adapter, name).check) {
      console.log(`NOTE       ${name}: the rulebook turns the extra-hooks check off (agent.adapters.${name}.extraHooks.check), so hooks that are not the workflow's own are not listed`);
    }
  }
} catch (error) {
  if (!(error instanceof TargetError)) throw error;
  console.error(`state: refused — ${error.message}`);
  process.exit(1);
}
if (state.grant) {
  const { testOnly } = state.grant.payload;
  // On the permitted line rather than a line of its own: it is part of what the
  // operator granted, and the order of the phases follows from it.
  console.log(`permitted  operator approved a plan, ${state.grant.ts}${testOnly ? ' — declared test-only' : ''}`);
  console.log(approvedPlanSummary(state));
  // Where the change is measured from, and each time that moved. The pinned
  // one is on the approval, the moves are events of their own.
  const pinned = readBaseline(state.live.find((e) => e.event === 'plan_approved').payload.baseline);
  console.log(`baseline   ${state.baseline.slice(0, 12)} on ${state.target.name} — pinned ${pinned.slice(0, 12)}`);
  for (const move of state.live.filter((e) => e.event === 'baseline_moved')) {
    console.log(`           moved ${readBaseline(move.payload.from).slice(0, 12)} → ${readBaseline(move.payload.to).slice(0, 12)}, ${move.ts}`);
  }
}
if (state.triage) {
  // "as it stood then" because the counts are a record and nothing here said
  // so. The operator read `surprise 4/317` as four tests failing right now, on
  // a tree the machine had already recorded as verified. Whatever is failing
  // now is what the test command says, not what this block says.
  console.log(`triage     recorded ${state.triage.ts}. Its counts are the suite's as it stood then.`);
  // The same report the triage printed and the turn end sent, so the operator
  // reads one layout wherever a triage is shown.
  const report = triageReport(state.triage, { branch: state.branch, dir: state.dir, testOnly: Boolean(state.grant.payload.testOnly) });
  for (const line of report.split('\n')) console.log(line ? `           ${line}` : '');
  // The report reads the snapshot only when it has something to name. A lost
  // one still matters here: recording needs it.
  const { problem } = triageEvidence(state.branch, state.triage);
  if (problem && !report.includes(problem)) console.log(`           The triage snapshot cannot be read: ${problem}`);
  // After a triage only. By then the implementation is written, so the list
  // is about the change rather than its first few edits. The same list the
  // Stop hook gives and the commit message will carry.
  const changes = branchChanges(state.baseline);
  const { ignores, suppressed } = reviewSuppressions({ base: state.baseline, added: changes.added });
  const areas = renderAreas(reviewAreas({ ...changes, ignores, suppressed }));
  if (areas.length > 0) {
    console.log('review     where review should look:');
    for (const line of areas) console.log(`           ${line}`);
  }
}
if (state.declaration) {
  const { note } = state.declaration.payload;
  console.log(`declared   operator typed record, ${state.declaration.ts}${note ? ` — ${note}` : ''}`);
}
for (const file of state.changeFiles) console.log(`change     ${file}`);
console.log('');
for (const next of state.next) console.log(`next       ${next}`);

process.exit(state.broken ? 1 : 0);
