import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { userSkillFile as claudeSkill } from '../agents/claude/install-files.mjs';
import { userSkillFile as codexSkill } from '../agents/codex/install-files.mjs';

let temp, claude, codex;
const exitCode = process.exitCode;
const contents = readFileSync(new URL('../adapters/skills/ktty-init.md', import.meta.url), 'utf8');
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'katatay-skills-'));
  for (const [key, dir] of [['CLAUDE_CONFIG_DIR', 'claude'], ['CODEX_HOME', 'codex']]) vi.stubEnv(key, join(temp, dir));
  claude = join(temp, 'claude/skills/ktty-init/SKILL.md');
  codex = join(temp, 'codex/skills/ktty-init/SKILL.md');
  vi.stubEnv('npm_config_global', 'true');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = exitCode;
  rmSync(temp, { recursive: true, force: true });
});

async function install() {
  vi.resetModules();
  await import('./install-skills.mjs');
}

it('installs the interview at both configured user locations and accepts an identical reinstall', async () => {
  await install();
  for (const file of [claude, codex]) {
    expect(readFileSync(file, 'utf8')).toBe(contents);
    expect(console.log).toHaveBeenCalledWith(`Installed ${file}`);
  }
  vi.mocked(console.log).mockClear();
  await install();
  expect(console.log).not.toHaveBeenCalled();
  expect(console.error).not.toHaveBeenCalled();
});

it('checks both destinations before writing and identifies the conflicting file', async () => {
  mkdirSync(dirname(codex), { recursive: true });
  writeFileSync(codex, 'mine');
  await install();
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining(codex));
  expect(process.exitCode).toBe(1);
  expect(readFileSync(codex, 'utf8')).toBe('mine');
  expect(existsSync(claude)).toBe(false);
});

it('leaves the user skill directories alone during a local npm install', async () => {
  vi.stubEnv('npm_config_global', undefined);
  await install();
  expect(existsSync(claude)).toBe(false);
  expect(existsSync(codex)).toBe(false);
});

it('locates the setup skill in each agent’s default user directory when no override is set', () => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
  vi.stubEnv('CODEX_HOME', undefined);
  expect(claudeSkill('ktty-init')).toBe(join(homedir(), '.claude/skills/ktty-init/SKILL.md'));
  expect(codexSkill('ktty-init')).toBe(join(homedir(), '.codex/skills/ktty-init/SKILL.md'));
});
