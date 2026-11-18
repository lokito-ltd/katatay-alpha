import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { loadCatalogue } from './parse.js';
import { approvedInPlanFor, type RecordedRequirement } from './guard.js';
import { current } from '../workflow/state.mjs';
import { target } from '../workflow/target.mjs';
import { gitText } from '../workflow/git.mjs';
import { isCode, isTest } from '../workflow/frozen.mjs';
import { command } from '../workflow/commands.mjs';
import { requirementsPrefix } from '../workflow/rulebook.mjs';

const ID_RE = /^(AC|INV)\d{4}$/;

/**
 * Whether main already knows this id.
 *
 * Renumbering is routine for an id that never reached main. Requirements are
 * committed on the branch when the plan is approved, so two branches can
 * allocate the same id without either of them doing anything wrong.
 *
 * An id main already knows is different. Renumbering it changes the identity of
 * a requirement that was agreed, which is a protected operation. It belongs in
 * a plan: `renumber` goes ahead only when the approved plan lists the new id
 * with the old one as `renumberedFrom`.
 */
export function isOnMain(id: string): boolean {
  // Outside the `try`: with no target configured the answer is unknown, and
  // reading that as "not agreed" would let an agreed id be renumbered.
  const ref = target().ref;
  try {
    const listed = gitText(['ls-tree', '-r', ref, '--name-only', '--', requirementsPrefix()]);
    return new RegExp(`/${id}__`).test(listed);
  } catch {
    return false; // no main yet: nothing has been agreed
  }
}

/**
 * Every file a renumber rewrites: the catalogue and change log under
 * the requirements folder, and every test and code file git knows about or would
 * track. Tests carry the tags, and code mentions ids in comments. Which files
 * are tests and which are code is the adapter's rule (`isTest` and `isCode` in
 * `frozen.mjs`), so a repository in another language is covered too.
 *
 * It used to walk five folders by name, which was one project's layout and no
 * other's. Before the last two were added to that list, their tags kept
 * naming an id that no longer existed, and `req:trace` counted them as evidence for it without
 * complaint. Asking git instead cannot leave a folder out.
 */
function filesToRewrite(): string[] {
  const prefix = requirementsPrefix();
  return gitText(['ls-files', '--cached', '--others', '--exclude-standard'])
    .split('\n')
    .filter((path) => path !== '' && existsSync(path))
    .filter((path) => (path.startsWith(prefix) && path.endsWith('.md')) || isTest(path) || isCode(path));
}

/**
 * @param approved the requirement changes the operator approved with the live
 *   plan. Only consulted for an id main knows. This check saves a session from
 *   doing work the guard would refuse; `req:guard` is the check that counts.
 */
export function renumber(from: string, to: string, approved: RecordedRequirement[] = []): string[] {
  if (!ID_RE.test(from) || !ID_RE.test(to)) throw new Error(`ids must look like AC0001 or INV0001`);
  if (from.slice(0, from.length - 4) !== to.slice(0, to.length - 4)) {
    throw new Error(`cannot change a requirement's type: ${from} → ${to}`);
  }
  if (isOnMain(from) && !approved.some((a) => a.id === to && a.renumberedFrom === from)) {
    throw new Error(
      `${from} exists on main. Renumbering an agreed requirement changes its identity, so it needs ` +
      `the operator's approval: a plan listing ${to} under \`requirement-changes:\`, with ` +
      `\`renumberedFrom: ${from}\`, approved by the operator.`,
    );
  }
  if (loadCatalogue().some((r) => r.id === to)) throw new Error(`${to} is already taken`);

  const source = loadCatalogue().find((r) => r.id === from);
  if (!source) throw new Error(`${from} not found in the catalogue`);

  const touched: string[] = [];

  // Every reference: the catalogue, the change log, test tags and code
  // comments. See `filesToRewrite`.
  for (const path of filesToRewrite()) {
    const before = readFileSync(path, 'utf8');
    const after = before.replaceAll(from, to);
    if (after !== before) {
      writeFileSync(path, after);
      touched.push(path);
    }
  }

  const renamed = source.path.replace(`${from}__`, `${to}__`);
  renameSync(source.path, renamed);
  touched.push(`${source.path} → ${renamed}`);

  return touched;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  const [from, to] = process.argv.slice(2);
  if (!from || !to) {
    console.error(`usage: ${command('req renumber')} <fromId> <toId>`);
    process.exit(2);
  }
  try {
    const approved = approvedInPlanFor(process.env, () => current().grant);
    for (const path of renumber(from, to, approved)) console.log(`  updated ${path}`);
    console.log(`req:renumber — ${from} is now ${to}`);
  } catch (error) {
    console.error(`req:renumber — ${(error as Error).message}`);
    process.exit(1);
  }
}
