# Security

Katatay is a guard: it holds a coding agent to a plan the operator approved.
A way around it is a security problem, even when no secret leaks.

## Report a problem privately

Report it through GitHub's private vulnerability reporting:
<https://github.com/lokito-ltd/katatay-alpha/security/advisories/new>.
Do not open a public issue, because a bypass is usable the moment it is
public.

Include what you need to show the problem: the Katatay version from
`ktty version`, the agent and its version, the steps, and what the referee
allowed that it should have refused, or recorded that it should not have.

You will get an answer within seven days. A confirmed problem is fixed in the
next release, and the advisory names you unless you ask otherwise.

## What to report

- An agent writing a locked file, or a test file while the tests are frozen,
  without the referee refusing it.
- The logbook recording an approval, a verification or a declaration that did
  not happen.
- A requirement weakened or removed without the guard failing.
- A check reading as clean when it failed or did not run.
- A secret reaching the logbook, a snapshot or a report.

## What is already known

The README's [Known limits](README.md#known-limits) lists the gaps this alpha
has on purpose, such as a session being able to edit the installed referee.
They need no report. A new way to exploit one of them, or a limit that is
worse than the README says, is still worth reporting.

## Supported versions

Only the latest release gets fixes. This is an alpha, and nothing older is
patched.
