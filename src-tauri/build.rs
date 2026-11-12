use std::process::Command;

fn main() {
    emit_build_sha();
    tauri_build::build()
}

fn emit_build_sha() {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let output = Command::new("git")
        .args(["rev-parse", "--short=12", "HEAD"])
        .current_dir(manifest)
        .output();
    let sha = output
        .ok()
        .filter(|result| result.status.success())
        .and_then(|result| String::from_utf8(result.stdout).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=VELORA_BUILD_SHA={sha}");
    println!("cargo:rerun-if-changed=../.git/HEAD");
}
