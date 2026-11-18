import { HARNESS_SCHEMA_VERSION } from '../schema-version.mjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHECK_TIME_LIMIT, CONFIG, RESERVED_CHECK_NAMES, RULEBOOK_WHY, TargetError, allChecks, highRiskAreas, parseAgentAdapters, parseChecks, parseHighRisk, parseRulebook,
  parseRequirementsDir, parseTargetBranch, readChecks, readConfig, readMutation, rulebookFingerprint, requirementsDir, requirementsPrefix,
  DEFAULT_FOLLOW_UPS, checkGating, followUpsFile, parseLockedPaths, parseExtraHooks, parseFollowUpsFile, parsePlansDir, plansDir,
  readAgentAdapters, analysisRequired, parsePlanValidation, resolvePath, withDraftConfig,
} from './rulebook.mjs';
import { readAdapter, AdapterError } from './adapter.mjs';
import { bareSections, fixtureRulebook, fixtureMutation, mutationChecks } from '../../tests/fixtures/workflow/adapter.mjs';

/** Each case changes only the fields it exercises. */
const rulebook = (over = {}) => ({ ...fixtureRulebook(), ...over });
const refusal = (run) => {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal');
};

describe('the rulebook', () => {
  it('accepts the rulebook examples published in the workflow README', () => {
    const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
    const documents = [...readme.matchAll(/^```json\n([\s\S]*?)\n```$/gm)].map(match => JSON.parse(match[1]));
    const examples = documents.filter(document => 'targetBranch' in document);
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      expect(parseRulebook(JSON.stringify(example))).toMatchObject(example);
    }
  });

  it('is read at the version this referee knows', () => {
    expect(parseRulebook(JSON.stringify(rulebook())).version).toBe(HARNESS_SCHEMA_VERSION);
    expect(HARNESS_SCHEMA_VERSION).toBe(1);
  });

  it('is refused when it is not JSON, or not an object, as a TargetError so every entry point refuses alike', () => {
    for (const text of ['{ not json', '[]', 'null', '"rulebook"']) {
      const error = refusal(() => parseRulebook(text));
      expect(error, text).toBeInstanceOf(TargetError);
    }
    expect(refusal(() => parseRulebook('{ not json')).message).toMatch(/is not readable as JSON/);
    expect(refusal(() => parseRulebook('[]')).message).toMatch(/must hold a JSON object/);
  });

  // The shape from before the rulebook. Guessing it from missing keys would
  // say "no target" and send the operator looking in the wrong place.
  it('requires an explicit version', () => {
    const { version: _, ...old } = rulebook();
    expect(refusal(() => parseRulebook(JSON.stringify(old))).message)
      .toMatch(/must specify "version": 1/);
  });

  // A later referee may add a key that is a safety setting. Reading the file
  // without it would be the generous guess.
  it('is refused at a version this referee does not read, and names the one it does', () => {
    for (const version of [0, 2, '1', 1.5, null]) {
      expect(refusal(() => parseRulebook(JSON.stringify(rulebook({ version }))))
        .message, JSON.stringify(version)).toMatch(/and this referee reads version 1/);
    }
  });

  it('is refused when it is missing, and says what it starts as', () => {
    const root = mkdtempSync(join(tmpdir(), 'rulebook-none-'));
    try {
      const error = refusal(() => readConfig(root));
      expect(error).toBeInstanceOf(TargetError);
      expect(error.message).toMatch(/there is no \.katatay\/rulebook\.json, which starts as \{ "version": 1/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe('on disk', () => {
    let root;
    const write = (body) => {
      mkdirSync(join(root, '.katatay'), { recursive: true });
      writeFileSync(join(root, CONFIG), JSON.stringify(body));
    };
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'rulebook-'));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it.each([undefined, null, '1', 2, 1])('reads the rulebook from disk with version %j', version => {
      write(rulebook({ version }));
      if (version === 1) expect(readConfig(root).version).toBe(1);
      else expect(() => readConfig(root)).toThrow(version === undefined
        ? `${CONFIG} must specify "version"` : `${CONFIG} says "version": ${JSON.stringify(version)}`);
    });

    it('fingerprints readable bytes even for invalid JSON, and returns null when the file is missing', () => {
      expect(rulebookFingerprint(root)).toBeNull();
      mkdirSync(join(root, '.katatay'));
      writeFileSync(join(root, CONFIG), Buffer.from('abc'));
      expect(rulebookFingerprint(root)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });

    it('requires an agent section and shows a valid minimum configuration', () => {
      write(rulebook({ agent: undefined }));
      const error = refusal(() => readConfig(root));
      expect(error).toBeInstanceOf(TargetError);
      expect(error.message).toContain('"agent": { "lockedPaths": [], "adapters": { "local": { "checkCommand": "node check.mjs" } } }');
    });

    it.each([
      [{ lockedPaths: [] }, '"agent.adapters" must be an object keyed by agent name'],
      [{ lockedPaths: [], adapters: {} }, '"agent.adapters" must contain at least one named adapter'],
    ])('refuses a rulebook with no named adapter: %j', (agent, diagnostic) => {
      write(rulebook({ agent }));
      const error = refusal(() => readConfig(root));
      expect(error).toBeInstanceOf(TargetError);
      expect(error.message).toContain(diagnostic);
    });

    it.each([
      [{ surprise: true }, 'surprise', 'version'],
      [{ targetBrnch: 'origin/main' }, 'targetBrnch', 'targetBranch'],
      [{ code: { compile: { flags: [] } } }, 'code.compile.flags', 'exitCodes'],
      [{ plans: { format: 1 } }, 'plans.format', 'validateFormat'],
      [{ highRisk: [{ reason: 'safety' }] }, 'highRisk[0].reason', 'why'],
      [{ agent: { adapters: { custom: { extraHooks: { acknowledged: [{ pattern: '' }] } } } } }, 'agent.adapters.custom.extraHooks.acknowledged[0].pattern', 'matcher'],
      [{ plans: { __protoKey: true } }, 'plans.__protoKey', 'dir'],
    ])('rejects an unrecognised key on read at %s', (over, path, allowed) => {
      write(rulebook(over));
      const message = refusal(() => readConfig(root)).message;
      expect(message).toContain(`unknown "${path}". Allowed keys:`);
      expect(message).toContain(allowed);
    });

    describe('the version 1 keys', () => {
      const disabled = { coverage: 'none', mutation: 'none' };
      const lint = { command: 'lint', exitCodes: { 0: 'clean', 1: 'findings' }, output: 'reports/lint.json' };
      const mutation = { command: 'mutate', output: 'reports/mutation.json', excludePaths: ['generated/**'] };
      const coverage = { command: 'read-lcov', output: 'reports/coverage.json', minimum: { 'src/': { lines: 85, branches: 75.5 } } };
      const active = () => rulebook({
        targetBranch: 'upstream/release/next', followUpsFile: 'docs/NEXT.md', requirementsDir: 'criteria/',
        plans: { dir: 'drafts', validateFormat: false },
        agent: { lockedPaths: ['protected/**'], adapters: { local: { checkCommand: 'node check.mjs' } } },
        checks: { requireAnalysis: false, testQuality: { coverage, mutation }, codeQuality: { lint } },
      });

      function writeWithOutput(name, fields) {
        const config = structuredClone(active());
        const entry = config.checks.testQuality[name];
        delete entry.output;
        Object.assign(entry, fields);
        write(config);
      }

      // The key tables are built at import time. Load them inside the case
      // so a mutation active for this test reaches the reader under test.
      function freshReader() {
        vi.resetModules();
        return import('./rulebook.mjs');
      }

      it('validates each folder and identifies the folder with an extra coverage key', async () => {
        const reader = await freshReader();
        const config = structuredClone(active());
        const floors = config.checks.testQuality.coverage.minimum;
        floors['lib/'] = { lines: 92, branches: 80 };
        write(config);
        expect(reader.readConfig(root).checks.testQuality.coverage.minimum).toEqual(floors);

        floors['lib/'].line = 92;
        write(config);
        const error = refusal(() => reader.readConfig(root));
        expect(error).toBeInstanceOf(reader.TargetError);
        expect(error.message).toBe(`unknown "checks.testQuality.coverage.minimum.lib/.line". Allowed keys: lines, branches. The workflow refuses to run without it. The operator edits .katatay/rulebook.json; src/schemas/rulebook.schema.json, in the folder 'ktty path' prints, describes its shape.`);
      });

      it.each(['coverage', 'mutation'])('reads %s.output as its single destination and identifies an invalid value there', async name => {
        const reader = await freshReader();
        const destination = 'reports/custom.json';
        writeWithOutput(name, { output: destination });
        const check = reader.readChecks(root).testQuality.find(check => check.name === name);
        if (name === 'mutation') {
          expect(check.report).toBe(destination);
          expect(check).not.toHaveProperty('output');
        } else {
          expect(check.output).toBe(destination);
        }
        writeWithOutput(name, { output: '../outside.json' });
        expect(() => reader.readConfig(root)).toThrow(`"checks.testQuality.${name}.output" must be one repository-relative output file`);
      });

      it.each(['coverage', 'mutation'])('asks for %s.output when no destination is supplied', name => {
        writeWithOutput(name, {});
        expect(() => readConfig(root)).toThrow(`"checks.testQuality.${name}.output" must be one repository-relative output file`);
      });

      it.each([false, true])('rejects the retired language section on disk (current sections present: %s)', current => {
        const config = active();
        if (!current) {
          delete config.tests;
          delete config.code;
        }
        write({ ...config, language: {} });
        expect(() => readConfig(root)).toThrow('unknown "language". Allowed keys: version, targetBranch, tests, code');
      });

      const allowed = {
        'tests.paths': 'all, acceptance, slow, support',
        'tests.run': 'command, reportPaths, tagComment',
        'checks.testQuality.coverage': 'command, runs, onFailure, timeLimitSeconds, suppressions, skipInCi, output, minimum',
        'checks.testQuality.mutation': 'command, runs, onFailure, timeLimitSeconds, suppressions, skipInCi, output, excludePaths',
      };

      describe.each(['alone', 'beside its replacement'])('a retired key %s', position => {
        it.each([
          ['tests.paths', 'fast', 'all'], ['tests.run', 'reports', 'reportPaths'],
          ['tests.run', 'reporterFile', 'command'], ['tests.run', 'reportWriter', 'command'],
          ['checks.testQuality.coverage', 'outputFile', 'output'], ['checks.testQuality.mutation', 'report', 'output'],
          ['checks.testQuality.mutation', 'reportFile', 'output'], ['checks.testQuality.mutation', 'exclude', 'excludePaths'],
        ])('rejects %s.%s on disk with the allowed keys', async (parent, retired, replacement) => {
          const reader = await freshReader();
          const config = structuredClone(active());
          config.tests = { paths: { all: ['*.spec'], acceptance: ['*.spec'], support: [] },
            run: { command: 'go test', reportPaths: ['out/*.xml'], tagComment: '//' } };
          config.code = { paths: ['*.go'], compile: 'none' };
          const section = parent.split('.').reduce((entry, key) => entry[key], config);
          section[retired] = section[replacement];
          if (position === 'alone') delete section[replacement];
          write(config);
          const error = refusal(() => reader.readConfig(root));
          expect(error).toBeInstanceOf(reader.TargetError);
          expect(error.message).toBe(`unknown "${parent}.${retired}". Allowed keys: ${allowed[parent]}. The workflow refuses to run without it. The operator edits .katatay/rulebook.json; src/schemas/rulebook.schema.json, in the folder 'ktty path' prints, describes its shape.`);
        });
      });

      it('uses all ten authoritative fields in a new-only rulebook', () => {
        write(active());
        const config = readConfig(root);
        expect(parseTargetBranch(config).name).toBe('upstream/release/next');
        expect(plansDir(root)).toBe(join(root, 'drafts'));
        expect(parsePlanValidation(config)).toBe(false);
        expect(followUpsFile(root)).toBe('docs/NEXT.md');
        expect(requirementsDir(root)).toBe('criteria');
        expect(parseLockedPaths(config)).toEqual(['protected/**']);
        expect(readAgentAdapters(root).local.checkCommand).toBe('node check.mjs');
        expect(analysisRequired(config)).toBe(false);
        expect(allChecks(readChecks(root)).map(check => check.command)).toEqual(['read-lcov', 'mutate', 'lint']);
        expect(readMutation(root)).toMatchObject({ command: mutation.command, report: mutation.output, exclude: mutation.excludePaths });
      });

      // Each retired key is unknown both on its own and beside its replacement.
      it.each([
        ['', 'target', { baseline: 'origin/main' }, 'targetBranch'],
        ['', 'followUps', { file: 'LATER.md' }, 'followUpsFile'],
        ['', 'requirements', { folder: 'specs/' }, 'requirementsDir'],
        ['plans', 'folder', 'plans/', 'dir'],
        ['agent', 'locked', [], 'lockedPaths'],
        ['agent.adapters.local', 'commands', { check: 'node old.mjs' }, 'checkCommand'],
        ['checks', 'quality', disabled, 'testQuality'],
        ['checks', 'code', { lint }, 'codeQuality'],
        ['checks', 'reportAnalysis', true, 'requireAnalysis'],
        ['checks.testQuality.mutation', 'skip', [], 'excludePaths'],
      ])('refuses the retired key %s %s with or without its replacement', (parent, old, value, replacement) => {
        for (const mixed of [true, false]) {
          const config = structuredClone(active());
          const section = parent ? parent.split('.').reduce((entry, key) => entry[key], config) : config;
          if (!mixed) delete section[replacement];
          section[old] = value;
          write(config);
          const path = [parent, old].filter(Boolean).join('.');
          expect(() => readConfig(root)).toThrow(`unknown "${path}". Allowed keys:`);
        }
      });

      // A relative check command, so the case's JSON in the test name holds no
      // checkout path. readConfig only parses the command, never runs it.
      const namedAgent = (lockedPaths) => ({ lockedPaths, adapters: { claude: { extraHooks: { check: true, acknowledged: [] }, checkCommand: 'node check.mjs' } } });
      it.each([
        [{ targetBranch: null }, 'no "targetBranch" key, as in { "version": 1, "targetBranch": "origin/main" }'],
        [{ targetBranch: 'main' }, '"targetBranch": "main", which is not <remote>/<branch>'],
        [{ followUpsFile: '../LATER.md' }, '"followUpsFile" is'],
        [{ requirementsDir: '/specs/' }, '"requirementsDir" is'],
        [{ plans: { dir: ' ' } }, '"plans.dir" is'],
        [{ agent: namedAgent('src/**') }, '"agent.lockedPaths" must be a list'],
        [{ agent: namedAgent(['bad**']) }, '"agent.lockedPaths" holds a malformed glob'],
        [{ agent: { lockedPaths: [], adapters: { local: { checkCommand: ' ' } } } }, '"agent.adapters.local.checkCommand" must be a command'],
        [{ agent: { lockedPaths: [], adapters: { ' ': { checkCommand: 'ok' } } } }, 'must name each agent'],
      ])('refuses an invalid setting on load (%j)', (fields, diagnostic) => {
        write(rulebook(fields));
        expect(() => readConfig(root)).toThrow(diagnostic);
      });

      it.each([
        [{ plans: { dir: '.' } }, ['plans.dir', 'repository root']],
        [{ plans: { dir: 'specs/drafts' }, requirementsDir: 'specs/' }, ['plans.dir', 'requirementsDir', 'specs/']],
        [{ followUpsFile: 'specs/NEXT.md', requirementsDir: 'specs/' }, ['followUpsFile', 'requirementsDir', 'specs/']],
        [{ plans: { dir: 'locked' }, agent: namedAgent(['locked/**']) }, ['plans.dir', 'locked/**']],
        [{ plans: { dir: 'plans' }, agent: namedAgent(['plans/config.json']) }, ['plans.dir', 'agent.lockedPaths']],
        [{ followUpsFile: 'later/NEXT.md', agent: namedAgent(['later/**']) }, ['followUpsFile', 'agent.lockedPaths']],
        [{ followUpsFile: 'requirements/NEXT.md' }, ['followUpsFile', 'requirements/']],
      ])('checks path overlaps at load (%j)', (fields, expected) => {
        write(rulebook(fields));
        const error = refusal(() => readConfig(root));
        expect(error).toBeInstanceOf(TargetError);
        for (const part of expected) expect(error.message).toContain(part);
      });

      it('checks coverage folders and percentage limits before handing out the test command', () => {
        const config = structuredClone(active());
        const coverage = config.checks.testQuality.coverage;
        coverage.minimum = { 'src/': { lines: 0, branches: 100 }, 'lib/': { lines: 99.9, branches: 0.1 } };
        write(config);
        expect(readAdapter(root).testRun.command).toBe(config.tests.run.command);

        for (const [folder, lines, branches, problem] of [
          ['src', 0, 100, 'must end with "/"'],
          ['src/', -0.1, 100, 'lines minimum'],
          ['src/', 0, 100.1, 'branches minimum'],
          ['src/', 99.99, 0, 'lines minimum'],
          ['src/', 0, '90', 'branches minimum'],
        ]) {
          coverage.minimum = { [folder]: { lines, branches } };
          write(config);
          expect(() => readAdapter(root)).toThrow(problem);
        }
      });

      it('reports both missing floors for a null folder entry as separate sentences', () => {
        const entry = { ...coverage, minimum: { 'src/': null } };
        write(rulebook({ checks: { testQuality: { coverage: entry, mutation: 'none' } } }));
        const error = refusal(() => readConfig(root));
        expect(error).toBeInstanceOf(TargetError);
        expect(error.message).toContain('"checks.testQuality.coverage.minimum": src/: the lines minimum');
        expect(error.message).toContain('and is undefined. src/: the branches minimum');
      });

      it.each([
        [{ requireAnalysis: 'false' }, '"checks.requireAnalysis" must be true or false'],
        [{ testQuality: null }, '"checks.testQuality" must be an object'],
        [{ testQuality: { mutation: 'none' } }, 'no "checks.testQuality.coverage" entry'],
        [{ testQuality: { coverage: 'none' } }, 'no "checks.testQuality.mutation" entry'],
        [{ codeQuality: [] }, '"checks.codeQuality" must be an object'],
        [{ codeQuality: { lint: { ...lint, command: '' } } }, '"checks.codeQuality.lint.command" must be a command'],
        [{ testQuality: { ...disabled, lint }, codeQuality: { lint } }, '"checks.codeQuality.lint": two checks are named "lint"'],
        [{ testQuality: { coverage: 'none', mutation }, codeQuality: { lint: { ...lint, output: mutation.output } } }, '"checks.codeQuality.lint": two checks write "reports/mutation.json"'],
        [{ testQuality: { coverage, mutation: { ...mutation, output: coverage.output } } }, '"checks.testQuality.mutation": two checks write "reports/coverage.json"'],
        [{ testQuality: { ...disabled, mutation: { ...mutation, output: '../result' } } }, '"checks.testQuality.mutation.output" must be one repository-relative output file'],
        [{ testQuality: { ...disabled, mutation: { ...mutation, excludePaths: null } } }, '"checks.testQuality.mutation.excludePaths" must be a list'],
        [{ testQuality: { ...disabled, mutation: { ...mutation, excludePaths: ['bad**'] } } }, '"checks.testQuality.mutation.excludePaths" holds a malformed glob'],
        [{ testQuality: { ...disabled, coverage: { ...coverage, exclude: [] } } }, 'unknown "checks.testQuality.coverage.exclude"'],
        [{ codeQuality: { lint: { ...lint, exclude: [] } } }, 'unknown "checks.codeQuality.lint.exclude"'],
        [{ testQuality: { ...disabled, lint: { ...lint, exclude: [] } } }, 'unknown "checks.testQuality.lint.exclude"'],
        [{ testQuality: { ...disabled, coverage: { ...coverage, minimum: { 'src/': { lines: 90, branches: 101 } } } } }, '"checks.testQuality.coverage.minimum": src/: the branches minimum must be a number from 0 to 100'],
        [{ testQuality: { ...disabled, coverage: { ...coverage, minimum: { 'src/': { lines: 1e-10, branches: 90 } } } } }, 'the lines minimum must be a number from 0 to 100 with at most one decimal, and is 1e-10'],
      ])('identifies the invalid setting in the check chains (%j)', (proposed, diagnostic) => {
        write(rulebook({ checks: { testQuality: disabled, ...proposed } }));
        expect(() => readConfig(root)).toThrow(diagnostic);
      });
    });

    // The freeze asks once per file in the repository.
    it('keeps the parsed file while it is unchanged, and reads it again when its size or time changes', () => {
      write(rulebook());
      const first = readConfig(root);
      expect(readConfig(root)).toBe(first);
      write(rulebook({ requirementsDir: 'specs/' }));
      const second = readConfig(root);
      expect(second).not.toBe(first);
      const same = JSON.stringify(rulebook({ requirementsDir: 'specs/' }));
      writeFileSync(join(root, CONFIG), same.replace('specs', 'docs/'));
      utimesSync(join(root, CONFIG), new Date(0), new Date(0));
      expect(readConfig(root)).not.toBe(second);
    });

    // Either one alone must be enough to read the file again: a rewrite of the
    // same length, and a rewrite that lands on the same time.
    it('reads the file again when only its time changes, and when only its size changes', () => {
      const path = join(root, CONFIG);
      const put = (folder, time) => {
        write(rulebook({ requirementsDir: folder }));
        utimesSync(path, time, time);
      };
      put('aaaa/', new Date(1_000_000));
      const first = readConfig(root);
      expect(readConfig(root)).toBe(first);
      put('bbbb/', new Date(2_000_000));
      expect(statSync(path).size).toBe(JSON.stringify(rulebook({ requirementsDir: 'aaaa/' })).length);
      const second = readConfig(root);
      expect(second).not.toBe(first);
      expect(second.requirementsDir).toBe('bbbb/');
      put('cccccc/', new Date(2_000_000));
      const third = readConfig(root);
      expect(third).not.toBe(second);
      expect(third.requirementsDir).toBe('cccccc/');
    });

    it.each([
      [undefined, 'has no "highRisk" list'],
      [[{ paths: ['db/{a'], why: 'Migrations' }], '"highRisk[0]".paths holds a malformed glob'],
      [[{ paths: ['db/**'], why: ' ' }], '"highRisk[0]".why must say why'],
    ])('refuses every reader when highRisk is invalid (%j)', (highRisk, problem) => {
      write(rulebook({ highRisk }));
      const error = refusal(() => readConfig(root));
      expect(error).toBeInstanceOf(TargetError);
      expect(error.message).toContain(problem);
      expect(error.message).toContain('The operator edits .katatay/rulebook.json');
      const adapterError = refusal(() => readAdapter(root));
      expect(adapterError).toBeInstanceOf(AdapterError);
      expect(adapterError.message).toBe(error.message);
      expect(() => readChecks(root)).toThrow(error.message);
      expect(() => requirementsDir(root)).toThrow(error.message);
      expect(() => highRiskAreas(['a.ts'], root)).toThrow(error.message);
    });

    it.each([
      ['tests', '"tests.paths"'],
      ['code', '"code.paths"'],
      ['targetBranch', 'no "targetBranch" key'],
      ['checks', 'no "checks" object'],
    ])('refuses an unrelated setting when %s is missing', (key, diagnostic) => {
      write(rulebook({ [key]: undefined }));
      expect(() => requirementsDir(root)).toThrow(diagnostic);
    });

    it('refuses an unrelated setting when a report glob has no literal folder', () => {
      const config = rulebook();
      config.tests.run.reportPaths = ['**/*.xml'];
      write(config);
      expect(() => readChecks(root)).toThrow('"tests.run.reportPaths" holds "**/*.xml"');
    });

    it('reads corrected settings after an invalid edit in the same process', () => {
      const config = rulebook();
      write(config);
      const before = readAdapter(root);
      expect(readAdapter(root)).toBe(before);

      config.highRisk = [{ paths: ['db/**'], why: '' }];
      write(config);
      expect(() => readAdapter(root)).toThrow('"highRisk[0]".why');
      expect(() => readConfig(root)).toThrow('"highRisk[0]".why');

      config.highRisk[0].why = 'Every database runs these migrations.';
      config.tests.run.command = 'npm run updated-suite';
      write(config);
      const after = readAdapter(root);
      expect(after).not.toBe(before);
      expect(after.testRun.command).toBe('npm run updated-suite');
      expect(readAdapter(root)).toBe(after);
    });

    it('reads the mutation settings and the requirements folder from the file', () => {
      write(rulebook({ requirementsDir: 'specs/', checks: mutationChecks(fixtureMutation({ timeLimitSeconds: 30, excludePaths: ['x/**'] })) }));
      expect(readMutation(root)).toMatchObject({ timeLimitSeconds: 30, exclude: ['x/**'] });
      expect(requirementsPrefix(root)).toBe('specs/');
    });
  });
});

describe('the high-risk areas', () => {
  const area = (over = {}) => ({ paths: ['db/**'], why: 'Every database runs them.', ...over });
  const refused = (highRisk) => refusal(() => parseHighRisk({ highRisk })).message;

  it('are refused when the list is missing, and an empty list is the way to say there are none', () => {
    expect(refusal(() => parseHighRisk({})).message).toMatch(/has no "highRisk" list\. Write \[\] if no files are high-risk/);
    expect(parseHighRisk({ highRisk: [] })).toEqual([]);
  });

  it('are refused unless each is paths and a reason', () => {
    expect(refused([null])).toContain('"highRisk[0]" must be');
    expect(refused([area(), 'db/**'])).toContain('"highRisk[1]" must be');
    for (const paths of [undefined, [], 'db/**', [5], ['']]) expect(refused([area({ paths })]), JSON.stringify(paths)).toContain('"highRisk[0]".paths must be a non-empty list of globs');
    for (const why of [undefined, '', '   ', 5]) expect(refused([area({ why })]), JSON.stringify(why)).toContain('"highRisk[0]".why must say why');
  });

  it('are refused for a malformed glob, rather than matching nothing later', () => {
    expect(refused([area({ paths: ['db/{a'] })])).toMatch(/"highRisk\[0\]"\.paths holds a malformed glob/);
  });

  it('list the changed files of each area under that area\'s reason, in the order the rulebook gives', () => {
    const root = mkdtempSync(join(tmpdir(), 'rulebook-areas-'));
    try {
      mkdirSync(join(root, '.katatay'));
      writeFileSync(join(root, CONFIG), JSON.stringify(rulebook({
        highRisk: [area(), area({ paths: ['ci/**', 'Makefile'], why: 'These change what does the checking.' })],
      })));
      expect(highRiskAreas(['Makefile', 'src/a.ts', 'db/0001.sql', 'ci/build.yml', 'db/0002.sql'], root)).toEqual([
        { why: 'Every database runs them.', items: ['db/0001.sql', 'db/0002.sql'] },
        { why: 'These change what does the checking.', items: ['Makefile', 'ci/build.yml'] },
      ]);
      expect(highRiskAreas(['src/a.ts'], root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Each area has its own reason, and the reviewer reads the reason.
  it('list a file under every area it is in', () => {
    const root = mkdtempSync(join(tmpdir(), 'rulebook-twice-'));
    try {
      mkdirSync(join(root, '.katatay'));
      writeFileSync(join(root, CONFIG), JSON.stringify(rulebook({ highRisk: [area({ paths: ['db/**'], why: 'one' }), area({ paths: ['**/*.sql'], why: 'two' })] })));
      expect(highRiskAreas(['db/a.sql'], root)).toEqual([{ why: 'one', items: ['db/a.sql'] }, { why: 'two', items: ['db/a.sql'] }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Lowering a floor passes the coverage check with no test written. A rulebook
  // that could leave itself off the list could hide that edit.
  it('always list the rulebook first, whatever the rulebook says', () => {
    const root = mkdtempSync(join(tmpdir(), 'rulebook-own-'));
    try {
      mkdirSync(join(root, '.katatay'));
      writeFileSync(join(root, CONFIG), JSON.stringify(rulebook({ highRisk: [area({ paths: ['**'], why: 'everything' })] })));
      expect(highRiskAreas(['db/a.sql', CONFIG], root)).toEqual([
        { why: RULEBOOK_WHY, items: [CONFIG] },
        { why: 'everything', items: ['db/a.sql', CONFIG] },
      ]);
      writeFileSync(join(root, CONFIG), JSON.stringify(rulebook({ highRisk: [] })));
      expect(highRiskAreas([CONFIG], root)).toEqual([{ why: RULEBOOK_WHY, items: [CONFIG] }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lists the changed writer only when selected by a high-risk area', () => {
    const root = mkdtempSync(join(tmpdir(), 'rulebook-writer-'));
    try {
      mkdirSync(join(root, '.katatay'));
      const writer = 'tools/report/junit.mjs';
      const { tests } = rulebook();
      tests.paths.support = [];
      tests.run.command = 'node ' + writer;
      const setAreas = highRisk => writeFileSync(join(root, CONFIG), JSON.stringify(rulebook({ tests, highRisk })));
      setAreas([]);
      expect(highRiskAreas([writer], root)).toEqual([]);
      tests.paths.support.push(writer);
      setAreas([]);
      expect(highRiskAreas([writer], root)).toEqual([]);
      tests.paths.support = [];
      setAreas([area({ paths: [writer], why: 'Writes test evidence' })]);
      expect(highRiskAreas([writer, CONFIG], root)).toEqual([
        { why: RULEBOOK_WHY, items: [CONFIG] }, { why: 'Writes test evidence', items: [writer] },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

});

describe('the named agent adapters', () => {
  const entry = { checkCommand: 'node check.mjs' };
  const parse = (adapters) => parseAgentAdapters({ agent: { adapters } });

  it('keeps each adapter and its configured entry order', () => {
    const adapters = { second: entry, first: { ...entry, extraHooks: { check: false } } };
    expect(parse(adapters)).toEqual(adapters);
    expect(Object.keys(parse(adapters))).toEqual(['second', 'first']);
    expect(parse({ only: entry })).toEqual({ only: entry });
  });

  it('refuses malformed sections and adapter entries', () => {
    for (const agent of [null, [], 'claude']) expect(refusal(() => parseAgentAdapters({ agent })).message).toContain('"agent" must be an object');
    for (const adapters of [null, [], 'node x']) expect(refusal(() => parse(adapters)).message).toContain('"agent.adapters" must be an object');
    for (const local of [null, [], 'node x']) expect(refusal(() => parse({ local })).message).toContain('"agent.adapters.local" must be an object');
    for (const name of ['', '  ']) expect(refusal(() => parse({ [name]: entry })).message).toContain('must name each agent');
    expect(refusal(() => parse({ local: {} })).message).toContain('"agent.adapters.local.checkCommand" must be a command');
    for (const check of [undefined, '', '  ', 5, null]) expect(refusal(() => parse({ local: { checkCommand: check } })).message).toContain('"agent.adapters.local.checkCommand" must be a command');
    expect(refusal(() => parse({ local: { checkCommand: 'node x', launch: 'node y' } })).message).toContain('unknown "agent.adapters.local.launch". Allowed keys: checkCommand');
  });
});

describe('the checks', () => {
  const EXITS = { 0: 'clean', 1: 'findings' };
  const check = (over = {}) => ({ command: 'make lint', exitCodes: EXITS, ...over });
  const chains = (checks) => parseChecks({ checks });
  const refused = (checks) => refusal(() => chains(checks)).message;
  const broken = (over) => refused({ codeQuality: { lint: check(over) } });

  it('accepts the analysis toggle only as a boolean alongside the two chains', () => {
    const checks = { testQuality: { coverage: 'none', mutation: 'none' }, codeQuality: { lint: check() } };
    for (const requireAnalysis of [true, false]) {
      expect(allChecks(chains({ ...checks, requireAnalysis })).map(c => c.name)).toEqual(['lint']);
    }
    expect(refused({ ...checks, requireAnalysis: 'false' })).toContain('"checks.requireAnalysis" must be true or false');
    expect(refused({ ...checks, checksReportAnalysis: true })).toContain('unknown "checks.checksReportAnalysis"');
  });

  it('require an explicit coverage choice even when there are other checks', () => {
    for (const checks of [{}, { codeQuality: { lint: check() } }, { testQuality: {} }, { testQuality: { lint: check() } }]) {
      const error = refusal(() => chains(checks));
      expect(error).toBeInstanceOf(TargetError);
      expect(error.message).toMatch(/"checks\.testQuality\.coverage".*"none".*switch coverage off/);
    }
  });

  it('are refused when the section is missing or not an object', () => {
    for (const checks of [undefined, null, [], 'build']) expect(refused(checks), JSON.stringify(checks)).toContain('has no "checks" object');
  });

  it('fill in always, block and 300 seconds for what an entry leaves out', () => {
    const [lint] = chains({ testQuality: { mutation: 'none', coverage: 'none' }, codeQuality: { lint: check() } }).codeQuality;
    expect(lint).toMatchObject({ name: 'lint', chain: 'codeQuality', command: 'make lint', runs: 'always', onFailure: 'block', timeLimitSeconds: 300, suppressions: [] });
    expect(CHECK_TIME_LIMIT).toBe(300);
  });

  it('keep what an entry says', () => {
    const over = { runs: 'oncePerPlan', onFailure: 'report', timeLimitSeconds: 30, suppressions: ['eslint-disable'] };
    expect(chains({ testQuality: { mutation: 'none', coverage: 'none', lint: check(over) } }).testQuality[0]).toMatchObject(over);
  });

  it('keep each chain in the order the rulebook lists it, the quality chain first', () => {
    const read = chains({ codeQuality: { b: check(), a: check() }, testQuality: { mutation: 'none', coverage: 'none', z: check() } });
    expect(allChecks(read).map(({ name, chain }) => `${chain}.${name}`)).toEqual(['testQuality.z', 'codeQuality.b', 'codeQuality.a']);
  });

  it.each([[true, true], [true, false], [false, true], [false, false]])(
    'schedules built-in quality checks before other checks regardless of property order (coverage=%s, mutation=%s)', (coverage, mutation) => {
      const parsed = chains({
        testQuality: {
          z: check(),
          mutation: mutation ? fixtureMutation() : 'none',
          a: check(),
          coverage: coverage ? { command: 'cat lcov.info', output: 'reports/coverage.json', minimum: { 'src/': { lines: 0, branches: 0 } } } : 'none',
        },
        codeQuality: { y: check(), x: check() },
      });
      expect(allChecks(parsed).map(item => item.name)).toEqual([
        ...(coverage ? ['coverage'] : []), ...(mutation ? ['mutation'] : []), 'z', 'a', 'y', 'x',
      ]);
    });

  // A rulebook nobody updated must not read as having no checks.
  it('refuse a check written as a name and a command, and show the shape now', () => {
    const message = refused({ build: 'npm run build' });
    expect(message).toContain('unknown "checks.build"');
    expect(message).toContain('Allowed keys: testQuality, codeQuality');
    expect(refused({ codeQuality: { build: 'npm run build' } })).toContain('"checks.codeQuality.build" must be an object');
  });

  it('refuse a key that is not a chain, and a chain that is not an object', () => {
    expect(refused({ lint: {} })).toContain('unknown "checks.lint". Allowed keys: testQuality, codeQuality');
    for (const code of [null, [], 'x']) expect(refused({ codeQuality: code }), JSON.stringify(code)).toContain('"checks.codeQuality" must be an object');
  });

  it('refuse an entry that is not an object, or has no command', () => {
    for (const entry of [null, [], 5]) expect(refused({ codeQuality: { lint: entry } }), JSON.stringify(entry)).toContain('"checks.codeQuality.lint" must be an object');
    for (const command of [undefined, '', '  ', 5]) expect(broken({ command }), JSON.stringify(command)).toContain('"checks.codeQuality.lint.command" must be a command');
  });

  // A misspelt key would otherwise be a setting nobody configured.
  it('refuse a key a check does not have', () => {
    expect(broken({ config: ['a.json'] })).toContain('unknown "checks.codeQuality.lint.config"');
    expect(broken({ blocks: true })).toContain('unknown "checks.codeQuality.lint.blocks"');
  });

  it('read exit codes one by one or as ranges, each to what it means', () => {
    const testQuality = { coverage: 'none', mutation: 'none' };
    const [lint] = chains({ testQuality, codeQuality: { lint: check({ exitCodes: { 0: 'clean', '1-3': 'findings', 255: 'broken' } }) } }).codeQuality;
    expect(lint.exitCodes).toEqual({ 0: 'clean', 1: 'findings', 2: 'findings', 3: 'findings', 255: 'broken' });
    expect(chains({ testQuality, codeQuality: { lint: check({ exitCodes: { 0: 'clean', '1-255': 'findings' } }) } }).codeQuality[0].exitCodes[255]).toBe('findings');
  });

  it('refuse exit codes that are not a map, or a key that is not a code or a range of them', () => {
    for (const exitCodes of [undefined, null, [0, 1], 'clean']) {
      expect(broken({ exitCodes }), JSON.stringify(exitCodes)).toContain('must map each exit code, or a range such as "1-255"');
    }
    for (const key of ['-1', '256', '1.5', 'one', '01', '', '3-1', '1-256', '1-', '-3']) {
      expect(broken({ exitCodes: { ...EXITS, [key]: 'broken' } }), key).toContain(`names ${JSON.stringify(key)}, which is not an exit code from 0 to 255`);
    }
  });

  it('refuse a meaning it does not know, and a code named twice', () => {
    for (const meaning of ['errors', 'Clean', 0, null]) {
      expect(broken({ exitCodes: { ...EXITS, 2: meaning } }), JSON.stringify(meaning)).toContain(`means ${JSON.stringify(meaning)}, which is not one of clean, findings, broken`);
    }
    expect(broken({ exitCodes: { 0: 'clean', '1-5': 'findings', 3: 'broken' } })).toContain('"checks.codeQuality.lint.exitCodes" names exit 3 twice');
  });

  // Without both, a clean run and a run that found something look the same.
  it('refuse exit codes without one that means clean, or one that means findings', () => {
    expect(broken({ exitCodes: { 1: 'findings' } })).toContain('has no code that means "clean"');
    expect(broken({ exitCodes: { 0: 'clean', 2: 'broken' } })).toContain('has no code that means "findings"');
  });

  it('refuse a value runs, onFailure or the time limit cannot be', () => {
    for (const runs of ['verify', 'plan', 'once', 5, null]) expect(broken({ runs }), JSON.stringify(runs)).toContain('"checks.codeQuality.lint.runs" must be one of always, oncePerPlan, or left out for always');
    for (const onFailure of ['blocks', true, null]) expect(broken({ onFailure }), JSON.stringify(onFailure)).toContain('"checks.codeQuality.lint.onFailure" must be one of block, report, or left out for block');
    for (const timeLimitSeconds of [0, -5, 1.5, '30', null]) {
      expect(broken({ timeLimitSeconds }), JSON.stringify(timeLimitSeconds)).toContain('"checks.codeQuality.lint.timeLimitSeconds" must be a positive whole number');
    }
  });

  it('read skipInCi as false when left out, and keep true or false beside either runs', () => {
    const testQuality = { coverage: 'none', mutation: 'none' };
    expect(chains({ testQuality, codeQuality: { lint: check() } }).codeQuality[0].skipInCi).toBe(false);
    for (const runs of ['always', 'oncePerPlan']) {
      for (const skipInCi of [true, false]) {
        expect(chains({ testQuality, codeQuality: { lint: check({ runs, skipInCi }) } }).codeQuality[0]).toMatchObject({ runs, skipInCi });
        expect(chains({ testQuality: { ...testQuality, lint: check({ runs, skipInCi }) } }).testQuality[0]).toMatchObject({ runs, skipInCi });
      }
    }
  });

  // A string such as "false" would otherwise read as true.
  it('refuse a skipInCi that is not true or false', () => {
    for (const skipInCi of ['true', 'false', 1, 0, null, []]) {
      expect(broken({ skipInCi }), JSON.stringify(skipInCi)).toContain('"checks.codeQuality.lint.skipInCi" must be true or false');
    }
  });

  it('refuse suppressions that are not a list of regular expressions', () => {
    for (const suppressions of ['nosec', [5], ['']]) expect(broken({ suppressions }), JSON.stringify(suppressions)).toContain('"checks.codeQuality.lint.suppressions" must be a list');
    expect(broken({ suppressions: ['(unclosed'] })).toContain('"checks.codeQuality.lint.suppressions" holds a malformed regular expression');
  });

  // Verify reports a failure by the step's name, so two of one name, or a
  // check named like one of verify's own steps, would leave it ambiguous.
  it('refuse a name used twice across the chains, and the names the referee keeps', () => {
    expect(refused({ testQuality: { lint: check() }, codeQuality: { lint: check() } })).toContain('two checks are named "lint"');
    for (const name of RESERVED_CHECK_NAMES) expect(refused({ codeQuality: { [name]: check() } }), name).toContain('uses a name the referee keeps for itself');
    expect(refused({ codeQuality: { ' ': check() } })).toContain('must name each check');
  });
});

describe('the mutation settings', () => {
  const check = (over) => parseChecks({ checks: mutationChecks(fixtureMutation(over)) }).testQuality[0];
  const refused = (over) => refusal(() => check(over)).message;

  it('keeps the configured report, limit, skips and suppressions with fixed execution policy', () => {
    const fields = { report: 'results/custom.json', timeLimitSeconds: 90, exclude: ['a/**'], suppressions: ['Stryker disable'] };
    const { report: output, exclude: excludePaths, ...settings } = fields;
    expect(check({ ...settings, output, excludePaths })).toMatchObject({ ...fields, onFailure: 'report', runs: 'oncePerPlan', exitCodes: { 0: 'clean', 1: 'findings', 2: 'findings' } });
  });

  it('requires an explicit mutation choice and refuses misspelled or conflicting settings', () => {
    expect(refused({ runs: 'once' })).toContain('or left out for oncePerPlan');
    expect(refused({ onFailure: 'warn' })).toContain('or left out for report');
    for (const testQuality of [{ coverage: 'none' }, { coverage: 'none', mutaton: 'none' }]) {
      expect(() => parseChecks({ checks: { testQuality } })).toThrow();
    }
    expect(parseChecks({ checks: mutationChecks('none') }).testQuality).toEqual([]);
    for (const fields of [{ enabled: false }, { runs: 'always' }, { onFailure: 'block' }, { exitCodes: { 1: 'clean' } }, { command: 'none' }]) expect(() => check(fields)).toThrow();
    for (const legacy of [{ testQuality: { mutation: {} } }, { language: { commands: { mutate: 'none' } } }, { language: { mutation: {} } }]) {
      expect(() => parseChecks({ checks: mutationChecks(), ...legacy })).toThrow(/unknown "/);
    }
  });

  it('requires a repository-relative report and a positive time limit', () => {
    for (const report of [undefined, 'none', '../a.json', '/tmp/a.json', 'a/*.json', 'C:/a.json', ['a.json']]) expect(refused({ output: report })).toContain('checks.testQuality.mutation.output');
    for (const timeLimitSeconds of [0, -5, 1.5, '240', null]) expect(refused({ timeLimitSeconds })).toContain('timeLimitSeconds');
  });

  it('keeps skipInCi beside the fixed once-per-plan policy, false when left out', () => {
    expect(check()).toMatchObject({ skipInCi: false, runs: 'oncePerPlan' });
    expect(check({ skipInCi: true })).toMatchObject({ skipInCi: true, runs: 'oncePerPlan', onFailure: 'report' });
    expect(check({ skipInCi: false, runs: 'oncePerPlan' })).toMatchObject({ skipInCi: false });
    for (const skipInCi of ['true', 1, null]) expect(refused({ skipInCi }), JSON.stringify(skipInCi)).toContain('"checks.testQuality.mutation.skipInCi" must be true or false');
  });

  it('need a list of globs to skip, empty if none, each of them well formed', () => {
    for (const skip of [undefined, 'a/**', [5], ['']]) expect(refused({ excludePaths: skip }), JSON.stringify(skip)).toContain('"checks.testQuality.mutation.excludePaths" must be a list of globs');
    expect(refused({ excludePaths: ['a/{b'] })).toContain('"checks.testQuality.mutation.excludePaths" holds a malformed glob');
  });
});

describe('the coverage floors', () => {
  const coverage = (over) => parseChecks({ checks: { testQuality: { mutation: 'none', coverage: { command: 'cat lcov.info', output: 'reports/coverage.json', minimum: { 'src/': { lines: 0, branches: 0 } }, ...over } } } }).testQuality[0];

  // Enabled coverage measures every tree, CI's included.
  it('refuse skipInCi true on coverage, and accept false or leaving it out', () => {
    expect(refusal(() => coverage({ skipInCi: true })).message).toContain('"checks.testQuality.coverage" must run on every verify, so it cannot skip CI');
    expect(coverage({ skipInCi: false }).skipInCi).toBe(false);
    expect(coverage({}).skipInCi).toBe(false);
    for (const skipInCi of ['true', 1, null]) {
      expect(refusal(() => coverage({ skipInCi })).message, JSON.stringify(skipInCi)).toContain('"checks.testQuality.coverage.skipInCi" must be true or false');
    }
  });

});

describe('the requirements folder', () => {
  const folder = (value) => parseRequirementsDir({ requirementsDir: value });

  it('is requirements unless the rulebook says otherwise', () => {
    expect(parseRequirementsDir({})).toBe('requirements');
    expect(parseRequirementsDir({ requirementsDir: undefined })).toBe('requirements');
  });

  it('is the folder given, without its trailing slash', () => {
    expect(folder('specs/')).toBe('specs');
    expect(folder('specs')).toBe('specs');
    expect(folder('docs/specs//')).toBe('docs/specs');
    expect(folder('  specs/  ')).toBe('specs');
  });

  // The guard reads the folder out of git. A path outside the repository names
  // files git does not hold.
  it('is refused unless it is a folder inside the repository', () => {
    for (const value of ['/etc', '../outside', 'a/../b', './specs', 'a//b', '', '/', '.', 5, null, 'a\\b']) {
      expect(refusal(() => folder(value)).message, JSON.stringify(value)).toContain('"requirementsDir"');
    }
    expect(refusal(() => parseRequirementsDir({ requirementsDir: {} })).message).toContain('"requirementsDir" is {}, which is not a folder');
  });

  it('is the folder without its slash, and the prefix with it for pathspecs', () => {
    const root = mkdtempSync(join(tmpdir(), 'rulebook-requirements-'));
    try {
      mkdirSync(join(root, '.katatay'));
      writeFileSync(join(root, CONFIG), JSON.stringify(rulebook({ requirementsDir: 'specs/' })));
      expect(requirementsDir(root)).toBe('specs');
      expect(requirementsPrefix(root)).toBe('specs/');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the target branch', () => {
  const baseline = (value) => parseTargetBranch({ version: 1, targetBranch: value });

  it('splits the target branch at the first slash, and names the remote-tracking ref', () => {
    expect(baseline('origin/release/2026')).toEqual({ remote: 'origin', branch: 'release/2026', ref: 'refs/remotes/origin/release/2026', name: 'origin/release/2026' });
  });

  it('is refused when absent, blank or not a string', () => {
    for (const config of [{}, { targetBranch: null }, { targetBranch: '' }, { targetBranch: '   ' }, { targetBranch: 5 }]) {
      const error = refusal(() => parseTargetBranch(config));
      expect(error, JSON.stringify(config)).toBeInstanceOf(TargetError);
      expect(error.message, JSON.stringify(config)).toContain('has no "targetBranch" key');
    }
  });

  it('is refused unless it is <remote>/<branch>', () => {
    for (const value of ['main', '/main', 'origin/']) expect(refusal(() => baseline(value)).message, value).toMatch(/is not <remote>\/<branch>/);
  });
});

describe('the plans folder', () => {
  it('is required, and kept as written', () => {
    expect(parsePlansDir(rulebook({ plans: { dir: '~/.claude/plans' } }))).toBe('~/.claude/plans');
    const { plans, ...none } = rulebook();
    expect(plans).toBeDefined();
    expect(refusal(() => parsePlansDir(none)).message).toContain('"plans.dir" is undefined, which is not a folder');
  });

  it('is refused when it is not a folder name', () => {
    for (const folder of ['', '  ', 3, 'a\\b', undefined]) {
      expect(refusal(() => parsePlansDir(rulebook({ plans: { dir: folder } }))).message).toMatch(/"plans\.dir" is .*which is not a folder/);
    }
  });

  it('is resolved from the repository root, the home folder or itself', () => {
    expect(resolvePath('plans/', '/repo', '/home/me')).toBe('/repo/plans');
    expect(resolvePath('~/.claude/plans', '/repo', '/home/me')).toBe('/home/me/.claude/plans');
    expect(resolvePath('~', '/repo', '/home/me')).toBe('/home/me');
    expect(resolvePath('/srv/plans', '/repo', '/home/me')).toBe('/srv/plans');
  });
});

describe('the follow-ups file', () => {
  it('is FOLLOW-UPS.md unless the rulebook names another', () => {
    expect(DEFAULT_FOLLOW_UPS).toBe('FOLLOW-UPS.md');
    expect(parseFollowUpsFile(rulebook())).toBe('FOLLOW-UPS.md');
    expect(parseFollowUpsFile(rulebook({ followUpsFile: undefined }))).toBe('FOLLOW-UPS.md');
    expect(parseFollowUpsFile(rulebook({ followUpsFile: 'docs/later.md' }))).toBe('docs/later.md');
  });

  it('is read without the spaces around it', () => {
    expect(parseFollowUpsFile(rulebook({ followUpsFile: '  docs/later.md  ' }))).toBe('docs/later.md');
  });

  it('is refused unless it is a Markdown file inside the repository', () => {
    for (const file of ['', '../LATER.md', '/tmp/LATER.md', '~/LATER.md', './LATER.md', 'docs//LATER.md', 'LATER.txt', 'a\\b.md', 3]) {
      expect(refusal(() => parseFollowUpsFile(rulebook({ followUpsFile: file }))).message, String(file))
        .toMatch(/"followUpsFile" is .*which is not a Markdown file inside the repository/);
    }
    expect(refusal(() => parseFollowUpsFile(rulebook({ followUpsFile: {} }))).message).toMatch(/"followUpsFile" is .*which is not a Markdown file/);
  });
});

describe('the agent\'s locked files', () => {
  it('are the list as written, including an explicit empty list', () => {
    expect(parseLockedPaths(rulebook({ agent: { lockedPaths: ['.claude/settings.json', '~/.claude/settings.json'] } })))
      .toEqual(['.claude/settings.json', '~/.claude/settings.json']);
    expect(parseLockedPaths({ agent: { lockedPaths: [] } })).toEqual([]);
    expect(() => parseLockedPaths({})).toThrow('"agent" must be an object');
  });

  // A missing list would read as nothing to lock, and nobody would have said so.
  it('are required whenever there is an agent section', () => {
    expect(refusal(() => parseLockedPaths(rulebook({ agent: { commands: {} } }))).message)
      .toMatch(/"agent\.lockedPaths" must be a list .*Write \[\] if there are none/);
  });

  it('are refused when the agent section is not an object', () => {
    expect(refusal(() => parseLockedPaths(rulebook({ agent: 'claude' }))).message).toMatch(/"agent" must be an object/);
  });

  it('are refused when an entry is not a glob', () => {
    expect(refusal(() => parseLockedPaths(rulebook({ agent: { lockedPaths: [''] } }))).message).toMatch(/"agent\.lockedPaths" must be a list/);
    expect(refusal(() => parseLockedPaths(rulebook({ agent: { lockedPaths: ['a**'] } }))).message).toMatch(/"agent\.lockedPaths" holds a malformed glob/);
  });
});

describe("each adapter's extra-hooks check", () => {
  const parse = (extraHooks) => parseExtraHooks({ extraHooks }, 'local');

  it('is on with nothing acknowledged unless the adapter entry says otherwise', () => {
    expect(parse()).toEqual({ check: true, acknowledged: [] });
    expect(parse({})).toEqual({ check: true, acknowledged: [] });
    expect(parse({ check: false })).toEqual({ check: false, acknowledged: [] });
  });

  it('reads the switch and each hook, with no matcher meaning an empty one', () => {
    expect(parse({ check: false, acknowledged: [{ event: 'Stop', command: 'notify.sh' }, { event: 'PreToolUse', matcher: 'Bash', command: 'rtk hook claude' }] })).toEqual({
      check: false,
      acknowledged: [{ event: 'Stop', matcher: '', command: 'notify.sh' }, { event: 'PreToolUse', matcher: 'Bash', command: 'rtk hook claude' }],
    });
  });

  it('refuses malformed settings with the configured name', () => {
    for (const extra of [null, [], 'on', 3]) expect(refusal(() => parse(extra)).message).toContain('"agent.adapters.local.extraHooks" must be an object');
    for (const check of [null, 'yes', 0]) expect(refusal(() => parse({ check })).message).toContain('"agent.adapters.local.extraHooks.check" must be true or false');
    for (const acknowledged of [null, {}, 'all']) expect(refusal(() => parse({ acknowledged })).message).toContain('"agent.adapters.local.extraHooks.acknowledged" must be a list');
    for (const entry of [null, [], 'hook']) expect(refusal(() => parse({ acknowledged: [entry] })).message).toContain('"agent.adapters.local.extraHooks.acknowledged[0]" must be');
    for (const event of [undefined, '', 3]) expect(refusal(() => parse({ acknowledged: [{ event, command: 'x' }] })).message).toContain('.event must name a hook event');
    for (const matcher of [null, 3]) expect(refusal(() => parse({ acknowledged: [{ event: 'Stop', matcher, command: 'x' }] })).message).toContain('.matcher must be a string');
    for (const command of [undefined, '', 3]) expect(refusal(() => parse({ acknowledged: [{ event: 'Stop', command }] })).message).toContain('.command must be the hook');
  });
});

/**
 * Plans and follow-ups are written without a plan and left out of the tree
 * fingerprint, so a rulebook that points them at the wrong place ungates
 * edits. See "Folders the rulebook must not overlap" in src/agents/README.md.
 */
describe('the folders the rulebook must not overlap', () => {
  const ROOT = '/work/repo';
  const HOME = '/home/me';
  const gate = (over) => () => checkGating(rulebook(over), ROOT, HOME);
  const plansAt = (folder, agent = {}) => gate({ plans: { dir: folder }, agent: { ...bareSections().agent, ...agent } });

  it('refuse a plans folder at the repository root, however it is written, and say why in words', () => {
    for (const folder of ['.', './', ROOT, `${ROOT}/`]) {
      const error = refusal(plansAt(folder));
      expect(error).toBeInstanceOf(TargetError);
      expect(error.message).toContain(`The rulebook puts \`plans.dir\` at \`${folder}\`, the repository root.`);
      expect(error.message).toContain('every edit to the manifests, the README and the other files at the root would be ungated, and none would cancel a verified tree');
      expect(error.message).toContain('Point `plans.dir` at a folder of its own, such as `~/.katatay/plans`.');
      expect(error.message).toContain('The operator edits .katatay/rulebook.json.');
    }
  });

  // Only files directly in the folder are exempt, so nothing in a repository
  // below it is.
  it('accept a plans folder above the repository, or in a folder of its own inside it', () => {
    for (const folder of ['..', '~', '/', 'plans/', 'docs/plans', '~/.claude/plans']) {
      expect(plansAt(folder), folder).not.toThrow();
    }
  });

  it('refuse a plans folder under .katatay/ or .git/, and name the lock', () => {
    for (const [folder, lock] of [['.katatay', '.katatay/**'], ['.katatay/state', '.katatay/**'], ['.git/', '.git/**'], ['.git/hooks', '.git/**']]) {
      const { message } = refusal(plansAt(folder));
      expect(message, folder).toContain(`The rulebook puts \`plans.dir\` at \`${folder}\`, which overlaps the lock \`${lock}\``);
      expect(message).toContain('It would only make the file unwritable');
    }
  });

  it('do not take a folder whose name only starts like a lock for the lock', () => {
    expect(plansAt('.github')).not.toThrow();
    expect(plansAt('.workflows')).not.toThrow();
  });

  it('refuse a plans folder under a locked folder of the agent\'s', () => {
    const agent = { lockedPaths: ['.claude/hooks/**'] };
    expect(refusal(plansAt('.claude/hooks', agent)).message).toContain('overlaps the lock `.claude/hooks/**` from agent.lockedPaths: the rulebook locks it as the agent\'s own');
    expect(refusal(plansAt('.claude/hooks/deeper', agent)).message).toContain('overlaps the lock `.claude/hooks/**`');
  });

  it('refuse a plans folder that a locked file sits directly in, inside the repository or out', () => {
    const agent = { lockedPaths: ['.claude/settings.json', '~/.claude/settings.json'] };
    expect(refusal(plansAt('.claude', agent)).message).toContain('overlaps the lock `.claude/settings.json`');
    expect(refusal(plansAt('~/.claude', agent)).message).toContain('overlaps the lock `~/.claude/settings.json`');
    expect(refusal(plansAt(`${HOME}/.claude`, agent)).message).toContain('overlaps the lock `~/.claude/settings.json`');
    expect(plansAt('~/.claude/plans', agent)).not.toThrow();
    expect(plansAt('~', agent)).not.toThrow();
  });

  // A lock with no folder of its own names a file directly in its starting
  // folder, and a lock of `~` is that folder itself.
  it('refuse a plans folder at the home folder when a locked file sits directly in it, or the lock is the folder', () => {
    expect(refusal(plansAt('~', { lockedPaths: ['~/.bashrc'] })).message).toContain('overlaps the lock `~/.bashrc`');
    expect(refusal(plansAt('~', { lockedPaths: ['~'] })).message).toContain('overlaps the lock `~`');
    expect(plansAt('~/plans', { lockedPaths: ['~/.bashrc'] })).not.toThrow();
  });

  // `**` matches no folder as well as any, so `~/**/settings.json` locks
  // `~/settings.json`, which sits directly in a plans folder at `~`.
  it('refuse a plans folder that a ** lock can reach with no folder between', () => {
    expect(refusal(plansAt('~', { lockedPaths: ['~/**/settings.json'] })).message).toContain('overlaps the lock `~/**/settings.json`');
    expect(refusal(plansAt('config', { lockedPaths: ['**/settings.json'] })).message).toContain('overlaps the lock `**/settings.json`');
  });

  // A lock written from the repository root is about the repository's files.
  it('do not let a lock inside the repository reach a plans folder outside it', () => {
    expect(plansAt('~/.claude/plans', { lockedPaths: ['**/settings.json'] })).not.toThrow();
    expect(plansAt('..', { lockedPaths: ['**/settings.json'] })).not.toThrow();
  });

  it('match an absolute lock against an absolute plans folder', () => {
    expect(refusal(plansAt('/etc/agent', { lockedPaths: ['/etc/agent/config.json'] })).message).toContain('overlaps the lock `/etc/agent/config.json`');
    expect(plansAt('/etc/other', { lockedPaths: ['/etc/agent/config.json'] })).not.toThrow();
  });

  // The requirements folder is locked only against deletion, so the overlap
  // would ungate it rather than make plans unwritable.
  it('refuse a plans folder inside the requirements folder, wherever the rulebook keeps it', () => {
    const { message } = refusal(plansAt('requirements/changes'));
    expect(message).toContain('inside the requirements folder `requirements/`');
    expect(message).toContain('files there would be edited without a plan and left out of the tree fingerprint');
    expect(refusal(gate({ plans: { dir: 'specs' }, requirementsDir: 'specs/' })).message).toContain('inside the requirements folder `specs/`');
  });

  it('refuse a follow-ups file under a lock or in the requirements folder', () => {
    expect(refusal(gate({ followUpsFile: '.katatay/LATER.md' })).message)
      .toContain('The rulebook puts `followUpsFile` at `.katatay/LATER.md`, under the lock `.katatay/**`');
    expect(refusal(gate({ followUpsFile: '.claude/hooks/LATER.md', agent: { ...bareSections().agent, lockedPaths: ['.claude/hooks/**'] } })).message)
      .toContain('under the lock `.claude/hooks/**`');
    expect(refusal(gate({ followUpsFile: 'requirements/LATER.md' })).message)
      .toContain('The rulebook puts `followUpsFile` at `requirements/LATER.md`, inside the requirements folder `requirements/`');
    expect(gate({ followUpsFile: 'docs/LATER.md' })).not.toThrow();
  });

  describe('when the rulebook is read', () => {
    let root;
    const write = (body) => {
      mkdirSync(join(root, '.katatay'), { recursive: true });
      writeFileSync(join(root, CONFIG), JSON.stringify(body));
    };
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'rulebook-gating-')); });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    // Every moment reads the rulebook, so every moment refuses.
    it('is refused by every reader, not only the section that holds the key', () => {
      write(rulebook({ plans: { dir: '.' } }));
      expect(refusal(() => readConfig(root)).message).toMatch(/the repository root/);
      expect(refusal(() => readChecks(root)).message).toMatch(/the repository root/);
    });

    it('answers the plans folder resolved, and the follow-ups file as written', () => {
      write(rulebook({ plans: { dir: 'plans/' }, followUpsFile: 'docs/LATER.md', agent: { lockedPaths: [], adapters: { local: { checkCommand: 'node check.mjs', extraHooks: { check: false } } } } }));
      expect(plansDir(root, '/home/me')).toBe(join(root, 'plans'));
      expect(followUpsFile(root)).toBe('docs/LATER.md');
      expect(parseExtraHooks(readAgentAdapters(root).local, 'local')).toEqual({ check: false, acknowledged: [] });
    });
  });
});

describe('coverage in the quality chain', () => {
  const coverage = (over = {}) => ({ command: 'cat reports/source.info', output: 'reports/coverage.json',
    minimum: { 'modules/': { lines: 90, branches: 80 } }, ...over });
  const parse = (entry = coverage()) => parseChecks({ checks: { testQuality: { mutation: 'none', coverage: entry } } }).testQuality[0];

  it('requires a command, output and minimums and supplies fixed execution policy', () => {
    expect(parse()).toMatchObject({ name: 'coverage', chain: 'testQuality', runs: 'always', onFailure: 'block',
      exitCodes: { 0: 'clean' }, timeLimitSeconds: 300, suppressions: [], output: 'reports/coverage.json' });
    for (const key of ['command', 'output', 'minimum']) {
      const entry = coverage(); delete entry[key];
      expect(() => parse(entry)).toThrow(`checks.testQuality.coverage.${key}`);
    }
  });

  it('cannot run once, merely report failures, skip unchanged trees, or remap exits', () => {
    for (const entry of [coverage({ runs: 'oncePerPlan' }), coverage({ onFailure: 'report' }),
      coverage({ command: 'cover {changedFiles}' }), coverage({ exitCodes: { 0: 'clean', 1: 'findings' } })]) {
      expect(() => parse(entry)).toThrow();
    }
    expect(() => parseChecks({ checks: { codeQuality: { coverage: { command: 'true', exitCodes: { 0: 'clean', 1: 'findings' } } } } })).toThrow('uses a name the referee keeps');
    expect(parse(coverage({ command: 'cover {baseline}' })).command).toBe('cover {baseline}');
  });

  it('is switched off by writing "none", which no other check may say', () => {
    expect(parseChecks({ checks: { testQuality: { mutation: 'none', coverage: 'none' } } })).toEqual({ testQuality: [], codeQuality: [] });
    expect(() => parseChecks({ checks: { testQuality: { mutation: 'none', coverage: 'off' } } })).toThrow('"checks.testQuality.coverage" must be an object');
    expect(() => parseChecks({ checks: { testQuality: { lint: 'none' } } })).toThrow('"checks.testQuality.lint" must be an object');
    expect(() => parseChecks({ checks: { codeQuality: { coverage: 'none' } } })).toThrow('uses a name the referee keeps');
  });

  it('validates suppression expressions and timeout while allowing an empty suppression list', () => {
    for (const suppressions of [null, 'ignore', [5], [''], ['(']]) expect(() => parse(coverage({ suppressions }))).toThrow('suppressions');
    expect(parse(coverage({ suppressions: ['pragma:\\s*no cover'] })).suppressions).toEqual(['pragma:\\s*no cover']);
    for (const timeLimitSeconds of [null, 0, -1, 1.5, '10']) expect(() => parse(coverage({ timeLimitSeconds }))).toThrow('timeLimitSeconds');
    expect(parse(coverage({ timeLimitSeconds: 1 })).timeLimitSeconds).toBe(1);
  });

  it('requires an unambiguous relative output path and a different destination for every check', () => {
    for (const output of ['', '/tmp/out', '../out', 'x/../out', './out', 'x//out', 'x/*.json', 'x/{a,b}', 'x\\out', '.git/out', '.katatay/out', 'C:/out', 5]) {
      expect(() => parse(coverage({ output })), String(output)).toThrow('output');
    }
    expect(() => parseChecks({ checks: { testQuality: { mutation: 'none', coverage: coverage() }, codeQuality: { lint: {
      command: 'lint', exitCodes: { 0: 'clean', 1: 'findings' }, output: 'reports/coverage.json',
    } } } })).toThrow('two checks write');
    expect(parseChecks({ checks: { testQuality: { mutation: 'none', coverage: 'none' }, codeQuality: { lint: { command: 'lint', exitCodes: { 0: 'clean', 1: 'findings' }, output: 'reports/lint.json' } } } }).codeQuality[0].output).toBe('reports/lint.json');
  });
});

describe('a drafted rulebook', () => {
  let root;
  let other;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'workflow-draft-'));
    other = mkdtempSync(join(tmpdir(), 'workflow-draft-other-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });
  const onDisk = (folder, config) => {
    mkdirSync(join(folder, '.katatay'), { recursive: true });
    writeFileSync(join(folder, CONFIG), JSON.stringify(config));
  };

  it('is what the readers get for its folder while the function runs, though no file holds it', async () => {
    const draft = rulebook({ followUpsFile: 'DRAFT.md' });
    const seen = await withDraftConfig(root, draft, () => ({ config: readConfig(root), adapter: readAdapter(root), checks: readChecks(root) }));
    expect(seen.config).toEqual(draft);
    expect(seen.adapter.testRun.command).toBe(draft.tests.run.command);
    expect(seen.checks).toEqual(parseChecks(draft));
    expect(() => statSync(join(root, CONFIG))).toThrow();
  });

  it('is forgotten when the function ends, so the file is read again', async () => {
    await withDraftConfig(root, rulebook({ followUpsFile: 'DRAFT.md' }), () => {});
    expect(refusal(() => readConfig(root)).message).toContain(`there is no ${CONFIG}`);
    onDisk(root, rulebook({ followUpsFile: 'DISK.md' }));
    expect(readConfig(root).followUpsFile).toBe('DISK.md');
  });

  it('wins over the file in its folder only while the function runs', async () => {
    onDisk(root, rulebook({ followUpsFile: 'DISK.md' }));
    expect(await withDraftConfig(root, rulebook({ followUpsFile: 'DRAFT.md' }), () => readConfig(root).followUpsFile)).toBe('DRAFT.md');
    expect(readConfig(root).followUpsFile).toBe('DISK.md');
  });

  it('is forgotten when the function throws, or its promise rejects', async () => {
    await expect(withDraftConfig(root, rulebook(), () => { throw new Error('thrown'); })).rejects.toThrow('thrown');
    await expect(withDraftConfig(root, rulebook(), async () => { throw new Error('rejected'); })).rejects.toThrow('rejected');
    expect(refusal(() => readConfig(root))).toBeInstanceOf(TargetError);
  });

  it('is waited for, and its result handed back', async () => {
    const result = await withDraftConfig(root, rulebook({ followUpsFile: 'DRAFT.md' }), async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return readConfig(root).followUpsFile;
    });
    expect(result).toBe('DRAFT.md');
  });

  it('answers for its own folder only', async () => {
    onDisk(other, rulebook({ followUpsFile: 'OTHER.md' }));
    const seen = await withDraftConfig(root, rulebook({ followUpsFile: 'DRAFT.md' }), () => readConfig(other).followUpsFile);
    expect(seen).toBe('OTHER.md');
  });

  it('is refused as a file would be, before the function starts', async () => {
    let ran = false;
    await expect(withDraftConfig(root, { version: HARNESS_SCHEMA_VERSION }, () => { ran = true; })).rejects.toBeInstanceOf(TargetError);
    expect(ran).toBe(false);
    expect(refusal(() => readConfig(root)).message).toContain(`there is no ${CONFIG}`);
  });

  it('is checked against the home folder it is given', async () => {
    const draft = rulebook({ plans: { dir: '~/plans' }, agent: { ...rulebook().agent, lockedPaths: [join(other, 'plans', 'locked.md')] } });
    await expect(withDraftConfig(root, draft, () => {}, other)).rejects.toThrow('overlaps the lock');
  });
});
