# Recovery and rollback

Piarium provides two related actions from every recoverable message:

- **conversation only** moves Pi's native session branch and restores editable prompt text/images;
- **conversation and files** also reverses the exact `write` and `edit` changes made by the turns that
  leave the active branch.

The default can be set to conversation only, conversation and files, or always ask.

Combined rollback uses affected-file checkpoints. It does not scan, copy, reset, or clean the complete
workspace when a session opens or a message is sent. If the recorded files have not changed again,
rollback runs directly from the message action. A chooser appears only for a real conflict, incomplete
external/shell coverage, or the always-ask preference.

Piarium saves the current versions of affected paths before applying a rollback, so a completed recovery
can be undone. Recovery storage can use the application data directory, a workspace-local directory, a
sibling directory, or a custom root. Project selection overrides the global default; Settings also owns
verified migration, unreachable-object cleanup, and explicit workspace-history deletion.

Pi remains the conversation authority. `pi-workspace-history` and `pi-wtf` are optional Pi packages and
are not installed or invoked by native Piarium recovery.

Arbitrary native commands do not expose a portable pre-write file list. A turn whose `bash`, terminal,
Git, extension, or unrelated process changed unjournalled paths is marked incomplete for file rollback;
Piarium does not hide that gap behind a slow full-workspace fallback. Conversation-only rollback remains
available.

The complete mechanism and provider contract are documented in
[Piarium native recovery journal](native-workspace-recovery-design.md).
