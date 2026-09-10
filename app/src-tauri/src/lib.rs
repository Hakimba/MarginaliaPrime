use std::path::PathBuf;
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::{AppHandle, Manager};
use tauri_plugin_fs::FsExt;

#[cfg(desktop)]
use tauri::Url;

mod dir_scanner;
mod engine;

use tauri::{Emitter, WebviewUrl, WebviewWindowBuilder};

#[cfg(desktop)]
fn allow_file_in_scopes(app: &AppHandle, files: Vec<PathBuf>) {
    let fs_scope = app.fs_scope();
    let asset_protocol_scope = app.asset_protocol_scope();
    for file in &files {
        if let Err(e) = fs_scope.allow_file(file) {
            log::error!("Failed to allow file in fs_scope: {e}");
        } else {
            log::debug!("Allowed file in fs_scope: {file:?}");
        }
        if let Err(e) = asset_protocol_scope.allow_file(file) {
            log::error!("Failed to allow file in asset_protocol_scope: {e}");
        } else {
            log::debug!("Allowed file in asset_protocol_scope: {file:?}");
        }
    }
}

fn allow_dir_in_scopes(app: &AppHandle, dir: &PathBuf) {
    let fs_scope = app.fs_scope();
    let asset_protocol_scope = app.asset_protocol_scope();
    if let Err(e) = fs_scope.allow_directory(dir, true) {
        log::error!("Failed to allow directory in fs_scope: {e}");
    } else {
        log::info!("Allowed directory in fs_scope: {dir:?}");
    }
    if let Err(e) = asset_protocol_scope.allow_directory(dir, true) {
        log::error!("Failed to allow directory in asset_protocol_scope: {e}");
    } else {
        log::info!("Allowed directory in asset_protocol_scope: {dir:?}");
    }
}

#[cfg(desktop)]
fn get_files_from_argv(argv: Vec<String>) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for (_, maybe_file) in argv.iter().enumerate().skip(1) {
        if maybe_file.starts_with("-") {
            continue;
        }
        if let Ok(url) = Url::parse(maybe_file) {
            if let Ok(path) = url.to_file_path() {
                files.push(path);
            } else {
                files.push(PathBuf::from(maybe_file))
            }
        } else {
            files.push(PathBuf::from(maybe_file))
        }
    }
    files
}

/// Render file paths as a JavaScript array literal for the init script,
/// or `null` when no file was given (the JS side checks for a defined array).
fn files_to_js_array(files: &[PathBuf]) -> String {
    if files.is_empty() {
        return "null".to_string();
    }
    let items = files
        .iter()
        .map(|f| {
            let file = f
                .to_string_lossy()
                .replace('\\', "\\\\")
                .replace('"', "\\\"");
            format!("\"{file}\"")
        })
        .collect::<Vec<_>>()
        .join(",");
    format!("[{items}]")
}

#[tauri::command]
fn get_environment_variable(name: &str) -> String {
    std::env::var(String::from(name)).unwrap_or(String::from(""))
}

#[tauri::command]
fn read_file_contents(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_executable_dir() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|p| p.to_path_buf()))
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

