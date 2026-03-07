# RESPLite Agent Skills

This folder contains portable skills for recurring RESPLite workflows.

## Skills

- `resplite-command-vertical-slice`: implement or extend Redis-like command support end to end.
- `resplite-migration-cutover-assistant`: work on Redis to RESPLite migration flows, dirty tracking, cutover, and verification.
- `resplite-ft-search-workbench`: work on `FT.*`, SQLite FTS5 behavior, and RediSearch migration mapping.

## Design intent

These skills are scoped by workflow, not by file type. Each one tells the agent:

- when the skill should trigger,
- which RESPLite files and specs matter first,
- how to keep scope aligned with the project's practical compatibility goals,
- how to verify the change before calling it done.

## Packaging

Each skill folder is portable and can be installed independently in a skills directory or zipped for distribution.
