// No console window behind the app on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{WebviewUrl, WebviewWindowBuilder};

const DEFAULT_URL: &str = "https://keep-it-moving.zerobsai.com";

/// Runs in every page the window loads, including the Access login; it acts
/// only on the Keep it moving origin.
const DESKTOP_JS: &str = include_str!("desktop.js");

fn main() {
    // The same variable the CLI reads, so `wrangler dev` works here too.
    let url = std::env::var("KEEP_IT_MOVING_URL").unwrap_or_else(|_| DEFAULT_URL.into());
    let url: tauri::Url = url.parse().expect("KEEP_IT_MOVING_URL must be a URL");
    let script = format!(
        "window.__KIM_ORIGIN__ = {:?};\n{DESKTOP_JS}",
        url.origin().ascii_serialization()
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Keep it moving")
                .inner_size(1280.0, 820.0)
                .min_inner_size(720.0, 480.0)
                .initialization_script(&script)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Keep it moving");
}
