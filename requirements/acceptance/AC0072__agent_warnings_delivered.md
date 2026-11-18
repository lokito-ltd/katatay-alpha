---
status: active
---

Every configured agent's check runs, its warnings are named by agent and reach every prompt and both state commands, and a check that gives no answer becomes one warning.

## Scenarios

- [AC0072.1] AGENTS.md files over what Codex reads are reported with their size, the limit and the overflow.
- [AC0072.2] A Codex workflow hook that is missing, disabled or untrusted is reported.
- [AC0072.3] An extra Stop or prompt hook in Codex is reported as able to send the approval.
- [AC0072.4] A Codex that cannot be started gives two warnings, about its settings and its hooks, each saying nothing is known.
- [AC0072.5] With CI set to exactly true, the Codex check skips its live query but still checks the request.
- [AC0072.6] Checks run in the rulebook's order, a crashing check becomes one warning, and the next check still runs.
- [AC0072.7] Each agent's named warnings appear in ktty state show, ktty state verify, every prompt and every verified turn end.

## Why

Only the operator can repair the agent's configuration, so warnings never fail
anything. Silence is never read as a clean report.

The Stop hook throws away what a passing verify prints, so a warning printed
only there reached nobody. That is why warnings ride with the prompt context
and the verified message.

Each adapter has its own extra-hook switch, on by default, under
`agent.adapters.<name>.extraHooks`. `ktty state show` names each agent whose
switch is off, and a missing workflow hook is reported either way.
