//! Read-back verification only; never activates saved accounts or edits credentials.
use super::*;

// The general loaders intentionally tolerate corruption (and may back it up).
// Verification must distinguish malformed data from logout without any writes.
fn read_object(path: &Path) -> Result<Option<Value>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("账号核验文件不可读。".to_string()),
    };
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(value @ Value::Object(_)) => Ok(Some(value)),
        _ => Err("账号核验文件格式损坏。".to_string()),
    }
}

fn read_verification_registry() -> Result<Value, String> {
    let registry = read_object(&codex_registry_path())?
        .unwrap_or_else(|| json!({"items": [], "activeAccountKey": ""}));
    if registry
        .get("activeAccountKey")
        .is_some_and(|key| !key.is_string())
        || registry.get("items").is_some_and(|items| !items.is_array())
    {
        return Err("账号核验索引格式损坏。".to_string());
    }
    Ok(registry)
}

fn expected_key(cleanup: &Value) -> Option<&str> {
    cleanup
        .get("expectedAccountKey")
        .and_then(Value::as_str)
        .filter(|key| !key.trim().is_empty())
        .or_else(|| {
            cleanup
                .get("restoredAccountKey")
                .and_then(Value::as_str)
                .filter(|key| !key.trim().is_empty())
        })
}

fn missing_baseline(cleanup: &Value) -> bool {
    let reason = json_str(cleanup, "reason");
    reason.contains("missing_official_auth") || reason.contains("invalid_official_auth")
}

fn signed_out(cleanup: &Value) -> bool {
    matches!(
        json_str(cleanup, "reason").as_str(),
        "restored_pre_login_signed_out" | "native_signed_out_after_corrupt_restore"
    ) || (json_bool(cleanup, "removed")
        && !json_bool(cleanup, "restored")
        && !missing_baseline(cleanup))
}

fn identity_failure(
    auth: Option<&Value>,
    registry: &Value,
    expected: &str,
) -> Option<&'static str> {
    let Some(auth) = auth else {
        return Some("auth-missing");
    };
    if !codex_auth_is_real_account_snapshot(auth) {
        return Some("not-official-account");
    }
    if !codex_auth_matches_restore_account(auth, registry, expected) {
        return Some("account-mismatch");
    }
    if registry.get("activeAccountKey").and_then(Value::as_str) != Some(expected) {
        return Some("active-account-mismatch");
    }
    None
}

/// Runs inside the existing stopped-client transaction, before deleting its artifacts.
pub(super) fn validate_written_identity(cleanup: &Value) -> Result<(), String> {
    if json_str(cleanup, "reason") == "missing_auth" && expected_key(cleanup).is_none() {
        return if read_object(&codex_auth_path())?.is_none() {
            Ok(())
        } else {
            Err("关闭后当前认证发生变化，已中止清理恢复记录。".to_string())
        };
    }
    if json_bool(cleanup, "restored") {
        if let Some(expected) = expected_key(cleanup) {
            let auth = read_object(&codex_auth_path())?;
            let registry = read_verification_registry()?;
            if identity_failure(auth.as_ref(), &registry, expected).is_some() {
                return Err(
                    "恢复后的官方账号凭据与目标账号不一致，已中止清理恢复记录。".to_string()
                );
            }
        }
    } else if signed_out(cleanup) {
        let auth = read_object(&codex_auth_path())?;
        let registry = read_verification_registry()?;
        if auth.is_some() || !json_str(&registry, "activeAccountKey").is_empty() {
            return Err("未登录状态写后核验失败，已中止清理恢复记录。".to_string());
        }
    }
    Ok(())
}

fn report(cleanup: &Value, launch: &Value, status: &str, reason: &str) -> Value {
    json!({
        "status": status,
        "expectedAccountKey": expected_key(cleanup),
        "reason": reason,
        "checkedAfterLaunch": json_bool(launch, "launchConfirmed") && !codex_launch_is_queued(launch),
        "scope": "local-auth-file",
        "nativeSessionVerified": false,
        "codexDir": codex_dir().to_string_lossy(),
    })
}

pub(super) fn verify_current(cleanup: &Value, launch: &Value) -> Value {
    // A failed historical restore may carry the OTHER account's preserved key.
    if missing_baseline(cleanup) {
        return report(cleanup, launch, "failed", "original-account-unavailable");
    }
    let auth = match read_object(&codex_auth_path()) {
        Ok(auth) => auth,
        Err(_) => return report(cleanup, launch, "failed", "auth-read-failed"),
    };
    let registry = match read_verification_registry() {
        Ok(registry) => registry,
        Err(_) => return report(cleanup, launch, "failed", "registry-read-failed"),
    };
    // A stale registry selection is not a live login. Legacy missing-auth
    // cleanup did not promise to erase that marker and must remain closable.
    if json_str(cleanup, "reason") == "missing_auth" && expected_key(cleanup).is_none() {
        return if auth.is_none() {
            report(cleanup, launch, "not-required", "auth-missing")
        } else {
            report(cleanup, launch, "failed", "auth-changed-after-close")
        };
    }
    if signed_out(cleanup) {
        return if auth.is_none() && json_str(&registry, "activeAccountKey").is_empty() {
            report(cleanup, launch, "not-required", "originally-signed-out")
        } else {
            report(cleanup, launch, "failed", "signed-out-state-mismatch")
        };
    }
    let Some(expected) = expected_key(cleanup) else {
        return report(
            cleanup,
            launch,
            "not-required",
            "no-official-restore-target",
        );
    };
    if !json_bool(cleanup, "restored") {
        return report(cleanup, launch, "failed", "original-account-not-restored");
    }
    if let Some(reason) = identity_failure(auth.as_ref(), &registry, expected) {
        return report(cleanup, launch, "failed", reason);
    }
    if auth
        .as_ref()
        .is_some_and(codex_official_auth_is_unrecoverable)
    {
        return report(cleanup, launch, "failed", "official-auth-unrecoverable");
    }
    if codex_launch_is_queued(launch) {
        return report(cleanup, launch, "pending", "launch-queued");
    }
    if !json_bool(launch, "launchConfirmed") {
        return report(cleanup, launch, "pending", "launch-not-confirmed");
    }
    // Confirms local persisted identity only, not OAuth server acceptance or
    // the native client's credential-store/account RPC state.
    report(cleanup, launch, "verified", "local-official-auth-matched")
}

pub(super) fn verify_targets(targets: &mut [Value], launch: &Value) -> Value {
    for target in targets.iter_mut() {
        let path = json_str(target, "codexDir");
        let cleanup = json_field(target, "authCleanup");
        let verification = if path.is_empty() {
            report(&cleanup, launch, "failed", "target-directory-missing")
        } else {
            with_codex_dir(Path::new(&path), || verify_current(&cleanup, launch))
        };
        target["authVerification"] = verification;
    }
    let mut result = targets
        .first()
        .map(|target| json_field(target, "authVerification"))
        .unwrap_or_else(|| report(&json!({}), launch, "failed", "target-directory-missing"));
    // Default-home agreement must not hide a different installation's failure.
    if targets
        .iter()
        .skip(1)
        .any(|target| target["authVerification"]["status"] == "failed")
    {
        result["status"] = json!("failed");
        result["reason"] = json!("secondary-target-verification-failed");
    } else if result["status"] != "failed"
        && targets
            .iter()
            .skip(1)
            .any(|target| target["authVerification"]["status"] == "pending")
    {
        result["status"] = json!("pending");
        result["reason"] = json!("secondary-target-verification-pending");
    }
    result
}
