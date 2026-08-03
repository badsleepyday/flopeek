use crate::identity_store::{
    node_identity_by_external_id, node_identity_by_uid, search_node_identities,
};
use crate::inventory::{
    discover_native_bounded_project, scan_native_incremental_manifest,
    scan_native_incremental_manifest_with_source_batch,
};
use crate::js_batch::native_manual_descriptions;
use crate::js_facts::{
    NativeJsFactsStatus, ensure_complete_native_js_structural_records,
    evict_native_js_source_cache, hydrate_native_js_source_facts, native_structural_record_digests,
    refresh_native_js_facts_session, refresh_native_js_facts_session_owned,
    reuse_native_js_facts_session, reuse_native_js_facts_session_owned, scan_native_js_facts,
    scan_native_js_facts_ephemeral, scan_native_js_facts_ephemeral_bounded,
    take_complete_native_js_structural_records,
};
use crate::project_identity::ProjectIdentity;
use crate::record_cache::{handle_native_js_record_cache_value, load_native_js_record_cache_raw};
use crate::scope::read_native_scope;
use crate::store::{
    NativeGraphPromotionRequest, begin_graph_build, complete_graph_delta,
    complete_graph_delta_by_public_versions, complete_graph_payload,
    complete_graph_payload_by_public_version, current_complete_graph, current_structural_batch,
    delay_at_test_boundary, initialize_native_store, open_native_store,
    promote_graph_build_with_changed_records, recover_incomplete_graph_builds,
    retained_public_delta_range,
};
use crate::structural_contract::validate_structural_records;
use crate::structural_graph::{
    StructuralGraphNode, StructuralGraphProjection, StructuralGraphSnapshot,
    build_structural_graph, javascript_ascii_cmp, javascript_ascii_locale_cmp,
    structural_edge_traversal_order, structural_graph_projection_from_parts,
    structural_graph_projection_into_value, structural_graph_snapshot,
};
use serde::ser::{SerializeMap, SerializeSeq, Serializer};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Instant;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

mod handlers;
mod queries;
mod request;
mod response;
mod router;
mod session;
mod transport;

use handlers::{lifecycle::*, materialize::*, refresh::*, session_graph::*};
use queries::{context_ref::*, flows::*, impact::*, overview::*};
use request::NativeRequest;
use response::{
    NativeProtocolError, NativeProtocolResult, NativeResponse, error_response,
    success_raw_response, success_response,
};
use router::handle_request;
#[cfg(test)]
use router::native_query_cache_key;
use session::*;
pub use transport::serve_jsonl;

pub const NATIVE_PROTOCOL_VERSION: &str = "flopeek-native-protocol/v1";
pub const STRUCTURAL_FACT_BATCH_SCHEMA: &str = "flopeek-structural-fact-batch/v1";
pub const STRUCTURAL_FACT_PATCH_SCHEMA: &str = "flopeek-structural-fact-patch/v1";

type NativePublicDeltaHistory = (Option<Value>, Option<(i64, i64)>);
type ComparedItems = (
    Vec<Value>,
    Vec<Value>,
    Vec<Value>,
    (usize, usize, usize),
    bool,
);

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests;
