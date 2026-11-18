#!/usr/bin/env node
/**
 * PostToolUse on ExitPlanMode — the operator approving a plan. The referee
 * records it (`on plan-approved`); this says what Claude Code sent.
 *
 * The hook running *is* the approval. PostToolUse fires only when a tool call
 * succeeds, and a plan the operator turns down never succeeds: "No, keep
 * planning" is a denial, and Claude Code fires no PostToolUse for one. The
 * previous version also searched the response for approval wording. That
 * wording never once matched what Claude Code actually says, which is how plan
 * mode went this project's whole life without recording an approval.
 *
 * The plan comes from `tool_response.plan`, which holds the version the
 * operator approved, including any edits they made before approving, rather
 * than the draft Claude wrote. Without it there is nothing to bind the approval
 * to, so the referee is not asked and the operator is told.
 *
 * The referee reads the plan from its file, never from the request, so this
 * hook makes sure the file holds `tool_response.plan` first, and writes it
 * there when it does not. A captured approval with an edit (2026-10-27, see
 * `tests/fixtures/claude/README.md`) showed Claude Code already saves the operator's
 * dialog edits to the file, so the write is a guard against that changing
 * rather than a step every approval needs. Claude Code keeps one plan file per
 * session, so a revised plan overwrites the file of the earlier approval. Only
 * the latest approval is compared with its file, so nothing is lost: the
 * earlier one's hash stays in the logbook.
 *
 * `tool_response.filePath` is the only place the plan file is named. An earlier
 * version fell back to `tool_input.planFilePath`, which no session has ever
 * sent: a captured `ExitPlanMode` payload carries `tool_input: { _targetMode }`
 * and nothing else. The fallback existed because a hand-written test payload
 * put the plan and its path in `tool_input`, and it went unnoticed because the
 * same payload was the only thing that ever exercised it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { input, emit, send, leave } from './io.mjs';
import { expectFields } from './drift.mjs';
import { ask } from './referee.mjs';
import { VERSION, forPlanApproved } from './translate.mjs';

/**
 * Make sure `file` holds `plan`: write it when the file is missing or says
 * something else. A missing folder is not created, because Claude Code made
 * the folder when it wrote the plan, and one that is gone is not this hook's
 * to invent.
 */
function holdApproved(file, plan) {
  let held;
  try {
    held = readFileSync(file, 'utf8');
  } catch {
    held = null;
  }
  if (held !== plan) writeFileSync(file, plan);
}

let hook;
try {
  hook = await input();
} catch (error) {
  // This is the only route to permission, so failing quietly would leave the
  // operator approving plans that nothing records.
  emit({ systemMessage: `The plan was approved, but the workflow hook failed to record it: ${error.message}` });
  await leave();
}
// `plan` has its own message below, written for the operator rather than for
// whoever maintains the hooks, so it is not repeated here.
expectFields(hook, { 'tool_response.filePath': 'no approval is recorded, because the workflow reads the approved plan from that file' });
const plan = hook?.tool_response?.plan;
const planFile = hook?.tool_response?.filePath;

if (typeof plan !== 'string' || plan.trim() === '') {
  emit({
    systemMessage:
      'The plan was approved, but Claude Code did not pass the approved plan text to the workflow hook, so no approval was recorded and edits stay blocked. '
      + 'Claude Code may have changed what it sends. Tell the operator.',
  });
} else if (typeof planFile !== 'string' || planFile === '') {
  emit({ systemMessage: 'The plan was approved, but Claude Code did not say which file holds it, so no approval was recorded and edits stay blocked. Tell the operator.' });
} else {
  let written = true;
  try {
    holdApproved(planFile, plan);
  } catch (error) {
    written = false;
    emit({
      systemMessage: `The plan was approved, but the workflow hook could not write the approved plan to ${planFile} (${error.code ?? error.message}), `
        + 'so no approval was recorded and edits stay blocked. Tell the operator.',
    });
  }
  if (written) send(forPlanApproved(ask('plan-approved', { version: VERSION, planFile })));
}
await leave();
