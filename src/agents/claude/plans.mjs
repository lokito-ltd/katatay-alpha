/** Claude's pre-presentation courtesy. It cannot approve a plan. */
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planCheck, VERSION } from './hooks/translate.mjs';

/** Atomically reserve the one interruption for this repository/session/prompt.
 * These empty temporary files carry no plan text or workflow authority. A
 * missing marker can only repeat a courtesy, never grant permission.
 */
export function claimCorrection(root, session, prompt, scratch = tmpdir()) {
  const key = createHash('sha256').update(JSON.stringify([realpathSync(root), session, prompt])).digest('hex');
  const folder = join(scratch, 'workflow-claude-plan-courtesy');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(join(folder, key), '', { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

const warning = (text) => ({
  systemMessage: text,
  hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text },
});

export function presentPlan(hook, { ask, claim = claimCorrection, root = process.cwd() }) {
  const file = hook?.tool_input?.planFilePath;
  if (typeof file !== 'string' || file.trim() === '') {
    return warning('Claude Code sent no tool_input.planFilePath, so the presented plan could not be checked. Approval remains the operator’s decision.');
  }
  let checked;
  try {
    checked = planCheck(ask('plan-presented', { version: VERSION, planFile: file }));
  } catch (error) {
    return warning(`The presented plan could not be checked: ${error.message}`);
  }
  if (!checked.text) return null;
  if (!checked.needsCorrection) return warning(checked.text);
  const { session_id: session, prompt_id: prompt } = hook;
  if (![session, prompt].every((id) => typeof id === 'string' && id.trim() !== '')) {
    return warning(`${checked.text}\n\nClaude Code sent no session_id or prompt_id to bound the correction request, so presentation continues.`);
  }
  try {
    if (claim(root, session, prompt)) return {
      systemMessage: checked.text,
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: checked.text },
    };
  } catch (error) {
    return warning(`${checked.text}\n\nThe courtesy interruption could not be tracked (${error.code ?? error.message}), so presentation continues.`);
  }
  return warning(checked.text);
}
