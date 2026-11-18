import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  DIR_FOR, FILENAME_RE, SCENARIOS_HEADING, STATUSES, TYPE_FOR_PREFIX,
  parseRequirement, type Requirement, type ReqType, type Status,
} from './parse.js';
import { requirementsDir } from '../workflow/rulebook.mjs';

export interface LintProblem { path: string; message: string }

/**
 * Structural checks on the catalogue: the rules that let a machine read it at
 * all. Anything about evidence or coverage lives in `req:trace` instead, which
 * reads the test suite.
 */
export function lint(root = requirementsDir()): LintProblem[] {
  const problems: LintProblem[] = [];
  const requirements: Requirement[] = [];

  for (const [type, dir] of Object.entries(DIR_FOR) as [ReqType, string][]) {
    const full = join(root, dir);
    if (!existsSync(full)) continue;

    for (const filename of readdirSync(full).sort()) {
      if (filename === 'README.md') continue;
      const path = join(full, filename);

      if (!filename.endsWith('.md')) {
        problems.push({ path, message: 'not a markdown file' });
        continue;
      }
      const match = FILENAME_RE.exec(filename);
      if (!match) {
        problems.push({ path, message: 'filename must match (AC|INV)NNNN__lower_snake_slug.md' });
        continue;
      }
      const prefix = match[1]!;
      if (TYPE_FOR_PREFIX[prefix] !== type) {
        problems.push({ path, message: `${prefix} requirement must live in ${DIR_FOR[TYPE_FOR_PREFIX[prefix]!]}/, not ${dir}/` });
        continue;
      }

      const req = parseRequirement(filename, readFileSync(path, 'utf8'), path);
      requirements.push(req);

      if (req.statement === '') {
        problems.push({ path, message: 'body has no statement — the first non-empty line is the requirement' });
      }
      if (!STATUSES.includes(req.status)) {
        problems.push({ path, message: `status must be one of ${STATUSES.join(', ')} (got ${JSON.stringify(req.status)})` });
      }
      if (req.status === 'superseded' && !req.supersededBy) {
        problems.push({ path, message: 'status superseded requires supersededBy naming the replacement' });
      }
      if (req.supersededBy && req.status !== 'superseded') {
        problems.push({ path, message: `supersededBy is only meaningful with status superseded (got ${req.status})` });
      }
      problems.push(...scenarioProblems(req));
    }
  }

  const byId = new Map<string, Requirement[]>();
  for (const req of requirements) {
    byId.set(req.id, [...(byId.get(req.id) ?? []), req]);
  }
  for (const [id, group] of byId) {
    if (group.length > 1) {
      problems.push({ path: group.map((r) => r.path).join(', '), message: `duplicate id ${id}` });
    }
  }

  // A superseded requirement must lead somewhere. Anyone who arrives at an
  // obsolete requirement has to be able to follow it to whatever replaced it.
  for (const req of requirements) {
    if (!req.supersededBy) continue;
    const target = byId.get(req.supersededBy)?.[0];
    if (!target) {
      problems.push({ path: req.path, message: `supersededBy ${req.supersededBy} does not exist` });
    } else if (target.status === 'withdrawn') {
      problems.push({ path: req.path, message: `supersededBy ${req.supersededBy} is withdrawn — the trail dead-ends` });
    }
  }

  return problems;
}

/**
 * The structure of one requirement's scenarios.
 *
 * An acceptance criterion that is agreed or built must have at least one. The
 * scenarios are what its tests prove, so an AC without them has nothing its
 * tests could be held to. A superseded or withdrawn AC is history, and is
 * left as it was written. Invariants may have scenarios but need none: there
 * are none yet, and how an invariant is evidenced is still open.
 */
export function scenarioProblems(req: Requirement): LintProblem[] {
  const problems: LintProblem[] = [];
  const { path } = req;

  if (req.type === 'acceptance' && (req.status === 'accepted' || req.status === 'active') && req.scenarios.length === 0) {
    problems.push({ path, message: `has no scenarios — list what the AC promises under \`${SCENARIOS_HEADING}\`, one \`- [${req.id}.1] …\` per line` });
  }
  for (const item of req.malformedScenarios) {
    problems.push({ path, message: `scenario is not \`- [${req.id}.N] text\`: ${item}` });
  }
  const seen = new Set<string>();
  for (const { id } of req.scenarios) {
    if (!id.startsWith(`${req.id}.`)) {
      problems.push({ path, message: `scenario ${id} belongs to another requirement — scenarios here are ${req.id}.N` });
    }
    if (seen.has(id)) problems.push({ path, message: `duplicate scenario id ${id}` });
    seen.add(id);
  }
  return problems;
}

/**
 * What a failing lint prints, heading first. `workflow verify` runs the checks
 * one after another, so whatever a check prints first sits straight under the
 * line the previous check printed. Details printed before their own heading
 * read as belonging to the check above.
 */
export function failureReport(problems: LintProblem[]): string[] {
  return [
    `req:lint — ${problems.length} problem(s)`,
    ...problems.map((p) => `  ${p.path}: ${p.message}`),
  ];
}

/** The check as `workflow req lint` runs it, and as the referee verify runs it.
 *  Prints what it found, and returns whether it passed. */
export function runLint(dir = requirementsDir()): boolean {
  const problems = lint(dir);
  if (problems.length > 0) {
    for (const line of failureReport(problems)) console.error(line);
    return false;
  }
  console.log('req:lint — catalogue OK');
  return true;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain && !runLint(process.argv[2])) process.exit(1);
