---
id: tucj9i5nh5
type: implementation
title: Bulk migration concurrency added
created: '2026-03-11 11:09:20'
---
Added configurable concurrency to runBulkImport and createMigration.bulk with default 1. Implemented chunked parallel import with shared global max_rps limiter. Added unit tests proving default sequential behavior and concurrent behavior with cap.
