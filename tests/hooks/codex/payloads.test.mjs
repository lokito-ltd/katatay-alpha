import { describe, expect, it } from 'vitest';
import { ANSWERS, PAYLOADS, TRANSCRIPTS, payload, transcript } from '../../fixtures/codex/payloads.mjs';

const paths = { home: '/home/op', repo: '/repo' };

describe('the captured Codex fixtures', () => {
  it('load, with every placeholder filled in', () => {
    for (const name of [...PAYLOADS, ...ANSWERS]) expect(JSON.stringify(payload(name, {}, paths))).not.toMatch(/\{\{(HOME|REPO)\}\}/);
    for (const name of TRANSCRIPTS) expect(transcript(name, paths)).not.toMatch(/\{\{(HOME|REPO)\}\}/);
  });

  it('name the event they were captured for', () => {
    for (const name of PAYLOADS) {
      const event = { pre: 'PreToolUse', user: 'UserPromptSubmit', stop: 'Stop' }[name.split('-')[0]];
      expect(payload(name, {}, paths).hook_event_name).toBe(event);
    }
  });

  it('put the repository where the payload names its working directory', () => {
    expect(payload('stop', {}, paths).cwd).toBe('/repo');
    expect(payload('user-prompt-submit-approval', {}, paths).transcript_path.startsWith('/home/op/.codex/sessions/')).toBe(true);
  });

  it('merge an override one level deep', () => {
    const merged = payload('pre-tool-use-bash', { tool_input: { command: 'ls' } }, paths);
    expect(merged.tool_input).toEqual({ command: 'ls' });
    expect(merged.tool_name).toBe('Bash');
  });

  // Every line of a transcript is its own JSON object, as Codex writes them.
  it('keep a transcript as JSON lines', () => {
    for (const name of TRANSCRIPTS) {
      const lines = transcript(name, paths).trim().split('\n');
      expect(lines.length).toBeGreaterThan(1);
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
