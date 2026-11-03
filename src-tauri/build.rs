fn main() {
    // The icons are compiled into the binary: icons/icon.ico as the Windows executable's
    // resource (window and taskbar icon), the PNG as the window icon elsewhere. tauri-build
    // only reruns when the config changes, so without this a replaced icon keeps showing
    // the old one until `cargo clean`.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
