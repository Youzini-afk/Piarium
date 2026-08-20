# Agent / editor coordination

Shared Workbench Kernel for Agent context attachments, tool file-change hints, patch
review, and session↔editor navigation. Document buffers and disk revisions stay in the
Document Registry / DocumentsAPI.

- `attachments.ts` — runtime+session scoped attachment list; consume-on-send
- `projection.ts` — saved vs unsaved prompt text; unsaved snapshots are not claimed as disk
- `hints.ts` — tool path hints only; file watch events remain authoritative
- `patch.ts` / `document-write.ts` — hunk apply/revert with expected revision; dirty buffers never overwritten
- `merge.ts` — three-way ancestor/ours/theirs regions
- `navigation.ts` — last session entry linked to a resource

Do not copy Pi plugin private history. Do not log attachment or document text.
