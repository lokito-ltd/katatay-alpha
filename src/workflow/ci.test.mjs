import { describe, expect, it } from 'vitest';
import { inCi } from './ci.mjs';

describe('whether the referee runs as a CI job', () => {
  it('is CI only when CI is exactly true', () => {
    expect(inCi({ CI: 'true' })).toBe(true);
  });

  // A mistyped value must never switch a check off or loosen the guard.
  it('is local when CI is unset, empty, false, or any other value', () => {
    for (const env of [{}, { CI: undefined }, { CI: '' }, { CI: 'false' }, { CI: '0' }, { CI: '1' }, { CI: 'yes' }, { CI: 'TRUE' }, { CI: ' true' }]) {
      expect(inCi(env), JSON.stringify(env)).toBe(false);
    }
  });

  it('reads this process\'s environment when given none', () => {
    const saved = process.env.CI;
    try {
      process.env.CI = 'true';
      expect(inCi()).toBe(true);
      delete process.env.CI;
      expect(inCi()).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.CI;
      else process.env.CI = saved;
    }
  });
});
