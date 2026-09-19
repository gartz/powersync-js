---
'@powersync/common': minor
'@powersync/shared-internals': minor
---

Watched queries accept `initialData`: rows presented as the query's first result rather than as a placeholder. The watched query is constructed with `isLoading` already false, the rows are available before the database is ready, and a differential watch diffs its first live result against them instead of against nothing.
