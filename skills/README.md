# RESPLite Agent Skills

This folder contains portable skills for recurring RESPLite workflows.

## Skills

- `resplite`: integrate and operate one or more RESPlite servers through the package's public APIs.
- `resplite-migration-cutover-assistant`: work on Redis to RESPLite migration flows, dirty tracking, cutover, and verification.
- `resplite-ft-search-workbench`: work on `FT.*`, SQLite FTS5 behavior, and RediSearch migration mapping.

## Design intent

These skills are scoped by workflow, not by file type. The general `resplite` skill is consumer-facing; migration and FT search retain their specialized implementation workflows. Each skill tells the agent:

- when the skill should trigger,
- which public entrypoints or specialized sources matter,
- which operational or compatibility boundaries must stay explicit.

## Packaging

Each skill folder is portable and can be installed independently in a skills directory or zipped for distribution.
