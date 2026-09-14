//! Canonical workspace file resources and cross-request path leases.
//!
//! R2 keeps editor buffers in the TypeScript Document Registry while moving
//! controlled disk identity, capture, apply, and CRUD side effects into this
//! kernel. File roots are epoch-local registrations: the Host must re-admit a
//! Documents-authorized canonical root after every kernel restart.
use super::*;
use crate::protocol_generated::{
    KernelFileApplyParams, KernelFileCaptureParams, KernelFileLeaseAcquireParams,
    KernelFileLeaseReleaseParams, KernelFileMkdirParams, KernelFileRemoveParams,
    KernelFileRenameParams, KernelFileRootRegisterParams,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum FileState {
    #[serde(rename = "regular-file")]
    RegularFile {
        #[serde(rename = "objectHash")]
        object_hash: String,
        #[serde(rename = "byteLength")]
        byte_length: u64,
        mode: Option<u32>,
    },
    Directory {
        mode: Option<u32>,
    },
    Symlink {
        #[serde(rename = "symlinkTarget")]
        symlink_target: String,
        mode: Option<u32>,
    },
    Missing,
    Unsupported,
}

#[derive(Clone, Debug)]
struct ResolvedFileResource {
    path: String,
    absolute: PathBuf,
}

fn file_params_value(params_value: &Value) -> Value {
    let mut params = params_value.clone();
    if let Some(object) = params.as_object_mut() {
        object.remove("__pathScopes");
    }
    params
}

fn parse_file_params<T: DeserializeOwned>(params_value: &Value) -> Result<T, KernelError> {
    Ok(serde_json::from_value(file_params_value(params_value))?)
}

fn file_mode(metadata: &fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o7777
    }
    #[cfg(windows)]
    {
        if metadata.permissions().readonly() {
            0o444
        } else {
            0o666
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = metadata;
        0o666
    }
}

fn apply_mode(path: &Path, mode: Option<u32>) -> Result<(), KernelError> {
    let Some(mode) = mode else {
        return Ok(());
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode & 0o7777))?;
    }
    #[cfg(windows)]
    {
        let mut permissions = fs::metadata(path)?.permissions();
        permissions.set_readonly(mode & 0o200 == 0);
        fs::set_permissions(path, permissions)?;
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (path, mode);
    }
    Ok(())
}

fn path_inside(root: &Path, candidate: &Path) -> bool {
    #[cfg(windows)]
    {
        let normalize = |path: &Path| path.to_string_lossy().replace('/', "\\").to_lowercase();
        let root = normalize(root);
        let candidate = normalize(candidate);
        candidate == root || candidate.starts_with(&(root + "\\"))
    }
    #[cfg(not(windows))]
    {
        candidate == root || candidate.starts_with(root)
    }
}

fn normalized_relative_path(
    value: &str,
    allow_root: bool,
) -> Result<(String, PathBuf), KernelError> {
    let normalized = value.replace('\\', "/");
    if normalized.is_empty() {
        if allow_root {
            return Ok((String::new(), PathBuf::new()));
        }
        return Err(KernelError::Authorization(
            "workspace root cannot be mutated directly".to_string(),
        ));
    }
    let mut result = PathBuf::new();
    let mut pieces = Vec::new();
    for component in Path::new(&normalized).components() {
        match component {
            Component::Normal(segment) => {
                let text = segment.to_str().ok_or_else(|| {
                    KernelError::Authorization("file path is not UTF-8".to_string())
                })?;
                if text.is_empty() {
                    return Err(KernelError::Authorization(
                        "file path contains an empty segment".to_string(),
                    ));
                }
                pieces.push(text.to_string());
                result.push(segment);
            }
            _ => {
                return Err(KernelError::Authorization(format!(
                    "file path is not relative and normalized: {value}"
                )))
            }
        }
    }
    if pieces.is_empty() && !allow_root {
        return Err(KernelError::Authorization(
            "workspace root cannot be mutated directly".to_string(),
        ));
    }
    Ok((pieces.join("/"), result))
}

fn resource_overlap(left: &FileLeaseResource, right: &FileLeaseResource) -> bool {
    if left.path == right.path {
        return true;
    }
    if left.subtree && (left.path.is_empty() || right.path.starts_with(&(left.path.clone() + "/")))
    {
        return true;
    }
    right.subtree && (right.path.is_empty() || left.path.starts_with(&(right.path.clone() + "/")))
}

