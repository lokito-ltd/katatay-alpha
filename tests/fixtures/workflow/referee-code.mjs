/**
 * The referee's own code, read for the scans that no import graph can do: what
 * programs it starts and which tool names it prints (`src/workflow/language-free.test.mjs`),
 * and which agent's words it says (`src/workflow/agent-free.test.mjs`).
 *
 * One walk for both, so the two scans cannot disagree about what the referee
 * is. Its tests are left out, and so are the machine harness and these
 * fixtures, which live under `tests/`: they drive an agent's hooks and a
 * language's tools on purpose. So is `src/adapters/`, and `src/agents/`, which
 * are not the referee.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../../src/', import.meta.url));
const REFEREE = ['workflow', 'evidence', 'requirements'];

/** The code of a file with its comments taken out, so a sentence that explains
 *  why `npm` is not used does not count as using it. */
export const withoutComments = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/ .*$/gm, '');

const modules = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return modules(path);
    return /\.(mjs|ts)$/.test(entry.name) && !/\.test\.(mjs|ts)$/.test(entry.name) ? [path] : [];
  });

/** Every referee file, as a path relative to `src/`. */
export const referee = () => REFEREE.flatMap((tree) => modules(join(SRC, tree))).map((path) => relative(SRC, path));

/** A referee file's code, comments left out. */
export const code = (path) => withoutComments(readFileSync(join(SRC, path), 'utf8'));
