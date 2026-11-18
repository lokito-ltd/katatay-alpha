import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { checksum } from './checksum.js';
import { requirementsDir } from '../workflow/rulebook.mjs';

export const STATUSES = ['accepted', 'active', 'superseded', 'withdrawn'] as const;
export type Status = (typeof STATUSES)[number];

export type ReqType = 'acceptance' | 'invariant';

export interface Requirement {
  id: string;
  type: ReqType;
  slug: string;
  path: string;
  status: Status;
  supersededBy?: string;
  source?: string;
  statement: string;
  checksum: string;
  /** The scenarios under `## Scenarios`, in the order the file lists them. */
  scenarios: Scenario[];
  /** List items under `## Scenarios` that are not `- [ID] text`. Lint reports them. */
  malformedScenarios: string[];
}

/**
 * One case an acceptance criterion promises, stated in a line, with an id of
 * its own: `AC0009.2`.
 *
 * Scenarios are how an AC and its tests say the same thing. Each scenario is
 * proved by tests whose title is the scenario's text, word for word, tagged
 * with its id. So the list in the AC file is what the tests prove, and a test's
 * body is only how it proves it. `req:trace` holds the two lists together.
 *
 * Each scenario has its own fingerprint instead of joining the statement's.
 * The guard compares them one by one, and that is what lets it tell a scenario
 * added, which adds obligation and is free, from one removed or reworded, which
 * needs approval. It also leaves the statement's fingerprint alone, which the
 * guard uses to recognise a renumbered requirement.
 */
export interface Scenario {
  id: string;
  text: string;
  checksum: string;
}

export const SCENARIOS_HEADING = '## Scenarios';

const SCENARIO_ITEM = /^\[((?:AC|INV)\d{4}\.\d+)\]\s+(\S[\s\S]*)$/;

/**
 * Scenario text as it is compared: runs of whitespace are one space, and
 * backticks are dropped. The backticks are there so `\r\n` reads as code in
 * the AC file, and a test title has no reason to carry them.
 */
export const scenarioText = (text: string): string =>
  text.replace(/`/g, '').replace(/\s+/g, ' ').trim();

/**
 * The scenarios under the `## Scenarios` heading, up to the next heading.
 *
 * An item is `- [AC0009.2] text`. A line that is indented and not a new item
 * continues the item above it, so a long scenario can wrap. Any other item is
 * returned as malformed rather than dropped, because a scenario that silently
 * failed to parse would be one nobody has to test.
 */
export function scenariosOf(body: string): { scenarios: Scenario[]; malformed: string[] } {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => line.trim() === SCENARIOS_HEADING);
  if (start === -1) return { scenarios: [], malformed: [] };

  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    if (/^[-*]\s/.test(line)) items.push(line.slice(2).trim());
    else if (line.trim() !== '' && /^\s/.test(line) && items.length > 0) {
      items[items.length - 1] += ` ${line.trim()}`;
    } else if (line.trim() !== '') items.push(line.trim());
  }

  const scenarios: Scenario[] = [];
  const malformed: string[] = [];
  for (const item of items) {
    const match = SCENARIO_ITEM.exec(item);
    if (!match) {
      malformed.push(item);
      continue;
    }
    const text = scenarioText(match[2]!);
    scenarios.push({ id: match[1]!, text, checksum: checksum(text) });
  }
  return { scenarios, malformed };
}

export const DIR_FOR: Record<ReqType, string> = {
  acceptance: 'acceptance',
  invariant: 'invariants',
};

export const FILENAME_RE = /^(AC|INV)(\d{4})__([a-z0-9_]+)\.md$/;

export const TYPE_FOR_PREFIX: Record<string, ReqType> = {
  AC: 'acceptance',
  INV: 'invariant',
};

/** The statement is the first non-empty line of the body. */
export function statementOf(body: string): string {
  for (const line of body.split('\n')) {
    if (line.trim() !== '') return line.trim();
  }
  return '';
}

/**
 * Parse one requirement from raw file content. Kept separate from disk access
 * so guard can parse blobs read out of git without touching the filesystem.
 */
export function parseRequirement(filename: string, raw: string, path: string): Requirement {
  const match = FILENAME_RE.exec(filename);
  if (!match) throw new Error(`filename does not match (AC|INV)NNNN__slug.md: ${filename}`);
  const [, prefix, digits, slug] = match as unknown as [string, string, string, string];

  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;
  const statement = statementOf(parsed.content);
  const { scenarios, malformed } = scenariosOf(parsed.content);

  return {
    id: `${prefix}${digits}`,
    type: TYPE_FOR_PREFIX[prefix]!,
    slug,
    path,
    status: data.status as Status,
    supersededBy: data.supersededBy as string | undefined,
    source: data.source as string | undefined,
    statement,
    checksum: checksum(statement),
    scenarios,
    malformedScenarios: malformed,
  };
}

/** Read the whole catalogue from a working tree. */
export function loadCatalogue(root = requirementsDir()): Requirement[] {
  const out: Requirement[] = [];
  for (const dir of Object.values(DIR_FOR)) {
    const full = join(root, dir);
    if (!existsSync(full)) continue;
    for (const filename of readdirSync(full).sort()) {
      if (!filename.endsWith('.md')) continue;
      const path = join(full, filename);
      out.push(parseRequirement(filename, readFileSync(path, 'utf8'), path));
    }
  }
  return out;
}
