use std::{
    fs::{self, File},
    io::{Read, Write},
    mem::size_of,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use flate2::read::GzDecoder;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tar::Archive;
use tauri::{
    ipc::{InvokeBody, Request},
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, Position, State, WindowEvent,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use transcribe_rs::onnx::{
    parakeet::{ParakeetModel, ParakeetParams, TimestampGranularity},
    sense_voice::{SenseVoiceModel, SenseVoiceParams},
    Quantization,
};

const PARAKEET_MODEL_ID: &str = "native/parakeet-tdt-0.6b-v3";
const PARAKEET_MODEL_DIR: &str = "parakeet-tdt-0.6b-v3-int8";
const PARAKEET_ARCHIVE_URL: &str = "https://blob.handy.computer/parakeet-v3-int8.tar.gz";
const PARAKEET_ARCHIVE_SHA256: &str =
    "43d37191602727524a7d8c6da0eef11c4ba24320f5b4730f1a2497befc2efa77";
const SENSEVOICE_MODEL_ID: &str = "native/sensevoice-small-int8";
const SENSEVOICE_MODEL_DIR: &str = "sense-voice-int8";
const SENSEVOICE_ARCHIVE_URL: &str = "https://blob.handy.computer/sense-voice-int8.tar.gz";
const SENSEVOICE_ARCHIVE_SHA256: &str =
    "171d611fe5d353a50bbb741b6f3ef42559b1565685684e9aa888ef563ba3e8a4";

const PARAKEET_FILES: &[&str] = &[
    "encoder-model.int8.onnx",
    "decoder_joint-model.int8.onnx",
    "nemo128.onnx",
    "vocab.txt",
];
const SENSEVOICE_FILES: &[&str] = &["model.int8.onnx", "tokens.txt"];

#[derive(Clone, Copy)]
struct ModelSpec {
    id: &'static str,
    name: &'static str,
    directory: &'static str,
    archive: &'static str,
    url: &'static str,
    sha256: &'static str,
    files: &'static [&'static str],
}

fn model_spec(id: &str) -> Result<ModelSpec, String> {
    match id {
        PARAKEET_MODEL_ID => Ok(ModelSpec {
            id: PARAKEET_MODEL_ID,
            name: "Parakeet V3",
            directory: PARAKEET_MODEL_DIR,
            archive: "parakeet-v3-int8.tar.gz",
            url: PARAKEET_ARCHIVE_URL,
            sha256: PARAKEET_ARCHIVE_SHA256,
            files: PARAKEET_FILES,
        }),
        SENSEVOICE_MODEL_ID => Ok(ModelSpec {
            id: SENSEVOICE_MODEL_ID,
            name: "SenseVoiceSmall Q8",
            directory: SENSEVOICE_MODEL_DIR,
            archive: "sense-voice-int8.tar.gz",
            url: SENSEVOICE_ARCHIVE_URL,
            sha256: SENSEVOICE_ARCHIVE_SHA256,
            files: SENSEVOICE_FILES,
        }),
        _ => Err("That transcription model is not supported.".to_string()),
    }
}

enum LoadedModel {
    Parakeet(ParakeetModel),
    SenseVoice(SenseVoiceModel),
}

impl LoadedModel {
    fn id(&self) -> &'static str {
        match self {
            Self::Parakeet(_) => PARAKEET_MODEL_ID,
            Self::SenseVoice(_) => SENSEVOICE_MODEL_ID,
        }
    }
}

#[derive(Default)]
struct ModelRequestTracker {
    generation: u64,
    requested_id: Option<&'static str>,
}

impl ModelRequestTracker {
    fn begin(&mut self, model_id: &'static str) -> u64 {
        self.generation = self.generation.wrapping_add(1).max(1);
        self.requested_id = Some(model_id);
        self.generation
    }

    fn is_current_request(&self, generation: u64) -> bool {
        self.generation == generation
    }

    fn wants(&self, model_id: &str) -> bool {
        self.requested_id == Some(model_id)
    }
}

