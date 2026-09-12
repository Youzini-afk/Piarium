//! SQLite catalog schema owned by the Rust storage authority.
//!
//! The schema is intentionally kept apart from the operation code so format
//! validation and atomic initialization remain one reviewable responsibility.

pub(crate) const CATALOG_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
     CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, byte_length INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS trie_nodes (hash TEXT PRIMARY KEY, children_json TEXT NOT NULL, state_json TEXT);
     CREATE TABLE IF NOT EXISTS branches (branch_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, create_params_hash TEXT NOT NULL, base_root TEXT NOT NULL, head_root TEXT NOT NULL, head_revision INTEGER NOT NULL, write_revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS revisions (branch_id TEXT NOT NULL, revision INTEGER NOT NULL, root_hash TEXT NOT NULL, parent_revision INTEGER, operation_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(branch_id, revision));
     CREATE TABLE IF NOT EXISTS pins (pin_id TEXT PRIMARY KEY, branch_id TEXT NOT NULL, workspace_id TEXT NOT NULL, revision INTEGER NOT NULL, root_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS root_blobs (root_hash TEXT NOT NULL, blob_hash TEXT NOT NULL, PRIMARY KEY(root_hash, blob_hash));
     CREATE TABLE IF NOT EXISTS root_parents (root_hash TEXT PRIMARY KEY, parent_root TEXT NOT NULL);
     CREATE TABLE IF NOT EXISTS recovery_roots (record_id TEXT NOT NULL, root_hash TEXT NOT NULL, PRIMARY KEY(record_id, root_hash));
     CREATE TABLE IF NOT EXISTS grants (grant_id TEXT PRIMARY KEY, host_id TEXT NOT NULL, grant_json TEXT NOT NULL, params_hash TEXT NOT NULL, revoked INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS operations (operation_id TEXT PRIMARY KEY, kind TEXT NOT NULL, params_hash TEXT NOT NULL, state TEXT NOT NULL, result_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS operation_owners (operation_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, created_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS object_owners (owner_id TEXT PRIMARY KEY, blob_hash TEXT NOT NULL, workspace_id TEXT, operation_id TEXT, owner_kind TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS object_owners_blob ON object_owners(blob_hash);
     CREATE INDEX IF NOT EXISTS object_owners_workspace ON object_owners(workspace_id);
     CREATE TABLE IF NOT EXISTS recovery_records (record_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, workspace_id TEXT NOT NULL, state TEXT NOT NULL, data_json TEXT NOT NULL, initial_data_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS pending_gc_files (hash TEXT PRIMARY KEY, path TEXT NOT NULL, state TEXT NOT NULL, last_error TEXT, queued_at INTEGER NOT NULL, cleaned_at INTEGER);
     CREATE INDEX IF NOT EXISTS revisions_root ON revisions(root_hash);
     CREATE INDEX IF NOT EXISTS pins_root ON pins(root_hash);
     CREATE INDEX IF NOT EXISTS root_blobs_blob ON root_blobs(blob_hash);
     CREATE INDEX IF NOT EXISTS recovery_operation ON recovery_records(operation_id);";