fn remove_existing(path: &Path) -> Result<(), KernelError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() => {
            fs::remove_dir(path).map_err(Into::into)
        }
        Ok(_) => fs::remove_file(path).map_err(Into::into),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn create_symlink(target: &str, path: &Path) -> Result<(), KernelError> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, path)?;
    }
    #[cfg(windows)]
    {
        let target_path = Path::new(target);
        let observed = if target_path.is_absolute() {
            target_path.to_path_buf()
        } else {
            path.parent()
                .unwrap_or_else(|| Path::new("."))
                .join(target_path)
        };
        if fs::metadata(&observed).is_ok_and(|metadata| metadata.is_dir()) {
            std::os::windows::fs::symlink_dir(target, path)?;
        } else {
            std::os::windows::fs::symlink_file(target, path)?;
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        return Err(KernelError::Storage(
            "symbolic links are unsupported on this platform".to_string(),
        ));
    }
    Ok(())
}

impl Storage {
    fn registered_file_root(&self, root_id: &str, grant: &Grant) -> Result<FileRoot, KernelError> {
        let root = self.file_roots.get(root_id).cloned().ok_or_else(|| {
            KernelError::Authorization(
                "file root is not registered for this kernel epoch".to_string(),
            )
        })?;
        let execution = grant
            .execution_workspace
            .as_deref()
            .or(grant.owning_workspace.as_deref());
        if execution != Some(root.execution_workspace_id.as_str())
            && !grant.capabilities.contains("storage.admin")
        {
            return Err(KernelError::Authorization(
                "grant execution workspace does not own file root".to_string(),
            ));
        }
        Ok(root)
    }

    fn resolve_file_resource(
        &self,
        root_id: &str,
        relative: &str,
        grant: &Grant,
        allow_root: bool,
    ) -> Result<ResolvedFileResource, KernelError> {
        let root = self.registered_file_root(root_id, grant)?;
        let (path, relative_path) = normalized_relative_path(relative, allow_root)?;
        if !path_allowed(grant, &path) {
            return Err(KernelError::Authorization(format!(
                "path is outside grant scope: {path}"
            )));
        }
        let mut current = root.canonical_root.clone();
        let components = relative_path.components().collect::<Vec<_>>();
        for (index, component) in components.iter().enumerate() {
            let next = current.join(component.as_os_str());
            if index + 1 < components.len() {
                match fs::canonicalize(&next) {
                    Ok(canonical) => {
                        if !path_inside(&root.canonical_root, &canonical) {
                            return Err(KernelError::Authorization(
                                "file path escaped the registered workspace root".to_string(),
                            ));
                        }
                        current = canonical;
                    }
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {
                        current = next;
                        for rest in &components[index + 1..] {
                            current.push(rest.as_os_str());
                        }
                        break;
                    }
                    Err(error) => return Err(error.into()),
                }
            } else {
                current = next;
            }
        }
        if !path_inside(&root.canonical_root, &current) {
            return Err(KernelError::Authorization(
                "file path escaped the registered workspace root".to_string(),
            ));
        }
        Ok(ResolvedFileResource {
            path,
            absolute: current,
        })
    }

    fn assert_file_lease(
        &self,
        grant: &Grant,
        root_id: &str,
        paths: &[FileLeaseResource],
        lease_id: Option<&str>,
    ) -> Result<(), KernelError> {
        if let Some(lease_id) = lease_id {
            let lease = self.file_leases.get(lease_id).ok_or_else(|| {
                KernelError::Operation("file resource lease is no longer active".to_string())
            })?;
            if lease.grant_id != grant.grant_id || lease.root_id != root_id {
                return Err(KernelError::Authorization(
                    "file resource lease belongs to another grant or root".to_string(),
                ));
            }
            if paths.iter().any(|path| {
                !lease.resources.iter().any(|held| {
                    resource_overlap(held, path) && (held.subtree || held.path == path.path)
                })
            }) {
                return Err(KernelError::Authorization(
                    "file resource is outside the held lease".to_string(),
                ));
            }
        }
        for lease in self.file_leases.values() {
            if lease.root_id != root_id || lease_id == Some(lease.lease_id.as_str()) {
                continue;
            }
            if paths.iter().any(|path| {
                lease
                    .resources
                    .iter()
                    .any(|held| resource_overlap(held, path))
            }) {
                return Err(KernelError::Operation(format!(
                    "file resource is busy under lease {}",
                    lease.lease_id
                )));
            }
        }
        Ok(())
    }

