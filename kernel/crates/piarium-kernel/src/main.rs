use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;
use uuid::Uuid;

const PROTOCOL_VERSION: u64 = 1;
const KERNEL_VERSION: &str = "0.1.0";

#[derive(Debug, Error)]
enum KernelError {
    #[error("protocol error: {0}")]
    Protocol(String),
    #[error("storage error: {0}")]
    Storage(String),
    #[error("authorization error: {0}")]
    Authorization(String),
    #[error("operation error: {0}")]
    Operation(String),
}

impl From<rusqlite::Error> for KernelError {
    fn from(value: rusqlite::Error) -> Self { Self::Storage(value.to_string()) }
}
impl From<io::Error> for KernelError {
    fn from(value: io::Error) -> Self { Self::Storage(value.to_string()) }
}
impl From<serde_json::Error> for KernelError {
    fn from(value: serde_json::Error) -> Self { Self::Protocol(value.to_string()) }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct TrieNode {
    children: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    state: Option<Value>,
}

#[derive(Clone, Debug)]
struct BranchRow {
    workspace_id: String,
    head_root: String,
    head_revision: i64,
    write_revision: i64,
}

struct StorageLock {
    path: PathBuf,
    _file: File,
}

impl Drop for StorageLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

struct Storage {
    root: PathBuf,
    conn: Connection,
    _lock: StorageLock,
}

impl Storage {
    fn open(root: &Path, host_id: &str) -> Result<Self, KernelError> {
        fs::create_dir_all(root)?;
        for directory in ["objects", "staging"] {
            fs::create_dir_all(root.join(directory))?;
        }
        let lock_path = root.join("kernel.lock");
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&lock_path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let stale = fs::read_to_string(&lock_path).ok()
                    .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                    .and_then(|record| record.get("pid").and_then(Value::as_u64))
                    .map(|pid| !process_is_alive(pid as u32))
                    .unwrap_or(false);
                if stale {
                    fs::remove_file(&lock_path)?;
                    OpenOptions::new().write(true).create_new(true).open(&lock_path)?
                } else {
                    return Err(KernelError::Storage(format!("storage is owned by another Host: {}", root.display())));
                }
            }
            Err(error) => return Err(KernelError::Storage(error.to_string())),
        };
        let lock_record = json!({"hostId": host_id, "pid": std::process::id(), "createdAt": now_ms()});
        file.write_all(lock_record.to_string().as_bytes())?;
        file.sync_all()?;
        let conn = Connection::open(root.join("catalog.sqlite"))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, byte_length INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS trie_nodes (hash TEXT PRIMARY KEY, children_json TEXT NOT NULL, state_json TEXT);
             CREATE TABLE IF NOT EXISTS branches (branch_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, base_root TEXT NOT NULL, head_root TEXT NOT NULL, head_revision INTEGER NOT NULL, write_revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS revisions (branch_id TEXT NOT NULL, revision INTEGER NOT NULL, root_hash TEXT NOT NULL, parent_revision INTEGER, operation_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(branch_id, revision));
             CREATE TABLE IF NOT EXISTS pins (pin_id TEXT PRIMARY KEY, branch_id TEXT NOT NULL, revision INTEGER NOT NULL, root_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS operations (operation_id TEXT PRIMARY KEY, kind TEXT NOT NULL, params_hash TEXT NOT NULL, state TEXT NOT NULL, result_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS recovery_records (record_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, workspace_id TEXT NOT NULL, state TEXT NOT NULL, data_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
             CREATE INDEX IF NOT EXISTS revisions_root ON revisions(root_hash);
             CREATE INDEX IF NOT EXISTS pins_root ON pins(root_hash);
             CREATE INDEX IF NOT EXISTS recovery_operation ON recovery_records(operation_id);",
        )?;
        Ok(Self { root: root.to_path_buf(), conn, _lock: StorageLock { path: lock_path, _file: file } })
    }

    fn transaction<T>(&mut self, f: impl FnOnce(&Transaction<'_>) -> Result<T, KernelError>) -> Result<T, KernelError> {
        let tx = self.conn.transaction()?;
        let value = f(&tx)?;
        tx.commit()?;
        Ok(value)
    }

    fn operation_existing(&self, id: &str, kind: &str, params_hash: &str) -> Result<Option<Value>, KernelError> {
        let row: Option<(String, String, Option<String>)> = self.conn.query_row(
            "SELECT kind, params_hash, result_json FROM operations WHERE operation_id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?;
        match row {
            None => Ok(None),
            Some((stored_kind, stored_hash, result)) => {
                if stored_kind != kind || stored_hash != params_hash {
                    return Err(KernelError::Operation(format!("operationId {id} was reused with different parameters")));
                }
                match result {
                    Some(text) => Ok(Some(serde_json::from_str(&text)?)),
                    None => Err(KernelError::Operation(format!("operationId {id} is still in progress"))),
                }
            }
        }
    }

    fn operation_begin(&mut self, id: &str, kind: &str, params_hash: &str) -> Result<(), KernelError> {
        self.conn.execute(
            "INSERT INTO operations(operation_id, kind, params_hash, state, created_at, updated_at) VALUES (?1, ?2, ?3, 'started', ?4, ?4)",
            params![id, kind, params_hash, now_ms()],
        )?;
        Ok(())
    }

    fn operation_finish(&mut self, id: &str, result: &Value) -> Result<(), KernelError> {
        self.conn.execute(
            "UPDATE operations SET state = 'committed', result_json = ?2, updated_at = ?3 WHERE operation_id = ?1",
            params![id, serde_json::to_string(result)?, now_ms()],
        )?;
        Ok(())
    }

    fn load_node(&self, hash: &str) -> Result<TrieNode, KernelError> {
        let row: Option<(String, Option<String>)> = self.conn.query_row(
            "SELECT children_json, state_json FROM trie_nodes WHERE hash = ?1",
            params![hash],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        let (children_json, state_json) = row.ok_or_else(|| KernelError::Storage(format!("missing trie node {hash}")))?;
        let node = TrieNode { children: serde_json::from_str(&children_json)?, state: state_json.map(|value| serde_json::from_str(&value)).transpose()? };
        if node_hash(&node) != hash { return Err(KernelError::Storage(format!("corrupt trie node {hash}"))); }
        Ok(node)
    }

    fn store_node_tx(tx: &Transaction<'_>, node: &TrieNode) -> Result<String, KernelError> {
        let hash = node_hash(node);
        tx.execute(
            "INSERT OR IGNORE INTO trie_nodes(hash, children_json, state_json) VALUES (?1, ?2, ?3)",
            params![hash, serde_json::to_string(&node.children)?, node.state.as_ref().map(serde_json::to_string).transpose()?],
        )?;
        Ok(hash)
    }

    fn store_node(&mut self, node: &TrieNode) -> Result<String, KernelError> {
        let hash = node_hash(node);
        self.conn.execute(
            "INSERT OR IGNORE INTO trie_nodes(hash, children_json, state_json) VALUES (?1, ?2, ?3)",
            params![hash, serde_json::to_string(&node.children)?, node.state.as_ref().map(serde_json::to_string).transpose()?],
        )?;
        Ok(hash)
    }

    fn empty_root(&mut self) -> Result<String, KernelError> {
        self.store_node(&TrieNode { children: BTreeMap::new(), state: None })
    }

    fn root_entries(&self, root: &str) -> Result<Vec<(String, Value)>, KernelError> {
        let mut output = Vec::new();
        self.walk_entries(root, "", &mut output)?;
        Ok(output)
    }

    fn walk_entries(&self, hash: &str, prefix: &str, output: &mut Vec<(String, Value)>) -> Result<(), KernelError> {
        let node = self.load_node(hash)?;
        if let Some(state) = node.state { output.push((prefix.to_string(), state)); }
        for (name, child) in node.children {
            let child_prefix = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
            self.walk_entries(&child, &child_prefix, output)?;
        }
        Ok(())
    }

    fn root_get(&self, root: &str, path: &str) -> Result<Option<Value>, KernelError> {
        let mut hash = root.to_string();
        for segment in path.split('/') {
            if segment.is_empty() { continue; }
            let node = self.load_node(&hash)?;
            let Some(child) = node.children.get(segment) else { return Ok(None); };
            hash = child.clone();
        }
        Ok(self.load_node(&hash)?.state)
    }

    fn load_node_tx(tx: &Transaction<'_>, hash: &str) -> Result<TrieNode, KernelError> {
        let row: Option<(String, Option<String>)> = tx.query_row(
            "SELECT children_json, state_json FROM trie_nodes WHERE hash = ?1",
            params![hash],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        let (children_json, state_json) = row.ok_or_else(|| KernelError::Storage(format!("missing trie node {hash}")))?;
        let node = TrieNode { children: serde_json::from_str(&children_json)?, state: state_json.map(|value| serde_json::from_str(&value)).transpose()? };
        if node_hash(&node) != hash { return Err(KernelError::Storage(format!("corrupt trie node {hash}"))); }
        Ok(node)
    }

    fn root_set_tx(tx: &Transaction<'_>, root: &str, segments: &[&str], state: Value) -> Result<String, KernelError> {
        let node = Self::load_node_tx(tx, root)?;
        if segments.is_empty() { return Self::store_node_tx(tx, &TrieNode { children: node.children, state: Some(state) }); }
        let name = segments[0];
        let child_root = node.children.get(name).cloned().unwrap_or_else(|| {
            // The empty node is content-addressed and inserted lazily in this transaction.
            node_hash(&TrieNode { children: BTreeMap::new(), state: None })
        });
        if !node.children.contains_key(name) {
            Self::store_node_tx(tx, &TrieNode { children: BTreeMap::new(), state: None })?;
        }
        let child = Self::root_set_tx(tx, &child_root, &segments[1..], state)?;
        let mut children = node.children;
        children.insert(name.to_string(), child);
        Self::store_node_tx(tx, &TrieNode { children, state: node.state })
    }

    fn branch(&self, branch_id: &str) -> Result<BranchRow, KernelError> {
        self.conn.query_row(
            "SELECT workspace_id, head_root, head_revision, write_revision FROM branches WHERE branch_id = ?1",
            params![branch_id],
            |row| Ok(BranchRow { workspace_id: row.get(0)?, head_root: row.get(1)?, head_revision: row.get(2)?, write_revision: row.get(3)? }),
        ).map_err(|error| match error { rusqlite::Error::QueryReturnedNoRows => KernelError::Operation(format!("branch not found: {branch_id}")), other => other.into() })
    }

    fn validate_path(path: &str) -> Result<Vec<String>, KernelError> {
        if path.is_empty() || path.contains('\0') || path.starts_with('/') || path.contains(':') {
            return Err(KernelError::Authorization(format!("invalid relative path: {path}")));
        }
        let normalized = path.replace('\\', "/");
        let parts: Vec<String> = normalized.split('/').filter(|part| !part.is_empty() && *part != ".").map(str::to_string).collect();
        if parts.is_empty() || parts.iter().any(|part| *part == "..") { return Err(KernelError::Authorization(format!("invalid relative path: {path}"))); }
        Ok(parts)
    }

    fn validate_state(&self, state: &Value) -> Result<(), KernelError> {
        let kind = state.get("kind").and_then(Value::as_str).ok_or_else(|| KernelError::Operation("state.kind is required".to_string()))?;
        match kind {
            "regular-file" => {
                let hash = state.get("objectHash").and_then(Value::as_str).ok_or_else(|| KernelError::Operation("regular-file.objectHash is required".to_string()))?;
                let bytes = state.get("byteLength").and_then(Value::as_u64).ok_or_else(|| KernelError::Operation("regular-file.byteLength is required".to_string()))?;
                if !hash.starts_with("sha256-") || hash.len() != 71 { return Err(KernelError::Operation("regular-file.objectHash is malformed".to_string())); }
                let row: Option<i64> = self.conn.query_row("SELECT byte_length FROM blobs WHERE hash = ?1", params![hash], |row| row.get(0)).optional()?;
                if row != Some(bytes as i64) { return Err(KernelError::Storage(format!("content object is not durable: {hash}"))); }
            }
            "missing" | "directory" | "symlink" | "unsupported" => {}
            other => return Err(KernelError::Operation(format!("unsupported path state: {other}"))),
        }
        Ok(())
    }

    fn put_blob(&mut self, params: &Value) -> Result<Value, KernelError> {
        let bytes = params.get("bytesBase64").and_then(Value::as_str).ok_or_else(|| KernelError::Operation("bytesBase64 is required".to_string()))?;
        let decoded = BASE64.decode(bytes).map_err(|error| KernelError::Operation(format!("invalid bytesBase64: {error}")))?;
        let hash = format!("sha256-{}", hex::encode(Sha256::digest(&decoded)));
        if let Some(expected) = params.get("expectedHash").and_then(Value::as_str) { if expected != hash { return Err(KernelError::Operation("content hash does not match expectedHash".to_string())); } }
        let target = object_path(&self.root, &hash)?;
        if target.exists() {
            let existing = fs::read(&target)?;
            let actual = format!("sha256-{}", hex::encode(Sha256::digest(&existing)));
            if actual != hash {
                return Err(KernelError::Storage(format!("content object is corrupt: {hash}")));
            }
            if existing.len() != decoded.len() {
                return Err(KernelError::Storage(format!("content object length is corrupt: {hash}")));
            }
        } else {
            let staging = self.root.join("staging").join(format!("{}.object", Uuid::new_v4()));
            let mut file = OpenOptions::new().write(true).create_new(true).open(&staging)?;
            file.write_all(&decoded)?; file.sync_all()?; drop(file);
            fs::create_dir_all(target.parent().unwrap())?;
            fs::rename(&staging, &target).or_else(|error| if error.kind() == io::ErrorKind::AlreadyExists { fs::remove_file(&staging) } else { Err(error) })?;
        }
        let recorded: Option<i64> = self.conn.query_row("SELECT byte_length FROM blobs WHERE hash = ?1", params![hash], |row| row.get(0)).optional()?;
        if let Some(byte_length) = recorded {
            if byte_length != decoded.len() as i64 {
                return Err(KernelError::Storage(format!("content object metadata is corrupt: {hash}")));
            }
        } else {
            self.conn.execute("INSERT INTO blobs(hash, byte_length) VALUES (?1, ?2)", params![hash, decoded.len() as i64])?;
        }
        Ok(json!({"hash": hash, "byteLength": decoded.len()}))
    }

    fn get_blob(&self, params: &Value) -> Result<Value, KernelError> {
        let hash = params.get("hash").and_then(Value::as_str).ok_or_else(|| KernelError::Operation("hash is required".to_string()))?;
        let path = object_path(&self.root, hash)?;
        let bytes = fs::read(path)?;
        let actual = format!("sha256-{}", hex::encode(Sha256::digest(&bytes)));
        if actual != hash {
            return Err(KernelError::Storage(format!("content object is corrupt: {hash}")));
        }
        let recorded: Option<i64> = self.conn.query_row("SELECT byte_length FROM blobs WHERE hash = ?1", params![hash], |row| row.get(0)).optional()?;
        if recorded != Some(bytes.len() as i64) {
            return Err(KernelError::Storage(format!("content object metadata is missing or corrupt: {hash}")));
        }
        let offset = params.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
        let length = params.get("length").and_then(Value::as_u64).map(|value| value as usize);
        let start = offset.min(bytes.len());
        let end = length.map(|value| start.saturating_add(value).min(bytes.len())).unwrap_or(bytes.len());
        Ok(json!({"hash": hash, "byteLength": bytes.len(), "offset": start, "nextOffset": end, "eof": end >= bytes.len(), "bytesBase64": BASE64.encode(&bytes[start..end])}))
    }

    fn create_branch(&mut self, params: &Value) -> Result<Value, KernelError> {
        let branch_id = params.get("branchId").and_then(Value::as_str).ok_or_else(|| KernelError::Operation("branchId is required".to_string()))?;
        let workspace_id = params.get("workspaceId").and_then(Value::as_str).ok_or_else(|| KernelError::Operation("workspaceId is required".to_string()))?;
        if let Ok(existing) = self.branch(branch_id) { if existing.workspace_id == workspace_id { return Ok(json!({"branchId": branch_id, "root": existing.head_root, "writeRevision": existing.write_revision, "headRevision": existing.head_revision, "created": false})); } return Err(KernelError::Operation("branchId belongs to another workspace".to_string())); }
        let entries = params.get("entries").and_then(Value::as_array).ok_or_else(|| KernelError::Operation("entries is required".to_string()))?;
        let empty = self.empty_root()?;
        let entries_to_write: Vec<(Vec<String>, Value)> = entries.iter().map(|entry| {
            let path = entry.get("path").and_then(Value::as_str).ok_or_else(|| KernelError::Operation("entry.path is required".to_string()))?;
            let segments = Self::validate_path(path)?;
            let state = entry.get("state").cloned().ok_or_else(|| KernelError::Operation("entry.state is required".to_string()))?;
            self.validate_state(&state)?;
            Ok((segments, state))
        }).collect::<Result<_, KernelError>>()?;
        let root = self.transaction(|tx| {
            let mut current = empty.clone();
            for (segments, state) in entries_to_write {
                let refs = segments.iter().map(String::as_str).collect::<Vec<_>>();
                current = Self::root_set_tx(tx, &current, &refs, state)?;
            }
            Ok(current)
        })?;
        let now = now_ms();
        self.conn.execute("INSERT INTO branches(branch_id, workspace_id, base_root, head_root, head_revision, write_revision, created_at, updated_at) VALUES (?1, ?2, ?3, ?3, 0, 0, ?4, ?4)", params![branch_id, workspace_id, root, now])?;
        self.conn.execute("INSERT OR IGNORE INTO revisions(branch_id, revision, root_hash, created_at) VALUES (?1, 0, ?2, ?3)", params![branch_id, root, now])?;
        Ok(json!({"branchId": branch_id, "root": root, "writeRevision": 0, "headRevision": 0, "created": true}))
    }

    fn branch_read(&self, params: &Value) -> Result<Value, KernelError> {
        let branch_id = params.get("branchId").and_then(Value::as_str).ok_or_else(|| KernelError::Operation("branchId is required".to_string()))?;
        let branch = self.branch(branch_id)?;
        let revision = params.get("revision").and_then(Value::as_i64).unwrap_or(branch.head_revision);
        let root = if revision == branch.head_revision { branch.head_root.clone() } else {
            self.conn.query_row("SELECT root_hash FROM revisions WHERE branch_id = ?1 AND revision = ?2", params![branch_id, revision], |row| row.get::<_, String>(0))?
        };
        let requested = params.get("paths").and_then(Value::as_array);
        let entries = if let Some(paths) = requested {
            let mut selected = Vec::new();
            for path in paths.iter().filter_map(Value::as_str) {
                Self::validate_path(path)?;
                if let Some(state) = self.root_get(&root, path)? { selected.push(json!({"path": path, "state": state})); }
            }
            selected
        } else if params.get("includeEntries").and_then(Value::as_bool).unwrap_or(false) {
            self.root_entries(&root)?.into_iter().map(|(path, state)| json!({"path": path, "state": state})).collect()
        } else { Vec::new() };
        Ok(json!({"branchId": branch_id, "workspaceId": branch.workspace_id, "root": root, "revision": revision, "headRevision": branch.head_revision, "writeRevision": branch.write_revision, "entries": entries}))
    }

    fn branch_write(&mut self, params: &Value) -> Result<Value, KernelError> {
        let branch_id = params.get("branchId").and_then(Value::as_str).ok_or_else(|| KernelError::Operation("branchId is required".to_string()))?;
        let expected = params.get("expectedWriteRevision").and_then(Value::as_i64).ok_or_else(|| KernelError::Operation("expectedWriteRevision is required".to_string()))?;
        let branch = self.branch(branch_id)?;
        if branch.write_revision != expected { return Ok(json!({"status": "conflict", "writeRevision": branch.write_revision, "root": branch.head_root})); }
        let changes = params.get("changes").and_then(Value::as_array).ok_or_else(|| KernelError::Operation("changes is required".to_string()))?;
        let changes_to_write: Vec<(Vec<String>, Value)> = changes.iter().map(|change| {
            let path = change.get("path").and_then(Value::as_str).ok_or_else(|| KernelError::Operation("change.path is required".to_string()))?;
            let segments = Self::validate_path(path)?;
            let state = change.get("state").cloned().ok_or_else(|| KernelError::Operation("change.state is required".to_string()))?;
            self.validate_state(&state)?;
            Ok((segments, state))
        }).collect::<Result<_, KernelError>>()?;
        let root = self.transaction(|tx| {
            let mut current = branch.head_root.clone();
            for (segments, state) in changes_to_write {
                let refs = segments.iter().map(String::as_str).collect::<Vec<_>>();
                current = Self::root_set_tx(tx, &current, &refs, state)?;
            }
            Ok(current)
        })?;
        let next = branch.write_revision + 1;
        self.conn.execute("UPDATE branches SET head_root = ?2, write_revision = ?3, updated_at = ?4 WHERE branch_id = ?1 AND write_revision = ?5", params![branch_id, root, next, now_ms(), expected])?;
        if self.conn.changes() != 1 { return Ok(json!({"status": "conflict", "writeRevision": self.branch(branch_id)?.write_revision, "root": self.branch(branch_id)?.head_root})); }
        Ok(json!({"status": "committed", "writeRevision": next, "root": root}))
    }

    fn branch_publish(&mut self, params: &Value) -> Result<Value, KernelError> {
        let branch_id = params.get("branchId").and_then(Value::as_str).ok_or_else(|| KernelError::Operation("branchId is required".to_string()))?;
        let branch = self.branch(branch_id)?;
        let revision = branch.head_revision + 1;
        self.conn.execute("INSERT INTO revisions(branch_id, revision, root_hash, operation_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)", params![branch_id, revision, branch.head_root, params.get("operationId").and_then(Value::as_str), now_ms()])?;
        self.conn.execute("UPDATE branches SET head_revision = ?2, updated_at = ?3 WHERE branch_id = ?1", params![branch_id, revision, now_ms()])?;
        Ok(json!({"branchId": branch_id, "revision": revision, "root": branch.head_root, "writeRevision": branch.write_revision}))
    }

    fn branch_pin(&mut self, params: &Value, pin: bool) -> Result<Value, KernelError> {
        let branch_id = params.get("branchId").and_then(Value::as_str).ok_or_else(|| KernelError::Operation("branchId is required".to_string()))?;
        let branch = self.branch(branch_id)?;
        let revision = params.get("revision").and_then(Value::as_i64).unwrap_or(branch.head_revision);
        let root = if revision == branch.head_revision { branch.head_root.clone() } else { self.conn.query_row("SELECT root_hash FROM revisions WHERE branch_id = ?1 AND revision = ?2", params![branch_id, revision], |row| row.get::<_, String>(0))? };
        let pin_id = params.get("pinId").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("pin-{}", Uuid::new_v4()));
        if pin { self.conn.execute("INSERT OR REPLACE INTO pins(pin_id, branch_id, revision, root_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5)", params![pin_id, branch_id, revision, root, now_ms()])?; } else { self.conn.execute("DELETE FROM pins WHERE pin_id = ?1", params![pin_id])?; }
        Ok(json!({"pinId": pin_id, "branchId": branch_id, "revision": revision, "root": root, "pinned": pin}))
    }

    fn branch_delete(&mut self, params: &Value) -> Result<Value, KernelError> {
        let branch_id = params.get("branchId").and_then(Value::as_str).ok_or_else(|| KernelError::Operation("branchId is required".to_string()))?;
        let deleted = self.conn.execute("DELETE FROM branches WHERE branch_id = ?1", params![branch_id])?;
        self.conn.execute("DELETE FROM revisions WHERE branch_id = ?1", params![branch_id])?;
        self.conn.execute("DELETE FROM pins WHERE branch_id = ?1", params![branch_id])?;
        Ok(json!({"branchId": branch_id, "deleted": deleted > 0}))
    }

    fn snapshot(&self, params_value: &Value) -> Result<Value, KernelError> {
        let mut branches = Vec::new();
        let requested_workspace = params_value.get("workspaceId").and_then(Value::as_str);
        let mut statement = self.conn.prepare("SELECT branch_id, workspace_id, base_root, head_root, head_revision, write_revision FROM branches WHERE (?1 IS NULL OR workspace_id = ?1) ORDER BY branch_id")?;
        for row in statement.query_map(params![requested_workspace], |row| Ok((row.get::<_,String>(0)?, row.get::<_,String>(1)?, row.get::<_,String>(2)?, row.get::<_,String>(3)?, row.get::<_,i64>(4)?, row.get::<_,i64>(5)?)))? {
            let (branch_id, workspace_id, base_root, head_root, head_revision, write_revision) = row?;
            let revisions = self.conn.prepare("SELECT revision, root_hash FROM revisions WHERE branch_id = ?1 ORDER BY revision")?.query_map(params![branch_id], |revision| Ok(json!({"revision": revision.get::<_,i64>(0)?, "root": revision.get::<_,String>(1)?})))?.collect::<Result<Vec<_>, _>>()?;
            branches.push(json!({"branchId": branch_id, "workspaceId": workspace_id, "baseRoot": base_root, "headRoot": head_root, "headRevision": head_revision, "writeRevision": write_revision, "revisions": revisions}));
        }
        Ok(json!({"workspaceId": requested_workspace, "branches": branches}))
    }

    fn branch_diff(&self, params: &Value) -> Result<Value, KernelError> {
        let left = params.get("leftRoot").and_then(Value::as_str).ok_or_else(|| KernelError::Operation("leftRoot is required".to_string()))?;
        let right = params.get("rightRoot").and_then(Value::as_str).ok_or_else(|| KernelError::Operation("rightRoot is required".to_string()))?;
        let mut added = Vec::new(); let mut removed = Vec::new(); let mut changed = Vec::new();
        self.diff_nodes(left, right, "", &mut added, &mut removed, &mut changed)?;
        Ok(json!({"leftRoot": left, "rightRoot": right, "added": added, "removed": removed, "changed": changed}))
    }

    fn diff_nodes(&self, left_hash: &str, right_hash: &str, prefix: &str, added: &mut Vec<String>, removed: &mut Vec<String>, changed: &mut Vec<String>) -> Result<(), KernelError> {
        if left_hash == right_hash { return Ok(()); }
        let left = self.load_node(left_hash)?; let right = self.load_node(right_hash)?;
        match (&left.state, &right.state) { (Some(a), Some(b)) if a != b => changed.push(prefix.to_string()), (Some(_), None) => removed.push(prefix.to_string()), (None, Some(_)) => added.push(prefix.to_string()), _ => {} }
        let names: BTreeSet<String> = left.children.keys().chain(right.children.keys()).cloned().collect();
        for name in names {
            let path = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
            match (left.children.get(&name), right.children.get(&name)) { (Some(l), Some(r)) => self.diff_nodes(l, r, &path, added, removed, changed)?, (Some(l), None) => self.collect_paths(l, &path, removed)?, (None, Some(r)) => self.collect_paths(r, &path, added)?, _ => {} }
        }
        Ok(())
    }

    fn collect_paths(&self, hash: &str, prefix: &str, target: &mut Vec<String>) -> Result<(), KernelError> {
        let node = self.load_node(hash)?; if node.state.is_some() { target.push(prefix.to_string()); }
        for (name, child) in node.children {
            let child_prefix = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
            self.collect_paths(&child, &child_prefix, target)?;
        }
        Ok(())
    }

    fn gc(&mut self) -> Result<Value, KernelError> {
        let mut roots = BTreeSet::new();
        for row in self.conn.prepare("SELECT base_root, head_root FROM branches")?.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))? { let (a,b)=row?; roots.insert(a); roots.insert(b); }
        for row in self.conn.prepare("SELECT root_hash FROM revisions UNION SELECT root_hash FROM pins")?.query_map([], |row| row.get::<_, String>(0))? { roots.insert(row?); }
        let mut nodes = BTreeSet::new(); let mut blobs = BTreeSet::new();
        for root in roots { self.collect_reachable(&root, &mut nodes, &mut blobs)?; }
        let all_nodes: Vec<String> = self.conn.prepare("SELECT hash FROM trie_nodes")?.query_map([], |row| row.get(0))?.collect::<Result<_,_>>()?;
        let mut deleted_nodes = 0; for hash in all_nodes { if !nodes.contains(&hash) { self.conn.execute("DELETE FROM trie_nodes WHERE hash = ?1", params![hash])?; deleted_nodes += 1; } }
        let all_blobs: Vec<String> = self.conn.prepare("SELECT hash FROM blobs")?.query_map([], |row| row.get(0))?.collect::<Result<_,_>>()?;
        let mut deleted_blobs = 0; for hash in all_blobs { if !blobs.contains(&hash) { let _ = fs::remove_file(object_path(&self.root,&hash)?); self.conn.execute("DELETE FROM blobs WHERE hash = ?1", params![hash])?; deleted_blobs += 1; } }
        Ok(json!({"deletedNodes": deleted_nodes, "deletedBlobs": deleted_blobs, "retainedNodes": nodes.len(), "retainedBlobs": blobs.len()}))
    }

    fn collect_reachable(&self, hash: &str, nodes: &mut BTreeSet<String>, blobs: &mut BTreeSet<String>) -> Result<(), KernelError> {
        if !nodes.insert(hash.to_string()) { return Ok(()); }
        let node = self.load_node(hash)?;
        if let Some(state) = node.state { if let Some(blob) = state.get("objectHash").and_then(Value::as_str) { blobs.insert(blob.to_string()); } }
        for child in node.children.values() { self.collect_reachable(child, nodes, blobs)?; }
        Ok(())
    }

    fn recovery_operation(&mut self, method: &str, params_value: &Value) -> Result<Value, KernelError> {
        let operation_id = params_value.get("operationId").and_then(Value::as_str).ok_or_else(|| KernelError::Operation("operationId is required".to_string()))?;
        let record_id = params_value.get("recordId").and_then(Value::as_str).unwrap_or(operation_id);
        let workspace_id = params_value.get("workspaceId").and_then(Value::as_str).unwrap_or("");
        let state = params_value.get("state").and_then(Value::as_str).unwrap_or(if method.ends_with("begin") { "started" } else { "updated" });
        let data = params_value.get("data").cloned().unwrap_or_else(|| json!({}));
        self.conn.execute("INSERT INTO recovery_records(record_id, operation_id, workspace_id, state, data_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6) ON CONFLICT(record_id) DO UPDATE SET state = excluded.state, data_json = excluded.data_json, updated_at = excluded.updated_at", params![record_id, operation_id, workspace_id, state, serde_json::to_string(&data)?, now_ms()])?;
        Ok(json!({"recordId": record_id, "operationId": operation_id, "state": state, "data": data}))
    }

    fn recovery_get(&self, params_value: &Value) -> Result<Value, KernelError> {
        let id = params_value.get("recordId").or_else(|| params_value.get("operationId")).and_then(Value::as_str).ok_or_else(|| KernelError::Operation("recordId or operationId is required".to_string()))?;
        let row: Option<(String,String,String,String)> = self.conn.query_row("SELECT operation_id, workspace_id, state, data_json FROM recovery_records WHERE record_id = ?1", params![id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).optional()?;
        let Some((operation_id, workspace_id, state, data)) = row else { return Ok(Value::Null); };
        Ok(json!({"recordId": id, "operationId": operation_id, "workspaceId": workspace_id, "state": state, "data": serde_json::from_str::<Value>(&data)?}))
    }

    fn operation_get(&self, params_value: &Value) -> Result<Value, KernelError> {
        let id = params_value.get("operationId").and_then(Value::as_str).ok_or_else(|| KernelError::Operation("operationId is required".to_string()))?;
        let row: Option<(String, String, String, Option<String>, i64, i64)> = self.conn.query_row(
            "SELECT kind, params_hash, state, result_json, created_at, updated_at FROM operations WHERE operation_id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        ).optional()?;
        let Some((kind, params_hash, state, result, created_at, updated_at)) = row else { return Ok(Value::Null); };
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

    fn health(&self) -> Result<Value, KernelError> {
        let integrity: String = self.conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        let branches: i64 = self.conn.query_row("SELECT COUNT(*) FROM branches", [], |row| row.get(0))?;
        let nodes: i64 = self.conn.query_row("SELECT COUNT(*) FROM trie_nodes", [], |row| row.get(0))?;
        let blobs: i64 = self.conn.query_row("SELECT COUNT(*) FROM blobs", [], |row| row.get(0))?;
        Ok(json!({"integrity": integrity, "branches": branches, "nodes": nodes, "blobs": blobs, "storageRoot": self.root}))
    }
}

struct Kernel {
    epoch: String,
    host_id: Option<String>,
    storage_root: Option<PathBuf>,
    storage: Option<Storage>,
    handshaken: bool,
}

impl Kernel {
    fn new() -> Self { Self { epoch: Uuid::new_v4().to_string(), host_id: None, storage_root: None, storage: None, handshaken: false } }

    fn handle(&mut self, request: &Value) -> Result<Option<Value>, KernelError> {
        let kind = request.get("kind").and_then(Value::as_str).unwrap_or("");
        if kind == "cancel" { return Ok(None); }
        if kind != "request" { return Err(KernelError::Protocol("expected request frame".to_string())); }
        let id = request.get("id").and_then(Value::as_str).ok_or_else(|| KernelError::Protocol("request id is required".to_string()))?;
        let method = request.get("method").and_then(Value::as_str).ok_or_else(|| KernelError::Protocol("request method is required".to_string()))?;
        let params_value = request.get("params").cloned().unwrap_or_else(|| json!({}));
        if method == "kernel.handshake" {
            if self.handshaken { return Err(KernelError::Protocol("handshake already completed".to_string())); }
            let protocol = params_value.get("protocolVersion").and_then(Value::as_u64).unwrap_or(0);
            if protocol != PROTOCOL_VERSION { return Err(KernelError::Protocol(format!("protocol mismatch: host={protocol}, kernel={PROTOCOL_VERSION}"))); }
            let host_id = params_value.get("hostId").and_then(Value::as_str).ok_or_else(|| KernelError::Protocol("hostId is required".to_string()))?.to_string();
            if host_id.trim().is_empty() { return Err(KernelError::Protocol("hostId is empty".to_string())); }
            let root = params_value.get("storageRoot").and_then(Value::as_str).ok_or_else(|| KernelError::Protocol("storageRoot is required".to_string()))?;
            if !Path::new(root).is_absolute() { return Err(KernelError::Authorization("storageRoot must be absolute".to_string())); }
            let storage = Storage::open(Path::new(root), &host_id)?;
            self.host_id = Some(host_id.clone()); self.storage_root = Some(PathBuf::from(root)); self.storage = Some(storage); self.handshaken = true;
            return Ok(Some(response_ok(id, json!({"protocolVersion": PROTOCOL_VERSION, "kernelVersion": KERNEL_VERSION, "kernelEpoch": self.epoch, "hostId": host_id, "storageRoot": root, "capabilities": ["storage", "workingState", "recovery", "branchCas", "pins", "gc"]}))));
        }
        if !self.handshaken { return Err(KernelError::Protocol("handshake is required before requests".to_string())); }
        if method == "kernel.ping" { return Ok(Some(response_ok(id, json!({"kernelEpoch": self.epoch, "ready": true})))); }
        if method == "kernel.shutdown" { return Ok(Some(response_ok(id, json!({"stopping": true})))); }
        if let Some(epoch) = request.get("epoch").and_then(Value::as_str) { if epoch != self.epoch { return Err(KernelError::Authorization("stale kernel epoch".to_string())); } }
        let storage = self.storage.as_mut().ok_or_else(|| KernelError::Storage("storage is not open".to_string()))?;
        let result = match method {
            "storage.health" => storage.health(),
            "storage.snapshot" => storage.snapshot(&params_value),
            "storage.putBlob" => idempotent(storage, method, &params_value, |storage| storage.put_blob(&params_value)),
            "storage.getBlob" => storage.get_blob(&params_value),
            "branch.create" => idempotent(storage, method, &params_value, |storage| storage.create_branch(&params_value)),
            "branch.read" => storage.branch_read(&params_value),
            "branch.write" => idempotent(storage, method, &params_value, |storage| storage.branch_write(&params_value)),
            "branch.publish" => idempotent(storage, method, &params_value, |storage| storage.branch_publish(&params_value)),
            "branch.pin" => idempotent(storage, method, &params_value, |storage| storage.branch_pin(&params_value, true)),
            "branch.unpin" => idempotent(storage, method, &params_value, |storage| storage.branch_pin(&params_value, false)),
            "branch.diff" => storage.branch_diff(&params_value),
            "branch.delete" => idempotent(storage, method, &params_value, |storage| storage.branch_delete(&params_value)),
            "storage.gc" => idempotent(storage, method, &params_value, |storage| storage.gc()),
            "recovery.operation.begin" | "recovery.operation.update" => storage.recovery_operation(method, &params_value),
            "recovery.operation.get" => storage.recovery_get(&params_value),
            "operation.get" => storage.operation_get(&params_value),
            _ => Err(KernelError::Protocol(format!("unknown method: {method}"))),
        }?;
        Ok(Some(response_ok(id, result)))
    }
}

fn idempotent(storage: &mut Storage, kind: &str, params_value: &Value, action: impl FnOnce(&mut Storage) -> Result<Value, KernelError>) -> Result<Value, KernelError> {
    let operation_id = params_value.get("operationId").and_then(Value::as_str).ok_or_else(|| KernelError::Operation(format!("{kind} requires operationId")))?;
    let params_hash = hash_json(params_value)?;
    if let Some(result) = storage.operation_existing(operation_id, kind, &params_hash)? { return Ok(result); }
    storage.operation_begin(operation_id, kind, &params_hash)?;
    match action(storage) {
        Ok(result) => { storage.operation_finish(operation_id, &result)?; Ok(result) }
        Err(error) => { let _ = storage.conn.execute("UPDATE operations SET state = 'failed', updated_at = ?2 WHERE operation_id = ?1", params![operation_id, now_ms()]); Err(error) }
    }
}

fn now_ms() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_millis() as i64).unwrap_or(0) }
fn process_is_alive(pid: u32) -> bool {
    if pid == std::process::id() { return true; }
    #[cfg(windows)]
    {
        Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH"]).output()
            .map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
            .unwrap_or(true)
    }
    #[cfg(not(windows))]
    {
        Command::new("kill").args(["-0", &pid.to_string()]).status().map(|status| status.success()).unwrap_or(true)
    }
}
fn hash_json(value: &Value) -> Result<String, KernelError> { Ok(format!("sha256-{}", hex::encode(Sha256::digest(serde_json::to_vec(value)?)))) }
fn node_hash(node: &TrieNode) -> String { format!("sha256-{}", hex::encode(Sha256::digest(serde_json::to_vec(node).unwrap_or_default()))) }
fn object_path(root: &Path, hash: &str) -> Result<PathBuf, KernelError> {
    let hex = hash.strip_prefix("sha256-").filter(|value| value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit())).ok_or_else(|| KernelError::Operation(format!("malformed content hash: {hash}")))?;
    Ok(root.join("objects").join(&hex[..2]).join(&hex[2..]))
}
fn response_ok(id: &str, result: Value) -> Value { json!({"v": 1, "kind": "response", "id": id, "ok": true, "result": result}) }
fn response_error(id: &str, error: &KernelError) -> Value { json!({"v": 1, "kind": "response", "id": id, "ok": false, "error": {"code": error_code(error), "message": error.to_string(), "retryable": false}}) }
fn error_code(error: &KernelError) -> &'static str { match error { KernelError::Protocol(_) => "protocol-error", KernelError::Storage(_) => "storage-error", KernelError::Authorization(_) => "unauthorized", KernelError::Operation(_) => "operation-error" } }

fn read_frame(input: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut header = [0u8; 4];
    match input.read_exact(&mut header) { Ok(()) => {}, Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None), Err(error) => return Err(error) }
    let length = u32::from_be_bytes(header) as usize;
    if length > 512 * 1024 * 1024 { return Err(io::Error::new(io::ErrorKind::InvalidData, "kernel frame exceeds transport limit")); }
    let mut payload = vec![0u8; length]; input.read_exact(&mut payload)?; Ok(Some(payload))
}
fn write_frame(output: &mut impl Write, value: &Value) -> io::Result<()> {
    let payload = serde_json::to_vec(value).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let length = u32::try_from(payload.len()).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "kernel frame is too large"))?;
    output.write_all(&length.to_be_bytes())?; output.write_all(&payload)?; output.flush()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut kernel = Kernel::new();
    let stdin = io::stdin(); let stdout = io::stdout(); let mut input = stdin.lock(); let mut output = stdout.lock();
    loop {
        let Some(payload) = read_frame(&mut input)? else { break; };
        let request: Value = match serde_json::from_slice(&payload) { Ok(value) => value, Err(error) => { let _ = write_frame(&mut output, &json!({"v":1,"kind":"response","id":null,"ok":false,"error":{"code":"protocol-error","message":format!("invalid JSON frame: {error}"),"retryable":false}})); break; } };
        let id = request.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        match kernel.handle(&request) {
            Ok(Some(response)) => { write_frame(&mut output, &response)?; if request.get("method").and_then(Value::as_str) == Some("kernel.shutdown") { break; } }
            Ok(None) => {}
            Err(error) => { write_frame(&mut output, &response_error(&id, &error))?; if matches!(error, KernelError::Protocol(_)) && !kernel.handshaken { break; } }
        }
    }
    Ok(())
}
