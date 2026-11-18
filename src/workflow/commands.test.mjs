/** How a message names a command: through one function, and only commands that exist. */
import { describe, expect, it } from 'vitest';
import { COMMANDS, command } from './commands.mjs';
import { ROUTES } from './cli/workflow.mjs';

describe('naming a command in a message', () => {
  // How `workflow` is started is the project's business, said in its own
  // instructions. A message that named a project's alias, such as an npm
  // script, would be wrong in every other project.
  it('names the referee\'s own command, never a project\'s alias for it', () => {
    expect(command('triage')).toBe('workflow triage');
    expect(command('req guard')).toBe('workflow req guard');
    expect(command('state show')).toBe('workflow state show');
    for (const name of COMMANDS) expect(command(name)).not.toMatch(/npm|:/);
  });

  // Checked against the referee's command and not against `package.json`,
  // which is one project's and may not exist in another.
  it('names only subcommands the referee\'s command has', () => {
    expect(COMMANDS.filter((name) => !Object.hasOwn(ROUTES, name))).toEqual([]);
    for (const name of COMMANDS) expect(command(name)).toBe(`workflow ${name}`);
  });

  it('refuses a name that is not a command, rather than print one that does not exist', () => {
    expect(() => command('trige')).toThrow(/no referee command is named "trige"/);
    expect(() => command('req:guard')).toThrow(/no referee command is named "req:guard"/);
    expect(() => command('')).toThrow();
  });
});
