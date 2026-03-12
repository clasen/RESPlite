---
id: 90dhbsvf0f
type: implementation
title: Apply dirty migration concurrency and progress
created: '2026-03-12 14:55:12'
---
Improved src/migration/apply-dirty.js to support concurrent dirty-key apply via options.concurrency (chunked Promise.all worker model) while preserving max_rps throttling. Added richer onProgress payload fields: dirty_keys_processed, dirty_pending, dirty_keys_per_second, dirty_eta_seconds, and related counters. Exposed new options through createMigration().applyDirty: concurrency and progressIntervalMs. Updated README migration cutover snippet with high-throughput applyDirty example and progress logging. Added unit test test/unit/migration-apply-dirty.test.js validating concurrency and progress payload. Verified with node --test test/unit/migration-apply-dirty.test.js and npm run test:unit (all passing).