#[derive(Clone, serde::Serialize)]
#[allow(dead_code)]
struct SingleInstancePayload {
    args: Vec<String>,
    cwd: String,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .level_for("tracing", log::LevelFilter::Warn)
                .build(),
        )
        .plugin(tauri_plugin_process::init())
        .manage(engine::EngineState::default())
        .invoke_handler(tauri::generate_handler![
            get_environment_variable,
            get_executable_dir,
            read_file_contents,
            dir_scanner::read_dir,
            engine::engine_binary_info,
            engine::engine_start,
            engine::engine_send,
            engine::engine_stop,
        ])
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init());

    #[cfg(desktop)]
    let builder = builder.plugin(
        tauri_plugin_single_instance::Builder::new()
            .callback(move |app, argv, cwd| {
                let _ = app
                    .get_webview_window("main")
                    .expect("no main window")
                    .set_focus();
                let files = get_files_from_argv(argv.clone());
                if !files.is_empty() {
                    allow_file_in_scopes(app, files.clone());
                }
                app.emit("single-instance", SingleInstancePayload { args: argv, cwd })
                    .unwrap();
            })
            .dbus_id("com.eddmann.marginalia".to_owned())
            .build(),
    );

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());

    builder
        .setup(|#[allow(unused_variables)] app| {
            // Files given on the command line ("open with"): allow them in the
            // fs/asset scopes and hand them to the webview through the init
            // script below, so no plugin round-trip is needed at startup.
            #[cfg(desktop)]
            let argv_files = get_files_from_argv(std::env::args().collect());
            #[cfg(not(desktop))]
            let argv_files: Vec<PathBuf> = Vec::new();
            #[cfg(desktop)]
            if !argv_files.is_empty() {
                allow_file_in_scopes(app.handle(), argv_files.clone());
            }
            let open_with_files_js = files_to_js_array(&argv_files);

            #[cfg(desktop)]
            {
                allow_dir_in_scopes(app.handle(), &PathBuf::from(get_executable_dir()));
            }

            #[cfg(desktop)]
            let cli_access = true;
            #[cfg(not(desktop))]
            let cli_access = false;

            #[cfg(target_os = "linux")]
            let is_appimage = std::env::var("APPIMAGE").is_ok()
                || std::env::current_exe()
                    .map(|path| path.to_string_lossy().contains("/tmp/.mount_"))
                    .unwrap_or(false);
            #[cfg(not(target_os = "linux"))]
            let is_appimage = false;

            let init_script = format!(
                r#"
                    if ({cli_access}) window.__MARGINALIA_CLI_ACCESS = true;
                    if ({is_appimage}) window.__MARGINALIA_IS_APPIMAGE = true;
                    window.OPEN_WITH_FILES = {open_with_files};
                    (function () {{
                        // 3 = info, 4 = warn, 5 = error in tauri-plugin-log.
                        var report = function (msg, level) {{
                            try {{
                                window.__TAURI_INTERNALS__.invoke('plugin:log|log', {{
                                    level: level || 5, message: '[js] ' + msg, location: 'webview'
                                }});
                            }} catch (_) {{}}
                        }};
                        var levelOf = {{ info: 3, warn: 4, error: 5 }};
                        window.addEventListener('error', function (e) {{
                            var stack = e.error && e.error.stack ? ' | ' + e.error.stack : '';
                            report((e.message || 'error') + ' @ ' + (e.filename || '?') + ':' + (e.lineno || 0) + stack);
                        }});
                        window.addEventListener('unhandledrejection', function (e) {{
                            var r = e.reason;
                            report('unhandled rejection: ' + (r && (r.stack || r.message) || String(r)));
                        }});
                        ['warn', 'error', 'info'].forEach(function (level) {{
                            var orig = console[level].bind(console);
                            console[level] = function () {{
                                var parts = [];
                                for (var i = 0; i < arguments.length; i++) {{
                                    var a = arguments[i];
                                    parts.push(a && a.stack ? a.stack : (typeof a === 'object' ? JSON.stringify(a) : String(a)));
                                }}
                                var text = parts.join(' ');
                                // Perf marks log themselves already; don't duplicate them.
                                if (text.indexOf('[perf]') !== 0) {{
                                    report('console.' + level + ': ' + text.slice(0, 2000), levelOf[level]);
                                }}
                                orig.apply(console, arguments);
                            }};
                        }});
                    }})();
                    window.addEventListener('DOMContentLoaded', function() {{
                        document.documentElement.classList.add('edge-to-edge');
                    }});
                "#,
                cli_access = cli_access,
                is_appimage = is_appimage,
                open_with_files = open_with_files_js,
            );

            let win_builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .background_throttling(BackgroundThrottlingPolicy::Disabled)
                .background_color(tauri::window::Color(50, 49, 48, 255))
                .initialization_script(&init_script);

            #[cfg(desktop)]
            let win_builder = win_builder.inner_size(800.0, 600.0).resizable(true);

            #[cfg(target_os = "macos")]
            let win_builder = win_builder.decorations(true).title("");

            #[cfg(all(not(target_os = "macos"), desktop))]
            let win_builder = {
                let mut builder = win_builder
                    .decorations(false)
                    .visible(false)
                    .shadow(true)
                    .title("Marginalia");

                #[cfg(target_os = "windows")]
                {
                    builder = builder.transparent(false);
                }
                #[cfg(target_os = "linux")]
                {
                    builder = builder
                        .transparent(true)
                        .background_color(tauri::window::Color(0, 0, 0, 0));
                }

                builder
            };

            win_builder.build().unwrap();

            app.handle().emit("window-ready", ()).unwrap();

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(
            #[allow(unused_variables)]
            |app_handle, event| {
                #[cfg(target_os = "macos")]
                if let tauri::RunEvent::Opened { urls } = event {
                    let files = urls
                        .into_iter()
                        .filter_map(|url| url.to_file_path().ok())
                        .collect::<Vec<_>>();

                    let app_handler_clone = app_handle.clone();
                    allow_file_in_scopes(app_handle, files.clone());
                    app_handle.listen("window-ready", move |_| {
                        println!("Window is ready, proceeding to handle files.");
                        set_window_open_with_files(&app_handler_clone, files.clone());
                    });
                }
            },
        );
}
