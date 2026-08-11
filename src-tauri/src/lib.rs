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
struct AppState {
    last_transcript: Mutex<String>,
    transcription_model: Arc<Mutex<Option<LoadedModel>>>,
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
    status: String,
    file: String,
    loaded: u64,
    total: u64,
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
    archive: &str,
    status: &str,
    loaded: u64,
    total: u64,
) -> Result<(), String> {
    app.emit(
        "transcription-model-progress",
        ModelProgress {
            status: status.to_string(),
            file: archive.to_string(),
            loaded,
            total,
        },
    )
    .map_err(|error| error.to_string())
}

fn install_model(app: &AppHandle, models_dir: &Path, spec: ModelSpec) -> Result<PathBuf, String> {
    fs::create_dir_all(models_dir).map_err(|error| error.to_string())?;
    let final_dir = models_dir.join(spec.directory);
    if model_files_are_ready(&final_dir, spec.files) {
        return Ok(final_dir);
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
    emit_model_progress(app, spec.archive, "progress", 0, total)?;

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
            emit_model_progress(app, spec.archive, "progress", loaded, total)?;
            last_progress = Instant::now();
        }
    }
    output.flush().map_err(|error| error.to_string())?;
    emit_model_progress(app, spec.archive, "verifying", loaded, total)?;

    let actual_hash = format!("{:x}", hasher.finalize());
    if actual_hash != spec.sha256 {
        let _ = fs::remove_file(&partial_path);
        return Err(format!(
            "The {} download was corrupt. Please try again.",
            spec.name
        ));
    }

    emit_model_progress(app, spec.archive, "extracting", loaded, total)?;
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
        spec.archive,
        "done",
        total.max(loaded),
        total.max(loaded),
    )?;
    Ok(final_dir)
}

#[tauri::command]
async fn prepare_transcription_model(
    app: AppHandle,
    state: State<'_, AppState>,
    model: String,
) -> Result<(), String> {
    let spec = model_spec(&model)?;
    let model_slot = state.transcription_model.clone();
    let model_app = app.clone();
    let models_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("models");

    tauri::async_runtime::spawn_blocking(move || {
        let mut model = model_slot
            .lock()
            .map_err(|_| "The transcription model state is unavailable.".to_string())?;
        if model.as_ref().is_some_and(|loaded| loaded.id() == spec.id) {
            return Ok(());
        }
        *model = None;
        let model_dir = install_model(&model_app, &models_dir, spec)?;
        emit_model_progress(&model_app, spec.archive, "loading", 1, 1)?;
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
        *model = Some(loaded);
        emit_model_progress(&model_app, spec.archive, "ready", 1, 1)?;
        Ok(())
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
    if bytes.is_empty() || bytes.len() % size_of::<f32>() != 0 {
        return Err("The recorded audio was empty or invalid.".to_string());
    }
    let audio = bytes
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
            prepare_transcription_model,
            set_indicator,
            set_last_transcript,
            show_main,
            transcribe_speech
        ])
        .run(tauri::generate_context!())
        .expect("error while running Aevum");
}
