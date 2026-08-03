use super::*;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NativeResponse {
    pub(super) protocol_version: &'static str,
    pub(super) request_id: Option<String>,
    pub(super) status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) result: Option<NativeProtocolResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) error: Option<NativeProtocolError>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub(super) enum NativeProtocolResult {
    Value(Value),
    Raw(Box<RawValue>),
}

#[derive(Clone, Debug, Serialize)]
pub(super) struct NativeProtocolError {
    pub(super) code: &'static str,
    pub(super) message: String,
}

pub(super) fn error_response(
    request_id: Option<String>,
    code: &'static str,
    message: impl Into<String>,
) -> NativeResponse {
    NativeResponse {
        protocol_version: NATIVE_PROTOCOL_VERSION,
        request_id,
        status: "error",
        result: None,
        error: Some(NativeProtocolError {
            code,
            message: message.into(),
        }),
    }
}

pub(super) fn success_response(request_id: String, result: Value) -> NativeResponse {
    NativeResponse {
        protocol_version: NATIVE_PROTOCOL_VERSION,
        request_id: Some(request_id),
        status: "ok",
        result: Some(NativeProtocolResult::Value(result)),
        error: None,
    }
}

pub(super) fn success_raw_response(request_id: String, result: Box<RawValue>) -> NativeResponse {
    NativeResponse {
        protocol_version: NATIVE_PROTOCOL_VERSION,
        request_id: Some(request_id),
        status: "ok",
        result: Some(NativeProtocolResult::Raw(result)),
        error: None,
    }
}
