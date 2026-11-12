//! A small opt-in Gaoge workflow, installed only with the Gaoge image MCP.
//! Never edit the bundled official imagegen skill or take over user-owned skills.
use sha2::{Digest, Sha256};
use std::fs::{self, Metadata, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Component, Path};

const SKILL: &str = include_str!("../../resources/skills/gaoge-image/SKILL.md");
const RECEIPT: &str = ".gaoge-managed-v1";
const RECEIPT_HEADER: &str = "gaoge-image-skill-v1\n";

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn is_link(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Reject junctions and other reparse points as well as symbolic links.
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

fn checked_metadata(path: &Path) -> Result<Option<Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if is_link(&metadata) => Err(format!(
            "Gaoge skill refuses a symbolic link or reparse point: {}",
            path.display()
        )),
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Read Gaoge skill path {}: {error}", path.display())),
    }
}

fn check_ancestors(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("Gaoge skill requires an absolute Codex home without parent traversal".into());
    }
    for ancestor in path.ancestors() {
        if let Some(metadata) = checked_metadata(ancestor)? {
            if !metadata.is_dir() {
                return Err(format!(
                    "Gaoge skill ancestor is not a directory: {}",
                    ancestor.display()
                ));
            }
        }
    }
    Ok(())
}

fn ensure_directory(path: &Path) -> Result<(), String> {
    check_ancestors(path)?;
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
        Err(error) => {
            return Err(format!(
                "Create Gaoge skill directory {}: {error}",
                path.display()
            ))
        }
    }
    match checked_metadata(path)? {
        Some(metadata) if metadata.is_dir() => Ok(()),
        _ => Err(format!("Invalid Gaoge skill directory: {}", path.display())),
    }
}

fn read_regular(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match checked_metadata(path)? {
        None => Ok(None),
        Some(metadata) if metadata.is_file() => fs::read(path)
            .map(Some)
            .map_err(|error| format!("Read Gaoge skill file {}: {error}", path.display())),
        Some(_) => Err(format!(
            "Gaoge skill path is not a regular file: {}",
            path.display()
        )),
    }
}

// A receipt alone is insufficient: the file must still match its recorded hash.
fn owns(skill: &[u8], receipt: &[u8]) -> bool {
    receipt == format!("{RECEIPT_HEADER}{}\n", digest(skill)).as_bytes()
}

fn atomic_write(path: &Path, bytes: &[u8], expected: Option<&[u8]>) -> Result<(), String> {
    let parent = path.parent().ok_or("Gaoge skill file has no parent")?;
    check_ancestors(parent)?;
    let temporary = parent.join(format!(
        ".gaoge-write-{}-{:016x}.tmp",
        std::process::id(),
        rand::random::<u64>()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("Create temporary Gaoge skill file: {error}"))?;
        file.write_all(bytes)
            .map_err(|error| format!("Write Gaoge skill file: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Sync Gaoge skill file: {error}"))?;
        drop(file);
        check_ancestors(parent)?;
        let current = read_regular(path)?;
        if current.as_deref() != expected {
            return Err("Gaoge skill changed concurrently; preserved the newer file".to_string());
        }
        if expected.is_none() {
            // Publishing via a hard link is atomic and cannot replace an existing
            // file, including one another process creates after the check above.
            fs::hard_link(&temporary, path)
                .map_err(|error| format!("Publish Gaoge skill file: {error}"))?;
        } else {
            super::replace_file_atomically(&temporary, path)?;
        }
        Ok(())
    })();
    let _ = fs::remove_file(&temporary);
    result
}

