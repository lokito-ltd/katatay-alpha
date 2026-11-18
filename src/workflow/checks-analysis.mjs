/** The same entry keys instruct the writer and validate the answer. Only
 * the writer judges whether the suggested test or repair is useful. */
import { command } from './commands.mjs';
import { compactReport } from './compact-report.mjs';
import { SUMMARY_LIMIT } from './event-format.mjs';
import { checksAnalyses, readSnapshot } from './local-snapshot.mjs';
import { STATE_FOLDER } from './folder.mjs';

export const CLEAN = 'All reported checks completed without findings.';
const HEADING = /^(Coverage|Mutants|Check|Limit) /;
function expected(report) {
  const sections = new Map();
  for (const { file, line } of report.coverage.uncovered) sections.set(`Coverage ${file}:${line}`, ['Scenario', 'Assert']);
  for (const { file, line, id } of report.mutation.survivors) {
    const key = `Mutants ${file}:${line}`;
    if (!sections.has(key)) sections.set(key, new Set());
    sections.get(key).add(`Variant ${id}`);
  }
  for (const check of report.checks) {
    if (check.status === 'findings') sections.set(`Check ${check.name}`, ['Finding', 'Action']);
  }
  for (const check of [{ name: 'coverage', ...report.coverage }, { name: 'mutation', ...report.mutation }, ...report.checks]) {
    if (!['clean', 'complete', 'findings'].includes(check.status)) sections.set(`Limit ${check.name} [${check.status}]`, ['Impact']);
    if (check.treeFingerprint) sections.set(`Limit ${check.name} [reused]`, ['Impact']);
  }
  return sections;
}

export function analysisRequest(seq, report) {
  const entries = expected(report);
  const keys = [...entries].flatMap(([key, fields]) => fields instanceof Set ? [key, ...fields] : [key]);
  return [
    `Write the checks analysis for verification ${seq}. Read the full evidence in that verified event’s payload.results and the snapshots its results name. Recommend specific tests and code quality improvements based on these reports.`,
    'For each Coverage entry, give Scenario: setup and action, and Assert: the observable result. Under each Mutants group, give each Variant its own Scenario and Assert, or No observable effect: with the reason.',
    'For each Check, give Finding: and Action: covering its findings, the code change and how to confirm it, or why no change is warranted. For each Limit, give Impact: explaining what this pass established and what remains unknown.',
    keys.length ? `Begin with a line starting \`Summary:\`: a short summary for the operator of what the analysis recommends, without evidence paths. The logbook keeps its first ${SUMMARY_LIMIT} characters. The referee lists the evidence at the end of the saved analysis.` : null,
    keys.length ? 'Then use these entry headings verbatim, each on its own line:\n' + keys.join('\n') : CLEAN,
    `Submit the analysis on stdin to \`${command('checks-analysis')} ${seq}\`. Post the full verification report and warnings in the main chat, followed by the summary the command prints, exactly as printed. Do not paste the full analysis: the summary links to it.`,
  ].filter(Boolean).join('\n\n');
}

/** The clean sentence, or the agent's `Summary:` block, which runs from the
 * first line to the first entry heading. Null when the analysis has none. */
function summaryBlock(text) {
  if (text.trim() === CLEAN) return CLEAN;
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (HEADING.test(line)) break;
    if (lines.length) lines.push(line);
    else if (line) {
      const match = /^Summary:\s*(.*)$/.exec(line);
      if (!match) return null;
      lines.push(match[1]);
    }
  }
  return lines.join('\n').trim() || null;
}

/** The summary the logbook keeps, cut to SUMMARY_LIMIT code points and
 * ending in `…` when cut. Null when the analysis has none. */
export function summaryOf(text) {
  const summary = summaryBlock(text);
  if (summary === null) return null;
  const chars = [...summary];
  return chars.length <= SUMMARY_LIMIT ? summary : chars.slice(0, SUMMARY_LIMIT - 1).join('') + '…';
}

const title = seq => `Agent's assessment for verification ${seq} checks results.`;
const LABEL = 'Full analysis';
const summaryLines = summary => ({ lines: summary.split('\n'), cut: true });
/** A count, with its names when they fit. */
const named = (label, names) => ({ text: `${label}: ${names.length} (${names.join(', ')}).`, short: `${label}: ${names.length}.` });

/** What the accepted analysis recommends, counted from its entry headings and
 *  fields, which `validateAnalysis` has already checked. */
function tally(text) {
  const counts = { coverage: 0, mutants: 0, noEffect: 0, checks: [], limits: [] };
  let group = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = HEADING.exec(line);
    if (heading) {
      group = heading[1];
      const name = line.slice(heading[0].length);
      if (group === 'Coverage') counts.coverage++;
      if (group === 'Check') counts.checks.push(name);
      if (group === 'Limit') counts.limits.push(name);
    } else if (group === 'Mutants' && line.startsWith('Scenario:')) counts.mutants++;
    else if (group === 'Mutants' && line.startsWith('No observable effect:')) counts.noEffect++;
  }
  return counts;
}

