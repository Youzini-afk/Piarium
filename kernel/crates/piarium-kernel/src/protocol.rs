use crate::error::KernelError;
use crate::model::TrieNode;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) const PROTOCOL_VERSION: u64 = 1;
pub(crate) const KERNEL_VERSION: &str = "0.1.0";
pub(crate) const KERNEL_BUILD_IDENTITY: &str = match option_env!("PIARIUM_KERNEL_BUILD_IDENTITY") {
    Some(value) => value,
    None => env!("CARGO_PKG_VERSION"),
};
pub(crate) const KERNEL_TARGET: &str = match option_env!("PIARIUM_KERNEL_TARGET") {
    Some(value) => value,
    None => "unknown-target",
};
pub(crate) const KERNEL_ARCH: &str = match option_env!("PIARIUM_KERNEL_ARCH") {
    Some(value) => value,
    None => "unknown-arch",
};
pub(crate) const STORAGE_FORMAT_VERSION: &str = "5";
// Control frames are deliberately bounded. Content bytes travel through the
// begin/data/finish stream and therefore do not need a giant JSON envelope.
pub(crate) const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
pub(crate) const MAX_BLOB_RESPONSE_BYTES: usize = (MAX_FRAME_BYTES * 3 / 4).saturating_sub(1024);
pub(crate) const KERNEL_CAPABILITIES: [&str; 6] = [
    "storage",
    "workingState",
    "recovery",
    "branchCas",
    "pins",
    "gc",
];

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}
pub(crate) fn hash_json(value: &Value) -> Result<String, KernelError> {
    Ok(format!(
        "sha256-{}",
        hex::encode(Sha256::digest(serde_json::to_vec(value)?))
    ))
}
pub(crate) fn node_hash(node: &TrieNode) -> String {
    let mut bytes = b"piarium-trie-node-v2\0".to_vec();
    bytes.extend(serde_json::to_vec(node).unwrap_or_default());
    format!("sha256-{}", hex::encode(Sha256::digest(bytes)))
}
pub(crate) fn object_path(root: &Path, hash: &str) -> Result<PathBuf, KernelError> {
    let hex = hash
        .strip_prefix("sha256-")
        .filter(|value| value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| KernelError::Operation(format!("malformed content hash: {hash}")))?;
    Ok(root.join("objects").join(&hex[..2]).join(&hex[2..]))
}
pub(crate) fn response_ok(id: &str, result: Value) -> Value {
    json!({"v": PROTOCOL_VERSION, "kind": "response", "id": id, "ok": true, "result": result})
}

pub(crate) fn reject_unknown_fields(
    value: &Value,
    allowed: &[&str],
    context: &str,
) -> Result<(), KernelError> {
    let object = value
        .as_object()
        .ok_or_else(|| KernelError::Protocol(format!("{context} must be an object")))?;
    if let Some(field) = object
        .keys()
        .find(|field| !allowed.iter().any(|allowed| allowed == field))
    {
        return Err(KernelError::Protocol(format!(
            "unknown {context} field: {field}"
        )));
    }
    Ok(())
}

pub(crate) fn validate_method_params(method: &str, params: &Value) -> Result<(), KernelError> {
    let fields: &[&str] = match method {
        "kernel.ping" | "kernel.shutdown" => &[],
        "storage.health" => &["deep"],
        "storage.snapshot" => &["workspaceId"],
        "authority.grant.revoke" => &["grantId"],
        "storage.putBlob.begin" => &["operationId", "byteLength", "expectedHash", "workspaceId"],
        "storage.putBlob.finish" => &["operationId", "streamId", "expectedHash", "workspaceId"],
        "storage.putBlob.abort" => &["operationId", "streamId", "workspaceId"],
        "storage.blob.release" => &["ownerId", "operationId", "workspaceId"],
        "storage.getBlob" => &["hash", "offset", "length"],
        "branch.create" => &[
            "operationId",
            "branchId",
            "workspaceId",
            "entries",
            "baseRef",
        ],
        "branch.read" => &["branchId", "revision", "paths", "includeEntries"],
        "branch.write" => &[
            "operationId",
            "branchId",
            "expectedWriteRevision",
            "changes",
        ],
        "branch.publish" => &[
            "operationId",
            "branchId",
            "expectedWriteRevision",
            "expectedRoot",
        ],
        "branch.pin" => &["operationId", "branchId", "revision", "pinId"],
        "branch.unpin" => &["operationId", "branchId", "pinId"],
        "branch.diff" => &["leftRoot", "rightRoot"],
        "branch.delete" => &["operationId", "branchId"],
        "pin.read" => &["pinId", "includeEntries"],
        "recovery.operation.begin" | "recovery.operation.update" => {
            &["operationId", "recordId", "workspaceId", "state", "data"]
        }
        "recovery.operation.get" => &["recordId", "operationId"],
        "operation.get" => &["operationId"],
        "storage.gc" => &["operationId"],
        "authority.grant.issue" => &[
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
        _ => return Ok(()),
    };
    reject_unknown_fields(params, fields, method)
}
pub(crate) fn read_frame(input: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut header = [0u8; 4];
    match input.read_exact(&mut header) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let length = u32::from_be_bytes(header) as usize;
    if length > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("kernel frame exceeds {} bytes", MAX_FRAME_BYTES),
        ));
    }
    let mut payload = vec![0u8; length];
    input.read_exact(&mut payload)?;
    Ok(Some(payload))
}
pub(crate) fn write_frame(output: &mut impl Write, value: &Value) -> io::Result<()> {
    let payload = serde_json::to_vec(value)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if payload.len() > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("kernel frame exceeds {} bytes", MAX_FRAME_BYTES),
        ));
    }
    let length = u32::try_from(payload.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "kernel frame is too large"))?;
    output.write_all(&length.to_be_bytes())?;
    output.write_all(&payload)?;
    output.flush()
}
