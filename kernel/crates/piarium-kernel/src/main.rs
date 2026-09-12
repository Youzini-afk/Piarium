use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use fs2::FileExt;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use uuid::Uuid;

mod authority;
mod error;
mod model;
mod protocol;
mod runtime;
use authority::{path_allowed, require_capability};
use error::KernelError;
use model::{BlobStream, BranchRow, BuildTree, Grant, PathState, TrieNode};
use protocol::*;

struct StorageLock {
    _file: File,
}

impl Drop for StorageLock {
    fn drop(&mut self) {
        let _ = self._file.unlock();
    }
}

struct Storage {
    root: PathBuf,
    conn: Connection,
    _lock: StorageLock,
    cancellation: Option<Arc<AtomicBool>>,
    streams: HashMap<String, BlobStream>,
}

impl Storage {
    fn open(root: &Path, host_id: &str) -> Result<Self, KernelError> {
        fs::create_dir_all(root)?;
        for directory in ["objects", "staging"] {
            fs::create_dir_all(root.join(directory))?;
        }
        if let Ok(entries) = fs::read_dir(root.join("staging")) {
            for entry in entries.flatten() {
                if entry.path().extension().and_then(|value| value.to_str()) == Some("stream") {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
        let lock_path = root.join("kernel.lock");
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(&lock_path)?;
        if file.try_lock_exclusive().is_err() {
            return Err(KernelError::Storage(format!(
                "storage is owned by another Host: {}",
                root.display()
            )));
        }
        file.set_len(0)?;
        let lock_record =
            json!({"hostId": host_id, "pid": std::process::id(), "createdAt": now_ms()});
        file.write_all(lock_record.to_string().as_bytes())?;
        file.sync_all()?;
        let catalog_path = root.join("catalog.sqlite");
        let catalog_existed = catalog_path.exists();
        let conn = Connection::open(catalog_path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
             CREATE TABLE IF NOT EXISTS recovery_records (record_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, workspace_id TEXT NOT NULL, state TEXT NOT NULL, data_json TEXT NOT NULL, initial_data_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS pending_gc_files (hash TEXT PRIMARY KEY, path TEXT NOT NULL, state TEXT NOT NULL, last_error TEXT, queued_at INTEGER NOT NULL, cleaned_at INTEGER);
             CREATE INDEX IF NOT EXISTS revisions_root ON revisions(root_hash);
             CREATE INDEX IF NOT EXISTS pins_root ON pins(root_hash);
             CREATE INDEX IF NOT EXISTS root_blobs_blob ON root_blobs(blob_hash);
             CREATE INDEX IF NOT EXISTS recovery_operation ON recovery_records(operation_id);",
        )?;
        let format: Option<String> = conn
            .query_row(
                "SELECT value FROM metadata WHERE key = 'format_version'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        match (catalog_existed, format) {
            (false, None) => {
                conn.execute(
                    "INSERT INTO metadata(key, value) VALUES ('format_version', ?1)",
                    params![STORAGE_FORMAT_VERSION],
                )?;
            }
            (_, Some(value)) if value == STORAGE_FORMAT_VERSION => {}
            (_, Some(value)) => {
                return Err(KernelError::Storage(format!(
                    "unsupported catalog format version: {value}"
                )))
            }
            (true, None) => {
                return Err(KernelError::Storage(
                    "catalog format version is missing".to_string(),
                ))
            }
        }
        let mut storage = Self {
            root: PathBuf::from(root),
            conn,
            _lock: StorageLock { _file: file },
            cancellation: None,
            streams: HashMap::new(),
        };
        // A process may have exited after the SQLite commit and before the
        // object unlink. Retry durable cleanup on the next owner start; a
        // failure remains visible through health instead of being swallowed.
        storage.sweep_orphan_objects()?;
        let _ = storage.drain_gc_files();
        Ok(storage)
    }

    fn set_cancellation(&mut self, cancellation: Arc<AtomicBool>) {
        self.cancellation = Some(cancellation);
    }
    fn clear_cancellation(&mut self) {
        self.cancellation = None;
    }
    fn check_cancelled(&self) -> Result<(), KernelError> {
        if self
            .cancellation
            .as_ref()
            .is_some_and(|token| token.load(Ordering::Acquire))
        {
            return Err(KernelError::Cancelled);
        }
        Ok(())
    }

    fn operation_existing(
        &self,
        id: &str,
        kind: &str,
        params_hash: &str,
    ) -> Result<Option<Value>, KernelError> {
        let row: Option<(String, String, String, Option<String>)> = self.conn.query_row(
            "SELECT kind, params_hash, state, result_json FROM operations WHERE operation_id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).optional()?;
        match row {
            None => Ok(None),
            Some((stored_kind, stored_hash, state, result)) => {
                if stored_kind != kind || stored_hash != params_hash {
                    return Err(KernelError::Operation(format!(
                        "operationId {id} was reused with different parameters"
                    )));
                }
                if state == "failed" {
                    return Ok(None);
                }
                match result {
                    Some(text) => Ok(Some(serde_json::from_str(&text)?)),
                    None => Err(KernelError::Operation(format!(
                        "operationId {id} is still in progress"
                    ))),
                }
            }
        }
    }

    fn operation_begin(
        &mut self,
        id: &str,
        kind: &str,
        params_hash: &str,
    ) -> Result<(), KernelError> {
        self.conn.execute(
            "INSERT INTO operations(operation_id, kind, params_hash, state, created_at, updated_at) VALUES (?1, ?2, ?3, 'started', ?4, ?4)",
            params![id, kind, params_hash, now_ms()],
        )?;
        Ok(())
    }

    fn operation_finish(&mut self, id: &str, result: &Value) -> Result<(), KernelError> {
        if std::env::var_os("PIARIUM_KERNEL_FAIL_OPERATION_FINISH").is_some() {
            return Err(KernelError::Storage(
                "injected operation finish failure".to_string(),
            ));
        }
        self.conn.execute(
            "UPDATE operations SET state = 'committed', result_json = ?2, updated_at = ?3 WHERE operation_id = ?1",
            params![id, serde_json::to_string(result)?, now_ms()],
        )?;
        Ok(())
    }

    fn operation_failed(&mut self, id: &str, error: &KernelError) -> Result<(), KernelError> {
        self.conn.execute(
            "UPDATE operations SET state = 'failed', result_json = ?2, updated_at = ?3 WHERE operation_id = ?1",
            params![id, serde_json::to_string(&json!({"error": error.to_string()}))?, now_ms()],
        )?;
        Ok(())
    }

    fn record_root_blobs(&mut self, root: &str) -> Result<(), KernelError> {
        let mut nodes = BTreeSet::new();
        let mut blobs = BTreeSet::new();
        self.collect_reachable(root, &mut nodes, &mut blobs)?;
        for blob in blobs {
            self.conn.execute(
                "INSERT OR IGNORE INTO root_blobs(root_hash, blob_hash) VALUES (?1, ?2)",
                params![root, blob],
            )?;
        }
        Ok(())
    }

    fn record_root_parent(&mut self, root: &str, parent: &str) -> Result<(), KernelError> {
        if root != parent {
            self.conn.execute(
                "INSERT OR IGNORE INTO root_parents(root_hash, parent_root) VALUES (?1, ?2)",
                params![root, parent],
            )?;
        }
        Ok(())
    }

    fn record_root_blob_hashes(
        &mut self,
        root: &str,
        hashes: impl IntoIterator<Item = String>,
    ) -> Result<(), KernelError> {
        for hash in hashes {
            self.conn.execute(
                "INSERT OR IGNORE INTO root_blobs(root_hash, blob_hash) VALUES (?1, ?2)",
                params![root, hash],
            )?;
        }
        Ok(())
    }

    fn load_grant(&self, grant_id: &str) -> Result<Grant, KernelError> {
        let json: String = self
            .conn
            .query_row(
                "SELECT grant_json FROM grants WHERE grant_id = ?1",
                params![grant_id],
                |row| row.get(0),
            )
            .map_err(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => {
                    KernelError::Authorization("grant not found".to_string())
                }
                other => other.into(),
            })?;
        serde_json::from_str(&json)
            .map_err(|error| KernelError::Storage(format!("grant is corrupt: {error}")))
    }

    fn issue_grant(
        &mut self,
        params: &Value,
        host_id: &str,
        expected_host_generation: &str,
        storage_identity: &str,
        epoch: &str,
    ) -> Result<Value, KernelError> {
        let grant_id = params
            .get("grantId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Authorization("grantId is required".to_string()))?;
        let supplied_host_generation = params
            .get("hostGeneration")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Authorization("hostGeneration is required".to_string()))?;
        if supplied_host_generation != expected_host_generation {
            return Err(KernelError::Authorization(
                "grant host generation does not match Host".to_string(),
            ));
        }
        let requested_storage = params
            .get("storageIdentity")
            .and_then(Value::as_str)
            .unwrap_or(storage_identity);
        if requested_storage != storage_identity {
            return Err(KernelError::Authorization(
                "grant storage identity does not match kernel storage".to_string(),
            ));
        }
        let parse_optional = |key: &str| -> Result<Option<String>, KernelError> {
            match params.get(key) {
                None | Some(Value::Null) => Ok(None),
                Some(Value::String(value)) if !value.is_empty() => Ok(Some(value.clone())),
                _ => Err(KernelError::Authorization(format!(
                    "grant {key} is malformed"
                ))),
            }
        };
        let capabilities: BTreeSet<String> = params
            .get("capabilities")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                KernelError::Authorization("grant capabilities are required".to_string())
            })?
            .iter()
            .map(|value| {
                value.as_str().map(str::to_string).ok_or_else(|| {
                    KernelError::Authorization("grant capability is malformed".to_string())
                })
            })
            .collect::<Result<_, _>>()?;
        if capabilities.is_empty() {
            return Err(KernelError::Authorization(
                "grant capabilities are empty".to_string(),
            ));
        }
        let path_scopes = params
            .get("pathScopes")
            .and_then(Value::as_array)
            .ok_or_else(|| KernelError::Authorization("grant pathScopes are required".to_string()))?
            .iter()
            .map(|value| {
                let raw = value.as_str().ok_or_else(|| {
                    KernelError::Authorization("grant path scope is malformed".to_string())
                })?;
                if raw.is_empty() {
                    Ok(String::new())
                } else {
                    Ok(Self::validate_path(raw)?.join("/"))
                }
            })
            .collect::<Result<Vec<_>, KernelError>>()?;
        let owning_workspace = parse_optional("owningWorkspace")?;
        let execution_workspace = parse_optional("executionWorkspace")?;
        let grant = Grant {
            grant_id: grant_id.to_string(),
            host_id: host_id.to_string(),
            host_generation: supplied_host_generation.to_string(),
            session_id: parse_optional("sessionId")?,
            thread_id: parse_optional("threadId")?,
            run_id: parse_optional("runId")?,
            owning_workspace,
            execution_workspace,
            storage_identity: storage_identity.to_string(),
            capabilities,
            path_scopes,
            kernel_epoch: epoch.to_string(),
            revoked: false,
        };
        let params_hash = hash_json(params)?;
        if let Some((stored_hash, stored_json)) = self
            .conn
            .query_row(
                "SELECT params_hash, grant_json FROM grants WHERE grant_id = ?1",
                params![grant_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?
        {
            if stored_hash != params_hash {
                return Err(KernelError::Authorization(
                    "grantId was reused with different parameters".to_string(),
                ));
            }
            return Ok(serde_json::from_str(&stored_json)?);
        }
        self.conn.execute("INSERT INTO grants(grant_id, host_id, grant_json, params_hash, revoked, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)", params![grant_id, host_id, serde_json::to_string(&grant)?, params_hash, now_ms()])?;
        Ok(serde_json::to_value(grant)?)
    }

    fn revoke_grant(&mut self, params: &Value, host_id: &str) -> Result<Value, KernelError> {
        let grant_id = params
            .get("grantId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Authorization("grantId is required".to_string()))?;
        let grant = self.load_grant(grant_id)?;
        if grant.host_id != host_id {
            return Err(KernelError::Authorization(
                "grant belongs to another Host".to_string(),
            ));
        }
        let mut revoked = grant;
        revoked.revoked = true;
        self.conn.execute(
            "UPDATE grants SET revoked = 1, updated_at = ?2, grant_json = ?3 WHERE grant_id = ?1",
            params![grant_id, now_ms(), serde_json::to_string(&revoked)?],
        )?;
        Ok(json!({"grantId": grant_id, "revoked": true}))
    }

    fn blob_owned(&self, hash: &str, workspace: Option<&str>) -> Result<bool, KernelError> {
        let query = if workspace.is_some() {
            "WITH RECURSIVE roots(root_hash) AS (SELECT base_root FROM branches WHERE workspace_id = ?2 UNION SELECT head_root FROM branches WHERE workspace_id = ?2 UNION SELECT r.root_hash FROM revisions r JOIN branches b ON b.branch_id = r.branch_id WHERE b.workspace_id = ?2 UNION SELECT p.root_hash FROM pins p WHERE p.workspace_id = ?2 UNION SELECT rr.root_hash FROM recovery_roots rr JOIN recovery_records rec ON rec.record_id = rr.record_id WHERE rec.workspace_id = ?2 UNION SELECT parent.root_hash FROM root_parents parent JOIN roots ON parent.parent_root = roots.root_hash) SELECT 1 FROM root_blobs rb JOIN roots ON roots.root_hash = rb.root_hash WHERE rb.blob_hash = ?1 LIMIT 1"
        } else {
            "WITH RECURSIVE roots(root_hash) AS (SELECT base_root FROM branches UNION SELECT head_root FROM branches UNION SELECT root_hash FROM revisions UNION SELECT root_hash FROM pins UNION SELECT root_hash FROM recovery_roots UNION SELECT parent.root_hash FROM root_parents parent JOIN roots ON parent.parent_root = roots.root_hash) SELECT 1 FROM root_blobs rb JOIN roots ON roots.root_hash = rb.root_hash WHERE rb.blob_hash = ?1 LIMIT 1"
        };
        let row: Option<i64> = if let Some(workspace) = workspace {
            self.conn
                .query_row(query, params![hash, workspace], |row| row.get(0))
                .optional()?
        } else {
            self.conn
                .query_row(query, params![hash], |row| row.get(0))
                .optional()?
        };
        Ok(row.is_some())
    }

    fn authorize(
        &self,
        grant_id: Option<&str>,
        epoch: &str,
        host_id: &str,
        host_generation: &str,
        method: &str,
        params: &Value,
    ) -> Result<(Grant, Value), KernelError> {
        let grant_id = grant_id
            .ok_or_else(|| KernelError::Authorization("grantId is required".to_string()))?;
        let grant = self.load_grant(grant_id)?;
        if grant.revoked {
            return Err(KernelError::Authorization("grant is revoked".to_string()));
        }
        if grant.host_id != host_id
            || grant.host_generation != host_generation
            || grant.kernel_epoch != epoch
            || grant.storage_identity != self.root.to_string_lossy()
        {
            return Err(KernelError::Authorization(
                "grant identity is stale".to_string(),
            ));
        }
        require_capability(&grant, method)?;
        let mut authorized = params.clone();
        let workspace = if let Some(workspace) = params.get("workspaceId").and_then(Value::as_str) {
            Some(workspace.to_string())
        } else if let Some(branch_id) = params.get("branchId").and_then(Value::as_str) {
            let branch_workspace: Option<String> = self
                .conn
                .query_row(
                    "SELECT workspace_id FROM branches WHERE branch_id = ?1",
                    params![branch_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            if branch_workspace.is_some() {
                branch_workspace
            } else if let Some(pin_id) = params.get("pinId").and_then(Value::as_str) {
                self.conn
                    .query_row(
                        "SELECT workspace_id FROM pins WHERE pin_id = ?1 AND branch_id = ?2",
                        params![pin_id, branch_id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?
            } else {
                None
            }
        } else if let Some(pin_id) = params.get("pinId").and_then(Value::as_str) {
            self.conn
                .query_row(
                    "SELECT workspace_id FROM pins WHERE pin_id = ?1",
                    params![pin_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
        } else {
            None
        };
        if let Some(owning) = &grant.owning_workspace {
            if workspace.as_deref() != Some(owning.as_str()) {
                return Err(KernelError::Authorization(
                    "grant workspace does not match resource".to_string(),
                ));
            }
            if params.get("workspaceId").is_none() {
                if let Some(object) = authorized.as_object_mut() {
                    object.insert("workspaceId".to_string(), Value::String(owning.clone()));
                }
            }
        }
        for field in ["paths", "entries", "changes"] {
            if let Some(values) = params.get(field).and_then(Value::as_array) {
                for value in values {
                    let path = value
                        .get("path")
                        .and_then(Value::as_str)
                        .or_else(|| value.as_str())
                        .ok_or_else(|| {
                            KernelError::Authorization(
                                "grant path subject is malformed".to_string(),
                            )
                        })?;
                    let canonical = Self::validate_path(path)?.join("/");
                    if !path_allowed(&grant, &canonical) {
                        return Err(KernelError::Authorization(format!(
                            "path is outside grant scope: {canonical}"
                        )));
                    }
                }
            }
        }
        if method == "storage.getBlob" {
            let hash = params
                .get("hash")
                .and_then(Value::as_str)
                .ok_or_else(|| KernelError::Authorization("hash is required".to_string()))?;
            if !self.blob_owned(hash, grant.owning_workspace.as_deref())? {
                return Err(KernelError::Authorization(
                    "content object is not owned by the grant".to_string(),
                ));
            }
        }
        Ok((grant, authorized))
    }

    fn load_node(&self, hash: &str) -> Result<TrieNode, KernelError> {
        let encoded: Option<String> = self
            .conn
            .query_row(
                "SELECT children_json, state_json FROM trie_nodes WHERE hash = ?1",
                params![hash],
                |row| row.get(0),
            )
            .optional()?;
        let encoded =
            encoded.ok_or_else(|| KernelError::Storage(format!("missing trie node {hash}")))?;
        let node: TrieNode = serde_json::from_str(&encoded)?;
        if node_hash(&node) != hash {
            return Err(KernelError::Storage(format!("corrupt trie node {hash}")));
        }
        Ok(node)
    }

    fn store_node(&mut self, node: &TrieNode) -> Result<String, KernelError> {
        let hash = node_hash(node);
        self.conn.execute(
            "INSERT OR IGNORE INTO trie_nodes(hash, children_json, state_json) VALUES (?1, ?2, ?3)",
            params![hash, serde_json::to_string(node)?, Option::<String>::None],
        )?;
        Ok(hash)
    }

    fn empty_root(&mut self) -> Result<String, KernelError> {
        self.store_node(&TrieNode::Path {
            state: None,
            children: None,
        })
    }

    fn root_entries(&self, root: &str) -> Result<Vec<(String, PathState)>, KernelError> {
        let mut output = Vec::new();
        self.walk_path_entries(root, "", &mut output)?;
        Ok(output)
    }

    fn walk_path_entries(
        &self,
        hash: &str,
        prefix: &str,
        output: &mut Vec<(String, PathState)>,
    ) -> Result<(), KernelError> {
        self.check_cancelled()?;
        let TrieNode::Path { state, children } = self.load_node(hash)? else {
            return Err(KernelError::Storage(
                "path root points to an index node".to_string(),
            ));
        };
        if let Some(state) = state {
            output.push((prefix.to_string(), state));
        }
        if let Some(children) = children {
            self.walk_index_entries(&children, prefix, output)?;
        }
        Ok(())
    }

    fn walk_index_entries(
        &self,
        hash: &str,
        prefix: &str,
        output: &mut Vec<(String, PathState)>,
    ) -> Result<(), KernelError> {
        self.check_cancelled()?;
        let TrieNode::Index {
            key,
            child,
            left,
            right,
            ..
        } = self.load_node(hash)?
        else {
            return Err(KernelError::Storage(
                "index root points to a path node".to_string(),
            ));
        };
        if let Some(left) = left {
            self.walk_index_entries(&left, prefix, output)?;
        }
        let child_prefix = if prefix.is_empty() {
            key
        } else {
            format!("{prefix}/{key}")
        };
        self.walk_path_entries(&child, &child_prefix, output)?;
        if let Some(right) = right {
            self.walk_index_entries(&right, prefix, output)?;
        }
        Ok(())
    }

    fn index_height(&self, hash: Option<&String>) -> Result<i32, KernelError> {
        let Some(hash) = hash else {
            return Ok(0);
        };
        let TrieNode::Index { height, .. } = self.load_node(hash)? else {
            return Err(KernelError::Storage(
                "index height requested for a path node".to_string(),
            ));
        };
        Ok(i32::from(height))
    }

    fn make_index(
        &mut self,
        key: String,
        child: String,
        left: Option<String>,
        right: Option<String>,
    ) -> Result<String, KernelError> {
        let height = (self
            .index_height(left.as_ref())?
            .max(self.index_height(right.as_ref())?)
            + 1) as u16;
        self.store_node(&TrieNode::Index {
            key,
            child,
            left,
            right,
            height,
        })
    }

    fn index_get(&self, root: Option<&String>, key: &str) -> Result<Option<String>, KernelError> {
        let Some(root) = root else {
            return Ok(None);
        };
        let TrieNode::Index {
            key: current,
            child,
            left,
            right,
            ..
        } = self.load_node(root)?
        else {
            return Err(KernelError::Storage("path node used as index".to_string()));
        };
        match key.cmp(&current) {
            std::cmp::Ordering::Equal => Ok(Some(child)),
            std::cmp::Ordering::Less => self.index_get(left.as_ref(), key),
            std::cmp::Ordering::Greater => self.index_get(right.as_ref(), key),
        }
    }

    fn rotate_left(&mut self, root: String) -> Result<String, KernelError> {
        let TrieNode::Index {
            key,
            child,
            left,
            right: Some(right),
            ..
        } = self.load_node(&root)?
        else {
            return Ok(root);
        };
        let TrieNode::Index {
            key: right_key,
            child: right_child,
            left: right_left,
            right: right_right,
            ..
        } = self.load_node(&right)?
        else {
            return Err(KernelError::Storage("invalid AVL right child".to_string()));
        };
        let next_left = self.make_index(key, child, left, right_left)?;
        self.make_index(right_key, right_child, Some(next_left), right_right)
    }

    fn rotate_right(&mut self, root: String) -> Result<String, KernelError> {
        let TrieNode::Index {
            key,
            child,
            left: Some(left),
            right,
            ..
        } = self.load_node(&root)?
        else {
            return Ok(root);
        };
        let TrieNode::Index {
            key: left_key,
            child: left_child,
            left: left_left,
            right: left_right,
            ..
        } = self.load_node(&left)?
        else {
            return Err(KernelError::Storage("invalid AVL left child".to_string()));
        };
        let next_right = self.make_index(key, child, left_right, right)?;
        self.make_index(left_key, left_child, left_left, Some(next_right))
    }

    fn balance_index(&mut self, root: String) -> Result<String, KernelError> {
        let TrieNode::Index {
            key,
            child,
            left,
            right,
            ..
        } = self.load_node(&root)?
        else {
            return Ok(root);
        };
        let balance = self.index_height(left.as_ref())? - self.index_height(right.as_ref())?;
        if balance > 1 {
            let left_hash = left.as_ref().expect("balance implies left child");
            let TrieNode::Index {
                left: left_left,
                right: left_right,
                ..
            } = self.load_node(left_hash)?
            else {
                return Err(KernelError::Storage("invalid AVL left node".to_string()));
            };
            let left_balance =
                self.index_height(left_left.as_ref())? - self.index_height(left_right.as_ref())?;
            if left_balance < 0 {
                let rotated = self.rotate_left(left_hash.clone())?;
                let rebuilt = self.make_index(key, child, Some(rotated), right)?;
                return self.rotate_right(rebuilt);
            }
            return self.rotate_right(root);
        }
        if balance < -1 {
            let right_hash = right.as_ref().expect("balance implies right child");
            let TrieNode::Index {
                left: right_left,
                right: right_right,
                ..
            } = self.load_node(right_hash)?
            else {
                return Err(KernelError::Storage("invalid AVL right node".to_string()));
            };
            let right_balance = self.index_height(right_left.as_ref())?
                - self.index_height(right_right.as_ref())?;
            if right_balance > 0 {
                let rotated = self.rotate_right(right_hash.clone())?;
                let rebuilt = self.make_index(key, child, left, Some(rotated))?;
                return self.rotate_left(rebuilt);
            }
            return self.rotate_left(root);
        }
        Ok(root)
    }

    fn index_set(
        &mut self,
        root: Option<String>,
        key: String,
        child: String,
    ) -> Result<String, KernelError> {
        self.check_cancelled()?;
        let Some(root) = root else {
            return self.make_index(key, child, None, None);
        };
        let TrieNode::Index {
            key: current,
            child: current_child,
            left,
            right,
            ..
        } = self.load_node(&root)?
        else {
            return Err(KernelError::Storage("path node used as index".to_string()));
        };
        let next = match key.cmp(&current) {
            std::cmp::Ordering::Equal => self.make_index(current, child, left, right)?,
            std::cmp::Ordering::Less => {
                let next_left = self.index_set(left, key, child)?;
                self.make_index(current, current_child, Some(next_left), right)?
            }
            std::cmp::Ordering::Greater => {
                let next_right = self.index_set(right, key, child)?;
                self.make_index(current, current_child, left, Some(next_right))?
            }
        };
        self.balance_index(next)
    }

    fn root_set(
        &mut self,
        root: &str,
        segments: &[&str],
        state: PathState,
    ) -> Result<String, KernelError> {
        self.check_cancelled()?;
        let TrieNode::Path {
            state: current_state,
            children,
        } = self.load_node(root)?
        else {
            return Err(KernelError::Storage("index node used as path".to_string()));
        };
        if segments.is_empty() {
            let children = if state.is_directory() { children } else { None };
            return self.store_node(&TrieNode::Path {
                state: Some(state),
                children,
            });
        }
        if current_state
            .as_ref()
            .is_some_and(|state| !state.is_directory())
        {
            return Err(KernelError::Operation(
                "a non-directory path cannot have descendants".to_string(),
            ));
        }
        let name = segments[0].to_string();
        let child_root = self
            .index_get(children.as_ref(), &name)?
            .unwrap_or(self.empty_root()?);
        let child = self.root_set(&child_root, &segments[1..], state)?;
        let next_index = self.index_set(children, name, child)?;
        self.store_node(&TrieNode::Path {
            state: current_state,
            children: Some(next_index),
        })
    }

    fn build_tree(entries: &[(Vec<String>, PathState)]) -> Result<BuildTree, KernelError> {
        let mut root = BuildTree::default();
        for (segments, state) in entries {
            let mut current = &mut root;
            for segment in segments {
                current = current.children.entry(segment.clone()).or_default();
            }
            if current.state.is_some() {
                return Err(KernelError::Operation(
                    "duplicate normalized path".to_string(),
                ));
            }
            current.state = Some(state.clone());
        }
        Ok(root)
    }

    fn build_index_balanced(
        &mut self,
        items: &[(String, String)],
        start: usize,
        end: usize,
    ) -> Result<Option<String>, KernelError> {
        if start >= end {
            return Ok(None);
        }
        let middle = start + (end - start) / 2;
        let left = self.build_index_balanced(items, start, middle)?;
        let right = self.build_index_balanced(items, middle + 1, end)?;
        Ok(Some(self.make_index(
            items[middle].0.clone(),
            items[middle].1.clone(),
            left,
            right,
        )?))
    }

    fn build_path_tree(&mut self, tree: BuildTree) -> Result<String, KernelError> {
        self.check_cancelled()?;
        let mut child_items = Vec::with_capacity(tree.children.len());
        for (key, child) in tree.children {
            self.check_cancelled()?;
            child_items.push((key, self.build_path_tree(child)?));
        }
        let index = self.build_index_balanced(&child_items, 0, child_items.len())?;
        self.store_node(&TrieNode::Path {
            state: tree.state,
            children: index,
        })
    }

    fn build_root(&mut self, entries: &[(Vec<String>, PathState)]) -> Result<String, KernelError> {
        self.check_cancelled()?;
        self.build_path_tree(Self::build_tree(entries)?)
    }

    fn root_get(&self, root: &str, path: &str) -> Result<Option<PathState>, KernelError> {
        let mut hash = root.to_string();
        for segment in path.split('/').filter(|segment| !segment.is_empty()) {
            let TrieNode::Path { children, .. } = self.load_node(&hash)? else {
                return Err(KernelError::Storage("index node used as path".to_string()));
            };
            let Some(child) = self.index_get(children.as_ref(), segment)? else {
                return Ok(None);
            };
            hash = child;
        }
        let TrieNode::Path { state, .. } = self.load_node(&hash)? else {
            return Err(KernelError::Storage("index node used as path".to_string()));
        };
        Ok(state)
    }

    fn branch(&self, branch_id: &str) -> Result<BranchRow, KernelError> {
        self.conn.query_row(
            "SELECT workspace_id, head_root, head_revision, write_revision FROM branches WHERE branch_id = ?1",
            params![branch_id],
            |row| Ok(BranchRow { workspace_id: row.get(0)?, head_root: row.get(1)?, head_revision: row.get(2)?, write_revision: row.get(3)? }),
        ).map_err(|error| match error { rusqlite::Error::QueryReturnedNoRows => KernelError::Operation(format!("branch not found: {branch_id}")), other => other.into() })
    }

    fn validate_path(path: &str) -> Result<Vec<String>, KernelError> {
        if path.is_empty()
            || path.contains('\0')
            || path.starts_with('/')
            || path.starts_with('\\')
            || path.contains(':')
        {
            return Err(KernelError::Authorization(format!(
                "invalid relative path: {path}"
            )));
        }
        let normalized = path.replace('\\', "/");
        let parts: Vec<String> = normalized
            .split('/')
            .filter(|part| !part.is_empty() && *part != ".")
            .map(str::to_string)
            .collect();
        if parts.is_empty()
            || parts
                .iter()
                .any(|part| *part == ".." || part.contains('\0'))
        {
            return Err(KernelError::Authorization(format!(
                "invalid relative path: {path}"
            )));
        }
        Ok(parts)
    }

    fn parse_state(&self, state: &Value) -> Result<PathState, KernelError> {
        let parsed: PathState = serde_json::from_value(state.clone())
            .map_err(|error| KernelError::Operation(format!("invalid path state: {error}")))?;
        if let PathState::RegularFile {
            object_hash,
            byte_length,
            ..
        } = &parsed
        {
            if !object_hash.starts_with("sha256-")
                || object_hash.len() != 71
                || !object_hash[7..].chars().all(|c| c.is_ascii_hexdigit())
            {
                return Err(KernelError::Operation(
                    "regular-file.objectHash is malformed".to_string(),
                ));
            }
            let row: Option<i64> = self
                .conn
                .query_row(
                    "SELECT byte_length FROM blobs WHERE hash = ?1",
                    params![object_hash],
                    |row| row.get(0),
                )
                .optional()?;
            if row
                != Some(i64::try_from(*byte_length).map_err(|_| {
                    KernelError::Operation("regular-file.byteLength is too large".to_string())
                })?)
            {
                return Err(KernelError::Storage(format!(
                    "content object is not durable: {object_hash}"
                )));
            }
        }
        Ok(parsed)
    }

    fn put_blob(&mut self, params: &Value) -> Result<Value, KernelError> {
        let bytes = params
            .get("bytesBase64")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("bytesBase64 is required".to_string()))?;
        let decoded = BASE64
            .decode(bytes)
            .map_err(|error| KernelError::Operation(format!("invalid bytesBase64: {error}")))?;
        let hash = format!("sha256-{}", hex::encode(Sha256::digest(&decoded)));
        if let Some(expected) = params.get("expectedHash").and_then(Value::as_str) {
            if expected != hash {
                return Err(KernelError::Operation(
                    "content hash does not match expectedHash".to_string(),
                ));
            }
        }
        let target = object_path(&self.root, &hash)?;
        if target.exists() {
            let existing = fs::read(&target)?;
            let actual = format!("sha256-{}", hex::encode(Sha256::digest(&existing)));
            if actual != hash {
                return Err(KernelError::Storage(format!(
                    "content object is corrupt: {hash}"
                )));
            }
            if existing.len() != decoded.len() {
                return Err(KernelError::Storage(format!(
                    "content object length is corrupt: {hash}"
                )));
            }
        } else {
            let staging = self
                .root
                .join("staging")
                .join(format!("{}.object", Uuid::new_v4()));
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staging)?;
            file.write_all(&decoded)?;
            file.sync_all()?;
            drop(file);
            fs::create_dir_all(target.parent().unwrap())?;
            fs::rename(&staging, &target).or_else(|error| {
                if error.kind() == io::ErrorKind::AlreadyExists {
                    fs::remove_file(&staging)
                } else {
                    Err(error)
                }
            })?;
        }
        let recorded: Option<i64> = self
            .conn
            .query_row(
                "SELECT byte_length FROM blobs WHERE hash = ?1",
                params![hash],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(byte_length) = recorded {
            if byte_length != decoded.len() as i64 {
                return Err(KernelError::Storage(format!(
                    "content object metadata is corrupt: {hash}"
                )));
            }
        } else {
            self.conn.execute(
                "INSERT INTO blobs(hash, byte_length) VALUES (?1, ?2)",
                params![hash, decoded.len() as i64],
            )?;
        }
        Ok(json!({"hash": hash, "byteLength": decoded.len()}))
    }

    fn begin_blob_stream(&mut self, params: &Value, grant_id: &str) -> Result<Value, KernelError> {
        let operation_id = params
            .get("operationId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("operationId is required".to_string()))?;
        let expected_length = params
            .get("byteLength")
            .and_then(Value::as_u64)
            .ok_or_else(|| KernelError::Operation("byteLength is required".to_string()))?;
        let expected_hash = params
            .get("expectedHash")
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some((stream_id, stream)) = self
            .streams
            .iter()
            .find(|(_, stream)| stream.operation_id == operation_id)
        {
            if stream.grant_id != grant_id
                || stream.expected_length != expected_length
                || stream.expected_hash != expected_hash
            {
                return Err(KernelError::Operation(
                    "operationId was reused with different stream parameters".to_string(),
                ));
            }
            return Ok(
                json!({"streamId": stream_id, "operationId": operation_id, "byteLength": expected_length, "received": stream.received, "nextSequence": stream.next_sequence}),
            );
        }
        let stream_id = format!("stream-{}", Uuid::new_v4());
        let staging = self
            .root
            .join("staging")
            .join(format!("{stream_id}.stream"));
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging)?;
        self.streams.insert(
            stream_id.clone(),
            BlobStream {
                operation_id: operation_id.to_string(),
                expected_length,
                received: 0,
                next_sequence: 0,
                expected_hash,
                staging,
                grant_id: grant_id.to_string(),
            },
        );
        Ok(
            json!({"streamId": stream_id, "operationId": operation_id, "byteLength": expected_length}),
        )
    }

    fn stream_blob_chunk(&mut self, params: &Value, grant_id: &str) -> Result<(), KernelError> {
        self.check_cancelled()?;
        let stream_id = params
            .get("streamId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("streamId is required".to_string()))?;
        let sequence = params
            .get("sequence")
            .and_then(Value::as_u64)
            .ok_or_else(|| KernelError::Operation("sequence is required".to_string()))?;
        let bytes = params
            .get("bytesBase64")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("bytesBase64 is required".to_string()))?;
        let decoded = BASE64
            .decode(bytes)
            .map_err(|error| KernelError::Operation(format!("invalid bytesBase64: {error}")))?;
        let stream = self
            .streams
            .get_mut(stream_id)
            .ok_or_else(|| KernelError::Operation("stream not found".to_string()))?;
        if stream.grant_id != grant_id || stream.next_sequence != sequence {
            return Err(KernelError::Authorization(
                "content stream identity is invalid".to_string(),
            ));
        }
        let next = stream
            .received
            .checked_add(decoded.len() as u64)
            .ok_or_else(|| KernelError::Operation("content stream length overflow".to_string()))?;
        if next > stream.expected_length {
            return Err(KernelError::Operation(
                "content stream exceeds declared byteLength".to_string(),
            ));
        }
        let mut file = OpenOptions::new().append(true).open(&stream.staging)?;
        file.write_all(&decoded)?;
        stream.received = next;
        stream.next_sequence += 1;
        Ok(())
    }

    fn finish_blob_stream(&mut self, params: &Value, grant_id: &str) -> Result<Value, KernelError> {
        let stream_id = params
            .get("streamId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("streamId is required".to_string()))?;
        let stream = self
            .streams
            .remove(stream_id)
            .ok_or_else(|| KernelError::Operation("stream not found".to_string()))?;
        if stream.grant_id != grant_id {
            let _ = fs::remove_file(&stream.staging);
            return Err(KernelError::Authorization(
                "content stream identity is invalid".to_string(),
            ));
        }
        if let Some(expected_hash) = params.get("expectedHash").and_then(Value::as_str) {
            if stream.expected_hash.as_deref() != Some(expected_hash) {
                let _ = fs::remove_file(&stream.staging);
                return Err(KernelError::Operation(
                    "content stream expectedHash does not match operation".to_string(),
                ));
            }
        }
        if stream.received != stream.expected_length {
            let _ = fs::remove_file(&stream.staging);
            return Err(KernelError::Operation(
                "content stream ended before declared byteLength".to_string(),
            ));
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&stream.staging)?;
        file.sync_all()?;
        drop(file);
        let decoded = fs::read(&stream.staging)?;
        let hash = format!("sha256-{}", hex::encode(Sha256::digest(&decoded)));
        if stream
            .expected_hash
            .as_deref()
            .is_some_and(|expected| expected != hash)
        {
            let _ = fs::remove_file(&stream.staging);
            return Err(KernelError::Operation(
                "content hash does not match expectedHash".to_string(),
            ));
        }
        let target = object_path(&self.root, &hash)?;
        if target.exists() {
            let existing = fs::read(&target)?;
            if existing != decoded {
                let _ = fs::remove_file(&stream.staging);
                return Err(KernelError::Storage(format!(
                    "content object is corrupt: {hash}"
                )));
            }
            fs::remove_file(&stream.staging)?;
        } else {
            fs::create_dir_all(target.parent().unwrap())?;
            fs::rename(&stream.staging, &target)?;
        }
        self.conn.execute(
            "INSERT OR IGNORE INTO blobs(hash, byte_length) VALUES (?1, ?2)",
            params![hash, decoded.len() as i64],
        )?;
        Ok(json!({"hash": hash, "byteLength": decoded.len()}))
    }

    fn abort_blob_stream(&mut self, params: &Value, grant_id: &str) -> Result<Value, KernelError> {
        let stream_id = params
            .get("streamId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("streamId is required".to_string()))?;
        let Some(stream) = self.streams.remove(stream_id) else {
            return Ok(json!({"streamId": stream_id, "aborted": false}));
        };
        if stream.grant_id != grant_id {
            self.streams.insert(stream_id.to_string(), stream);
            return Err(KernelError::Authorization(
                "content stream identity is invalid".to_string(),
            ));
        }
        let _ = fs::remove_file(&stream.staging);
        Ok(json!({"streamId": stream_id, "aborted": true}))
    }

    fn get_blob(&self, params: &Value) -> Result<Value, KernelError> {
        let hash = params
            .get("hash")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("hash is required".to_string()))?;
        let path = object_path(&self.root, hash)?;
        let bytes = fs::read(path)?;
        let actual = format!("sha256-{}", hex::encode(Sha256::digest(&bytes)));
        if actual != hash {
            return Err(KernelError::Storage(format!(
                "content object is corrupt: {hash}"
            )));
        }
        let recorded: Option<i64> = self
            .conn
            .query_row(
                "SELECT byte_length FROM blobs WHERE hash = ?1",
                params![hash],
                |row| row.get(0),
            )
            .optional()?;
        if recorded != Some(bytes.len() as i64) {
            return Err(KernelError::Storage(format!(
                "content object metadata is missing or corrupt: {hash}"
            )));
        }
        let offset = params.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
        let length = params
            .get("length")
            .and_then(Value::as_u64)
            .map(|value| value as usize);
        let start = offset.min(bytes.len());
        let end = length
            .map(|value| start.saturating_add(value).min(bytes.len()))
            .unwrap_or(bytes.len());
        Ok(
            json!({"hash": hash, "byteLength": bytes.len(), "offset": start, "nextOffset": end, "eof": end >= bytes.len(), "bytesBase64": BASE64.encode(&bytes[start..end])}),
        )
    }

    fn validate_batch_paths(entries: &[(Vec<String>, PathState)]) -> Result<(), KernelError> {
        let mut seen = BTreeMap::new();
        for (segments, state) in entries {
            let path = segments.join("/");
            if seen.insert(path.clone(), state).is_some() {
                return Err(KernelError::Operation(format!(
                    "duplicate normalized path: {path}"
                )));
            }
        }
        for path in seen.keys() {
            let mut parent = String::new();
            for segment in path.split('/').take(path.matches('/').count()) {
                if !parent.is_empty() {
                    parent.push('/');
                }
                parent.push_str(segment);
                if seen.get(&parent).is_some_and(|state| !state.is_directory()) {
                    return Err(KernelError::Operation(format!(
                        "a non-directory path cannot have descendants: {parent}"
                    )));
                }
            }
        }
        Ok(())
    }

    fn create_branch(&mut self, params: &Value) -> Result<Value, KernelError> {
        let branch_id = params
            .get("branchId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("branchId is required".to_string()))?;
        let workspace_id = params
            .get("workspaceId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("workspaceId is required".to_string()))?;
        let mut identity_params = params.clone();
        if let Some(object) = identity_params.as_object_mut() {
            object.remove("operationId");
        }
        let create_params_hash = hash_json(&identity_params)?;
        let existing_identity: Option<(String, String)> = self
            .conn
            .query_row(
                "SELECT workspace_id, create_params_hash FROM branches WHERE branch_id = ?1",
                params![branch_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((existing_workspace, existing_hash)) = existing_identity {
            let existing = self.branch(branch_id)?;
            if existing_workspace == workspace_id && existing_hash == create_params_hash {
                return Ok(
                    json!({"branchId": branch_id, "root": existing.head_root, "writeRevision": existing.write_revision, "headRevision": existing.head_revision, "created": false}),
                );
            }
            if existing.workspace_id == workspace_id {
                return Err(KernelError::Operation(
                    "branchId was reused with different creation parameters".to_string(),
                ));
            }
            return Err(KernelError::Operation(
                "branchId belongs to another workspace".to_string(),
            ));
        }
        let entries = params
            .get("entries")
            .and_then(Value::as_array)
            .ok_or_else(|| KernelError::Operation("entries is required".to_string()))?;
        let mut entries_to_write = Vec::with_capacity(entries.len());
        for entry in entries {
            self.check_cancelled()?;
            let path = entry
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| KernelError::Operation("entry.path is required".to_string()))?;
            let segments = Self::validate_path(path)?;
            let state = entry
                .get("state")
                .cloned()
                .ok_or_else(|| KernelError::Operation("entry.state is required".to_string()))?;
            entries_to_write.push((segments, self.parse_state(&state)?));
        }
        Self::validate_batch_paths(&entries_to_write)?;
        let root = self.build_root(&entries_to_write)?;
        self.record_root_blobs(&root)?;
        let now = now_ms();
        self.conn.execute("INSERT INTO branches(branch_id, workspace_id, create_params_hash, base_root, head_root, head_revision, write_revision, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4, 0, 0, ?5, ?5)", params![branch_id, workspace_id, create_params_hash, root, now])?;
        self.conn.execute("INSERT OR IGNORE INTO revisions(branch_id, revision, root_hash, created_at) VALUES (?1, 0, ?2, ?3)", params![branch_id, root, now])?;
        Ok(
            json!({"branchId": branch_id, "root": root, "writeRevision": 0, "headRevision": 0, "created": true}),
        )
    }

    fn branch_read(&self, params: &Value) -> Result<Value, KernelError> {
        let branch_id = params
            .get("branchId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("branchId is required".to_string()))?;
        let branch = self.branch(branch_id)?;
        let requested_revision = params.get("revision").and_then(Value::as_i64);
        let (revision, root, view) = if let Some(revision) = requested_revision {
            if revision < 0 {
                return Err(KernelError::Operation(
                    "revision must be non-negative".to_string(),
                ));
            }
            let root = self
                .conn
                .query_row(
                    "SELECT root_hash FROM revisions WHERE branch_id = ?1 AND revision = ?2",
                    params![branch_id, revision],
                    |row| row.get::<_, String>(0),
                )
                .map_err(|error| match error {
                    rusqlite::Error::QueryReturnedNoRows => KernelError::Operation(format!(
                        "revision not found: {branch_id}@{revision}"
                    )),
                    other => other.into(),
                })?;
            (revision, root, "revision")
        } else {
            (branch.head_revision, branch.head_root.clone(), "current")
        };
        let requested = params.get("paths").and_then(Value::as_array);
        let entries = if let Some(paths) = requested {
            let mut selected = Vec::new();
            for path in paths.iter().filter_map(Value::as_str) {
                let canonical = Self::validate_path(path)?.join("/");
                if let Some(state) = self.root_get(&root, &canonical)? {
                    selected.push(json!({"path": canonical, "state": state}));
                }
            }
            selected
        } else if params
            .get("includeEntries")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            self.root_entries(&root)?
                .into_iter()
                .map(|(path, state)| json!({"path": path, "state": state}))
                .collect()
        } else {
            Vec::new()
        };
        Ok(
            json!({"branchId": branch_id, "workspaceId": branch.workspace_id, "root": root, "revision": revision, "view": view, "currentRoot": branch.head_root, "headRevision": branch.head_revision, "writeRevision": branch.write_revision, "entries": entries}),
        )
    }

    fn branch_write(&mut self, params: &Value) -> Result<Value, KernelError> {
        let branch_id = params
            .get("branchId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("branchId is required".to_string()))?;
        let expected = params
            .get("expectedWriteRevision")
            .and_then(Value::as_i64)
            .ok_or_else(|| {
                KernelError::Operation("expectedWriteRevision is required".to_string())
            })?;
        let branch = self.branch(branch_id)?;
        if branch.write_revision != expected {
            return Ok(
                json!({"status": "conflict", "writeRevision": branch.write_revision, "root": branch.head_root}),
            );
        }
        let changes = params
            .get("changes")
            .and_then(Value::as_array)
            .ok_or_else(|| KernelError::Operation("changes is required".to_string()))?;
        let mut changes_to_write = Vec::with_capacity(changes.len());
        for change in changes {
            self.check_cancelled()?;
            let path = change
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| KernelError::Operation("change.path is required".to_string()))?;
            let segments = Self::validate_path(path)?;
            let state = change
                .get("state")
                .cloned()
                .ok_or_else(|| KernelError::Operation("change.state is required".to_string()))?;
            changes_to_write.push((segments, self.parse_state(&state)?));
        }
        Self::validate_batch_paths(&changes_to_write)?;
        let previous_root = branch.head_root.clone();
        let changed_blobs = changes_to_write
            .iter()
            .filter_map(|(_, state)| state.object_hash().map(str::to_string))
            .collect::<Vec<_>>();
        let mut root = previous_root.clone();
        for (segments, state) in changes_to_write {
            let refs = segments.iter().map(String::as_str).collect::<Vec<_>>();
            root = self.root_set(&root, &refs, state)?;
        }
        let next = branch.write_revision + 1;
        self.conn.execute("UPDATE branches SET head_root = ?2, write_revision = ?3, updated_at = ?4 WHERE branch_id = ?1 AND write_revision = ?5", params![branch_id, root, next, now_ms(), expected])?;
        if self.conn.changes() != 1 {
            return Ok(
                json!({"status": "conflict", "writeRevision": self.branch(branch_id)?.write_revision, "root": self.branch(branch_id)?.head_root}),
            );
        }
        self.record_root_parent(&root, &previous_root)?;
        self.record_root_blob_hashes(&root, changed_blobs)?;
        Ok(json!({"status": "committed", "writeRevision": next, "root": root}))
    }

    fn branch_publish(&mut self, params: &Value) -> Result<Value, KernelError> {
        let branch_id = params
            .get("branchId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("branchId is required".to_string()))?;
        let branch = self.branch(branch_id)?;
        let revision = branch.head_revision + 1;
        self.conn.execute("INSERT INTO revisions(branch_id, revision, root_hash, operation_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)", params![branch_id, revision, branch.head_root, params.get("operationId").and_then(Value::as_str), now_ms()])?;
        self.conn.execute(
            "UPDATE branches SET head_revision = ?2, updated_at = ?3 WHERE branch_id = ?1",
            params![branch_id, revision, now_ms()],
        )?;
        Ok(
            json!({"branchId": branch_id, "revision": revision, "root": branch.head_root, "writeRevision": branch.write_revision}),
        )
    }

    fn branch_pin(&mut self, params: &Value, pin: bool) -> Result<Value, KernelError> {
        let branch_id = params
            .get("branchId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("branchId is required".to_string()))?;
        let pin_id = params
            .get("pinId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("pin-{}", Uuid::new_v4()));
        if !pin {
            let deleted = self.conn.execute(
                "DELETE FROM pins WHERE pin_id = ?1 AND branch_id = ?2",
                params![pin_id, branch_id],
            )?;
            return Ok(
                json!({"pinId": pin_id, "branchId": branch_id, "pinned": false, "released": deleted > 0}),
            );
        }
        let branch = self.branch(branch_id)?;
        let requested_revision = params.get("revision").and_then(Value::as_i64);
        let (revision, root) = if let Some(revision) = requested_revision {
            if revision < 0 {
                return Err(KernelError::Operation(
                    "revision must be non-negative".to_string(),
                ));
            }
            let root = self
                .conn
                .query_row(
                    "SELECT root_hash FROM revisions WHERE branch_id = ?1 AND revision = ?2",
                    params![branch_id, revision],
                    |row| row.get::<_, String>(0),
                )
                .map_err(|error| match error {
                    rusqlite::Error::QueryReturnedNoRows => KernelError::Operation(format!(
                        "revision not found: {branch_id}@{revision}"
                    )),
                    other => other.into(),
                })?;
            (revision, root)
        } else {
            (branch.head_revision, branch.head_root.clone())
        };
        self.conn.execute("INSERT OR REPLACE INTO pins(pin_id, branch_id, workspace_id, revision, root_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)", params![pin_id, branch_id, branch.workspace_id, revision, root, now_ms()])?;
        Ok(
            json!({"pinId": pin_id, "branchId": branch_id, "revision": revision, "root": root, "pinned": true}),
        )
    }

    fn branch_delete(&mut self, params: &Value) -> Result<Value, KernelError> {
        let branch_id = params
            .get("branchId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("branchId is required".to_string()))?;
        let deleted = self.conn.execute(
            "DELETE FROM branches WHERE branch_id = ?1",
            params![branch_id],
        )?;
        self.conn.execute(
            "DELETE FROM revisions WHERE branch_id = ?1",
            params![branch_id],
        )?;
        let pins: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM pins WHERE branch_id = ?1",
            params![branch_id],
            |row| row.get(0),
        )?;
        Ok(json!({"branchId": branch_id, "deleted": deleted > 0, "retainedPins": pins}))
    }

    fn pin_read(&self, params: &Value) -> Result<Value, KernelError> {
        let pin_id = params
            .get("pinId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("pinId is required".to_string()))?;
        let (branch_id, revision, root): (String, i64, String) = self
            .conn
            .query_row(
                "SELECT branch_id, revision, root_hash FROM pins WHERE pin_id = ?1",
                params![pin_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => {
                    KernelError::Operation(format!("pin not found: {pin_id}"))
                }
                other => other.into(),
            })?;
        let entries = if params
            .get("includeEntries")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            self.root_entries(&root)?
                .into_iter()
                .map(|(path, state)| json!({"path": path, "state": state}))
                .collect()
        } else {
            Vec::new()
        };
        Ok(
            json!({"pinId": pin_id, "branchId": branch_id, "revision": revision, "root": root, "entries": entries}),
        )
    }

    fn snapshot(&self, params_value: &Value) -> Result<Value, KernelError> {
        let mut branches = Vec::new();
        let requested_workspace = params_value.get("workspaceId").and_then(Value::as_str);
        let mut statement = self.conn.prepare("SELECT branch_id, workspace_id, base_root, head_root, head_revision, write_revision FROM branches WHERE (?1 IS NULL OR workspace_id = ?1) ORDER BY branch_id")?;
        for row in statement.query_map(params![requested_workspace], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })? {
            let (branch_id, workspace_id, base_root, head_root, head_revision, write_revision) =
                row?;
            let revisions = self.conn.prepare("SELECT revision, root_hash FROM revisions WHERE branch_id = ?1 ORDER BY revision")?.query_map(params![branch_id], |revision| Ok(json!({"revision": revision.get::<_,i64>(0)?, "root": revision.get::<_,String>(1)?})))?.collect::<Result<Vec<_>, _>>()?;
            branches.push(json!({"branchId": branch_id, "workspaceId": workspace_id, "baseRoot": base_root, "headRoot": head_root, "headRevision": head_revision, "writeRevision": write_revision, "revisions": revisions}));
        }
        Ok(json!({"workspaceId": requested_workspace, "branches": branches}))
    }

    fn branch_diff(&self, params: &Value) -> Result<Value, KernelError> {
        let left = params
            .get("leftRoot")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("leftRoot is required".to_string()))?;
        let right = params
            .get("rightRoot")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("rightRoot is required".to_string()))?;
        let mut added = Vec::new();
        let mut removed = Vec::new();
        let mut changed = Vec::new();
        self.diff_nodes(left, right, "", &mut added, &mut removed, &mut changed)?;
        Ok(
            json!({"leftRoot": left, "rightRoot": right, "added": added, "removed": removed, "changed": changed}),
        )
    }

    fn diff_nodes(
        &self,
        left_hash: &str,
        right_hash: &str,
        prefix: &str,
        added: &mut Vec<String>,
        removed: &mut Vec<String>,
        changed: &mut Vec<String>,
    ) -> Result<(), KernelError> {
        if left_hash == right_hash {
            return Ok(());
        }
        let left = self.load_node(left_hash)?;
        let right = self.load_node(right_hash)?;
        let (
            TrieNode::Path {
                state: left_state,
                children: left_children,
            },
            TrieNode::Path {
                state: right_state,
                children: right_children,
            },
        ) = (left, right)
        else {
            return Err(KernelError::Storage("path/index node mismatch".to_string()));
        };
        match (&left_state, &right_state) {
            (Some(a), Some(b)) if a != b => changed.push(prefix.to_string()),
            (Some(_), None) => removed.push(prefix.to_string()),
            (None, Some(_)) => added.push(prefix.to_string()),
            _ => {}
        }
        self.diff_indices(
            left_children.as_ref(),
            right_children.as_ref(),
            prefix,
            added,
            removed,
            changed,
        )
    }

    fn index_entries(
        &self,
        hash: &str,
        output: &mut Vec<(String, String)>,
    ) -> Result<(), KernelError> {
        self.check_cancelled()?;
        let TrieNode::Index {
            key,
            child,
            left,
            right,
            ..
        } = self.load_node(hash)?
        else {
            return Err(KernelError::Storage("path node used as index".to_string()));
        };
        if let Some(left) = left {
            self.index_entries(&left, output)?;
        }
        output.push((key, child));
        if let Some(right) = right {
            self.index_entries(&right, output)?;
        }
        Ok(())
    }

    fn diff_indices(
        &self,
        left: Option<&String>,
        right: Option<&String>,
        prefix: &str,
        added: &mut Vec<String>,
        removed: &mut Vec<String>,
        changed: &mut Vec<String>,
    ) -> Result<(), KernelError> {
        self.check_cancelled()?;
        if left == right {
            return Ok(());
        }
        let mut left_entries = Vec::new();
        let mut right_entries = Vec::new();
        if let Some(left) = left {
            self.index_entries(left, &mut left_entries)?;
        }
        if let Some(right) = right {
            self.index_entries(right, &mut right_entries)?;
        }
        let mut li = 0;
        let mut ri = 0;
        while li < left_entries.len() || ri < right_entries.len() {
            self.check_cancelled()?;
            match (left_entries.get(li), right_entries.get(ri)) {
                (Some((left_key, left_child)), Some((right_key, right_child)))
                    if left_key == right_key =>
                {
                    let path = if prefix.is_empty() {
                        left_key.clone()
                    } else {
                        format!("{prefix}/{left_key}")
                    };
                    self.diff_nodes(left_child, right_child, &path, added, removed, changed)?;
                    li += 1;
                    ri += 1;
                }
                (Some((left_key, left_child)), Some((right_key, _))) if left_key < right_key => {
                    let path = if prefix.is_empty() {
                        left_key.clone()
                    } else {
                        format!("{prefix}/{left_key}")
                    };
                    self.collect_paths(left_child, &path, removed)?;
                    li += 1;
                }
                (Some((_, _)), Some((right_key, right_child))) => {
                    let path = if prefix.is_empty() {
                        right_key.clone()
                    } else {
                        format!("{prefix}/{right_key}")
                    };
                    self.collect_paths(right_child, &path, added)?;
                    ri += 1;
                }
                (Some((left_key, left_child)), None) => {
                    let path = if prefix.is_empty() {
                        left_key.clone()
                    } else {
                        format!("{prefix}/{left_key}")
                    };
                    self.collect_paths(left_child, &path, removed)?;
                    li += 1;
                }
                (None, Some((right_key, right_child))) => {
                    let path = if prefix.is_empty() {
                        right_key.clone()
                    } else {
                        format!("{prefix}/{right_key}")
                    };
                    self.collect_paths(right_child, &path, added)?;
                    ri += 1;
                }
                (None, None) => break,
            }
        }
        Ok(())
    }

    fn collect_paths(
        &self,
        hash: &str,
        prefix: &str,
        target: &mut Vec<String>,
    ) -> Result<(), KernelError> {
        self.check_cancelled()?;
        let TrieNode::Path { state, children } = self.load_node(hash)? else {
            return Err(KernelError::Storage("index node used as path".to_string()));
        };
        if state.is_some() {
            target.push(prefix.to_string());
        }
        if let Some(children) = children {
            let mut entries = Vec::new();
            self.index_entries(&children, &mut entries)?;
            for (name, child) in entries {
                let child_prefix = if prefix.is_empty() {
                    name
                } else {
                    format!("{prefix}/{name}")
                };
                self.collect_paths(&child, &child_prefix, target)?;
            }
        }
        Ok(())
    }

    fn drain_gc_files(&mut self) -> Result<Value, KernelError> {
        let rows: Vec<(String, String)> = self
            .conn
            .prepare("SELECT hash, path FROM pending_gc_files WHERE state IN ('pending', 'failed') ORDER BY queued_at")?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<_, _>>()?;
        let mut deleted = Vec::new();
        let mut failures = Vec::new();
        for (hash, raw_path) in rows {
            if std::env::var_os("PIARIUM_KERNEL_FAIL_GC_DELETE").is_some() {
                let message = format!("{hash}: injected GC cleanup failure");
                self.conn.execute(
                    "UPDATE pending_gc_files SET state = 'failed', last_error = ?2 WHERE hash = ?1",
                    params![hash, message],
                )?;
                failures.push(message);
                continue;
            }
            match fs::remove_file(&raw_path) {
                Ok(()) => deleted.push(hash.clone()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => deleted.push(hash.clone()),
                Err(error) => {
                    let message = format!("{hash}: {error}");
                    self.conn.execute(
                        "UPDATE pending_gc_files SET state = 'failed', last_error = ?2 WHERE hash = ?1",
                        params![hash, message],
                    )?;
                    failures.push(message);
                }
            }
        }
        for hash in &deleted {
            self.conn.execute(
                "DELETE FROM pending_gc_files WHERE hash = ?1",
                params![hash],
            )?;
        }
        Ok(json!({"deleted": deleted, "failures": failures}))
    }

    fn sweep_orphan_objects(&mut self) -> Result<(), KernelError> {
        let objects_root = self.root.join("objects");
        let Ok(shards) = fs::read_dir(&objects_root) else {
            return Ok(());
        };
        for shard in shards.flatten() {
            let shard_path = shard.path();
            let shard_name = shard.file_name().to_string_lossy().to_string();
            if shard_name.len() != 2 || !shard_name.chars().all(|value| value.is_ascii_hexdigit()) {
                continue;
            }
            let Ok(files) = fs::read_dir(&shard_path) else {
                continue;
            };
            for file in files.flatten() {
                let file_path = file.path();
                if !file_path.is_file() {
                    continue;
                }
                let suffix = file.file_name().to_string_lossy().to_string();
                if suffix.len() != 62 || !suffix.chars().all(|value| value.is_ascii_hexdigit()) {
                    continue;
                }
                let hash = format!("sha256-{shard_name}{suffix}");
                let referenced: Option<i64> = self
                    .conn
                    .query_row(
                        "SELECT 1 FROM blobs WHERE hash = ?1 UNION SELECT 1 FROM root_blobs WHERE blob_hash = ?1 LIMIT 1",
                        params![hash],
                        |row| row.get(0),
                    )
                    .optional()?;
                if referenced.is_none() {
                    self.conn.execute(
                        "INSERT OR IGNORE INTO pending_gc_files(hash, path, state, queued_at) VALUES (?1, ?2, 'pending', ?3)",
                        params![hash, file_path.to_string_lossy().to_string(), now_ms()],
                    )?;
                }
            }
        }
        Ok(())
    }

    fn cleanup_status(&self) -> Result<(i64, Vec<String>), KernelError> {
        let pending: i64 =
            self.conn
                .query_row("SELECT COUNT(*) FROM pending_gc_files", [], |row| {
                    row.get(0)
                })?;
        let failures = self
            .conn
            .prepare(
                "SELECT last_error FROM pending_gc_files WHERE state = 'failed' ORDER BY queued_at",
            )?
            .query_map([], |row| row.get::<_, Option<String>>(0))?
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .flatten()
            .collect();
        Ok((pending, failures))
    }

    fn gc(&mut self) -> Result<Value, KernelError> {
        let mut roots = BTreeSet::new();
        for row in self
            .conn
            .prepare("SELECT base_root, head_root FROM branches")?
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
        {
            let (a, b) = row?;
            roots.insert(a);
            roots.insert(b);
        }
        for row in self.conn.prepare("SELECT root_hash FROM revisions UNION SELECT root_hash FROM pins UNION SELECT root_hash FROM recovery_roots")?.query_map([], |row| row.get::<_, String>(0))? { roots.insert(row?); }
        let mut nodes = BTreeSet::new();
        let mut blobs = BTreeSet::new();
        for root in roots {
            self.check_cancelled()?;
            self.collect_reachable(&root, &mut nodes, &mut blobs)?;
        }
        let all_nodes: Vec<String> = self
            .conn
            .prepare("SELECT hash FROM trie_nodes")?
            .query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        let mut deleted_nodes = 0;
        for hash in all_nodes {
            self.check_cancelled()?;
            if !nodes.contains(&hash) {
                self.conn
                    .execute("DELETE FROM trie_nodes WHERE hash = ?1", params![hash])?;
                deleted_nodes += 1;
            }
        }
        let all_blobs: Vec<String> = self
            .conn
            .prepare("SELECT hash FROM blobs")?
            .query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        let mut deleted_blobs = 0;
        for hash in all_blobs {
            self.check_cancelled()?;
            if !blobs.contains(&hash) {
                let path = object_path(&self.root, &hash)?;
                self.conn.execute(
                    "INSERT OR IGNORE INTO pending_gc_files(hash, path, state, queued_at) VALUES (?1, ?2, 'pending', ?3)",
                    params![hash, path.to_string_lossy().to_string(), now_ms()],
                )?;
                self.conn
                    .execute("DELETE FROM blobs WHERE hash = ?1", params![hash])?;
                deleted_blobs += 1;
            }
        }
        Ok(
            json!({"deletedNodes": deleted_nodes, "releasedBlobs": deleted_blobs, "deletedBlobs": 0, "cleanupFailures": [], "retainedNodes": nodes.len(), "retainedBlobs": blobs.len()}),
        )
    }

    fn collect_reachable(
        &self,
        hash: &str,
        nodes: &mut BTreeSet<String>,
        blobs: &mut BTreeSet<String>,
    ) -> Result<(), KernelError> {
        self.check_cancelled()?;
        if !nodes.insert(hash.to_string()) {
            return Ok(());
        }
        let node = self.load_node(hash)?;
        match node {
            TrieNode::Path { state, children } => {
                if let Some(state) = state {
                    if let Some(blob) = state.object_hash() {
                        blobs.insert(blob.to_string());
                    }
                }
                if let Some(children) = children {
                    self.collect_reachable(&children, nodes, blobs)?;
                }
            }
            TrieNode::Index {
                child, left, right, ..
            } => {
                self.collect_reachable(&child, nodes, blobs)?;
                if let Some(left) = left {
                    self.collect_reachable(&left, nodes, blobs)?;
                }
                if let Some(right) = right {
                    self.collect_reachable(&right, nodes, blobs)?;
                }
            }
        }
        Ok(())
    }

    fn recovery_operation(
        &mut self,
        method: &str,
        params_value: &Value,
    ) -> Result<Value, KernelError> {
        let operation_id = params_value
            .get("operationId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("operationId is required".to_string()))?;
        let record_id = params_value
            .get("recordId")
            .and_then(Value::as_str)
            .unwrap_or(operation_id);
        let workspace_id = params_value
            .get("workspaceId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let state = params_value.get("state").and_then(Value::as_str).unwrap_or(
            if method.ends_with("begin") {
                "started"
            } else {
                "updated"
            },
        );
        let data = params_value
            .get("data")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let data_json = serde_json::to_string(&data)?;
        let existing = self
            .conn
            .query_row(
                "SELECT 1 FROM recovery_records WHERE record_id = ?1",
                params![record_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        if existing.is_some() {
            self.conn.execute(
                "UPDATE recovery_records SET state = ?2, data_json = ?3, updated_at = ?4 WHERE record_id = ?1",
                params![record_id, state, data_json, now_ms()],
            )?;
        } else {
            self.conn.execute(
                "INSERT INTO recovery_records(record_id, operation_id, workspace_id, state, data_json, initial_data_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?6)",
                params![record_id, operation_id, workspace_id, state, data_json, now_ms()],
            )?;
        }
        for key in ["root", "rootHash"] {
            if let Some(root) = data.get(key).and_then(Value::as_str) {
                self.conn.execute(
                    "INSERT OR IGNORE INTO recovery_roots(record_id, root_hash) VALUES (?1, ?2)",
                    params![record_id, root],
                )?;
            }
        }
        Ok(
            json!({"recordId": record_id, "operationId": operation_id, "state": state, "data": data}),
        )
    }

    fn recovery_get(&self, params_value: &Value) -> Result<Value, KernelError> {
        let id = params_value
            .get("recordId")
            .or_else(|| params_value.get("operationId"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                KernelError::Operation("recordId or operationId is required".to_string())
            })?;
        let row: Option<(String, String, String, String, String)> = self.conn.query_row("SELECT operation_id, workspace_id, state, data_json, initial_data_json FROM recovery_records WHERE record_id = ?1", params![id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))).optional()?;
        let Some((operation_id, workspace_id, state, data, initial_data)) = row else {
            return Ok(Value::Null);
        };
        Ok(
            json!({"recordId": id, "operationId": operation_id, "workspaceId": workspace_id, "state": state, "data": serde_json::from_str::<Value>(&data)?, "initialData": serde_json::from_str::<Value>(&initial_data)?}),
        )
    }

    fn operation_get(&self, params_value: &Value) -> Result<Value, KernelError> {
        let id = params_value
            .get("operationId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("operationId is required".to_string()))?;
        let row: Option<(String, String, String, Option<String>, i64, i64)> = self.conn.query_row(
            "SELECT kind, params_hash, state, result_json, created_at, updated_at FROM operations WHERE operation_id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        ).optional()?;
        let Some((kind, params_hash, state, result, created_at, updated_at)) = row else {
            return Ok(Value::Null);
        };
        Ok(json!({
            "operationId": id,
            "kind": kind,
            "paramsHash": params_hash,
            "state": state,
            "result": result.map(|text| serde_json::from_str::<Value>(&text)).transpose()?,
            "createdAt": created_at,
            "updatedAt": updated_at,
        }))
    }

    fn health(&self, params: &Value) -> Result<Value, KernelError> {
        let integrity: String = self
            .conn
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        let branches: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM branches", [], |row| row.get(0))?;
        let nodes: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM trie_nodes", [], |row| row.get(0))?;
        let blobs: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM blobs", [], |row| row.get(0))?;
        let (pending_cleanup, cleanup_failures) = self.cleanup_status()?;
        let node_payload_bytes: i64 = self.conn.query_row("SELECT COALESCE(SUM(length(children_json) + COALESCE(length(state_json), 0)), 0) FROM trie_nodes", [], |row| row.get(0))?;
        if !params.get("deep").and_then(Value::as_bool).unwrap_or(false) {
            return Ok(
                json!({"integrity": integrity, "branches": branches, "nodes": nodes, "nodePayloadBytes": node_payload_bytes, "blobs": blobs, "storageRoot": self.root, "pendingCleanup": pending_cleanup, "cleanupFailures": cleanup_failures, "deep": false}),
            );
        }
        let mut roots = BTreeSet::new();
        for row in self
            .conn
            .prepare("SELECT base_root, head_root FROM branches")?
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
        {
            let (base, head) = row?;
            roots.insert(base);
            roots.insert(head);
        }
        for row in self.conn.prepare("SELECT root_hash FROM revisions UNION SELECT root_hash FROM pins UNION SELECT root_hash FROM recovery_roots")?.query_map([], |row| row.get::<_, String>(0))? { roots.insert(row?); }
        let mut reachable_nodes = BTreeSet::new();
        let mut reachable_blobs = BTreeSet::new();
        let mut missing_nodes = Vec::new();
        for root in roots {
            if let Err(error) =
                self.collect_reachable(&root, &mut reachable_nodes, &mut reachable_blobs)
            {
                missing_nodes.push(format!("{root}: {error}"));
            }
        }
        let mut missing_objects = Vec::new();
        let mut corrupt_objects = Vec::new();
        for hash in reachable_blobs {
            let recorded: Option<i64> = self
                .conn
                .query_row(
                    "SELECT byte_length FROM blobs WHERE hash = ?1",
                    params![hash],
                    |row| row.get(0),
                )
                .optional()?;
            match (recorded, fs::read(object_path(&self.root, &hash)?)) {
                (Some(length), Ok(bytes))
                    if length == bytes.len() as i64
                        && format!("sha256-{}", hex::encode(Sha256::digest(&bytes))) == hash => {}
                (None, _) => missing_objects.push(hash),
                (Some(_), Err(_)) => missing_objects.push(hash),
                _ => corrupt_objects.push(hash),
            }
        }
        let status = if integrity == "ok"
            && missing_nodes.is_empty()
            && missing_objects.is_empty()
            && corrupt_objects.is_empty()
            && cleanup_failures.is_empty()
        {
            "ok"
        } else {
            "degraded"
        };
        Ok(
            json!({"integrity": status, "sqliteIntegrity": integrity, "branches": branches, "nodes": nodes, "nodePayloadBytes": node_payload_bytes, "blobs": blobs, "storageRoot": self.root, "pendingCleanup": pending_cleanup, "cleanupFailures": cleanup_failures, "deep": true, "missingNodes": missing_nodes, "missingObjects": missing_objects, "corruptObjects": corrupt_objects}),
        )
    }
}

fn idempotent(
    storage: &mut Storage,
    kind: &str,
    params_value: &Value,
    action: impl FnOnce(&mut Storage) -> Result<Value, KernelError>,
) -> Result<Value, KernelError> {
    let operation_id = params_value
        .get("operationId")
        .and_then(Value::as_str)
        .ok_or_else(|| KernelError::Operation(format!("{kind} requires operationId")))?;
    let mut identity_params = params_value.clone();
    if kind == "storage.putBlob.finish" {
        if let Some(object) = identity_params.as_object_mut() {
            object.remove("streamId");
        }
    }
    let params_hash = hash_json(&identity_params)?;
    if let Some(result) = storage.operation_existing(operation_id, kind, &params_hash)? {
        return Ok(result);
    }
    if kind == "storage.gc" {
        storage.sweep_orphan_objects()?;
        let _ = storage.drain_gc_files()?;
    }
    storage.conn.execute(
        "DELETE FROM operations WHERE operation_id = ?1 AND state = 'failed'",
        params![operation_id],
    )?;
    storage.conn.execute_batch("BEGIN IMMEDIATE")?;
    let outcome = (|| {
        storage.operation_begin(operation_id, kind, &params_hash)?;
        let result = action(storage)?;
        storage.operation_finish(operation_id, &result)?;
        Ok::<Value, KernelError>(result)
    })();
    match outcome {
        Ok(result) => {
            storage.conn.execute_batch("COMMIT")?;
            if kind == "storage.gc" {
                let cleanup = storage.drain_gc_files()?;
                let mut enriched = result.clone();
                if let Some(object) = enriched.as_object_mut() {
                    let deleted = cleanup.get("deleted").cloned().unwrap_or_else(|| json!([]));
                    let failures = cleanup
                        .get("failures")
                        .cloned()
                        .unwrap_or_else(|| json!([]));
                    object.insert(
                        "deletedBlobs".to_string(),
                        json!(deleted.as_array().map_or(0, Vec::len)),
                    );
                    object.insert("cleanupFailures".to_string(), failures);
                }
                storage.conn.execute(
                    "UPDATE operations SET result_json = ?2, updated_at = ?3 WHERE operation_id = ?1",
                    params![operation_id, serde_json::to_string(&enriched)?, now_ms()],
                )?;
                return Ok(enriched);
            }
            Ok(result)
        }
        Err(error) => {
            let _ = storage.conn.execute_batch("ROLLBACK");
            storage.conn.execute_batch("BEGIN IMMEDIATE")?;
            storage.operation_begin(operation_id, kind, &params_hash)?;
            storage.operation_failed(operation_id, &error)?;
            storage.conn.execute_batch("COMMIT")?;
            Err(error)
        }
    }
}

fn recovery_idempotent(
    storage: &mut Storage,
    method: &str,
    params_value: &Value,
    action: impl FnOnce(&mut Storage) -> Result<Value, KernelError>,
) -> Result<Value, KernelError> {
    let operation_id = params_value
        .get("operationId")
        .and_then(Value::as_str)
        .ok_or_else(|| KernelError::Operation(format!("{method} requires operationId")))?;
    let record_id = params_value
        .get("recordId")
        .and_then(Value::as_str)
        .unwrap_or(operation_id);
    let workspace_id = params_value
        .get("workspaceId")
        .and_then(Value::as_str)
        .unwrap_or("");
    // Recovery updates are deliberately multi-stage: state/data may advance,
    // while the record, workspace and operation identity remain immutable.
    // The first data payload is retained in recovery_records.initial_data_json
    // for startup reconciliation and is never replaced by a later update.
    let identity_hash = hash_json(&json!({
        "operationId": operation_id,
        "recordId": record_id,
        "workspaceId": workspace_id,
    }))?;
    let stored: Option<(String, String, String, Option<String>)> = storage
        .conn
        .query_row(
            "SELECT kind, params_hash, state, result_json FROM operations WHERE operation_id = ?1",
            params![operation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    if let Some((kind, params_hash, state, result)) = &stored {
        if kind != "recovery.operation" || params_hash != &identity_hash {
            return Err(KernelError::Operation(format!(
                "operationId {operation_id} was reused with different parameters"
            )));
        }
        if method.ends_with(".begin") && state == "committed" {
            return result
                .as_deref()
                .map(serde_json::from_str)
                .transpose()?
                .ok_or_else(|| {
                    KernelError::Operation(format!(
                        "operationId {operation_id} has no committed recovery result"
                    ))
                });
        }
    }
    storage.conn.execute_batch("BEGIN IMMEDIATE")?;
    let outcome = (|| {
        if stored.is_some() {
            storage.conn.execute(
                "UPDATE operations SET state = 'started', result_json = NULL, updated_at = ?2 WHERE operation_id = ?1",
                params![operation_id, now_ms()],
            )?;
        } else {
            storage.operation_begin(operation_id, "recovery.operation", &identity_hash)?;
        }
        let result = action(storage)?;
        storage.operation_finish(operation_id, &result)?;
        Ok::<Value, KernelError>(result)
    })();
    match outcome {
        Ok(result) => {
            storage.conn.execute_batch("COMMIT")?;
            Ok(result)
        }
        Err(error) => {
            let _ = storage.conn.execute_batch("ROLLBACK");
            storage.conn.execute_batch("BEGIN IMMEDIATE")?;
            if stored.is_some() {
                storage.operation_failed(operation_id, &error)?;
            } else {
                storage.operation_begin(operation_id, "recovery.operation", &identity_hash)?;
                storage.operation_failed(operation_id, &error)?;
            }
            storage.conn.execute_batch("COMMIT")?;
            Err(error)
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    runtime::run()
}
