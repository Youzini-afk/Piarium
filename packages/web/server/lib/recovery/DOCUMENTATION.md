# Native workspace recovery

Piarium recovery follows an IDE-local-history model rather than treating every chat turn as a new workspace archive.

## Checkpoint layers

1. Resolving a workspace schedules one non-blocking baseline. This is the only normal path that scans the full workspace.
2. Every Pi turn records a durable content witness (`epoch` plus `mutationRevision`) before and after execution. If the witness did not change, combined recovery performs zero filesystem operations and only navigates the conversation.
3. Once a ready baseline exists, the Pi writer watcher reports the paths affected during a turn. The next checkpoint inherits the previous manifest and re-reads only those files or directories.
4. A watcher reset, unavailable watcher, or missing baseline falls back to a full capture. This preserves coverage for shell and external writes without making a full scan the common path.

Writer revisions fence concurrent activity but are not part of content identity. A writer can open and close without changing files; such a turn remains a valid no-op checkpoint.

## Integrity

Objects remain content-addressed. A capture publishes its manifest only after every referenced object exists with the expected size, and restore verifies object hashes before applying them. Staged manifest rows are committed to SQLite in one transaction rather than one durable transaction per file.

The filesystem watcher is a path-discovery accelerator, not the source of file contents. If it reports incomplete coverage, Piarium uses the full-capture fallback instead of claiming an exact incremental checkpoint.
