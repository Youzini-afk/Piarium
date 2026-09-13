//! Working-state branches, revisions, current roots, pins, builders, and diffs.
use super::operations::idempotent;
use super::*;

impl Storage {
    pub(super) fn validate_batch_paths(
        entries: &[(Vec<String>, PathState)],
    ) -> Result<(), KernelError> {
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

    pub(super) fn validate_state_ownership(
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

    pub(super) fn begin_branch_builder(
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

    pub(super) fn append_branch_builder(
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

    pub(super) fn finish_branch_builder(
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

    pub(super) fn abort_branch_builder(
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

    pub(super) fn create_branch(
        &mut self,
        params: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
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

    pub(super) fn branch_read(&self, params: &Value) -> Result<Value, KernelError> {
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
        } else if let Some(roots) = params.get("roots").and_then(Value::as_array) {
            let requested = roots
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>();
            let scoped = self.root_entries_scoped(&root, &requested)?;
            let cursor = params.get("cursor").and_then(Value::as_u64).unwrap_or(0) as usize;
            let page_size = params.get("pageSize").and_then(Value::as_u64).map(|value| value as usize).unwrap_or(scoped.len());
            if params.get("pageSize").is_some() && page_size == 0 { return Err(KernelError::Operation("pageSize must be positive when supplied".to_string())); }
            let start = cursor.min(scoped.len());
            let end = start.saturating_add(page_size).min(scoped.len());
            if end < scoped.len() { next_cursor = Some(end as u64); }
            scoped[start..end].iter().cloned().map(|(path, state)| json!({"path": path, "state": state})).collect()
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

    pub(super) fn begin_branch_write_builder(
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

    pub(super) fn append_branch_write_builder(
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

    pub(super) fn finish_branch_write_builder(
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

    pub(super) fn abort_branch_write_builder(
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

    pub(super) fn branch_write(
        &mut self,
        params: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
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

    pub(super) fn branch_publish(&mut self, params: &Value) -> Result<Value, KernelError> {
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

    pub(super) fn branch_pin(
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

    pub(super) fn branch_delete(&mut self, params: &Value) -> Result<Value, KernelError> {
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

    pub(super) fn pin_read(&self, params: &Value, grant_id: &str) -> Result<Value, KernelError> {
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

    pub(super) fn snapshot(&self, params_value: &Value) -> Result<Value, KernelError> {
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

    pub(super) fn branch_diff(&self, params: &Value) -> Result<Value, KernelError> {
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

    pub(super) fn diff_nodes(
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

    pub(super) fn index_entries(
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

    pub(super) fn diff_indices(
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

    pub(super) fn index_root_in_range(
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

    pub(super) fn collect_index_range(
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

    pub(super) fn diff_index_range(
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

    pub(super) fn collect_paths(
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
}
