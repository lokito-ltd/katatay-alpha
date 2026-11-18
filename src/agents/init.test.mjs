import { describe, expect, it } from 'vitest';
import { ADAPTERS, WORKFLOW, initArguments } from './init.mjs';

describe('the init launcher', () => {
  it('starts the referee\'s init with every adapter, by absolute path, then the arguments it was given', () => {
    expect(initArguments(['--project', 'p'])).toEqual([
      WORKFLOW, 'init',
      '--agent', `claude=node ${JSON.stringify(ADAPTERS[0][1])}`,
      '--agent', `codex=node ${JSON.stringify(ADAPTERS[1][1])}`,
      '--project', 'p',
    ]);
  });
});