#[derive(Default)]
struct AppState {
    last_transcript: Mutex<String>,
    transcription_model: Arc<Mutex<Option<LoadedModel>>>,
    model_requests: Arc<Mutex<ModelRequestTracker>>,
    model_load_gate: Arc<Mutex<()>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct IndicatorState {
    status: String,
    level: f32,
    message: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelProgress {
    model: String,
    request_id: u64,
    status: String,
    file: String,
    loaded: u64,
    total: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelPreparationResult {
    model: String,
    request_id: u64,
    activated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeTranscriptionResult {
    text: String,
    inference_ms: f64,
}

fn model_files_are_ready(path: &Path, files: &[&str]) -> bool {
    files.iter().all(|file| path.join(file).is_file())
}

fn emit_model_progress(
    app: &AppHandle,
    spec: ModelSpec,
    request_id: u64,
    status: &str,
    loaded: u64,
    total: u64,
) -> Result<(), String> {
    app.emit(
        "transcription-model-progress",
        ModelProgress {
            model: spec.id.to_string(),
            request_id,
            status: status.to_string(),
            file: spec.archive.to_string(),
            loaded,
            total,
        },
    )
    .map_err(|error| error.to_string())
}

enum ModelInstallOutcome {
    Ready(PathBuf),
    Superseded,
}

fn install_model(
    app: &AppHandle,
    models_dir: &Path,
    spec: ModelSpec,
    request_id: u64,
    requests: &Arc<Mutex<ModelRequestTracker>>,
) -> Result<ModelInstallOutcome, String> {
    fs::create_dir_all(models_dir).map_err(|error| error.to_string())?;
    let final_dir = models_dir.join(spec.directory);
    if model_files_are_ready(&final_dir, spec.files) {
        return Ok(ModelInstallOutcome::Ready(final_dir));
    }

    let partial_path = models_dir.join(format!("{}.partial", spec.archive));
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(30 * 60))
        .build()
        .map_err(|error| format!("Could not start the model download: {error}"))?;
    let mut response = client
        .get(spec.url)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|error| format!("Could not download {}: {error}", spec.name))?;
    let total = response.content_length().unwrap_or(0);
    let mut output = File::create(&partial_path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    let mut loaded = 0_u64;
    let mut last_progress = Instant::now();
    emit_model_progress(app, spec, request_id, "progress", 0, total)?;

    loop {
        let count = response
            .read(&mut buffer)
            .map_err(|error| format!("The model download was interrupted: {error}"))?;
        if count == 0 {
            break;
        }
        output
            .write_all(&buffer[..count])
            .map_err(|error| format!("Could not save the model: {error}"))?;
        hasher.update(&buffer[..count]);
        loaded += count as u64;
        if last_progress.elapsed() >= Duration::from_millis(150) {
            let request_is_current = requests
                .lock()
                .map_err(|_| "The model request state is unavailable.".to_string())?
                .is_current_request(request_id);
            if !request_is_current {
                drop(output);
                let _ = fs::remove_file(&partial_path);
                return Ok(ModelInstallOutcome::Superseded);
            }
            emit_model_progress(app, spec, request_id, "progress", loaded, total)?;
            last_progress = Instant::now();
        }
    }
    let request_is_current = requests
        .lock()
        .map_err(|_| "The model request state is unavailable.".to_string())?
        .is_current_request(request_id);
    if !request_is_current {
        drop(output);
        let _ = fs::remove_file(&partial_path);
        return Ok(ModelInstallOutcome::Superseded);
    }
    output.flush().map_err(|error| error.to_string())?;
    emit_model_progress(app, spec, request_id, "verifying", loaded, total)?;

    let actual_hash = format!("{:x}", hasher.finalize());
    if actual_hash != spec.sha256 {
        let _ = fs::remove_file(&partial_path);
        return Err(format!(
            "The {} download was corrupt. Please try again.",
            spec.name
        ));
    }

    emit_model_progress(app, spec, request_id, "extracting", loaded, total)?;
    let extracting_dir = models_dir.join(format!("{}.extracting", spec.directory));
    if extracting_dir.exists() {
        fs::remove_dir_all(&extracting_dir).map_err(|error| error.to_string())?;
    }
    fs::create_dir_all(&extracting_dir).map_err(|error| error.to_string())?;
    let archive_file = File::open(&partial_path).map_err(|error| error.to_string())?;
    let mut archive = Archive::new(GzDecoder::new(archive_file));
    for entry in archive
        .entries()
        .map_err(|error| format!("Could not read the {} archive: {error}", spec.name))?
    {
        let mut entry = entry.map_err(|error| error.to_string())?;
        if !entry
            .unpack_in(&extracting_dir)
            .map_err(|error| format!("Could not install {}: {error}", spec.name))?
        {
            return Err(format!(
                "The {} archive contained an unsafe path.",
                spec.name
            ));
        }
    }

    let nested_dir = extracting_dir.join(spec.directory);
    let source_dir = if model_files_are_ready(&extracting_dir, spec.files) {
        extracting_dir.clone()
    } else if model_files_are_ready(&nested_dir, spec.files) {
        nested_dir
    } else {
        let _ = fs::remove_dir_all(&extracting_dir);
        let _ = fs::remove_file(&partial_path);
        return Err(format!(
            "The {} archive did not contain the expected files.",
            spec.name
        ));
    };

    if final_dir.exists() {
        fs::remove_dir_all(&final_dir).map_err(|error| error.to_string())?;
    }
    fs::rename(&source_dir, &final_dir).map_err(|error| error.to_string())?;
    if extracting_dir.exists() {
        let _ = fs::remove_dir_all(&extracting_dir);
    }
    let _ = fs::remove_file(&partial_path);
    emit_model_progress(
        app,
        spec,
        request_id,
        "done",
        total.max(loaded),
        total.max(loaded),
    )?;
    Ok(ModelInstallOutcome::Ready(final_dir))
}

#[tauri::command]
async fn prepare_transcription_model(
    app: AppHandle,
    state: State<'_, AppState>,
    model: String,
) -> Result<ModelPreparationResult, String> {
    let spec = model_spec(&model)?;
    let model_slot = state.transcription_model.clone();
    let requests = state.model_requests.clone();
    let load_gate = state.model_load_gate.clone();
    let model_app = app.clone();
    let models_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("models");
    let request_id = requests
        .lock()
        .map_err(|_| "The model request state is unavailable.".to_string())?
        .begin(spec.id);

    tauri::async_runtime::spawn_blocking(move || {
        // A switch back to the model that is still serving requests should not
        // wait behind an obsolete model load. Beginning this request above also
        // prevents that older load from replacing the active model afterward.
        let already_active = model_slot
            .lock()
            .map_err(|_| "The transcription model state is unavailable.".to_string())?
            .as_ref()
            .is_some_and(|loaded| loaded.id() == spec.id);
        if already_active {
            return Ok(ModelPreparationResult {
                model: spec.id.to_string(),
                request_id,
                activated: true,
            });
        }

        let _load_guard = load_gate
            .lock()
            .map_err(|_| "The model loading gate is unavailable.".to_string())?;

        let is_requested = || -> Result<bool, String> {
            Ok(requests
                .lock()
                .map_err(|_| "The model request state is unavailable.".to_string())?
                .wants(spec.id))
        };
        if !is_requested()? {
            return Ok(ModelPreparationResult {
                model: spec.id.to_string(),
                request_id,
                activated: false,
            });
        }

        let already_active = model_slot
            .lock()
            .map_err(|_| "The transcription model state is unavailable.".to_string())?
            .as_ref()
            .is_some_and(|loaded| loaded.id() == spec.id);
        if already_active {
            return Ok(ModelPreparationResult {
                model: spec.id.to_string(),
                request_id,
                activated: true,
            });
        }

        let model_dir = match install_model(&model_app, &models_dir, spec, request_id, &requests)? {
            ModelInstallOutcome::Ready(path) => path,
            ModelInstallOutcome::Superseded => {
                return Ok(ModelPreparationResult {
                    model: spec.id.to_string(),
                    request_id,
                    activated: false,
                });
            }
        };
        if !is_requested()? {
            return Ok(ModelPreparationResult {
                model: spec.id.to_string(),
                request_id,
                activated: false,
            });
        }

        emit_model_progress(&model_app, spec, request_id, "loading", 1, 1)?;
        let loaded = match spec.id {
            PARAKEET_MODEL_ID => LoadedModel::Parakeet(
                ParakeetModel::load(&model_dir, &Quantization::Int8)
                    .map_err(|error| format!("Could not load Parakeet V3: {error}"))?,
            ),
            SENSEVOICE_MODEL_ID => LoadedModel::SenseVoice(
                SenseVoiceModel::load(&model_dir, &Quantization::Int8)
                    .map_err(|error| format!("Could not load SenseVoiceSmall Q8: {error}"))?,
            ),
            _ => return Err("That transcription model is not supported.".to_string()),
        };

        // Keep the request lock through the short final swap so a newer request
        // cannot arrive between the stale check and activation. Work from an
        // older request is still reusable when the latest intent chose the same model.
        let request_guard = requests
            .lock()
            .map_err(|_| "The model request state is unavailable.".to_string())?;
        if !request_guard.wants(spec.id) {
            return Ok(ModelPreparationResult {
                model: spec.id.to_string(),
                request_id,
                activated: false,
            });
        }
        let mut model = model_slot
            .lock()
            .map_err(|_| "The transcription model state is unavailable.".to_string())?;
        *model = Some(loaded);
        drop(model);
        drop(request_guard);

        emit_model_progress(&model_app, spec, request_id, "ready", 1, 1)?;
        Ok(ModelPreparationResult {
            model: spec.id.to_string(),
            request_id,
            activated: true,
        })
    })
    .await
    .map_err(|error| format!("The model preparation task stopped: {error}"))?
}

#[tauri::command]
async fn transcribe_speech(
    request: Request<'_>,
    state: State<'_, AppState>,
) -> Result<NativeTranscriptionResult, String> {
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(_) => return Err("Audio must be sent as raw 16 kHz samples.".to_string()),
    };
    if bytes.len() < size_of::<u32>() + size_of::<f32>()
        || !(bytes.len() - size_of::<u32>()).is_multiple_of(size_of::<f32>())
    {
        return Err("The recorded audio was empty or invalid.".to_string());
    }
    let model_code = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    let requested_model_id = match model_code {
        0 => PARAKEET_MODEL_ID,
        1 => SENSEVOICE_MODEL_ID,
        _ => return Err("The requested transcription model was invalid.".to_string()),
    };
    let audio = bytes[size_of::<u32>()..]
        .chunks_exact(size_of::<f32>())
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect::<Vec<_>>();
    let model_slot = state.transcription_model.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let mut model = model_slot
            .lock()
            .map_err(|_| "The transcription model state is unavailable.".to_string())?;
        let model = model
            .as_mut()
            .ok_or_else(|| "The transcription model is not ready yet.".to_string())?;
        if model.id() != requested_model_id {
            return Err(
                "The selected transcription model changed before processing began.".to_string(),
            );
        }
        let started = Instant::now();
        let result = match model {
            LoadedModel::Parakeet(model) => model
                .transcribe_with(
                    &audio,
                    &ParakeetParams {
                        timestamp_granularity: Some(TimestampGranularity::Segment),
                        ..Default::default()
                    },
                )
                .map_err(|error| format!("Parakeet transcription failed: {error}"))?,
            LoadedModel::SenseVoice(model) => model
                .transcribe_with(
                    &audio,
                    &SenseVoiceParams {
                        language: Some("auto".to_string()),
                        use_itn: Some(true),
                    },
                )
                .map_err(|error| format!("SenseVoice transcription failed: {error}"))?,
        };
        Ok(NativeTranscriptionResult {
            text: result.text,
            inference_ms: started.elapsed().as_secs_f64() * 1000.0,
        })
    })
    .await
    .map_err(|error| format!("The transcription task stopped: {error}"))?
}

