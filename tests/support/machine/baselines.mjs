/** What the baseline cases share: reading the logbook, writing files, and a server
 *  that answers or does not. They were one file, `baseline.test.mjs`, until it
 *  was split by cost (see `harness.mjs`), and all three parts need these. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ctx, events, git, publish } from './harness.mjs';

export const read = (name) => JSON.parse(readFileSync(join(ctx.logbook, name), 'utf8'));
export const eventNamed = (kind) => events().filter((e) => e.endsWith(`__${kind}.json`));
export const head = () => git('rev-parse', 'HEAD').trim();
export const write = (file, body) => {
  mkdirSync(join(ctx.repo, file, '..'), { recursive: true });
  writeFileSync(join(ctx.repo, file), body);
};

/** The server unreachable: the remote points somewhere nothing answers. */
export const serverDown = () => git('remote', 'set-url', 'origin', join(ctx.repo, '.no-such-server'));
export const serverUp = () => git('remote', 'set-url', 'origin', ctx.remote);

/**
 * Work merged into the target by someone else, while this branch was open: a
 * test added on a branch of its own, pushed to the server's `main`.
 */
export const targetGainsATest = () => {
  const base = head();
  git('checkout', '--quiet', '-b', 'elsewhere', 'origin/main');
  write('elsewhere.test.mjs', 'it("elsewhere", () => {});\n');
  git('add', 'elsewhere.test.mjs');
  git('commit', '--quiet', '-m', 'someone else\'s change');
  publish();
  git('checkout', '--quiet', 'feat/x');
  return base;
};
