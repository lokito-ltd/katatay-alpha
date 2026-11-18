import { describe, expect, it } from 'vitest';
import { patchWrites } from './patch.mjs';
import { payload } from '../../../tests/fixtures/codex/payloads.mjs';

const paths = { home: '/home/op', repo: '/repo' };

describe('the files a patch writes', () => {
  it('reads every file header of a captured patch, in order', () => {
    const { tool_input: { command }, cwd } = payload('pre-tool-use-apply-patch', {}, paths);
    expect(patchWrites(command, cwd)).toEqual([
      { path: '/repo/a.txt', delete: false },
      { path: '/repo/b.txt', delete: true },
      { path: '/repo/c.txt', delete: false },
      { path: '/repo/notes.md', delete: true },
    ]);
  });

  it('counts an added file as a write', () => {
    expect(patchWrites('*** Begin Patch\n*** Add File: a.txt\n+one\n*** Add File: b.txt\n+two\n*** End Patch', '/repo'))
      .toEqual([{ path: '/repo/a.txt', delete: false }, { path: '/repo/b.txt', delete: false }]);
  });

  // Moving a requirement out of its folder deletes it there, and the referee
  // refuses a delete under that folder. As an update, the move would get past.
  it('counts the old path of a move as a delete', () => {
    const writes = patchWrites('*** Update File: requirements/AC0001.md\n*** Move to: elsewhere/AC0001.md\n@@\n', '/repo');
    expect(writes).toEqual([{ path: '/repo/requirements/AC0001.md', delete: true }, { path: '/repo/elsewhere/AC0001.md', delete: false }]);
  });

  it('resolves relative paths against the directory Codex gave, and keeps absolute ones', () => {
    expect(patchWrites('*** Update File: ../x.txt\n*** Delete File: /tmp/y.txt', '/repo/sub'))
      .toEqual([{ path: '/repo/x.txt', delete: false }, { path: '/tmp/y.txt', delete: true }]);
  });

  it('reads Windows line endings too', () => {
    expect(patchWrites('*** Begin Patch\r\n*** Add File: a.txt\r\n+one\r\n*** End Patch', '/repo')).toEqual([{ path: '/repo/a.txt', delete: false }]);
  });

  // The caller denies a patch that names no file.
  it('names nothing for a patch with no file header', () => {
    expect(patchWrites('*** Begin Patch\n@@\n-a\n+b\n*** End Patch', '/repo')).toEqual([]);
    expect(patchWrites('', '/repo')).toEqual([]);
  });

  // A hunk line that only looks like a header is content, so it starts with
  // `+`, `-` or a space, and is not read as a file.
  it('does not read a header inside a hunk', () => {
    expect(patchWrites('*** Update File: a.md\n@@\n+*** Delete File: b.md', '/repo')).toEqual([{ path: '/repo/a.md', delete: false }]);
  });

  it('ignores a move with no file before it', () => {
    expect(patchWrites('*** Move to: c.txt', '/repo')).toEqual([{ path: '/repo/c.txt', delete: false }]);
  });
});

describe('a header with space after the path', () => {
  it('names the file without the space', () => {
    expect(patchWrites('*** Add File: a.txt  \n+one', '/repo')).toEqual([{ path: '/repo/a.txt', delete: false }]);
  });
});
