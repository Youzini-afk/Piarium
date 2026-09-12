use super::{idempotent, recovery_idempotent, Storage};
use crate::authority::require_capability;
use crate::error::{response_error, KernelError};
use crate::protocol::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use uuid::Uuid;

struct Kernel {
    epoch: String,
    host_id: Option<String>,
    host_generation: Option<String>,
    build_version: Option<String>,
    storage_root: Option<PathBuf>,
    storage: Option<Storage>,
    handshaken: bool,
}

impl Kernel {
    fn new() -> Self {
        Self {
            epoch: Uuid::new_v4().to_string(),
            host_id: None,
            host_generation: None,
            build_version: None,
            storage_root: None,
            storage: None,
            handshaken: false,
        }
    }

    fn handle(
        &mut self,
        request: &Value,
        cancellation: Arc<AtomicBool>,
    ) -> Result<Option<Value>, KernelError> {
        if cancellation.load(Ordering::Acquire) {
            return Err(KernelError::Cancelled);
        }
        let version = request.get("v").and_then(Value::as_u64).unwrap_or(0);
        if version != PROTOCOL_VERSION {
            return Err(KernelError::Protocol(format!(
                "protocol version mismatch: host={version}, kernel={PROTOCOL_VERSION}"
            )));
        }
        let kind = request.get("kind").and_then(Value::as_str).unwrap_or("");
        let id = request
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Protocol("request id is required".to_string()))?;
        if id.is_empty() {
            return Err(KernelError::Protocol("request id is empty".to_string()));
        }
        if kind == "request" {
            reject_unknown_fields(
                request,
                &["v", "kind", "id", "method", "params", "epoch", "grantId"],
                "request",
            )?;
        } else if kind == "cancel" {
            reject_unknown_fields(request, &["v", "kind", "id", "epoch", "grantId"], "cancel")?;
        } else if kind == "data" {
            reject_unknown_fields(
                request,
                &[
                    "v",
                    "kind",
                    "id",
                    "streamId",
                    "sequence",
                    "bytesBase64",
                    "epoch",
                    "grantId",
                ],
                "data",
            )?;
        }
        if kind == "cancel" {
            return Ok(None);
        }
        if kind == "data" {
            if !self.handshaken {
                return Err(KernelError::Protocol(
                    "handshake is required before data frames".to_string(),
                ));
            }
            let request_epoch = request
                .get("epoch")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    KernelError::Authorization("epoch is required after handshake".to_string())
                })?;
            if request_epoch != self.epoch {
                return Err(KernelError::Authorization("stale kernel epoch".to_string()));
            }
            let storage = self
                .storage
                .as_mut()
                .ok_or_else(|| KernelError::Storage("storage is not open".to_string()))?;
            let grant_id = request
                .get("grantId")
                .and_then(Value::as_str)
                .ok_or_else(|| KernelError::Authorization("grantId is required".to_string()))?;
            let params_value = json!({"streamId": request.get("streamId"), "sequence": request.get("sequence"), "bytesBase64": request.get("bytesBase64")});
            let host_id = self.host_id.as_deref().ok_or_else(|| {
                KernelError::Authorization("Host identity is unavailable".to_string())
            })?;
            let (grant, _) = storage.authorize(
                Some(grant_id),
                &self.epoch,
                host_id,
                self.host_generation.as_deref().unwrap_or_default(),
                "storage.putBlob.chunk",
                &params_value,
            )?;
            require_capability(&grant, "storage.putBlob.chunk")?;
            storage.stream_blob_chunk(&params_value, grant_id)?;
            return Ok(None);
        }
        if kind != "request" {
            return Err(KernelError::Protocol("expected request frame".to_string()));
        }
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Protocol("request method is required".to_string()))?;
        let params_value = request.get("params").cloned().unwrap_or_else(|| json!({}));
        if method == "kernel.handshake" {
            if self.handshaken {
                return Err(KernelError::Protocol(
                    "handshake already completed".to_string(),
                ));
            }
            reject_unknown_fields(
                &params_value,
                &[
                    "protocolVersion",
                    "buildVersion",
                    "hostId",
                    "hostGeneration",
                    "storageRoot",
                    "capabilities",
                ],
                "handshake",
            )?;
            let protocol = params_value
                .get("protocolVersion")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            if protocol != PROTOCOL_VERSION {
                return Err(KernelError::Protocol(format!(
                    "protocol mismatch: host={protocol}, kernel={PROTOCOL_VERSION}"
                )));
            }
            let host_id = params_value
                .get("hostId")
                .and_then(Value::as_str)
                .ok_or_else(|| KernelError::Protocol("hostId is required".to_string()))?
                .to_string();
            if host_id.trim().is_empty() {
                return Err(KernelError::Protocol("hostId is empty".to_string()));
            }
            let host_generation = params_value
                .get("hostGeneration")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| KernelError::Protocol("hostGeneration is required".to_string()))?
                .to_string();
            let build_version = params_value
                .get("buildVersion")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| KernelError::Protocol("buildVersion is required".to_string()))?
                .to_string();
            let requested_capabilities = params_value
                .get("capabilities")
                .and_then(Value::as_array)
                .ok_or_else(|| KernelError::Protocol("capabilities are required".to_string()))?;
            for capability in requested_capabilities {
                let capability = capability
                    .as_str()
                    .ok_or_else(|| KernelError::Protocol("capability is malformed".to_string()))?;
                if !KERNEL_CAPABILITIES.contains(&capability) {
                    return Err(KernelError::Protocol(format!(
                        "unsupported capability requested: {capability}"
                    )));
                }
            }
            let root = params_value
                .get("storageRoot")
                .and_then(Value::as_str)
                .ok_or_else(|| KernelError::Protocol("storageRoot is required".to_string()))?;
            if !Path::new(root).is_absolute() {
                return Err(KernelError::Authorization(
                    "storageRoot must be absolute".to_string(),
                ));
            }
            fs::create_dir_all(root)?;
            let canonical_root = fs::canonicalize(root)?.to_string_lossy().to_string();
            let storage = Storage::open(Path::new(&canonical_root), &host_id)?;
            self.host_id = Some(host_id.clone());
            self.host_generation = Some(host_generation.clone());
            self.build_version = Some(build_version.clone());
            self.storage_root = Some(PathBuf::from(&canonical_root));
            self.storage = Some(storage);
            self.handshaken = true;
            return Ok(Some(response_ok(
                id,
                json!({"protocolVersion": PROTOCOL_VERSION, "kernelVersion": KERNEL_VERSION, "buildVersion": build_version, "kernelEpoch": self.epoch, "hostId": host_id, "hostGeneration": host_generation, "storageRoot": canonical_root, "capabilities": KERNEL_CAPABILITIES}),
            )));
        }
        if !self.handshaken {
            return Err(KernelError::Protocol(
                "handshake is required before requests".to_string(),
            ));
        }
        validate_method_params(method, &params_value)?;
        let request_epoch = request
            .get("epoch")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                KernelError::Authorization("epoch is required after handshake".to_string())
            })?;
        if request_epoch != self.epoch {
            return Err(KernelError::Authorization("stale kernel epoch".to_string()));
        }
        if method == "kernel.ping" {
            return Ok(Some(response_ok(
                id,
                json!({"kernelEpoch": self.epoch, "ready": true}),
            )));
        }
        if method == "kernel.shutdown" {
            return Ok(Some(response_ok(id, json!({"stopping": true}))));
        }
        let storage = self
            .storage
            .as_mut()
            .ok_or_else(|| KernelError::Storage("storage is not open".to_string()))?;
        let host_id = self.host_id.as_deref().ok_or_else(|| {
            KernelError::Authorization("Host identity is unavailable".to_string())
        })?;
        let grant_id = request.get("grantId").and_then(Value::as_str);
        if method == "authority.grant.issue" {
            reject_unknown_fields(
                &params_value,
                &[
                    "grantId",
                    "hostGeneration",
                    "sessionId",
                    "threadId",
                    "runId",
                    "owningWorkspace",
                    "executionWorkspace",
                    "storageIdentity",
                    "capabilities",
                    "pathScopes",
                ],
                "grant",
            )?;
            let storage_identity = storage.root.to_string_lossy().to_string();
            return Ok(Some(response_ok(
                id,
                storage.issue_grant(
                    &params_value,
                    host_id,
                    self.host_generation.as_deref().unwrap_or_default(),
                    &storage_identity,
                    &self.epoch,
                )?,
            )));
        }
        if method == "authority.grant.revoke" {
            reject_unknown_fields(&params_value, &["grantId"], "grant revoke")?;
            return Ok(Some(response_ok(
                id,
                storage.revoke_grant(&params_value, host_id)?,
            )));
        }
        let authorized_params =
            if method == "authority.grant.issue" || method == "authority.grant.revoke" {
                params_value.clone()
            } else {
                let (_grant, authorized_params) = storage.authorize(
                    grant_id,
                    &self.epoch,
                    host_id,
                    self.host_generation.as_deref().unwrap_or_default(),
                    method,
                    &params_value,
                )?;
                authorized_params
            };
        storage.set_cancellation(cancellation);
        let result = match method {
            "storage.health" => storage.health(&authorized_params),
            "storage.snapshot" => storage.snapshot(&authorized_params),
            "storage.putBlob" => idempotent(storage, method, &authorized_params, |storage| {
                storage.put_blob(&authorized_params)
            }),
            "storage.putBlob.begin" => {
                storage.begin_blob_stream(&authorized_params, grant_id.unwrap_or(""))
            }
            "storage.putBlob.finish" => {
                idempotent(storage, method, &authorized_params, |storage| {
                    storage.finish_blob_stream(&authorized_params, grant_id.unwrap_or(""))
                })
            }
            "storage.putBlob.abort" => {
                storage.abort_blob_stream(&authorized_params, grant_id.unwrap_or(""))
            }
            "storage.getBlob" => storage.get_blob(&authorized_params),
            "branch.create" => idempotent(storage, method, &authorized_params, |storage| {
                storage.create_branch(&authorized_params)
            }),
            "branch.read" => storage.branch_read(&authorized_params),
            "branch.write" => idempotent(storage, method, &authorized_params, |storage| {
                storage.branch_write(&authorized_params)
            }),
            "branch.publish" => idempotent(storage, method, &authorized_params, |storage| {
                storage.branch_publish(&authorized_params)
            }),
            "branch.pin" => idempotent(storage, method, &authorized_params, |storage| {
                storage.branch_pin(&authorized_params, true)
            }),
            "branch.unpin" => idempotent(storage, method, &authorized_params, |storage| {
                storage.branch_pin(&authorized_params, false)
            }),
            "branch.diff" => storage.branch_diff(&authorized_params),
            "branch.delete" => idempotent(storage, method, &authorized_params, |storage| {
                storage.branch_delete(&authorized_params)
            }),
            "pin.read" => storage.pin_read(&authorized_params),
            "storage.gc" => idempotent(storage, method, &authorized_params, |storage| storage.gc()),
            "recovery.operation.begin" | "recovery.operation.update" => {
                recovery_idempotent(storage, method, &authorized_params, |storage| {
                    storage.recovery_operation(method, &authorized_params)
                })
            }
            "recovery.operation.get" => storage.recovery_get(&authorized_params),
            "operation.get" => storage.operation_get(&authorized_params),
            _ => Err(KernelError::Protocol(format!("unknown method: {method}"))),
        };
        storage.clear_cancellation();
        Ok(Some(response_ok(id, result?)))
    }
}

