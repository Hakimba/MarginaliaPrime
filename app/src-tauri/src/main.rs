// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Launched by the `claude` CLI as the reader's tool server: no window, no
    // Tauri, and above all no single-instance handoff to the running app.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--reader-tools") {
        std::process::exit(marginalialib::reader_tools::serve(args.get(2).cloned()));
    }
    marginalialib::run();
}
