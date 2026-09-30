//! Storage of the book index the reader's tools search (see `reader_tools.rs`).
//!
//! The webview builds the index (it owns the PDF and EPUB parsers) and hands
//! it here as JSON. It lives in the app's data directory, away from the CLI's
//! working directory, so that nothing but the tools ever reads it.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

use tauri::{AppHandle, Manager};

/// A book hash as the library names it: nothing else may reach a file name.
fn checked_hash(hash: &str) -> Result<&str, String> {
    if !hash.is_empty() && hash.len() <= 64 && hash.chars().all(|c| c.is_ascii_alphanumeric()) {
        Ok(hash)
    } else {
        Err(format!("invalid book hash: {hash:?}"))
    }
}

/// Where the index of a book is kept.
pub fn index_path(app: &AppHandle, hash: &str) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("no app data directory: {e}"))?;
    Ok(base
        .join("index")
        .join(format!("{}.json", checked_hash(hash)?)))
}

/// Where the reading state the tools filter by is kept, beside the index.
fn state_path(app: &AppHandle, hash: &str) -> Result<PathBuf, String> {
    let index = index_path(app, hash)?;
    Ok(index.with_file_name(format!("{}.state.json", checked_hash(hash)?)))
}

/// The reading state of a book (furthest page read, permissions), if any.
#[tauri::command]
pub async fn book_state_load(app: AppHandle, hash: String) -> Result<Option<String>, String> {
    let path = state_path(&app, &hash)?;
    match std::fs::read_to_string(&path) {
        Ok(content) => Ok(Some(content)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

/// Store the reading state; the tools read it at every call.
#[tauri::command]
pub async fn book_state_write(app: AppHandle, hash: String, content: String) -> Result<(), String> {
    let path = state_path(&app, &hash)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    let partial = path.with_extension(format!(
        "json.{}.{}.part",
        std::process::id(),
        WRITES.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&partial, content)
        .map_err(|e| format!("cannot write {}: {e}", partial.display()))?;
    std::fs::rename(&partial, &path).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

/// The stored index, or None when the book has none yet.
#[tauri::command]
pub async fn book_index_load(app: AppHandle, hash: String) -> Result<Option<String>, String> {
    let path = index_path(&app, &hash)?;
    match std::fs::read_to_string(&path) {
        Ok(content) => Ok(Some(content)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

/// Whether stored index JSON says it is complete.
fn is_complete(content: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(content)
        .ok()
        .and_then(|v| v.get("complete").and_then(serde_json::Value::as_bool))
        .unwrap_or(false)
}

static WRITES: AtomicUsize = AtomicUsize::new(0);

/// Store the index, replacing the previous one in a single step: the tools
/// may be reading it at that very moment. A checkpoint never replaces a
/// complete index: the same book open twice would otherwise undo the other.
#[tauri::command]
pub async fn book_index_write(app: AppHandle, hash: String, content: String) -> Result<(), String> {
    let path = index_path(&app, &hash)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    if !is_complete(&content) {
        if let Ok(existing) = std::fs::read_to_string(&path) {
            if is_complete(&existing) {
                return Ok(());
            }
        }
    }
    // One temporary file per write: two writers never share one.
    let partial = path.with_extension(format!(
        "json.{}.{}.part",
        std::process::id(),
        WRITES.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&partial, content)
        .map_err(|e| format!("cannot write {}: {e}", partial.display()))?;
    std::fs::rename(&partial, &path).map_err(|e| format!("cannot write {}: {e}", path.display()))
}
