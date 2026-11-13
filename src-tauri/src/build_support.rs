use std::{
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Clone, Debug, Default)]
pub struct GitSnapshot {
    pub checkout_sha: Option<String>,
    pub branch: Option<String>,
    pub dirty: Option<bool>,
    pub watch_paths: Vec<PathBuf>,
}

fn git_output(directory: &Path, arguments: &[&str]) -> Option<Vec<u8>> {
    let output = Command::new("git")
        .args(["-C"])
        .arg(directory)
        .args(arguments)
        .output()
        .ok()?;
    output.status.success().then_some(output.stdout)
}

fn git_text(directory: &Path, arguments: &[&str]) -> Option<String> {
    let output = git_output(directory, arguments)?;
    let value = String::from_utf8(output).ok()?;
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn add_git_path(paths: &mut Vec<PathBuf>, root: &Path, value: &str) {
    let path = PathBuf::from(value.trim());
    if path.is_absolute() {
        paths.push(path);
    } else {
        paths.push(root.join(path));
    }
}

pub fn inspect_git(start_directory: &Path) -> GitSnapshot {
    let Some(root_value) = git_text(start_directory, &["rev-parse", "--show-toplevel"]) else {
        return GitSnapshot::default();
    };
    let root = PathBuf::from(root_value);
    let checkout_sha =
        git_text(&root, &["rev-parse", "--verify", "HEAD"]).filter(|sha| is_full_git_sha(sha));
    let symbolic_ref = git_text(&root, &["symbolic-ref", "--quiet", "HEAD"]);
    let branch = git_text(&root, &["symbolic-ref", "--quiet", "--short", "HEAD"]);
    let dirty = git_output(&root, &["status", "--porcelain", "--untracked-files=all"])
        .map(|status| !status.is_empty());

    let mut watch_paths = Vec::new();
    for git_file in ["HEAD", "index", "packed-refs"] {
        if let Some(path) = git_text(&root, &["rev-parse", "--git-path", git_file]) {
            add_git_path(&mut watch_paths, &root, &path);
        }
    }
    if let Some(reference) = symbolic_ref {
        if let Some(path) = git_text(&root, &["rev-parse", "--git-path", &reference]) {
            add_git_path(&mut watch_paths, &root, &path);
        }
    }

    if let Some(tracked) = git_output(&root, &["ls-files", "-z"]) {
        for path in tracked
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
        {
            if let Ok(path) = std::str::from_utf8(path) {
                watch_paths.push(root.join(path));
            }
        }
    }

    // Track source directories as well so newly added untracked files can
    // refresh the dirty bit without a clean Cargo rebuild.
    for directory in ["src", "src-tauri/src", ".github", "scripts", "docs"] {
        let path = root.join(directory);
        if path.exists() {
            watch_paths.push(path);
        }
    }
    watch_paths.sort();
    watch_paths.dedup();

    GitSnapshot {
        checkout_sha,
        branch,
        dirty,
        watch_paths,
    }
}

pub fn is_full_git_sha(value: &str) -> bool {
    (value.len() == 40 || value.len() == 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::{Path, PathBuf},
        process::Command,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    static NEXT_ID: AtomicU64 = AtomicU64::new(0);

    struct TestRepository {
        parent: PathBuf,
        root: PathBuf,
    }

    impl TestRepository {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let parent = std::env::temp_dir().join(format!(
                "velora-build-support-{}-{nonce}-{id}",
                std::process::id()
            ));
            let root = parent.join("repo");
            fs::create_dir_all(&root).expect("create temporary repository directory");
            run_git(&root, &["init", "--initial-branch=main"]);
            run_git(&root, &["config", "user.name", "VELORA provenance test"]);
            run_git(
                &root,
                &["config", "user.email", "velora-provenance@example.invalid"],
            );
            fs::write(root.join("README.md"), "first commit\n")
                .expect("write synthetic tracked file");
            run_git(&root, &["add", "README.md"]);
            run_git(&root, &["commit", "-m", "first synthetic commit"]);
            Self { parent, root }
        }

        fn commit_second_revision(&self) {
            fs::write(self.root.join("README.md"), "second commit\n")
                .expect("change synthetic tracked file");
            run_git(&self.root, &["add", "README.md"]);
            run_git(&self.root, &["commit", "-m", "second synthetic commit"]);
        }
    }

    impl Drop for TestRepository {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.parent);
        }
    }

    fn run_git(directory: &Path, arguments: &[&str]) -> String {
        let output = Command::new("git")
            .args(["-C"])
            .arg(directory)
            .args(arguments)
            .output()
            .expect("run Git in temporary repository");
        assert!(
            output.status.success(),
            "git {arguments:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout)
            .expect("Git output is UTF-8")
            .trim()
            .to_string()
    }

    fn cargo_probe_sha(directory: &Path, target_directory: &Path) -> String {
        let output = Command::new("cargo")
            .arg("run")
            .arg("--quiet")
            .arg("--manifest-path")
            .arg(directory.join("Cargo.toml"))
            .env("CARGO_TARGET_DIR", target_directory)
            .output()
            .expect("run cached Cargo provenance probe");
        assert!(
            output.status.success(),
            "Cargo provenance probe failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout)
            .expect("probe output is UTF-8")
            .trim()
            .to_string()
    }

    #[test]
    fn consecutive_commits_on_one_branch_report_the_current_full_sha_without_cleaning() {
        let repository = TestRepository::new();
        let first = inspect_git(&repository.root);
        assert!(is_full_git_sha(first.checkout_sha.as_deref().unwrap()));
        assert_eq!(first.branch.as_deref(), Some("main"));
        assert_eq!(first.dirty, Some(false));

        repository.commit_second_revision();
        let second = inspect_git(&repository.root);
        assert!(is_full_git_sha(second.checkout_sha.as_deref().unwrap()));
        assert_ne!(second.checkout_sha, first.checkout_sha);
        assert_eq!(second.branch.as_deref(), Some("main"));
        assert_eq!(second.dirty, Some(false));
        assert!(second
            .watch_paths
            .iter()
            .any(|path| path.ends_with("refs/heads/main")));
    }

    #[test]
    fn cargo_rebuild_on_a_same_branch_commit_refreshes_the_embedded_sha_without_cleaning() {
        let repository = TestRepository::new();
        let source_directory = repository.root.join("src");
        fs::create_dir_all(&source_directory).expect("create synthetic Rust source directory");
        let helper = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/build_support.rs");
        fs::copy(helper, source_directory.join("build_support.rs"))
            .expect("copy the exact build metadata helper into the fixture");
        fs::write(
            repository.root.join("Cargo.toml"),
            "[package]\nname = \"velora-provenance-probe\"\nversion = \"0.1.0\"\nedition = \"2021\"\nbuild = \"build.rs\"\n",
        )
        .expect("write synthetic Cargo manifest");
        fs::write(
            repository.root.join("build.rs"),
            r#"#[path = "src/build_support.rs"]
mod build_support;

fn main() {
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let snapshot = build_support::inspect_git(directory);
    for path in snapshot.watch_paths {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    println!("cargo:rustc-env=VELORA_PROBE_SHA={}", snapshot.checkout_sha.unwrap_or_default());
}
"#,
        )
        .expect("write synthetic Cargo build script");
        fs::write(
            repository.root.join("src/main.rs"),
            "fn main() { println!(\"{}\", env!(\"VELORA_PROBE_SHA\")); }\n",
        )
        .expect("write synthetic binary");
        run_git(&repository.root, &["add", "-A"]);
        run_git(
            &repository.root,
            &["commit", "-m", "add cached build probe"],
        );

        let target_directory = repository.parent.join("cargo-target");
        let first_sha = run_git(&repository.root, &["rev-parse", "HEAD"]);
        let first_build_sha = cargo_probe_sha(&repository.root, &target_directory);
        assert_eq!(first_build_sha, first_sha);

        std::thread::sleep(std::time::Duration::from_millis(1100));
        run_git(
            &repository.root,
            &[
                "commit",
                "--allow-empty",
                "-m",
                "advance branch without touching sources",
            ],
        );
        let second_sha = run_git(&repository.root, &["rev-parse", "HEAD"]);
        assert_ne!(second_sha, first_sha);
        let second_build_sha = cargo_probe_sha(&repository.root, &target_directory);
        assert_eq!(second_build_sha, second_sha);
    }

    #[test]
    fn detached_head_has_a_full_sha_and_no_branch_name() {
        let repository = TestRepository::new();
        run_git(&repository.root, &["checkout", "--detach", "HEAD"]);
        let snapshot = inspect_git(&repository.root);
        assert!(is_full_git_sha(snapshot.checkout_sha.as_deref().unwrap()));
        assert_eq!(snapshot.branch, None);
        assert_eq!(snapshot.dirty, Some(false));
    }

    #[test]
    fn worktree_dot_git_file_resolves_head_and_active_branch_ref() {
        let repository = TestRepository::new();
        let worktree = repository.parent.join("worktree");
        run_git(
            &repository.root,
            &[
                "worktree",
                "add",
                "-b",
                "worktree-branch",
                worktree.to_str().expect("worktree path is UTF-8"),
                "HEAD",
            ],
        );
        assert!(worktree.join(".git").is_file());
        let snapshot = inspect_git(&worktree);
        assert!(is_full_git_sha(snapshot.checkout_sha.as_deref().unwrap()));
        assert_eq!(snapshot.branch.as_deref(), Some("worktree-branch"));
        assert!(snapshot
            .watch_paths
            .iter()
            .any(|path| path.ends_with("refs/heads/worktree-branch")));
    }

    #[test]
    fn dirty_state_tracks_modified_and_untracked_files() {
        let repository = TestRepository::new();
        fs::write(repository.root.join("README.md"), "dirty\n")
            .expect("modify synthetic tracked file");
        assert_eq!(inspect_git(&repository.root).dirty, Some(true));
        fs::write(repository.root.join("untracked.txt"), "untracked\n")
            .expect("add synthetic untracked file");
        assert_eq!(inspect_git(&repository.root).dirty, Some(true));
    }

    #[test]
    fn missing_git_metadata_is_unknown_and_does_not_invent_a_sha() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("velora-no-git-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&directory).expect("create directory without Git metadata");
        let snapshot = inspect_git(&directory);
        assert_eq!(snapshot.checkout_sha, None);
        assert_eq!(snapshot.branch, None);
        assert_eq!(snapshot.dirty, None);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn full_sha_validation_rejects_abbreviated_and_malformed_values() {
        assert!(is_full_git_sha(&"a".repeat(40)));
        assert!(is_full_git_sha(&"b".repeat(64)));
        assert!(!is_full_git_sha("36312486cebb"));
        assert!(!is_full_git_sha(&format!("{}z", "a".repeat(39))));
    }
}
