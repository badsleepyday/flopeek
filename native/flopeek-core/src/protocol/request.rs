use super::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct NativeRequest {
    pub(super) protocol_version: String,
    pub(super) request_id: String,
    pub(super) method: String,
    #[serde(default)]
    pub(super) params: Value,
}
