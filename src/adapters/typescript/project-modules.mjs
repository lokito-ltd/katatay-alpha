/**
 * Loads the packages the adapter drives, Stryker and TypeScript, from the
 * project it runs in, and not from Katatay's own folder.
 *
 * Node resolves an import from the folder of the file that makes it. Installed
 * globally, that folder is the global one, where these packages are missing.
 * And the project's own versions are the ones that must run: its Stryker with
 * its Vitest, its TypeScript reading its tests. So each is looked up as the
 * project would look it up, from `package.json` in the current directory,
 * where the referee runs the project's commands.
 *
 * `.mjs` so the `.mjs` programs Stryker loads and the reporter can share it,
 * in this repository and once packed.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** `require` as the project in `cwd` would call it. */
export const projectRequire = (cwd = process.cwd()) => createRequire(join(cwd, 'package.json'));

/** Where the project in `cwd` finds `name`, or a clear error when it has none. */
function resolveFromProject(name, cwd) {
  try {
    return projectRequire(cwd).resolve(name);
  } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND') throw error;
    throw new Error(`${name} is not installed in the project at ${cwd}. The TypeScript adapter uses the project's own copy.`);
  }
}

/**
 * An ES module package, as the project in `cwd` has it. Resolved the way
 * `require` resolves, then loaded with `import`, so a package with top-level
 * await loads too, and no Node version warns about `require` of ESM.
 */
export async function importFromProject(name, cwd = process.cwd()) {
  return import(pathToFileURL(resolveFromProject(name, cwd)).href);
}

/** Tried in this order: an alias for TypeScript 6 first, then the plain name. */
const TYPESCRIPT = ['typescript-api', 'typescript'];

/**
 * The TypeScript compiler API, as the project in `cwd` has it: `typescript-api`
 * first, a name a project gives TypeScript 6 when it also has TypeScript 7,
 * then `typescript`. TypeScript 7 has no JavaScript API, its `typescript` is
 * a version number and nothing else, so a module without `createSourceFile`
 * does not count. Returns the module, the name it was found under and its
 * version.
 */
export function typescriptFromProject(cwd = process.cwd()) {
  const require = projectRequire(cwd);
  const found = [];
  for (const name of TYPESCRIPT) {
    let ts;
    try {
      ts = require(name);
    } catch (error) {
      if (error?.code === 'MODULE_NOT_FOUND') continue;
      throw error;
    }
    if (typeof ts?.createSourceFile === 'function') return { ts, name, version: ts.version };
    found.push(`${name} ${ts?.version ?? '(unknown version)'}`);
  }
  const seen = found.length === 0 ? 'neither is installed' : `found only ${found.join(', ')}, which has no compiler API`;
  throw new Error([
    `The TypeScript adapter needs the TypeScript compiler API in the project at ${cwd}, as typescript-api or typescript: ${seen}.`,
    'TypeScript 7 has no JavaScript API. Install TypeScript 6 beside it under another name:',
    '  npm install --save-dev typescript-api@npm:typescript@^6',
  ].join('\n'));
}