#[tauri::command]
fn set_indicator(
    app: AppHandle,
    status: String,
    level: Option<f32>,
    message: Option<String>,
) -> Result<(), String> {
    let window = app
        .get_webview_window("indicator")
        .ok_or_else(|| "Recording indicator window is unavailable".to_string())?;

    if status == "hidden" {
        window.hide().map_err(|error| error.to_string())?;
        return Ok(());
    }

    window
        .emit(
            "indicator-state",
            IndicatorState {
                status,
                level: level.unwrap_or(0.0).clamp(0.0, 1.0),
                message,
            },
        )
        .map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn show_main(app: AppHandle) -> Result<(), String> {
    show_main_window(&app)
}

#[tauri::command]
fn copy_text(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard()
        .write_text(text)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_last_transcript(app: AppHandle, text: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    *state
        .last_transcript
        .lock()
        .map_err(|_| "Transcript state is unavailable".to_string())? = text;
    Ok(())
}

#[tauri::command]
fn insert_text(
    app: AppHandle,
    text: String,
    use_clipboard: bool,
    copy_to_clipboard: bool,
) -> Result<(), String> {
    if text.is_empty() {
        return Ok(());
    }

    if use_clipboard {
        let previous = if copy_to_clipboard {
            None
        } else {
            app.clipboard().read_text().ok()
        };

        app.clipboard()
            .write_text(text)
            .map_err(|error| error.to_string())?;
        thread::sleep(Duration::from_millis(55));
        send_ctrl_v()?;

        if let Some(previous) = previous {
            thread::sleep(Duration::from_millis(260));
            let _ = app.clipboard().write_text(previous);
        }
    } else {
        send_unicode_text(&text)?;
        if copy_to_clipboard {
            app.clipboard()
                .write_text(text)
                .map_err(|error| error.to_string())?;
        }
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn keyboard_input(
    virtual_key: u16,
    scan_code: u16,
    flags: u32,
) -> windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
    };

    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: virtual_key,
                wScan: scan_code,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

#[cfg(target_os = "windows")]
fn send_inputs(
    inputs: &[windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT],
) -> Result<(), String> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT};

    let sent = unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            size_of::<INPUT>() as i32,
        )
    };
    if sent == inputs.len() as u32 {
        Ok(())
    } else {
        Err("Windows rejected the simulated keyboard input".to_string())
    }
}

