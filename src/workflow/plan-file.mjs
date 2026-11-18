/** Read the file an adapter supplies, without granting permission. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inPlansFolder, real } from './places.mjs';
import { parsePlansDir, readConfig } from './rulebook.mjs';

export function readPlanFile(planFile, root, home) {
  const folder = parsePlansDir(readConfig(root));
  if (!inPlansFolder(planFile, root, home)) {
    return { kind: 'location', problem: `${JSON.stringify(planFile)} is not a Markdown file directly in ${folder}, the rulebook's plans folder` };
  }
  const path = real(resolve(root, planFile));
  try {
    const bytes = readFileSync(path);
    return { folder, path, bytes, text: bytes.toString('utf8') };
  } catch (error) {
    return { kind: 'read', problem: `the plan file ${path} cannot be read (${error.code ?? error.message})` };
  }
}
