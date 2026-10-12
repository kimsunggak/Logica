//! LOGICA desktop backend.
//!
//! The backend is intentionally small. It only does what the webview cannot do
//! safely on its own:
//!
//! * `project`: sandboxed file access inside the opened LaTeX project folder.
//! * `compile`: running the local LaTeX toolchain.
//! * `credentials`: storing provider secrets in the OS credential store.
//! * `chatgpt`: Sign in with ChatGPT (OAuth with PKCE and a loopback redirect).
//! * `ai`: forwarding AI requests to fixed provider endpoints, attaching the
//!   stored credential so that secrets never reach the webview.
//! * `app_state`: persisting non-secret UI state and settings.

mod ai;
mod app_state;
mod chatgpt;
mod compile;
mod credentials;
mod error;
mod project;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(ai::AiRequests::default())
        .manage(chatgpt::ChatGptAuth::default())
        .invoke_handler(tauri::generate_handler![
            project::list_project_files,
            project::read_text_file,
            project::write_text_file,
            project::stat_files,
            project::read_binary_file,
            project::path_exists,
            compile::detect_compilers,
            compile::compile_latex,
            credentials::credential_status,
            credentials::credential_set,
            credentials::credential_delete,
            ai::ai_stream,
            ai::ai_cancel,
            ai::ai_get,
            chatgpt::chatgpt_status,
            chatgpt::chatgpt_sign_in,
            chatgpt::chatgpt_cancel_sign_in,
            chatgpt::chatgpt_sign_out,
            app_state::load_app_state,
            app_state::save_app_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LOGICA");
}
