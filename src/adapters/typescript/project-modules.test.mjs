import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { importFromProject, projectRequire, typescriptFromProject } from './project-modules.mjs';

/**
 * Each case builds a project outside this repository, so nothing it finds can
 * come from this repository's own `node_modules`.
 */
let project;
const write = (path, contents) => {
  mkdirSync(dirname(join(project, path)), { recursive: true });
  writeFileSync(join(project, path), contents);
};
/** A CommonJS package whose module is `exports`. */
const commonjs = (name, exports) => {
  write(`node_modules/${name}/package.json`, JSON.stringify({ name, main: 'index.js' }));
  write(`node_modules/${name}/index.js`, `module.exports = ${exports};\n`);
};
/** A TypeScript with the compiler API, as far as the adapter looks. */
const compiler = version => `{ version: '${version}', createSourceFile() {} }`;

beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'project-modules-')));
  write('package.json', '{}\n');
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

describe('a package the adapter drives', () => {
  it('is found in the project, and not in Katatay\'s own folder', () => {
    commonjs('only-here', "'the project copy'");
    expect(projectRequire(project)('only-here')).toBe('the project copy');
    // This repository has vitest; the project does not.
    expect(() => projectRequire(project).resolve('vitest')).toThrow(/Cannot find module 'vitest'/);
  });

  it('is imported from the project as an ES module, with top-level await', async () => {
    write('node_modules/esm-only/package.json', JSON.stringify({ name: 'esm-only', type: 'module', exports: { './plugin': './plugin.js' } }));
    write('node_modules/esm-only/plugin.js', "export const kind = await Promise.resolve('from the project');\n");
    expect((await importFromProject('esm-only/plugin', project)).kind).toBe('from the project');
  });

  it('is named, with the project, when the project does not have it', async () => {
    await expect(importFromProject('@stryker-mutator/core', project)).rejects.toThrow(
      `@stryker-mutator/core is not installed in the project at ${project}. The TypeScript adapter uses the project's own copy.`,
    );
  });

  it('passes on any other failure to resolve it unchanged', async () => {
    write('node_modules/closed/package.json', JSON.stringify({ name: 'closed', exports: { './open': './open.js' } }));
    await expect(importFromProject('closed/hidden', project)).rejects.toMatchObject({ code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  });
});

describe('the TypeScript the reporter reads tests with', () => {
  it('is typescript-api, before typescript, when the project has both', () => {
    commonjs('typescript-api', compiler('6.0.3'));
    commonjs('typescript', compiler('5.9.0'));
    expect(typescriptFromProject(project)).toMatchObject({ name: 'typescript-api', version: '6.0.3' });
  });

  it('is typescript when the project has no typescript-api', () => {
    commonjs('typescript', compiler('5.9.0'));
    const found = typescriptFromProject(project);
    expect(found).toMatchObject({ name: 'typescript', version: '5.9.0' });
    expect(typeof found.ts.createSourceFile).toBe('function');
  });

  it('is refused, with the way to add TypeScript 6, when the project has only TypeScript 7', () => {
    commonjs('typescript', "{ version: '7.0.2', versionMajorMinor: '7.0' }");
    expect(() => typescriptFromProject(project)).toThrow([
      `The TypeScript adapter needs the TypeScript compiler API in the project at ${project}, as typescript-api or typescript: found only typescript 7.0.2, which has no compiler API.`,
      'TypeScript 7 has no JavaScript API. Install TypeScript 6 beside it under another name:',
      '  npm install --save-dev typescript-api@npm:typescript@^6',
    ].join('\n'));
  });

  it('is refused when the project has neither', () => {
    expect(() => typescriptFromProject(project)).toThrow(
      `in the project at ${project}, as typescript-api or typescript: neither is installed.`,
    );
  });

  it('passes on a TypeScript that fails to load unchanged', () => {
    commonjs('typescript-api', "(() => { throw new Error('broken install'); })()");
    expect(() => typescriptFromProject(project)).toThrow('broken install');
  });
});