#[cfg(target_os = "windows")]
fn send_ctrl_v() -> Result<(), String> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{KEYEVENTF_KEYUP, VK_CONTROL, VK_V};

    let inputs = [
        keyboard_input(VK_CONTROL, 0, 0),
        keyboard_input(VK_V, 0, 0),
        keyboard_input(VK_V, 0, KEYEVENTF_KEYUP),
        keyboard_input(VK_CONTROL, 0, KEYEVENTF_KEYUP),
    ];
    send_inputs(&inputs)
}

#[cfg(not(target_os = "windows"))]
fn send_ctrl_v() -> Result<(), String> {
    Err("Text insertion is only supported on Windows".to_string())
}

#[cfg(target_os = "windows")]
fn send_unicode_text(text: &str) -> Result<(), String> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{KEYEVENTF_KEYUP, KEYEVENTF_UNICODE};

    let mut inputs = Vec::with_capacity(text.encode_utf16().count() * 2);
    for unit in text.encode_utf16() {
        inputs.push(keyboard_input(0, unit, KEYEVENTF_UNICODE));
        inputs.push(keyboard_input(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
    }
    send_inputs(&inputs)
}

#[cfg(not(target_os = "windows"))]
fn send_unicode_text(_text: &str) -> Result<(), String> {
    Err("Direct text insertion is only supported on Windows".to_string())
}

fn show_main_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window is unavailable".to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

fn configure_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Aevum", true, None::<&str>)?;
    let copy_last =
        MenuItem::with_id(app, "copy_last", "Copy Last Transcript", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Aevum", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &copy_last, &quit])?;

    let mut builder = TrayIconBuilder::with_id("hex-tray")
        .tooltip("Aevum — voice to text")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                let _ = show_main_window(app);
            }
            "copy_last" => {
                let transcript = app
                    .state::<AppState>()
                    .last_transcript
                    .lock()
                    .map(|value| value.clone())
                    .unwrap_or_default();
                if !transcript.is_empty() {
                    let _ = app.clipboard().write_text(transcript);
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[derive(Clone, Copy, Default, PartialEq)]
struct HoldCombo {
    ctrl: bool,
    alt: bool,
    shift: bool,
    win: bool,
    key: Option<u32>,
}

#[derive(Default)]
struct HoldKeyboardState {
    ctrl: bool,
    alt: bool,
    shift: bool,
    win: bool,
    key_down: bool,
}

static HOLD_COMBO: Mutex<Option<HoldCombo>> = Mutex::new(None);
static HOLD_KEYS: Mutex<HoldKeyboardState> = Mutex::new(HoldKeyboardState {
    ctrl: false,
    alt: false,
    shift: false,
    win: false,
    key_down: false,
});
static HOLD_ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static HOLD_APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();
static HOLD_TX: std::sync::OnceLock<std::sync::mpsc::Sender<bool>> = std::sync::OnceLock::new();

#[derive(Clone, Serialize)]
struct HoldHotkeyEvent {
    state: &'static str,
}

fn hold_vk_from_name(name: &str) -> Result<u32, String> {
    let upper = name.trim().to_ascii_uppercase();
    let bytes = upper.as_bytes();
    match upper.as_str() {
        "SPACE" => return Ok(0x20),
        "UP" => return Ok(0x26),
        "DOWN" => return Ok(0x28),
        "LEFT" => return Ok(0x25),
        "RIGHT" => return Ok(0x27),
        "HOME" => return Ok(0x24),
        "END" => return Ok(0x23),
        "PAGEUP" => return Ok(0x21),
        "PAGEDOWN" => return Ok(0x22),
        "INSERT" => return Ok(0x2D),
        _ => {}
    }
    if bytes.len() == 1 && bytes[0].is_ascii_uppercase() {
        return Ok(bytes[0] as u32);
    }
    if bytes.len() == 1 && bytes[0].is_ascii_digit() {
        return Ok(bytes[0] as u32);
    }
    if let Some(number) = upper.strip_prefix('F').and_then(|rest| rest.parse::<u32>().ok()) {
        if (1..=24).contains(&number) {
            return Ok(0x70 + number - 1);
        }
    }
    Err(format!("The key \"{name}\" is not supported."))
}

fn parse_hold_shortcut(shortcut: &str) -> Result<Option<HoldCombo>, String> {
    let trimmed = shortcut.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let mut combo = HoldCombo::default();
    for part in trimmed.split('+') {
        match part.trim().to_ascii_lowercase().as_str() {
            "ctrl" | "control" => combo.ctrl = true,
            "alt" | "option" => combo.alt = true,
            "shift" => combo.shift = true,
            "super" | "win" | "windows" | "meta" | "cmd" | "command" => combo.win = true,
            other => {
                if combo.key.is_some() {
                    return Err("A shortcut can contain only one regular key.".to_string());
                }
                combo.key = Some(hold_vk_from_name(other)?);
            }
        }
    }
    if !(combo.ctrl || combo.alt || combo.shift || combo.win) {
        return Err("Include at least one modifier such as Ctrl, Alt, Shift or Win.".to_string());
    }
    Ok(Some(combo))
}

// Runs inside the low-level hook callback, so it must stay near-instant:
// Windows removes hooks whose callbacks exceed the low-level hook timeout.
fn emit_hold_state(active: bool) {
    use std::sync::atomic::Ordering;
    if HOLD_ACTIVE.swap(active, Ordering::SeqCst) == active {
        return;
    }
    if let Some(sender) = HOLD_TX.get() {
        let _ = sender.send(active);
    }
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn hold_hotkey_hook(
    code: i32,
    wparam: windows_sys::Win32::Foundation::WPARAM,
    lparam: windows_sys::Win32::Foundation::LPARAM,
) -> windows_sys::Win32::Foundation::LRESULT {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, HC_ACTION, KBDLLHOOKSTRUCT, WM_KEYDOWN, WM_SYSKEYDOWN,
    };

    let mut swallow = false;
    if code == HC_ACTION as i32 {
        let info = &*(lparam as *const KBDLLHOOKSTRUCT);
        let vk = info.vkCode;
        let down = matches!(wparam as u32, WM_KEYDOWN | WM_SYSKEYDOWN);
        let combo = HOLD_COMBO.lock().ok().and_then(|guard| *guard);

        if let Ok(mut keys) = HOLD_KEYS.lock() {
            match vk {
                0xA2 | 0xA3 | 0x11 => keys.ctrl = down,
                0xA4 | 0xA5 | 0x12 => keys.alt = down,
                0xA0 | 0xA1 | 0x10 => keys.shift = down,
                0x5B | 0x5C => keys.win = down,
                _ => {
                    if let Some(combo) = combo {
                        if combo.key == Some(vk) {
                            keys.key_down = down;
                        }
                    }
                }
            }

            if let Some(combo) = combo {
                let modifiers_held = (!combo.ctrl || keys.ctrl)
                    && (!combo.alt || keys.alt)
                    && (!combo.shift || keys.shift)
                    && (!combo.win || keys.win);
                let satisfied = modifiers_held
                    && match combo.key {
                        Some(_) => keys.key_down,
                        None => true,
                    };
                if combo.key == Some(vk) && modifiers_held {
                    swallow = true;
                }
                drop(keys);
                emit_hold_state(satisfied);
            } else {
                drop(keys);
                emit_hold_state(false);
            }
        }
    }
    if swallow {
        1
    } else {
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }
}

#[cfg(target_os = "windows")]
fn start_hold_hotkey_hook(app: &AppHandle) {
    let _ = HOLD_APP.set(app.clone());
    let (sender, receiver) = std::sync::mpsc::channel::<bool>();
    let _ = HOLD_TX.set(sender);
    let emitter = app.clone();
    thread::spawn(move || {
        while let Ok(active) = receiver.recv() {
            let _ = emitter.emit(
                "hold-hotkey",
                HoldHotkeyEvent {
                    state: if active { "Pressed" } else { "Released" },
                },
            );
        }
    });
    thread::spawn(|| unsafe {
        use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetMessageW, SetWindowsHookExW, MSG, WH_KEYBOARD_LL,
        };
        let module = GetModuleHandleW(std::ptr::null());
        let mut hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hold_hotkey_hook), module, 0);
        if hook.is_null() {
            hook = SetWindowsHookExW(
                WH_KEYBOARD_LL,
                Some(hold_hotkey_hook),
                std::ptr::null_mut(),
                0,
            );
        }
        if hook.is_null() {
            if let Some(app) = HOLD_APP.get() {
                let _ = app.emit("hold-hotkey-hook-failed", ());
            }
            return;
        }
        let mut message: MSG = std::mem::zeroed();
        while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {}
    });
}

