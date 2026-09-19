# Maintaining project documentation

## Rationale

This organization follows OpenAI's [Rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra), reviewed on 2026-09-19: keep always-loaded instructions small, route to context by task, make skill triggers precise, and define completion without prescribing every step. Retain concrete boundaries rather than broad approval requirements.

## Where information belongs

| Information | Home |
| --- | --- |
| Repository-wide source ownership, generated-file restrictions, task routing | [AGENTS.md](../AGENTS.md) |
| Catalog invariants and authoring constraints | [Catalog maintenance](catalog-maintenance.md) |
| Manager recovery, concurrency, captions, dialogs, and build jobs | [Manager maintenance](manager-maintenance.md) |
| Public runtime, routes, accessibility, and service-worker contracts | [Public app maintenance](public-app-maintenance.md) |
| Verification commands, CI expectations, publishing, and commit scope | [Build and deployment](build-and-deployment.md) |
| User workflows and command walkthroughs | [Project README](../PROJECT_README.md) |
| Visual design decisions | [Design system](../design.md) |
| Completed implementation proposals | [Historical plans](../plans/README.md) |

The maintenance guides preserve the detailed contracts formerly in the root `AGENTS.md`. Moving a contract does not relax it. Keep user-facing descriptions consistent with those contracts and update links when moving sections. Paths and shell commands in maintenance guides are relative to the repository root; Markdown links are relative to the containing document.

## Task prompts

State the desired result, relevant constraints, and completion evidence. For example:

> Fix the manager photo editor losing its draft after pagination. Preserve explicit saving and revision-conflict handling. Add a regression test, run the affected manager checks, and verify the editing flow in the browser. Finish with the fix and verification results.

For a documentation change:

> Update the authoring walkthrough to match the current manager navigation. Check the relevant UI sources and documentation links, preserve unrelated edits, and report the changed documents.

These examples do not authorize deployment. A request to deploy follows the project's existing publishing checklist and includes reporting the push and Pages status.

## Reviewing instruction changes

Keep skill descriptions specific to the workflow they enable. Put optional workflow detail in linked references and keep required data-protection or human-review boundaries explicit. Avoid adding model-specific rituals or repeating generic coding advice across files.

For this repository, review documentation changes by checking that source ownership, catalog invariants, recovery/concurrency rules, generated-output handling, and deployment boundaries remain reachable from `AGENTS.md`. Check local links and whitespace. Documentation-only edits do not require regenerating the site or running the application suite. Changes to application behavior still require the checks for that surface.
