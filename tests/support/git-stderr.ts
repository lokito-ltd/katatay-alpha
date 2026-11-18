/**
 * Catches git's `fatal:` lines on stderr, so a test that leaks one fails.
 *
 * Git prints `fatal:` whenever a command fails, and many failures in the tools
 * are ordinary answers that the code catches on purpose. When the call lets
 * git's stderr through, the line is printed anyway. One such leak put
 * `fatal: ambiguous argument 'HEAD'` at the top of every triage, and it was
 * found by reading triage output, because only one code path had a test
 * watching stderr. `fail-on-git-stderr.ts` runs this around every test in the
 * `fast` project instead.
 *
 * Only `fatal:` counts. Git also prints `error:` and `warning:`, but so do
 * other tools, and a check that fired on React's warnings would be turned off
 * rather than read. `fatal:` is git's, and it is what leaked.
 *
 * It watches `write` on the stream. Node passes a child's copied stderr
 * through `process.stderr.write`, which is exactly the leak this is for. A
 * child started with `stdio: 'inherit'` writes to the terminal directly and is
 * not seen.
 */

const FATAL = /^fatal: .*$/gm;

type Write = NodeJS.WriteStream['write'];

/**
 * Starts watching `stream`. Everything written still reaches it. `stop` puts
 * the original `write` back and returns the `fatal:` lines seen meanwhile.
 */
export function watchStderr(stream: { write: Write } = process.stderr): { stop: () => string[] } {
  const original = stream.write;
  const caught: string[] = [];
  stream.write = function (this: unknown, chunk: unknown, ...rest: unknown[]) {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
    caught.push(...(text.match(FATAL) ?? []));
    return (original as (...args: unknown[]) => boolean).call(this, chunk, ...rest);
  } as Write;
  return {
    stop: () => {
      stream.write = original;
      return caught;
    },
  };
}

/** Throws when anything was caught, naming what and where to look. */
export function failOnCaught(caught: string[]): void {
  if (caught.length === 0) return;
  throw new Error(
    `This test wrote git's error output to stderr:\n\n${caught.join('\n')}\n\n` +
      'A git call let its stderr through. Under src/workflow/, run git through git.mjs, ' +
      'which keeps that text inside the thrown error instead of printing it.',
  );
}
