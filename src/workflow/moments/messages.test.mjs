import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { HARNESS_SCHEMA_VERSION } from '../../schema-version.mjs';
import { AUDIENCES, CODES, VERSION, answer, message } from './messages.mjs';

/** The machine-readable half of the agent contract. */
const contract = JSON.parse(readFileSync(new URL('../../agents/contract.json', import.meta.url), 'utf8'));

// The referee's list and the contract's are two copies of one list. An adapter
// reads the contract, so a code only one of them has is one an adapter could
// not plan for, or one the referee never sends.
describe('the codes', () => {
  it('are the contract\'s codes, in its order', () => {
    expect(CODES).toEqual(contract.schemas.Code.enum);
  });

  it('each have the meaning the contract gives them', () => {
    expect(Object.keys(contract.schemas.Code.meanings)).toEqual(CODES);
  });
});

describe('the audiences and the version', () => {
  it('are the contract\'s', () => {
    expect(AUDIENCES).toEqual(contract.schemas.Audience.enum);
    expect(VERSION).toBe(contract.version);
    expect(VERSION).toBe(contract.schemas.Version.const);
    expect(contract.version).toBe(HARNESS_SCHEMA_VERSION);
    for (const [name, command] of Object.entries(contract.commands)) {
      for (const example of command.examples ?? []) {
        for (const side of ['stdin', 'stdout']) {
          if (side in example) expect(example[side].version, `${name}: ${example.title} ${side}`).toBe(HARNESS_SCHEMA_VERSION);
        }
      }
    }
  });
});

describe('a message', () => {
  it('is its code, its audience under `for`, and its text', () => {
    expect(message('needs_plan', 'agent', 'Present a plan.')).toEqual({ code: 'needs_plan', for: 'agent', text: 'Present a plan.' });
  });

  // A code or audience outside the contract is a bug in the referee. Sent, it
  // would reach an adapter that could only show it as text.
  it('refuses a code or an audience the contract does not have', () => {
    expect(() => message('blocked', 'agent', 'x')).toThrow(/"blocked" is not one of the contract's codes/);
    expect(() => message('stop', 'reviewer', 'x')).toThrow(/"reviewer" is not one of the contract's audiences/);
  });

  // The contract's text has at least one character, and a blank message is
  // something an adapter would show as an empty line.
  it('refuses a message with no text', () => {
    for (const text of ['', '  \n', undefined]) {
      expect(() => message('info', 'agent', text)).toThrow(/a "info" message has no text/);
    }
  });
});

describe('an answer', () => {
  it('owns the version and messages even when the caller supplies both', () => {
    const fields = { messages: ['caller'], allow: false, version: 99 };
    const actual = [message('locked', 'agent', 'Locked.')];
    expect(JSON.stringify(answer(fields, actual))).toBe(JSON.stringify({ version: HARNESS_SCHEMA_VERSION, allow: false, messages: actual }));
  });

  it('is the version first, then the decision, then the messages', () => {
    const said = answer({ allow: false }, [message('locked', 'agent', 'Locked.')]);
    expect(said).toEqual({ version: 1, allow: false, messages: [{ code: 'locked', for: 'agent', text: 'Locked.' }] });
    expect(Object.keys(said)).toEqual(['version', 'allow', 'messages']);
  });

  it('may have no decision, as `on prompt` has none', () => {
    expect(answer({}, [])).toEqual({ version: 1, messages: [] });
  });
});
