use std::{
    mem::size_of,
    sync::Mutex,
    thread,
    time::Duration,
};

use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, Position, WindowEvent,
};
use tauri_plugin_clipboard_manager::ClipboardExt;

#[derive(Default)]
struct AppState {
    last_transcript: Mutex<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct IndicatorState {
    status: String,
    level: f32,
    message: Option<String>,
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
fn keyboard_input(virtual_key: u16, scan_code: u16, flags: u32) -> windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT {
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
fn send_inputs(inputs: &[windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT]) -> Result<(), String> {
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
    let copy_last = MenuItem::with_id(
        app,
        "copy_last",
        "Copy Last Transcript",
        true,
        None::<&str>,
    )?;
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
            set_indicator,
            set_last_transcript,
            show_main
        ])
        .run(tauri::generate_context!())
        .expect("error while running Aevum");
}
