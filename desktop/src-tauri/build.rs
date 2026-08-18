fn main() {
    // tauri-build does not watch capabilities/ on its own, so a change there
    // leaves a stale ACL compiled into the binary — the command is simply
    // absent at runtime and the only symptom is a feature silently not working.
    println!("cargo:rerun-if-changed=capabilities");
    tauri_build::build()
}
