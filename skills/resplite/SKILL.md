---
name: resplite
description: Integrates and operates RESPlite in a Node.js application through its public APIs. Use when adding one embedded server, managing multiple named instances, configuring SQLite, cache, hooks, command policy, or graceful shutdown. Do not use for contributing commands, migration internals, or FT implementation work.
metadata:
  category: workflow-automation
  tags: [resplite, redis, sqlite, embedded, integration]
---

# Integrate RESPlite

Use this skill to add RESPlite to an application, not to modify RESPlite internals.

## Choose the runtime shape

- Use `createRESPlite()` when the process needs one embedded RESP server.
- Use `createRESPliteGroup()` when one process owns two or more independent named servers.
- Use the standalone entrypoint only when RESPlite should run as its own process.

Import embedded APIs from `resplite/embed`.

## One embedded server

```javascript
import { createRESPlite } from 'resplite/embed';

const server = await createRESPlite({
  host: '127.0.0.1',
  port: 6380,
  db: './data.db',
});

// Use server.port when port: 0 lets the OS choose a port.
await server.close();
```

`createRESPlite()` returns `{ host, port, close }`. By default it owns `SIGINT` and `SIGTERM`; pass `gracefulShutdown: false` when the application already has a global shutdown sequence.

## Multiple embedded servers

```javascript
import { createRESPliteGroup } from 'resplite/embed';

const group = await createRESPliteGroup({
  main: {
    host: '127.0.0.1',
    port: 6380,
    db: './main.db',
  },
  volatile: {
    host: '127.0.0.1',
    port: 6379,
    db: ':memory:',
    cache: false,
  },
});

console.log(group.servers.main.port);
await group.close();
```

The group starts instances in declaration order, rolls back earlier instances if a later start fails, and closes every instance through one idempotent `close()` call. It owns one `SIGINT`/`SIGTERM` handler pair unless the second argument is `{ gracefulShutdown: false }`.

## Configuration decisions

- Resolve relative `db` paths in the application when they come from external configuration; RESPlite interprets them relative to the process working directory.
- Give every persistent instance a different SQLite file. Repeating `:memory:` is valid because each instance receives its own in-memory database.
- Treat `cache`, pragmas, hooks, and command policy as instance-local options.
- Use `cache: false` when an extra hot-data cache is unnecessary, such as for a small in-memory instance.
- Use hooks for application observability and `commandPolicy` to rename or disable commands exposed by that server.

Do not invent local fallback values for operational settings already owned by the application's configuration.

## Lifecycle ownership

Choose one owner for process signals:

- Let RESPlite own them for a dedicated embedded server or group.
- Pass `gracefulShutdown: false` and await `server.close()` or `group.close()` from the application's existing shutdown coordinator.

Do not register per-instance signal handlers around a group, and do not force `process.exit()` before all application resources have closed.

## Boundaries

A group coordinates lifecycle only. Its servers do not share data, cache, Pub/Sub subscriptions, or Redis Cluster semantics. Sharing one persistent SQLite file between instances is unsupported.

For Redis migration workflows use the `resplite-migration` skill. For implementing or extending `FT.*` behavior inside RESPlite use `resplite-ft-search`.
