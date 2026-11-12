//! Native paginated rollouts are a graph of immutable prefixes, not fragments
//! which may be flattened by thread ID. Keep their byte/ordinal coordinates.
use super::*;

pub(super) fn owns_native_history(meta: &Value) -> bool {
    let payload = meta.get("payload").unwrap_or(meta);
    // New native headers carry a session identity as well as ordinal
    // coordinates. Legacy aggregate fragments also used ordinals alone,
    // so that field by itself cannot identify paginated history.
    if meta.get("ordinal").is_some_and(Value::is_u64)
        && payload
            .get("session_id")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty())
    {
        return true;
    }
    [
        "history_mode",
        "history_base",
        "forked_from_ordinal_exclusive",
    ]
    .iter()
    .any(|key| payload.get(*key).is_some_and(|value| !value.is_null()))
}

pub(super) fn protects(file: &Path) -> Result<bool, String> {
    read_rollout_session_meta(file).map(|meta| owns_native_history(&meta))
}

/// The thread whose bytes a branch continues from, when the header records a
/// `history_base`.  This is what makes a file a *referenced source*: some other
/// rollout stores byte and ordinal coordinates into it, so its contents must not
/// change length afterwards.  A source file usually carries no pagination marker
/// of its own, so `protects` alone cannot recognise it.
pub(super) fn history_base_thread_id(meta: &Value) -> Option<&str> {
    let payload = meta.get("payload").unwrap_or(meta);
    payload
        .get("history_base")
        .filter(|base| !base.is_null())
        .and_then(|base| base.get("thread_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
}

/// Columns of a `history_base` cut the branch depends on.  Kept separately so a
/// released build can report the coordinates it is protecting.
pub(super) fn history_base_end_byte_offset(meta: &Value) -> Option<u64> {
    let payload = meta.get("payload").unwrap_or(meta);
    payload
        .get("history_base")
        .filter(|base| !base.is_null())
        .and_then(|base| base.get("end_byte_offset"))
        .and_then(Value::as_u64)
}

#[derive(Default)]
pub(super) struct NativeHistorySelector {
    databases: Option<Vec<Connection>>,
}

impl NativeHistorySelector {
    pub(super) fn select_native_head(
        &mut self,
        segments: &[&RolloutSummary],
    ) -> Result<Option<RolloutSummary>, String> {
        let mut native = Vec::new();
        for segment in segments {
            if protects(&segment.path)? {
                native.push(*segment);
            }
        }
        if native.is_empty() {
            return Ok(None);
        }
        // The stored head is authoritative after editing/rollback. A newer file
        // on another branch must not silently replace it just because it is longer.
        let databases = self.databases.get_or_insert_with(|| {
            codex_state_sqlite_paths()
                .into_iter()
                .filter(|p| p.exists())
                .filter_map(|database| {
                    Connection::open_with_flags(
                        database,
                        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
                    )
                    .ok()
                })
                .collect()
        });
        for conn in databases {
            let head: Result<String, _> = conn.query_row(
                "SELECT rollout_path FROM threads WHERE id = ?1",
                params![native[0].id],
                |row| row.get(0),
            );
            if let Ok(head) = head {
                if let Some(segment) = native
                    .iter()
                    .find(|s| codex_path_identity(&s.path) == codex_path_identity(Path::new(&head)))
                {
                    return Ok(Some((*segment).clone()));
                }
            }
        }
        // No indexed head: retain a raw native file without changing any bytes.
        // Do not manufacture a merged history or rewrite lineage checkpoints.
        let raw: Vec<_> = native
            .iter()
            .copied()
            .filter(|s| !is_managed_canonical_rollout_path(&s.path))
            .collect();
        let candidates = if raw.is_empty() { &native } else { &raw };
        let selected = candidates
            .iter()
            .copied()
            .reduce(|current, candidate| {
                if rollout_is_better_canonical(candidate, current) {
                    candidate
                } else {
                    current
                }
            })
            .ok_or_else(|| "No native rollout is available for this thread.".to_string())?;
        Ok(Some(selected.clone()))
    }
}
