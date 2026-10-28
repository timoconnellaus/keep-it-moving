// No console window behind the app on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(debug_assertions)]
use tauri::Manager;
use tauri::{WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

const DEFAULT_URL: &str = "https://keep-it-moving.zerobsai.com";

/// Runs in every page the window loads, including Google's sign-in; it acts
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
            let site = url.origin();
            let handle = app.handle().clone();
            // Release builds grant the native bridge to the hosted site only.
            #[cfg(debug_assertions)]
            app.add_capability(include_str!("../dev-capabilities/local.json"))?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.clone()))
                .title("Keep it moving")
                .inner_size(1280.0, 820.0)
                .min_inner_size(720.0, 480.0)
                .initialization_script(&script)
                // Only the site and Google's sign-in load here; anything
                // else goes to the default browser.
                .on_navigation(move |target| {
                    // about:, blob: and data: frames stay in the page.
                    if !matches!(target.scheme(), "http" | "https") {
                        return true;
                    }
                    let allowed = target.origin() == site
                        || target.host_str() == Some("keep-it-moving.zerobsai.com")
                        || target.host_str() == Some("interviewer.zerobsai.com")
                        || (target.scheme() == "https"
                            && target.host_str() == Some("accounts.google.com"));
                    if !allowed {
                        let _ = handle.opener().open_url(target.as_str(), None::<&str>);
                    }
                    allowed
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Keep it moving");
}
