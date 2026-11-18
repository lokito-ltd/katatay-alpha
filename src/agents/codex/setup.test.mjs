import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_DOC_MAX_BYTES, covers, docSizeWarnings, setupWarnings } from './setup.mjs';
import { EXPECTED, commandFor } from './registration.mjs';
import { payload } from '../../../tests/fixtures/codex/payloads.mjs';

const root = '/repo';
const paths = { home: '/home/op', repo: root };
const captured = payload('app-server-hooks-list', {}, paths);
const config = payload('app-server-config-read', {}, paths);
const template = captured.data[0].hooks[0];
const camel = (event) => event.charAt(0).toLowerCase() + event.slice(1);

/**
 * The workflow's own three hooks as `hooks/list` reports them once registered
 * and trusted: the captured entry's shape, with the workflow's command,
 * event and matcher in it.
 */
const own = (changes = {}) => EXPECTED.map((expected) => ({
  ...template,
  eventName: camel(expected.event),
  matcher: expected.matcher.length > 0 ? expected.matcher.join('|') : null,
  command: commandFor(expected.script),
  ...(changes[expected.event] ?? {}),
}));
const listing = (hooks, extra = {}) => ({ data: [{ ...captured.data[0], hooks, ...extra }] });
const warnings = (where) => setupWarnings({ root, hooksList: listing(own()), config, extraHooks: { acknowledged: [] }, instructions: true, ...where });

describe('a matcher', () => {
  it('covers every tool when it is empty, missing or a star', () => {
    for (const matcher of [null, undefined, '', '*']) expect(covers(matcher, 'Bash')).toBe(true);
  });

  it('covers the tools its expression names, whole', () => {
    expect(covers('apply_patch|Bash', 'Bash')).toBe(true);
    expect(covers('apply_patch', 'Bash')).toBe(false);
    expect(covers('Bas', 'Bash')).toBe(false);
  });

  it('covers nothing when it is not a valid expression', () => {
    expect(covers('(', 'Bash')).toBe(false);
  });
});

