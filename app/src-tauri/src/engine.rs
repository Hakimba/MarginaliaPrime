//! Runs the `claude` CLI as a child process and streams its newline-delimited
//! JSON protocol to the webview.
//!
//! One process per conversation, kept alive with `--input-format stream-json`
//! so the CLI owns the conversation history and the prompt cache stays warm.
//! The frontend owns the CLI contract (which flags, which JSON messages); this
//! module owns process lifetime, the working directory and the harness file.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

/// A running CLI process. `stdin` is taken out of the child so we can write to
/// it while the reader tasks own the output streams.
struct EngineProcess {
    child: Child,
    stdin: Option<ChildStdin>,
}

type Processes = Arc<Mutex<HashMap<String, EngineProcess>>>;

#[derive(Default)]
pub struct EngineState {
    processes: Processes,
}

/// Kill and forget the process registered under `id`, if any.
async fn stop_process(processes: &Processes, id: &str) {
    if let Some(mut proc) = processes.lock().await.remove(id) {
        drop(proc.stdin.take());
        let _ = proc.child.kill().await;
    }
}

#[derive(Clone, Serialize)]
struct LinePayload {
    id: String,
    line: String,
}

#[derive(Clone, Serialize)]
struct ExitPayload {
    id: String,
    code: Option<i32>,
}

#[derive(Serialize)]
pub struct StartInfo {
    /// Absolute path of the binary that was spawned.
    binary: String,
    /// Full argument list, harness flag included, for the Inspect overlay.
    args: Vec<String>,
    /// Working directory of the process.
    cwd: String,
}

#[derive(Serialize)]
pub struct BinaryInfo {
    path: String,
    version: String,
}

/// Locate the `claude` binary. A GUI-launched app does not inherit the shell's
/// PATH additions, so PATH alone is not enough (same trap as node).
fn resolve_binary() -> Result<PathBuf, String> {
    if let Ok(explicit) = std::env::var("MARGINALIA_CLAUDE_BIN") {
        let path = PathBuf::from(&explicit);
        if path.is_file() {
            return Ok(path);
        }
        return Err(format!(
            "MARGINALIA_CLAUDE_BIN points at {explicit}, which is not a file"
        ));
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in path_var.split(':').filter(|d| !d.is_empty()) {
            candidates.push(PathBuf::from(dir).join("claude"));
        }
    }
    if let Some(home) = dirs_home() {
        candidates.push(home.join(".local/bin/claude"));
        candidates.push(home.join(".claude/local/claude"));
        candidates.push(home.join("bin/claude"));
    }
    candidates.push(PathBuf::from("/usr/local/bin/claude"));
    candidates.push(PathBuf::from("/usr/bin/claude"));

    candidates.into_iter().find(|c| c.is_file()).ok_or_else(|| {
        "The `claude` command was not found. Install Claude Code and log in with `claude`, \
             or set MARGINALIA_CLAUDE_BIN to its full path."
            .to_string()
    })
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Per-book working directory for the CLI, outside the repository so that no
/// stray `CLAUDE.md` or `.mcp.json` is picked up from a project folder.
fn workdir_for(app: &AppHandle, book_key: &str) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("no app data directory: {e}"))?;
    let safe: String = book_key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let dir = base.join("engine").join(if safe.is_empty() {
        "default".to_string()
    } else {
        safe
    });
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Report the CLI's path and version, so the panel can explain a missing or
/// broken installation before the first message is sent.
#[tauri::command]
pub async fn engine_binary_info() -> Result<BinaryInfo, String> {
    let binary = resolve_binary()?;
    let output = Command::new(&binary)
        .arg("--version")
        .output()
        .await
        .map_err(|e| format!("cannot run {}: {e}", binary.display()))?;
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(BinaryInfo {
        path: binary.to_string_lossy().to_string(),
        version,
    })
}

/// Spawn a CLI process for `id`. `args` is the full argument list except the
/// harness flag, which is appended here after writing `harness.md` into the
/// process working directory.
#[tauri::command]
pub async fn engine_start(
    app: AppHandle,
    state: State<'_, EngineState>,
    id: String,
    book_key: String,
    args: Vec<String>,
    harness: String,
) -> Result<StartInfo, String> {
    let processes = state.processes.clone();
    stop_process(&processes, &id).await;

    let binary = resolve_binary()?;
    let cwd = workdir_for(&app, &book_key)?;
    let harness_path = cwd.join("harness.md");
    std::fs::write(&harness_path, harness)
        .map_err(|e| format!("cannot write {}: {e}", harness_path.display()))?;

    let mut full_args = args;
    full_args.push("--append-system-prompt-file".to_string());
    full_args.push(harness_path.to_string_lossy().to_string());

    let mut child = Command::new(&binary)
        .args(&full_args)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("cannot start {}: {e}", binary.display()))?;

    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    if let Some(stdout) = stdout {
        let app = app.clone();
        let id = id.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app.emit(
                    "engine://line",
                    LinePayload {
                        id: id.clone(),
                        line,
                    },
                );
            }
        });
    }

    if let Some(stderr) = stderr {
        let app = app.clone();
        let id = id.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log::warn!("[claude:{id}] {line}");
                let _ = app.emit(
                    "engine://stderr",
                    LinePayload {
                        id: id.clone(),
                        line,
                    },
                );
            }
        });
    }

    let info = StartInfo {
        binary: binary.to_string_lossy().to_string(),
        args: full_args,
        cwd: cwd.to_string_lossy().to_string(),
    };

    processes
        .lock()
        .await
        .insert(id.clone(), EngineProcess { child, stdin });

    // Report the exit so the panel can tell "finished" from "died".
    let app_for_wait = app.clone();
    let processes_for_wait = processes.clone();
    tauri::async_runtime::spawn(async move {
        // Poll instead of taking ownership of the child: `engine_stop` may kill it.
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
            let mut guard = processes_for_wait.lock().await;
            let Some(proc) = guard.get_mut(&id) else {
                break;
            };
            match proc.child.try_wait() {
                Ok(Some(status)) => {
                    let code = status.code();
                    guard.remove(&id);
                    drop(guard);
                    let _ = app_for_wait.emit(
                        "engine://exit",
                        ExitPayload {
                            id: id.clone(),
                            code,
                        },
                    );
                    break;
                }
                Ok(None) => continue,
                Err(_) => {
                    guard.remove(&id);
                    break;
                }
            }
        }
    });

    Ok(info)
}

/// Write one JSON line to the process stdin. The pipe is kept open: the CLI
/// waits on stdin for the next turn.
#[tauri::command]
pub async fn engine_send(
    state: State<'_, EngineState>,
    id: String,
    line: String,
) -> Result<(), String> {
    let mut guard = state.processes.lock().await;
    let proc = guard
        .get_mut(&id)
        .ok_or_else(|| "engine is not running".to_string())?;
    let stdin = proc
        .stdin
        .as_mut()
        .ok_or_else(|| "engine stdin is closed".to_string())?;
    let mut payload = line.into_bytes();
    payload.push(b'\n');
    stdin
        .write_all(&payload)
        .await
        .map_err(|e| format!("cannot write to engine: {e}"))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("cannot flush engine input: {e}"))
}

/// Kill the process for `id`, if any. Idempotent.
#[tauri::command]
pub async fn engine_stop(state: State<'_, EngineState>, id: String) -> Result<(), String> {
    stop_process(&state.processes, &id).await;
    Ok(())
}