    fn capture_file_state(
        &mut self,
        resource: &ResolvedFileResource,
        store: bool,
        operation_id: &str,
        workspace_id: &str,
        grant_id: &str,
    ) -> Result<(FileState, Option<String>), KernelError> {
        self.check_cancelled()?;
        let metadata = match fs::symlink_metadata(&resource.absolute) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok((FileState::Missing, None))
            }
            Err(error) => return Err(error.into()),
        };
        if metadata.file_type().is_symlink() {
            let target = fs::read_link(&resource.absolute)?
                .to_string_lossy()
                .to_string();
            return Ok((
                FileState::Symlink {
                    symlink_target: target,
                    mode: Some(file_mode(&metadata)),
                },
                None,
            ));
        }
        if metadata.is_dir() {
            return Ok((
                FileState::Directory {
                    mode: Some(file_mode(&metadata)),
                },
                None,
            ));
        }
        if !metadata.is_file() {
            return Ok((FileState::Unsupported, None));
        }
        let mode = file_mode(&metadata);
        if !store {
            let (hash, byte_length) = hash_file(&resource.absolute)?;
            let after = fs::symlink_metadata(&resource.absolute)?;
            let (after_hash, after_length) = hash_file(&resource.absolute)?;
            if !after.is_file()
                || file_mode(&after) != mode
                || hash != after_hash
                || byte_length != after_length
            {
                return Err(KernelError::Operation(format!(
                    "file changed while being captured: {}",
                    resource.path
                )));
            }
            return Ok((
                FileState::RegularFile {
                    object_hash: hash,
                    byte_length,
                    mode: Some(mode),
                },
                None,
            ));
        }

        let staging_dir = self.root.join("staging");
        fs::create_dir_all(&staging_dir)?;
        let staging = staging_dir.join(format!("file-capture-{}", Uuid::new_v4()));
        let mut source = BufReader::new(File::open(&resource.absolute)?);
        let mut target_file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .read(true)
            .open(&staging)?;
        let mut digest = Sha256::new();
        let mut byte_length = 0u64;
        let mut buffer = [0u8; 128 * 1024];
        loop {
            self.check_cancelled()?;
            let read = source.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            target_file.write_all(&buffer[..read])?;
            digest.update(&buffer[..read]);
            byte_length = byte_length
                .checked_add(read as u64)
                .ok_or_else(|| KernelError::Storage("file size overflow".to_string()))?;
        }
        target_file.sync_all()?;
        drop(target_file);
        let hash = format!("sha256-{}", hex::encode(digest.finalize()));
        let after = fs::symlink_metadata(&resource.absolute)?;
        let (after_hash, after_length) = hash_file(&resource.absolute)?;
        if !after.is_file()
            || file_mode(&after) != mode
            || hash != after_hash
            || byte_length != after_length
        {
            let _ = fs::remove_file(&staging);
            return Err(KernelError::Operation(format!(
                "file changed while being captured: {}",
                resource.path
            )));
        }
        let object = object_path(&self.root, &hash)?;
        if object.exists() {
            let (existing_hash, existing_length) = hash_file(&object)?;
            if existing_hash != hash || existing_length != byte_length {
                let _ = fs::remove_file(&staging);
                return Err(KernelError::Storage(format!(
                    "content object is corrupt: {hash}"
                )));
            }
            fs::remove_file(&staging)?;
            sync_directory(&staging_dir)?;
        } else {
            let shard = object.parent().expect("object path has shard");
            if !shard.exists() {
                fs::create_dir_all(shard)?;
                sync_directory(&self.root.join("objects"))?;
            }
            durable_rename(&staging, &object)?;
            OpenOptions::new()
                .read(true)
                .write(true)
                .open(&object)?
                .sync_all()?;
            sync_directory(&staging_dir)?;
            sync_directory(shard)?;
        }
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
        let owner_id = blob_owner_id(operation_id);
        self.record_object_owner(
            &owner_id,
            &hash,
            Some(workspace_id),
            Some(operation_id),
            grant_id,
        )?;
        Ok((
            FileState::RegularFile {
                object_hash: hash,
                byte_length,
                mode: Some(mode),
            },
            Some(owner_id),
        ))
    }

    fn observe_state(&mut self, resource: &ResolvedFileResource) -> Result<FileState, KernelError> {
        self.capture_file_state(resource, false, "observe", "", "")
            .map(|value| value.0)
    }

    fn apply_file_state(
        &mut self,
        resource: &ResolvedFileResource,
        state: &FileState,
        workspace_id: &str,
    ) -> Result<(), KernelError> {
        self.check_cancelled()?;
        if resource.path.is_empty() {
            return Err(KernelError::Authorization(
                "workspace root cannot be applied as a file state".to_string(),
            ));
        }
        match state {
            FileState::Missing => remove_existing(&resource.absolute),
            FileState::Directory { mode } => {
                match fs::symlink_metadata(&resource.absolute) {
                    Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
                    Ok(_) => remove_existing(&resource.absolute)?,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
                fs::create_dir_all(&resource.absolute)?;
                apply_mode(&resource.absolute, *mode)
            }
            FileState::Symlink {
                symlink_target,
                mode: _,
            } => {
                remove_existing(&resource.absolute)?;
                if let Some(parent) = resource.absolute.parent() {
                    fs::create_dir_all(parent)?;
                }
                create_symlink(symlink_target, &resource.absolute)
            }
            FileState::RegularFile {
                object_hash,
                byte_length,
                mode,
            } => {
                if !self.blob_owned(object_hash, Some(workspace_id))? {
                    return Err(KernelError::Authorization(
                        "file target object is not owned by the workspace".to_string(),
                    ));
                }
                let object = object_path(&self.root, object_hash)?;
                let (actual_hash, actual_length) = hash_file(&object)?;
                if actual_hash != *object_hash || actual_length != *byte_length {
                    return Err(KernelError::Storage(format!(
                        "content object is corrupt: {object_hash}"
                    )));
                }
                if let Some(parent) = resource.absolute.parent() {
                    fs::create_dir_all(parent)?;
                }
                match fs::symlink_metadata(&resource.absolute) {
                    Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                        fs::remove_dir(&resource.absolute)?
                    }
                    Ok(_) | Err(_) => {}
                }
                let temporary = resource
                    .absolute
                    .with_file_name(format!(".piarium-kernel-{}", Uuid::new_v4()));
                fs::copy(&object, &temporary)?;
                apply_mode(&temporary, *mode)?;
                OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(&temporary)?
                    .sync_all()?;
                durable_rename(&temporary, &resource.absolute).map_err(|error| {
                    let _ = fs::remove_file(&temporary);
                    KernelError::Storage(error.to_string())
                })?;
                OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(&resource.absolute)?
                    .sync_all()?;
                if let Some(parent) = resource.absolute.parent() {
                    sync_directory(parent)?;
                }
                Ok(())
            }
            FileState::Unsupported => Err(KernelError::Operation(
                "unsupported file states cannot be applied".to_string(),
            )),
        }
    }

    fn file_state_matches(observed: &FileState, expected: &FileState) -> bool {
        match (observed, expected) {
            (FileState::Missing, FileState::Missing)
            | (FileState::Unsupported, FileState::Unsupported) => true,
            (FileState::Directory { mode: observed }, FileState::Directory { mode: expected }) => {
                expected.is_none() || observed == expected
            }
            (
                FileState::Symlink {
                    symlink_target: observed_target,
                    mode: observed_mode,
                },
                FileState::Symlink {
                    symlink_target: expected_target,
                    mode: expected_mode,
                },
            ) => {
                observed_target == expected_target
                    && (expected_mode.is_none() || observed_mode == expected_mode)
            }
            (
                FileState::RegularFile {
                    object_hash: observed_hash,
                    byte_length: observed_length,
                    mode: observed_mode,
                },
                FileState::RegularFile {
                    object_hash: expected_hash,
                    byte_length: expected_length,
                    mode: expected_mode,
                },
            ) => {
                observed_hash == expected_hash
                    && observed_length == expected_length
                    && (expected_mode.is_none() || observed_mode == expected_mode)
            }
            _ => false,
        }
    }

    fn begin_file_operation(
        &mut self,
        operation_id: &str,
        kind: &str,
        params_value: &Value,
    ) -> Result<(String, Option<Value>, bool), KernelError> {
        let identity_params = file_params_value(params_value);
        let params_hash = hash_json(&identity_params)?;
        let existing: Option<(String, String, String, Option<String>)> = self.conn.query_row(
            "SELECT kind, params_hash, state, result_json FROM operations WHERE operation_id = ?1",
            params![operation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).optional()?;
        if let Some((stored_kind, stored_hash, state, result)) = existing {
            if stored_kind != kind || stored_hash != params_hash {
                return Err(KernelError::Operation(format!(
                    "operationId {operation_id} was reused with different parameters"
                )));
            }
            if state == "committed" {
                let result = result.ok_or_else(|| {
                    KernelError::Storage("committed file operation has no result".to_string())
                })?;
                return Ok((params_hash, Some(serde_json::from_str(&result)?), false));
            }
            if state == "started" {
                return Ok((params_hash, None, true));
            }
            self.conn.execute(
                "DELETE FROM operations WHERE operation_id = ?1",
                params![operation_id],
            )?;
            self.conn.execute(
                "DELETE FROM operation_owners WHERE operation_id = ?1",
                params![operation_id],
            )?;
        }
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let outcome = (|| {
            self.operation_begin(operation_id, kind, &params_hash)?;
            self.record_operation_workspace(
                operation_id,
                params_value.get("workspaceId").and_then(Value::as_str),
            )?;
            self.conn.execute(
                "UPDATE operations SET result_json = ?2, updated_at = ?3 WHERE operation_id = ?1",
                params![
                    operation_id,
                    serde_json::to_string(&json!({"intent": identity_params}))?,
                    now_ms()
                ],
            )?;
            Ok::<(), KernelError>(())
        })();
        match outcome {
            Ok(()) => {
                self.conn.execute_batch("COMMIT")?;
                Ok((params_hash, None, false))
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    fn finish_file_operation(
        &mut self,
        operation_id: &str,
        result: &Value,
    ) -> Result<(), KernelError> {
        self.finish_file_operation_owned(operation_id, result, None, None)
    }

    fn finish_file_operation_owned(
        &mut self,
        operation_id: &str,
        result: &Value,
        owner_id: Option<&str>,
        workspace_id: Option<&str>,
    ) -> Result<(), KernelError> {
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let outcome = (|| {
            self.operation_finish(operation_id, result)?;
            if let (Some(owner_id), Some(workspace_id)) = (owner_id, workspace_id) {
                self.conn.execute(
                    "DELETE FROM object_owners WHERE owner_id = ?1 AND workspace_id = ?2",
                    params![owner_id, workspace_id],
                )?;
            }
            Ok::<(), KernelError>(())
        })();
        match outcome {
            Ok(()) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(())
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    fn reconcile_file_operations_for_root(
        &mut self,
        root_id: &str,
        workspace_id: &str,
        grant: &Grant,
    ) -> Result<(usize, usize), KernelError> {
        let pending = {
            let mut statement = self.conn.prepare(
                "SELECT o.operation_id, o.kind, o.result_json FROM operations o JOIN operation_owners w ON w.operation_id = o.operation_id WHERE o.state = 'started' AND w.workspace_id = ?1 AND o.kind LIKE 'file.%' ORDER BY o.created_at, o.operation_id",
            )?;
            let rows = statement.query_map(params![workspace_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let mut reconciled = 0usize;
        let mut unresolved = 0usize;
        for (operation_id, kind, stored) in pending {
            let Some(stored) = stored else {
                unresolved += 1;
                continue;
            };
            let envelope: Value = serde_json::from_str(&stored)?;
            let Some(intent) = envelope.get("intent") else {
                unresolved += 1;
                continue;
            };
            if intent.get("rootId").and_then(Value::as_str) != Some(root_id) {
                continue;
            }
            let result = match kind.as_str() {
                "file.apply" => {
                    let params: KernelFileApplyParams = parse_file_params(intent)?;
                    let resource =
                        self.resolve_file_resource(root_id, &params.path, grant, false)?;
                    let target: FileState = serde_json::from_str(&params.target_json)?;
                    let observed = self.observe_state(&resource)?;
                    if Self::file_state_matches(&observed, &target) {
                        Some((
                            json!({"status":"applied","reconciled":true,"stateJson":serde_json::to_string(&observed)?}),
                            params.owner_id,
                            Some(params.workspace_id),
                        ))
                    } else {
                        None
                    }
                }
                "file.mkdir" => {
                    let params: KernelFileMkdirParams = parse_file_params(intent)?;
                    let resource =
                        self.resolve_file_resource(root_id, &params.path, grant, false)?;
                    if fs::symlink_metadata(&resource.absolute).is_ok_and(|metadata| {
                        metadata.is_dir() && !metadata.file_type().is_symlink()
                    }) {
                        Some((json!({"status":"created","reconciled":true}), None, None))
                    } else {
                        None
                    }
                }
                "file.remove" => {
                    let params: KernelFileRemoveParams = parse_file_params(intent)?;
                    let resource =
                        self.resolve_file_resource(root_id, &params.path, grant, false)?;
                    if fs::symlink_metadata(&resource.absolute)
                        .is_err_and(|error| error.kind() == io::ErrorKind::NotFound)
                    {
                        Some((json!({"status":"removed","reconciled":true}), None, None))
                    } else {
                        None
                    }
                }
                "file.rename" => {
                    let params: KernelFileRenameParams = parse_file_params(intent)?;
                    let source =
                        self.resolve_file_resource(root_id, &params.from_path, grant, false)?;
                    let target =
                        self.resolve_file_resource(root_id, &params.to_path, grant, false)?;
                    if fs::symlink_metadata(&source.absolute)
                        .is_err_and(|error| error.kind() == io::ErrorKind::NotFound)
                        && fs::symlink_metadata(&target.absolute).is_ok()
                    {
                        Some((json!({"status":"renamed","reconciled":true}), None, None))
                    } else {
                        None
                    }
                }
                _ => None,
            };
            if let Some((result, owner_id, owner_workspace)) = result {
                self.finish_file_operation_owned(
                    &operation_id,
                    &result,
                    owner_id.as_deref(),
                    owner_workspace.as_deref(),
                )?;
                reconciled += 1;
            } else {
                unresolved += 1;
            }
        }
        Ok((reconciled, unresolved))
    }

    pub(super) fn file_root_register(
        &mut self,
        params_value: &Value,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let params: KernelFileRootRegisterParams = parse_file_params(params_value)?;
        let expected_execution = grant
            .execution_workspace
            .as_deref()
            .or(grant.owning_workspace.as_deref());
        if expected_execution != Some(params.execution_workspace_id.as_str())
            && !grant.capabilities.contains("storage.admin")
        {
            return Err(KernelError::Authorization(
                "grant execution workspace does not match file root registration".to_string(),
            ));
        }
        let requested = Path::new(&params.canonical_root);
        if !requested.is_absolute() {
            return Err(KernelError::Authorization(
                "file root must be absolute".to_string(),
            ));
        }
        let canonical = fs::canonicalize(requested)?;
        if !fs::metadata(&canonical)?.is_dir() {
            return Err(KernelError::Operation(
                "file root is not a directory".to_string(),
            ));
        }
        if let Some(existing) = self
            .file_roots
            .values()
            .find(|root| root.execution_workspace_id == params.execution_workspace_id)
        {
            if existing.canonical_root != canonical {
                return Err(KernelError::Authorization(
                    "execution workspace root changed during this kernel epoch".to_string(),
                ));
            }
            let root_id = existing.root_id.clone();
            let execution_workspace_id = existing.execution_workspace_id.clone();
            let canonical_root = existing.canonical_root.clone();
            let (reconciled_operations, pending_operations) =
                self.reconcile_file_operations_for_root(&root_id, &params.workspace_id, grant)?;
            return Ok(json!({
                "rootId": root_id,
                "executionWorkspaceId": execution_workspace_id,
                "canonicalRoot": canonical_root,
                "reconciledOperations": reconciled_operations,
                "pendingOperations": pending_operations,
            }));
        }
        let identity = format!(
            "file-root-v1\0{}\0{}",
            params.execution_workspace_id,
            canonical.to_string_lossy()
        );
        let root_id = format!(
            "file-root-{}",
            hex::encode(Sha256::digest(identity.as_bytes()))
        );
        let root = FileRoot {
            root_id: root_id.clone(),
            execution_workspace_id: params.execution_workspace_id.clone(),
            canonical_root: canonical.clone(),
        };
        self.file_roots.insert(root_id.clone(), root);
        let (reconciled_operations, pending_operations) =
            self.reconcile_file_operations_for_root(&root_id, &params.workspace_id, grant)?;
        Ok(json!({
            "rootId": root_id,
            "executionWorkspaceId": params.execution_workspace_id,
            "canonicalRoot": canonical,
            "reconciledOperations": reconciled_operations,
            "pendingOperations": pending_operations,
        }))
    }

    pub(super) fn file_lease_acquire(
        &mut self,
        params_value: &Value,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let params: KernelFileLeaseAcquireParams = parse_file_params(params_value)?;
        let _root = self.registered_file_root(&params.root_id, grant)?;
        let resources = params
            .resources
            .iter()
            .map(|resource| {
                let (path, _) = normalized_relative_path(&resource.path, true)?;
                if !path_allowed(grant, &path) {
                    return Err(KernelError::Authorization(format!(
                        "path is outside grant scope: {path}"
                    )));
                }
                let subtree = match resource.scope.as_str() {
                    "exact" => false,
                    "subtree" => true,
                    _ => {
                        return Err(KernelError::Protocol(
                            "file lease scope must be exact or subtree".to_string(),
                        ))
                    }
                };
                Ok(FileLeaseResource { path, subtree })
            })
            .collect::<Result<Vec<_>, KernelError>>()?;
        if resources.is_empty() {
            return Err(KernelError::Operation(
                "file lease requires at least one resource".to_string(),
            ));
        }
        if let Some(existing) = self.file_leases.get(&params.lease_id) {
            if existing.grant_id == grant.grant_id
                && existing.root_id == params.root_id
                && existing.workspace_id == params.workspace_id
            {
                return Ok(
                    json!({"leaseId": params.lease_id, "status": "acquired", "reused": true}),
                );
            }
            return Err(KernelError::Authorization(
                "file lease id belongs to another resource owner".to_string(),
            ));
        }
        for existing in self.file_leases.values() {
            if existing.root_id != params.root_id {
                continue;
            }
            if resources.iter().any(|resource| {
                existing
                    .resources
                    .iter()
                    .any(|held| resource_overlap(resource, held))
            }) {
                return Ok(
                    json!({"leaseId": params.lease_id, "status": "busy", "blockingLeaseId": existing.lease_id}),
                );
            }
        }
        self.file_leases.insert(
            params.lease_id.clone(),
            FileLease {
                lease_id: params.lease_id.clone(),
                root_id: params.root_id,
                workspace_id: params.workspace_id,
                grant_id: grant.grant_id.clone(),
                resources,
            },
        );
        Ok(json!({"leaseId": params.lease_id, "status": "acquired", "reused": false}))
    }

    pub(super) fn file_lease_release(
        &mut self,
        params_value: &Value,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let params: KernelFileLeaseReleaseParams = parse_file_params(params_value)?;
        let Some(existing) = self.file_leases.get(&params.lease_id) else {
            return Ok(json!({"leaseId": params.lease_id, "released": false}));
        };
        if existing.grant_id != grant.grant_id
            || existing.root_id != params.root_id
            || existing.workspace_id != params.workspace_id
        {
            return Err(KernelError::Authorization(
                "file lease belongs to another resource owner".to_string(),
            ));
        }
        self.file_leases.remove(&params.lease_id);
        Ok(json!({"leaseId": params.lease_id, "released": true}))
    }

    pub(super) fn file_capture(
        &mut self,
        params_value: &Value,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let params: KernelFileCaptureParams = parse_file_params(params_value)?;
        let resource = self.resolve_file_resource(&params.root_id, &params.path, grant, true)?;
        self.assert_file_lease(
            grant,
            &params.root_id,
            &[FileLeaseResource {
                path: resource.path.clone(),
                subtree: false,
            }],
            params.lease_id.as_deref(),
        )?;
        let (state, owner_id) = self.capture_file_state(
            &resource,
            params.store,
            &params.operation_id,
            &params.workspace_id,
            &grant.grant_id,
        )?;
        Ok(
            json!({"path": resource.path, "stateJson": serde_json::to_string(&state)?, "ownerId": owner_id}),
        )
    }

    pub(super) fn file_apply(
        &mut self,
        params_value: &Value,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let params: KernelFileApplyParams = parse_file_params(params_value)?;
        let resource = self.resolve_file_resource(&params.root_id, &params.path, grant, false)?;
        self.assert_file_lease(
            grant,
            &params.root_id,
            &[FileLeaseResource {
                path: resource.path.clone(),
                subtree: false,
            }],
            params.lease_id.as_deref(),
        )?;
        let target: FileState = serde_json::from_str(&params.target_json)?;
        let expected = params
            .expected_json
            .as_deref()
            .map(serde_json::from_str::<FileState>)
            .transpose()?;
        let (_params_hash, committed, resuming) =
            self.begin_file_operation(&params.operation_id, "file.apply", params_value)?;
        if let Some(committed) = committed {
            return Ok(committed);
        }
        let current = self.observe_state(&resource)?;
        if Self::file_state_matches(&current, &target) {
            let result = json!({"status": "applied", "reconciled": resuming, "stateJson": serde_json::to_string(&current)?});
            self.finish_file_operation_owned(
                &params.operation_id,
                &result,
                params.owner_id.as_deref(),
                Some(&params.workspace_id),
            )?;
            return Ok(result);
        }
        if let Some(expected) = expected.as_ref() {
            if !Self::file_state_matches(&current, expected) {
                let result =
                    json!({"status": "conflict", "stateJson": serde_json::to_string(&current)?});
                self.finish_file_operation_owned(
                    &params.operation_id,
                    &result,
                    params.owner_id.as_deref(),
                    Some(&params.workspace_id),
                )?;
                return Ok(result);
            }
        }
        self.apply_file_state(&resource, &target, &params.workspace_id)?;
        let observed = self.observe_state(&resource)?;
        if !Self::file_state_matches(&observed, &target) {
            return Err(KernelError::Storage(format!(
                "file state did not match target after apply: {}",
                resource.path
            )));
        }
        let result = json!({"status": "applied", "reconciled": false, "stateJson": serde_json::to_string(&observed)?});
        self.finish_file_operation_owned(
            &params.operation_id,
            &result,
            params.owner_id.as_deref(),
            Some(&params.workspace_id),
        )?;
        Ok(result)
    }

    pub(super) fn file_mkdir(
        &mut self,
        params_value: &Value,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let params: KernelFileMkdirParams = parse_file_params(params_value)?;
        let resource = self.resolve_file_resource(&params.root_id, &params.path, grant, false)?;
        self.assert_file_lease(
            grant,
            &params.root_id,
            &[FileLeaseResource {
                path: resource.path.clone(),
                subtree: true,
            }],
            params.lease_id.as_deref(),
        )?;
        let (_hash, committed, resuming) =
            self.begin_file_operation(&params.operation_id, "file.mkdir", params_value)?;
        if let Some(committed) = committed {
            return Ok(committed);
        }
        match fs::symlink_metadata(&resource.absolute) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => {
                return Err(KernelError::Operation(
                    "mkdir target exists and is not a directory".to_string(),
                ))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                if params.recursive {
                    fs::create_dir_all(&resource.absolute)?;
                } else {
                    fs::create_dir(&resource.absolute)?;
                }
                if let Some(parent) = resource.absolute.parent() {
                    sync_directory(parent)?;
                }
            }
            Err(error) => return Err(error.into()),
        }
        let result = json!({"status": "created", "reconciled": resuming});
        self.finish_file_operation(&params.operation_id, &result)?;
        Ok(result)
    }

    pub(super) fn file_remove(
        &mut self,
        params_value: &Value,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let params: KernelFileRemoveParams = parse_file_params(params_value)?;
        let resource = self.resolve_file_resource(&params.root_id, &params.path, grant, false)?;
        self.assert_file_lease(
            grant,
            &params.root_id,
            &[FileLeaseResource {
                path: resource.path.clone(),
                subtree: params.recursive,
            }],
            params.lease_id.as_deref(),
        )?;
        let (_hash, committed, resuming) =
            self.begin_file_operation(&params.operation_id, "file.remove", params_value)?;
        if let Some(committed) = committed {
            return Ok(committed);
        }
        match fs::symlink_metadata(&resource.absolute) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                if params.recursive {
                    fs::remove_dir_all(&resource.absolute)?;
                } else {
                    fs::remove_dir(&resource.absolute)?;
                }
            }
            Ok(_) => fs::remove_file(&resource.absolute)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound && params.force => {}
            Err(error) => return Err(error.into()),
        }
        if let Some(parent) = resource.absolute.parent() {
            sync_directory(parent)?;
        }
        let result = json!({"status": "removed", "reconciled": resuming});
        self.finish_file_operation(&params.operation_id, &result)?;
        Ok(result)
    }

    pub(super) fn file_rename(
        &mut self,
        params_value: &Value,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let params: KernelFileRenameParams = parse_file_params(params_value)?;
        let source =
            self.resolve_file_resource(&params.root_id, &params.from_path, grant, false)?;
        let target = self.resolve_file_resource(&params.root_id, &params.to_path, grant, false)?;
        let resources = [
            FileLeaseResource {
                path: source.path.clone(),
                subtree: true,
            },
            FileLeaseResource {
                path: target.path.clone(),
                subtree: true,
            },
        ];
        self.assert_file_lease(
            grant,
            &params.root_id,
            &resources,
            params.lease_id.as_deref(),
        )?;
        let (_hash, committed, resuming) =
            self.begin_file_operation(&params.operation_id, "file.rename", params_value)?;
        if let Some(committed) = committed {
            return Ok(committed);
        }
        let source_state = self.observe_state(&source)?;
        let target_state = self.observe_state(&target)?;
        let expected_source = params
            .expected_from_json
            .as_deref()
            .map(serde_json::from_str::<FileState>)
            .transpose()?;
        let expected_target = params
            .expected_to_json
            .as_deref()
            .map(serde_json::from_str::<FileState>)
            .transpose()?;
        if expected_source
            .as_ref()
            .is_some_and(|expected| !Self::file_state_matches(&source_state, expected))
            || expected_target
                .as_ref()
                .is_some_and(|expected| !Self::file_state_matches(&target_state, expected))
        {
            let result = json!({
                "status": "conflict",
                "sourceStateJson": serde_json::to_string(&source_state)?,
                "targetStateJson": serde_json::to_string(&target_state)?,
            });
            self.finish_file_operation(&params.operation_id, &result)?;
            return Ok(result);
        }
        let source_exists = !matches!(source_state, FileState::Missing);
        let target_exists = !matches!(target_state, FileState::Missing);
        if !source_exists && target_exists {
            let result = json!({"status": "renamed", "reconciled": true});
            self.finish_file_operation(&params.operation_id, &result)?;
            return Ok(result);
        }
        if !source_exists {
            return Err(KernelError::Operation(
                "rename source is missing".to_string(),
            ));
        }
        if params.target_must_be_missing.unwrap_or(false) && target_exists {
            let result = json!({"status": "target-exists"});
            self.finish_file_operation(&params.operation_id, &result)?;
            return Ok(result);
        }
        if let Some(parent) = target.absolute.parent() {
            fs::create_dir_all(parent)?;
        }
        durable_rename(&source.absolute, &target.absolute)?;
        if let Some(parent) = source.absolute.parent() {
            sync_directory(parent)?;
        }
        if source.absolute.parent() != target.absolute.parent() {
            if let Some(parent) = target.absolute.parent() {
                sync_directory(parent)?;
            }
        }
        let result = json!({"status": "renamed", "reconciled": resuming});
        self.finish_file_operation(&params.operation_id, &result)?;
        Ok(result)
    }
}
