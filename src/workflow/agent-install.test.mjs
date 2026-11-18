/**
 * What `agentInstall` lets through of an install answer's shared files and
 * hook registration: the one locked file `init` writes, and only the one the
 * agent's defaults named.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentInstall } from './agent.mjs';

let root;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-install-')));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const REQUEST = { instructions: '# The workflow\n', skills: [] };
const LOCKED = ['.agent/settings.json'];
const FILES = [{ path: 'AGENT.md', text: 'x', shared: true }];

/** The install answer `answer` prints, as the command line that prints it. */
function printing(answer) {
  writeFileSync(join(root, 'install.mjs'), `process.stdout.write(${JSON.stringify(JSON.stringify(answer))});`);
  return 'node install.mjs';
}
const asked = (answer, registrationFile = '.agent/settings.json') =>
  agentInstall(printing({ version: 1, ...answer }), REQUEST, { root, home: join(root, 'home'), locked: LOCKED, registrationFile });

describe('an install answer\'s shared files and registration', () => {
  it('returns the registration for the file the defaults named, though the agent\'s locks cover it', () => {
    const registration = { path: '.agent/settings.json', text: '{}\n' };
    expect(asked({ files: FILES, registration })).toEqual({ files: FILES, registration });
  });

  it('refuses a registration for another file than the defaults named', () => {
    expect(asked({ files: FILES, registration: { path: '.agent/other.json', text: '{}' } }).none)
      .toContain('its registration is ".agent/other.json", and its defaults named ".agent/settings.json"');
  });

  it('refuses an answer with no registration when the defaults named one', () => {
    expect(asked({ files: FILES }).none).toContain('it answers no "registration", and its defaults named ".agent/settings.json"');
  });

  it('refuses a registration that is not { path, text }', () => {
    for (const registration of [{ path: '.agent/settings.json' }, { path: '', text: '' }, null, 'x']) {
      expect(asked({ files: FILES, registration }).none, JSON.stringify(registration)).toContain('its "registration" is not { path, text }');
    }
  });

  it('refuses a registration the referee\'s own locks cover, whatever the defaults named', () => {
    expect(asked({ files: FILES, registration: { path: '.git/hooks/pre-commit', text: '' } }, '.git/hooks/pre-commit').none).toContain('is locked');
    expect(asked({ files: FILES, registration: { path: '../outside.json', text: '' } }, '../outside.json').none).toContain('leaves the project');
  });

  it('still refuses an instruction file the agent\'s locks cover', () => {
    expect(asked({ files: [{ path: '.agent/settings.json', text: '' }], registration: { path: '.agent/settings.json', text: '' } }).none).toContain('is locked');
  });

  it('refuses a shared mark that is not true or false', () => {
    expect(asked({ files: [{ path: 'AGENT.md', text: 'x', shared: 'yes' }], registration: { path: '.agent/settings.json', text: '' } }).none)
      .toContain('its "files" is not a list of { path, text, shared? }');
  });

  it('passes a registration back to a caller that names no file', () => {
    const registration = { path: 'hooks.json', text: '{}' };
    expect(agentInstall(printing({ version: 1, files: [], registration }), REQUEST, { root })).toEqual({ files: [], registration });
  });
});
