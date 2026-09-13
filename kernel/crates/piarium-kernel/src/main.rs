use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use fs2::FileExt;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use uuid::Uuid;

mod authority;
mod error;
mod model;
mod protocol;
mod protocol_generated;
mod runtime;
mod storage_schema;
use authority::{path_allowed, path_allowed_scopes, require_capability};
use error::KernelError;
use model::{
    BlobStream, BranchBuilder, BranchRow, BranchWriteBuilder, BuildTree, Grant, PathState, TrieNode,
};
use protocol::*;
use storage_schema::{
    CATALOG_SCHEMA, CATALOG_USER_VERSION, REQUIRED_COLUMNS, REQUIRED_INDEXES, REQUIRED_TABLES,
};

fn sync_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        File::open(path)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

fn durable_rename(source: &Path, target: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        fs::rename(source, target)
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        const MOVEFILE_REPLACE_EXISTING: u32 = 0x0000_0001;
        const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
        }
        let existing = source
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let replacement = target
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let moved = unsafe {
            MoveFileExW(
                existing.as_ptr(),
                replacement.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if moved == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

fn hash_file(path: &Path) -> Result<(String, u64), KernelError> {
    let mut reader = BufReader::new(File::open(path)?);
    let mut digest = Sha256::new();
    let mut length = 0u64;
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        length = length
            .checked_add(read as u64)
            .ok_or_else(|| KernelError::Storage("content length overflow".to_string()))?;
    }
    Ok((format!("sha256-{}", hex::encode(digest.finalize())), length))
}

fn chrono_like_now() -> String {
    // Keep recovery timestamps RFC3339-shaped without adding a clock crate to
    // the kernel's small dependency set.  The civil-date conversion is the
    // standard proleptic Gregorian calculation used for Unix timestamps.
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0);
    let days = seconds.div_euclid(86_400);
    let day_seconds = seconds.rem_euclid(86_400);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = year + if month <= 2 { 1 } else { 0 };
    let hour = day_seconds / 3_600;
    let minute = (day_seconds % 3_600) / 60;
    let second = day_seconds % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn recovery_fault(phase: &str) -> Result<(), KernelError> {
    if std::env::var("PIARIUM_KERNEL_FAIL_RECOVERY_PHASE")
        .ok()
        .as_deref()
        == Some(phase)
    {
        return Err(KernelError::Storage(format!(
            "injected recovery failure at {phase}"
        )));
    }
    Ok(())
}

fn blob_owner_id(operation_id: &str) -> String {
    format!(
        "blob-owner-{}",
        hex::encode(Sha256::digest(operation_id.as_bytes()))
    )
}

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
    branch_builders: HashMap<String, BranchBuilder>,
    branch_write_builders: HashMap<String, BranchWriteBuilder>,
    verified_objects: BTreeSet<String>,
}

impl Storage {
    fn catalog_schema_fingerprint() -> String {
        format!(
            "sha256-{}",
            hex::encode(Sha256::digest(CATALOG_SCHEMA.as_bytes()))
        )
    }