pub(crate) fn run() -> Result<(), Box<dyn std::error::Error>> {
    let (request_tx, request_rx) = mpsc::channel::<(Value, Arc<AtomicBool>)>();
    let (response_tx, response_rx) = mpsc::channel::<Value>();
    let cancellations = Arc::new(Mutex::new(HashMap::<String, Arc<AtomicBool>>::new()));
    let worker_cancellations = cancellations.clone();
    let worker = thread::spawn(move || {
        let mut kernel = Kernel::new();
        for (request, cancellation) in request_rx {
            let id = request
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let method = request
                .get("method")
                .and_then(Value::as_str)
                .map(str::to_string);
            let response = match kernel.handle(&request, cancellation) {
                Ok(Some(response)) => response,
                Ok(None) => continue,
                Err(error) => response_error(&id, &error),
            };
            let stopping = method.as_deref() == Some("kernel.shutdown");
            let _ = response_tx.send(response);
            worker_cancellations
                .lock()
                .ok()
                .map(|mut active| active.remove(&id));
            if stopping {
                break;
            }
        }
    });
    let writer = thread::spawn(move || {
        let stdout = io::stdout();
        let mut output = stdout.lock();
        for response in response_rx {
            if write_frame(&mut output, &response).is_err() {
                break;
            }
        }
    });
    let stdin = io::stdin();
    let mut input = stdin.lock();
    while let Some(payload) = read_frame(&mut input)? {
        let request: Value = match serde_json::from_slice(&payload) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("invalid JSON frame: {error}");
                break;
            }
        };
        let id = request
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if request.get("kind").and_then(Value::as_str) == Some("cancel") {
            if let Some(token) = cancellations
                .lock()
                .ok()
                .and_then(|active| active.get(&id).cloned())
            {
                token.store(true, Ordering::Release);
            }
            continue;
        }
        let token = Arc::new(AtomicBool::new(false));
        if !id.is_empty() {
            if let Ok(mut active) = cancellations.lock() {
                active.insert(id, token.clone());
            }
        }
        if request_tx.send((request, token)).is_err() {
            break;
        }
    }
    drop(request_tx);
    let _ = worker.join();
    let _ = writer.join();
    Ok(())
}
