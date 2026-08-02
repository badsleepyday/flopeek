use super::*;

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
        serde_json::to_writer(&mut writer, &response)
            .map_err(|error| format!("Unable to encode native protocol response: {error}"))?;
        writer
            .write_all(b"\n")
            .map_err(|error| format!("Unable to write native protocol response: {error}"))?;
        writer
            .flush()
            .map_err(|error| format!("Unable to flush native protocol response: {error}"))?;
        if should_shutdown {
            return Ok(());
        }
    }
    Ok(())
}
