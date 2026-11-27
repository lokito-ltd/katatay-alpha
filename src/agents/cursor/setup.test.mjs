import { describe, expect, it } from 'vitest';
import { HARNESS_ROOT, hookRegistration } from './registration.mjs';
import { ENTERPRISE_FILES, covers, setupWarnings } from './setup.mjs';

const own = () => hookRegistration(HARNESS_ROOT);
const project = (hooks) => JSON.stringify({ version: 1, hooks });
const warnings = (files, { extraHooks = { acknowledged: [] }, instructions = true } = {}) => setupWarnings({ files, extraHooks, instructions });

describe('Cursor\'s setup check', () => {
  it('finds nothing wrong with the registration init writes', () => {
    expect(warnings({ '.cursor/hooks.json': JSON.stringify(own()), '~/.cursor/hooks.json': null })).toEqual([]);
  });

  it('reports each workflow hook missing, with what stops working', () => {
    const found = warnings({ '.cursor/hooks.json': null });
    expect(found).toEqual([
      '.cursor/hooks.json does not register the workflow\'s preToolUse hook (src/agents/cursor/hooks/pre-tool.mjs), so edits are no longer held until a plan has been approved, and nothing stops a session writing to .git, the workflow logbook or the files the rulebook locks.',
      '.cursor/hooks.json does not register the workflow\'s beforeSubmitPrompt hook (src/agents/cursor/hooks/user-prompt.mjs), so clicking Build records nothing and no change can leave the open phase, and the operator\'s `record` and `reset` are no longer heard.',
      '.cursor/hooks.json does not register the workflow\'s stop hook (src/agents/cursor/hooks/turn-end.mjs), so the test freeze is off, and nothing runs verify or records that it passed.',
    ]);
    const { stop, ...rest } = own().hooks;
    expect(warnings({ '.cursor/hooks.json': project(rest) })).toEqual([found[2]]);
  });

  it('reports a project file that is not JSON, and every workflow hook as missing', () => {
    const found = warnings({ '.cursor/hooks.json': '{' });
    expect(found[0]).toMatch(/^\.cursor\/hooks\.json is not JSON \(.+\), so Cursor runs none of its hooks and what it would run is not known\.$/);
    expect(found).toHaveLength(4);
  });

  it('reports a changed workflow hook: a narrower matcher, no failClosed, a short timeout, a follow-up cap', () => {
    const hooks = own().hooks;
    const changed = {
      preToolUse: [{ ...hooks.preToolUse[0], matcher: 'Write', failClosed: false }],
      beforeSubmitPrompt: [{ ...hooks.beforeSubmitPrompt[0], timeout: 10 }],
      stop: [{ command: hooks.stop[0].command, loop_limit: 5 }],
    };
    expect(warnings({ '.cursor/hooks.json': project(changed) })).toEqual([
      'the workflow\'s preToolUse hook (src/agents/cursor/hooks/pre-tool.mjs) does not run for Delete or Shell, because its matcher is `Write`. For those tools edits are no longer held until a plan has been approved, and nothing stops a session writing to .git, the workflow logbook or the files the rulebook locks.',
      'the workflow\'s preToolUse hook (src/agents/cursor/hooks/pre-tool.mjs) is registered without `failClosed: true`, so a crash or a timeout of the hook lets the tool call through.',
      'the workflow\'s beforeSubmitPrompt hook (src/agents/cursor/hooks/user-prompt.mjs) has a timeout under 60 seconds, so Cursor may stop it before it answers.',
      'the workflow\'s stop hook (src/agents/cursor/hooks/turn-end.mjs) has a timeout under 900 seconds, so Cursor may stop it before it answers.',
      'the workflow\'s stop hook (src/agents/cursor/hooks/turn-end.mjs) is registered without `loop_limit: null`, so Cursor stops sending its follow-ups after a few, and a report for the operator can be lost.',
    ]);
  });

  it('counts a look-alike command as an extra hook, and the workflow\'s hook as missing', () => {
    const hooks = own().hooks;
    const found = warnings({ '.cursor/hooks.json': project({ ...hooks, stop: [{ ...hooks.stop[0], command: 'node other/src/agents/cursor/hooks/turn-end.mjs' }] }) });
    expect(found[0]).toMatch(/^\.cursor\/hooks\.json does not register the workflow's stop hook/);
    expect(found[1]).toMatch(/^\.cursor\/hooks\.json registers an extra stop hook: `node other\/src\/agents\/cursor\/hooks\/turn-end\.mjs`\. Cursor sends what a stop hook answers/);
  });

  it('reports an extra stop or prompt hook in any hooks file as able to send the approval, and others as outside the gate', () => {
    const found = warnings({
      '.cursor/hooks.json': project({ ...own().hooks, afterFileEdit: [{ command: 'prettier', matcher: 'Write' }] }),
      '~/.cursor/hooks.json': project({ stop: [{ command: 'notify' }], beforeSubmitPrompt: [{ type: 'prompt', prompt: 'check it' }] }),
    });
    expect(found).toEqual([
      '.cursor/hooks.json registers an extra afterFileEdit hook on Write: `prettier`. It runs outside the workflow\'s gate. If it is the operator\'s, they list it under extraHooks.acknowledged in this adapter\'s agent.adapters entry in .katatay/rulebook.json.',
      '~/.cursor/hooks.json registers an extra stop hook: `notify`. Cursor sends what a stop hook answers to the agent as a prompt, and a prompt hook sees every prompt, so it could send or hold back Build\'s approval on the operator\'s behalf. If it is the operator\'s, they list it under extraHooks.acknowledged in this adapter\'s agent.adapters entry in .katatay/rulebook.json.',
      '~/.cursor/hooks.json registers an extra beforeSubmitPrompt hook: `prompt hook`. Cursor sends what a stop hook answers to the agent as a prompt, and a prompt hook sees every prompt, so it could send or hold back Build\'s approval on the operator\'s behalf. If it is the operator\'s, they list it under extraHooks.acknowledged in this adapter\'s agent.adapters entry in .katatay/rulebook.json.',
    ]);
  });

  it('leaves out acknowledged extra hooks, and every extra hook when the check is off', () => {
    const files = { '.cursor/hooks.json': JSON.stringify(own()), '~/.cursor/hooks.json': project({ stop: [{ command: 'notify' }], afterShellExecution: [{ command: 'log', matcher: 'git' }] }) };
    expect(warnings(files, { extraHooks: { acknowledged: [{ event: 'stop', command: 'notify' }, { event: 'afterShellExecution', matcher: 'git', command: 'log' }] } })).toEqual([]);
    expect(warnings(files, { extraHooks: { acknowledged: [{ event: 'stop', matcher: 'x', command: 'notify' }, { event: 'afterShellExecution', command: 'log' }] } })).toHaveLength(2);
    expect(warnings(files, { extraHooks: null })).toEqual([]);
  });

  it('reports the rule file missing, and skips hooks values that are not lists of objects', () => {
    expect(warnings({ '.cursor/hooks.json': JSON.stringify({ ...own(), hooks: { ...own().hooks, sessionStart: 'x', stop: [null, ...own().hooks.stop] } }) }, { instructions: false }))
      .toEqual(['.cursor/rules/workflow.mdc is missing, so Cursor starts each chat without the workflow\'s instructions. Install them with the Cursor adapter\'s install command, as init does.']);
    expect(warnings({ '~/.cursor/hooks.json': JSON.stringify({ hooks: [] }) })).toEqual([]);
  });

  it('reads matchers as Cursor does, and knows each platform\'s enterprise file', () => {
    for (const matcher of [undefined, null, '', '*', 'Write|Delete', 'Wri']) expect(covers(matcher, 'Write'), String(matcher)).toBe(true);
    expect(covers('Shell', 'Write')).toBe(false);
    expect(covers('(', 'Write')).toBe(false);
    expect(ENTERPRISE_FILES).toEqual({ darwin: '/Library/Application Support/Cursor/hooks.json', linux: '/etc/cursor/hooks.json', win32: 'C:\\ProgramData\\Cursor\\hooks.json' });
  });
});

describe('cases the mutation run found', () => {
  const ownHooks = () => own().hooks;

  it('reads a hooks file holding null, no hooks or a non-object entry without warning or throwing', () => {
    for (const text of ['null', '{"hooks":null}', '{"hooks":{"stop":[3]}}']) {
      expect(warnings({ '.cursor/hooks.json': JSON.stringify(own()), '~/.cursor/hooks.json': text }), text).toEqual([]);
    }
  });

  it('counts the workflow\'s command only under its own event, and anywhere else as extra', () => {
    const { preToolUse, ...rest } = ownHooks();
    const found = warnings({ '.cursor/hooks.json': project({ ...rest, beforeSubmitPrompt: [...rest.beforeSubmitPrompt, preToolUse[0]] }) });
    expect(found[0]).toMatch(/^\.cursor\/hooks\.json does not register the workflow's preToolUse hook/);
    expect(found[1]).toMatch(/^\.cursor\/hooks\.json registers an extra beforeSubmitPrompt hook on Write\|Delete\|Shell: `node src\/agents\/cursor\/hooks\/pre-tool\.mjs`/);
    expect(found).toHaveLength(2);
  });

  it('reports the workflow\'s own command in the user\'s file as extra', () => {
    const found = warnings({ '.cursor/hooks.json': JSON.stringify(own()), '~/.cursor/hooks.json': project({ stop: ownHooks().stop }) });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^~\/\.cursor\/hooks\.json registers an extra stop hook: `node src\/agents\/cursor\/hooks\/turn-end\.mjs`/);
  });

  it('finds nothing wrong when one of two registrations of a workflow hook is right', () => {
    const hooks = ownHooks();
    const twice = {
      preToolUse: [{ ...hooks.preToolUse[0], matcher: 'Write', failClosed: false }, hooks.preToolUse[0]],
      beforeSubmitPrompt: hooks.beforeSubmitPrompt,
      stop: [{ ...hooks.stop[0], timeout: 10, loop_limit: 5 }, hooks.stop[0]],
    };
    expect(warnings({ '.cursor/hooks.json': project(twice) })).toEqual([]);
  });

  it('reports a user file that is not JSON once, without the project\'s missing-hook warnings', () => {
    const found = warnings({ '.cursor/hooks.json': JSON.stringify(own()), '~/.cursor/hooks.json': '{' });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^~\/\.cursor\/hooks\.json is not JSON/);
  });

  it('matches an acknowledgement on its event and its command too', () => {
    const files = { '.cursor/hooks.json': JSON.stringify(own()), '~/.cursor/hooks.json': project({ stop: [{ command: 'notify' }] }) };
    for (const known of [{ event: 'beforeSubmitPrompt', command: 'notify' }, { event: 'stop', command: 'other' }]) {
      expect(warnings(files, { extraHooks: { acknowledged: [known] } }), JSON.stringify(known)).toHaveLength(1);
    }
  });
});