describe('Codex\'s setup', () => {
  it('has nothing wrong when the three hooks are registered, enabled and trusted', () => {
    expect(warnings({})).toEqual([]);
  });

  // The capture registered six hooks of its own, none the workflow's.
  it('names each workflow hook the captured project does not register, and what stops working', () => {
    const said = warnings({ hooksList: captured, extraHooks: null });
    expect(said).toHaveLength(3);
    for (const expected of EXPECTED) expect(said.some((w) => w.includes(expected.script) && w.includes(expected.consequence))).toBe(true);
  });

  it('names a hook that is disabled', () => {
    expect(warnings({ hooksList: listing(own({ Stop: { enabled: false } })) })).toEqual([expect.stringMatching(/Stop hook .* is disabled/)]);
  });

  it('names a hook that is not trusted, or changed after it was', () => {
    expect(warnings({ hooksList: listing(own({ PreToolUse: { trustStatus: 'untrusted' } })) })).toEqual([expect.stringMatching(/has not been trusted/)]);
    expect(warnings({ hooksList: listing(own({ UserPromptSubmit: { trustStatus: 'modified' } })) })).toEqual([expect.stringMatching(/changed after it was trusted/)]);
  });

  it('accepts a hook the organisation manages', () => {
    expect(warnings({ hooksList: listing(own({ Stop: { trustStatus: 'managed', isManaged: true, source: 'mdm', sourcePath: '/etc/codex/hooks.json' } })) })).toEqual([]);
  });

  it('names a tool the gate no longer runs for', () => {
    expect(warnings({ hooksList: listing(own({ PreToolUse: { matcher: 'apply_patch' } })) })).toEqual([expect.stringMatching(/does not run for Bash/)]);
  });

  // The user layer is where a hook nobody reviews would be added.
  it('counts the workflow\'s command in the user layer as extra', () => {
    const copy = { ...own()[2], source: 'user', sourcePath: '/home/op/.codex/hooks.json' };
    const said = warnings({ hooksList: listing([...own(), copy]) });
    expect(said).toEqual([expect.stringMatching(/\/home\/op\/\.codex\/hooks\.json \(user\) registers an extra Stop hook/)]);
  });

  it('names an extra hook from any layer, unless the operator acknowledged it', () => {
    const extra = { ...template, source: 'plugin', sourcePath: '/plugins/p/hooks/hooks.json', eventName: 'preToolUse', matcher: 'Bash', command: 'rtk hook codex' };
    expect(warnings({ hooksList: listing([...own(), extra]) })).toEqual([expect.stringMatching(/\(plugin\) registers an extra PreToolUse hook on Bash: `rtk hook codex`\. It runs outside/)]);
    expect(warnings({ hooksList: listing([...own(), extra]) })[0]).toContain("If it is the operator's, they list it under extraHooks.acknowledged in this adapter's agent.adapters entry in .katatay/rulebook.json.");
    expect(warnings({ hooksList: listing([...own(), extra]), extraHooks: { acknowledged: [{ event: 'PreToolUse', matcher: 'Bash', command: 'rtk hook codex' }] } })).toEqual([]);
  });

  // A Stop hook's block reason is sent as a prompt, and the approval is a prompt.
  it('says an extra Stop or prompt hook could send the approval', () => {
    const extra = { ...template, source: 'user', sourcePath: '/home/op/.codex/hooks.json', eventName: 'stop', matcher: null, command: 'node mine.mjs' };
    expect(warnings({ hooksList: listing([...own(), extra]) })[0]).toMatch(/could send the plan approval text/);
  });

  it('lists no extra hook when the rulebook switches that check off, and still names missing ones', () => {
    expect(warnings({ hooksList: captured, extraHooks: null }).every((w) => !w.includes('extra'))).toBe(true);
    const extra = warnings({ hooksList: captured }).filter((w) => w.includes('extra'));
    expect(extra).toHaveLength(1);
    expect(extra[0]).toContain('/repo/.codex/hooks.json (project) has 6 extra hook registrations for `node /repo/capture.mjs`');
    expect(extra[0]).toContain("Can affect plan approval: UserPromptSubmit, Stop.\n  - Outside the workflow's gate: PreToolUse on *, PermissionRequest on *, PostToolUse on *, SessionStart.");
    expect(extra[0]).toContain('could send the plan approval text');
  });

  it('names hooks switched off in the settings', () => {
    const off = { ...config, config: { ...config.config, features: { ...config.config.features, hooks: false } } };
    expect(warnings({ config: off })).toEqual([expect.stringMatching(/\[features\] hooks = false/)]);
  });

  it('names allow_managed_hooks_only, unless the workflow\'s hooks are the managed ones', () => {
    const managedOnly = { ...config, config: { ...config.config, allow_managed_hooks_only: true } };
    expect(warnings({ config: managedOnly })).toEqual([expect.stringMatching(/allow_managed_hooks_only/)]);
    const managed = own(Object.fromEntries(EXPECTED.map(({ event }) => [event, { isManaged: true, trustStatus: 'managed' }])));
    expect(warnings({ config: managedOnly, hooksList: listing(managed) })).toEqual([]);
  });

  it('passes on what Codex itself reports about its hooks', () => {
    const said = warnings({ hooksList: listing(own(), { warnings: ['both hooks.json and [hooks] in one layer'], errors: [{ path: '/x/hooks.json', message: 'bad JSON' }] }) });
    expect(said).toEqual(['Codex reports about its hooks: both hooks.json and [hooks] in one layer', 'Codex could not load hooks from /x/hooks.json: bad JSON']);
  });

  it('names the instructions file when it is missing', () => {
    expect(warnings({ instructions: false })).toEqual([expect.stringMatching(/^AGENTS\.md is missing/)]);
  });

  // Silence would read as a setup with nothing wrong.
  it('says nothing is known when Codex could not be asked', () => {
    const said = warnings({ hooksList: 'codex could not be started', config: 'codex could not be started' });
    expect(said).toEqual([expect.stringMatching(/settings could not be read/), expect.stringMatching(/could not be asked about its hooks \(codex could not be started\)/)]);
  });

  it('says nothing is known when Codex lists nothing for the repository', () => {
    expect(warnings({ hooksList: { data: [] } })).toEqual([expect.stringMatching(/with nothing for this repository/)]);
  });

  it('reads the entry for this repository when Codex lists several', () => {
    const other = { cwd: '/other', hooks: [], warnings: [], errors: [] };
    expect(warnings({ hooksList: { data: [other, { ...captured.data[0], cwd: root, hooks: own() }] } })).toEqual([]);
  });
});