#[derive(Debug, PartialEq, Eq)]
enum SyncOutcome {
    Changed(&'static str),
    Current,
    PreservedCustom(&'static str),
}

impl SyncOutcome {
    fn changed(&self) -> bool {
        matches!(self, Self::Changed(_))
    }
}

/// Returns true only when a managed skill was installed, updated, or removed.
/// A same-name user skill (or any modified managed skill) is left untouched.
/// The caller creates Codex home; this function never changes global settings.
pub(crate) fn sync(codex_home: &Path, enabled: bool) -> Result<bool, String> {
    sync_managed(codex_home, enabled).map(|outcome| outcome.changed())
}

/// Upgrade the bundled workflow for a target already using the Gaoge image MCP.
/// The caller must check the existing MCP configuration before invoking this:
/// startup discovery must not opt an unrelated Codex home into the integration.
/// This changes files only; an already-running MCP/client still needs a restart.
pub(crate) fn sync_existing_integration(codex_home: &Path) -> serde_json::Value {
    let skill_path = codex_home.join("skills/gaoge-image/SKILL.md");
    let (status, changed, preserved_custom, message) = match sync_managed(codex_home, true) {
        Ok(SyncOutcome::Changed(message)) => ("changed", true, false, message.to_string()),
        Ok(SyncOutcome::Current) => (
            "current",
            false,
            false,
            "Gaoge image skill is already current".to_string(),
        ),
        Ok(SyncOutcome::PreservedCustom(message)) => {
            ("preserved_custom", false, true, message.to_string())
        }
        Err(error) => ("error", false, false, error),
    };
    serde_json::json!({
        "status": status,
        "changed": changed,
        "preservedCustom": preserved_custom,
        "message": message,
        "skillPath": skill_path.to_string_lossy(),
    })
}

fn sync_managed(codex_home: &Path, enabled: bool) -> Result<SyncOutcome, String> {
    check_ancestors(codex_home)?;
    let skills = codex_home.join("skills");
    let directory = skills.join("gaoge-image");
    check_ancestors(&directory)?;
    let skill_path = directory.join("SKILL.md");
    let receipt_path = directory.join(RECEIPT);
    let existed = checked_metadata(&directory)?.is_some();
    if !existed && !enabled {
        return Ok(SyncOutcome::Current);
    }
    if !existed {
        ensure_directory(&skills)?;
        // Do not claim a concurrently-created directory as our own.
        fs::create_dir(&directory).map_err(|error| format!("Create Gaoge image skill: {error}"))?;
        check_ancestors(&directory)?;
        atomic_write(&skill_path, SKILL.as_bytes(), None)?;
        let receipt = format!("{RECEIPT_HEADER}{}\n", digest(SKILL.as_bytes()));
        atomic_write(&receipt_path, receipt.as_bytes(), None)?;
        return Ok(SyncOutcome::Changed(
            "Installed the managed Gaoge image skill",
        ));
    }
    let current = read_regular(&skill_path)?;
    let receipt = read_regular(&receipt_path)?;
    let (Some(current), Some(receipt)) = (current, receipt) else {
        return Ok(SyncOutcome::PreservedCustom(
            "Preserved an existing Gaoge skill without a complete managed receipt",
        ));
    };
    if !owns(&current, &receipt) {
        return Ok(SyncOutcome::PreservedCustom(
            "Preserved a modified Gaoge skill or an unrecognized managed receipt",
        ));
    }
    if enabled {
        if current == SKILL.as_bytes() {
            return Ok(SyncOutcome::Current);
        }
        atomic_write(&skill_path, SKILL.as_bytes(), Some(&current))?;
        let next_receipt = format!("{RECEIPT_HEADER}{}\n", digest(SKILL.as_bytes()));
        atomic_write(&receipt_path, next_receipt.as_bytes(), Some(&receipt))?;
        Ok(SyncOutcome::Changed(
            "Updated the managed Gaoge image skill",
        ))
    } else {
        check_ancestors(&directory)?;
        if read_regular(&skill_path)?.as_deref() != Some(current.as_slice())
            || read_regular(&receipt_path)?.as_deref() != Some(receipt.as_slice())
        {
            return Err("Gaoge skill changed concurrently; preserved user content".into());
        }
        fs::remove_file(&skill_path)
            .map_err(|error| format!("Remove managed Gaoge skill: {error}"))?;
        fs::remove_file(&receipt_path)
            .map_err(|error| format!("Remove Gaoge skill receipt: {error}"))?;
        // Never recursively remove this folder: additional files belong to users.
        let _ = fs::remove_dir(&directory);
        Ok(SyncOutcome::Changed(
            "Removed the managed Gaoge image skill",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn path(home: &Path) -> std::path::PathBuf {
        home.join("skills/gaoge-image/SKILL.md")
    }

    #[test]
    fn install_is_idempotent_and_uninstall_removes_only_managed_files() {
        let home = home();
        let root = home.path().canonicalize().unwrap();
        assert!(sync(&root, true).unwrap());
        assert_eq!(fs::read(path(&root)).unwrap(), SKILL.as_bytes());
        assert!(!sync(&root, true).unwrap());
        assert!(sync(&root, false).unwrap());
        assert!(!path(&root).exists());
        assert!(root.join("skills").is_dir());
        assert!(!sync(&root, false).unwrap());
    }

    #[test]
    fn never_takes_over_an_existing_same_name_skill_or_empty_directory() {
        let home = home();
        let root = home.path().canonicalize().unwrap();
        let skill = path(&root);
        fs::create_dir_all(skill.parent().unwrap()).unwrap();
        assert!(!sync(&root, true).unwrap());
        fs::write(&skill, b"user-owned content").unwrap();
        assert!(!sync(&root, true).unwrap());
        assert!(!sync(&root, false).unwrap());
        assert_eq!(fs::read(&skill).unwrap(), b"user-owned content");
        assert!(!skill.parent().unwrap().join(RECEIPT).exists());
    }

    #[test]
    fn preserves_user_modifications_and_additional_files() {
        let home = home();
        let root = home.path().canonicalize().unwrap();
        assert!(sync(&root, true).unwrap());
        fs::write(path(&root), b"custom edits").unwrap();
        assert!(!sync(&root, true).unwrap());
        assert!(!sync(&root, false).unwrap());
        assert_eq!(fs::read(path(&root)).unwrap(), b"custom edits");
        // Restore the known managed bytes, leaving an extra user file in place.
        fs::write(path(&root), SKILL.as_bytes()).unwrap();
        let extra = path(&root).parent().unwrap().join("notes.txt");
        fs::write(&extra, b"keep me").unwrap();
        assert!(sync(&root, false).unwrap());
        assert_eq!(fs::read(extra).unwrap(), b"keep me");
    }

    #[test]
    fn updates_an_unchanged_previous_managed_version() {
        let home = home();
        let root = home.path().canonicalize().unwrap();
        assert!(sync(&root, true).unwrap());
        let old = b"old bundled Gaoge workflow";
        fs::write(path(&root), old).unwrap();
        fs::write(
            path(&root).parent().unwrap().join(RECEIPT),
            format!("{RECEIPT_HEADER}{}\n", digest(old)),
        )
        .unwrap();
        assert!(sync(&root, true).unwrap());
        assert_eq!(fs::read(path(&root)).unwrap(), SKILL.as_bytes());
        assert!(!sync(&root, true).unwrap());
        assert!(sync(&root, false).unwrap());
    }

    #[test]
    fn integrated_target_reports_install_and_current_without_rewriting() {
        let home = home();
        let root = home.path().canonicalize().unwrap();
        let installed = sync_existing_integration(&root);
        assert_eq!(installed["status"], "changed");
        assert_eq!(installed["changed"], true);
        assert_eq!(installed["preservedCustom"], false);
        assert_eq!(
            installed["skillPath"],
            path(&root).to_string_lossy().as_ref()
        );
        let first_modified = fs::metadata(path(&root)).unwrap().modified().unwrap();
        let current = sync_existing_integration(&root);
        assert_eq!(current["status"], "current");
        assert_eq!(current["changed"], false);
        assert_eq!(
            fs::metadata(path(&root)).unwrap().modified().unwrap(),
            first_modified,
        );
    }

    #[test]
    fn integrated_old_managed_workflow_upgrades_once_and_preserves_extra_files() {
        let home = home();
        let root = home.path().canonicalize().unwrap();
        assert!(sync(&root, true).unwrap());
        let skill = path(&root);
        let old = b"previous managed workflow: default 2.5F";
        fs::write(&skill, old).unwrap();
        let receipt_path = skill.parent().unwrap().join(RECEIPT);
        fs::write(&receipt_path, format!("{RECEIPT_HEADER}{}\n", digest(old))).unwrap();
        let custom_notes = skill.parent().unwrap().join("notes.txt");
        fs::write(&custom_notes, b"user notes").unwrap();

        let report = sync_existing_integration(&root);
        assert_eq!(report["status"], "changed");
        assert_eq!(fs::read(&skill).unwrap(), SKILL.as_bytes());
        assert!(owns(SKILL.as_bytes(), &fs::read(&receipt_path).unwrap()));
        assert_eq!(fs::read(custom_notes).unwrap(), b"user notes");
        assert_eq!(sync_existing_integration(&root)["status"], "current");
    }

    #[test]
    fn integrated_user_edits_and_unreceipted_skills_report_preserved_custom() {
        let home = home();
        let root = home.path().canonicalize().unwrap();
        assert!(sync(&root, true).unwrap());
        let skill = path(&root);
        let receipt_path = skill.parent().unwrap().join(RECEIPT);
        let original_receipt = fs::read(&receipt_path).unwrap();
        fs::write(&skill, b"user's explicitly pinned 2.5 workflow").unwrap();
        let report = sync_existing_integration(&root);
        assert_eq!(report["status"], "preserved_custom");
        assert_eq!(report["changed"], false);
        assert_eq!(report["preservedCustom"], true);
        assert_eq!(fs::read(&receipt_path).unwrap(), original_receipt);
        assert_eq!(
            fs::read(&skill).unwrap(),
            b"user's explicitly pinned 2.5 workflow"
        );

        // Matching the bundled text is not proof that we own an existing skill.
        fs::write(&skill, SKILL.as_bytes()).unwrap();
        fs::remove_file(&receipt_path).unwrap();
        assert_eq!(
            sync_existing_integration(&root)["status"],
            "preserved_custom",
        );
        assert!(!receipt_path.exists());
    }

    #[test]
    fn integrated_target_reports_filesystem_errors_without_claiming_success() {
        let home = home();
        let root = home.path().canonicalize().unwrap();
        fs::write(root.join("skills"), b"a user file").unwrap();
        let report = sync_existing_integration(&root);
        assert_eq!(report["status"], "error");
        assert_eq!(report["changed"], false);
        // OS error text is localized on Windows; the status and preservation
        // behavior are the stable contract.
        assert!(!report["message"].as_str().unwrap().trim().is_empty());
        assert_eq!(fs::read(root.join("skills")).unwrap(), b"a user file");
        assert!(!path(&root).exists());
    }

    #[test]
    fn rejects_parent_traversal_and_non_directory_ancestors() {
        let home = home();
        let root = home.path().canonicalize().unwrap();
        assert!(sync(Path::new("relative-home"), true).is_err());
        assert!(sync(&root.join("nested/../escape"), true).is_err());
        fs::write(root.join("skills"), b"not a directory").unwrap();
        assert!(sync(&root, true).is_err());
        assert_eq!(fs::read(root.join("skills")).unwrap(), b"not a directory");
    }

    #[test]
    fn atomic_write_never_overwrites_new_or_concurrently_changed_files() {
        let home = home();
        let root = home.path().canonicalize().unwrap();
        let file = root.join("SKILL.md");
        fs::write(&file, b"new user version").unwrap();
        assert!(atomic_write(&file, b"replacement", None).is_err());
        assert!(atomic_write(&file, b"replacement", Some(b"old version")).is_err());
        assert_eq!(fs::read(&file).unwrap(), b"new user version");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
    }

    #[test]
    fn missing_disabled_home_is_not_created() {
        let home = home();
        let root = home.path().canonicalize().unwrap().join("absent");
        assert!(!sync(&root, false).unwrap());
        assert!(!root.exists());
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn refuses_symlinked_skill_parent_and_file() {
        let home = home();
        let target = tempfile::tempdir().unwrap();
        let root = home.path().canonicalize().unwrap();
        let outside = target.path().canonicalize().unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, root.join("skills")).unwrap();
        #[cfg(windows)]
        if let Err(error) = std::os::windows::fs::symlink_dir(&outside, root.join("skills")) {
            if error.raw_os_error() == Some(1314) {
                return;
            }
            panic!("create test directory symlink: {error}");
        }
        assert!(sync(&root, true).is_err());
        assert!(sync(&root, false).is_err());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        #[cfg(unix)]
        fs::remove_file(root.join("skills")).unwrap();
        #[cfg(windows)]
        fs::remove_dir(root.join("skills")).unwrap();
        assert!(sync(&root, true).unwrap());
        fs::remove_file(path(&root)).unwrap();
        let outside_file = outside.join("user.md");
        fs::write(&outside_file, b"outside user content").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside_file, path(&root)).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&outside_file, path(&root)).unwrap();
        assert!(sync(&root, true).is_err());
        assert!(sync(&root, false).is_err());
        assert_eq!(fs::read(outside_file).unwrap(), b"outside user content");
    }
}
