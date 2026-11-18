---
status: active
---

`ktty req trace` fails unless every scenario of each active AC has a running acceptance test titled with its text and tagged with its id.

## Scenarios

- [AC0062.1] A scenario whose acceptance test is titled with its words and id passes.
- [AC0062.2] A scenario of an active AC with no acceptance test, or with only ordinary tests, fails.
- [AC0062.3] A skipped, expected-to-fail or never-collected test is not evidence, but its title and tag are still checked.
- [AC0062.4] Titles are compared by words only, ignoring case, whitespace, punctuation and leading group names.
- [AC0062.5] A tag naming a missing scenario, a withdrawn or superseded requirement, or two scenarios at once fails.
- [AC0062.6] A bare AC tag fails, and a bare INV tag passes.
- [AC0062.7] A tag in the comment lines directly above a test counts, and tags in files that are not acceptance files are ignored.

## Why

Tests are the requirements' living documentation. A test file says what it
proves without anyone reading its body, and the AC and its tests cannot drift
apart silently. Only a test that runs and can fail is evidence. One title
cannot match two texts, so a test proves one scenario.

Trace reads the last test report and refuses when there is none. Accepted ACs
are exempt, because they are agreed but not yet proved.