describe('which hooks are the workflow\'s own', () => {
  const project = (changes) => ({ ...own()[0], ...changes });

  // Only the project's own file registers them. A copy in another project
  // file, or the right file running another command, is extra.
  it('counts a hook in another project file, or with another command, as extra', () => {
    for (const changes of [{ sourcePath: '/repo/sub/.codex/hooks.json' }, { command: 'node other.mjs' }]) {
      const said = warnings({ hooksList: listing([project(changes), ...own().slice(1)]) });
      expect(said).toEqual([expect.stringMatching(/does not register the workflow's PreToolUse hook/), expect.stringMatching(/registers an extra PreToolUse hook/)]);
    }
  });

  it('counts the gate\'s command registered under another event as extra', () => {
    const said = warnings({ hooksList: listing([project({ eventName: 'stop' }), ...own().slice(1)]) });
    expect(said).toEqual([expect.stringMatching(/does not register the workflow's PreToolUse hook/), expect.stringMatching(/registers an extra Stop hook/)]);
  });

  it('treats a user registration with the exact project path and command as extra', () => {
    const [gate, ...rest] = own();
    const said = warnings({ hooksList: listing([{ ...gate, source: 'user', isManaged: false }, ...rest]) });
    expect(said).toEqual([
      expect.stringContaining("does not register the workflow's PreToolUse"),
      expect.stringContaining(`${gate.sourcePath} (user) registers an extra PreToolUse`),
    ]);
  });

  it('skips a null listing entry before selecting the requested checkout', () => {
    expect(warnings({ hooksList: { data: [null, ...listing(own()).data] } })).toEqual([]);
  });

  it('compares only the project file Codex actually loaded from the main checkout', () => {
    const mainCheckout = mkdtempSync(join(tmpdir(), 'setup-main-'));
    try {
      const checkout = join(mainCheckout, 'linked');
      const mainFile = join(mainCheckout, '.codex/hooks.json');
      const worktreeFile = join(checkout, '.codex/hooks.json');
      mkdirSync(join(mainCheckout, '.codex'));
      mkdirSync(join(checkout, '.codex'), { recursive: true });
      writeFileSync(mainFile, '{"enabled":true,"hooks":{}}');
      const from = (sourcePath, source = 'project') => own().map(h => ({ ...h, source, sourcePath }));
      const check = hooks => warnings({ root: checkout, mainCheckout, hooksList: { data: [{ cwd: checkout, hooks }] } });

      // The worktree's copy can be missing. Its absence only matters when the main file is loaded.
      expect(check(from(worktreeFile))).toEqual([]);
      expect(check(from(mainFile, 'user')).some(text => text.includes('Could not compare'))).toBe(false);
      expect(check(from(mainFile))).toEqual([expect.stringContaining(`Could not compare it with ${worktreeFile}`)]);

      writeFileSync(worktreeFile, '{"hooks": {}, "enabled": true}');
      expect(check(from(mainFile))).toEqual([]);
      writeFileSync(worktreeFile, '{"enabled":false,"hooks":{}}');
      expect(check(from(mainFile))).toEqual([expect.stringContaining(`${worktreeFile} differs`)]);
      const plugin = { ...own()[0], source: 'plugin', sourcePath: '/plugin/hooks.json' };
      expect(check([...from(mainFile), plugin])).toEqual([
        `Codex loaded project hooks from ${mainFile}, the main checkout’s registration. The worktree registration at ${worktreeFile} differs.`,
        expect.stringContaining('/plugin/hooks.json (plugin) registers an extra PreToolUse'),
      ]);
      expect(check(from(mainFile).map(h => ({ ...h, trustStatus: 'modified' })))).toEqual([
        expect.stringContaining('differs'), ...Array(3).fill(expect.stringContaining('changed after it was trusted')),
      ]);
    } finally {
      rmSync(mainCheckout, { recursive: true, force: true });
    }
  });

  // Several registrations of one hook are fine while one of them runs.
  it('is content with one enabled, trusted registration among several', () => {
    const [gate, ...rest] = own();
    const disabled = { ...gate, enabled: false };
    const untrusted = { ...gate, trustStatus: 'untrusted' };
    expect(warnings({ hooksList: listing([disabled, gate, ...rest]) })).toEqual([]);
    expect(warnings({ hooksList: listing([untrusted, gate, ...rest]) })).toEqual([]);
  });

  it('is content when two registrations cover the gate\'s two tools between them', () => {
    const [gate, ...rest] = own();
    expect(warnings({ hooksList: listing([{ ...gate, matcher: 'apply_patch' }, { ...gate, matcher: 'Bash' }, ...rest]) })).toEqual([]);
  });

  it('names the matcher of the registration that runs', () => {
    const [gate, ...rest] = own();
    expect(warnings({ hooksList: listing([{ ...gate, matcher: 'Bash' }, ...rest]) })).toEqual([expect.stringMatching(/does not run for apply_patch, because its matcher is `Bash`/)]);
  });
});

describe('acknowledging an extra hook', () => {
  const extra = (changes = {}) => ({ ...template, source: 'user', sourcePath: '/home/op/.codex/hooks.json', eventName: 'preToolUse', matcher: 'Bash', command: 'rtk hook codex', ...changes });
  const ack = (known) => warnings({ hooksList: listing([...own(), extra()]), extraHooks: { acknowledged: [known] } });

  it('keeps the same command separate by source file, layer and arguments', () => {
    const said = warnings({ hooksList: listing([...own(), extra(), extra({ sourcePath: '/other/hooks.json' }),
      extra({ source: 'plugin' }), extra({ command: 'rtk hook codex --quiet' })]) });
    expect(said).toEqual([
      expect.stringContaining('/home/op/.codex/hooks.json (user) registers an extra PreToolUse hook on Bash: `rtk hook codex`'),
      expect.stringContaining('/other/hooks.json (user) registers an extra PreToolUse hook on Bash: `rtk hook codex`'),
      expect.stringContaining('/home/op/.codex/hooks.json (plugin) registers an extra PreToolUse hook on Bash: `rtk hook codex`'),
      expect.stringContaining('/home/op/.codex/hooks.json (user) registers an extra PreToolUse hook on Bash: `rtk hook codex --quiet`'),
    ]);
  });

  // The event, the matcher and the command must all match, or a hook could
  // ride in under another's acknowledgement.
  it('takes the event, the matcher and the command together', () => {
    expect(ack({ event: 'PreToolUse', matcher: 'Bash', command: 'rtk hook codex' })).toEqual([]);
    expect(ack({ event: 'Stop', matcher: 'Bash', command: 'rtk hook codex' })).toHaveLength(1);
    expect(ack({ event: 'PreToolUse', matcher: 'apply_patch', command: 'rtk hook codex' })).toHaveLength(1);
    expect(ack({ event: 'PreToolUse', matcher: 'Bash', command: 'rtk hook' })).toHaveLength(1);
  });

  it('reads a missing matcher as the empty one, on both sides', () => {
    const hooksList = listing([...own(), extra({ matcher: null })]);
    expect(warnings({ hooksList, extraHooks: { acknowledged: [{ event: 'PreToolUse', command: 'rtk hook codex' }] } })).toEqual([]);
    expect(warnings({ hooksList, extraHooks: { acknowledged: [{ event: 'PreToolUse', matcher: 'Bash', command: 'rtk hook codex' }] } })).toHaveLength(1);
  });

  it('names a hook with no matcher without one, and a handler with no command by its kind', () => {
    expect(warnings({ hooksList: listing([...own(), extra({ matcher: null })]) })[0]).toMatch(/an extra PreToolUse hook: `rtk hook codex`/);
    expect(warnings({ hooksList: listing([...own(), extra({ command: undefined, handlerType: 'mcpTool' })]) })[0]).toMatch(/`mcpTool handler`/);
    expect(warnings({ hooksList: listing([...own(), extra({ command: undefined, handlerType: undefined })]) })[0]).toMatch(/`unknown handler`/);
  });

  it('acknowledges nothing when the rulebook\'s section lists nothing', () => {
    expect(warnings({ hooksList: listing([...own(), extra()]), extraHooks: {} })).toHaveLength(1);
  });

  it('names the file and the layer the hook came from', () => {
    expect(warnings({ hooksList: listing([...own(), extra()]) })[0].startsWith('/home/op/.codex/hooks.json (user) registers')).toBe(true);
  });
});

describe('answers of an unexpected shape', () => {
  it('reads settings with no config as default ones', () => {
    expect(warnings({ config: {} })).toEqual([]);
    expect(warnings({ config: null })).toEqual([]);
  });

  it('reads a hook list with no list in it as nothing for this repository', () => {
    expect(warnings({ hooksList: {} })).toEqual([expect.stringMatching(/with nothing for this repository/)]);
    expect(warnings({ hooksList: { data: 'x' } })).toEqual([expect.stringMatching(/with nothing for this repository/)]);
  });

  it('skips entries that are not hooks, and reads an entry with no hooks as none', () => {
    expect(warnings({ hooksList: listing([null, 'x', ...own()]) })).toEqual([]);
    expect(warnings({ hooksList: listing(undefined) })).toHaveLength(3);
  });

  it('names an error with nothing in it as best it can', () => {
    expect(warnings({ hooksList: listing(own(), { errors: [{}] }) })).toEqual(['Codex could not load hooks from a file: no reason given']);
  });

  // One managed hook is not enough: the other two still do not run.
  it('names allow_managed_hooks_only while any workflow hook is not managed', () => {
    const managedOnly = { ...config, config: { ...config.config, allow_managed_hooks_only: true } };
    const oneManaged = own({ Stop: { isManaged: true, trustStatus: 'managed' } });
    expect(warnings({ config: managedOnly, hooksList: listing(oneManaged) })).toEqual([expect.stringMatching(/allow_managed_hooks_only/)]);
  });
});

describe('the size of the AGENTS.md files Codex loads together', () => {
  const big = DEFAULT_DOC_MAX_BYTES + 100;

  it('warns when the root file is over the default limit, naming size, limit and overflow', () => {
    expect(docSizeWarnings([{ path: 'AGENTS.md', bytes: big }], undefined)).toEqual([
      `\`AGENTS.md\` is ${big} bytes, over Codex's \`project_doc_max_bytes\` of 32768. Codex reads only the first 32768 bytes, so it misses the last 100 bytes of its instructions, the workflow's included. `
        + `Raise \`project_doc_max_bytes\` in \`~/.codex/config.toml\` to at least ${big}, then restart Codex.`,
    ]);
  });

  it('says nothing when the files fit, exactly at the limit included', () => {
    expect(docSizeWarnings([{ path: 'AGENTS.md', bytes: DEFAULT_DOC_MAX_BYTES }], undefined)).toEqual([]);
    expect(docSizeWarnings([], undefined)).toEqual([]);
  });

  it('measures against a raised project_doc_max_bytes', () => {
    expect(docSizeWarnings([{ path: 'AGENTS.md', bytes: big }], 65536)).toEqual([]);
    expect(docSizeWarnings([{ path: 'AGENTS.md', bytes: 2000 }], 1000)).toEqual([expect.stringContaining('of 1000. Codex reads only the first 1000 bytes')]);
  });

  it.each([[null], ['65536'], [0], [-1], [1.5]])('falls back to 32768 for a limit of %j', (limit) => {
    expect(docSizeWarnings([{ path: 'AGENTS.md', bytes: big }], limit)).toEqual([expect.stringContaining('of 32768.')]);
  });

  it('adds a nested file to the ones above it, root first, and warns for that folder only', () => {
    const files = [
      { path: 'app/x/AGENTS.md', bytes: 3000 },
      { path: 'AGENTS.md', bytes: 30000 },
      { path: 'app/AGENTS.md', bytes: 100 },
      { path: 'docs/AGENTS.md', bytes: 100 },
      { path: 'apple/AGENTS.md', bytes: 100 },
    ];
    expect(docSizeWarnings(files, undefined)).toEqual([
      expect.stringMatching(/^The AGENTS\.md files Codex loads together in `app\/x\/` \(`AGENTS\.md`, `app\/AGENTS\.md`, `app\/x\/AGENTS\.md`\) come to 33100 bytes/),
    ]);
  });

  it('is part of the setup warnings, measured against the settings Codex reads', () => {
    const docs = [{ path: 'AGENTS.md', bytes: big }];
    expect(warnings({ docs })).toEqual([expect.stringMatching(/^`AGENTS\.md` is \d+ bytes, over/)]);
    expect(warnings({ docs, config: { config: { ...config.config, project_doc_max_bytes: big } } })).toEqual([]);
    // Unread settings give no limit to measure against, so the warning says
    // the limit is unknown rather than claiming the default is in force.
    expect(warnings({ docs, config: 'codex could not be started', hooksList: listing(own()) })).toEqual([
      expect.stringMatching(/settings could not be read/),
      expect.stringMatching(/over Codex's default `project_doc_max_bytes` of 32768\. Codex's settings could not be read, so the limit it uses is not known\./),
    ]);
  });

  it('says the limit is unknown when the settings could not be read, whatever limit it was given', () => {
    expect(docSizeWarnings([{ path: 'AGENTS.md', bytes: big }], 65536, { known: false })).toEqual([
      `\`AGENTS.md\` is ${big} bytes, over Codex's default \`project_doc_max_bytes\` of 32768. Codex's settings could not be read, so the limit it uses is not known. `
        + `If it is the default, Codex misses the last 100 bytes of its instructions, the workflow's included. `
        + `Check that \`project_doc_max_bytes\` in \`~/.codex/config.toml\` is at least ${big}.`,
    ]);
    expect(docSizeWarnings([{ path: 'AGENTS.md', bytes: DEFAULT_DOC_MAX_BYTES }], undefined, { known: false })).toEqual([]);
  });
});
