/** Standard reports for commands used by workflow tests. Each command writes
 * its report during the run, so the referee's stale-report check is exercised. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const mutant = (status, over = {}) => ({
  file: 'modules/a.ts', id: '1', mutatorName: 'EqualityOperator', replacement: 'a !== b',
  location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
  status, testsCompleted: 1, ...over,
});

export function reportOf(mutants = []) {
  const files = Object.create(null);
  for (const { file, source = 'a === b\n', ...result } of mutants) {
    files[file] ??= { language: 'javascript', source, mutants: [] };
    files[file].mutants.push(result);
  }
  return { schemaVersion: '1.0', thresholds: { high: 80, low: 60 }, files };
}

export function writeReport(root, mutants = []) {
  const config = JSON.parse(readFileSync(join(root, '.katatay/rulebook.json'), 'utf8'));
  const path = join(root, config.checks.testQuality.mutation.output);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(reportOf(mutants)));
}

export function mutationCommand(text, code = 0, mutants = [], before = '') {
  const script = `const fs = require('fs'); const path = require('path');
    ${before}
    const config = JSON.parse(fs.readFileSync('.katatay/rulebook.json', 'utf8'));
    const report = config.checks.testQuality.mutation.output;
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, ${JSON.stringify(JSON.stringify(reportOf(mutants)))});
    console.log(${JSON.stringify(text)}); process.exitCode = ${code};`;
  return `node -e '${script.replaceAll("'", "'\\''")}'`;
}
