import { constants, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { userSkillFile as claudeSkill } from '../agents/claude/install-files.mjs';
import { userSkillFile as codexSkill } from '../agents/codex/install-files.mjs';

function install() {
  const source = new URL('../adapters/skills/ktty-init.md', import.meta.url);
  const content = readFileSync(source);
  const destinations = new Set([claudeSkill('ktty-init'), codexSkill('ktty-init')]);
  const missing = [];
  for (const file of destinations) {
    if (!existsSync(file)) missing.push(file);
    else if (!readFileSync(file).equals(content)) {
      throw new Error(`A different skill already exists at ${file}. Move it aside and retry to install Katatay's copy.`);
    }
  }
  for (const file of missing) {
    mkdirSync(dirname(file), { recursive: true });
    copyFileSync(source, file, constants.COPYFILE_EXCL);
    console.log(`Installed ${file}`);
  }
}

if (process.env.npm_config_global === 'true') {
  try { install(); } catch (error) {
    console.error(`ktty-init: ${error.message}`);
    process.exitCode = 1;
  }
}
