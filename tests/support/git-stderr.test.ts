import { describe, expect, it } from 'vitest';
import config from '../../vitest.config';
import { failOnCaught, watchStderr } from './git-stderr';

/**
 * The check that fails a test for leaking git's stderr. It is tried against a
 * stand-in stream: a `fatal:` line written to the real one would be caught by
 * the same check running around this very test.
 */
const stream = () => {
  const written: unknown[] = [];
  const write = (chunk: unknown) => {
    written.push(chunk);
    return true;
  };
  return { written, target: { write: write as NodeJS.WriteStream['write'] } };
};

describe("the watch for git's errors on stderr", () => {
  it("catches git's fatal line", () => {
    const { target } = stream();
    const watch = watchStderr(target);
    target.write("fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.\nUse '--' to separate paths\n");
    expect(watch.stop()).toEqual(["fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree."]);
  });

  it('catches it in bytes as well as in text', () => {
    const { target } = stream();
    const watch = watchStderr(target);
    target.write(Buffer.from('fatal: not a git repository\n'));
    expect(watch.stop()).toEqual(['fatal: not a git repository']);
  });

  it('ignores other output, including the word fatal mid-line', () => {
    const { target } = stream();
    const watch = watchStderr(target);
    target.write('Warning: something React says\nerror: a different tool\nnot fatal: this one\n');
    expect(watch.stop()).toEqual([]);
  });

  it('still passes everything on to the stream', () => {
    const { target, written } = stream();
    const watch = watchStderr(target);
    target.write('fatal: one\n');
    target.write('two\n');
    watch.stop();
    expect(written).toEqual(['fatal: one\n', 'two\n']);
  });

  it('puts the original write back when stopped', () => {
    const { target } = stream();
    const original = target.write;
    watchStderr(target).stop();
    expect(target.write).toBe(original);
  });

  it('fails a test that leaked, and names the line', () => {
    expect(() => failOnCaught(['fatal: not a git repository'])).toThrow(/fatal: not a git repository/);
  });

  it('lets a test that leaked nothing pass', () => {
    expect(() => failOnCaught([])).not.toThrow();
  });

  // The watch does nothing unless the fast project loads it around every test.
  it('runs around every test in the fast project', () => {
    const fast = config.test?.projects?.find(
      (project) => typeof project === 'object' && 'test' in project && project.test?.name === 'fast',
    );
    expect(fast && typeof fast === 'object' && 'test' in fast ? fast.test?.setupFiles : undefined).toContain(
      'tests/support/fail-on-git-stderr.ts',
    );
  });
});
