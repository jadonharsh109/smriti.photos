fn main() {
    // tauri-build watches neither of these on its own, so a change here leaves
    // a stale ACL compiled into the binary — the command is simply absent at
    // runtime and the only symptom is a feature silently not working.
    println!("cargo:rerun-if-changed=capabilities");
    println!("cargo:rerun-if-changed=permissions");
    tauri_build::build()
}
