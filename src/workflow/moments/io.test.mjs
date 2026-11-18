/**
 * The input a write moment accepts, checked in process. `io.process.test.mjs`
 * starts a moment as a command, the way an agent adapter does.
 */
import { describe, expect, it } from 'vitest';

describe('the list of files a write names', () => {
  const problems = async (writes) => (await import('./io.mjs')).shapeProblems({ writes }, { writes: 'list of { path, delete }' });

  it('takes an empty list, and files each with a path and a delete flag', async () => {
    expect(await problems([])).toEqual([]);
    expect(await problems([{ path: 'a.ts', delete: false }, { path: '/b', delete: true }])).toEqual([]);
  });

  // A file with no name, or no word on whether it is removed, is an adapter
  // bug, and a guess at it could read a delete as a write.
  it('refuses anything else, and says what it got', async () => {
    for (const writes of [undefined, null, 'a.ts', [null], [{ path: 'a.ts' }], [{ path: '', delete: false }], [{ path: 3, delete: false }], [{ path: 'a', delete: 'no' }]]) {
      const [said] = await problems(writes);
      expect(said, JSON.stringify(writes)).toMatch(/^`writes` must be list of \{ path, delete \}, and is /);
    }
  });
});