/**
 * The compact report of an accepted analysis, for the operator: the agent's
 * summary, what it recommends in counts, and the link to its checks_analysis
 * event, which names the snapshot holding the full text and its evidence.
 */
export function analysisSummary({ text, seq, link }) {
  if (text.trim() === CLEAN) return compactReport({ title: title(seq), blocks: [{ lines: [CLEAN] }], link, label: LABEL });
  const { coverage, mutants, noEffect, checks, limits } = tally(text);
  const tests = [coverage && `${coverage} for uncovered lines`, mutants && `${mutants} for surviving mutants`].filter(Boolean);
  const facts = [
    tests.length && `Tests suggested: ${tests.join(', ')}.`,
    noEffect && `Mutants with no observable effect: ${noEffect}.`,
    checks.length && named('Check findings answered', checks),
    limits.length && named('Limitations', limits),
  ].filter(Boolean);
  const summary = summaryOf(text);
  return compactReport({
    title: title(seq),
    blocks: [summary === null ? null : summaryLines(summary), facts.length ? { lines: facts } : null].filter(Boolean),
    link,
    label: LABEL,
  });
}

/** The compact report when the full analysis cannot be read: the summary the
 *  event keeps, and why the rest is lost. */
export function lostAnalysisSummary({ summary, seq, link, evidence, why }) {
  return compactReport({
    title: title(seq),
    blocks: [{ lines: [`The full analysis cannot be read from ${evidence}: ${why.replace(/\.$/, '')}.`] }, summaryLines(summary)],
    link,
    label: LABEL,
  });
}

/**
 * The evidence the request told the agent to read: every item the
 * verification's results name, in the order the receipt holds them. Built
 * from the receipt alone, so a retry rebuilds the same text.
 */
export function evidenceSection(receipt) {
  const items = receipt.payload.results
    .flatMap(result => result.evidence.map(item => `- ${result.name}, ${item.title}: ${item.snapshot}`));
  return '\n\nEvidence\n' + (items.length ? items.join('\n') : 'None.') + '\n';
}

/** The saved file: the agent's exact text, then the evidence list. */
export const savedAnalysis = (text, receipt) => Buffer.from(text + evidenceSection(receipt), 'utf8');

/**
 * The agent's text of an accepted analysis, read back from its file. Throws
 * when the file is missing or altered, or no longer ends with the evidence
 * list this receipt gives.
 */
export function acceptedText(branch, event, receipt, root = process.cwd()) {
  const saved = readSnapshot(branch, checksAnalyses, event.payload.analysisSnapshot, root).toString('utf8');
  const section = evidenceSection(receipt);
  if (!saved.endsWith(section)) throw new Error('its evidence list does not match the verification');
  return saved.slice(0, saved.length - section.length);
}

function fieldsMatch(lines, fields) {
  const used = new Set();
  for (const line of lines) {
    const match = /^([^:]+):\s*(.*)$/.exec(line);
    if (!match || !fields.includes(match[1]) || !match[2].trim() || used.has(match[1])) return false;
    used.add(match[1]);
  }
  return used.size === fields.length;
}

export function validateAnalysis(report, text) {
  const entries = expected(report);
  if (!entries.size) {
    if (text.trim() !== CLEAN) throw new Error(`expected "${CLEAN}"`);
    return;
  }
  const summary = summaryBlock(text);
  if (summary === null) throw new Error('missing Summary');
  if (summary.includes(`${STATE_FOLDER}/`)) throw new Error('Summary names evidence paths');
  const groups = new Map();
  let group;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (HEADING.test(line)) {
      if (!entries.has(line)) throw new Error(`unexpected ${line}`);
      if (groups.has(line)) throw new Error(`duplicate ${line}`);
      group = [];
      groups.set(line, group);
    } else if (group) group.push(line);
  }
  for (const [key, fields] of entries) {
    const lines = groups.get(key);
    if (!lines) throw new Error(`missing ${key}`);
    if (fields instanceof Set) {
      const variants = new Map();
      let body;
      for (const line of lines) {
        if (line.startsWith('Variant ')) {
          if (!fields.has(line) || variants.has(line)) throw new Error(`${key}: unexpected or duplicate ${line}`);
          body = [];
          variants.set(line, body);
        } else if (body) body.push(line);
        else throw new Error(`${key}: expected Variant heading`);
      }
      for (const variant of fields) {
        const body = variants.get(variant);
        if (!body) throw new Error(`missing ${key}, ${variant}`);
        if (!fieldsMatch(body, ['Scenario', 'Assert']) && !fieldsMatch(body, ['No observable effect'])) {
          throw new Error(`${key}, ${variant} needs Scenario and Assert, or No observable effect`);
        }
      }
    } else if (!fieldsMatch(lines, fields)) throw new Error(`${key} needs ${fields.join(' and ')}`);
  }
}
