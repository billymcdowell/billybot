use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, State};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// The Whisper model file. Download it once into the app's models folder.
/// Swap for "ggml-large-v3-turbo-q5_0.bin" for better accuracy.
const MODEL_FILE: &str = "ggml-base.en.bin";

/// Keeps the model in memory after the first use, so it's only loaded once.
#[derive(Default)]
pub struct Stt(Mutex<Option<Arc<WhisperContext>>>);

/// <app data dir>/models/<MODEL_FILE>, where the app data dir is
/// macOS:   ~/Library/Application Support/<app identifier>
/// Windows: %APPDATA%\<app identifier>
/// Linux:   ~/.local/share/<app identifier>
fn model_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("models").join(MODEL_FILE))
}

fn load_model(app: &AppHandle, stt: &Stt) -> Result<Arc<WhisperContext>, String> {
    let mut slot = stt.0.lock().map_err(|_| "Speech model lock failed")?;
    if let Some(model) = slot.as_ref() {
        return Ok(model.clone());
    }
    let path = model_path(app)?;
    if !path.exists() {
        return Err(format!("Speech model not found. Download {MODEL_FILE} to {}", path.display()));
    }
    let model = WhisperContext::new_with_params(&path, WhisperContextParameters::default())
        .map_err(|e| format!("Couldn't load the speech model: {e}"))?;
    let model = Arc::new(model);
    *slot = Some(model.clone());
    Ok(model)
}

/// Runs Whisper on 16 kHz mono audio and returns the text.
fn run_whisper(model: &WhisperContext, samples: &[f32]) -> Result<String, String> {
    let mut state = model.create_state().map_err(|e| e.to_string())?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    state.full(params, samples).map_err(|e| e.to_string())?;

    let mut text = String::new();
    for segment in state.as_iter() {
        text.push_str(&segment.to_str_lossy().map_err(|e| e.to_string())?);
    }
    // Whisper writes this for silence.
    Ok(text.replace("[BLANK_AUDIO]", "").trim().to_string())
}

/// Called from TypeScript with the audio as raw bytes: 16 kHz mono 32-bit floats.
#[tauri::command]
pub async fn transcribe_local(
    app: AppHandle,
    stt: State<'_, Stt>,
    request: Request<'_>,
) -> Result<String, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected raw audio bytes".into());
    };
    let samples: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    let model = load_model(&app, &stt)?;
    // Transcribing takes a moment, so run it off the main thread.
    tauri::async_runtime::spawn_blocking(move || run_whisper(&model, &samples))
        .await
        .map_err(|e| e.to_string())?
}
