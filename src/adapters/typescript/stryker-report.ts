/**
 * Stryker's JSON reporter writes completed runs. A run stopped at its budget
 * has only the progress journal, so the wrapper publishes those completed
 * results in the same schema after all workers have stopped.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative } from 'node:path';
import { PROGRESS } from './progress.mjs';

export const DEFAULT_REPORT = 'reports/mutation/mutation.json';

/** The same default as Stryker's JSON reporter. The project can pass another
 * path and name that path in its rulebook. */
export function reportFileOf(args: string[]): string {
  const at = args.indexOf('--report-file');
  if (at === -1) return DEFAULT_REPORT;
  const path = args[at + 1];
  if (!path || path.startsWith('--') || isAbsolute(path) || path.includes('\\') || /^[A-Za-z]:/.test(path) || /[*?{}[\]]/.test(path)
    || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('mutate: --report-file needs a path from the repository root');
  }
  return path;
}

interface Result {
  fileName: string;
  id: string;
  location: { start: { line: number; column: number }; end: { line: number; column: number } };
  mutatorName: string;
  status: string;
  [key: string]: unknown;
}

/** Empty is a valid report for the wrapper's explicit no-tests result.
 * Completed journal entries already use the schema's one-based positions.
 * Their ids and optional test associations are preserved as written.
 */
export function writePartialReport(cwd: string, reportFile: string, noTests: boolean): void {
  const files: Record<string, { language: string; source: string; mutants: Omit<Result, 'fileName'>[] }> = Object.create(null);
  const progress = join(cwd, PROGRESS);
  const journal = !noTests && existsSync(progress) ? readFileSync(progress, 'utf8') : '';
  for (const line of journal.split('\n').filter(Boolean)) {
    const entry = JSON.parse(line) as { result?: Result };
    if (entry.result === undefined) continue;
    const { fileName, ...mutant } = entry.result;
    const file = relative(cwd, fileName).split('\\').join('/');
    if (file === '' || file.startsWith('../') || isAbsolute(file)) throw new Error(`mutate: result is outside the repository: ${fileName}`);
    const result = files[file] ??= {
      language: ['.ts', '.tsx', '.mts', '.cts'].includes(extname(file)) ? 'typescript' : 'javascript',
      source: readFileSync(join(cwd, file), 'utf8'),
      mutants: [],
    };
    result.mutants.push(mutant);
  }
  const path = join(cwd, reportFile);
  const temporary = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(temporary, JSON.stringify({ schemaVersion: '1.0', thresholds: { high: 80, low: 60 }, partial: true, files }));
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
