// Generated from kernel/protocol/schema.json. Do not hand-edit.
#![allow(dead_code)]

use crate::model::PathState;
use serde::Deserialize;
use serde_json::Value;

#[derive(Clone, Debug, Deserialize)]
#[serde(transparent)]
pub(crate) struct RequiredNullable<T>(pub(crate) Option<T>);

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelHandshakeParams {
    pub(crate) protocol_version: i64,
    pub(crate) build_version: String,
    pub(crate) host_id: String,
    pub(crate) host_generation: String,
    pub(crate) storage_root: String,
    pub(crate) capabilities: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelEmptyParams {}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelHealthParams {
    pub(crate) deep: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelGrantIssueParams {
    pub(crate) grant_id: String,
    pub(crate) host_generation: String,
    pub(crate) authority_instance_id: Option<RequiredNullable<String>>,
    pub(crate) worker_id: Option<RequiredNullable<String>>,
    pub(crate) worker_generation: Option<RequiredNullable<i64>>,
    pub(crate) session_id: RequiredNullable<String>,
    pub(crate) thread_id: RequiredNullable<String>,
    pub(crate) run_id: RequiredNullable<String>,
    pub(crate) owning_workspace: RequiredNullable<String>,
    pub(crate) execution_workspace: RequiredNullable<String>,
    pub(crate) storage_identity: String,
    pub(crate) capabilities: Vec<String>,
    pub(crate) path_scopes: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelGrantRevokeParams {
    pub(crate) grant_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelSnapshotParams {
    pub(crate) workspace_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelPutBlobBeginParams {
    pub(crate) operation_id: String,
    pub(crate) stream_id: String,
    pub(crate) byte_length: i64,
    pub(crate) expected_hash: Option<String>,
    pub(crate) workspace_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelPutBlobFinishParams {
    pub(crate) operation_id: String,
    pub(crate) stream_id: String,
    pub(crate) expected_hash: Option<String>,
    pub(crate) workspace_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelPutBlobAbortParams {
    pub(crate) operation_id: String,
    pub(crate) stream_id: String,
    pub(crate) workspace_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBlobReleaseParams {
    pub(crate) owner_id: String,
    pub(crate) workspace_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelGetBlobParams {
    pub(crate) hash: String,
    pub(crate) branch_id: Option<String>,
    pub(crate) revision: Option<i64>,
    pub(crate) pin_id: Option<String>,
    pub(crate) owner_id: Option<String>,
    pub(crate) record_id: Option<String>,
    pub(crate) slot: Option<String>,
    pub(crate) path: Option<String>,
    pub(crate) offset: Option<i64>,
    pub(crate) length: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecordPutParams {
    pub(crate) operation_id: String,
    pub(crate) record_id: String,
    pub(crate) workspace_id: String,
    pub(crate) record_type: String,
    pub(crate) state: String,
    pub(crate) session_id: Option<String>,
    pub(crate) thread_id: Option<String>,
    pub(crate) run_id: Option<String>,
    pub(crate) branch_id: Option<String>,
    pub(crate) revision: Option<i64>,
    pub(crate) result_revision: Option<i64>,
    pub(crate) expected_record_revision: Option<i64>,
    pub(crate) payload_json: String,
    pub(crate) owner_ids: Vec<String>,
    pub(crate) references: Vec<KernelRecordReference>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecordGetParams {
    pub(crate) workspace_id: String,
    pub(crate) record_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecordListParams {
    pub(crate) workspace_id: String,
    pub(crate) record_type: Option<String>,
    pub(crate) session_id: Option<String>,
    pub(crate) thread_id: Option<String>,
    pub(crate) run_id: Option<String>,
    pub(crate) branch_id: Option<String>,
    pub(crate) cursor: Option<i64>,
    pub(crate) page_size: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecordReleaseParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) record_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingResultPutParams {
    pub(crate) operation_id: String,
    pub(crate) record_id: String,
    pub(crate) workspace_id: String,
    pub(crate) branch_id: String,
    pub(crate) result_revision: i64,
    pub(crate) root: String,
    pub(crate) parent_ref: Option<String>,
    pub(crate) changed_paths: Vec<String>,
    pub(crate) diff_stats: KernelWorkingDiffStats,
    pub(crate) created_at: String,
    pub(crate) document: KernelWorkingResultDocument,
    pub(crate) session_id: Option<String>,
    pub(crate) thread_id: Option<String>,
    pub(crate) run_id: Option<String>,
    pub(crate) expected_record_revision: Option<i64>,
    pub(crate) owner_ids: Vec<String>,
    pub(crate) references: Vec<KernelRecordReference>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingResultGetParams {
    pub(crate) workspace_id: String,
    pub(crate) record_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingResultListParams {
    pub(crate) workspace_id: String,
    pub(crate) branch_id: Option<String>,
    pub(crate) cursor: Option<i64>,
    pub(crate) page_size: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingResultReleaseParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) record_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingDraftPutParams {
    pub(crate) operation_id: String,
    pub(crate) record_id: String,
    pub(crate) workspace_id: String,
    pub(crate) document: KernelWorkingDraftDocument,
    pub(crate) root: Option<String>,
    pub(crate) pin_id: Option<String>,
    pub(crate) created_at: String,
    pub(crate) expected_record_revision: Option<i64>,
    pub(crate) owner_ids: Vec<String>,
    pub(crate) references: Vec<KernelRecordReference>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingDraftGetParams {
    pub(crate) workspace_id: String,
    pub(crate) record_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingDraftListParams {
    pub(crate) workspace_id: String,
    pub(crate) cursor: Option<i64>,
    pub(crate) page_size: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingDraftReleaseParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) record_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingVerificationPutParams {
    pub(crate) operation_id: String,
    pub(crate) record_id: String,
    pub(crate) workspace_id: String,
    pub(crate) kind: String,
    pub(crate) thread_id: String,
    pub(crate) run_id: Option<String>,
    pub(crate) branch_id: String,
    pub(crate) result_revision: i64,
    pub(crate) root: String,
    pub(crate) document: KernelWorkingVerificationDocument,
    pub(crate) expected_record_revision: Option<i64>,
    pub(crate) owner_ids: Vec<String>,
    pub(crate) references: Vec<KernelRecordReference>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingVerificationListParams {
    pub(crate) workspace_id: String,
    pub(crate) thread_id: String,
    pub(crate) kind: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingVerificationReleaseParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) record_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingReviewPutParams {
    pub(crate) operation_id: String,
    pub(crate) record_id: String,
    pub(crate) workspace_id: String,
    pub(crate) thread_id: String,
    pub(crate) run_id: Option<String>,
    pub(crate) branch_id: String,
    pub(crate) result_revision: i64,
    pub(crate) root: String,
    pub(crate) document: KernelWorkingReviewDocument,
    pub(crate) expected_record_revision: Option<i64>,
    pub(crate) owner_ids: Vec<String>,
    pub(crate) references: Vec<KernelRecordReference>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingReviewListParams {
    pub(crate) workspace_id: String,
    pub(crate) thread_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingReviewReleaseParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) record_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelCreateBranchBeginParams {
    pub(crate) operation_id: String,
    pub(crate) builder_id: String,
    pub(crate) branch_id: String,
    pub(crate) workspace_id: String,
    pub(crate) base_ref: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelCreateBranchAppendParams {
    pub(crate) builder_id: String,
    pub(crate) sequence: i64,
    pub(crate) entries: Vec<KernelCreateEntry>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelCreateBranchFinishParams {
    pub(crate) operation_id: String,
    pub(crate) builder_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelCreateBranchAbortParams {
    pub(crate) builder_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchReadParams {
    pub(crate) branch_id: String,
    pub(crate) revision: Option<i64>,
    pub(crate) paths: Option<Vec<String>>,
    pub(crate) include_entries: Option<bool>,
    pub(crate) cursor: Option<i64>,
    pub(crate) page_size: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchWriteBeginParams {
    pub(crate) operation_id: String,
    pub(crate) builder_id: String,
    pub(crate) branch_id: String,
    pub(crate) expected_write_revision: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchWriteAppendParams {
    pub(crate) builder_id: String,
    pub(crate) sequence: i64,
    pub(crate) changes: Vec<KernelBranchChange>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchWriteFinishParams {
    pub(crate) operation_id: String,
    pub(crate) builder_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchWriteAbortParams {
    pub(crate) builder_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchPublishParams {
    pub(crate) operation_id: String,
    pub(crate) branch_id: String,
    pub(crate) expected_write_revision: i64,
    pub(crate) expected_root: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchPinParams {
    pub(crate) operation_id: String,
    pub(crate) branch_id: String,
    pub(crate) revision: Option<i64>,
    pub(crate) expected_write_revision: Option<i64>,
    pub(crate) expected_root: Option<String>,
    pub(crate) pin_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchUnpinParams {
    pub(crate) operation_id: String,
    pub(crate) branch_id: String,
    pub(crate) pin_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchDiffParams {
    pub(crate) left_root: String,
    pub(crate) right_root: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchDeleteParams {
    pub(crate) operation_id: String,
    pub(crate) branch_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelPinReadParams {
    pub(crate) pin_id: String,
    pub(crate) paths: Option<Vec<String>>,
    pub(crate) include_entries: Option<bool>,
    pub(crate) cursor: Option<i64>,
    pub(crate) page_size: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryOperationGetParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryTurnStartParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) execution_id: String,
    pub(crate) session_id: String,
    pub(crate) user_entry_id: String,
    pub(crate) worker_id: String,
    pub(crate) runtime_generation: i64,
    pub(crate) active_writer_scopes: Vec<String>,
    pub(crate) provenance: String,
    pub(crate) failure: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryTurnGetParams {
    pub(crate) workspace_id: String,
    pub(crate) execution_id: String,
    pub(crate) session_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryTurnSettleParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) execution_id: String,
    pub(crate) expected_revision: i64,
    pub(crate) status: String,
    pub(crate) observed_resource_ids: Vec<String>,
    pub(crate) observation_complete: bool,
    pub(crate) assistant_entry_id: Option<String>,
    pub(crate) failure_json: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryCheckpointCreateParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) label: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryCheckpointListParams {
    pub(crate) workspace_id: String,
    pub(crate) cursor: Option<i64>,
    pub(crate) page_size: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryEntryResolveParams {
    pub(crate) workspace_id: String,
    pub(crate) session_id: String,
    pub(crate) entry_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryChangeBeforeParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) session_id: String,
    pub(crate) execution_id: String,
    pub(crate) checkpoint_id: String,
    pub(crate) path: String,
    pub(crate) tool_name: String,
    pub(crate) mutation_id: String,
    pub(crate) before_json: String,
    pub(crate) references: Vec<KernelRecoveryReference>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryChangeGetParams {
    pub(crate) workspace_id: String,
    pub(crate) checkpoint_id: String,
    pub(crate) path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryChangeAfterParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) session_id: String,
    pub(crate) execution_id: String,
    pub(crate) checkpoint_id: String,
    pub(crate) path: String,
    pub(crate) after_json: String,
    pub(crate) succeeded: bool,
    pub(crate) expected_revision: i64,
    pub(crate) references: Vec<KernelRecoveryReference>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryOperationCreateParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) kind: String,
    pub(crate) state: String,
    pub(crate) data_json: String,
    pub(crate) files: Vec<KernelRecoveryOperationFile>,
    pub(crate) session_id: Option<String>,
    pub(crate) thread_id: Option<String>,
    pub(crate) run_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryOperationFileCasParams {
    pub(crate) transition_id: String,
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) path: String,
    pub(crate) expected_revision: i64,
    pub(crate) expected_phase: String,
    pub(crate) phase: String,
    pub(crate) observed_fingerprint: Option<String>,
    pub(crate) expected_json: Option<String>,
    pub(crate) target_json: Option<String>,
    pub(crate) safety_json: Option<String>,
    pub(crate) references: Option<Vec<KernelRecoveryReference>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryOperationCompleteParams {
    pub(crate) transition_id: String,
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) expected_revision: i64,
    pub(crate) state: String,
    pub(crate) result_json: Option<String>,
    pub(crate) failure_json: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryOperationListParams {
    pub(crate) workspace_id: String,
    pub(crate) kind: Option<String>,
    pub(crate) cursor: Option<i64>,
    pub(crate) page_size: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryOperationReleaseParams {
    pub(crate) transition_id: String,
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelOperationGetParams {
    pub(crate) operation_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelOperationReleaseParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelGcParams {
    pub(crate) operation_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecordReference {
    pub(crate) slot: String,
    pub(crate) object_hash: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingDiffStats {
    pub(crate) files: i64,
    pub(crate) insertions: i64,
    pub(crate) deletions: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingResultDocument {
    pub(crate) result_revision: i64,
    pub(crate) branch_id: String,
    pub(crate) parent_ref: Option<String>,
    pub(crate) changed_paths: Vec<String>,
    pub(crate) diff_stats: KernelWorkingDiffStats,
    pub(crate) created_at: String,
    pub(crate) root: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingDraftDocument {
    pub(crate) id: String,
    pub(crate) workspace_id: String,
    pub(crate) created_at: String,
    pub(crate) root: String,
    pub(crate) pin_id: Option<String>,
    pub(crate) provenance: Vec<KernelDraftProvenance>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingVerificationDocument {
    pub(crate) result_revision: Option<i64>,
    pub(crate) merged_result_revision: Option<i64>,
    pub(crate) merge_operation_id: Option<String>,
    pub(crate) branch_id: Option<String>,
    pub(crate) result_tree_hash: Option<String>,
    pub(crate) parent_tree_hash: Option<String>,
    pub(crate) recorded_at: i64,
    pub(crate) window_opened_at: Option<i64>,
    pub(crate) draft_unsaved: Option<bool>,
    pub(crate) note: Option<String>,
    pub(crate) binding: String,
    pub(crate) binding_reason: Option<String>,
    pub(crate) checks: Vec<KernelCommandVerificationRecord>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingReviewDocument {
    pub(crate) result_revision: i64,
    pub(crate) status: String,
    pub(crate) recorded_at: i64,
    pub(crate) review_thread_id: Option<String>,
    pub(crate) review_run_id: Option<String>,
    pub(crate) gate: Option<bool>,
    pub(crate) conclusion: Option<String>,
    pub(crate) findings: Option<Vec<KernelReviewFinding>>,
    pub(crate) error: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelCreateEntry {
    pub(crate) path: String,
    pub(crate) state: PathState,
    pub(crate) owner_id: Option<String>,
    pub(crate) source_path: Option<String>,
    pub(crate) source_record_id: Option<String>,
    pub(crate) source_slot: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchChange {
    pub(crate) path: String,
    pub(crate) state: PathState,
    pub(crate) owner_id: Option<String>,
    pub(crate) source_path: Option<String>,
    pub(crate) source_record_id: Option<String>,
    pub(crate) source_slot: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryReference {
    pub(crate) slot: String,
    pub(crate) object_hash: String,
    pub(crate) owner_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryOperationFile {
    pub(crate) path: String,
    pub(crate) expected_json: Option<String>,
    pub(crate) target_json: Option<String>,
    pub(crate) safety_json: Option<String>,
    pub(crate) phase: Option<String>,
    pub(crate) references: Option<Vec<KernelRecoveryReference>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelDraftProvenance {
    pub(crate) path: String,
    pub(crate) base_revision: RequiredNullable<String>,
    pub(crate) encoding: String,
    pub(crate) bom: bool,
    pub(crate) local_edit_revision: i64,
    pub(crate) revision: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelCommandVerificationRecord {
    pub(crate) id: String,
    pub(crate) run_id: String,
    pub(crate) command: String,
    pub(crate) cwd: String,
    pub(crate) env_summary: Option<KernelVerificationEnvSummary>,
    pub(crate) command_run_id: Option<String>,
    pub(crate) started_at: i64,
    pub(crate) ended_at: i64,
    pub(crate) exit_code: RequiredNullable<i64>,
    pub(crate) cancelled: bool,
    pub(crate) output_handle: Option<String>,
    pub(crate) output_preview: Option<String>,
    pub(crate) actor: KernelVerificationActor,
    pub(crate) binding_generation: i64,
    pub(crate) input_identity: KernelVerificationInputIdentity,
    pub(crate) input_changed_during_run: RequiredNullable<bool>,
    pub(crate) relation_to_published: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelReviewFinding {
    pub(crate) severity: String,
    pub(crate) file: Option<String>,
    pub(crate) line: Option<i64>,
    pub(crate) message: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelVerificationEnvSummary {
    pub(crate) path: Option<bool>,
    pub(crate) virtual_env: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelVerificationActor {
    pub(crate) authority_instance_id: String,
    pub(crate) session_id: String,
    pub(crate) worker_id: String,
    pub(crate) worker_generation: i64,
    pub(crate) run_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelVerificationInputIdentity {
    pub(crate) kind: String,
    pub(crate) branch_id: Option<String>,
    pub(crate) root: Option<String>,
    pub(crate) start_tree_hash: Option<String>,
    pub(crate) end_tree_hash: Option<String>,
    pub(crate) reason: Option<String>,
}

pub(crate) fn validate_generated_method_params(method: &str, params: &Value) -> Result<(), String> {
    match method {
        "kernel.handshake" => serde_json::from_value::<KernelHandshakeParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "kernel.ping" => serde_json::from_value::<KernelEmptyParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "kernel.shutdown" => serde_json::from_value::<KernelEmptyParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "storage.health" => serde_json::from_value::<KernelHealthParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "authority.grant.issue" => serde_json::from_value::<KernelGrantIssueParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "authority.grant.revoke" => {
            serde_json::from_value::<KernelGrantRevokeParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "storage.snapshot" => serde_json::from_value::<KernelSnapshotParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "storage.putBlob.begin" => {
            serde_json::from_value::<KernelPutBlobBeginParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "storage.putBlob.finish" => {
            serde_json::from_value::<KernelPutBlobFinishParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "storage.putBlob.abort" => {
            serde_json::from_value::<KernelPutBlobAbortParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "storage.blob.release" => serde_json::from_value::<KernelBlobReleaseParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "storage.getBlob" => serde_json::from_value::<KernelGetBlobParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "storage.record.put" => serde_json::from_value::<KernelRecordPutParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "storage.record.get" => serde_json::from_value::<KernelRecordGetParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "storage.record.list" => serde_json::from_value::<KernelRecordListParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "storage.record.release" => {
            serde_json::from_value::<KernelRecordReleaseParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.result.put" => {
            serde_json::from_value::<KernelWorkingResultPutParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.result.get" => {
            serde_json::from_value::<KernelWorkingResultGetParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.result.list" => {
            serde_json::from_value::<KernelWorkingResultListParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.result.release" => {
            serde_json::from_value::<KernelWorkingResultReleaseParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.draft.put" => {
            serde_json::from_value::<KernelWorkingDraftPutParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.draft.get" => {
            serde_json::from_value::<KernelWorkingDraftGetParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.draft.list" => {
            serde_json::from_value::<KernelWorkingDraftListParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.draft.release" => {
            serde_json::from_value::<KernelWorkingDraftReleaseParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.verification.put" => {
            serde_json::from_value::<KernelWorkingVerificationPutParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.verification.list" => {
            serde_json::from_value::<KernelWorkingVerificationListParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.verification.release" => {
            serde_json::from_value::<KernelWorkingVerificationReleaseParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.review.put" => {
            serde_json::from_value::<KernelWorkingReviewPutParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.review.list" => {
            serde_json::from_value::<KernelWorkingReviewListParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.review.release" => {
            serde_json::from_value::<KernelWorkingReviewReleaseParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "branch.create.begin" => {
            serde_json::from_value::<KernelCreateBranchBeginParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "branch.create.append" => {
            serde_json::from_value::<KernelCreateBranchAppendParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "branch.create.finish" => {
            serde_json::from_value::<KernelCreateBranchFinishParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "branch.create.abort" => {
            serde_json::from_value::<KernelCreateBranchAbortParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "branch.read" => serde_json::from_value::<KernelBranchReadParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "branch.write.begin" => {
            serde_json::from_value::<KernelBranchWriteBeginParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "branch.write.append" => {
            serde_json::from_value::<KernelBranchWriteAppendParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "branch.write.finish" => {
            serde_json::from_value::<KernelBranchWriteFinishParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "branch.write.abort" => {
            serde_json::from_value::<KernelBranchWriteAbortParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "branch.publish" => serde_json::from_value::<KernelBranchPublishParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "branch.pin" => serde_json::from_value::<KernelBranchPinParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "branch.unpin" => serde_json::from_value::<KernelBranchUnpinParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "branch.diff" => serde_json::from_value::<KernelBranchDiffParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "branch.delete" => serde_json::from_value::<KernelBranchDeleteParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "pin.read" => serde_json::from_value::<KernelPinReadParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "recovery.operation.get" => {
            serde_json::from_value::<KernelRecoveryOperationGetParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.turn.start" => {
            serde_json::from_value::<KernelRecoveryTurnStartParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.turn.get" => {
            serde_json::from_value::<KernelRecoveryTurnGetParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.turn.settle" => {
            serde_json::from_value::<KernelRecoveryTurnSettleParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.checkpoint.create" => {
            serde_json::from_value::<KernelRecoveryCheckpointCreateParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.checkpoint.list" => {
            serde_json::from_value::<KernelRecoveryCheckpointListParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.entry.resolve" => {
            serde_json::from_value::<KernelRecoveryEntryResolveParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.change.before" => {
            serde_json::from_value::<KernelRecoveryChangeBeforeParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.change.get" => {
            serde_json::from_value::<KernelRecoveryChangeGetParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.change.after" => {
            serde_json::from_value::<KernelRecoveryChangeAfterParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.operation.create" => {
            serde_json::from_value::<KernelRecoveryOperationCreateParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.operation.file.cas" => {
            serde_json::from_value::<KernelRecoveryOperationFileCasParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.operation.complete" => {
            serde_json::from_value::<KernelRecoveryOperationCompleteParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.operation.list" => {
            serde_json::from_value::<KernelRecoveryOperationListParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.operation.release" => {
            serde_json::from_value::<KernelRecoveryOperationReleaseParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "operation.get" => serde_json::from_value::<KernelOperationGetParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "operation.release" => {
            serde_json::from_value::<KernelOperationReleaseParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "storage.gc" => serde_json::from_value::<KernelGcParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        _ => Ok(()),
    }
}

pub(crate) fn validate_generated_working_document(
    record_type: &str,
    document: &Value,
) -> Result<(), String> {
    match record_type {
        "working.result" => serde_json::from_value::<KernelWorkingResultDocument>(document.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "working.draft" => serde_json::from_value::<KernelWorkingDraftDocument>(document.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "working.verification" => {
            serde_json::from_value::<KernelWorkingVerificationDocument>(document.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.review" => serde_json::from_value::<KernelWorkingReviewDocument>(document.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        _ => Ok(()),
    }
}
