import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { sourceLines } from './mutation-report.mjs';

/** A missing file contains none of the recorded lines. An unreadable file
 * gives no evidence either way. Only compare regular files in this repo. */
function currentLines(root, file) {
  try {
    const directory = realpathSync(root);
    const path = realpathSync(resolve(directory, file));
    if (!path.startsWith(directory + sep) || !statSync(path).isFile()) return null;
    return new Set(sourceLines(readFileSync(path, 'utf8')));
  } catch (error) {
    return error.code === 'ENOENT' || error.code === 'ENOTDIR' ? new Set() : null;
  }
}

/** Replace the adapter's flat list. Everything around it, including why a
 * run was partial, is still useful. Older verifies could also append a list
 * of missing rows (with multiline replacements) just before their count. */
function withoutFlatList(report, flatRows) {
  const lines = report.replace(/^Survivors in the report:\n- [\s\S]*\n(?=(?:inconclusive: )?\d+ mutants?, \d+ caught, \d+ survived$)/m, '').split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === 'Survived:') {
      let next = i + 1;
      while (next < lines.length) {
        const row = /^\s*- (.+?) → /.exec(lines[next]);
        if (!row || !flatRows.has(row[1])) break;
        next++;
      }
      if (next > i + 1) { i = next - 1; continue; }
    }
    kept.push(lines[i]);
  }
  return kept.join('\n').trimEnd();
}

/**
 * @param {string} report run text, including the tool's summary and diagnostics
 * @param {import('./mutation-report.mjs').Survivor[]} survivors in report order
 * @param {string} [root] compare with this working tree when showing a saved run
 */
export function survivorReport(report, survivors, root) {
  if (!survivors.length) return report;
  const groups = new Map();
  const flatRows = new Set();
  for (const { file, location, sourceLine, mutator, replacement } of survivors) {
    const at = `${file}:${location.start.line}`;
    flatRows.add(at + ' ' + mutator);
    if (!groups.has(at)) groups.set(at, { file, sourceLine, variants: new Map() });
    const variants = groups.get(at).variants;
    const key = JSON.stringify([mutator, replacement]);
    if (!variants.has(key)) variants.set(key, { mutator, replacement, count: 0 });
    variants.get(key).count++;
  }

  const lines = [withoutFlatList(report, flatRows), '', 'Survivors by line:'];
  const files = new Map();
  for (const [at, { file, sourceLine, variants }] of groups) {
    let label = '';
    if (root !== undefined && sourceLine !== undefined) {
      if (!files.has(file)) files.set(file, currentLines(root, file));
      const current = files.get(file);
      if (current === null) label = ' (comparison unavailable)';
      else if (!current.has(sourceLine)) label = ' (changed since the run)';
    }
    lines.push(at + label);
    if (sourceLine !== undefined) lines.push('  ' + sourceLine);
    for (const { mutator, replacement, count } of variants.values()) {
      const change = replacement === undefined ? '' : ' → ' + replacement.replace(/\r\n|[\r\n]/g, '\n      ');
      lines.push('    ' + mutator + change + (count > 1 ? `  ×${count}` : ''));
    }
  }
  return lines.join('\n');
}
