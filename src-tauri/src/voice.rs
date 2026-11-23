use crate::config::{AppConfig, ProviderId, get_api_key};
use crate::llm::providers::{ASKII_CLOUD_URL, OPENAI_DEFAULT_URL, normalize_base_url};
use reqwest::Client;
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};
use reqwest::multipart::{Form, Part};
use serde_json::Value;
use std::time::Duration;

pub async fn transcribe_audio(
    config: &AppConfig,
    audio_bytes: Vec<u8>,
    mime_type: &str,
) -> Result<String, String> {
    if audio_bytes.is_empty() {
        return Err("No audio was recorded.".to_string());
    }

    let custom_whisper = config.whisper_url.trim();
    let (endpoint, api_key, model) = if !custom_whisper.is_empty() {
        let base = custom_whisper.trim_end_matches('/');
        let url = if base.ends_with("/transcriptions") || base.ends_with("/inference") {
            base.to_string()
        } else {
            format!("{base}/v1/audio/transcriptions")
        };
        (url, None, "whisper-1".to_string())
    } else if let Some(key) = get_api_key(ProviderId::OpenAi) {
        let base = normalize_base_url(&config.openai_url, OPENAI_DEFAULT_URL);
        (
            format!("{base}/audio/transcriptions"),
            Some(key),
            "whisper-1".to_string(),
        )
    } else if let Some(key) = get_api_key(ProviderId::AskiiCloud) {
        (
            format!("{ASKII_CLOUD_URL}/audio/transcriptions"),
            Some(key),
            "whisper-1".to_string(),
        )
    } else {
        return Err(
            "Voice transcription requires an OpenAI/ASKII Cloud API key or a local Whisper server URL in Setup."
                .to_string(),
        );
    };

    let ext = if mime_type.contains("wav") {
        "wav"
    } else if mime_type.contains("ogg") {
        "ogg"
    } else {
        "webm"
    };

    let file_part = Part::bytes(audio_bytes)
        .file_name(format!("voice.{ext}"))
        .mime_str(mime_type)
        .map_err(|e| format!("Invalid audio mime type: {e}"))?;

    let form = Form::new()
        .part("file", file_part)
        .text("model", model);

    let mut headers = HeaderMap::new();
    if let Some(key) = api_key {
        let val = HeaderValue::from_str(&format!("Bearer {key}"))
            .map_err(|_| "Invalid API key header".to_string())?;
        headers.insert(AUTHORIZATION, val);
    }

    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let resp = client
        .post(&endpoint)
        .headers(headers)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Transcription request failed: {e}"))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "Transcription failed (HTTP {}): {}",
            status.as_u16(),
            body.chars().take(180).collect::<String>()
        ));
    }

    if let Ok(json) = serde_json::from_str::<Value>(&body) {
        if let Some(text) = json.get("text").and_then(|t| t.as_str()) {
            return Ok(text.trim().to_string());
        }
    }
    Ok(body.trim().to_string())
}
