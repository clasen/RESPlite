---
id: 105jsp012x
type: implementation
title: Bulk onProgress ETA support
created: '2026-03-11 11:10:48'
---
Added ETA/progress metrics to bulk migration onProgress payload. New optional options: estimated_total_keys in runBulkImport, estimatedTotalKeys in createMigration/bulk(). onProgress payload now includes elapsed_seconds, keys_per_second, estimated_total_keys, remaining_keys_estimate, eta_seconds, progress_pct. README migration example updated to print ETA/rate. Added unit test validating ETA fields and final 100%/eta=0 behavior.
