// Documentation-based synthetic PreToolUse payloads, not live Claude captures.
// Start separate hook processes to exercise the actual referee and marker race.
import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ctx, events, machineFixture, on, phase, planFile } from '../support/machine/harness.mjs';

machineFixture();
const script = resolve('src/agents/claude/hooks/pre-tool.mjs');
function present(file, prompt = 'first') {
  if (!ctx.repo || !ctx.home) throw new Error('This hook needs a fixture repository.');
  const payload = { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: { planFilePath: file }, session_id: 'session', prompt_id: prompt };
  return new Promise((yes, no) => {
    const child = execFile(process.execPath, [script], { cwd: ctx.repo, env: { ...process.env, HOME: ctx.home, TMPDIR: ctx.home } }, (error, stdout) => {
      if (error) return no(error);
      try { yes(stdout.trim() ? JSON.parse(stdout) : null); } catch (error) { no(error); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

it('denies only one concurrent presentation, checks again on each prompt, and leaves approval to the dialog', async () => {
  const file = planFile();
  mkdirSync(dirname(file), { recursive: true });
  const missing = await present(file);
  expect(missing.systemMessage).toContain('cannot be read');
  expect(missing.hookSpecificOutput).toEqual({ hookEventName: 'PreToolUse', additionalContext: missing.systemMessage });
  writeFileSync(file, 'Incomplete.');
  const pair = await Promise.all([present(file), present(file)]);
  expect(pair.map(out => out.hookSpecificOutput.permissionDecision ?? 'advisory').sort()).toEqual(['advisory', 'deny']);
  for (const out of pair) expect(out.systemMessage).toContain('section Why is missing');
  expect((await present(file, 'next')).hookSpecificOutput.permissionDecision).toBe('deny');
  writeFileSync(file, ['Why', 'What', 'How', 'Requirements', 'Predicted failures', 'Test delta'].map(s => '## ' + s + '\nA complete section.\n').join('\n'));
  expect(await present(file)).toBeNull();
  expect(on('plan-presented', { version: 1, planFile: file }).answer).toEqual({ version: 1, needsCorrection: false, messages: [] });
  expect(events()).toEqual([]);
  expect(phase()).toBe('open');
});
