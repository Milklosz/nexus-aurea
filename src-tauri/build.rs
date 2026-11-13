#[path = "src/build_support.rs"]
mod build_support;

use std::{env, process::Command};

fn main() {
    emit_build_provenance();
    tauri_build::build()
}

fn emit_build_provenance() {
    for name in [
        "VELORA_SOURCE_SHA",
        "VELORA_BUILD_EVENT",
        "VELORA_BUILD_REF",
        "VELORA_PR_HEAD_SHA",
        "VELORA_PR_BASE_SHA",
        "VELORA_CHECKOUT_SHA",
        "GITHUB_SHA",
        "GITHUB_REF",
        "GITHUB_REF_NAME",
        "GITHUB_EVENT_NAME",
        "GITHUB_RUN_ID",
        "GITHUB_RUN_ATTEMPT",
        "PROFILE",
        "TARGET",
        "RUSTC",
    ] {
        println!("cargo:rerun-if-env-changed={name}");
    }

    let manifest = env::var_os("CARGO_MANIFEST_DIR")
        .map(std::path::PathBuf::from)
        .expect("Cargo provides CARGO_MANIFEST_DIR");
    let git = build_support::inspect_git(&manifest);
    for path in &git.watch_paths {
        println!("cargo:rerun-if-changed={}", path.display());
    }

    let expected_source_sha = env::var("VELORA_SOURCE_SHA")
        .ok()
        .filter(|value| !value.is_empty());
    let expected_checkout_sha = env::var("VELORA_CHECKOUT_SHA")
        .ok()
        .filter(|value| !value.is_empty());
    for expected in [
        expected_source_sha.as_deref(),
        expected_checkout_sha.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        assert!(
            build_support::is_full_git_sha(expected),
            "CI source and checkout SHA values must be full Git commit SHAs"
        );
        if let Some(actual) = git.checkout_sha.as_deref() {
            assert_eq!(
                expected, actual,
                "CI source SHA does not match the checked out commit"
            );
        }
    }
    if let (Some(source), Some(checkout)) = (
        expected_source_sha.as_deref(),
        expected_checkout_sha.as_deref(),
    ) {
        assert_eq!(
            source, checkout,
            "VELORA_SOURCE_SHA and VELORA_CHECKOUT_SHA must identify the same checked out tree"
        );
    }

    let source_sha = expected_source_sha
        .or_else(|| git.checkout_sha.clone())
        .unwrap_or_else(|| "unknown".to_string());
    let checkout_sha = expected_checkout_sha
        .or(git.checkout_sha)
        .unwrap_or_else(|| "unknown".to_string());
    let branch = git.branch.unwrap_or_else(|| "detached".to_string());
    let dirty = git
        .dirty
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let build_ref =
        env_first(&["VELORA_BUILD_REF", "GITHUB_REF"]).unwrap_or_else(|| branch.clone());
    let event = env_first(&["VELORA_BUILD_EVENT", "GITHUB_EVENT_NAME"])
        .unwrap_or_else(|| "local".to_string());
    let pr_head_sha =
        env_first(&["VELORA_PR_HEAD_SHA"]).filter(|value| build_support::is_full_git_sha(value));
    let pr_base_sha =
        env_first(&["VELORA_PR_BASE_SHA"]).filter(|value| build_support::is_full_git_sha(value));
    let target = env_first(&["TARGET"]).unwrap_or_else(|| "unknown".to_string());
    let profile = env_first(&["PROFILE"]).unwrap_or_else(|| "unknown".to_string());
    let rustc_version = rustc_version();

    emit("VELORA_BUILD_SHA", &source_sha);
    emit("VELORA_CHECKOUT_SHA", &checkout_sha);
    emit("VELORA_BUILD_BRANCH", &branch);
    emit("VELORA_BUILD_REF", &build_ref);
    emit("VELORA_BUILD_DIRTY", &dirty);
    emit("VELORA_BUILD_EVENT", &event);
    emit("VELORA_PR_HEAD_SHA", pr_head_sha.as_deref().unwrap_or(""));
    emit("VELORA_PR_BASE_SHA", pr_base_sha.as_deref().unwrap_or(""));
    emit("VELORA_BUILD_TARGET", &target);
    emit("VELORA_BUILD_PROFILE", &profile);
    emit("VELORA_RUSTC_VERSION", &rustc_version);
}

fn env_first(names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| env::var(name).ok().filter(|value| !value.is_empty()))
}

fn emit(name: &str, value: &str) {
    let safe_value = value.replace(['\r', '\n'], " ");
    println!("cargo:rustc-env={name}={safe_value}");
}

fn rustc_version() -> String {
    let executable = env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
    Command::new(executable)
        .arg("--version")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}
