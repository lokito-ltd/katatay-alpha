---
name: commit-message
description: Create git commit messages based on current staged changes. Always prefixes the subject with a gitmoji.
---

# Git Commit Message

## Instructions

1. Run `git status`.
   - If it reports `nothing to commit, working tree clean`, reply "No changes
     found. Please make changes to your files before trying to commit." and stop.
   - If it reports `Changes not staged for commit`, ask the user whether to
     stage them, and stage on confirmation.
   - Only proceed once everything intended for the commit is staged.
2. Run `git diff --cached` and read it: which files changed, what the change
   does, and why it matters. With many staged files, review each one so the
   message covers all of them. (`git diff --staged` is the same command;
   `--stat` gives a summary, and a path argument narrows it to one file.)
3. If — and only if — the repository has a requirements folder holding a
   requirement catalogue, work out which requirements this commit touches:

   ```bash
   git diff --cached -- requirements/
   ```

   Use the rulebook's requirements folder if it names another. For each
   requirement file in that diff, take the id from the filename and read what
   actually happened to it. Do not infer it from the commit's purpose:

   | In the diff | Record it as |
   | --- | --- |
   | the file is new | `added` |
   | the `status:` line changed | `status <before> → <after>` |
   | the first non-empty line of the body changed | `statement reworded` |
   | the file is gone | `DELETED` |

   A deletion is forbidden by the catalogue's own rules — a requirement leaves
   only by becoming `superseded` or `withdrawn`. Say so prominently rather than
   recording it as an ordinary entry, and check before committing.

   List them in the body under a `Requirements:` heading, after the functional
   bullets, one per line. Omit the heading entirely when the commit touches no
   requirement — most commits will not.

4. Get the review areas from the referee: run `workflow areas --staged`,
   started the way the project's instructions say, with the starter's own
   output silenced.

   If it prints anything, put that output in the body under a `Review:`
   heading, after the `Requirements:` section if there is one. Copy it as it
   stands: do not add an area, drop one, reword one or re-wrap it. If it prints
   nothing, leave the heading out.

   The reason: the operator reviews by hand on the hosting platform, and the
   commit message is where that review starts. The list says where they
   **must** look: the staged files that do the checking, and the rulebook's
   high-risk files. A tool writes it, from git, so it cannot leave out what the
   tools flagged. An agent choosing the areas could, and nothing would show it
   had.

5. Write the message in the format below, always leading with the gitmoji for
   its type.
6. Show the full commit message, verbatim, every time you ask to commit — never
   refer to "the message above" or summarise it. Print it using the output
   format below, then ask in plain text: "Would you like me to create this
   commit? Reply yes to commit with exactly this message." End the turn there
   and wait for the reply.

   Ask in plain text, not through an interactive dialog: a dialog can cover the
   text printed before it, and then the user is asked to approve a message they
   cannot see.

   Commit only on a clear yes, and with exactly the message shown. If the
   message changes, show the whole message again before asking again.
7. Once committed, check the project's instructions for who pushes. If they say
   the operator pushes — as in a repository where review and pushing by hand is
   what holds the line — stop after the commit and do not offer to push. Say
   the commit is ready for the operator to push. Otherwise ask the same way —
   in plain text — whether to push, and push only on confirmation.

## Commit Message Format

```text
<emoji> <type>(<scope>): <subject>

<body>

<footer>
```

- **emoji** — required, from the table below. Never ask whether the user wants
  one, and never omit it because they did not mention emojis.
- **type** — see the table below.
- **scope** — optional; the area of the codebase affected, e.g. `feat(auth):`.
- **subject** — imperative, present tense, lowercase, under 50 characters:
  "add feature", not "added feature" or "adds feature".
- **body** — optional, separated by a blank line, wrapped at 72 characters.
  Bullets, one change per line, six at most. Say what changed functionally and
  why, not how it was implemented.
- **footer** — optional; issue references such as `Closes #123`.

### Types and their emoji

| Type     | Emoji | Usage                                                  |
| -------- | ----- | ------------------------------------------------------ |
| feat     | ✨    | A new feature                                          |
| fix      | 🐛    | A bug fix                                              |
| docs     | 📚    | Documentation changes                                  |
| style    | 💄    | Formatting only; no change in meaning                  |
| refactor | ♻️    | Neither fixes a bug nor adds a feature                 |
| perf     | ⚡    | Performance improvements                               |
| test     | ✅    | Adding or updating tests                               |
| chore    | 🔨    | Tooling, dependencies, build process                   |
| ci       | 👷    | CI configuration                                       |
| build    | 📦    | Build system or packaging                              |
| revert   | ⏮️    | Reverting an earlier commit                            |
| security | 🔒    | Security fixes                                         |

### Example

```text
✨ feat(checkout): add paypal payment option

- Integrate with PayPal's API
- Handle declined-payment errors

Closes #234
```

With a requirement catalogue:

```text
✨ feat(proposal): record rejection as a first-class outcome

- Store a terminal rejected state rather than absence of acceptance
- Skip rejected proposals on a second pass over the same source

Requirements:
- AC0001 status accepted → active
- INV0001 status accepted → active
```

With review areas, pasted from `workflow areas --staged`:

```text
✨ feat(storage): keep a project's pasted sources

- Store pasted text alongside the project it belongs to

Review:
Must look:
  Migrations. Every database runs them, and merged ones never change.
  - db/migrations/0004_sources.sql
```

## Output Format

When presenting the generated commit message to the user:

```markdown
Here's the suggested commit message based on your staged changes:

​`
<generated commit message>
​`
```

## Important Notes

- Never run `git commit` or `git push` without user approval, and never offer
  a push where the project's rules keep pushing for the operator (step 7).
- Never ask for commit approval without the complete message visible in that
  same message, and never through an interactive dialog (see step 6).
- The requirement list describes **this commit**, not the branch. A requirement
  added in one commit and promoted in another appears once in each, and no single
  message shows the net effect. That is correct — the commit message records a
  commit. What the branch does to the catalogue is answered by
  `workflow req guard` and recorded in the change file in the requirements
  folder's `changes/`; do not try to reconstruct it here.

## In Claude Code

Ask for commit approval, and whether to stage or push, in plain chat text, never with `AskUserQuestion`: in the desktop app its dialog covers the text before it and does not show an option's `preview`, so the operator would approve a message they cannot see.
