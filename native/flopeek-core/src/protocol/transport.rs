use super::*;

#[cfg(all(target_os = "linux", target_env = "gnu"))]
unsafe extern "C" {
    fn malloc_trim(pad: usize) -> i32;
}

fn release_completed_lifecycle_heap() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    // SAFETY: `malloc_trim(0)` is a process-local glibc allocator operation.
    // It neither invalidates live allocations nor crosses the JSONL boundary;
    // this call occurs only after the completed lifecycle response was flushed
    // and dropped.
    unsafe {
        let _ = malloc_trim(0);
    }
}

fn write_owned_json_value<W: Write>(
    writer: &mut W,
    value: Value,
    release_large_arrays: bool,
) -> Result<(), String> {
    match value {
        Value::Null => writer.write_all(b"null").map_err(|error| error.to_string()),
        Value::Bool(value) => {
            serde_json::to_writer(&mut *writer, &value).map_err(|error| error.to_string())
        }
        Value::Number(value) => {
            serde_json::to_writer(&mut *writer, &value).map_err(|error| error.to_string())
        }
        Value::String(value) => {
            serde_json::to_writer(&mut *writer, &value).map_err(|error| error.to_string())
        }
        Value::Array(values) => {
            writer.write_all(b"[").map_err(|error| error.to_string())?;
            let large = release_large_arrays && values.len() >= 256;
            for (index, value) in values.into_iter().enumerate() {
                if index > 0 {
                    writer.write_all(b",").map_err(|error| error.to_string())?;
                }
                write_owned_json_value(writer, value, release_large_arrays)?;
                if large && (index + 1) % 256 == 0 {
                    writer.flush().map_err(|error| error.to_string())?;
                    release_completed_lifecycle_heap();
                }
            }
            writer.write_all(b"]").map_err(|error| error.to_string())
        }
        Value::Object(entries) => {
            writer.write_all(b"{").map_err(|error| error.to_string())?;
            for (index, (key, value)) in entries.into_iter().enumerate() {
                if index > 0 {
                    writer.write_all(b",").map_err(|error| error.to_string())?;
                }
                serde_json::to_writer(&mut *writer, &key).map_err(|error| error.to_string())?;
                writer.write_all(b":").map_err(|error| error.to_string())?;
                write_owned_json_value(writer, value, release_large_arrays)?;
            }
            writer.write_all(b"}").map_err(|error| error.to_string())
        }
    }
}

fn write_native_response_owned<W: Write>(
    writer: &mut W,
    response: NativeResponse,
    release_large_arrays: bool,
) -> Result<(), String> {
    let NativeResponse {
        protocol_version,
        request_id,
        status,
        result,
        error,
    } = response;
    writer
        .write_all(b"{\"protocolVersion\":\"")
        .map_err(|error| error.to_string())?;
    writer
        .write_all(protocol_version.as_bytes())
        .map_err(|error| error.to_string())?;
    writer
        .write_all(b"\",\"requestId\":")
        .map_err(|error| error.to_string())?;
    serde_json::to_writer(&mut *writer, &request_id).map_err(|error| error.to_string())?;
    writer
        .write_all(b",\"status\":\"")
        .map_err(|error| error.to_string())?;
    writer
        .write_all(status.as_bytes())
        .map_err(|error| error.to_string())?;
    if let Some(result) = result {
        writer
            .write_all(b"\",\"result\":")
            .map_err(|error| error.to_string())?;
        match result {
            NativeProtocolResult::Value(value) => {
                write_owned_json_value(writer, value, release_large_arrays)?
            }
            NativeProtocolResult::Raw(value) => writer
                .write_all(value.get().as_bytes())
                .map_err(|error| error.to_string())?,
        }
    } else {
        writer.write_all(b"\"").map_err(|error| error.to_string())?;
    }
    if let Some(error) = error {
        writer
            .write_all(b",\"error\":")
            .map_err(|error| error.to_string())?;
        serde_json::to_writer(&mut *writer, &error).map_err(|error| error.to_string())?;
    }
    writer.write_all(b"}").map_err(|error| error.to_string())
}

pub fn serve_jsonl<R: BufRead, W: Write>(reader: R, mut writer: W) -> Result<(), String> {
    let mut session = NativeProtocolSession::from_env()?;
    for line in reader.lines() {
        let line =
            line.map_err(|error| format!("Unable to read native protocol request: {error}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let dispatch_started = Instant::now();
        let (mut response, should_shutdown) = match serde_json::from_str::<NativeRequest>(&line) {
            Ok(request) => handle_request(&mut session, request),
            Err(error) => (
                error_response(
                    None,
                    "invalid-request",
                    format!("Request must be valid JSON for {NATIVE_PROTOCOL_VERSION}: {error}"),
                ),
                false,
            ),
        };
        if let Some(NativeProtocolResult::Value(result)) = response.result.as_mut()
            && let Some(profile) = result
                .get_mut("receipt")
                .and_then(|receipt| receipt.get_mut("profile"))
                .and_then(Value::as_object_mut)
        {
            profile.insert(
                "nativeProtocolDispatchMs".to_string(),
                json!(elapsed_ms(dispatch_started)),
            );
        }
        let completed_lifecycle = matches!(
            response.result.as_ref(),
            Some(NativeProtocolResult::Value(result))
                if result.get("receipt").is_some()
        );
        write_native_response_owned(&mut writer, response, completed_lifecycle)
            .map_err(|error| format!("Unable to encode native protocol response: {error}"))?;
        writer
            .write_all(b"\n")
            .map_err(|error| format!("Unable to write native protocol response: {error}"))?;
        writer
            .flush()
            .map_err(|error| format!("Unable to flush native protocol response: {error}"))?;
        drop(line);
        if completed_lifecycle {
            release_completed_lifecycle_heap();
        }
        if should_shutdown {
            return Ok(());
        }
    }
    Ok(())
}
