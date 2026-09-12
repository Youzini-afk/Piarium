use crate::error::KernelError;
use crate::model::Grant;

pub(crate) fn required_capability(method: &str) -> &'static str {
    match method {
        "storage.health" | "storage.snapshot" | "storage.getBlob" | "branch.read"
        | "branch.diff" | "pin.read" | "operation.get" => "storage.read",
        "storage.putBlob.begin"
        | "storage.putBlob.finish"
        | "storage.putBlob.abort"
        | "storage.blob.release"
        | "storage.putBlob.chunk"
        | "branch.create"
        | "branch.write"
        | "branch.publish"
        | "branch.pin"
        | "branch.unpin"
        | "branch.delete" => "storage.write",
        "storage.gc" => "storage.gc",
        "recovery.operation.begin" | "recovery.operation.update" | "recovery.operation.get" => {
            "recovery"
        }
        _ => "storage.read",
    }
}

pub(crate) fn require_capability(grant: &Grant, method: &str) -> Result<(), KernelError> {
    let required = required_capability(method);
    if grant.capabilities.contains(required) || grant.capabilities.contains("storage.admin") {
        return Ok(());
    }
    Err(KernelError::Authorization(format!(
        "grant lacks capability: {required}"
    )))
}

pub(crate) fn path_allowed(grant: &Grant, path: &str) -> bool {
    path_allowed_scopes(&grant.path_scopes, path)
}

pub(crate) fn path_allowed_scopes(scopes: &[String], path: &str) -> bool {
    scopes
        .iter()
        .any(|scope| scope.is_empty() || path == scope || path.starts_with(&format!("{scope}/")))
}