#[cfg(not(target_os = "windows"))]
fn start_hold_hotkey_hook(_app: &AppHandle) {}

#[tauri::command]
fn set_hold_hotkey(shortcut: String) -> Result<(), String> {
    let combo = parse_hold_shortcut(&shortcut)?;
    *HOLD_COMBO
        .lock()
        .map_err(|_| "The shortcut state is unavailable.".to_string())? = combo;
    emit_hold_state(false);
    Ok(())
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only web links can be opened.".to_string());
    }
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    let operation: Vec<u16> = "open\0".encode_utf16().collect();
    let url_wide: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            url_wide.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    };
    if result as usize > 32 {
        Ok(())
    } else {
        Err("Windows could not open the link.".to_string())
    }
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn open_external(_url: String) -> Result<(), String> {
    Err("Opening links is only supported on Windows.".to_string())
}

fn position_indicator(app: &tauri::App) {
    let Some(indicator) = app.get_webview_window("indicator") else {
        return;
    };
    let _ = indicator.set_ignore_cursor_events(true);
    let Ok(Some(monitor)) = indicator.primary_monitor() else {
        return;
    };
    let scale = monitor.scale_factor();
    let size = monitor.size();
    let x = (size.width as i32 - (220.0 * scale) as i32) / 2;
    let y = size.height as i32 - (132.0 * scale) as i32;
    let _ = indicator.set_position(Position::Physical(PhysicalPosition::new(x, y)));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let _ = show_main_window(app);
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            configure_tray(app)?;
            position_indicator(app);
            start_hold_hotkey_hook(&app.handle().clone());

            if let Some(main) = app.get_webview_window("main") {
                let window_to_hide = main.clone();
                main.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window_to_hide.hide();
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            copy_text,
            insert_text,
            open_external,
            prepare_transcription_model,
            set_hold_hotkey,
            set_indicator,
            set_last_transcript,
            show_main,
            transcribe_speech
        ])
        .run(tauri::generate_context!())
        .expect("error while running Aevum");
}

#[cfg(test)]
mod tests {
    use super::{ModelRequestTracker, PARAKEET_MODEL_ID, SENSEVOICE_MODEL_ID};

    #[test]
    fn newer_model_request_supersedes_older_generation() {
        let mut tracker = ModelRequestTracker::default();
        let first = tracker.begin(PARAKEET_MODEL_ID);
        let second = tracker.begin(SENSEVOICE_MODEL_ID);

        assert!(!tracker.is_current_request(first));
        assert!(tracker.is_current_request(second));
        assert!(tracker.wants(SENSEVOICE_MODEL_ID));
    }

    #[test]
    fn older_work_can_satisfy_latest_matching_intent() {
        let mut tracker = ModelRequestTracker::default();
        let first_sensevoice = tracker.begin(SENSEVOICE_MODEL_ID);
        tracker.begin(PARAKEET_MODEL_ID);
        tracker.begin(SENSEVOICE_MODEL_ID);

        assert!(!tracker.is_current_request(first_sensevoice));
        assert!(tracker.wants(SENSEVOICE_MODEL_ID));
    }
}
