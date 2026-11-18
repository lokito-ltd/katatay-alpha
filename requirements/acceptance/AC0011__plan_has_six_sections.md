---
status: active
---

A presented plan has six level-two sections, each once and in this order: Why, What, How, Requirements, Predicted failures, Test delta.

## Scenarios

- [AC0011.1] A plan missing a section is reported with that section's name.
- [AC0011.2] An empty section is reported, even when it holds only comments or subheadings.
- [AC0011.3] A duplicate section, a section out of order and a leftover template placeholder are reported together.
- [AC0011.4] A heading at the wrong level, case or spacing is named as a near miss and not accepted.
- [AC0011.5] Headings inside fenced examples, blockquotes, indented code or comments do not count as sections.
- [AC0011.6] Requirements and Predicted failures may say None.
- [AC0011.7] The closing workflow block does not count as content for the section above it.

## Why

The same section list builds the template the agent is shown and the check
that is run, so they cannot drift apart. Exclusions are optional, as prose or
an "Out of scope" subsection. "Test delta" is a prediction: triage settles
which tests need writing.

This check runs only when a plan is presented. Approval does not check the
sections (AC0015).
