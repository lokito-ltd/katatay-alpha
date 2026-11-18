/** A payload that no longer carries what a hook reads.
 *  See `harness.mjs` for why these cases spawn real processes. */
import { describe, expect, it } from 'vitest';
import {
  machineFixture, approvePlan, attempt, hook, phase, prompt, sent, stop,
} from '../support/machine/harness.mjs';

machineFixture();

/**
 * What the fixtures cannot do.
 *
 * A fixture is a copy of a session that has already happened, so no test built
 * on one can notice Claude Code changing its payloads tomorrow. Only a live
 * session can. These cases prove that when a field a hook reads goes missing,
 * the hook says which one, in the message it was already sending — which is the
 * signal to recapture, and the only thing standing between a payload change and
 * another year of quietly recording nothing.
 *
 * Absent is not falsy. `stop_hook_active: false` is the ordinary case and must
 * stay silent, or the warning becomes noise and nobody reads the one that
 * matters.
 */
describe('noticing that Claude Code sent something else', () => {
  const without = (fixture, field) => {
    const real = sent(fixture);
    delete real[field];
    return real;
  };

  it('says which field the gate lost', () => {
    const decision = hook('pre-tool.mjs', without('pre-tool-use-write', 'tool_name'));
    expect(decision.systemMessage).toMatch(/`tool_name`/);
    expect(decision.systemMessage).toMatch(/tests\/fixtures\/claude\//);
  });

  it('says so when the operator\'s words can no longer be heard', () => {
    const decision = hook('user-prompt.mjs', without('user-prompt-submit', 'prompt'));
    expect(decision.hookSpecificOutput.additionalContext).toMatch(/`prompt`/);
  });

  // One hook, one JSON object on stdout. The warning has to ride in the message
  // the hook was already sending rather than being a second write, so this
  // checks both are in the one object.
  it('carries the warning alongside what the hook was already saying', () => {
    const decision = hook('user-prompt.mjs', without('user-prompt-submit', 'prompt'));
    const said = decision.hookSpecificOutput.additionalContext;
    expect(said).toMatch(/`prompt`/);
    expect(said).toMatch(/workflow: open/);
  });

  it('says so when a turn can no longer be told it has already been blocked', () => {
    const decision = hook('turn-end.mjs', without('stop', 'stop_hook_active'));
    expect(decision.systemMessage).toMatch(/`stop_hook_active`/);
  });

  it('says so when an approval can no longer name its plan file', () => {
    const real = sent('post-tool-use-exit-plan-mode');
    delete real.tool_response.filePath;
    const decision = hook('post-tool.mjs', real);
    expect(decision.systemMessage).toMatch(/`tool_response.filePath`/);
    expect(decision.systemMessage).toMatch(/Claude Code did not say which file holds it, so no approval was recorded/);
    // Not recorded: the workflow reads the plan from the file, so text alone
    // grants nothing.
    expect(phase()).toBe('open');
  });

  it('stays quiet on an ordinary turn', () => {
    expect(stop()?.systemMessage ?? '').not.toMatch(/Recapture/);
    expect(prompt('hello').hookSpecificOutput.additionalContext).not.toMatch(/Recapture/);
    approvePlan();
    expect(attempt('source.txt')).toBeNull();
  });
});
