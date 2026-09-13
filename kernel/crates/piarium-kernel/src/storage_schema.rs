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
	     CREATE TABLE IF NOT EXISTS object_owners (owner_id TEXT PRIMARY KEY, blob_hash TEXT NOT NULL, workspace_id TEXT, operation_id TEXT, grant_id TEXT NOT NULL, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS object_owners_blob ON object_owners(blob_hash);
     CREATE INDEX IF NOT EXISTS object_owners_workspace ON object_owners(workspace_id);
     CREATE TABLE IF NOT EXISTS recovery_records (record_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, workspace_id TEXT NOT NULL, state TEXT NOT NULL, data_json TEXT NOT NULL, initial_data_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS domain_records (record_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, record_type TEXT NOT NULL, state TEXT NOT NULL, session_id TEXT, thread_id TEXT, run_id TEXT, branch_id TEXT, revision INTEGER, result_revision INTEGER, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS domain_record_refs (record_id TEXT NOT NULL REFERENCES domain_records(record_id) ON DELETE CASCADE, slot TEXT NOT NULL, object_hash TEXT NOT NULL, PRIMARY KEY(record_id, slot));
     CREATE TABLE IF NOT EXISTS pending_gc_files (hash TEXT PRIMARY KEY, path TEXT NOT NULL, state TEXT NOT NULL, last_error TEXT, queued_at INTEGER NOT NULL, cleaned_at INTEGER);
     CREATE INDEX IF NOT EXISTS revisions_root ON revisions(root_hash);
     CREATE INDEX IF NOT EXISTS pins_root ON pins(root_hash);
     CREATE INDEX IF NOT EXISTS root_blobs_blob ON root_blobs(blob_hash);
     CREATE INDEX IF NOT EXISTS recovery_operation ON recovery_records(operation_id);
     CREATE INDEX IF NOT EXISTS domain_records_workspace ON domain_records(workspace_id, record_type, updated_at DESC);
     CREATE INDEX IF NOT EXISTS domain_records_thread ON domain_records(workspace_id, thread_id, record_type);
     CREATE INDEX IF NOT EXISTS domain_record_refs_hash ON domain_record_refs(object_hash);";

pub(crate) const CATALOG_USER_VERSION: i64 = 6;

pub(crate) const REQUIRED_TABLES: &[&str] = &[
    "blobs",
    "branches",
    "domain_record_refs",
    "domain_records",
    "grants",
    "metadata",
    "object_owners",
    "operation_owners",
    "operations",
    "pending_gc_files",
    "pins",
    "recovery_records",
    "recovery_roots",
    "revisions",
    "root_blobs",
    "root_parents",
    "trie_nodes",
];

pub(crate) const REQUIRED_INDEXES: &[&str] = &[
    "domain_record_refs_hash",
    "domain_records_thread",
    "domain_records_workspace",
    "object_owners_blob",
    "object_owners_workspace",
    "pins_root",
    "recovery_operation",
    "revisions_root",
    "root_blobs_blob",
];

pub(crate) const REQUIRED_COLUMNS: &[(&str, &[&str])] = &[
    ("blobs", &["hash", "byte_length"]),
    (
        "branches",
        &[
            "branch_id",
            "workspace_id",
            "create_params_hash",
            "base_root",
            "head_root",
            "head_revision",
            "write_revision",
            "created_at",
            "updated_at",
        ],
    ),
    (
        "grants",
        &[
            "grant_id",
            "host_id",
            "grant_json",
            "params_hash",
            "revoked",
            "created_at",
            "updated_at",
        ],
    ),
    ("metadata", &["key", "value"]),
    (
        "object_owners",
        &[
            "owner_id",
            "blob_hash",
            "workspace_id",
            "operation_id",
            "grant_id",
            "created_at",
        ],
    ),
    (
        "operation_owners",
        &["operation_id", "workspace_id", "created_at"],
    ),
    (
        "operations",
        &[
            "operation_id",
            "kind",
            "params_hash",
            "state",
            "result_json",
            "created_at",
            "updated_at",
        ],
    ),
    (
        "pending_gc_files",
        &[
            "hash",
            "path",
            "state",
            "last_error",
            "queued_at",
            "cleaned_at",
        ],
    ),
    (
        "pins",
        &[
            "pin_id",
            "branch_id",
            "workspace_id",
            "revision",
            "root_hash",
            "created_at",
        ],
    ),
    (
        "recovery_records",
        &[
            "record_id",
            "operation_id",
            "workspace_id",
            "state",
            "data_json",
            "initial_data_json",
            "created_at",
            "updated_at",
        ],
    ),
    (
        "domain_records",
        &[
            "record_id",
            "workspace_id",
            "record_type",
            "state",
            "session_id",
            "thread_id",
            "run_id",
            "branch_id",
            "revision",
            "result_revision",
            "payload_json",
            "created_at",
            "updated_at",
        ],
    ),
    ("domain_record_refs", &["record_id", "slot", "object_hash"]),
    ("recovery_roots", &["record_id", "root_hash"]),
    (
        "revisions",
        &[
            "branch_id",
            "revision",
            "root_hash",
            "parent_revision",
            "operation_id",
            "created_at",
        ],
    ),
    ("root_blobs", &["root_hash", "blob_hash"]),
    ("root_parents", &["root_hash", "parent_root"]),
    ("trie_nodes", &["hash", "children_json", "state_json"]),
];