    fn validate_catalog_schema(conn: &Connection) -> Result<(), KernelError> {
        let user_version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if user_version != CATALOG_USER_VERSION {
            return Err(KernelError::Storage(format!(
                "catalog user_version does not match format {}: {user_version}",
                STORAGE_FORMAT_VERSION
            )));
        }
        let fingerprint: Option<String> = conn
            .query_row(
                "SELECT value FROM metadata WHERE key = 'schema_fingerprint'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let expected_fingerprint = Self::catalog_schema_fingerprint();
        if fingerprint.as_deref() != Some(expected_fingerprint.as_str()) {
            return Err(KernelError::Storage(
                "catalog schema fingerprint does not match this kernel".to_string(),
            ));
        }
        let tables = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let expected_tables = REQUIRED_TABLES
            .iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>();
        if tables != expected_tables {
            return Err(KernelError::Storage(format!(
                "catalog table set is corrupt: expected {:?}, found {:?}",
                expected_tables, tables
            )));
        }
        let indexes = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let expected_indexes = REQUIRED_INDEXES
            .iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>();
        if indexes != expected_indexes {
            return Err(KernelError::Storage(format!(
                "catalog index set is corrupt: expected {:?}, found {:?}",
                expected_indexes, indexes
            )));
        }
        for (table, expected) in REQUIRED_COLUMNS {
            let pragma = format!("PRAGMA table_info({table})");
            let columns = conn
                .prepare(&pragma)?
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()?;
            let expected = expected
                .iter()
                .map(|value| value.to_string())
                .collect::<Vec<_>>();
            if columns != expected {
                return Err(KernelError::Storage(format!(
                    "catalog columns are corrupt for {table}: expected {:?}, found {:?}",
                    expected, columns
                )));
            }
        }
        Ok(())
    }

    fn open(root: &Path, host_id: &str) -> Result<Self, KernelError> {
        fs::create_dir_all(root)?;
        let lock_path = root.join("kernel.lock");
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
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
        for directory in ["objects", "staging"] {
            fs::create_dir_all(root.join(directory))?;
        }
        // No staging scan or directory mutation is allowed before the OS lock
        // is held. A second Host must not clean files owned by the first Host.
        if let Ok(entries) = fs::read_dir(root.join("staging")) {
            for entry in entries.flatten() {
                if entry.path().extension().and_then(|value| value.to_str()) == Some("stream") {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
        let catalog_path = root.join("catalog.sqlite");
        let catalog_existed = catalog_path.exists();
        let (format, catalog_empty): (Option<String>, bool) = if catalog_existed {
            let probe =
                Connection::open_with_flags(&catalog_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            let format = match probe
                .query_row(
                    "SELECT value FROM metadata WHERE key = 'format_version'",
                    [],
                    |row| row.get(0),
                )
                .optional()
            {
                Ok(format) => format,
                Err(rusqlite::Error::SqliteFailure(_, Some(message)))
                    if message.contains("no such table") =>
                {
                    None
                }
                Err(error) => return Err(error.into()),
            };
            let empty = probe.query_row(
                "SELECT COUNT(*) = 0 FROM sqlite_master WHERE type = 'table'",
                [],
                |row| row.get(0),
            )?;
            (format, empty)
        } else {
            (None, true)
        };
        let initialize_catalog = !catalog_existed || (format.is_none() && catalog_empty);
        if !initialize_catalog {
            match format {
                Some(value) if value == STORAGE_FORMAT_VERSION => {}
                Some(value) => {
                    return Err(KernelError::Storage(format!(
                        "unsupported catalog format version: {value}"
                    )))
                }
                None => {
                    return Err(KernelError::Storage(
                        "catalog format version is missing".to_string(),
                    ))
                }
            }
        }
        let conn = Connection::open(catalog_path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        if initialize_catalog {
            conn.execute_batch("BEGIN IMMEDIATE")?;
            if let Err(error) = conn.execute_batch(CATALOG_SCHEMA).and_then(|_| {
                conn.execute(
                    "INSERT INTO metadata(key, value) VALUES ('format_version', ?1)",
                    params![STORAGE_FORMAT_VERSION],
                )?;
                conn.execute(
                    "INSERT INTO metadata(key, value) VALUES ('schema_fingerprint', ?1)",
                    params![Self::catalog_schema_fingerprint()],
                )?;
                conn.pragma_update(None, "user_version", CATALOG_USER_VERSION)
            }) {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(error.into());
            }
            conn.execute_batch("COMMIT")?;
        } else {
            Self::validate_catalog_schema(&conn)?;
        }
        let mut storage = Self {
            root: PathBuf::from(root),
            conn,
            _lock: StorageLock { _file: file },
            cancellation: None,
            streams: HashMap::new(),
            branch_builders: HashMap::new(),
            branch_write_builders: HashMap::new(),
            verified_objects: BTreeSet::new(),
        };
        // A process may have exited after the SQLite commit and before the
        // object unlink. Retry durable cleanup on the next owner start; a
        // failure remains visible through health instead of being swallowed.
        storage.sweep_orphan_objects()?;
        storage.drain_gc_files()?;
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

    fn record_operation_workspace(
        &mut self,
        operation_id: &str,
        workspace_id: Option<&str>,
    ) -> Result<(), KernelError> {
        if let Some(workspace_id) = workspace_id {
            self.conn.execute(
                "INSERT OR IGNORE INTO operation_owners(operation_id, workspace_id, created_at) VALUES (?1, ?2, ?3)",
                params![operation_id, workspace_id, now_ms()],
            )?;
        }
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

    fn record_object_owner(
        &mut self,
        owner_id: &str,
        hash: &str,
        workspace_id: Option<&str>,
        operation_id: Option<&str>,
        grant_id: &str,
    ) -> Result<(), KernelError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO object_owners(owner_id, blob_hash, workspace_id, operation_id, grant_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![owner_id, hash, workspace_id, operation_id, grant_id, now_ms()],
        )?;
        Ok(())
    }

    fn release_object_owner(
        &mut self,
        params_value: &Value,
        workspace_id: Option<&str>,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let owner_id = params_value
            .get("ownerId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("ownerId is required".to_string()))?;
        let released = if let Some(workspace_id) = workspace_id {
            self.conn.execute(
                "DELETE FROM object_owners WHERE owner_id = ?1 AND workspace_id = ?2 AND grant_id = ?3",
                params![owner_id, workspace_id, grant_id],
            )?
        } else {
            self.conn.execute(
                "DELETE FROM object_owners WHERE owner_id = ?1 AND grant_id = ?2",
                params![owner_id, grant_id],
            )?
        };
        Ok(json!({"ownerId": owner_id, "released": released > 0}))
    }

    fn validate_object_owners(
        &self,
        workspace_id: &str,
        grant_id: &str,
        owners: &BTreeMap<String, String>,
    ) -> Result<(), KernelError> {
        for (owner_id, expected_hash) in owners {
            let actual: Option<String> = self
                .conn
                .query_row(
                    "SELECT blob_hash FROM object_owners WHERE owner_id = ?1 AND workspace_id = ?2 AND grant_id = ?3",
                    params![owner_id, workspace_id, grant_id],
                    |row| row.get(0),
                )
                .optional()?;
            if actual.as_deref() != Some(expected_hash) {
                return Err(KernelError::Authorization(format!(
                    "temporary object owner is not valid for this write: {owner_id}"
                )));
            }
        }
        Ok(())
    }

    fn consume_object_owners(
        &mut self,
        workspace_id: &str,
        grant_id: &str,
        owners: &BTreeMap<String, String>,
    ) -> Result<(), KernelError> {
        self.validate_object_owners(workspace_id, grant_id, owners)?;
        for owner_id in owners.keys() {
            self.conn.execute(
                "DELETE FROM object_owners WHERE owner_id = ?1 AND workspace_id = ?2 AND grant_id = ?3",
                params![owner_id, workspace_id, grant_id],
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
        let worker_generation = match params.get("workerGeneration") {
            None | Some(Value::Null) => None,
            Some(value) => Some(value.as_u64().ok_or_else(|| {
                KernelError::Authorization("grant workerGeneration is malformed".to_string())
            })?),
        };
        let grant = Grant {
            grant_id: grant_id.to_string(),
            host_id: host_id.to_string(),
            host_generation: supplied_host_generation.to_string(),
            authority_instance_id: parse_optional("authorityInstanceId")?,
            worker_id: parse_optional("workerId")?,
            worker_generation,
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
            let mut stored_grant: Grant = serde_json::from_str(&stored_json)?;
            if stored_grant.kernel_epoch != epoch || stored_grant.revoked {
                stored_grant.kernel_epoch = epoch.to_string();
                stored_grant.revoked = false;
                self.conn.execute(
                    "UPDATE grants SET revoked = 0, updated_at = ?2, grant_json = ?3 WHERE grant_id = ?1",
                    params![grant_id, now_ms(), serde_json::to_string(&stored_grant)?],
                )?;
            }
            return Ok(serde_json::to_value(stored_grant)?);
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
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let outcome = (|| {
            self.conn.execute(
                "UPDATE grants SET revoked = 1, updated_at = ?2, grant_json = ?3 WHERE grant_id = ?1",
                params![grant_id, now_ms(), serde_json::to_string(&revoked)?],
            )?;
            self.abort_streams_for_grant(grant_id)?;
            self.conn.execute(
                "DELETE FROM pins WHERE grant_id = ?1 AND ephemeral = 1",
                params![grant_id],
            )?;
            Ok::<(), KernelError>(())
        })();
        match outcome {
            Ok(()) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(json!({"grantId": grant_id, "revoked": true}))
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    fn blob_reachable(&self, hash: &str, workspace: Option<&str>) -> Result<bool, KernelError> {
        let query = if workspace.is_some() {
            "WITH RECURSIVE roots(root_hash) AS (SELECT base_root FROM branches WHERE workspace_id = ?2 UNION SELECT head_root FROM branches WHERE workspace_id = ?2 UNION SELECT r.root_hash FROM revisions r JOIN branches b ON b.branch_id = r.branch_id WHERE b.workspace_id = ?2 UNION SELECT p.root_hash FROM pins p WHERE p.workspace_id = ?2 UNION SELECT parent.parent_root FROM root_parents parent JOIN roots ON parent.root_hash = roots.root_hash) SELECT 1 FROM root_blobs rb JOIN roots ON roots.root_hash = rb.root_hash WHERE rb.blob_hash = ?1 LIMIT 1"
        } else {
            "WITH RECURSIVE roots(root_hash) AS (SELECT base_root FROM branches UNION SELECT head_root FROM branches UNION SELECT root_hash FROM revisions UNION SELECT root_hash FROM pins UNION SELECT parent.parent_root FROM root_parents parent JOIN roots ON parent.root_hash = roots.root_hash) SELECT 1 FROM root_blobs rb JOIN roots ON roots.root_hash = rb.root_hash WHERE rb.blob_hash = ?1 LIMIT 1"
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

    fn blob_owned(&self, hash: &str, workspace: Option<&str>) -> Result<bool, KernelError> {
        if self.blob_reachable(hash, workspace)? {
            return Ok(true);
        }
        let row: Option<i64> = if let Some(workspace) = workspace {
            self.conn
                .query_row(
                    "SELECT 1 FROM object_owners WHERE blob_hash = ?1 AND workspace_id = ?2 UNION SELECT 1 FROM domain_record_refs r WHERE r.object_hash = ?1 AND r.workspace_id = ?2 UNION SELECT 1 FROM recovery_refs r WHERE r.object_hash = ?1 AND r.workspace_id = ?2 LIMIT 1",
                    params![hash, workspace],
                    |row| row.get(0),
                )
                .optional()?
        } else {
            self.conn
                .query_row(
                    "SELECT 1 FROM object_owners WHERE blob_hash = ?1 UNION SELECT 1 FROM domain_record_refs WHERE object_hash = ?1 UNION SELECT 1 FROM recovery_refs WHERE object_hash = ?1 LIMIT 1",
                    params![hash],
                    |row| row.get(0),
                )
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
        } else if method == "storage.putBlob.chunk" {
            params
                .get("streamId")
                .and_then(Value::as_str)
                .and_then(|stream_id| {
                    self.streams
                        .get(stream_id)
                        .and_then(|stream| stream.workspace_id.clone())
                })
        } else if let Some(builder_id) = params.get("builderId").and_then(Value::as_str) {
            let builder = self
                .branch_builders
                .get(builder_id)
                .map(|builder| (&builder.grant_id, &builder.workspace_id))
                .or_else(|| {
                    self.branch_write_builders
                        .get(builder_id)
                        .map(|builder| (&builder.grant_id, &builder.workspace_id))
                });
            if builder.is_some_and(|(builder_grant, _)| builder_grant != &grant.grant_id)
                && !grant.capabilities.contains("storage.admin")
            {
                return Err(KernelError::Authorization(
                    "branch builder belongs to another grant".to_string(),
                ));
            }
            builder.map(|(_, workspace)| workspace.clone())
        } else if let Some(owner_id) = params.get("ownerId").and_then(Value::as_str) {
            let owner: Option<(Option<String>, String)> = self
                .conn
                .query_row(
                    "SELECT workspace_id, grant_id FROM object_owners WHERE owner_id = ?1",
                    params![owner_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if owner
                .as_ref()
                .is_some_and(|(_, owner_grant)| owner_grant != &grant.grant_id)
                && !grant.capabilities.contains("storage.admin")
            {
                return Err(KernelError::Authorization(
                    "temporary object owner belongs to another grant".to_string(),
                ));
            }
            owner.and_then(|(workspace, _)| workspace)
        } else if let Some(operation_id) = params.get("operationId").and_then(Value::as_str) {
            let operation_workspace: Option<String> = self
                .conn
                .query_row(
                    "SELECT workspace_id FROM operation_owners WHERE operation_id = ?1",
                    params![operation_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            if operation_workspace.is_some() {
                operation_workspace
            } else {
                self.conn
                    .query_row(
                        "SELECT workspace_id FROM recovery_operations WHERE operation_id = ?1",
                        params![operation_id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?
            }
        } else if let Some(record_id) = params.get("recordId").and_then(Value::as_str) {
            self.conn
                .query_row(
                    "SELECT workspace_id FROM domain_records WHERE record_id = ?1 AND workspace_id = ?2 UNION SELECT workspace_id FROM recovery_operations WHERE operation_id = ?1 AND workspace_id = ?2 LIMIT 1",
                    params![record_id, grant.owning_workspace],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
        } else if method == "branch.diff" {
            let left = params.get("leftRoot").and_then(Value::as_str);
            let right = params.get("rightRoot").and_then(Value::as_str);
            if let (Some(left), Some(right)) = (left, right) {
                if let Some(owning) = &grant.owning_workspace {
                    if self.root_owned_by_workspace(left, owning)?
                        && self.root_owned_by_workspace(right, owning)?
                    {
                        Some(owning.clone())
                    } else {
                        None
                    }
                } else {
                    let left_workspace = self.root_workspace(left)?;
                    let right_workspace = self.root_workspace(right)?;
                    if left_workspace.is_some() && left_workspace == right_workspace {
                        left_workspace
                    } else {
                        None
                    }
                }
            } else {
                None
            }
        } else {
            None
        };
        if method == "operation.get" && workspace.is_none() {
            return Err(KernelError::Authorization(
                "operation is not owned by this storage authority".to_string(),
            ));
        }
        let workspace = workspace;
        if let Some(owning) = &grant.owning_workspace {
            if workspace
                .as_deref()
                .is_some_and(|workspace| workspace != owning.as_str())
            {
                return Err(KernelError::Authorization(
                    "grant workspace does not match resource".to_string(),
                ));
            }
        }
        if let Some(workspace) = workspace.as_deref() {
            if params.get("workspaceId").is_none() {
                if let Some(object) = authorized.as_object_mut() {
                    object.insert(
                        "workspaceId".to_string(),
                        Value::String(workspace.to_string()),
                    );
                }
            }
        }
        if let Some(object) = authorized.as_object_mut() {
            object.insert(
                "__pathScopes".to_string(),
                Value::Array(
                    grant
                        .path_scopes
                        .iter()
                        .cloned()
                        .map(Value::String)
                        .collect(),
                ),
            );
        }
        if method == "storage.snapshot" && !grant.path_scopes.iter().any(String::is_empty) {
            return Err(KernelError::Authorization(
                "snapshot requires an unbounded path grant".to_string(),
            ));
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
                    if let Some(source_path) = value.get("sourcePath").and_then(Value::as_str) {
                        let source = Self::validate_path(source_path)?.join("/");
                        if !path_allowed(&grant, &source) {
                            return Err(KernelError::Authorization(format!(
                                "source path is outside grant scope: {source}"
                            )));
                        }
                    }
                }
            }
        }
        if let Some(path) = params.get("path").and_then(Value::as_str) {
            let canonical = Self::validate_path(path)?.join("/");
            if !path_allowed(&grant, &canonical) {
                return Err(KernelError::Authorization(format!(
                    "path is outside grant scope: {canonical}"
                )));
            }
        }
        if method == "storage.getBlob" {
            let hash = params
                .get("hash")
                .and_then(Value::as_str)
                .ok_or_else(|| KernelError::Authorization("hash is required".to_string()))?;
            if !self.blob_owned(
                hash,
                workspace.as_deref().or(grant.owning_workspace.as_deref()),
            )? {
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

    fn index_remove_min(
        &mut self,
        root: String,
    ) -> Result<(String, String, Option<String>), KernelError> {
        let TrieNode::Index {
            key,
            child,
            left,
            right,
            ..
        } = self.load_node(&root)?
        else {
            return Err(KernelError::Storage("path node used as index".to_string()));
        };
        let Some(left_root) = left else {
            return Ok((key, child, right));
        };
        let (minimum_key, minimum_child, next_left) = self.index_remove_min(left_root)?;
        let rebuilt = self.make_index(key, child, next_left, right)?;
        Ok((
            minimum_key,
            minimum_child,
            Some(self.balance_index(rebuilt)?),
        ))
    }

    fn index_remove(
        &mut self,
        root: Option<String>,
        key: &str,
    ) -> Result<Option<String>, KernelError> {
        self.check_cancelled()?;
        let Some(root) = root else {
            return Ok(None);
        };
        let TrieNode::Index {
            key: current,
            child,
            left,
            right,
            ..
        } = self.load_node(&root)?
        else {
            return Err(KernelError::Storage("path node used as index".to_string()));
        };
        match key.cmp(current.as_str()) {
            std::cmp::Ordering::Less => {
                let next_left = self.index_remove(left, key)?;
                let rebuilt = self.make_index(current, child, next_left, right)?;
                Ok(Some(self.balance_index(rebuilt)?))
            }
            std::cmp::Ordering::Greater => {
                let next_right = self.index_remove(right, key)?;
                let rebuilt = self.make_index(current, child, left, next_right)?;
                Ok(Some(self.balance_index(rebuilt)?))
            }
            std::cmp::Ordering::Equal => match (left, right) {
                (None, next) | (next, None) => Ok(next),
                (Some(left), Some(right)) => {
                    let (successor_key, successor_child, next_right) =
                        self.index_remove_min(right)?;
                    let rebuilt =
                        self.make_index(successor_key, successor_child, Some(left), next_right)?;
                    Ok(Some(self.balance_index(rebuilt)?))
                }
            },
        }
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

    fn root_restore_from_base(
        &mut self,
        current_root: &str,
        base_root: &str,
        segments: &[&str],
    ) -> Result<String, KernelError> {
        if segments.is_empty() {
            return Ok(base_root.to_string());
        }
        let TrieNode::Path {
            state: current_state,
            children: current_children,
        } = self.load_node(current_root)?
        else {
            return Err(KernelError::Storage("index node used as path".to_string()));
        };
        if current_state
            .as_ref()
            .is_some_and(|state| !state.is_directory())
        {
            return Err(KernelError::Operation(
                "a non-directory path cannot have descendants".to_string(),
            ));
        }
        let TrieNode::Path {
            children: base_children,
            ..
        } = self.load_node(base_root)?
        else {
            return Err(KernelError::Storage("index node used as path".to_string()));
        };
        let name = segments[0].as_ref();
        let current_child = self
            .index_get(current_children.as_ref(), name)?
            .unwrap_or(self.empty_root()?);
        let base_child = self.index_get(base_children.as_ref(), name)?;
        let next_children = if segments.len() == 1 {
            match base_child {
                Some(base_child) => {
                    self.index_set(current_children, name.to_string(), base_child)?
                }
                None => self
                    .index_remove(current_children, name)?
                    .unwrap_or_else(String::new),
            }
        } else {
            let empty = self.empty_root()?;
            let restored = self.root_restore_from_base(
                &current_child,
                base_child.as_deref().unwrap_or(&empty),
                &segments[1..],
            )?;
            if base_child.is_none() && restored == empty {
                self.index_remove(current_children, name)?
                    .unwrap_or_else(String::new)
            } else {
                self.index_set(current_children, name.to_string(), restored)?
            }
        };
        self.store_node(&TrieNode::Path {
            state: current_state,
            children: (!next_children.is_empty()).then_some(next_children),
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
            "SELECT workspace_id, base_root, head_root, head_revision, write_revision FROM branches WHERE branch_id = ?1",
            params![branch_id],
            |row| Ok(BranchRow { workspace_id: row.get(0)?, base_root: row.get(1)?, head_root: row.get(2)?, head_revision: row.get(3)?, write_revision: row.get(4)? }),
        ).map_err(|error| match error { rusqlite::Error::QueryReturnedNoRows => KernelError::Operation(format!("branch not found: {branch_id}")), other => other.into() })
    }

    fn root_owned_by_workspace(&self, root: &str, workspace_id: &str) -> Result<bool, KernelError> {
        let found: Option<i64> = self
            .conn
            .query_row(
                "SELECT 1 FROM branches WHERE workspace_id = ?2 AND (base_root = ?1 OR head_root = ?1) UNION SELECT 1 FROM revisions r JOIN branches b ON b.branch_id = r.branch_id WHERE b.workspace_id = ?2 AND r.root_hash = ?1 UNION SELECT 1 FROM pins WHERE workspace_id = ?2 AND root_hash = ?1 LIMIT 1",
                params![root, workspace_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(found.is_some())
    }

    fn root_workspace(&self, root: &str) -> Result<Option<String>, KernelError> {
        self.conn
            .query_row(
                "SELECT workspace_id FROM branches WHERE base_root = ?1 OR head_root = ?1 UNION SELECT b.workspace_id FROM revisions r JOIN branches b ON b.branch_id = r.branch_id WHERE r.root_hash = ?1 UNION SELECT workspace_id FROM pins WHERE root_hash = ?1 LIMIT 1",
                params![root],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    fn resolve_base_ref(&self, base_ref: &str, workspace_id: &str) -> Result<String, KernelError> {
        let root = if base_ref.starts_with("sha256-") {
            base_ref.to_string()
        } else if let Some(pin_id) = base_ref.strip_prefix("pin:") {
            self.conn
                .query_row(
                    "SELECT root_hash FROM pins WHERE pin_id = ?1 AND workspace_id = ?2",
                    params![pin_id, workspace_id],
                    |row| row.get::<_, String>(0),
                )
                .map_err(|error| match error {
                    rusqlite::Error::QueryReturnedNoRows => KernelError::Authorization(
                        "baseRef pin is not owned by workspace".to_string(),
                    ),
                    other => other.into(),
                })?
        } else if let Some((branch_id, revision)) = base_ref.split_once('@') {
            let revision = revision
                .parse::<i64>()
                .map_err(|_| KernelError::Operation("baseRef revision is malformed".to_string()))?;
            self.conn
                .query_row(
                    "SELECT r.root_hash FROM revisions r JOIN branches b ON b.branch_id = r.branch_id WHERE r.branch_id = ?1 AND r.revision = ?2 AND b.workspace_id = ?3",
                    params![branch_id, revision, workspace_id],
                    |row| row.get::<_, String>(0),
                )
                .map_err(|error| match error {
                    rusqlite::Error::QueryReturnedNoRows => {
                        KernelError::Authorization("baseRef revision is not owned by workspace".to_string())
                    }
                    other => other.into(),
                })?
        } else {
            return Err(KernelError::Operation(
                "baseRef must be a root hash, pin:<pinId>, or branchId@revision".to_string(),
            ));
        };
        if !self.root_owned_by_workspace(&root, workspace_id)? {
            return Err(KernelError::Authorization(
                "baseRef root is not owned by workspace".to_string(),
            ));
        }
        self.load_node(&root)?;
        Ok(root)
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
        if let PathState::RegularFile { object_hash, .. } = &parsed {
            if !object_hash.starts_with("sha256-")
                || object_hash.len() != 71
                || !object_hash[7..].chars().all(|c| c.is_ascii_hexdigit())
            {
                return Err(KernelError::Operation(
                    "regular-file.objectHash is malformed".to_string(),
                ));
            }
        }
        Ok(parsed)
    }

    fn validate_blob_metadata(&self, state: &PathState) -> Result<(), KernelError> {
        let PathState::RegularFile {
            object_hash,
            byte_length,
            ..
        } = state
        else {
            return Ok(());
        };
        let recorded: Option<i64> = self
            .conn
            .query_row(
                "SELECT byte_length FROM blobs WHERE hash = ?1",
                params![object_hash],
                |row| row.get(0),
            )
            .optional()?;
        if recorded
            != Some(i64::try_from(*byte_length).map_err(|_| {
                KernelError::Operation("regular-file.byteLength is too large".to_string())
            })?)
        {
            return Err(KernelError::Storage(format!(
                "content object is not durable: {object_hash}"
            )));
        }
        Ok(())
    }

    fn begin_blob_stream(&mut self, params: &Value, grant_id: &str) -> Result<Value, KernelError> {
        self.check_cancelled()?;
        let operation_id = params
            .get("operationId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("operationId is required".to_string()))?;
        let stream_id = params
            .get("streamId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("streamId is required".to_string()))?;
        let expected_length = params
            .get("byteLength")
            .and_then(Value::as_u64)
            .ok_or_else(|| KernelError::Operation("byteLength is required".to_string()))?;
        let expected_hash = params
            .get("expectedHash")
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(stream) = self.streams.get(stream_id) {
            if stream.grant_id != grant_id
                || stream.operation_id != operation_id
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
        let staging = self
            .root
            .join("staging")
            .join(format!("{stream_id}.stream"));
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging)?;
        self.streams.insert(
            stream_id.to_string(),
            BlobStream {
                operation_id: operation_id.to_string(),
                expected_length,
                received: 0,
                next_sequence: 0,
                expected_hash,
                staging: staging.clone(),
                grant_id: grant_id.to_string(),
                workspace_id: params
                    .get("workspaceId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            },
        );
        if let Err(error) = self.check_cancelled() {
            self.streams.remove(stream_id);
            let _ = fs::remove_file(&staging);
            return Err(error);
        }
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
        self.check_cancelled()?;
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
        if params.get("workspaceId").and_then(Value::as_str) != stream.workspace_id.as_deref() {
            let _ = fs::remove_file(&stream.staging);
            return Err(KernelError::Authorization(
                "content stream workspace identity is invalid".to_string(),
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
        if let Err(error) = self.check_cancelled() {
            let _ = fs::remove_file(&stream.staging);
            return Err(error);
        }
        let (hash, byte_length) = hash_file(&stream.staging)?;
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
            let (existing_hash, existing_length) = hash_file(&target)?;
            if existing_hash != hash || existing_length != byte_length {
                let _ = fs::remove_file(&stream.staging);
                return Err(KernelError::Storage(format!(
                    "content object is corrupt: {hash}"
                )));
            }
            fs::remove_file(&stream.staging)?;
            sync_directory(&self.root.join("staging"))?;
        } else {
            let shard = target.parent().expect("object path always has a shard");
            if !shard.exists() {
                fs::create_dir(shard)?;
                sync_directory(&self.root.join("objects"))?;
            }
            if let Err(error) = self.check_cancelled() {
                let _ = fs::remove_file(&stream.staging);
                return Err(error);
            }
            durable_rename(&stream.staging, &target)?;
            OpenOptions::new()
                .read(true)
                .write(true)
                .open(&target)?
                .sync_all()?;
            sync_directory(&self.root.join("staging"))?;
        }
        sync_directory(target.parent().unwrap())?;
        self.conn.execute(
            "INSERT OR IGNORE INTO blobs(hash, byte_length) VALUES (?1, ?2)",
            params![
                hash,
                i64::try_from(byte_length).map_err(|_| KernelError::Operation(
                    "content object is too large".to_string()
                ))?
            ],
        )?;
        self.verified_objects.insert(hash.clone());
        let owner_id = blob_owner_id(&stream.operation_id);
        self.record_object_owner(
            &owner_id,
            &hash,
            params.get("workspaceId").and_then(Value::as_str),
            Some(&stream.operation_id),
            grant_id,
        )?;
        Ok(json!({"hash": hash, "byteLength": byte_length, "ownerId": owner_id}))
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

    fn abort_streams_for_grant(&mut self, grant_id: &str) -> Result<(), KernelError> {
        let stream_ids = self
            .streams
            .iter()
            .filter(|(_, stream)| stream.grant_id == grant_id)
            .map(|(stream_id, _)| stream_id.clone())
            .collect::<Vec<_>>();
        for stream_id in stream_ids {
            if let Some(stream) = self.streams.remove(&stream_id) {
                let _ = fs::remove_file(stream.staging);
            }
        }
        self.branch_builders
            .retain(|_, builder| builder.grant_id != grant_id);
        self.branch_write_builders
            .retain(|_, builder| builder.grant_id != grant_id);
        self.conn.execute(
            "DELETE FROM object_owners WHERE grant_id = ?1",
            params![grant_id],
        )?;
        Ok(())
    }

    fn grant_workspace(&self, grant_id: &str) -> Option<String> {
        self.conn
            .query_row(
                "SELECT grant_json FROM grants WHERE grant_id = ?1",
                params![grant_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .ok()
            .flatten()
            .and_then(|value| serde_json::from_str::<Grant>(&value).ok())
            .and_then(|grant| grant.owning_workspace)
    }

    fn validate_blob_read_source(
        &self,
        params: &Value,
        hash: &str,
        grant_id: &str,
        storage_admin: bool,
    ) -> Result<(), KernelError> {
        let branch_id = params.get("branchId").and_then(Value::as_str);
        let pin_id = params.get("pinId").and_then(Value::as_str);
        let owner_id = params.get("ownerId").and_then(Value::as_str);
        let record_id = params.get("recordId").and_then(Value::as_str);
        if [
            branch_id.is_some(),
            pin_id.is_some(),
            owner_id.is_some(),
            record_id.is_some(),
        ]
        .into_iter()
        .filter(|value| *value)
        .count()
            != 1
        {
            return Err(KernelError::Authorization(
                "content reads require exactly one branchId, pinId, or ownerId source".to_string(),
            ));
        }
        if let Some(owner_id) = owner_id {
            if params.get("path").is_some() || params.get("revision").is_some() {
                return Err(KernelError::Authorization(
                    "owner content reads cannot claim a path or revision".to_string(),
                ));
            }
            let owned: Option<(String, String)> = self
                .conn
                .query_row(
                    "SELECT blob_hash, grant_id FROM object_owners WHERE owner_id = ?1",
                    params![owner_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if owned.as_ref().is_none_or(|(owned_hash, owner_grant)| {
                owned_hash != hash || (!storage_admin && owner_grant != grant_id)
            }) {
                return Err(KernelError::Authorization(
                    "content object is not bound to the supplied owner".to_string(),
                ));
            }
            return Ok(());
        }
        if let Some(record_id) = record_id {
            if params.get("path").is_some() || params.get("revision").is_some() {
                return Err(KernelError::Authorization(
                    "record content reads use an explicit reference slot, not a path or revision"
                        .to_string(),
                ));
            }
            let slot = params.get("slot").and_then(Value::as_str).ok_or_else(|| {
                KernelError::Authorization(
                    "record content reads require a reference slot".to_string(),
                )
            })?;
            let record_workspace = self.grant_workspace(grant_id).ok_or_else(|| {
                KernelError::Authorization(
                    "record content reads require an owning workspace grant".to_string(),
                )
            })?;
            if let Some(record) = self.domain_record_value(&record_workspace, record_id)? {
                if !self.grant_can_access_domain_record(&record, grant_id)? {
                    return Err(KernelError::Authorization(
                        "record belongs to another actor".to_string(),
                    ));
                }
            }
            let owned: Option<(String, String)> = self
                .conn
                .query_row(
                    "SELECT object_hash, workspace_id FROM domain_record_refs WHERE record_id = ?1 AND slot = ?2 AND workspace_id = ?3 UNION SELECT object_hash, workspace_id FROM recovery_refs WHERE (owner_id = ?1 OR owner_id LIKE ?1 || ':%') AND slot = ?2 AND workspace_id = ?3 LIMIT 1",
                    params![record_id, slot, record_workspace],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if owned.as_ref().is_none_or(|(owned_hash, workspace)| {
                owned_hash != hash
                    || (!storage_admin
                        && self
                            .grant_workspace(grant_id)
                            .is_some_and(|grant_workspace| grant_workspace != *workspace))
            }) {
                return Err(KernelError::Authorization(
                    "content object is not bound to the supplied durable record".to_string(),
                ));
            }
            return Ok(());
        }
        let raw_path = params.get("path").and_then(Value::as_str).ok_or_else(|| {
            KernelError::Authorization(
                "path is required for a branch or pin content read".to_string(),
            )
        })?;
        let path = Self::validate_path(raw_path)?.join("/");
        let root = if let Some(branch_id) = branch_id {
            if let Some(revision) = params.get("revision").and_then(Value::as_i64) {
                self.conn
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
                    })?
            } else {
                self.branch(branch_id)?.head_root
            }
        } else {
            if params.get("revision").is_some() {
                return Err(KernelError::Authorization(
                    "revision is only valid for a branch content source".to_string(),
                ));
            }
            self.conn
                .query_row(
                    "SELECT root_hash FROM pins WHERE pin_id = ?1",
                    params![pin_id.expect("source count checked")],
                    |row| row.get::<_, String>(0),
                )
                .map_err(|error| match error {
                    rusqlite::Error::QueryReturnedNoRows => {
                        KernelError::Operation("pin not found".to_string())
                    }
                    other => other.into(),
                })?
        };
        let state = self.root_get(&root, &path)?;
        if state.as_ref().and_then(PathState::object_hash) != Some(hash) {
            return Err(KernelError::Authorization(
                "content object is not the file bound to the supplied source path".to_string(),
            ));
        }
        Ok(())
    }

    fn get_blob(
        &mut self,
        params: &Value,
        grant_id: &str,
        storage_admin: bool,
    ) -> Result<Value, KernelError> {
        let hash = params
            .get("hash")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("hash is required".to_string()))?;
        self.validate_blob_read_source(params, hash, grant_id, storage_admin)?;
        let path = object_path(&self.root, hash)?;
        let byte_length = fs::metadata(&path)?.len();
        if !self.verified_objects.contains(hash) {
            let (actual, hashed_length) = hash_file(&path)?;
            if actual != hash || hashed_length != byte_length {
                return Err(KernelError::Storage(format!(
                    "content object is corrupt: {hash}"
                )));
            }
            self.verified_objects.insert(hash.to_string());
        }
        let recorded: Option<i64> = self
            .conn
            .query_row(
                "SELECT byte_length FROM blobs WHERE hash = ?1",
                params![hash],
                |row| row.get(0),
            )
            .optional()?;
        if recorded
            != Some(
                i64::try_from(byte_length)
                    .map_err(|_| KernelError::Storage("content object is too large".to_string()))?,
            )
        {
            return Err(KernelError::Storage(format!(
                "content object metadata is missing or corrupt: {hash}"
            )));
        }
        let offset = match params.get("offset") {
            Some(value) => value.as_u64().ok_or_else(|| {
                KernelError::Operation("offset must be a non-negative integer".to_string())
            })?,
            None => 0,
        };
        let length = match params.get("length") {
            Some(value) => value.as_u64().ok_or_else(|| {
                KernelError::Operation("length must be a non-negative integer".to_string())
            })?,
            None => byte_length.saturating_sub(offset),
        };
        if byte_length > MAX_BLOB_RESPONSE_BYTES as u64 && params.get("length").is_none() {
            return Err(KernelError::Operation(
                "content object is larger than one response frame; request a byte range"
                    .to_string(),
            ));
        }
        if length > MAX_BLOB_RESPONSE_BYTES as u64 {
            return Err(KernelError::Operation(
                "requested byte range is larger than one response frame".to_string(),
            ));
        }
        let start = offset.min(byte_length);
        let end = start.saturating_add(length).min(byte_length);
        let slice_length = usize::try_from(end - start).map_err(|_| {
            KernelError::Operation("requested object range is too large".to_string())
        })?;
        let mut file = File::open(&path)?;
        file.seek(SeekFrom::Start(start))?;
        let mut bytes = vec![0u8; slice_length];
        file.read_exact(&mut bytes)?;
        Ok(
            json!({"hash": hash, "byteLength": byte_length, "offset": start, "nextOffset": end, "eof": end >= byte_length, "bytesBase64": BASE64.encode(bytes)}),
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

    fn validate_state_ownership(
        &self,
        entries: &[(Vec<String>, PathState)],
        temporary_owners: &BTreeMap<String, String>,
        source_paths: &BTreeMap<String, String>,
        source_records: &BTreeMap<String, (String, String)>,
        source_roots: &[&str],
        workspace_id: &str,
        grant_id: &str,
    ) -> Result<(), KernelError> {
        for (segments, state) in entries {
            if let Some(hash) = state.object_hash() {
                let supplied_owner = temporary_owners.values().any(|owned| owned == hash);
                let target_path = segments.join("/");
                let source_path = source_paths.get(&target_path).unwrap_or(&target_path);
                let source_matches = source_roots.iter().try_fold(false, |matched, root| {
                    if matched {
                        return Ok(true);
                    }
                    Ok::<bool, KernelError>(
                        self.root_get(root, source_path)?
                            .as_ref()
                            .and_then(PathState::object_hash)
                            == Some(hash),
                    )
                })?;
                let record_matches = if let Some((record_id, slot)) =
                    source_records.get(&target_path)
                {
                    let grant = self.load_grant(grant_id)?;
                    if !grant.capabilities.contains("storage.maintenance")
                        && !grant.capabilities.contains("storage.admin")
                    {
                        return Err(KernelError::Authorization(
                            "record-backed branch writes require storage maintenance authority"
                                .to_string(),
                        ));
                    }
                    let record = self
                        .domain_record_value(workspace_id, record_id)?
                        .ok_or_else(|| {
                            KernelError::Authorization("source record is not found".to_string())
                        })?;
                    if !self.grant_can_access_domain_record(&record, grant_id)? {
                        return Err(KernelError::Authorization(
                            "source record belongs to another actor".to_string(),
                        ));
                    }
                    self.conn.query_row(
                        "SELECT 1 FROM domain_record_refs WHERE workspace_id = ?1 AND record_id = ?2 AND slot = ?3 AND object_hash = ?4",
                        params![workspace_id, record_id, slot, hash],
                        |row| row.get::<_, i64>(0),
                    ).optional()?.is_some()
                } else {
                    false
                };
                if !supplied_owner && !source_matches && !record_matches {
                    return Err(KernelError::Authorization(format!(
                        "content object is not bound to an authorized source: {target_path}"
                    )));
                }
                self.validate_blob_metadata(state)?;
            }
        }
        Ok(())
    }

    fn begin_branch_builder(
        &mut self,
        params: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        self.check_cancelled()?;
        let builder_id = params
            .get("builderId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("builderId is required".to_string()))?;
        let operation_id = params
            .get("operationId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("operationId is required".to_string()))?;
        let branch_id = params
            .get("branchId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("branchId is required".to_string()))?;
        let workspace_id = params
            .get("workspaceId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("workspaceId is required".to_string()))?;
        let base_ref = params
            .get("baseRef")
            .and_then(Value::as_str)
            .map(str::to_string);
        if self.branch_write_builders.contains_key(builder_id) {
            return Err(KernelError::Operation(
                "builderId is already used by a branch mutation".to_string(),
            ));
        }
        if let Some(existing) = self.branch_builders.get(builder_id) {
            if existing.operation_id != operation_id
                || existing.branch_id != branch_id
                || existing.workspace_id != workspace_id
                || existing.base_ref != base_ref
                || existing.grant_id != grant_id
            {
                return Err(KernelError::Operation(
                    "builderId was reused with a different branch identity".to_string(),
                ));
            }
            return Ok(json!({
                "builderId": builder_id,
                "operationId": operation_id,
                "nextSequence": existing.next_sequence,
                "entryCount": existing.entries.len(),
            }));
        }
        self.branch_builders.insert(
            builder_id.to_string(),
            BranchBuilder {
                operation_id: operation_id.to_string(),
                branch_id: branch_id.to_string(),
                workspace_id: workspace_id.to_string(),
                base_ref,
                next_sequence: 0,
                entries: Vec::new(),
                grant_id: grant_id.to_string(),
            },
        );
        Ok(
            json!({"builderId": builder_id, "operationId": operation_id, "nextSequence": 0, "entryCount": 0}),
        )
    }

    fn append_branch_builder(
        &mut self,
        params: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        self.check_cancelled()?;
        let builder_id = params
            .get("builderId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("builderId is required".to_string()))?;
        let sequence = params
            .get("sequence")
            .and_then(Value::as_u64)
            .ok_or_else(|| KernelError::Operation("sequence is required".to_string()))?;
        let entries = params
            .get("entries")
            .and_then(Value::as_array)
            .ok_or_else(|| KernelError::Operation("entries is required".to_string()))?;
        for entry in entries {
            let path = entry
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| KernelError::Operation("entry.path is required".to_string()))?;
            Self::validate_path(path)?;
            let state = entry
                .get("state")
                .cloned()
                .ok_or_else(|| KernelError::Operation("entry.state is required".to_string()))?;
            self.parse_state(&state)?;
        }
        let builder = self
            .branch_builders
            .get_mut(builder_id)
            .ok_or_else(|| KernelError::Operation("branch builder not found".to_string()))?;
        if builder.grant_id != grant_id || builder.next_sequence != sequence {
            return Err(KernelError::Authorization(
                "branch builder identity or sequence is invalid".to_string(),
            ));
        }
        let original_len = builder.entries.len();
        builder.entries.extend(entries.iter().cloned());
        builder.next_sequence += 1;
        if let Err(error) = self.check_cancelled() {
            if let Some(builder) = self.branch_builders.get_mut(builder_id) {
                builder.entries.truncate(original_len);
                builder.next_sequence = sequence;
            }
            return Err(error);
        }
        Ok(json!({
            "builderId": builder_id,
            "nextSequence": sequence + 1,
            "entryCount": self.branch_builders.get(builder_id).map_or(0, |builder| builder.entries.len()),
        }))
    }

    fn finish_branch_builder(
        &mut self,
        params: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        self.check_cancelled()?;
        let builder_id = params
            .get("builderId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("builderId is required".to_string()))?;
        let operation_id = params
            .get("operationId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("operationId is required".to_string()))?;
        let builder = self
            .branch_builders
            .get(builder_id)
            .ok_or_else(|| KernelError::Operation("branch builder not found".to_string()))?;
        if builder.grant_id != grant_id || builder.operation_id != operation_id {
            return Err(KernelError::Authorization(
                "branch builder identity is invalid".to_string(),
            ));
        }
        let builder = self
            .branch_builders
            .remove(builder_id)
            .expect("validated branch builder still exists");
        let mut creation = json!({
            "operationId": builder.operation_id,
            "branchId": builder.branch_id,
            "workspaceId": builder.workspace_id,
            "entries": builder.entries,
        });
        if let Some(base_ref) = &builder.base_ref {
            creation
                .as_object_mut()
                .expect("branch creation is an object")
                .insert("baseRef".to_string(), Value::String(base_ref.clone()));
        }
        idempotent(self, "branch.create", &creation, |storage| {
            storage.create_branch(&creation, grant_id)
        })
    }

    fn abort_branch_builder(
        &mut self,
        params: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let builder_id = params
            .get("builderId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("builderId is required".to_string()))?;
        let Some(builder) = self.branch_builders.get(builder_id) else {
            return Ok(json!({"builderId": builder_id, "aborted": false}));
        };
        if builder.grant_id != grant_id {
            return Err(KernelError::Authorization(
                "branch builder belongs to another grant".to_string(),
            ));
        }
        self.branch_builders.remove(builder_id);
        Ok(json!({"builderId": builder_id, "aborted": true}))
    }

    fn create_branch(&mut self, params: &Value, grant_id: &str) -> Result<Value, KernelError> {
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
            .cloned()
            .unwrap_or_default();
        let mut entries_to_write = Vec::with_capacity(entries.len());
        let mut owners_to_consume = BTreeMap::new();
        let mut source_paths = BTreeMap::new();
        let mut source_records = BTreeMap::new();
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
            let parsed = self.parse_state(&state)?;
            let source_count = usize::from(entry.get("ownerId").is_some())
                + usize::from(entry.get("sourcePath").is_some())
                + usize::from(
                    entry.get("sourceRecordId").is_some() || entry.get("sourceSlot").is_some(),
                );
            if source_count > 1 {
                return Err(KernelError::Operation(
                    "a branch entry must use exactly one content source".to_string(),
                ));
            }
            if source_count > 0 && parsed.object_hash().is_none() {
                return Err(KernelError::Operation(
                    "content sources are only valid for regular-file entries".to_string(),
                ));
            }
            let normalized_path = segments.join("/");
            if let Some(source_path) = entry.get("sourcePath").and_then(Value::as_str) {
                source_paths.insert(
                    normalized_path.clone(),
                    Self::validate_path(source_path)?.join("/"),
                );
            }
            match (
                entry.get("sourceRecordId").and_then(Value::as_str),
                entry.get("sourceSlot").and_then(Value::as_str),
            ) {
                (Some(record_id), Some(slot)) if !record_id.is_empty() && !slot.is_empty() => {
                    source_records.insert(
                        normalized_path.clone(),
                        (record_id.to_string(), slot.to_string()),
                    );
                }
                (None, None) => {}
                _ => {
                    return Err(KernelError::Operation(
                        "sourceRecordId and sourceSlot must be supplied together".to_string(),
                    ))
                }
            }
            if let Some(owner_id) = entry.get("ownerId").and_then(Value::as_str) {
                let hash = parsed.object_hash().ok_or_else(|| {
                    KernelError::Operation(
                        "ownerId is only valid for a regular-file entry".to_string(),
                    )
                })?;
                if owners_to_consume
                    .insert(owner_id.to_string(), hash.to_string())
                    .is_some_and(|previous| previous != hash)
                {
                    return Err(KernelError::Operation(
                        "one ownerId cannot identify different content objects".to_string(),
                    ));
                }
            }
            entries_to_write.push((segments, parsed));
        }
        Self::validate_batch_paths(&entries_to_write)?;
        self.validate_object_owners(workspace_id, grant_id, &owners_to_consume)?;
        let base_root = if let Some(base_ref) = params.get("baseRef").and_then(Value::as_str) {
            self.resolve_base_ref(base_ref, workspace_id)?
        } else {
            self.empty_root()?
        };
        self.validate_state_ownership(
            &entries_to_write,
            &owners_to_consume,
            &source_paths,
            &source_records,
            &[&base_root],
            workspace_id,
            grant_id,
        )?;
        let entry_blob_hashes = entries_to_write
            .iter()
            .filter_map(|(_, state)| state.object_hash().map(str::to_string))
            .collect::<Vec<_>>();
        let mut root = base_root.clone();
        if !entries_to_write.is_empty() {
            if params.get("baseRef").is_none() {
                root = self.build_root(&entries_to_write)?;
            } else {
                for (segments, state) in entries_to_write {
                    let refs = segments.iter().map(String::as_str).collect::<Vec<_>>();
                    root = self.root_set(&root, &refs, state)?;
                }
            }
            if params.get("baseRef").is_some() {
                self.record_root_blob_hashes(&root, entry_blob_hashes.clone())?;
            }
        }
        if params.get("baseRef").is_none() {
            self.record_root_blobs(&root)?;
        }
        self.consume_object_owners(workspace_id, grant_id, &owners_to_consume)?;
        self.record_root_parent(&root, &base_root)?;
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
        let scopes = params
            .get("__pathScopes")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            });
        let mut next_cursor: Option<u64> = None;
        let entries = if let Some(paths) = requested {
            let mut selected = Vec::new();
            for path in paths.iter().filter_map(Value::as_str) {
                let canonical = Self::validate_path(path)?.join("/");
                if let Some(scopes) = scopes.as_ref() {
                    if !path_allowed_scopes(scopes, &canonical) {
                        return Err(KernelError::Authorization(format!(
                            "path is outside grant scope: {canonical}"
                        )));
                    }
                }
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
            let all_entries = self.root_entries(&root)?;
            let cursor = params.get("cursor").and_then(Value::as_u64).unwrap_or(0) as usize;
            let page_size = params
                .get("pageSize")
                .and_then(Value::as_u64)
                .map(|value| value as usize)
                .unwrap_or(all_entries.len());
            if params.get("pageSize").is_some() && page_size == 0 {
                return Err(KernelError::Operation(
                    "pageSize must be positive when supplied".to_string(),
                ));
            }
            let start = cursor.min(all_entries.len());
            let end = start.saturating_add(page_size).min(all_entries.len());
            if end < all_entries.len() {
                next_cursor = Some(end as u64);
            }
            all_entries[start..end]
                .iter()
                .cloned()
                .filter(|(path, _)| {
                    scopes
                        .as_ref()
                        .is_none_or(|scopes| path_allowed_scopes(scopes, path))
                })
                .map(|(path, state)| json!({"path": path, "state": state}))
                .collect()
        } else {
            Vec::new()
        };
        Ok(
            json!({"branchId": branch_id, "workspaceId": branch.workspace_id, "root": root, "revision": revision, "view": view, "currentRoot": branch.head_root, "headRevision": branch.head_revision, "writeRevision": branch.write_revision, "entries": entries, "nextCursor": next_cursor}),
        )
    }

    fn begin_branch_write_builder(
        &mut self,
        params: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        self.check_cancelled()?;
        let builder_id = params
            .get("builderId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("builderId is required".to_string()))?;
        let operation_id = params
            .get("operationId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("operationId is required".to_string()))?;
        let branch_id = params
            .get("branchId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("branchId is required".to_string()))?;
        let expected_write_revision = params
            .get("expectedWriteRevision")
            .and_then(Value::as_i64)
            .ok_or_else(|| {
                KernelError::Operation("expectedWriteRevision is required".to_string())
            })?;
        let workspace_id = self.branch(branch_id)?.workspace_id;
        if self.branch_builders.contains_key(builder_id) {
            return Err(KernelError::Operation(
                "builderId is already used by a branch creation".to_string(),
            ));
        }
        if let Some(existing) = self.branch_write_builders.get(builder_id) {
            if existing.operation_id != operation_id
                || existing.branch_id != branch_id
                || existing.expected_write_revision != expected_write_revision
                || existing.grant_id != grant_id
            {
                return Err(KernelError::Operation(
                    "builderId was reused with a different branch mutation".to_string(),
                ));
            }
            return Ok(json!({
                "builderId": builder_id,
                "operationId": operation_id,
                "nextSequence": existing.next_sequence,
                "changeCount": existing.changes.len(),
            }));
        }
        self.branch_write_builders.insert(
            builder_id.to_string(),
            BranchWriteBuilder {
                operation_id: operation_id.to_string(),
                branch_id: branch_id.to_string(),
                expected_write_revision,
                workspace_id,
                next_sequence: 0,
                changes: Vec::new(),
                grant_id: grant_id.to_string(),
            },
        );
        Ok(
            json!({"builderId": builder_id, "operationId": operation_id, "nextSequence": 0, "changeCount": 0}),
        )
    }

    fn append_branch_write_builder(
        &mut self,
        params: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        self.check_cancelled()?;
        let builder_id = params
            .get("builderId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("builderId is required".to_string()))?;
        let sequence = params
            .get("sequence")
            .and_then(Value::as_u64)
            .ok_or_else(|| KernelError::Operation("sequence is required".to_string()))?;
        let changes = params
            .get("changes")
            .and_then(Value::as_array)
            .ok_or_else(|| KernelError::Operation("changes is required".to_string()))?;
        for change in changes {
            let path = change
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| KernelError::Operation("change.path is required".to_string()))?;
            Self::validate_path(path)?;
            let state = change
                .get("state")
                .cloned()
                .ok_or_else(|| KernelError::Operation("change.state is required".to_string()))?;
            self.parse_state(&state)?;
        }
        let builder = self
            .branch_write_builders
            .get_mut(builder_id)
            .ok_or_else(|| {
                KernelError::Operation("branch mutation builder not found".to_string())
            })?;
        if builder.grant_id != grant_id || builder.next_sequence != sequence {
            return Err(KernelError::Authorization(
                "branch mutation builder identity or sequence is invalid".to_string(),
            ));
        }
        let original_len = builder.changes.len();
        builder.changes.extend(changes.iter().cloned());
        builder.next_sequence += 1;
        if let Err(error) = self.check_cancelled() {
            if let Some(builder) = self.branch_write_builders.get_mut(builder_id) {
                builder.changes.truncate(original_len);
                builder.next_sequence = sequence;
            }
            return Err(error);
        }
        Ok(json!({
            "builderId": builder_id,
            "nextSequence": sequence + 1,
            "changeCount": self.branch_write_builders.get(builder_id).map_or(0, |builder| builder.changes.len()),
        }))
    }

    fn finish_branch_write_builder(
        &mut self,
        params: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        self.check_cancelled()?;
        let builder_id = params
            .get("builderId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("builderId is required".to_string()))?;
        let operation_id = params
            .get("operationId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("operationId is required".to_string()))?;
        let builder = self.branch_write_builders.get(builder_id).ok_or_else(|| {
            KernelError::Operation("branch mutation builder not found".to_string())
        })?;
        if builder.grant_id != grant_id || builder.operation_id != operation_id {
            return Err(KernelError::Authorization(
                "branch mutation builder identity is invalid".to_string(),
            ));
        }
        let builder = self
            .branch_write_builders
            .remove(builder_id)
            .expect("validated branch mutation builder still exists");
        let mutation = json!({
            "operationId": builder.operation_id,
            "branchId": builder.branch_id,
            "workspaceId": builder.workspace_id,
            "expectedWriteRevision": builder.expected_write_revision,
            "changes": builder.changes,
        });
        idempotent(self, "branch.write", &mutation, |storage| {
            storage.branch_write(&mutation, grant_id)
        })
    }

    fn abort_branch_write_builder(
        &mut self,
        params: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let builder_id = params
            .get("builderId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("builderId is required".to_string()))?;
        let Some(builder) = self.branch_write_builders.get(builder_id) else {
            return Ok(json!({"builderId": builder_id, "aborted": false}));
        };
        if builder.grant_id != grant_id {
            return Err(KernelError::Authorization(
                "branch mutation builder belongs to another grant".to_string(),
            ));
        }
        self.branch_write_builders.remove(builder_id);
        Ok(json!({"builderId": builder_id, "aborted": true}))
    }

    fn branch_write(&mut self, params: &Value, grant_id: &str) -> Result<Value, KernelError> {
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
        let mut owners_to_consume = BTreeMap::new();
        let mut source_paths = BTreeMap::new();
        let mut source_records = BTreeMap::new();
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
            let parsed = self.parse_state(&state)?;
            let source_count = usize::from(change.get("ownerId").is_some())
                + usize::from(change.get("sourcePath").is_some())
                + usize::from(
                    change.get("sourceRecordId").is_some() || change.get("sourceSlot").is_some(),
                );
            if source_count > 1 {
                return Err(KernelError::Operation(
                    "a branch change must use exactly one content source".to_string(),
                ));
            }
            if source_count > 0 && parsed.object_hash().is_none() {
                return Err(KernelError::Operation(
                    "content sources are only valid for regular-file changes".to_string(),
                ));
            }
            let normalized_path = segments.join("/");
            if let Some(source_path) = change.get("sourcePath").and_then(Value::as_str) {
                source_paths.insert(
                    normalized_path.clone(),
                    Self::validate_path(source_path)?.join("/"),
                );
            }
            match (
                change.get("sourceRecordId").and_then(Value::as_str),
                change.get("sourceSlot").and_then(Value::as_str),
            ) {
                (Some(record_id), Some(slot)) if !record_id.is_empty() && !slot.is_empty() => {
                    source_records.insert(
                        normalized_path.clone(),
                        (record_id.to_string(), slot.to_string()),
                    );
                }
                (None, None) => {}
                _ => {
                    return Err(KernelError::Operation(
                        "sourceRecordId and sourceSlot must be supplied together".to_string(),
                    ))
                }
            }
            if let Some(owner_id) = change.get("ownerId").and_then(Value::as_str) {
                let hash = parsed.object_hash().ok_or_else(|| {
                    KernelError::Operation(
                        "ownerId is only valid for a regular-file change".to_string(),
                    )
                })?;
                if owners_to_consume
                    .insert(owner_id.to_string(), hash.to_string())
                    .is_some_and(|previous| previous != hash)
                {
                    return Err(KernelError::Operation(
                        "one ownerId cannot identify different content objects".to_string(),
                    ));
                }
            }
            changes_to_write.push((segments, parsed));
        }
        Self::validate_batch_paths(&changes_to_write)?;
        self.validate_object_owners(&branch.workspace_id, grant_id, &owners_to_consume)?;
        self.validate_state_ownership(
            &changes_to_write,
            &owners_to_consume,
            &source_paths,
            &source_records,
            &[&branch.head_root, &branch.base_root],
            &branch.workspace_id,
            grant_id,
        )?;
        let previous_root = branch.head_root.clone();
        let changed_blobs = changes_to_write
            .iter()
            .filter_map(|(_, state)| state.object_hash().map(str::to_string))
            .collect::<Vec<_>>();
        let mut root = previous_root.clone();
        for (segments, state) in changes_to_write {
            let refs = segments.iter().map(String::as_str).collect::<Vec<_>>();
            let base_state = self.root_get(&branch.base_root, &segments.join("/"))?;
            let restores_base = !state.is_directory()
                && match (&state, base_state.as_ref()) {
                    (PathState::Missing, None) => true,
                    (_, Some(base_state)) => base_state == &state,
                    _ => false,
                };
            root = if restores_base {
                self.root_restore_from_base(&root, &branch.base_root, &refs)?
            } else {
                self.root_set(&root, &refs, state)?
            };
        }
        let next = branch.write_revision + 1;
        self.conn.execute("UPDATE branches SET head_root = ?2, write_revision = ?3, updated_at = ?4 WHERE branch_id = ?1 AND write_revision = ?5", params![branch_id, root, next, now_ms(), expected])?;
        if self.conn.changes() != 1 {
            return Ok(
                json!({"status": "conflict", "writeRevision": self.branch(branch_id)?.write_revision, "root": self.branch(branch_id)?.head_root}),
            );
        }
        self.record_root_parent(&root, &previous_root)?;
        self.record_root_blob_hashes(&root, changed_blobs.clone())?;
        self.consume_object_owners(&branch.workspace_id, grant_id, &owners_to_consume)?;
        Ok(json!({"status": "committed", "writeRevision": next, "root": root}))
    }

    fn branch_publish(&mut self, params: &Value) -> Result<Value, KernelError> {
        let branch_id = params
            .get("branchId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("branchId is required".to_string()))?;
        let branch = self.branch(branch_id)?;
        let expected = params
            .get("expectedWriteRevision")
            .and_then(Value::as_i64)
            .ok_or_else(|| {
                KernelError::Operation("expectedWriteRevision is required".to_string())
            })?;
        let expected_root = params
            .get("expectedRoot")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("expectedRoot is required".to_string()))?;
        if expected != branch.write_revision || expected_root != branch.head_root {
            return Ok(
                json!({"status": "conflict", "branchId": branch_id, "writeRevision": branch.write_revision, "root": branch.head_root}),
            );
        }
        let revision = branch.head_revision + 1;
        self.conn.execute("INSERT INTO revisions(branch_id, revision, root_hash, operation_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)", params![branch_id, revision, branch.head_root, params.get("operationId").and_then(Value::as_str), now_ms()])?;
        self.conn.execute(
            "UPDATE branches SET head_revision = ?2, updated_at = ?3 WHERE branch_id = ?1",
            params![branch_id, revision, now_ms()],
        )?;
        Ok(
            json!({"status": "committed", "branchId": branch_id, "revision": revision, "root": branch.head_root, "writeRevision": branch.write_revision}),
        )
    }

    fn branch_pin(
        &mut self,
        params: &Value,
        pin: bool,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
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
            let owner: Option<String> = self
                .conn
                .query_row(
                    "SELECT grant_id FROM pins WHERE pin_id = ?1 AND branch_id = ?2",
                    params![pin_id, branch_id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(owner) = owner.as_deref() {
                let grant = self.load_grant(grant_id)?;
                if owner != grant_id
                    && !grant.capabilities.contains("storage.maintenance")
                    && !grant.capabilities.contains("storage.admin")
                {
                    return Err(KernelError::Authorization(
                        "pin belongs to another actor".to_string(),
                    ));
                }
            }
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
        let expected_write_revision = params.get("expectedWriteRevision").and_then(Value::as_i64);
        let expected_root = params.get("expectedRoot").and_then(Value::as_str);
        if requested_revision.is_some()
            && (expected_write_revision.is_some() || expected_root.is_some())
        {
            return Err(KernelError::Operation(
                "revision and current-root expectations are mutually exclusive".to_string(),
            ));
        }
        if expected_write_revision.is_some() != expected_root.is_some() {
            return Err(KernelError::Operation(
                "expectedWriteRevision and expectedRoot must be supplied together".to_string(),
            ));
        }
        let (revision, write_revision, root, view) = if let Some(revision) = requested_revision {
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
            (revision, -1, root, "revision")
        } else if let (Some(expected_write_revision), Some(expected_root)) =
            (expected_write_revision, expected_root)
        {
            if branch.write_revision != expected_write_revision || branch.head_root != expected_root
            {
                return Ok(json!({
                    "status": "conflict",
                    "branchId": branch_id,
                    "writeRevision": branch.write_revision,
                    "root": branch.head_root,
                }));
            }
            (
                branch.head_revision,
                branch.write_revision,
                branch.head_root.clone(),
                "current",
            )
        } else {
            let root = self
                .conn
                .query_row(
                    "SELECT root_hash FROM revisions WHERE branch_id = ?1 AND revision = ?2",
                    params![branch_id, branch.head_revision],
                    |row| row.get::<_, String>(0),
                )
                .map_err(|error| match error {
                    rusqlite::Error::QueryReturnedNoRows => KernelError::Operation(
                        "cannot pin a branch without a published revision".to_string(),
                    ),
                    other => other.into(),
                })?;
            (branch.head_revision, -1, root, "revision")
        };
        let ephemeral = write_revision >= 0;
        if let Some((existing_branch, existing_workspace, existing_revision, existing_write_revision, existing_root, existing_grant, existing_ephemeral)) = self
            .conn
            .query_row(
                "SELECT branch_id, workspace_id, revision, write_revision, root_hash, grant_id, ephemeral FROM pins WHERE pin_id = ?1",
                params![pin_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, bool>(6)?,
                    ))
                },
            )
            .optional()?
        {
            if existing_branch != branch_id
                || existing_workspace != branch.workspace_id
                || existing_revision != revision
                || existing_write_revision != write_revision
                || existing_root != root
                || existing_grant != grant_id
                || existing_ephemeral != ephemeral
            {
                return Err(KernelError::Authorization(
                    "pinId is already bound to another identity".to_string(),
                ));
            }
            return Ok(
                json!({"pinId": pin_id, "branchId": branch_id, "workspaceId": branch.workspace_id, "revision": revision, "writeRevision": write_revision, "view": view, "root": root, "pinned": true, "created": false}),
            );
        }
        self.conn.execute("INSERT INTO pins(pin_id, branch_id, workspace_id, revision, write_revision, root_hash, grant_id, ephemeral, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)", params![pin_id, branch_id, branch.workspace_id, revision, write_revision, root, grant_id, ephemeral, now_ms()])?;
        Ok(
            json!({"pinId": pin_id, "branchId": branch_id, "workspaceId": branch.workspace_id, "revision": revision, "writeRevision": write_revision, "view": view, "root": root, "pinned": true, "created": true}),
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

    fn pin_read(&self, params: &Value, grant_id: &str) -> Result<Value, KernelError> {
        let pin_id = params
            .get("pinId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("pinId is required".to_string()))?;
        let (branch_id, workspace_id, revision, write_revision, root, owner_grant, ephemeral): (String, String, i64, i64, String, String, bool) = self
            .conn
            .query_row(
                "SELECT branch_id, workspace_id, revision, write_revision, root_hash, grant_id, ephemeral FROM pins WHERE pin_id = ?1",
                params![pin_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
            )
            .map_err(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => {
                    KernelError::Operation(format!("pin not found: {pin_id}"))
                }
                other => other.into(),
            })?;
        if ephemeral && owner_grant != grant_id {
            let grant = self.load_grant(grant_id)?;
            if !grant.capabilities.contains("storage.maintenance")
                && !grant.capabilities.contains("storage.admin")
            {
                return Err(KernelError::Authorization(
                    "query pin belongs to another actor".to_string(),
                ));
            }
        }
        let scopes = params
            .get("__pathScopes")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            });
        let mut next_cursor: Option<u64> = None;
        let entries = if let Some(paths) = params.get("paths").and_then(Value::as_array) {
            let mut selected = Vec::new();
            for path in paths.iter().filter_map(Value::as_str) {
                let canonical = Self::validate_path(path)?.join("/");
                if scopes
                    .as_ref()
                    .is_some_and(|scopes| !path_allowed_scopes(scopes, &canonical))
                {
                    return Err(KernelError::Authorization(format!(
                        "path is outside grant scope: {canonical}"
                    )));
                }
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
            let all_entries = self
                .root_entries(&root)?
                .into_iter()
                .filter(|(path, _)| {
                    scopes
                        .as_ref()
                        .is_none_or(|scopes| path_allowed_scopes(scopes, path))
                })
                .collect::<Vec<_>>();
            let cursor = params.get("cursor").and_then(Value::as_u64).unwrap_or(0) as usize;
            let page_size = params
                .get("pageSize")
                .and_then(Value::as_u64)
                .map(|value| value as usize)
                .unwrap_or(all_entries.len());
            if params.get("pageSize").is_some() && page_size == 0 {
                return Err(KernelError::Operation(
                    "pageSize must be positive when supplied".to_string(),
                ));
            }
            let start = cursor.min(all_entries.len());
            let end = start.saturating_add(page_size).min(all_entries.len());
            if end < all_entries.len() {
                next_cursor = Some(end as u64);
            }
            all_entries[start..end]
                .iter()
                .cloned()
                .map(|(path, state)| json!({"path": path, "state": state}))
                .collect()
        } else {
            Vec::new()
        };
        Ok(
            json!({"pinId": pin_id, "branchId": branch_id, "workspaceId": workspace_id, "revision": revision, "writeRevision": write_revision, "view": if write_revision >= 0 { "current" } else { "revision" }, "root": root, "entries": entries, "nextCursor": next_cursor}),
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
        if let Some(scopes) = params
            .get("__pathScopes")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
        {
            added.retain(|path| path_allowed_scopes(&scopes, path));
            removed.retain(|path| path_allowed_scopes(&scopes, path));
            changed.retain(|path| path_allowed_scopes(&scopes, path));
        }
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
        self.diff_index_range(
            left.cloned(),
            right.cloned(),
            None,
            None,
            prefix,
            added,
            removed,
            changed,
        )
    }

    fn index_root_in_range(
        &self,
        mut root: Option<String>,
        lower: Option<&str>,
        upper: Option<&str>,
    ) -> Result<Option<String>, KernelError> {
        while let Some(hash) = root.clone() {
            let TrieNode::Index {
                key, left, right, ..
            } = self.load_node(&hash)?
            else {
                return Err(KernelError::Storage("path node used as index".to_string()));
            };
            if lower.is_some_and(|lower| key.as_str() <= lower) {
                root = right;
            } else if upper.is_some_and(|upper| key.as_str() >= upper) {
                root = left;
            } else {
                return Ok(Some(hash));
            }
        }
        Ok(None)
    }

    fn collect_index_range(
        &self,
        root: Option<String>,
        lower: Option<&str>,
        upper: Option<&str>,
        prefix: &str,
        target: &mut Vec<String>,
    ) -> Result<(), KernelError> {
        self.check_cancelled()?;
        let Some(root) = root else {
            return Ok(());
        };
        let TrieNode::Index {
            key,
            child,
            left,
            right,
            ..
        } = self.load_node(&root)?
        else {
            return Err(KernelError::Storage("path node used as index".to_string()));
        };
        if lower.is_none_or(|lower| key.as_str() > lower) {
            self.collect_index_range(left, lower, upper, prefix, target)?;
        }
        if lower.is_none_or(|lower| key.as_str() > lower)
            && upper.is_none_or(|upper| key.as_str() < upper)
        {
            let path = if prefix.is_empty() {
                key.clone()
            } else {
                format!("{prefix}/{key}")
            };
            self.collect_paths(&child, &path, target)?;
        }
        if upper.is_none_or(|upper| key.as_str() < upper) {
            self.collect_index_range(right, lower, upper, prefix, target)?;
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn diff_index_range(
        &self,
        left: Option<String>,
        right: Option<String>,
        lower: Option<&str>,
        upper: Option<&str>,
        prefix: &str,
        added: &mut Vec<String>,
        removed: &mut Vec<String>,
        changed: &mut Vec<String>,
    ) -> Result<(), KernelError> {
        self.check_cancelled()?;
        let left = self.index_root_in_range(left, lower, upper)?;
        let right = self.index_root_in_range(right, lower, upper)?;
        if left == right {
            return Ok(());
        }
        match (&left, &right) {
            (None, Some(_)) => return self.collect_index_range(right, lower, upper, prefix, added),
            (Some(_), None) => {
                return self.collect_index_range(left, lower, upper, prefix, removed)
            }
            (None, None) => return Ok(()),
            _ => {}
        }
        let TrieNode::Index { key: left_key, .. } =
            self.load_node(left.as_deref().expect("range root checked"))?
        else {
            return Err(KernelError::Storage("path node used as index".to_string()));
        };
        let TrieNode::Index { key: right_key, .. } =
            self.load_node(right.as_deref().expect("range root checked"))?
        else {
            return Err(KernelError::Storage("path node used as index".to_string()));
        };
        let pivot = if left_key <= right_key {
            left_key
        } else {
            right_key
        };
        let left_child = self.index_get(left.as_ref(), &pivot)?;
        let right_child = self.index_get(right.as_ref(), &pivot)?;
        self.diff_index_range(
            left.clone(),
            right.clone(),
            lower,
            Some(&pivot),
            prefix,
            added,
            removed,
            changed,
        )?;
        let path = if prefix.is_empty() {
            pivot.clone()
        } else {
            format!("{prefix}/{pivot}")
        };
        match (left_child, right_child) {
            (Some(left_child), Some(right_child)) => {
                self.diff_nodes(&left_child, &right_child, &path, added, removed, changed)?
            }
            (Some(left_child), None) => self.collect_paths(&left_child, &path, removed)?,
            (None, Some(right_child)) => self.collect_paths(&right_child, &path, added)?,
            (None, None) => {}
        }
        self.diff_index_range(
            left,
            right,
            Some(&pivot),
            upper,
            prefix,
            added,
            removed,
            changed,
        )
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
            let derived = match object_path(&self.root, &hash) {
                Ok(path) => path,
                Err(error) => {
                    let message = format!("{hash}: invalid pending object identity: {error}");
                    self.conn.execute(
                        "UPDATE pending_gc_files SET state = 'failed', last_error = ?2 WHERE hash = ?1",
                        params![hash, message],
                    )?;
                    failures.push(message);
                    continue;
                }
            };
            let objects_root = self.root.join("objects");
            if !derived.starts_with(&objects_root) {
                let message = format!("{hash}: pending object path escaped storage root");
                self.conn.execute(
                    "UPDATE pending_gc_files SET state = 'failed', last_error = ?2 WHERE hash = ?1",
                    params![hash, message],
                )?;
                failures.push(message);
                continue;
            }
            if std::env::var_os("PIARIUM_KERNEL_FAIL_GC_DELETE").is_some() {
                let message = format!("{hash}: injected GC cleanup failure");
                self.conn.execute(
                    "UPDATE pending_gc_files SET state = 'failed', last_error = ?2 WHERE hash = ?1",
                    params![hash, message],
                )?;
                failures.push(message);
                continue;
            }
            if Path::new(&raw_path) != derived {
                let message = format!("{hash}: ignored untrusted pending path");
                self.conn.execute(
                    "UPDATE pending_gc_files SET state = 'failed', last_error = ?2 WHERE hash = ?1",
                    params![hash, message],
                )?;
                failures.push(message);
                continue;
            }
            match fs::remove_file(&derived) {
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
        for row in self
            .conn
            .prepare("SELECT root_hash FROM revisions UNION SELECT root_hash FROM pins")?
            .query_map([], |row| row.get::<_, String>(0))?
        {
            roots.insert(row?);
        }
        let mut nodes = BTreeSet::new();
        let mut blobs = BTreeSet::new();
        for root in roots {
            self.check_cancelled()?;
            self.collect_reachable(&root, &mut nodes, &mut blobs)?;
        }
        for row in self
            .conn
            .prepare("SELECT blob_hash FROM object_owners")?
            .query_map([], |row| row.get::<_, String>(0))?
        {
            blobs.insert(row?);
        }
        for row in self
            .conn
            .prepare("SELECT object_hash FROM domain_record_refs")?
            .query_map([], |row| row.get::<_, String>(0))?
        {
            blobs.insert(row?);
        }
        for row in self
            .conn
            .prepare("SELECT object_hash FROM recovery_refs")?
            .query_map([], |row| row.get::<_, String>(0))?
        {
            blobs.insert(row?);
        }
        let stale_root_blobs: Vec<(String, String)> = self
            .conn
            .prepare("SELECT root_hash, blob_hash FROM root_blobs")?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<_, _>>()?;
        for (root_hash, blob_hash) in stale_root_blobs {
            if !nodes.contains(&root_hash) {
                self.conn.execute(
                    "DELETE FROM root_blobs WHERE root_hash = ?1 AND blob_hash = ?2",
                    params![root_hash, blob_hash],
                )?;
            }
        }
        let stale_parents: Vec<(String, String)> = self
            .conn
            .prepare("SELECT root_hash, parent_root FROM root_parents")?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<_, _>>()?;
        for (root_hash, parent_root) in stale_parents {
            if !nodes.contains(&root_hash) || !nodes.contains(&parent_root) {
                self.conn.execute(
                    "DELETE FROM root_parents WHERE root_hash = ?1 AND parent_root = ?2",
                    params![root_hash, parent_root],
                )?;
            }
        }
        self.conn.execute(
            "DELETE FROM operation_owners WHERE operation_id IN (SELECT operation_id FROM operations WHERE state != 'committed')",
            [],
        )?;
        self.conn.execute(
            "DELETE FROM object_owners WHERE operation_id IN (SELECT operation_id FROM operations WHERE state != 'committed')",
            [],
        )?;
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
                self.verified_objects.remove(&hash);
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

    fn recovery_workspace(
        &self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<String, KernelError> {
        let workspace_id = params_value
            .get("workspaceId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                KernelError::Operation("recovery workspaceId is required".to_string())
            })?;
        let grant = self.load_grant(grant_id)?;
        if grant.owning_workspace.as_deref() != Some(workspace_id)
            && !grant.capabilities.contains("storage.admin")
        {
            return Err(KernelError::Authorization(
                "recovery workspace does not match actor grant".to_string(),
            ));
        }
        for key in ["sessionId", "threadId", "runId"] {
            let supplied = params_value.get(key).and_then(Value::as_str);
            let expected = match key {
                "sessionId" => grant.session_id.as_deref(),
                "threadId" => grant.thread_id.as_deref(),
                _ => grant.run_id.as_deref(),
            };
            if supplied.is_some() && expected.is_some() && supplied != expected {
                return Err(KernelError::Authorization(format!(
                    "recovery {key} does not match actor grant"
                )));
            }
            if supplied.is_some()
                && expected.is_none()
                && !grant.capabilities.contains("recovery.maintenance")
                && !grant.capabilities.contains("storage.admin")
            {
                return Err(KernelError::Authorization(format!(
                    "recovery {key} requires an actor-bound grant"
                )));
            }
        }
        Ok(workspace_id.to_string())
    }

    fn require_recovery_owner(
        &self,
        grant_id: &str,
        session_id: Option<&str>,
        thread_id: Option<&str>,
        run_id: Option<&str>,
    ) -> Result<(), KernelError> {
        let grant = self.load_grant(grant_id)?;
        if grant.capabilities.contains("recovery.maintenance")
            || grant.capabilities.contains("storage.admin")
        {
            return Ok(());
        }
        let identities = [
            ("sessionId", session_id, grant.session_id.as_deref()),
            ("threadId", thread_id, grant.thread_id.as_deref()),
            ("runId", run_id, grant.run_id.as_deref()),
        ];
        if identities.iter().all(|(_, value, _)| value.is_none()) {
            return Err(KernelError::Authorization(
                "unowned recovery resources require a maintenance grant".to_string(),
            ));
        }
        for (name, resource, actor) in identities {
            if let Some(resource) = resource {
                if actor != Some(resource) {
                    return Err(KernelError::Authorization(format!(
                        "recovery {name} does not match actor grant"
                    )));
                }
            }
        }
        Ok(())
    }

    fn validate_recovery_state(value: &Value, label: &str) -> Result<(), KernelError> {
        let object = value.as_object().ok_or_else(|| {
            KernelError::Operation(format!("{label} must be a recovery state object"))
        })?;
        let kind = object
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation(format!("{label}.kind is required")))?;
        let allowed: &[&str] = match kind {
            "missing" | "unsupported" => &["kind"],
            "directory" => &["kind", "mode"],
            "symlink" => &["kind", "mode", "symlinkTarget"],
            "regular-file" => &["kind", "objectHash", "byteLength", "mode"],
            _ => return Err(KernelError::Operation(format!("{label}.kind is invalid"))),
        };
        if object.keys().any(|key| !allowed.contains(&key.as_str())) {
            return Err(KernelError::Operation(format!(
                "{label} contains unknown fields"
            )));
        }
        if let Some(mode) = object.get("mode") {
            if mode.as_u64().is_none_or(|mode| mode > u32::MAX as u64) {
                return Err(KernelError::Operation(format!("{label}.mode is invalid")));
            }
        }
        match kind {
            "regular-file" => {
                let hash = object
                    .get("objectHash")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if hash.len() != 71
                    || !hash.starts_with("sha256-")
                    || !hash[7..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                {
                    return Err(KernelError::Operation(format!(
                        "{label}.objectHash is invalid"
                    )));
                }
                if object.get("byteLength").and_then(Value::as_u64).is_none() {
                    return Err(KernelError::Operation(format!(
                        "{label}.byteLength is invalid"
                    )));
                }
            }
            "symlink" => {
                if object
                    .get("symlinkTarget")
                    .and_then(Value::as_str)
                    .is_none()
                {
                    return Err(KernelError::Operation(format!(
                        "{label}.symlinkTarget is required"
                    )));
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn recovery_state_hash(value: &Value, label: &str) -> Result<Option<String>, KernelError> {
        Self::validate_recovery_state(value, label)?;
        Ok(value
            .get("objectHash")
            .and_then(Value::as_str)
            .map(str::to_string))
    }

    fn require_recovery_state_reference(
        state: &Value,
        label: &str,
        references: &[(String, String, Option<String>)],
    ) -> Result<(), KernelError> {
        if let Some(hash) = Self::recovery_state_hash(state, label)? {
            if !references
                .iter()
                .any(|(_, reference_hash, _)| reference_hash == &hash)
            {
                return Err(KernelError::Operation(format!(
                    "{label} content is missing its durable reference"
                )));
            }
        }
        Ok(())
    }

    fn recovery_json_object(params_value: &Value, field: &str) -> Result<Value, KernelError> {
        let raw = params_value
            .get(field)
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation(format!("{field} is required")))?;
        let value = serde_json::from_str::<Value>(raw)
            .map_err(|error| KernelError::Operation(format!("{field} is malformed: {error}")))?;
        if !value.is_object() {
            return Err(KernelError::Operation(format!(
                "{field} must contain an object"
            )));
        }
        if let Some(kind) = value.get("kind").and_then(Value::as_str) {
            match kind {
                "missing" | "unsupported" | "directory" => {}
                "symlink" => {
                    if value.get("symlinkTarget").and_then(Value::as_str).is_none() {
                        return Err(KernelError::Operation(format!(
                            "{field} symlinkTarget is required"
                        )));
                    }
                }
                "regular-file" => {
                    let hash = value
                        .get("objectHash")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let byte_length = value.get("byteLength").and_then(Value::as_i64);
                    if !hash.starts_with("sha256-") || byte_length.is_none_or(|length| length < 0) {
                        return Err(KernelError::Operation(format!(
                            "{field} regular-file state is malformed"
                        )));
                    }
                }
                _ => {
                    return Err(KernelError::Operation(format!(
                        "{field} kind is unsupported"
                    )))
                }
            }
        }
        Ok(value)
    }

    fn recovery_references(
        &self,
        params_value: &Value,
        workspace_id: &str,
        grant_id: &str,
    ) -> Result<Vec<(String, String, Option<String>)>, KernelError> {
        let references = params_value
            .get("references")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                KernelError::Operation("recovery references are required".to_string())
            })?;
        let mut slots = BTreeSet::new();
        let mut result = Vec::with_capacity(references.len());
        for reference in references {
            let slot = reference
                .get("slot")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    KernelError::Operation("recovery reference slot is malformed".to_string())
                })?;
            if !slots.insert(slot.to_string()) {
                return Err(KernelError::Operation(
                    "recovery reference slots must be unique".to_string(),
                ));
            }
            let hash = reference
                .get("objectHash")
                .and_then(Value::as_str)
                .filter(|value| value.starts_with("sha256-") && value.len() == 71)
                .ok_or_else(|| {
                    KernelError::Operation("recovery reference objectHash is malformed".to_string())
                })?;
            let owner_id = reference
                .get("ownerId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty());
            if let Some(owner_id) = owner_id {
                let owned_hash: Option<String> = self
                    .conn
                    .query_row(
                        "SELECT blob_hash FROM object_owners WHERE owner_id = ?1 AND blob_hash = ?2 AND workspace_id = ?3 AND grant_id = ?4",
                        params![owner_id, hash, workspace_id, grant_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if owned_hash.is_none() {
                    return Err(KernelError::Authorization(format!(
                        "recovery owner is not valid: {owner_id}"
                    )));
                }
            } else {
                let durable = self
                    .conn
                    .query_row(
                        "SELECT 1 FROM blobs WHERE hash = ?1 AND (EXISTS (SELECT 1 FROM recovery_refs WHERE object_hash = ?1 AND workspace_id = ?2) OR EXISTS (SELECT 1 FROM domain_record_refs WHERE object_hash = ?1 AND workspace_id = ?2) OR EXISTS (SELECT 1 FROM root_blobs WHERE blob_hash = ?1))",
                        params![hash, workspace_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()?
                    .is_some();
                if !durable {
                    return Err(KernelError::Authorization(
                        "recovery reference must consume an owner or existing durable reference"
                            .to_string(),
                    ));
                }
            }
            result.push((
                slot.to_string(),
                hash.to_string(),
                owner_id.map(str::to_string),
            ));
        }
        Ok(result)
    }

    fn insert_recovery_refs(
        &mut self,
        workspace_id: &str,
        owner_kind: &str,
        owner_id: &str,
        references: &[(String, String, Option<String>)],
        grant_id: &str,
    ) -> Result<(), KernelError> {
        self.conn.execute(
            "DELETE FROM recovery_refs WHERE workspace_id = ?1 AND owner_kind = ?2 AND owner_id = ?3",
            params![workspace_id, owner_kind, owner_id],
        )?;
        let mut consumed = BTreeMap::new();
        for (slot, hash, owner) in references {
            self.conn.execute(
                "INSERT INTO recovery_refs(workspace_id, owner_kind, owner_id, slot, object_hash) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![workspace_id, owner_kind, owner_id, slot, hash],
            )?;
            if let Some(owner) = owner {
                consumed.insert(owner.clone(), hash.clone());
            }
        }
        self.consume_object_owners(workspace_id, grant_id, &consumed)
    }

    fn recovery_checkpoint_value(
        &self,
        workspace_id: &str,
        id: &str,
    ) -> Result<Option<Value>, KernelError> {
        let row: Option<(String, String, i64, String, String, String, Option<String>, Option<String>, Option<String>, Option<String>, i64, i64, i64)> = self.conn.query_row(
            "SELECT id, workspace_id, sequence, source, state, created_at, label, session_id, entry_id, execution_id, changed_path_count, byte_length, revision FROM recovery_checkpoints WHERE workspace_id = ?1 AND id = ?2",
            params![workspace_id, id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?, row.get(10)?, row.get(11)?, row.get(12)?)),
        ).optional()?;
        Ok(row.map(|(id, workspace_id, sequence, source, state, created_at, label, session_id, entry_id, execution_id, changed_path_count, byte_length, revision)| json!({
            "id": id, "workspaceId": workspace_id, "sequence": sequence, "source": source, "state": state, "createdAt": created_at,
            "label": label, "sessionId": session_id, "entryId": entry_id, "executionId": execution_id,
            "changedPathCount": changed_path_count, "byteLength": byte_length, "revision": revision,
        })))
    }

    fn recovery_turn_value(
        &self,
        workspace_id: &str,
        execution_id: &str,
    ) -> Result<Option<Value>, KernelError> {
        let row: Option<(String, String, String, i64, String, String, String, Option<String>, String, String, String, String, String, String, Option<String>, String, Option<String>, i64)> = self.conn.query_row(
            "SELECT execution_id, workspace_id, runtime_key, runtime_generation, worker_id, session_id, user_entry_id, assistant_entry_id, checkpoint_id, active_writer_scopes_json, provenance, status, observed_resource_ids_json, unrecorded_resource_ids_json, failure_json, started_at, settled_at, revision FROM recovery_turns WHERE workspace_id = ?1 AND execution_id = ?2",
            params![workspace_id, execution_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?, row.get(10)?, row.get(11)?, row.get(12)?, row.get(13)?, row.get(14)?, row.get(15)?, row.get(16)?, row.get(17)?)),
        ).optional()?;
        let Some((
            execution_id,
            workspace_id,
            runtime_key,
            runtime_generation,
            worker_id,
            session_id,
            user_entry_id,
            assistant_entry_id,
            checkpoint_id,
            active_writer_scopes_json,
            provenance,
            status,
            observed_resource_ids_json,
            unrecorded_resource_ids_json,
            failure_json,
            started_at,
            settled_at,
            revision,
        )) = row
        else {
            return Ok(None);
        };
        Ok(Some(json!({
            "executionId": execution_id, "workspaceId": workspace_id, "runtimeKey": runtime_key, "runtimeGeneration": runtime_generation,
            "workerId": worker_id, "sessionId": session_id, "userEntryId": user_entry_id, "assistantEntryId": assistant_entry_id,
            "checkpointId": checkpoint_id, "activeWriterScopes": serde_json::from_str::<Value>(&active_writer_scopes_json)?, "provenance": provenance,
            "status": status, "observedResourceIds": serde_json::from_str::<Value>(&observed_resource_ids_json)?, "unrecordedResourceIds": serde_json::from_str::<Value>(&unrecorded_resource_ids_json)?,
            "failure": failure_json.and_then(|value| serde_json::from_str::<Value>(&value).ok()), "startedAt": started_at, "settledAt": settled_at, "revision": revision,
        })))
    }

    fn recovery_turn_start(
        &mut self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.recovery_workspace(params_value, grant_id)?;
        let execution_id = params_value
            .get("executionId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("executionId is required".to_string()))?;
        let session_id = params_value
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("sessionId is required".to_string()))?;
        let operation_id = params_value
            .get("operationId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("operationId is required".to_string()))?;
        let identity_hash = hash_json(params_value)?;
        if let Some(existing) =
            self.operation_existing(operation_id, "recovery.turn.start", &identity_hash)?
        {
            return Ok(existing);
        }
        if let Some(existing) = self.recovery_turn_value(&workspace_id, execution_id)? {
            return Ok(existing);
        }
        let now = format!("{}", chrono_like_now());
        let checkpoint_id = format!("recovery.checkpoint:{workspace_id}:{execution_id}");
        let sequence: i64 = self.conn.query_row("SELECT COALESCE(MAX(sequence), 0) + 1 FROM recovery_checkpoints WHERE workspace_id = ?1", params![workspace_id], |row| row.get(0))?;
        let active = serde_json::to_string(
            &params_value
                .get("activeWriterScopes")
                .cloned()
                .unwrap_or_else(|| json!([])),
        )?;
        let runtime_generation = params_value
            .get("runtimeGeneration")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let runtime_key = format!(
            "{}@{}",
            params_value
                .get("workerId")
                .and_then(Value::as_str)
                .unwrap_or(""),
            runtime_generation
        );
        let status = if params_value
            .get("failure")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            "incomplete"
        } else {
            "pending"
        };
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| {
            self.operation_begin(operation_id, "recovery.turn.start", &identity_hash)?;
            self.record_operation_workspace(operation_id, Some(&workspace_id))?;
            recovery_fault("turn-intent")?;
            self.conn.execute("INSERT INTO recovery_checkpoints(id, workspace_id, sequence, source, state, created_at, session_id, entry_id, execution_id, revision) VALUES (?1, ?2, ?3, 'turn', ?4, ?5, ?6, ?7, ?8, 1)", params![checkpoint_id, workspace_id, sequence, status, now, session_id, params_value.get("userEntryId").and_then(Value::as_str), execution_id])?;
            self.conn.execute("INSERT INTO recovery_turns(execution_id, workspace_id, runtime_key, runtime_generation, worker_id, session_id, user_entry_id, checkpoint_id, active_writer_scopes_json, provenance, status, observed_resource_ids_json, unrecorded_resource_ids_json, started_at, revision) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, '[]', '[]', ?12, 1)", params![execution_id, workspace_id, runtime_key, runtime_generation, params_value.get("workerId").and_then(Value::as_str).unwrap_or(""), session_id, params_value.get("userEntryId").and_then(Value::as_str).unwrap_or(""), checkpoint_id, active, params_value.get("provenance").and_then(Value::as_str).unwrap_or("caused-by"), status, now])?;
            let value = self
                .recovery_turn_value(&workspace_id, execution_id)?
                .ok_or_else(|| {
                    KernelError::Storage("recovery turn disappeared after commit".to_string())
                })?;
            self.operation_finish(operation_id, &value)?;
            Ok(value)
        })();
        match result {
            Ok(value) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(value)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    fn recovery_turn_get(
        &self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.recovery_workspace(params_value, grant_id)?;
        let execution_id = params_value
            .get("executionId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("executionId is required".to_string()))?;
        Ok(self
            .recovery_turn_value(&workspace_id, execution_id)?
            .unwrap_or(Value::Null))
    }

    fn recovery_turn_settle(
        &mut self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.recovery_workspace(params_value, grant_id)?;
        let execution_id = params_value
            .get("executionId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("executionId is required".to_string()))?;
        let operation_id = params_value
            .get("operationId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("operationId is required".to_string()))?;
        let identity_hash = hash_json(params_value)?;
        if let Some(existing) =
            self.operation_existing(operation_id, "recovery.turn.settle", &identity_hash)?
        {
            return Ok(existing);
        }
        let expected = params_value
            .get("expectedRevision")
            .and_then(Value::as_i64)
            .ok_or_else(|| KernelError::Operation("expectedRevision is required".to_string()))?;
        let current: Option<(i64, String, String)> = self.conn.query_row("SELECT revision, checkpoint_id, status FROM recovery_turns WHERE workspace_id = ?1 AND execution_id = ?2", params![workspace_id, execution_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional()?;
        let Some((revision, checkpoint_id, _)) = current else {
            return Err(KernelError::Operation(
                "recovery turn not found".to_string(),
            ));
        };
        if revision != expected {
            return Err(KernelError::Operation(
                "recovery turn revision conflict".to_string(),
            ));
        }
        let status = params_value
            .get("status")
            .and_then(Value::as_str)
            .filter(|value| matches!(*value, "pending" | "ready" | "incomplete" | "failed"))
            .ok_or_else(|| KernelError::Operation("recovery turn status is invalid".to_string()))?;
        let observed = serde_json::to_string(
            &params_value
                .get("observedResourceIds")
                .cloned()
                .unwrap_or_else(|| json!([])),
        )?;
        let failure = params_value.get("failureJson").and_then(Value::as_str);
        let now = format!("{}", chrono_like_now());
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| {
            self.operation_begin(operation_id, "recovery.turn.settle", &identity_hash)?;
            self.record_operation_workspace(operation_id, Some(&workspace_id))?;
            self.conn.execute("UPDATE recovery_turns SET assistant_entry_id = ?1, status = ?2, observed_resource_ids_json = ?3, failure_json = ?4, settled_at = ?5, revision = revision + 1 WHERE workspace_id = ?6 AND execution_id = ?7 AND revision = ?8", params![params_value.get("assistantEntryId").and_then(Value::as_str), status, observed, failure, now, workspace_id, execution_id, expected])?;
            self.conn.execute("UPDATE recovery_checkpoints SET state = ?1, revision = revision + 1 WHERE workspace_id = ?2 AND id = ?3", params![status, workspace_id, checkpoint_id])?;
            let value = self
                .recovery_turn_value(&workspace_id, execution_id)?
                .ok_or_else(|| {
                    KernelError::Storage("recovery turn disappeared after settle".to_string())
                })?;
            self.operation_finish(operation_id, &value)?;
            Ok(value)
        })();
        match result {
            Ok(value) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(value)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    fn recovery_checkpoint_create(
        &mut self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.recovery_workspace(params_value, grant_id)?;
        let label = params_value
            .get("label")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("checkpoint label is required".to_string()))?;
        let operation_id = params_value
            .get("operationId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("operationId is required".to_string()))?;
        let identity_hash = hash_json(params_value)?;
        if let Some(existing) =
            self.operation_existing(operation_id, "recovery.checkpoint.create", &identity_hash)?
        {
            return Ok(existing);
        }
        let id = format!(
            "recovery.checkpoint:{workspace_id}:named:{}",
            Uuid::new_v4()
        );
        let sequence: i64 = self.conn.query_row("SELECT COALESCE(MAX(sequence), 0) + 1 FROM recovery_checkpoints WHERE workspace_id = ?1", params![workspace_id], |row| row.get(0))?;
        let now = format!("{}", chrono_like_now());
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| {
            self.operation_begin(operation_id, "recovery.checkpoint.create", &identity_hash)?;
            self.record_operation_workspace(operation_id, Some(&workspace_id))?;
            self.conn.execute("INSERT INTO recovery_checkpoints(id, workspace_id, sequence, source, state, created_at, label, revision) VALUES (?1, ?2, ?3, 'named', 'ready', ?4, ?5, 1)", params![id, workspace_id, sequence, now, label])?;
            let value = self
                .recovery_checkpoint_value(&workspace_id, &id)?
                .ok_or_else(|| {
                    KernelError::Storage("checkpoint disappeared after commit".to_string())
                })?;
            self.operation_finish(operation_id, &value)?;
            Ok(value)
        })();
        match result {
            Ok(value) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(value)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    fn recovery_checkpoint_list(
        &self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.recovery_workspace(params_value, grant_id)?;
        let cursor = params_value
            .get("cursor")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let page_size = params_value
            .get("pageSize")
            .and_then(Value::as_i64)
            .unwrap_or(128);
        if page_size <= 0 {
            return Err(KernelError::Operation(
                "pageSize must be positive".to_string(),
            ));
        }
        let rows: Vec<String> = self.conn.prepare("SELECT id FROM recovery_checkpoints WHERE workspace_id = ?1 AND sequence < ?2 ORDER BY sequence DESC LIMIT ?3")?.query_map(params![workspace_id, if cursor > 0 { cursor } else { i64::MAX }, page_size + 1], |row| row.get(0))?.collect::<Result<_, _>>()?;
        let has_more = rows.len() as i64 > page_size;
        let ids = rows
            .into_iter()
            .take(page_size as usize)
            .collect::<Vec<_>>();
        let mut checkpoints = Vec::new();
        for id in ids {
            if let Some(value) = self.recovery_checkpoint_value(&workspace_id, &id)? {
                checkpoints.push(value);
            }
        }
        let next_cursor = checkpoints
            .last()
            .and_then(|value| value.get("sequence").and_then(Value::as_i64))
            .filter(|_| has_more);
        Ok(json!({"checkpoints": checkpoints, "nextCursor": next_cursor}))
    }

    fn recovery_entry_resolve(
        &self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.recovery_workspace(params_value, grant_id)?;
        let session_id = params_value
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("sessionId is required".to_string()))?;
        let entry_id = params_value
            .get("entryId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("entryId is required".to_string()))?;
        let row: Option<(String, String, String)> = self.conn.query_row("SELECT execution_id, checkpoint_id, status FROM recovery_turns WHERE workspace_id = ?1 AND session_id = ?2 AND (user_entry_id = ?3 OR assistant_entry_id = ?3) ORDER BY started_at DESC LIMIT 1", params![workspace_id, session_id, entry_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional()?;
        let Some((execution_id, checkpoint_id, status)) = row else {
            return Ok(json!({"status": "unbound", "reason": "entry-unbound"}));
        };
        let checkpoint = self
            .recovery_checkpoint_value(&workspace_id, &checkpoint_id)?
            .unwrap_or(Value::Null);
        if status != "ready" || checkpoint.get("state").and_then(Value::as_str) != Some("ready") {
            return Ok(
                json!({"status": "incomplete", "reason": "checkpoint-incomplete", "executionId": execution_id, "checkpoint": checkpoint}),
            );
        }
        Ok(
            json!({"status": "ready", "executionId": execution_id, "checkpoint": checkpoint, "position": "before"}),
        )
    }

    fn recovery_change_before(
        &mut self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.recovery_workspace(params_value, grant_id)?;
        let before = Self::recovery_json_object(params_value, "beforeJson")?;
        Self::validate_recovery_state(&before, "beforeJson")?;
        let checkpoint_id = params_value
            .get("checkpointId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("checkpointId is required".to_string()))?;
        let execution_id = params_value
            .get("executionId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("executionId is required".to_string()))?;
        let session_id = params_value
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("sessionId is required".to_string()))?;
        let raw_path = params_value
            .get("path")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                KernelError::Operation("recovery change path is required".to_string())
            })?;
        let path = Self::validate_path(raw_path)?.join("/");
        let turn: Option<(String, String)> = self.conn.query_row(
            "SELECT checkpoint_id, session_id FROM recovery_turns WHERE workspace_id = ?1 AND execution_id = ?2",
            params![workspace_id, execution_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        let Some((turn_checkpoint, turn_session)) = turn else {
            return Err(KernelError::Operation(
                "recovery turn is not found".to_string(),
            ));
        };
        if turn_checkpoint != checkpoint_id || turn_session != session_id {
            return Err(KernelError::Authorization(
                "recovery change does not belong to the actor turn".to_string(),
            ));
        }
        self.require_recovery_owner(grant_id, Some(session_id), None, None)?;
        let references = self.recovery_references(params_value, &workspace_id, grant_id)?;
        Self::require_recovery_state_reference(&before, "beforeJson", &references)?;
        let now = format!("{}", chrono_like_now());
        let existing: Option<(i64, String, String, String)> = self.conn.query_row("SELECT revision, execution_id, mutation_id, before_json FROM recovery_changes WHERE workspace_id = ?1 AND checkpoint_id = ?2 AND path = ?3", params![workspace_id, checkpoint_id, path], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).optional()?;
        if let Some((_, stored_execution, stored_mutation, stored_before)) = &existing {
            if stored_execution != execution_id
                || stored_mutation
                    != params_value
                        .get("mutationId")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                || serde_json::from_str::<Value>(stored_before)? != before
            {
                return Err(KernelError::Operation(
                    "recovery change identity was reused with different input".to_string(),
                ));
            }
        } else {
            self.conn.execute("INSERT INTO recovery_changes(workspace_id, checkpoint_id, path, execution_id, tool_name, mutation_id, before_json, state, created_at, updated_at, revision) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'before', ?8, ?8, 1)", params![workspace_id, checkpoint_id, path, execution_id, params_value.get("toolName").and_then(Value::as_str).unwrap_or(""), params_value.get("mutationId").and_then(Value::as_str).unwrap_or(""), serde_json::to_string(&before)?, now])?;
        }
        self.insert_recovery_refs(
            &workspace_id,
            "change",
            &format!("change:{checkpoint_id}:{path}"),
            &references,
            grant_id,
        )?;
        Ok(
            json!({"workspaceId": workspace_id, "checkpointId": checkpoint_id, "path": path, "revision": existing.map(|value| value.0).unwrap_or(1), "recorded": true}),
        )
    }

    fn recovery_change_get(
        &self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.recovery_workspace(params_value, grant_id)?;
        let checkpoint_id = params_value
            .get("checkpointId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("checkpointId is required".to_string()))?;
        let raw_path = params_value
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                KernelError::Operation("recovery change path is required".to_string())
            })?;
        let path = Self::validate_path(raw_path)?.join("/");
        let row: Option<(String, String, String, String, Option<String>, String, i64)> = self.conn.query_row("SELECT path, before_json, state, execution_id, after_json, updated_at, revision FROM recovery_changes WHERE workspace_id = ?1 AND checkpoint_id = ?2 AND path = ?3", params![workspace_id, checkpoint_id, path], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?))).optional()?;
        let Some((path, before_json, state, execution_id, after_json, updated_at, revision)) = row
        else {
            return Ok(Value::Null);
        };
        let session_id: Option<String> = self.conn.query_row(
            "SELECT session_id FROM recovery_turns WHERE workspace_id = ?1 AND execution_id = ?2 AND checkpoint_id = ?3",
            params![workspace_id, execution_id, checkpoint_id],
            |row| row.get(0),
        ).optional()?;
        self.require_recovery_owner(grant_id, session_id.as_deref(), None, None)?;
        Ok(
            json!({"workspaceId": workspace_id, "checkpointId": checkpoint_id, "path": path, "executionId": execution_id, "before": serde_json::from_str::<Value>(&before_json)?, "after": after_json.and_then(|value| serde_json::from_str::<Value>(&value).ok()), "state": state, "updatedAt": updated_at, "revision": revision}),
        )
    }

    fn recovery_change_after(
        &mut self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.recovery_workspace(params_value, grant_id)?;
        let after = Self::recovery_json_object(params_value, "afterJson")?;
        Self::validate_recovery_state(&after, "afterJson")?;
        let checkpoint_id = params_value
            .get("checkpointId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("checkpointId is required".to_string()))?;
        let execution_id = params_value
            .get("executionId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("executionId is required".to_string()))?;
        let session_id = params_value
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("sessionId is required".to_string()))?;
        let raw_path = params_value
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                KernelError::Operation("recovery change path is required".to_string())
            })?;
        let path = Self::validate_path(raw_path)?.join("/");
        let expected = params_value
            .get("expectedRevision")
            .and_then(Value::as_i64)
            .ok_or_else(|| KernelError::Operation("expectedRevision is required".to_string()))?;
        let current: Option<(i64, String, String)> = self.conn.query_row("SELECT revision, before_json, execution_id FROM recovery_changes WHERE workspace_id = ?1 AND checkpoint_id = ?2 AND path = ?3", params![workspace_id, checkpoint_id, path], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional()?;
        let Some((revision, before_json, stored_execution)) = current else {
            return Err(KernelError::Operation(
                "recovery before-image is missing".to_string(),
            ));
        };
        let turn_session: Option<String> = self.conn.query_row("SELECT session_id FROM recovery_turns WHERE workspace_id = ?1 AND execution_id = ?2 AND checkpoint_id = ?3", params![workspace_id, execution_id, checkpoint_id], |row| row.get(0)).optional()?;
        if stored_execution != execution_id || turn_session.as_deref() != Some(session_id) {
            return Err(KernelError::Authorization(
                "recovery change does not belong to the actor turn".to_string(),
            ));
        }
        self.require_recovery_owner(grant_id, Some(session_id), None, None)?;
        if revision != expected {
            return Err(KernelError::Operation(
                "recovery change revision conflict".to_string(),
            ));
        }
        let references = self.recovery_references(params_value, &workspace_id, grant_id)?;
        let now = format!("{}", chrono_like_now());
        let before_value = serde_json::from_str::<Value>(&before_json)?;
        if before_value == after {
            self.conn.execute("DELETE FROM recovery_refs WHERE workspace_id = ?1 AND owner_kind = 'change' AND owner_id = ?2", params![workspace_id, format!("change:{checkpoint_id}:{path}")])?;
            self.conn.execute("DELETE FROM recovery_changes WHERE workspace_id = ?1 AND checkpoint_id = ?2 AND path = ?3 AND revision = ?4", params![workspace_id, checkpoint_id, path, expected])?;
            return Ok(
                json!({"workspaceId": workspace_id, "checkpointId": checkpoint_id, "path": path, "released": true, "revision": expected}),
            );
        }
        Self::require_recovery_state_reference(&after, "afterJson", &references)?;
        self.conn.execute("UPDATE recovery_changes SET after_json = ?1, state = ?2, updated_at = ?3, revision = revision + 1 WHERE workspace_id = ?4 AND checkpoint_id = ?5 AND path = ?6 AND revision = ?7", params![serde_json::to_string(&after)?, if params_value.get("succeeded").and_then(Value::as_bool).unwrap_or(false) { "after" } else { "failed" }, now, workspace_id, checkpoint_id, path, expected])?;
        self.insert_recovery_refs(
            &workspace_id,
            "change",
            &format!("change:{checkpoint_id}:{path}"),
            &references,
            grant_id,
        )?;
        Ok(
            json!({"workspaceId": workspace_id, "checkpointId": checkpoint_id, "path": path, "before": before_value, "after": after, "revision": expected + 1}),
        )
    }

    fn recovery_operation_create(
        &mut self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.recovery_workspace(params_value, grant_id)?;
        let operation_id = params_value
            .get("operationId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("operationId is required".to_string()))?;
        let kind = params_value
            .get("kind")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("operation kind is required".to_string()))?;
        let state = params_value
            .get("state")
            .and_then(Value::as_str)
            .filter(|value| {
                matches!(
                    *value,
                    "planned"
                        | "applying"
                        | "applying-files"
                        | "complete"
                        | "aborted"
                        | "compensated"
                        | "needs-attention"
                        | "undone"
                        | "awaiting-surface"
                )
            })
            .ok_or_else(|| KernelError::Operation("operation state is invalid".to_string()))?;
        let session_id = params_value.get("sessionId").and_then(Value::as_str);
        let thread_id = params_value.get("threadId").and_then(Value::as_str);
        let run_id = params_value.get("runId").and_then(Value::as_str);
        self.require_recovery_owner(grant_id, session_id, thread_id, run_id)?;
        let data = Self::recovery_json_object(params_value, "dataJson")?;
        let files = params_value
            .get("files")
            .and_then(Value::as_array)
            .ok_or_else(|| KernelError::Operation("operation files are required".to_string()))?;
        let mut paths = BTreeSet::new();
        let now = format!("{}", chrono_like_now());
        let identity_hash = hash_json(params_value)?;
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| {
            if let Some(existing_result) =
                self.operation_existing(operation_id, "recovery.operation.create", &identity_hash)?
            {
                return Ok(existing_result);
            }
            let existing: Option<(i64, String, String)> = self.conn.query_row("SELECT revision, state, data_json FROM recovery_operations WHERE workspace_id = ?1 AND operation_id = ?2", params![workspace_id, operation_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional()?;
            if let Some(existing) = existing {
                return Ok(
                    json!({"operationId": operation_id, "workspaceId": workspace_id, "state": existing.1, "revision": existing.0, "data": serde_json::from_str::<Value>(&existing.2)?, "files": []}),
                );
            }
            self.operation_begin(operation_id, "recovery.operation.create", &identity_hash)?;
            self.record_operation_workspace(operation_id, Some(&workspace_id))?;
            self.conn.execute("INSERT INTO recovery_operations(operation_id, workspace_id, kind, state, session_id, thread_id, run_id, data_json, created_at, updated_at, revision) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, 1)", params![operation_id, workspace_id, kind, state, session_id, thread_id, run_id, serde_json::to_string(&data)?, now])?;
            recovery_fault("operation-before-files")?;
            for (ordinal, file) in files.iter().enumerate() {
                let raw_path = file
                    .get("path")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        KernelError::Operation("operation file path is required".to_string())
                    })?;
                let path = Self::validate_path(raw_path)?.join("/");
                if !paths.insert(path.to_string()) {
                    return Err(KernelError::Operation(
                        "operation file paths must be unique".to_string(),
                    ));
                }
                let refs = file.get("references").cloned().unwrap_or_else(|| json!([]));
                let refs_params = json!({"references": refs});
                let normalized = self.recovery_references(&refs_params, &workspace_id, grant_id)?;
                for field in ["expectedJson", "targetJson", "safetyJson"] {
                    if let Some(raw) = file.get(field).and_then(Value::as_str) {
                        let value = serde_json::from_str::<Value>(raw)?;
                        Self::require_recovery_state_reference(&value, field, &normalized)?;
                    }
                }
                let phase = file
                    .get("phase")
                    .and_then(Value::as_str)
                    .unwrap_or("pending");
                if !matches!(
                    phase,
                    "pending"
                        | "apply-intent"
                        | "target-observed"
                        | "compensate-intent"
                        | "safety-observed"
                        | "needs-attention"
                        | "external-intent"
                        | "external-dispatched"
                        | "external-target-observed"
                        | "external-compensate-intent"
                        | "external-safety-observed"
                ) {
                    return Err(KernelError::Operation(
                        "operation file phase is invalid".to_string(),
                    ));
                }
                self.conn.execute("INSERT INTO recovery_operation_files(workspace_id, operation_id, ordinal, path, expected_json, target_json, safety_json, phase, revision, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9)", params![workspace_id, operation_id, ordinal as i64, path, file.get("expectedJson").and_then(Value::as_str), file.get("targetJson").and_then(Value::as_str), file.get("safetyJson").and_then(Value::as_str), phase, now])?;
                self.insert_recovery_refs(
                    &workspace_id,
                    "operation-file",
                    &format!("operation-file:{operation_id}:{path}"),
                    &normalized,
                    grant_id,
                )?;
            }
            recovery_fault("operation-before-finish")?;
            let result = json!({"operationId": operation_id, "workspaceId": workspace_id, "kind": kind, "state": state, "revision": 1, "data": data, "files": files});
            self.operation_finish(operation_id, &result)?;
            Ok(result)
        })();
        match result {
            Ok(value) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(value)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    fn recovery_operation_file_cas(
        &mut self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.recovery_workspace(params_value, grant_id)?;
        let operation_id = params_value
            .get("operationId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("operationId is required".to_string()))?;
        let raw_path = params_value
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("operation file path is required".to_string()))?;
        let path = Self::validate_path(raw_path)?.join("/");
        let expected = params_value
            .get("expectedRevision")
            .and_then(Value::as_i64)
            .ok_or_else(|| KernelError::Operation("expectedRevision is required".to_string()))?;
        let expected_phase = params_value
            .get("expectedPhase")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("expectedPhase is required".to_string()))?;
        let phase = params_value
            .get("phase")
            .and_then(Value::as_str)
            .filter(|value| {
                matches!(
                    *value,
                    "pending"
                        | "apply-intent"
                        | "target-observed"
                        | "compensate-intent"
                        | "safety-observed"
                        | "needs-attention"
                        | "external-intent"
                        | "external-dispatched"
                        | "external-target-observed"
                        | "external-compensate-intent"
                        | "external-safety-observed"
                )
            })
            .ok_or_else(|| KernelError::Operation("operation file phase is invalid".to_string()))?;
        let owner: Option<(Option<String>, Option<String>, Option<String>)> = self.conn.query_row(
            "SELECT session_id, thread_id, run_id FROM recovery_operations WHERE workspace_id = ?1 AND operation_id = ?2",
            params![workspace_id, operation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?;
        let Some((session_id, thread_id, run_id)) = owner else {
            return Err(KernelError::Operation(
                "recovery operation is not found".to_string(),
            ));
        };
        self.require_recovery_owner(
            grant_id,
            session_id.as_deref(),
            thread_id.as_deref(),
            run_id.as_deref(),
        )?;
        let current: Option<(i64, String)> = self.conn.query_row("SELECT revision, phase FROM recovery_operation_files WHERE workspace_id = ?1 AND operation_id = ?2 AND path = ?3", params![workspace_id, operation_id, path], |row| Ok((row.get(0)?, row.get(1)?))).optional()?;
        let Some((revision, current_phase)) = current else {
            return Err(KernelError::Operation(
                "operation file is not found".to_string(),
            ));
        };
        if revision != expected || current_phase != expected_phase {
            return Err(KernelError::Operation(
                "operation file phase conflict".to_string(),
            ));
        }
        let normalized = params_value
            .get("references")
            .map(|refs| {
                self.recovery_references(&json!({"references": refs}), &workspace_id, grant_id)
            })
            .transpose()?;
        for field in ["expectedJson", "targetJson", "safetyJson"] {
            if let Some(raw) = params_value.get(field).and_then(Value::as_str) {
                let value = serde_json::from_str::<Value>(raw)?;
                let refs = normalized.as_ref().ok_or_else(|| {
                    KernelError::Operation(format!("{field} update requires references"))
                })?;
                Self::require_recovery_state_reference(&value, field, refs)?;
            }
        }
        recovery_fault("file-phase-cas")?;
        let changed = self.conn.execute("UPDATE recovery_operation_files SET phase = ?1, observed_fingerprint = COALESCE(?2, observed_fingerprint), expected_json = COALESCE(?3, expected_json), target_json = COALESCE(?4, target_json), safety_json = COALESCE(?5, safety_json), revision = revision + 1, updated_at = ?6 WHERE workspace_id = ?7 AND operation_id = ?8 AND path = ?9 AND revision = ?10 AND phase = ?11", params![phase, params_value.get("observedFingerprint").and_then(Value::as_str), params_value.get("expectedJson").and_then(Value::as_str), params_value.get("targetJson").and_then(Value::as_str), params_value.get("safetyJson").and_then(Value::as_str), chrono_like_now(), workspace_id, operation_id, path, expected, expected_phase])?;
        if changed != 1 {
            return Err(KernelError::Operation(
                "operation file phase conflict".to_string(),
            ));
        }
        if let Some(normalized) = normalized {
            self.insert_recovery_refs(
                &workspace_id,
                "operation-file",
                &format!("operation-file:{operation_id}:{path}"),
                &normalized,
                grant_id,
            )?;
        }
        Ok(
            json!({"operationId": operation_id, "workspaceId": workspace_id, "path": path, "phase": phase, "revision": expected + 1}),
        )
    }

    fn recovery_operation_complete(
        &mut self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.recovery_workspace(params_value, grant_id)?;
        let operation_id = params_value
            .get("operationId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("operationId is required".to_string()))?;
        let expected = params_value
            .get("expectedRevision")
            .and_then(Value::as_i64)
            .ok_or_else(|| KernelError::Operation("expectedRevision is required".to_string()))?;
        let state = params_value
            .get("state")
            .and_then(Value::as_str)
            .filter(|value| {
                matches!(
                    *value,
                    "complete" | "aborted" | "compensated" | "undone" | "needs-attention"
                )
            })
            .ok_or_else(|| {
                KernelError::Operation("terminal operation state is invalid".to_string())
            })?;
        let owner: Option<(Option<String>, Option<String>, Option<String>)> = self.conn.query_row(
            "SELECT session_id, thread_id, run_id FROM recovery_operations WHERE workspace_id = ?1 AND operation_id = ?2",
            params![workspace_id, operation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?;
        let Some((session_id, thread_id, run_id)) = owner else {
            return Err(KernelError::Operation(
                "recovery operation is not found".to_string(),
            ));
        };
        self.require_recovery_owner(
            grant_id,
            session_id.as_deref(),
            thread_id.as_deref(),
            run_id.as_deref(),
        )?;
        for field in ["resultJson", "failureJson"] {
            if let Some(raw) = params_value.get(field).and_then(Value::as_str) {
                let value = serde_json::from_str::<Value>(raw)?;
                if !value.is_object() {
                    return Err(KernelError::Operation(format!(
                        "{field} must contain an object"
                    )));
                }
            }
        }
        recovery_fault("operation-complete")?;
        let changed = self.conn.execute("UPDATE recovery_operations SET state = ?1, result_json = ?2, failure_json = ?3, revision = revision + 1, updated_at = ?4 WHERE workspace_id = ?5 AND operation_id = ?6 AND revision = ?7 AND state NOT IN ('complete', 'aborted', 'compensated', 'undone', 'needs-attention')", params![state, params_value.get("resultJson").and_then(Value::as_str), params_value.get("failureJson").and_then(Value::as_str), chrono_like_now(), workspace_id, operation_id, expected])?;
        if changed == 0 {
            return Err(KernelError::Operation(
                "operation terminal state conflict".to_string(),
            ));
        }
        Ok(
            json!({"operationId": operation_id, "workspaceId": workspace_id, "state": state, "revision": expected + 1}),
        )
    }

    fn recovery_operation_list(
        &self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.recovery_workspace(params_value, grant_id)?;
        self.require_recovery_owner(grant_id, None, None, None)?;
        let cursor = params_value
            .get("cursor")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let page_size = params_value
            .get("pageSize")
            .and_then(Value::as_i64)
            .unwrap_or(128);
        if page_size <= 0 {
            return Err(KernelError::Operation(
                "pageSize must be positive".to_string(),
            ));
        }
        let kind = params_value.get("kind").and_then(Value::as_str);
        let (sql, values) = if let Some(kind) = kind {
            ("SELECT operation_id, kind, state, data_json, revision FROM recovery_operations WHERE workspace_id = ?1 AND kind = ?2 ORDER BY created_at DESC LIMIT ?3 OFFSET ?4", vec![Value::String(workspace_id.clone()), Value::String(kind.to_string()), Value::from(page_size + 1), Value::from(cursor)])
        } else {
            ("SELECT operation_id, kind, state, data_json, revision FROM recovery_operations WHERE workspace_id = ?1 ORDER BY created_at DESC LIMIT ?2 OFFSET ?3", vec![Value::String(workspace_id.clone()), Value::from(page_size + 1), Value::from(cursor)])
        };
        let mut statement = self.conn.prepare(sql)?;
        let mut rows = if kind.is_some() {
            statement.query(params![workspace_id, kind.unwrap_or(""), page_size, cursor])?
        } else {
            statement.query(params![workspace_id, page_size, cursor])?
        };
        let mut operations = Vec::new();
        while let Some(row) = rows.next()? {
            let operation_id: String = row.get(0)?;
            operations.push(json!({"operationId": operation_id, "workspaceId": workspace_id, "kind": row.get::<_, String>(1)?, "state": row.get::<_, String>(2)?, "data": serde_json::from_str::<Value>(&row.get::<_, String>(3)?)?, "revision": row.get::<_, i64>(4)?}));
        }
        let _ = values;
        let has_more = operations.len() as i64 > page_size;
        operations.truncate(page_size as usize);
        Ok(
            json!({"operations": operations, "nextCursor": if has_more { Value::from(cursor + page_size) } else { Value::Null }}),
        )
    }

    fn recovery_operation_release(
        &mut self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.recovery_workspace(params_value, grant_id)?;
        let operation_id = params_value
            .get("operationId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("operationId is required".to_string()))?;
        let stored: Option<(String, Option<String>, Option<String>, Option<String>)> = self.conn.query_row("SELECT state, session_id, thread_id, run_id FROM recovery_operations WHERE workspace_id = ?1 AND operation_id = ?2", params![workspace_id, operation_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).optional()?;
        let Some((state, session_id, thread_id, run_id)) = stored else {
            return Ok(json!({"operationId": operation_id, "released": false}));
        };
        self.require_recovery_owner(
            grant_id,
            session_id.as_deref(),
            thread_id.as_deref(),
            run_id.as_deref(),
        )?;
        if !matches!(
            state.as_str(),
            "complete" | "aborted" | "compensated" | "undone"
        ) {
            return Err(KernelError::Operation(
                "only terminal recovery operations can be released".to_string(),
            ));
        }
        self.conn.execute("DELETE FROM recovery_refs WHERE workspace_id = ?1 AND ((owner_kind = 'operation-file' AND owner_id LIKE ?2) OR (owner_kind = 'operation' AND owner_id = ?3))", params![workspace_id, format!("operation-file:{operation_id}:%"), format!("operation:{operation_id}")])?;
        let deleted = self.conn.execute(
            "DELETE FROM recovery_operations WHERE workspace_id = ?1 AND operation_id = ?2",
            params![workspace_id, operation_id],
        )?;
        Ok(json!({"operationId": operation_id, "released": deleted > 0}))
    }

    fn recovery_operation_get(
        &self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.recovery_workspace(params_value, grant_id)?;
        let operation_id = params_value
            .get("operationId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("operationId is required".to_string()))?;
        let typed: Option<(String, String, String, Option<String>, Option<String>, Option<String>, String, Option<String>, Option<String>, i64)> = self.conn.query_row(
            "SELECT kind, state, data_json, session_id, thread_id, run_id, created_at, result_json, failure_json, revision FROM recovery_operations WHERE workspace_id = ?1 AND operation_id = ?2",
            params![workspace_id, operation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?)),
        ).optional()?;
        let Some((
            kind,
            state,
            data_json,
            session_id,
            thread_id,
            run_id,
            created_at,
            result_json,
            failure_json,
            revision,
        )) = typed
        else {
            return Ok(Value::Null);
        };
        self.require_recovery_owner(
            grant_id,
            session_id.as_deref(),
            thread_id.as_deref(),
            run_id.as_deref(),
        )?;
        let mut files = Vec::new();
        let mut files_statement = self.conn.prepare("SELECT path, expected_json, target_json, safety_json, phase, observed_fingerprint, revision FROM recovery_operation_files WHERE workspace_id = ?1 AND operation_id = ?2 ORDER BY ordinal")?;
        let mut rows = files_statement.query(params![workspace_id, operation_id])?;
        while let Some(row) = rows.next()? {
            files.push(json!({
                "path": row.get::<_, String>(0)?,
                "expectedJson": row.get::<_, Option<String>>(1)?,
                "targetJson": row.get::<_, Option<String>>(2)?,
                "safetyJson": row.get::<_, Option<String>>(3)?,
                "phase": row.get::<_, String>(4)?,
                "observedFingerprint": row.get::<_, Option<String>>(5)?,
                "revision": row.get::<_, i64>(6)?,
            }));
        }
        Ok(json!({
            "operationId": operation_id,
            "workspaceId": workspace_id,
            "kind": kind,
            "state": state,
            "sessionId": session_id,
            "threadId": thread_id,
            "runId": run_id,
            "createdAt": created_at,
            "data": serde_json::from_str::<Value>(&data_json)?,
            "result": result_json.map(|value| serde_json::from_str::<Value>(&value)).transpose()?,
            "failure": failure_json.map(|value| serde_json::from_str::<Value>(&value)).transpose()?,
            "revision": revision,
            "files": files,
        }))
    }

    fn validate_domain_record_identity(
        &self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<String, KernelError> {
        let workspace_id = params_value
            .get("workspaceId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("record workspaceId is required".to_string()))?;
        let grant = self.load_grant(grant_id)?;
        if grant.owning_workspace.as_deref() != Some(workspace_id)
            && !grant.capabilities.contains("storage.admin")
        {
            return Err(KernelError::Authorization(
                "record workspace does not match actor grant".to_string(),
            ));
        }
        for key in ["sessionId", "threadId", "runId"] {
            if let Some(value) = params_value.get(key).and_then(Value::as_str) {
                let expected = match key {
                    "sessionId" => grant.session_id.as_deref(),
                    "threadId" => grant.thread_id.as_deref(),
                    _ => grant.run_id.as_deref(),
                };
                if let Some(expected) = expected {
                    if expected != value {
                        return Err(KernelError::Authorization(format!(
                            "record {key} does not match actor grant"
                        )));
                    }
                } else if !grant.capabilities.contains("recovery.maintenance")
                    && !grant.capabilities.contains("storage.maintenance")
                    && !grant.capabilities.contains("storage.admin")
                {
                    return Err(KernelError::Authorization(format!(
                        "record {key} requires an actor-bound grant"
                    )));
                }
            }
        }
        Ok(workspace_id.to_string())
    }

    fn validate_domain_record_payload(
        record_type: &str,
        record_id: &str,
        workspace_id: &str,
        state: &str,
        payload: &Value,
    ) -> Result<(), KernelError> {
        let object = payload.as_object().ok_or_else(|| {
            KernelError::Operation("typed record payload must be an object".to_string())
        })?;
        let same = |field: &str, expected: &str| -> Result<(), KernelError> {
            if let Some(value) = object.get(field).and_then(Value::as_str) {
                if value != expected {
                    return Err(KernelError::Operation(format!(
                        "typed record {field} does not match its identity"
                    )));
                }
            }
            Ok(())
        };
        match record_type {
            "recovery.checkpoint" => {
                same("id", record_id)?;
                same("workspaceId", workspace_id)?;
                if !matches!(state, "pending" | "ready" | "incomplete" | "failed") {
                    return Err(KernelError::Operation(
                        "checkpoint state is invalid".to_string(),
                    ));
                }
                if let Some(sequence) = object.get("sequence") {
                    if sequence.as_i64().is_none_or(|value| value < 0) {
                        return Err(KernelError::Operation(
                            "checkpoint sequence is invalid".to_string(),
                        ));
                    }
                }
            }
            "recovery.turn" => {
                let execution = object
                    .get("executionId")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        KernelError::Operation("turn executionId is required".to_string())
                    })?;
                if record_id != format!("recovery.turn:{execution}") {
                    return Err(KernelError::Operation(
                        "turn recordId is not derived from executionId".to_string(),
                    ));
                }
                same("workspaceId", workspace_id)?;
                if object.get("sessionId").and_then(Value::as_str).is_none()
                    || object.get("checkpointId").and_then(Value::as_str).is_none()
                {
                    return Err(KernelError::Operation(
                        "turn identity is incomplete".to_string(),
                    ));
                }
                if !matches!(state, "pending" | "ready" | "incomplete" | "failed") {
                    return Err(KernelError::Operation("turn state is invalid".to_string()));
                }
            }
            "recovery.change" => {
                if object.get("checkpointId").and_then(Value::as_str).is_none()
                    || object.get("path").and_then(Value::as_str).is_none()
                {
                    return Err(KernelError::Operation(
                        "change identity is incomplete".to_string(),
                    ));
                }
                if object.get("before").is_none() && object.get("beforeJson").is_none() {
                    return Err(KernelError::Operation(
                        "change before state is required".to_string(),
                    ));
                }
            }
            "recovery.operation" => {
                same("id", record_id)?;
                same("workspaceId", workspace_id)?;
                if object.get("kind").and_then(Value::as_str).is_none() {
                    return Err(KernelError::Operation(
                        "operation kind is required".to_string(),
                    ));
                }
            }
            "recovery.operation-file" => {
                if object.get("operationId").and_then(Value::as_str).is_none()
                    || object.get("path").and_then(Value::as_str).is_none()
                {
                    return Err(KernelError::Operation(
                        "operation-file identity is incomplete".to_string(),
                    ));
                }
                if !matches!(
                    state,
                    "pending"
                        | "apply-intent"
                        | "target-observed"
                        | "compensate-intent"
                        | "safety-observed"
                        | "needs-attention"
                        | "external-intent"
                        | "external-dispatched"
                        | "external-safety-observed"
                ) {
                    return Err(KernelError::Operation(
                        "operation-file phase is invalid".to_string(),
                    ));
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn grant_can_access_domain_record(
        &self,
        value: &Value,
        grant_id: &str,
    ) -> Result<bool, KernelError> {
        let grant = self.load_grant(grant_id)?;
        if grant.capabilities.contains("recovery.maintenance")
            || grant.capabilities.contains("storage.maintenance")
            || grant.capabilities.contains("storage.admin")
        {
            return Ok(true);
        }
        for key in ["sessionId", "threadId", "runId"] {
            let record_value = value.get(key).and_then(Value::as_str);
            let grant_value = match key {
                "sessionId" => grant.session_id.as_deref(),
                "threadId" => grant.thread_id.as_deref(),
                _ => grant.run_id.as_deref(),
            };
            if record_value.is_some() && grant_value.is_some() && record_value != grant_value {
                return Ok(false);
            }
            if record_value.is_some()
                && grant_value.is_none()
                && !grant.capabilities.contains("storage.admin")
            {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn domain_record_value(
        &self,
        workspace_id: &str,
        record_id: &str,
    ) -> Result<Option<Value>, KernelError> {
        let row: Option<(
            String,
            String,
            String,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<i64>,
            Option<i64>,
            i64,
            String,
            i64,
            i64,
        )> = self
            .conn
            .query_row(
                "SELECT record_id, workspace_id, record_type, state, session_id, thread_id, run_id, branch_id, revision, result_revision, record_revision, payload_json, created_at, updated_at FROM domain_records WHERE record_id = ?1 AND workspace_id = ?2",
                params![record_id, workspace_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                        row.get(9)?,
                        row.get(10)?,
                        row.get(11)?,
                        row.get(12)?,
                        row.get(13)?,
                    ))
                },
            )
            .optional()?;
        let Some((
            record_id,
            workspace_id,
            record_type,
            state,
            session_id,
            thread_id,
            run_id,
            branch_id,
            revision,
            result_revision,
            record_revision,
            payload_json,
            created_at,
            updated_at,
        )) = row
        else {
            return Ok(None);
        };
        let references = self
            .conn
            .prepare("SELECT slot, object_hash FROM domain_record_refs WHERE record_id = ?1 AND workspace_id = ?2 ORDER BY slot")?
            .query_map(params![record_id, workspace_id], |row| {
                Ok(json!({"slot": row.get::<_, String>(0)?, "objectHash": row.get::<_, String>(1)?}))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let payload = serde_json::from_str::<Value>(&payload_json).map_err(|error| {
            KernelError::Storage(format!("domain record payload is corrupt: {error}"))
        })?;
        Ok(Some(json!({
            "recordId": record_id,
            "workspaceId": workspace_id,
            "recordType": record_type,
            "state": state,
            "sessionId": session_id,
            "threadId": thread_id,
            "runId": run_id,
            "branchId": branch_id,
            "revision": revision,
            "resultRevision": result_revision,
            "recordRevision": record_revision,
            "payloadJson": serde_json::to_string(&payload)?,
            "references": references,
            "createdAt": created_at,
            "updatedAt": updated_at,
        })))
    }

    fn domain_record_put(
        &mut self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.validate_domain_record_identity(params_value, grant_id)?;
        let record_id = params_value
            .get("recordId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("recordId is required".to_string()))?;
        let record_type = params_value
            .get("recordType")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("recordType is required".to_string()))?;
        const KNOWN_RECORD_TYPES: &[&str] = &[
            "working.branch",
            "working.draft",
            "working.result",
            "working.verification.child",
            "working.verification.parent",
            "working.review",
            "retrieval.artifact",
            "retrieval.receipt",
            "retrieval.evidence",
            "recovery.metadata",
            "recovery.checkpoint",
            "recovery.change",
            "recovery.turn",
            "recovery.operation",
            "recovery.operation-file",
        ];
        if !KNOWN_RECORD_TYPES.contains(&record_type)
            && !(record_type.starts_with("retrieval.evidence.")
                && record_type.len() > "retrieval.evidence.".len())
        {
            return Err(KernelError::Operation(format!(
                "recordType is not supported: {record_type}"
            )));
        }
        let state = params_value
            .get("state")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("record state is required".to_string()))?;
        let payload_json = params_value
            .get("payloadJson")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("payloadJson is required".to_string()))?;
        let payload: Value = serde_json::from_str(payload_json).map_err(|error| {
            KernelError::Operation(format!("payloadJson is malformed: {error}"))
        })?;
        if !payload.is_object() {
            return Err(KernelError::Operation(
                "payloadJson must contain an object".to_string(),
            ));
        }
        Self::validate_domain_record_payload(
            record_type,
            record_id,
            &workspace_id,
            state,
            &payload,
        )?;
        let references = params_value
            .get("references")
            .and_then(Value::as_array)
            .ok_or_else(|| KernelError::Operation("record references are required".to_string()))?;
        let owner_ids = params_value
            .get("ownerIds")
            .and_then(Value::as_array)
            .ok_or_else(|| KernelError::Operation("record ownerIds are required".to_string()))?;
        let mut owner_hashes = BTreeMap::new();
        for owner in owner_ids {
            let owner_id = owner
                .as_str()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| KernelError::Operation("record ownerId is malformed".to_string()))?;
            let hash: String = self
                .conn
                .query_row(
                    "SELECT blob_hash FROM object_owners WHERE owner_id = ?1 AND workspace_id = ?2 AND grant_id = ?3",
                    params![owner_id, workspace_id, grant_id],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| KernelError::Authorization(format!("record owner is not valid: {owner_id}")))?;
            owner_hashes.insert(owner_id.to_string(), hash);
        }
        let mut normalized_refs = Vec::new();
        let mut slots = BTreeSet::new();
        for reference in references {
            let slot = reference
                .get("slot")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    KernelError::Operation("record reference slot is malformed".to_string())
                })?;
            if !slots.insert(slot.to_string()) {
                return Err(KernelError::Operation(
                    "record reference slots must be unique".to_string(),
                ));
            }
            let hash = reference
                .get("objectHash")
                .and_then(Value::as_str)
                .filter(|value| value.starts_with("sha256-"))
                .ok_or_else(|| {
                    KernelError::Operation("record reference objectHash is malformed".to_string())
                })?;
            let owner_matches = owner_hashes.values().any(|owner_hash| owner_hash == hash);
            let durable = self
                .conn
                .query_row(
                    "SELECT 1 FROM blobs WHERE hash = ?1 AND (EXISTS (SELECT 1 FROM domain_record_refs WHERE object_hash = ?1 AND workspace_id = ?2) OR EXISTS (SELECT 1 FROM root_blobs WHERE blob_hash = ?1))",
                    params![hash, workspace_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .is_some();
            if !owner_matches && !durable {
                return Err(KernelError::Authorization(
                    "record reference must consume an owner or existing durable reference"
                        .to_string(),
                ));
            }
            normalized_refs.push((slot.to_string(), hash.to_string()));
        }
        let existing = self
            .conn
            .query_row(
                "SELECT workspace_id, record_type, record_revision, revision, session_id, thread_id, run_id, branch_id, result_revision FROM domain_records WHERE record_id = ?1 AND workspace_id = ?2",
                params![record_id, workspace_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?, row.get::<_, Option<i64>>(3)?, row.get::<_, Option<String>>(4)?, row.get::<_, Option<String>>(5)?, row.get::<_, Option<String>>(6)?, row.get::<_, Option<String>>(7)?, row.get::<_, Option<i64>>(8)?)),
            )
            .optional()?;
        let expected_record_revision = params_value
            .get("expectedRecordRevision")
            .and_then(Value::as_i64);
        let record_revision = existing.as_ref().map_or(1, |row| row.2 + 1);
        if let Some((
            existing_workspace,
            existing_type,
            existing_record_revision,
            existing_revision,
            existing_session,
            existing_thread,
            existing_run,
            existing_branch,
            existing_result_revision,
        )) = existing
        {
            if existing_workspace != workspace_id || existing_type != record_type {
                return Err(KernelError::Authorization(
                    "record identity cannot be changed".to_string(),
                ));
            }
            for (label, old, new) in [
                (
                    "sessionId",
                    existing_session.as_deref(),
                    params_value.get("sessionId").and_then(Value::as_str),
                ),
                (
                    "threadId",
                    existing_thread.as_deref(),
                    params_value.get("threadId").and_then(Value::as_str),
                ),
                (
                    "runId",
                    existing_run.as_deref(),
                    params_value.get("runId").and_then(Value::as_str),
                ),
                (
                    "branchId",
                    existing_branch.as_deref(),
                    params_value.get("branchId").and_then(Value::as_str),
                ),
            ] {
                if old != new {
                    return Err(KernelError::Authorization(format!(
                        "record {label} identity cannot be changed"
                    )));
                }
            }
            if existing_result_revision
                != params_value.get("resultRevision").and_then(Value::as_i64)
            {
                return Err(KernelError::Authorization(
                    "record resultRevision identity cannot be changed".to_string(),
                ));
            }
            if existing_revision != params_value.get("revision").and_then(Value::as_i64) {
                return Err(KernelError::Authorization(
                    "record revision identity cannot be changed".to_string(),
                ));
            }
            let expected = expected_record_revision.ok_or_else(|| {
                KernelError::Operation("record update requires expectedRecordRevision".to_string())
            })?;
            if existing_record_revision != expected {
                return Err(KernelError::Operation(
                    "record revision conflict".to_string(),
                ));
            }
        } else if expected_record_revision.is_some() {
            return Err(KernelError::Operation(
                "record revision conflict: record does not exist".to_string(),
            ));
        }
        let now = now_ms();
        self.conn.execute(
            "INSERT INTO domain_records(record_id, workspace_id, record_type, state, session_id, thread_id, run_id, branch_id, revision, result_revision, record_revision, payload_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, COALESCE((SELECT created_at FROM domain_records WHERE record_id = ?1 AND workspace_id = ?2), ?13), ?13) ON CONFLICT(workspace_id, record_id) DO UPDATE SET state = excluded.state, record_revision = excluded.record_revision, payload_json = excluded.payload_json, updated_at = excluded.updated_at",
            params![record_id, workspace_id, record_type, state, params_value.get("sessionId").and_then(Value::as_str), params_value.get("threadId").and_then(Value::as_str), params_value.get("runId").and_then(Value::as_str), params_value.get("branchId").and_then(Value::as_str), params_value.get("revision").and_then(Value::as_i64), params_value.get("resultRevision").and_then(Value::as_i64), record_revision, serde_json::to_string(&payload)?, now],
        )?;
        self.conn.execute(
            "DELETE FROM domain_record_refs WHERE workspace_id = ?1 AND record_id = ?2",
            params![workspace_id, record_id],
        )?;
        for (slot, hash) in &normalized_refs {
            self.conn.execute("INSERT INTO domain_record_refs(workspace_id, record_id, slot, object_hash) VALUES (?1, ?2, ?3, ?4)", params![workspace_id, record_id, slot, hash])?;
        }
        let mut consumed = BTreeMap::new();
        for (owner_id, hash) in owner_hashes {
            if !normalized_refs
                .iter()
                .any(|(_, reference_hash)| reference_hash == &hash)
            {
                return Err(KernelError::Operation(format!(
                    "record owner is not referenced: {owner_id}"
                )));
            }
            consumed.insert(owner_id, hash);
        }
        self.consume_object_owners(&workspace_id, grant_id, &consumed)?;
        self.domain_record_value(&workspace_id, record_id)?
            .ok_or_else(|| KernelError::Storage("record disappeared after commit".to_string()))
    }

    fn domain_record_get(
        &self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = params_value
            .get("workspaceId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("record workspaceId is required".to_string()))?;
        let record_id = params_value
            .get("recordId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("recordId is required".to_string()))?;
        let grant = self.load_grant(grant_id)?;
        if grant.owning_workspace.as_deref() != Some(workspace_id)
            && !grant.capabilities.contains("storage.admin")
        {
            return Err(KernelError::Authorization(
                "record workspace does not match actor grant".to_string(),
            ));
        }
        match self.domain_record_value(workspace_id, record_id)? {
            Some(value)
                if value.get("workspaceId").and_then(Value::as_str) == Some(workspace_id)
                    && self.grant_can_access_domain_record(&value, grant_id)? =>
            {
                Ok(value)
            }
            Some(value)
                if value.get("workspaceId").and_then(Value::as_str) == Some(workspace_id) =>
            {
                Err(KernelError::Authorization(
                    "record belongs to another actor".to_string(),
                ))
            }
            Some(_) => Err(KernelError::Authorization(
                "record belongs to another workspace".to_string(),
            )),
            None => Ok(Value::Null),
        }
    }

    fn domain_record_list(
        &self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = params_value
            .get("workspaceId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("record workspaceId is required".to_string()))?;
        let grant = self.load_grant(grant_id)?;
        if grant.owning_workspace.as_deref() != Some(workspace_id)
            && !grant.capabilities.contains("storage.admin")
        {
            return Err(KernelError::Authorization(
                "record workspace does not match actor grant".to_string(),
            ));
        }
        let cursor = params_value
            .get("cursor")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize;
        let page_size = params_value
            .get("pageSize")
            .and_then(Value::as_u64)
            .unwrap_or(128) as usize;
        if page_size == 0 {
            return Err(KernelError::Operation(
                "pageSize must be positive when supplied".to_string(),
            ));
        }
        let record_type = params_value.get("recordType").and_then(Value::as_str);
        let mut sql = "SELECT record_id FROM domain_records WHERE workspace_id = ?1".to_string();
        if record_type.is_some() {
            sql.push_str(" AND record_type = ?2");
        }
        sql.push_str(" ORDER BY updated_at, record_id");
        let mut ids = Vec::new();
        if let Some(record_type) = record_type {
            for row in self
                .conn
                .prepare(&sql)?
                .query_map(params![workspace_id, record_type], |row| {
                    row.get::<_, String>(0)
                })?
            {
                ids.push(row?);
            }
        } else {
            for row in self
                .conn
                .prepare(&sql)?
                .query_map(params![workspace_id], |row| row.get::<_, String>(0))?
            {
                ids.push(row?);
            }
        }
        let session_filter = params_value.get("sessionId").and_then(Value::as_str);
        let thread_filter = params_value.get("threadId").and_then(Value::as_str);
        let run_filter = params_value.get("runId").and_then(Value::as_str);
        let branch_filter = params_value.get("branchId").and_then(Value::as_str);
        let mut filtered = Vec::new();
        for id in ids {
            let Some(value) = self.domain_record_value(workspace_id, &id)? else {
                continue;
            };
            if !self.grant_can_access_domain_record(&value, grant_id)? {
                continue;
            }
            if session_filter.is_some_and(|filter| {
                value.get("sessionId").and_then(Value::as_str) != Some(filter)
            }) || thread_filter
                .is_some_and(|filter| value.get("threadId").and_then(Value::as_str) != Some(filter))
                || run_filter.is_some_and(|filter| {
                    value.get("runId").and_then(Value::as_str) != Some(filter)
                })
                || branch_filter.is_some_and(|filter| {
                    value.get("branchId").and_then(Value::as_str) != Some(filter)
                })
            {
                continue;
            }
            filtered.push(value);
        }
        let start = cursor.min(filtered.len());
        let end = start.saturating_add(page_size).min(filtered.len());
        Ok(
            json!({"records": filtered[start..end].to_vec(), "nextCursor": if end < filtered.len() { Value::from(end as u64) } else { Value::Null }}),
        )
    }

    fn domain_record_release(
        &mut self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.validate_domain_record_identity(params_value, grant_id)?;
        let record_id = params_value
            .get("recordId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("recordId is required".to_string()))?;
        if let Some(value) = self.domain_record_value(&workspace_id, record_id)? {
            if !self.grant_can_access_domain_record(&value, grant_id)? {
                return Err(KernelError::Authorization(
                    "record belongs to another actor".to_string(),
                ));
            }
        }
        let deleted = self.conn.execute(
            "DELETE FROM domain_records WHERE record_id = ?1 AND workspace_id = ?2",
            params![record_id, workspace_id],
        )?;
        Ok(json!({"recordId": record_id, "released": deleted > 0}))
    }

    fn validate_node_integrity(
        &self,
        hash: &str,
        lower: Option<&str>,
        upper: Option<&str>,
        active: &mut BTreeSet<String>,
        cached: &mut HashMap<String, (i32, Option<String>, Option<String>)>,
        errors: &mut Vec<String>,
    ) -> Result<(i32, Option<String>, Option<String>), KernelError> {
        if !active.insert(hash.to_string()) {
            errors.push(format!("trie cycle detected at {hash}"));
            return Ok((0, None, None));
        }
        let node = self.load_node(hash)?;
        let result = match node {
            TrieNode::Path { state, children } => {
                if state.as_ref().is_some_and(|state| !state.is_directory()) && children.is_some() {
                    errors.push(format!("non-directory path node has children: {hash}"));
                }
                if let Some(children) = children {
                    let _ = self
                        .validate_node_integrity(&children, None, None, active, cached, errors)?;
                }
                (0, None, None)
            }
            TrieNode::Index {
                key,
                child,
                left,
                right,
                height,
            } => {
                if lower.is_some_and(|lower| key.as_str() <= lower)
                    || upper.is_some_and(|upper| key.as_str() >= upper)
                {
                    errors.push(format!("AVL key order violation at {hash}"));
                }
                let _ = self.validate_node_integrity(&child, None, None, active, cached, errors)?;
                let left_info = if let Some(left) = left {
                    self.validate_node_integrity(
                        &left,
                        lower,
                        Some(key.as_str()),
                        active,
                        cached,
                        errors,
                    )?
                } else {
                    (0, None, None)
                };
                let right_info = if let Some(right) = right {
                    self.validate_node_integrity(
                        &right,
                        Some(key.as_str()),
                        upper,
                        active,
                        cached,
                        errors,
                    )?
                } else {
                    (0, None, None)
                };
                let expected_height = left_info.0.max(right_info.0) + 1;
                if i32::from(height) != expected_height || (left_info.0 - right_info.0).abs() > 1 {
                    errors.push(format!("AVL height/balance violation at {hash}"));
                }
                let min = left_info.1.unwrap_or_else(|| key.clone());
                let max = right_info.2.unwrap_or_else(|| key.clone());
                (expected_height, Some(min), Some(max))
            }
        };
        active.remove(hash);
        cached.insert(hash.to_string(), result.clone());
        Ok(result)
    }

    fn deep_relationship_errors(&self) -> Result<Vec<String>, KernelError> {
        let mut errors = Vec::new();
        let mut cached = HashMap::new();
        let mut validate_root = |root: &str, errors: &mut Vec<String>| -> Result<(), KernelError> {
            let node = match self.load_node(root) {
                Ok(node) => node,
                Err(error) => {
                    errors.push(format!("{root}: {error}"));
                    return Ok(());
                }
            };
            if !matches!(node, TrieNode::Path { .. }) {
                errors.push(format!("root is not a path node: {root}"));
            }
            let mut active = BTreeSet::new();
            if let Err(error) =
                self.validate_node_integrity(root, None, None, &mut active, &mut cached, errors)
            {
                errors.push(format!("{root}: {error}"));
            }
            Ok(())
        };
        let mut branches = self.conn.prepare(
            "SELECT branch_id, workspace_id, base_root, head_root, head_revision FROM branches",
        )?;
        for row in branches.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })? {
            let (branch_id, _workspace, base_root, head_root, head_revision) = row?;
            if self
                .conn
                .query_row(
                    "SELECT 1 FROM revisions WHERE branch_id = ?1 AND revision = ?2",
                    params![branch_id, head_revision],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .is_none()
            {
                errors.push(format!("branch published revision is missing: {branch_id}"));
            }
            if let Err(error) = validate_root(&head_root, &mut errors) {
                errors.push(format!("{branch_id}: {error}"));
            }
            if let Err(error) = validate_root(&base_root, &mut errors) {
                errors.push(format!("{branch_id} base: {error}"));
            }
        }
        let mut pins = self.conn.prepare(
            "SELECT p.pin_id, p.branch_id, p.workspace_id, p.revision, p.root_hash, b.workspace_id FROM pins p LEFT JOIN branches b ON b.branch_id = p.branch_id",
        )?;
        for row in pins.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })? {
            let (pin_id, branch_id, workspace, revision, root, branch_workspace) = row?;
            let revision_root = self
                .conn
                .query_row(
                    "SELECT root_hash FROM revisions WHERE branch_id = ?1 AND revision = ?2",
                    params![branch_id, revision],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            let branch_identity_invalid = branch_workspace
                .as_deref()
                .is_some_and(|branch_workspace| branch_workspace != workspace);
            let revision_invalid =
                branch_workspace.is_some() && revision_root.as_deref() != Some(root.as_str());
            if branch_identity_invalid || revision_invalid {
                errors.push(format!("pin identity is inconsistent: {pin_id}"));
            }
            if let Err(error) = validate_root(&root, &mut errors) {
                errors.push(format!("pin {pin_id}: {error}"));
            }
        }
        let mut owners = self
            .conn
            .prepare("SELECT owner_id, blob_hash FROM object_owners")?;
        for row in owners.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })? {
            let (owner_id, hash) = row?;
            let blob = self
                .conn
                .query_row(
                    "SELECT byte_length FROM blobs WHERE hash = ?1",
                    params![hash],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            if blob.is_none() {
                errors.push(format!("owner points to missing blob: {owner_id}"));
            }
        }
        let mut pending = self.conn.prepare(
            "SELECT hash, path FROM pending_gc_files WHERE state IN ('pending', 'failed')",
        )?;
        for row in pending.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })? {
            let (hash, raw_path) = row?;
            match object_path(&self.root, &hash) {
                Ok(derived)
                    if derived.starts_with(self.root.join("objects"))
                        && Path::new(&raw_path) == derived => {}
                Ok(_) | Err(_) => {
                    errors.push(format!(
                        "pending cleanup path is outside derived object path: {hash}"
                    ));
                }
            }
        }
        Ok(errors)
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

    fn operation_release(&mut self, params_value: &Value) -> Result<Value, KernelError> {
        let operation_id = params_value
            .get("operationId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("operationId is required".to_string()))?;
        let workspace_id = params_value
            .get("workspaceId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                KernelError::Authorization("operation workspace is required".to_string())
            })?;
        let blocked: Option<String> = self
            .conn
            .query_row(
                "SELECT 'temporary-object' FROM object_owners WHERE operation_id = ?1 UNION SELECT 'revision' FROM revisions WHERE operation_id = ?1 LIMIT 1",
                params![operation_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(blocked) = blocked {
            return Ok(json!({
                "operationId": operation_id,
                "released": false,
                "status": "in-use",
                "reason": blocked,
            }));
        }
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let outcome = (|| {
            let owned: Option<i64> = self
                .conn
                .query_row(
                    "SELECT 1 FROM operation_owners WHERE operation_id = ?1 AND workspace_id = ?2",
                    params![operation_id, workspace_id],
                    |row| row.get(0),
                )
                .optional()?;
            if owned.is_none() {
                return Ok(false);
            }
            self.conn.execute(
                "DELETE FROM operation_owners WHERE operation_id = ?1 AND workspace_id = ?2",
                params![operation_id, workspace_id],
            )?;
            self.conn.execute(
                "DELETE FROM operations WHERE operation_id = ?1",
                params![operation_id],
            )?;
            Ok::<bool, KernelError>(true)
        })();
        match outcome {
            Ok(released) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(
                    json!({"operationId": operation_id, "released": released, "status": if released { "released" } else { "missing" }}),
                )
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
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
        let node_json_bytes: i64 = self.conn.query_row("SELECT COALESCE(SUM(length(CAST(children_json AS BLOB)) + COALESCE(length(CAST(state_json AS BLOB)), 0)), 0) FROM trie_nodes", [], |row| row.get(0))?;
        let operations: i64 =
            self.conn
                .query_row("SELECT COUNT(*) FROM operations", [], |row| row.get(0))?;
        let temporary_object_owners: i64 =
            self.conn
                .query_row("SELECT COUNT(*) FROM object_owners", [], |row| row.get(0))?;
        let catalog_path = self.root.join("catalog.sqlite");
        let catalog_bytes = fs::metadata(&catalog_path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        let wal_bytes = fs::metadata(self.root.join("catalog.sqlite-wal"))
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if !params.get("deep").and_then(Value::as_bool).unwrap_or(false) {
            return Ok(
                json!({"integrity": integrity, "branches": branches, "nodes": nodes, "nodeJsonBytes": node_json_bytes, "catalogBytes": catalog_bytes, "walBytes": wal_bytes, "operations": operations, "temporaryObjectOwners": temporary_object_owners, "blobs": blobs, "storageRoot": self.root, "pendingCleanup": pending_cleanup, "cleanupFailures": cleanup_failures, "deep": false}),
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
        for row in self
            .conn
            .prepare("SELECT root_hash FROM revisions UNION SELECT root_hash FROM pins")?
            .query_map([], |row| row.get::<_, String>(0))?
        {
            roots.insert(row?);
        }
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
            match (recorded, hash_file(&object_path(&self.root, &hash)?)) {
                (Some(length), Ok((actual_hash, actual_length)))
                    if i64::try_from(actual_length).ok() == Some(length) && actual_hash == hash => {
                }
                (None, _) => missing_objects.push(hash),
                (Some(_), Err(_)) => missing_objects.push(hash),
                _ => corrupt_objects.push(hash),
            }
        }
        let relationship_errors = self.deep_relationship_errors()?;
        let status = if integrity == "ok"
            && missing_nodes.is_empty()
            && missing_objects.is_empty()
            && corrupt_objects.is_empty()
            && relationship_errors.is_empty()
            && cleanup_failures.is_empty()
        {
            "ok"
        } else {
            "degraded"
        };
        Ok(
            json!({"integrity": status, "sqliteIntegrity": integrity, "branches": branches, "nodes": nodes, "nodeJsonBytes": node_json_bytes, "catalogBytes": catalog_bytes, "walBytes": wal_bytes, "operations": operations, "temporaryObjectOwners": temporary_object_owners, "blobs": blobs, "storageRoot": self.root, "pendingCleanup": pending_cleanup, "cleanupFailures": cleanup_failures, "deep": true, "missingNodes": missing_nodes, "missingObjects": missing_objects, "corruptObjects": corrupt_objects, "relationshipErrors": relationship_errors}),
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
        storage.record_operation_workspace(
            operation_id,
            params_value.get("workspaceId").and_then(Value::as_str),
        )?;
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

fn main() -> Result<(), Box<dyn std::error::Error>> {
    runtime::run()
}
