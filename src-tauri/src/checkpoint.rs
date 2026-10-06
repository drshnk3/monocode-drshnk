#[cfg(test)]
use std::collections::HashMap;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

#[cfg(test)]
use crate::fs::GitDiffStats;
use crate::fs::{
    expand_home, git_checked, git_diff_files_for, path_to_js, resolve_repo_path, GitChangedFile,
    GitDiffIndex, MAX_TEXT_FILE_BYTES,
};

const MAX_SNAPSHOT_FILES: usize = 500;
const MAX_PATCH_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone)]
pub struct CheckpointStore {
    root: PathBuf,
    gate: Arc<Mutex<()>>,
}

impl CheckpointStore {
    fn new(root: PathBuf) -> Self {
        Self {
            root,
            gate: Arc::new(Mutex::new(())),
        }
    }

    fn exclusive<T>(
        &self,
        operation: impl FnOnce(&Self) -> Result<T, String>,
    ) -> Result<T, String> {
        let _guard = self
            .gate
            .lock()
            .map_err(|_| "Checkpoint store lock poisoned".to_string())?;
        operation(self)
    }

    fn session_dir(&self, session_id: &str) -> PathBuf {
        self.root.join(session_id)
    }

    fn ensure(&self, session_id: &str, cwd: &str) -> Result<(), String> {
        let root = project_root(cwd)?;
        let dir = self.session_dir(session_id);
        if let Some(manifest) = read_manifest(&dir)? {
            if same_cwd(&manifest.cwd, cwd) {
                return Ok(());
            }
            let _ = std::fs::remove_dir_all(&dir);
        }
        std::fs::create_dir_all(dir.join("files")).map_err(|e| e.to_string())?;

        let mut files = BTreeMap::new();
        let mut tracked = BTreeSet::new();
        for file in git_diff_files_for(&root).files {
            if files.len() >= MAX_SNAPSHOT_FILES {
                break;
            }
            let Ok(relative) = resolve_repo_path(&root, &file.relative) else {
                continue;
            };
            if in_head(&root, &relative) {
                tracked.insert(relative.clone());
            }
            files.insert(relative.clone(), snapshot_file(&dir, &root, &relative)?);
        }
        write_manifest(
            &dir,
            &Manifest {
                cwd: root.to_string_lossy().into_owned(),
                files,
                touched: BTreeSet::new(),
                tracked,
                prepared: BTreeSet::new(),
                after: BTreeMap::new(),
                stats: BTreeMap::new(),
                diverged: BTreeSet::new(),
                head: git_head(&root)
                    .ok()
                    .map(|head| String::from_utf8_lossy(&head).trim().to_string()),
                integrated: BTreeMap::new(),
            },
        )
    }

    fn prepare(&self, session_id: &str, cwd: &str, paths: &[String]) -> Result<(), String> {
        if paths.is_empty() {
            return Ok(());
        }
        let root = project_root(cwd)?;
        let dir = self.session_dir(session_id);
        let mut manifest = match read_manifest(&dir)? {
            Some(manifest) if same_cwd(&manifest.cwd, cwd) => manifest,
            _ => return Ok(()),
        };

        let mut dirty = false;
        for path in paths {
            let Ok(relative) = relative_to_root(&root, path) else {
                continue;
            };
            // Keep the original pre-edit snapshot across later edits by this
            // session. The first tool-start event owns the safe undo boundary.
            if manifest.touched.contains(&relative) && manifest.prepared.contains(&relative) {
                if !after_matches_worktree(&dir, &root, &manifest, &relative)
                    && manifest.diverged.insert(relative)
                {
                    dirty = true;
                }
                continue;
            }
            if manifest.prepared.contains(&relative) {
                continue;
            }
            if manifest.touched.contains(&relative) {
                // Upgrade a legacy or completion-only claim by dropping its
                // untrusted state and starting at this real tool boundary.
                release_path(&mut manifest, &relative);
                dirty = true;
            }
            let before = snapshot_file(&dir, &root, &relative)?;
            if manifest.files.insert(relative.clone(), before) != Some(before) {
                dirty = true;
            }
            if manifest.prepared.insert(relative.clone()) {
                dirty = true;
            }
            if in_head(&root, &relative) && manifest.tracked.insert(relative) {
                dirty = true;
            }
        }
        if dirty {
            write_manifest(&dir, &manifest)?;
        }
        Ok(())
    }

    fn capture(&self, session_id: &str, cwd: &str, paths: &[String]) -> Result<(), String> {
        if paths.is_empty() {
            return Ok(());
        }
        let root = project_root(cwd)?;
        let dir = self.session_dir(session_id);
        let mut manifest = match read_manifest(&dir)? {
            Some(manifest) if same_cwd(&manifest.cwd, cwd) => manifest,
            _ => return Ok(()),
        };

        let mut dirty = false;
        for path in paths {
            if manifest.touched.len() >= MAX_SNAPSHOT_FILES {
                break;
            }
            let Ok(relative) = relative_to_root(&root, path) else {
                continue;
            };
            manifest.touched.insert(relative.clone());
            let tracked_in_head = in_head(&root, &relative);
            if tracked_in_head {
                manifest.tracked.insert(relative.clone());
            }
            if !manifest.files.contains_key(&relative)
                && !root.join(&relative).exists()
                && !tracked_in_head
            {
                // A completion without a matching prepare event is retained
                // for review but is deliberately not undoable.
                manifest
                    .files
                    .insert(relative.clone(), snapshot_file(&dir, &root, &relative)?);
            }
            let after = snapshot_after_file(&dir, &root, &relative)?;
            manifest.after.insert(relative.clone(), after);
            if let Some(stats) = calculate_session_stats(&dir, &manifest, &relative) {
                manifest.stats.insert(relative, stats);
            }
            dirty = true;
        }
        if dirty {
            write_manifest(&dir, &manifest)?;
        }
        Ok(())
    }

    fn status(&self, session_id: &str, cwd: &str) -> Result<CheckpointStatus, String> {
        let Some(manifest) = self.load_matching(session_id, cwd)? else {
            return Ok(CheckpointStatus { files: Vec::new() });
        };
        let root = project_root(cwd)?;
        let foreign_touched = self.foreign_touched_paths(cwd, session_id);
        Ok(diff_from_manifest(
            &self.session_dir(session_id),
            &root,
            &manifest,
            &foreign_touched,
        ))
    }

    fn apply(
        &self,
        session_id: &str,
        from_cwd: &str,
        to_cwd: &str,
    ) -> Result<CheckpointApplyResult, String> {
        let mut manifest = self
            .load_matching(session_id, from_cwd)?
            .ok_or("This worker has no recoverable change checkpoint")?;
        let from_root = project_root(from_cwd)?;
        let to_root = project_root(to_cwd)?;
        if same_cwd(from_cwd, to_cwd) {
            return Err("An isolated worker cannot be integrated into itself".into());
        }
        let from_head = git_head(&from_root)?;
        let moved = match manifest.head.as_deref() {
            // Files are merged against the worker's own baseline, so only a
            // worker commit (which hides changes from capture) is unsafe.
            Some(head) => String::from_utf8_lossy(&from_head).trim() != head,
            None => from_head != git_head(&to_root)?,
        };
        if moved {
            return Err(
                "The worker or lead branch moved while this task was running. The worker worktree was kept for manual review."
                    .into(),
            );
        }
        let dir = self.session_dir(session_id);
        let changed = verified_worker_delta(&dir, &from_root, &manifest)?;

        // Preflight every path before writing any of them. A retry may see a
        // mixture of before/after/merged states if the app stopped during a
        // previous application; all are safe and make this idempotent.
        let mut already_applied = 0;
        let mut writes = Vec::new();
        let mut merged = Vec::new();
        let mut conflicts = Vec::new();
        for relative in &changed {
            if path_contains_symlink(&to_root, relative) {
                return Err(format!(
                    "Cannot integrate {relative}: the target path contains a symbolic link. The worker worktree was kept."
                ));
            }
            let before = manifest
                .files
                .get(relative)
                .copied()
                .ok_or_else(|| format!("Missing original snapshot for {relative}"))?;
            let after = manifest
                .after
                .get(relative)
                .copied()
                .ok_or_else(|| format!("Missing worker snapshot for {relative}"))?;
            let target = worktree_snapshot(&to_root, relative);
            let before_state = stored_snapshot(&dir, relative, before, false);
            let after_state = stored_snapshot(&dir, relative, after, true);
            if target == after_state || integrated_matches(&manifest, relative, &target) {
                already_applied += 1;
            } else if target == before_state {
                writes.push((relative.clone(), after_state));
            } else if let Some(result) = merge_text(&dir, &target, &before_state, &after_state)? {
                if let Some(record) = IntegratedFile::of(&result) {
                    manifest.integrated.insert(relative.clone(), record);
                }
                merged.push(relative.clone());
                writes.push((relative.clone(), result));
            } else {
                conflicts.push(relative.clone());
            }
        }
        if !conflicts.is_empty() {
            return Err(format!(
                "Cannot integrate {}: the lead checkout changed since this worker started and the edits could not be merged. The worker worktree was kept.",
                conflicts.join(", ")
            ));
        }
        if !merged.is_empty() {
            write_manifest(&dir, &manifest)?;
        }
        for (relative, (state, mode)) in writes {
            write_state(&to_root, &relative, state, mode)?;
        }
        Ok(CheckpointApplyResult {
            files: changed,
            already_applied,
            merged,
        })
    }

    fn cleanup_safe(&self, session_id: &str, cwd: &str) -> Result<bool, String> {
        let Some(manifest) = self.load_matching(session_id, cwd)? else {
            return Ok(false);
        };
        let root = project_root(cwd)?;
        Ok(
            verified_worker_delta(&self.session_dir(session_id), &root, &manifest)
                .map(|changed| changed.is_empty())
                .unwrap_or(false),
        )
    }

    fn forget(&self, session_id: &str) -> Result<(), String> {
        let dir = self.session_dir(session_id);
        if dir.exists() {
            std::fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn file_diff(
        &self,
        session_id: &str,
        cwd: &str,
        relative: &str,
    ) -> Result<CheckpointFileDiff, String> {
        let Some(manifest) = self.load_matching(session_id, cwd)? else {
            return Err("Session changes are no longer available".into());
        };
        let root = project_root(cwd)?;
        let relative = resolve_repo_path(&root, relative)?;
        if !manifest.touched.contains(&relative) || !manifest.prepared.contains(&relative) {
            return Err("This file was not changed by the session".into());
        }
        if manifest.diverged.contains(&relative) {
            return Err(
                "Exact lines are unavailable because the file changed between this session's edits"
                    .into(),
            );
        }

        let dir = self.session_dir(session_id);
        let before = manifest
            .files
            .get(&relative)
            .copied()
            .ok_or_else(|| "Session baseline is unavailable".to_string())?;
        let after = manifest
            .after
            .get(&relative)
            .copied()
            .ok_or_else(|| "Session result is unavailable".to_string())?;
        let original = read_snapshot(&dir, &relative, before);
        let current = read_after_snapshot(&dir, &relative, after);
        let too_large =
            matches!(original, FileState::Skipped) || matches!(current, FileState::Skipped);
        let binary = state_is_binary(&original) || state_is_binary(&current);
        let (original, current) = if binary || too_large {
            (String::new(), String::new())
        } else {
            (state_text(original), state_text(current))
        };
        let status = manifest
            .stats
            .get(&relative)
            .map(|stats| stats.status.clone())
            .unwrap_or_else(|| "modified".into());
        Ok(CheckpointFileDiff {
            path: path_to_js(&root.join(&relative)),
            relative,
            status,
            original,
            current,
            binary,
            too_large,
        })
    }

    /// The session's changes as one git-style unified diff, from the same
    /// before/after snapshots that review and integration use.
    fn patch(
        &self,
        session_id: &str,
        cwd: &str,
        max_bytes: usize,
    ) -> Result<CheckpointPatch, String> {
        let status = self.status(session_id, cwd)?;
        let mut out = CheckpointPatch {
            files: Vec::new(),
            patch: String::new(),
            truncated: false,
        };
        let Some(manifest) = self.load_matching(session_id, cwd)? else {
            return Ok(out);
        };
        let dir = self.session_dir(session_id);
        let max_bytes = max_bytes.min(MAX_PATCH_BYTES);
        for file in status.files {
            let relative = file.relative;
            let before = manifest
                .files
                .get(&relative)
                .map(|kind| stored_snapshot(&dir, &relative, *kind, false));
            let after = manifest
                .after
                .get(&relative)
                .map(|kind| stored_snapshot(&dir, &relative, *kind, true));
            let binary = [&before, &after]
                .into_iter()
                .flatten()
                .any(|(state, _)| state_is_binary(state));
            if !out.truncated {
                if max_bytes == 0 {
                    out.truncated = true;
                } else {
                    let chunk = match (before, after) {
                        (Some(before), Some(after)) => file_patch(
                            &dir,
                            &relative,
                            before,
                            after,
                            binary,
                            !file.exact,
                        )?,
                        _ => format!(
                            "diff --git a/{relative} b/{relative}\nSession snapshots are unavailable\n"
                        ),
                    };
                    out.truncated = !append_capped(&mut out.patch, &chunk, max_bytes);
                }
            }
            out.files.push(CheckpointPatchFile {
                relative,
                status: file.status,
                additions: file.additions,
                deletions: file.deletions,
                binary,
            });
        }
        Ok(out)
    }

    /// Remaining git line counts for each session, using one working-tree index.
    #[cfg(test)]
    fn stats_for_sessions(
        &self,
        cwd: &str,
        session_ids: &[String],
    ) -> Result<HashMap<String, GitDiffStats>, String> {
        let mut out = HashMap::new();
        if session_ids.is_empty() {
            return Ok(out);
        }
        let root = project_root(cwd)?;
        let index = git_diff_files_for(&root);
        for session_id in session_ids {
            let Some(manifest) = self.load_matching(session_id, cwd)? else {
                out.insert(session_id.clone(), GitDiffStats::default());
                continue;
            };
            let foreign_touched = self.foreign_touched_paths(cwd, session_id);
            let status = diff_from_manifest_with(
                &index,
                &self.session_dir(session_id),
                &root,
                &manifest,
                &foreign_touched,
            );
            out.insert(session_id.clone(), stats_from_status(&status));
        }
        Ok(out)
    }

    fn undo(
        &self,
        session_id: &str,
        cwd: &str,
        relative: Option<&str>,
    ) -> Result<CheckpointStatus, String> {
        let Some(mut manifest) = self.load_matching(session_id, cwd)? else {
            return Ok(CheckpointStatus { files: Vec::new() });
        };
        let root = project_root(cwd)?;
        let dir = self.session_dir(session_id);
        let foreign_touched = self.foreign_touched_paths(cwd, session_id);
        let changed = diff_from_manifest(&dir, &root, &manifest, &foreign_touched);
        if let Some(relative) = relative {
            let relative = resolve_repo_path(&root, relative)?;
            let Some(file) = changed.files.iter().find(|file| file.relative == relative) else {
                return self.status(session_id, cwd);
            };
            if !file.undoable {
                return Err(format!(
                    "Cannot safely undo {relative}: it changed outside this session"
                ));
            }
            restore_one(&dir, &root, &manifest, &relative)?;
            release_path(&mut manifest, &relative);
            write_manifest(&dir, &manifest)?;
            return self.status(session_id, cwd);
        }
        if changed.files.iter().any(|file| !file.undoable) {
            return Err(
                "Cannot safely undo all: one or more files changed outside this session".into(),
            );
        }
        for file in &changed.files {
            restore_one(&dir, &root, &manifest, &file.relative)?;
        }
        let _ = std::fs::remove_dir_all(&dir);
        Ok(CheckpointStatus { files: Vec::new() })
    }

    fn keep(
        &self,
        session_id: &str,
        cwd: &str,
        relative: Option<&str>,
    ) -> Result<CheckpointStatus, String> {
        let Some(mut manifest) = self.load_matching(session_id, cwd)? else {
            return Ok(CheckpointStatus { files: Vec::new() });
        };
        let root = project_root(cwd)?;
        let dir = self.session_dir(session_id);
        let Some(relative) = relative else {
            let _ = std::fs::remove_dir_all(&dir);
            return Ok(CheckpointStatus { files: Vec::new() });
        };
        let relative = resolve_repo_path(&root, relative)?;
        release_path(&mut manifest, &relative);
        write_manifest(&dir, &manifest)?;
        self.status(session_id, cwd)
    }

    fn load_matching(&self, session_id: &str, cwd: &str) -> Result<Option<Manifest>, String> {
        let dir = self.session_dir(session_id);
        let Some(manifest) = read_manifest(&dir)? else {
            return Ok(None);
        };
        if !same_cwd(&manifest.cwd, cwd) {
            return Ok(None);
        }
        Ok(Some(manifest))
    }

    /// Paths already claimed by another live session in the same project.
    fn foreign_touched_paths(&self, cwd: &str, except_session_id: &str) -> HashSet<String> {
        let mut paths = HashSet::new();
        let entries = match std::fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(_) => return paths,
        };
        for entry in entries.flatten() {
            let session_id = entry.file_name().to_string_lossy().into_owned();
            if session_id == except_session_id {
                continue;
            }
            let dir = entry.path();
            let Ok(Some(manifest)) = read_manifest(&dir) else {
                continue;
            };
            if !same_cwd(&manifest.cwd, cwd) {
                continue;
            }
            paths.extend(manifest.touched.intersection(&manifest.prepared).cloned());
        }
        paths
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    cwd: String,
    files: BTreeMap<String, SnapshotKind>,
    #[serde(default)]
    touched: BTreeSet<String>,
    #[serde(default)]
    tracked: BTreeSet<String>,
    /// Paths captured before a structured edit started. Only these are safe
    /// candidates for Undo.
    #[serde(default)]
    prepared: BTreeSet<String>,
    /// Worktree contents immediately after the session's latest edit.
    #[serde(default)]
    after: BTreeMap<String, SnapshotKind>,
    /// Stable line counts for the session-owned before/after pair.
    #[serde(default)]
    stats: BTreeMap<String, ChangeStats>,
    /// Paths whose contents changed between two edits by this session.
    #[serde(default)]
    diverged: BTreeSet<String>,
    /// Checkout HEAD when the checkpoint started. Absent in older manifests.
    #[serde(default)]
    head: Option<String>,
    /// Lead results of three-way merges, written before the files so a
    /// retried integration recognizes them instead of merging twice.
    #[serde(default)]
    integrated: BTreeMap<String, IntegratedFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct IntegratedFile {
    sha256: String,
    mode: Option<u32>,
}

impl IntegratedFile {
    fn of((state, mode): &FileWithMode) -> Option<Self> {
        use sha2::{Digest, Sha256};
        let FileState::Contents(bytes) = state else {
            return None;
        };
        Some(Self {
            sha256: format!("{:x}", Sha256::digest(bytes)),
            mode: *mode,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ChangeStats {
    status: String,
    additions: i64,
    deletions: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum SnapshotKind {
    Contents,
    Missing,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum FileState {
    Contents(Vec<u8>),
    Missing,
    Skipped,
}

/// A file state with its Unix permission bits, when known.
type FileWithMode = (FileState, Option<u32>);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointFile {
    pub path: String,
    pub relative: String,
    pub status: String,
    pub additions: i64,
    pub deletions: i64,
    /// False when the file changed between this session's own edit snapshots,
    /// so its net line ownership cannot be reconstructed exactly.
    pub exact: bool,
    pub undoable: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointStatus {
    pub files: Vec<CheckpointFile>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointFileDiff {
    pub path: String,
    pub relative: String,
    pub status: String,
    pub original: String,
    pub current: String,
    pub binary: bool,
    pub too_large: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointPatchFile {
    pub relative: String,
    pub status: String,
    pub additions: i64,
    pub deletions: i64,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointPatch {
    pub files: Vec<CheckpointPatchFile>,
    pub patch: String,
    /// The patch stopped at the byte limit; `files` is always complete.
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointApplyResult {
    pub files: Vec<String>,
    pub already_applied: usize,
    /// Files the lead had also changed, combined by a clean three-way merge.
    pub merged: Vec<String>,
}

pub fn init(app: &AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("checkpoints");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.manage(CheckpointStore::new(dir));
    Ok(())
}

#[tauri::command]
pub async fn session_checkpoint_ensure(
    store: State<'_, CheckpointStore>,
    session_id: String,
    cwd: String,
) -> Result<(), String> {
    validate_id(&session_id, "session")?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store.exclusive(|store| store.ensure(&session_id, &cwd))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_checkpoint_prepare(
    store: State<'_, CheckpointStore>,
    session_id: String,
    cwd: String,
    paths: Vec<String>,
) -> Result<(), String> {
    validate_id(&session_id, "session")?;
    if paths.len() > MAX_SNAPSHOT_FILES {
        return Err("Too many paths".into());
    }
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store.exclusive(|store| store.prepare(&session_id, &cwd, &paths))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_checkpoint_capture(
    store: State<'_, CheckpointStore>,
    session_id: String,
    cwd: String,
    paths: Vec<String>,
) -> Result<(), String> {
    validate_id(&session_id, "session")?;
    if paths.len() > MAX_SNAPSHOT_FILES {
        return Err("Too many paths".into());
    }
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store.exclusive(|store| store.capture(&session_id, &cwd, &paths))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_checkpoint_status(
    store: State<'_, CheckpointStore>,
    session_id: String,
    cwd: String,
) -> Result<CheckpointStatus, String> {
    validate_id(&session_id, "session")?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store.exclusive(|store| store.status(&session_id, &cwd))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_checkpoint_apply(
    store: State<'_, CheckpointStore>,
    session_id: String,
    from_cwd: String,
    to_cwd: String,
) -> Result<CheckpointApplyResult, String> {
    validate_id(&session_id, "session")?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store.exclusive(|store| store.apply(&session_id, &from_cwd, &to_cwd))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_checkpoint_cleanup_safe(
    store: State<'_, CheckpointStore>,
    session_id: String,
    cwd: String,
) -> Result<bool, String> {
    validate_id(&session_id, "session")?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store.exclusive(|store| store.cleanup_safe(&session_id, &cwd))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_checkpoint_forget(
    store: State<'_, CheckpointStore>,
    session_id: String,
) -> Result<(), String> {
    validate_id(&session_id, "session")?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.exclusive(|store| store.forget(&session_id)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_checkpoint_file_diff(
    store: State<'_, CheckpointStore>,
    session_id: String,
    cwd: String,
    relative: String,
) -> Result<CheckpointFileDiff, String> {
    validate_id(&session_id, "session")?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store.exclusive(|store| store.file_diff(&session_id, &cwd, &relative))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_checkpoint_patch(
    store: State<'_, CheckpointStore>,
    session_id: String,
    root: String,
    max_bytes: usize,
) -> Result<CheckpointPatch, String> {
    validate_id(&session_id, "session")?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store.exclusive(|store| store.patch(&session_id, &root, max_bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_checkpoint_undo(
    store: State<'_, CheckpointStore>,
    session_id: String,
    cwd: String,
    relative: Option<String>,
) -> Result<CheckpointStatus, String> {
    validate_id(&session_id, "session")?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store.exclusive(|store| store.undo(&session_id, &cwd, relative.as_deref()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_checkpoint_keep(
    store: State<'_, CheckpointStore>,
    session_id: String,
    cwd: String,
    relative: Option<String>,
) -> Result<CheckpointStatus, String> {
    validate_id(&session_id, "session")?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store.exclusive(|store| store.keep(&session_id, &cwd, relative.as_deref()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Reconstruct the worker-owned delta and reject anything that was not
/// captured at a structured tool boundary. This is stricter than the review
/// UI because cleanup must never discard an ambiguous edit.
fn verified_worker_delta(
    dir: &Path,
    root: &Path,
    manifest: &Manifest,
) -> Result<Vec<String>, String> {
    if !manifest.diverged.is_empty() {
        return Err(format!(
            "Cannot safely integrate files that changed outside the worker: {}",
            manifest
                .diverged
                .iter()
                .cloned()
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    let current_dirty: BTreeSet<String> = git_diff_files_for(root)
        .files
        .into_iter()
        .map(|file| file.relative)
        .collect();
    if let Some(relative) = current_dirty
        .iter()
        .find(|relative| !manifest.files.contains_key(*relative))
    {
        return Err(format!(
            "Cannot safely integrate {relative}: its change was not captured for this worker. The worker worktree was kept."
        ));
    }

    let mut changed = Vec::new();
    for (relative, before) in &manifest.files {
        if path_contains_symlink(root, relative) {
            return Err(format!(
                "Cannot safely integrate {relative}: the worker path contains a symbolic link. The worker worktree was kept."
            ));
        }
        if *before == SnapshotKind::Skipped {
            return Err(format!(
                "Cannot safely integrate {relative}: this file type or size cannot be checkpointed. The worker worktree was kept."
            ));
        }
        let before_state = stored_snapshot(dir, relative, *before, false);
        if manifest.touched.contains(relative) {
            if !manifest.prepared.contains(relative) {
                return Err(format!(
                    "Cannot safely integrate {relative}: its pre-edit state was not captured. The worker worktree was kept."
                ));
            }
            let after = manifest
                .after
                .get(relative)
                .copied()
                .ok_or_else(|| format!("Missing worker snapshot for {relative}"))?;
            if after == SnapshotKind::Skipped {
                return Err(format!(
                    "Cannot safely integrate {relative}: this file type or size cannot be checkpointed. The worker worktree was kept."
                ));
            }
            let after_state = stored_snapshot(dir, relative, after, true);
            if worktree_snapshot(root, relative) != after_state {
                return Err(format!(
                    "Cannot safely integrate {relative}: it changed after the worker checkpoint. The worker worktree was kept."
                ));
            }
            if before_state != after_state {
                changed.push(relative.clone());
            }
        } else if worktree_snapshot(root, relative) != before_state {
            return Err(format!(
                "Cannot safely integrate {relative}: its change was not attributed to this worker. The worker worktree was kept."
            ));
        }
    }
    changed.sort();
    Ok(changed)
}

fn integrated_matches(manifest: &Manifest, relative: &str, target: &FileWithMode) -> bool {
    manifest
        .integrated
        .get(relative)
        .is_some_and(|record| IntegratedFile::of(target).as_ref() == Some(record))
}

/// Mode after combining two sides that each may have changed it.
fn merge_mode(lead: Option<u32>, before: Option<u32>, after: Option<u32>) -> Option<Option<u32>> {
    if after == before || after == lead {
        Some(lead)
    } else if lead == before {
        Some(after)
    } else {
        None
    }
}

/// Combine a worker edit with a lead edit to the same text file. Returns None
/// when they conflict, or when either side added, deleted, or holds a binary
/// or unsupported file, so the caller refuses instead of guessing.
fn merge_text(
    dir: &Path,
    lead: &FileWithMode,
    before: &FileWithMode,
    after: &FileWithMode,
) -> Result<Option<FileWithMode>, String> {
    let (
        (FileState::Contents(lead_bytes), lead_mode),
        (FileState::Contents(before_bytes), before_mode),
        (FileState::Contents(after_bytes), after_mode),
    ) = (lead, before, after)
    else {
        return Ok(None);
    };
    if [lead_bytes, before_bytes, after_bytes]
        .iter()
        .any(|bytes| bytes.contains(&0))
    {
        return Ok(None);
    }
    let Some(mode) = merge_mode(*lead_mode, *before_mode, *after_mode) else {
        return Ok(None);
    };
    let scratch = dir.join("merge");
    let _ = std::fs::remove_dir_all(&scratch);
    std::fs::create_dir_all(&scratch).map_err(|e| e.to_string())?;
    let result = (|| {
        let paths = [
            (scratch.join("lead"), lead_bytes),
            (scratch.join("base"), before_bytes),
            (scratch.join("worker"), after_bytes),
        ];
        for (path, bytes) in &paths {
            std::fs::write(path, bytes).map_err(|e| e.to_string())?;
        }
        let mut cmd = Command::new("git");
        crate::hide_window_console(&mut cmd);
        let output = cmd
            .args(["merge-file", "-p", "-q"])
            .args(paths.iter().map(|(path, _)| path))
            .output()
            .map_err(|e| e.to_string())?;
        // The exit code is the number of conflicts; negative means failure.
        match output.status.code() {
            Some(0) => Ok(Some((FileState::Contents(output.stdout), mode))),
            Some(1..=127) => Ok(None),
            _ => Err(format!(
                "Three-way merge failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )),
        }
    })();
    let _ = std::fs::remove_dir_all(&scratch);
    result
}

fn git_file_mode(mode: Option<u32>) -> &'static str {
    match mode {
        Some(mode) if mode & 0o111 != 0 => "100755",
        _ => "100644",
    }
}

/// One file's section of a git-style patch. Hunks come from `git diff
/// --no-index`; the headers are rebuilt with the project-relative path.
fn file_patch(
    dir: &Path,
    relative: &str,
    before: FileWithMode,
    after: FileWithMode,
    binary: bool,
    inexact: bool,
) -> Result<String, String> {
    let mut out = format!("diff --git a/{relative} b/{relative}\n");
    let old_mode = git_file_mode(before.1);
    let new_mode = git_file_mode(after.1);
    match (&before.0, &after.0) {
        (FileState::Missing, _) => out.push_str(&format!("new file mode {new_mode}\n")),
        (_, FileState::Missing) => out.push_str(&format!("deleted file mode {old_mode}\n")),
        _ if old_mode != new_mode => {
            out.push_str(&format!("old mode {old_mode}\nnew mode {new_mode}\n"))
        }
        _ => {}
    }
    if inexact {
        out.push_str(
            "Exact lines unavailable: the file also changed between this session's edits\n",
        );
        return Ok(out);
    }
    if matches!(before.0, FileState::Skipped) || matches!(after.0, FileState::Skipped) {
        out.push_str("File too large to diff\n");
        return Ok(out);
    }
    if binary {
        out.push_str("Binary file changed\n");
        return Ok(out);
    }
    let scratch = dir.join("patch");
    let _ = std::fs::remove_dir_all(&scratch);
    std::fs::create_dir_all(&scratch).map_err(|e| e.to_string())?;
    let result = (|| {
        let contents = |state: &FileState| match state {
            FileState::Contents(bytes) => bytes.clone(),
            FileState::Missing | FileState::Skipped => Vec::new(),
        };
        std::fs::write(scratch.join("a"), contents(&before.0)).map_err(|e| e.to_string())?;
        std::fs::write(scratch.join("b"), contents(&after.0)).map_err(|e| e.to_string())?;
        let mut cmd = Command::new("git");
        crate::hide_window_console(&mut cmd);
        let output = cmd
            .current_dir(&scratch)
            .args([
                "diff",
                "--no-index",
                "--no-ext-diff",
                "--no-color",
                "--text",
                "-U3",
                "--",
                "a",
                "b",
            ])
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() && output.status.code() != Some(1) {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        let text = String::from_utf8_lossy(&output.stdout);
        Ok(text
            .find("\n@@")
            .map(|start| text[start + 1..].to_string())
            .unwrap_or_default())
    })();
    let _ = std::fs::remove_dir_all(&scratch);
    let hunks = result?;
    if !hunks.is_empty() {
        let old = if matches!(before.0, FileState::Missing) {
            "/dev/null".to_string()
        } else {
            format!("a/{relative}")
        };
        let new = if matches!(after.0, FileState::Missing) {
            "/dev/null".to_string()
        } else {
            format!("b/{relative}")
        };
        out.push_str(&format!("--- {old}\n+++ {new}\n{hunks}"));
        if !out.ends_with('\n') {
            out.push('\n');
        }
    }
    Ok(out)
}

/// Append `chunk` if it fits in `max_bytes`, otherwise as many whole lines as
/// fit. Returns false once anything was left out.
fn append_capped(patch: &mut String, chunk: &str, max_bytes: usize) -> bool {
    if patch.len() + chunk.len() <= max_bytes {
        patch.push_str(chunk);
        return true;
    }
    for line in chunk.split_inclusive('\n') {
        if patch.len() + line.len() > max_bytes {
            break;
        }
        patch.push_str(line);
    }
    false
}

fn write_state(
    root: &Path,
    relative: &str,
    state: FileState,
    mode: Option<u32>,
) -> Result<(), String> {
    let relative = resolve_repo_path(root, relative)?;
    if path_contains_symlink(root, &relative) {
        return Err(format!("Cannot write through symbolic link {relative}"));
    }
    match state {
        FileState::Contents(bytes) => {
            let path = root.join(relative);
            write_worktree(&path, &bytes)?;
            set_file_mode(&path, mode)
        }
        FileState::Missing => remove_worktree(root, &relative),
        FileState::Skipped => Err(format!("Cannot write unsupported file {relative}")),
    }
}

fn stored_snapshot(
    dir: &Path,
    relative: &str,
    kind: SnapshotKind,
    after: bool,
) -> (FileState, Option<u32>) {
    let blob_root = if after {
        dir.join("after")
    } else {
        dir.join("files")
    };
    (
        read_snapshot_at(&blob_root, relative, kind),
        snapshot_mode(&blob_root, relative, kind),
    )
}

fn worktree_snapshot(root: &Path, relative: &str) -> (FileState, Option<u32>) {
    (
        read_worktree(root, relative),
        file_mode(&root.join(relative)),
    )
}

fn path_contains_symlink(root: &Path, relative: &str) -> bool {
    let mut current = root.to_path_buf();
    for part in relative.split('/') {
        current.push(part);
        match std::fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => return true,
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return false,
            Err(_) => return true,
        }
    }
    false
}

fn git_head(root: &Path) -> Result<Vec<u8>, String> {
    let mut command = Command::new("git");
    crate::hide_window_console(&mut command);
    let output = command
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--verify", "HEAD"])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(output.stdout)
}

fn diff_from_manifest(
    dir: &Path,
    root: &Path,
    manifest: &Manifest,
    foreign_touched: &HashSet<String>,
) -> CheckpointStatus {
    diff_from_manifest_with(
        &git_diff_files_for(root),
        dir,
        root,
        manifest,
        foreign_touched,
    )
}

fn diff_from_manifest_with(
    index: &GitDiffIndex,
    dir: &Path,
    root: &Path,
    manifest: &Manifest,
    foreign_touched: &HashSet<String>,
) -> CheckpointStatus {
    let by_relative: BTreeMap<&str, &GitChangedFile> = index
        .files
        .iter()
        .map(|file| (file.relative.as_str(), file))
        .collect();
    let git_dirty: HashSet<&str> = by_relative.keys().copied().collect();
    let mut files = Vec::new();

    for relative in &manifest.touched {
        // Without a tool-start snapshot there is no trustworthy session
        // boundary. Never guess from the shared working tree.
        if !manifest.prepared.contains(relative) {
            continue;
        }
        if session_snapshot_differs(dir, manifest, relative) == Some(false) {
            continue;
        }
        if !file_differs(dir, root, manifest, relative, &git_dirty) {
            continue;
        }
        // Review is always scoped to this session's captured before/after
        // snapshots. A foreign claim can make restoring the file unsafe, but
        // it does not make this session's recorded diff or counts inexact.
        let exact = !manifest.diverged.contains(relative);
        let undoable = exact
            && !foreign_touched.contains(relative)
            && after_matches_worktree(dir, root, manifest, relative);
        let session_change = manifest.stats.get(relative).map(|stats| {
            let additions = if exact { stats.additions } else { 0 };
            let deletions = if exact { stats.deletions } else { 0 };
            (stats.status.clone(), additions, deletions)
        });
        files.push(describe_change(
            root,
            relative,
            by_relative.get(relative.as_str()).copied(),
            exact,
            undoable,
            session_change,
        ));
    }

    files.sort_by(|a, b| a.relative.cmp(&b.relative));
    CheckpointStatus { files }
}

fn session_snapshot_differs(dir: &Path, manifest: &Manifest, relative: &str) -> Option<bool> {
    let before = manifest.files.get(relative).copied()?;
    let after = manifest.after.get(relative).copied()?;
    Some(read_snapshot(dir, relative, before) != read_after_snapshot(dir, relative, after))
}

#[cfg(test)]
fn stats_from_status(status: &CheckpointStatus) -> GitDiffStats {
    let mut additions = 0i64;
    let mut deletions = 0i64;
    for file in &status.files {
        additions += file.additions;
        deletions += file.deletions;
    }
    GitDiffStats {
        files: status.files.len() as i64,
        additions,
        deletions,
    }
}

fn file_differs(
    dir: &Path,
    root: &Path,
    manifest: &Manifest,
    relative: &str,
    git_dirty: &HashSet<&str>,
) -> bool {
    // Once a tracked path is clean against HEAD, its session change was
    // committed (or otherwise resolved) and no longer needs review.
    if !git_dirty.contains(relative)
        && (manifest.tracked.contains(relative) || in_head(root, relative))
    {
        return false;
    }
    match manifest.files.get(relative) {
        Some(SnapshotKind::Skipped) => false,
        Some(kind) => read_worktree(root, relative) != read_snapshot(dir, relative, *kind),
        None => {
            git_dirty.contains(relative)
                || (root.join(relative).is_file() && !in_head(root, relative))
        }
    }
}

fn describe_change(
    root: &Path,
    relative: &str,
    git: Option<&GitChangedFile>,
    exact: bool,
    undoable: bool,
    session_change: Option<(String, i64, i64)>,
) -> CheckpointFile {
    if let Some((status, additions, deletions)) = session_change {
        return CheckpointFile {
            path: path_to_js(&root.join(relative)),
            relative: relative.to_string(),
            status,
            additions,
            deletions,
            exact,
            undoable,
        };
    }
    if let Some(file) = git {
        return CheckpointFile {
            path: file.path.clone(),
            relative: file.relative.clone(),
            status: file.status.clone(),
            additions: file.additions,
            deletions: file.deletions,
            exact,
            undoable,
        };
    }
    let abs = root.join(relative);
    let status = if !abs.exists() { "deleted" } else { "modified" };
    CheckpointFile {
        path: path_to_js(&abs),
        relative: relative.to_string(),
        status: status.into(),
        additions: 0,
        deletions: 0,
        exact,
        undoable,
    }
}

fn calculate_session_stats(dir: &Path, manifest: &Manifest, relative: &str) -> Option<ChangeStats> {
    let before = manifest.files.get(relative).copied()?;
    let after = manifest.after.get(relative).copied()?;
    if before == SnapshotKind::Skipped || after == SnapshotKind::Skipped {
        return None;
    }
    let before_path = state_blob_path(&dir.join("files"), relative).ok()?;
    let after_path = state_blob_path(&dir.join("after"), relative).ok()?;
    let (additions, deletions) = diff_numstat(&before_path, &after_path)?;
    let status = match (before, after) {
        (SnapshotKind::Missing, SnapshotKind::Missing) => "modified",
        (SnapshotKind::Missing, _) => "added",
        (_, SnapshotKind::Missing) => "deleted",
        _ => "modified",
    };
    Some(ChangeStats {
        status: status.into(),
        additions,
        deletions,
    })
}

fn diff_numstat(before: &Path, after: &Path) -> Option<(i64, i64)> {
    let mut cmd = Command::new("git");
    crate::hide_window_console(&mut cmd);
    let output = cmd
        .args(["diff", "--no-index", "--no-ext-diff", "--numstat", "--"])
        .arg(before)
        .arg(after)
        .output()
        .ok()?;
    if !output.status.success() && output.status.code() != Some(1) {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut fields = text.lines().next()?.split('\t');
    let additions = fields.next()?.parse().ok()?;
    let deletions = fields.next()?.parse().ok()?;
    Some((additions, deletions))
}

fn after_matches_worktree(dir: &Path, root: &Path, manifest: &Manifest, relative: &str) -> bool {
    let Some(kind) = manifest.after.get(relative).copied() else {
        return false;
    };
    read_worktree(root, relative) == read_after_snapshot(dir, relative, kind)
}

fn release_path(manifest: &mut Manifest, relative: &str) {
    manifest.files.remove(relative);
    manifest.touched.remove(relative);
    manifest.tracked.remove(relative);
    manifest.prepared.remove(relative);
    manifest.after.remove(relative);
    manifest.stats.remove(relative);
    manifest.diverged.remove(relative);
}

fn restore_one(dir: &Path, root: &Path, manifest: &Manifest, relative: &str) -> Result<(), String> {
    let relative = resolve_repo_path(root, relative)?;
    match manifest.files.get(&relative) {
        Some(SnapshotKind::Skipped) => Ok(()),
        Some(kind) => restore_snapshot(dir, root, &relative, *kind),
        None => revert_new_change(root, &relative),
    }
}

fn restore_snapshot(
    dir: &Path,
    root: &Path,
    relative: &str,
    kind: SnapshotKind,
) -> Result<(), String> {
    match kind {
        SnapshotKind::Skipped => Ok(()),
        SnapshotKind::Missing => {
            let _ = git_checked(root, &["reset", "-q", "HEAD", "--", relative]);
            remove_worktree(root, relative)
        }
        SnapshotKind::Contents => {
            let bytes = match read_snapshot(dir, relative, kind) {
                FileState::Contents(bytes) => bytes,
                _ => return Ok(()),
            };
            write_worktree(&root.join(relative), &bytes)?;
            let _ = git_checked(root, &["reset", "-q", "HEAD", "--", relative]);
            Ok(())
        }
    }
}

fn revert_new_change(root: &Path, relative: &str) -> Result<(), String> {
    let relative = resolve_repo_path(root, relative)?;
    if in_head(root, &relative) {
        return git_checked(
            root,
            &[
                "restore",
                "--source=HEAD",
                "--staged",
                "--worktree",
                "--",
                &relative,
            ],
        );
    }
    let _ = git_checked(root, &["reset", "-q", "HEAD", "--", &relative]);
    remove_worktree(root, &relative)
}

fn in_head(root: &Path, relative: &str) -> bool {
    git_checked(root, &["cat-file", "-e", &format!("HEAD:{relative}")]).is_ok()
}

fn snapshot_file(dir: &Path, root: &Path, relative: &str) -> Result<SnapshotKind, String> {
    snapshot_file_at(&dir.join("files"), root, relative)
}

fn snapshot_after_file(dir: &Path, root: &Path, relative: &str) -> Result<SnapshotKind, String> {
    snapshot_file_at(&dir.join("after"), root, relative)
}

fn snapshot_file_at(blob_root: &Path, root: &Path, relative: &str) -> Result<SnapshotKind, String> {
    let abs = root.join(relative);
    let meta = match std::fs::symlink_metadata(&abs) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let blob = state_blob_path(blob_root, relative)?;
            if let Some(parent) = blob.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(blob, []).map_err(|e| e.to_string())?;
            return Ok(SnapshotKind::Missing);
        }
        Err(error) => return Err(error.to_string()),
    };
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Ok(SnapshotKind::Skipped);
    }
    if meta.len() > MAX_TEXT_FILE_BYTES {
        return Ok(SnapshotKind::Skipped);
    }
    let bytes = std::fs::read(&abs).map_err(|e| e.to_string())?;
    let blob = state_blob_path(blob_root, relative)?;
    if let Some(parent) = blob.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&blob, bytes).map_err(|e| e.to_string())?;
    set_file_mode(&blob, file_mode(&abs))?;
    Ok(SnapshotKind::Contents)
}

#[cfg(unix)]
fn file_mode(path: &Path) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::symlink_metadata(path)
        .ok()
        .filter(|meta| meta.is_file() && !meta.file_type().is_symlink())
        .map(|meta| meta.permissions().mode() & 0o777)
}

#[cfg(not(unix))]
fn file_mode(_path: &Path) -> Option<u32> {
    None
}

#[cfg(unix)]
fn set_file_mode(path: &Path, mode: Option<u32>) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    if let Some(mode) = mode {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn set_file_mode(_path: &Path, _mode: Option<u32>) -> Result<(), String> {
    Ok(())
}

fn snapshot_mode(blob_root: &Path, relative: &str, kind: SnapshotKind) -> Option<u32> {
    if kind != SnapshotKind::Contents {
        return None;
    }
    state_blob_path(blob_root, relative)
        .ok()
        .and_then(|path| file_mode(&path))
}

fn read_snapshot(dir: &Path, relative: &str, kind: SnapshotKind) -> FileState {
    read_snapshot_at(&dir.join("files"), relative, kind)
}

fn read_after_snapshot(dir: &Path, relative: &str, kind: SnapshotKind) -> FileState {
    read_snapshot_at(&dir.join("after"), relative, kind)
}

fn read_snapshot_at(blob_root: &Path, relative: &str, kind: SnapshotKind) -> FileState {
    match kind {
        SnapshotKind::Missing => FileState::Missing,
        SnapshotKind::Skipped => FileState::Skipped,
        SnapshotKind::Contents => match state_blob_path(blob_root, relative)
            .ok()
            .and_then(|path| std::fs::read(path).ok())
        {
            Some(bytes) => FileState::Contents(bytes),
            None => FileState::Missing,
        },
    }
}

fn read_worktree(root: &Path, relative: &str) -> FileState {
    let abs = root.join(relative);
    if !abs.exists() {
        return FileState::Missing;
    }
    if !abs.is_file() {
        return FileState::Skipped;
    }
    match std::fs::metadata(&abs).and_then(|meta| {
        if meta.len() > MAX_TEXT_FILE_BYTES {
            return Ok(FileState::Skipped);
        }
        std::fs::read(&abs).map(FileState::Contents)
    }) {
        Ok(state) => state,
        Err(_) => FileState::Missing,
    }
}

fn state_is_binary(state: &FileState) -> bool {
    matches!(state, FileState::Contents(bytes) if bytes.contains(&0))
}

fn state_text(state: FileState) -> String {
    match state {
        FileState::Contents(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        FileState::Missing | FileState::Skipped => String::new(),
    }
}

fn write_worktree(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if path.is_dir() {
        return Err(format!("{} is a directory", path.display()));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, bytes).map_err(|e| e.to_string())
}

fn remove_worktree(root: &Path, relative: &str) -> Result<(), String> {
    let abs = root.join(relative);
    if abs.is_file() || abs.is_symlink() {
        std::fs::remove_file(&abs).map_err(|e| e.to_string())?;
        return Ok(());
    }
    if abs.is_dir() {
        let _ = git_checked(root, &["clean", "-fd", "--", relative]);
        if abs.exists() {
            std::fs::remove_dir_all(&abs).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn state_blob_path(blob_root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty()
        || relative.starts_with('/')
        || relative
            .split('/')
            .any(|part| part.is_empty() || part == "..")
    {
        return Err("Invalid path".into());
    }
    Ok(blob_root.join(relative))
}

fn read_manifest(dir: &Path) -> Result<Option<Manifest>, String> {
    let path = dir.join("manifest.json");
    if !path.is_file() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

fn write_manifest(dir: &Path, manifest: &Manifest) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let dest = dir.join("manifest.json");
    let tmp = dir.join("manifest.json.tmp");
    let bytes = serde_json::to_vec_pretty(manifest).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, dest).map_err(|e| e.to_string())
}

fn project_root(cwd: &str) -> Result<PathBuf, String> {
    let trimmed = cwd.trim();
    if trimmed.is_empty() || trimmed == "~" {
        return Err("cwd is required".into());
    }
    let root = expand_home(trimmed);
    if !root.is_dir() {
        return Err(format!("{}: Not a directory", root.display()));
    }
    Ok(root)
}

fn same_cwd(saved: &str, cwd: &str) -> bool {
    let Ok(left) = project_root(saved) else {
        return false;
    };
    let Ok(right) = project_root(cwd) else {
        return false;
    };
    left == right
}

fn relative_to_root(root: &Path, path: &str) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Invalid path".into());
    }
    let expanded = expand_home(trimmed);
    if expanded.is_absolute() {
        let relative = expanded
            .strip_prefix(root)
            .map_err(|_| "Path is outside the project".to_string())?;
        let relative = relative.to_string_lossy().replace('\\', "/");
        return resolve_repo_path(root, &relative);
    }
    resolve_repo_path(root, trimmed)
}

fn validate_id(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(format!("Invalid {label} id"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::ErrorKind;
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

    struct Tmp(PathBuf);
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn tmp(label: &str) -> Tmp {
        loop {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!(
                "monocode-checkpoint-{label}-{}-{stamp}-{seq}",
                std::process::id()
            ));
            match std::fs::create_dir(&dir) {
                Ok(()) => return Tmp(dir),
                Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("{}", error),
            }
        }
    }

    fn git(dir: &Path, args: &[&str]) -> bool {
        Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "monocode")
            .env("GIT_AUTHOR_EMAIL", "monocode@test")
            .env("GIT_COMMITTER_NAME", "monocode")
            .env("GIT_COMMITTER_EMAIL", "monocode@test")
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    fn init_git_commit(dir: &Path, files: &[(&str, &str)]) -> bool {
        if !git(dir, &["init", "-b", "main"]) && !git(dir, &["init"]) {
            return false;
        }
        let _ = git(dir, &["config", "user.email", "monocode@test"]);
        let _ = git(dir, &["config", "user.name", "monocode"]);
        let _ = git(dir, &["config", "core.autocrlf", "false"]);
        for (name, contents) in files {
            let path = dir.join(name);
            if let Some(parent) = path.parent() {
                if std::fs::create_dir_all(parent).is_err() {
                    return false;
                }
            }
            if std::fs::write(&path, contents).is_err() {
                return false;
            }
        }
        git(dir, &["add", "."]) && git(dir, &["commit", "-m", "init"])
    }

    fn store() -> (Tmp, CheckpointStore) {
        let dir = tmp("store");
        let store = CheckpointStore::new(dir.0.clone());
        (dir, store)
    }

    fn relatives(status: &CheckpointStatus) -> Vec<&str> {
        status
            .files
            .iter()
            .map(|file| file.relative.as_str())
            .collect()
    }

    fn record(store: &CheckpointStore, id: &str, cwd: &str, paths: &[&str]) {
        let owned: Vec<String> = paths.iter().map(|path| (*path).to_string()).collect();
        store.capture(id, cwd, &owned).unwrap();
        // Most legacy tests write before calling this helper. Mark their
        // already-captured baselines as if a tool-start prepare event ran;
        // dedicated tests below exercise the real prepare/capture lifecycle.
        let root = project_root(cwd).unwrap();
        let dir = store.session_dir(id);
        let mut manifest = read_manifest(&dir).unwrap().unwrap();
        for path in paths {
            manifest
                .prepared
                .insert(relative_to_root(&root, path).unwrap());
        }
        write_manifest(&dir, &manifest).unwrap();
    }

    #[test]
    fn undo_reverts_only_session_files_and_keeps_user_dirty() {
        let repo = tmp("keep-user");
        if !init_git_commit(&repo.0, &[("user.txt", "mine\n"), ("clean.txt", "head\n")]) {
            return;
        }
        std::fs::write(repo.0.join("user.txt"), "mine-dirty\n").unwrap();
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();

        store.ensure("s1", &cwd).unwrap();

        std::fs::write(repo.0.join("user.txt"), "agent-on-user\n").unwrap();
        std::fs::write(repo.0.join("clean.txt"), "agent-on-clean\n").unwrap();
        std::fs::write(repo.0.join("new.txt"), "created\n").unwrap();
        record(&store, "s1", &cwd, &["user.txt", "clean.txt", "new.txt"]);

        let status = store.status("s1", &cwd).unwrap();
        assert_eq!(relatives(&status), vec!["clean.txt", "new.txt", "user.txt"]);

        store.undo("s1", &cwd, None).unwrap();

        assert_eq!(
            std::fs::read_to_string(repo.0.join("user.txt")).unwrap(),
            "mine-dirty\n"
        );
        assert_eq!(
            std::fs::read_to_string(repo.0.join("clean.txt")).unwrap(),
            "head\n"
        );
        assert!(!repo.0.join("new.txt").exists());
        assert!(store.status("s1", &cwd).unwrap().files.is_empty());
    }

    #[test]
    fn undo_does_not_touch_untouched_user_files() {
        let repo = tmp("untouched");
        if !init_git_commit(&repo.0, &[("keep.txt", "head\n"), ("edit.txt", "head\n")]) {
            return;
        }
        std::fs::write(repo.0.join("keep.txt"), "user\n").unwrap();
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd).unwrap();

        std::fs::write(repo.0.join("edit.txt"), "agent\n").unwrap();
        std::fs::write(repo.0.join("created.txt"), "new\n").unwrap();
        record(&store, "s1", &cwd, &["edit.txt", "created.txt"]);

        let status = store.status("s1", &cwd).unwrap();
        assert_eq!(relatives(&status), vec!["created.txt", "edit.txt"]);

        store.undo("s1", &cwd, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.0.join("keep.txt")).unwrap(),
            "user\n"
        );
        assert_eq!(
            std::fs::read_to_string(repo.0.join("edit.txt")).unwrap(),
            "head\n"
        );
        assert!(!repo.0.join("created.txt").exists());
    }

    #[test]
    fn ensure_is_idempotent_across_turns() {
        let repo = tmp("idempotent");
        if !init_git_commit(&repo.0, &[("a.txt", "head\n")]) {
            return;
        }
        std::fs::write(repo.0.join("a.txt"), "user\n").unwrap();
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd).unwrap();
        std::fs::write(repo.0.join("a.txt"), "agent-1\n").unwrap();
        record(&store, "s1", &cwd, &["a.txt"]);
        store.ensure("s1", &cwd).unwrap();
        std::fs::write(repo.0.join("b.txt"), "agent-2\n").unwrap();
        record(&store, "s1", &cwd, &["b.txt"]);

        store.undo("s1", &cwd, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
            "user\n"
        );
        assert!(!repo.0.join("b.txt").exists());
    }

    #[test]
    fn keep_clears_review_and_leaves_files() {
        let repo = tmp("keep");
        if !init_git_commit(&repo.0, &[("a.txt", "head\n")]) {
            return;
        }
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd).unwrap();
        std::fs::write(repo.0.join("a.txt"), "agent\n").unwrap();
        std::fs::write(repo.0.join("b.txt"), "new\n").unwrap();
        record(&store, "s1", &cwd, &["a.txt", "b.txt"]);
        assert!(!store.status("s1", &cwd).unwrap().files.is_empty());

        store.keep("s1", &cwd, None).unwrap();
        assert!(store.status("s1", &cwd).unwrap().files.is_empty());
        assert_eq!(
            std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
            "agent\n"
        );
        assert_eq!(
            std::fs::read_to_string(repo.0.join("b.txt")).unwrap(),
            "new\n"
        );
    }

    #[test]
    fn keep_one_file_then_undo_the_rest() {
        let repo = tmp("keep-one");
        if !init_git_commit(&repo.0, &[("a.txt", "head-a\n"), ("b.txt", "head-b\n")]) {
            return;
        }
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd).unwrap();
        std::fs::write(repo.0.join("a.txt"), "agent-a\n").unwrap();
        std::fs::write(repo.0.join("b.txt"), "agent-b\n").unwrap();
        record(&store, "s1", &cwd, &["a.txt", "b.txt"]);

        store.keep("s1", &cwd, Some("a.txt")).unwrap();
        let status = store.status("s1", &cwd).unwrap();
        assert_eq!(relatives(&status), vec!["b.txt"]);

        store.undo("s1", &cwd, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
            "agent-a\n"
        );
        assert_eq!(
            std::fs::read_to_string(repo.0.join("b.txt")).unwrap(),
            "head-b\n"
        );
    }

    #[test]
    fn ensure_baselines_other_session_dirty_files() {
        let repo = tmp("ensure-baseline");
        if !init_git_commit(&repo.0, &[("plan.md", "old\n")]) {
            return;
        }
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();

        store.ensure("s1", &cwd).unwrap();
        std::fs::write(repo.0.join("plan.md"), "session-one\n").unwrap();
        record(&store, "s1", &cwd, &["plan.md"]);

        store.ensure("s2", &cwd).unwrap();
        assert!(store.status("s2", &cwd).unwrap().files.is_empty());
    }

    #[test]
    fn other_session_edits_do_not_appear_in_review() {
        let repo = tmp("two-sessions");
        if !init_git_commit(&repo.0, &[("plan.md", "old\n"), ("readme.md", "old\n")]) {
            return;
        }
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();

        store.ensure("s1", &cwd).unwrap();
        std::fs::write(repo.0.join("plan.md"), "session-one\n").unwrap();
        record(&store, "s1", &cwd, &["plan.md"]);
        assert_eq!(
            relatives(&store.status("s1", &cwd).unwrap()),
            vec!["plan.md"]
        );

        store.ensure("s2", &cwd).unwrap();
        std::fs::write(repo.0.join("readme.md"), "session-two\n").unwrap();
        record(&store, "s2", &cwd, &["readme.md"]);

        assert_eq!(
            relatives(&store.status("s1", &cwd).unwrap()),
            vec!["plan.md"]
        );
        assert_eq!(
            relatives(&store.status("s2", &cwd).unwrap()),
            vec!["readme.md"]
        );

        store.undo("s1", &cwd, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.0.join("plan.md")).unwrap(),
            "old\n"
        );
        assert_eq!(
            std::fs::read_to_string(repo.0.join("readme.md")).unwrap(),
            "session-two\n"
        );
    }

    #[test]
    fn read_only_session_has_no_changes_when_another_session_edits() {
        let repo = tmp("read-only-session");
        if !init_git_commit(&repo.0, &[("app.ts", "head\n")]) {
            return;
        }
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("writer", &cwd).unwrap();
        store.ensure("reader", &cwd).unwrap();

        store.prepare("writer", &cwd, &["app.ts".into()]).unwrap();
        std::fs::write(repo.0.join("app.ts"), "writer\n").unwrap();
        store.capture("writer", &cwd, &["app.ts".into()]).unwrap();

        assert_eq!(
            relatives(&store.status("writer", &cwd).unwrap()),
            vec!["app.ts"]
        );
        assert!(store.status("reader", &cwd).unwrap().files.is_empty());
    }

    #[test]
    fn status_counts_only_the_session_delta_from_its_pre_edit_snapshot() {
        let repo = tmp("session-counts");
        if !init_git_commit(&repo.0, &[("app.ts", "head\n")]) {
            return;
        }
        std::fs::write(repo.0.join("app.ts"), "user-one\nuser-two\n").unwrap();
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd).unwrap();
        store.prepare("s1", &cwd, &["app.ts".into()]).unwrap();
        std::fs::write(repo.0.join("app.ts"), "user-one\nuser-two\nagent\n").unwrap();
        store.capture("s1", &cwd, &["app.ts".into()]).unwrap();

        let status = store.status("s1", &cwd).unwrap();
        assert_eq!(status.files.len(), 1);
        assert_eq!(status.files[0].additions, 1);
        assert_eq!(status.files[0].deletions, 0);
        assert!(status.files[0].exact);
        assert!(status.files[0].undoable);
        assert_eq!(status.files[0].path, path_to_js(&repo.0.join("app.ts")));

        let diff = store.file_diff("s1", &cwd, "app.ts").unwrap();
        assert_eq!(diff.original, "user-one\nuser-two\n");
        assert_eq!(diff.current, "user-one\nuser-two\nagent\n");
        assert_eq!(diff.path, path_to_js(&repo.0.join("app.ts")));

        // Review remains the captured session result, not a later shared
        // working-tree state.
        std::fs::write(repo.0.join("app.ts"), "user-one\nuser-two\nagent\nother\n").unwrap();
        let diff = store.file_diff("s1", &cwd, "app.ts").unwrap();
        assert_eq!(diff.current, "user-one\nuser-two\nagent\n");
    }

    #[test]
    fn shared_file_keeps_session_scoped_review_but_disables_unsafe_undo() {
        let repo = tmp("shared-file");
        if !init_git_commit(&repo.0, &[("app.ts", "head\n")]) {
            return;
        }
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd).unwrap();
        store.ensure("s2", &cwd).unwrap();

        store.prepare("s1", &cwd, &["app.ts".into()]).unwrap();
        std::fs::write(repo.0.join("app.ts"), "session-one\n").unwrap();
        store.capture("s1", &cwd, &["app.ts".into()]).unwrap();

        store.prepare("s2", &cwd, &["app.ts".into()]).unwrap();
        std::fs::write(repo.0.join("app.ts"), "session-one\nsession-two\n").unwrap();
        store.capture("s2", &cwd, &["app.ts".into()]).unwrap();

        let s1 = store.status("s1", &cwd).unwrap();
        let s2 = store.status("s2", &cwd).unwrap();
        assert!(s1.files[0].exact);
        assert!(s2.files[0].exact);
        assert_eq!((s1.files[0].additions, s1.files[0].deletions), (1, 1));
        assert_eq!((s2.files[0].additions, s2.files[0].deletions), (1, 0));
        assert!(!s1.files[0].undoable);
        assert!(!s2.files[0].undoable);
        let s1_diff = store.file_diff("s1", &cwd, "app.ts").unwrap();
        assert_eq!(s1_diff.original, "head\n");
        assert_eq!(s1_diff.current, "session-one\n");
        let s2_diff = store.file_diff("s2", &cwd, "app.ts").unwrap();
        assert_eq!(s2_diff.original, "session-one\n");
        assert_eq!(s2_diff.current, "session-one\nsession-two\n");
        assert!(store.undo("s1", &cwd, None).is_err());
        assert_eq!(
            std::fs::read_to_string(repo.0.join("app.ts")).unwrap(),
            "session-one\nsession-two\n"
        );

        // Accepting s1 releases its ownership without touching the file. The
        // second session can then safely undo back to the contents it started
        // from, preserving s1's accepted line.
        store.keep("s1", &cwd, None).unwrap();
        assert!(store.status("s2", &cwd).unwrap().files[0].undoable);
        store.undo("s2", &cwd, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.0.join("app.ts")).unwrap(),
            "session-one\n"
        );
    }

    #[test]
    fn undo_refuses_a_file_changed_after_the_session_edit() {
        let repo = tmp("changed-after");
        if !init_git_commit(&repo.0, &[("app.ts", "head\n")]) {
            return;
        }
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd).unwrap();
        store.prepare("s1", &cwd, &["app.ts".into()]).unwrap();
        std::fs::write(repo.0.join("app.ts"), "agent\n").unwrap();
        store.capture("s1", &cwd, &["app.ts".into()]).unwrap();

        std::fs::write(repo.0.join("app.ts"), "agent\nother\n").unwrap();

        assert!(!store.status("s1", &cwd).unwrap().files[0].undoable);
        assert!(store.undo("s1", &cwd, None).is_err());
        assert_eq!(
            std::fs::read_to_string(repo.0.join("app.ts")).unwrap(),
            "agent\nother\n"
        );
    }

    #[test]
    fn capture_missing_path_lets_non_git_undo_delete() {
        let project = tmp("nongit");
        let cwd = project.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd).unwrap();
        store
            .prepare(
                "s1",
                &cwd,
                &[project.0.join("made.txt").to_string_lossy().into_owned()],
            )
            .unwrap();
        std::fs::write(project.0.join("made.txt"), "hello\n").unwrap();
        store
            .capture(
                "s1",
                &cwd,
                &[project.0.join("made.txt").to_string_lossy().into_owned()],
            )
            .unwrap();
        assert_eq!(
            relatives(&store.status("s1", &cwd).unwrap()),
            vec!["made.txt"]
        );
        store.undo("s1", &cwd, None).unwrap();
        assert!(!project.0.join("made.txt").exists());
    }

    #[test]
    fn late_capture_is_not_attributed_to_the_session() {
        let repo = tmp("late-capture");
        if !init_git_commit(&repo.0, &[("a.txt", "head\n")]) {
            return;
        }
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd).unwrap();
        std::fs::write(repo.0.join("a.txt"), "agent\n").unwrap();
        store.capture("s1", &cwd, &["a.txt".into()]).unwrap();
        assert!(store.status("s1", &cwd).unwrap().files.is_empty());
        store.undo("s1", &cwd, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
            "agent\n"
        );

        // A later structured edit in that same session replaces the
        // untrusted completion-only claim with a real boundary.
        store.ensure("s1", &cwd).unwrap();
        store.capture("s1", &cwd, &["a.txt".into()]).unwrap();
        store.prepare("s1", &cwd, &["a.txt".into()]).unwrap();
        std::fs::write(repo.0.join("a.txt"), "same-session-valid\n").unwrap();
        store.capture("s1", &cwd, &["a.txt".into()]).unwrap();
        assert!(store.status("s1", &cwd).unwrap().files[0].undoable);
        store.undo("s1", &cwd, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
            "agent\n"
        );

        // An old/unprepared claim is not ownership and must not block a later
        // session that recorded a trustworthy before/after pair.
        store.ensure("s2", &cwd).unwrap();
        store.prepare("s2", &cwd, &["a.txt".into()]).unwrap();
        std::fs::write(repo.0.join("a.txt"), "second-session\n").unwrap();
        store.capture("s2", &cwd, &["a.txt".into()]).unwrap();
        assert!(store.status("s2", &cwd).unwrap().files[0].undoable);
        store.undo("s2", &cwd, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
            "agent\n"
        );
    }

    #[test]
    fn committed_session_changes_leave_review() {
        let repo = tmp("committed");
        if !init_git_commit(&repo.0, &[("edit.txt", "head\n"), ("delete.txt", "head\n")]) {
            return;
        }
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd).unwrap();

        std::fs::write(repo.0.join("edit.txt"), "agent\n").unwrap();
        std::fs::write(repo.0.join("created.txt"), "new\n").unwrap();
        std::fs::remove_file(repo.0.join("delete.txt")).unwrap();
        record(
            &store,
            "s1",
            &cwd,
            &["edit.txt", "created.txt", "delete.txt"],
        );
        assert_eq!(
            relatives(&store.status("s1", &cwd).unwrap()),
            vec!["created.txt", "delete.txt", "edit.txt"]
        );

        assert!(git(&repo.0, &["add", "-A"]));
        assert!(git(&repo.0, &["commit", "-m", "agent changes"]));
        assert!(store.status("s1", &cwd).unwrap().files.is_empty());
    }

    #[test]
    fn deleting_untracked_baseline_still_needs_review() {
        let repo = tmp("delete-untracked");
        if !init_git_commit(&repo.0, &[("tracked.txt", "head\n")]) {
            return;
        }
        std::fs::write(repo.0.join("loose.txt"), "user\n").unwrap();
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd).unwrap();

        std::fs::remove_file(repo.0.join("loose.txt")).unwrap();
        record(&store, "s1", &cwd, &["loose.txt"]);
        assert_eq!(
            relatives(&store.status("s1", &cwd).unwrap()),
            vec!["loose.txt"]
        );
    }

    #[test]
    fn session_stats_match_git_not_edit_churn() {
        let repo = tmp("stats-churn");
        if !init_git_commit(&repo.0, &[("a.txt", "head\n")]) {
            return;
        }
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd).unwrap();

        std::fs::write(repo.0.join("a.txt"), "one\ntwo\nthree\nfour\n").unwrap();
        record(&store, "s1", &cwd, &["a.txt"]);
        std::fs::write(repo.0.join("a.txt"), "head\nworld\n").unwrap();
        record(&store, "s1", &cwd, &["a.txt"]);

        let stats = store.stats_for_sessions(&cwd, &["s1".into()]).unwrap();
        let s1 = stats.get("s1").expect("s1 stats");
        assert_eq!(s1.files, 1);
        assert_eq!(s1.additions, 1);
        assert_eq!(s1.deletions, 0);
    }

    #[test]
    fn session_stats_are_scoped_to_touched_files() {
        let repo = tmp("stats-scoped");
        if !init_git_commit(&repo.0, &[("a.txt", "a\n"), ("b.txt", "b\n")]) {
            return;
        }
        std::fs::write(repo.0.join("b.txt"), "user\n").unwrap();
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("s1", &cwd).unwrap();

        std::fs::write(repo.0.join("a.txt"), "a\nA\n").unwrap();
        record(&store, "s1", &cwd, &["a.txt"]);

        let stats = store.stats_for_sessions(&cwd, &["s1".into()]).unwrap();
        let s1 = stats.get("s1").expect("s1 stats");
        assert_eq!(s1.files, 1);
        assert_eq!(s1.additions, 1);
        assert_eq!(s1.deletions, 0);
        assert_eq!(relatives(&store.status("s1", &cwd).unwrap()), vec!["a.txt"]);
    }

    #[test]
    fn isolated_worker_delta_applies_idempotently_to_matching_baseline() {
        let source = tmp("apply-source");
        let target = tmp("apply-target");
        if !init_git_commit(&source.0, &[("a.txt", "head\n")]) {
            return;
        }
        let source_path = source.0.to_string_lossy().into_owned();
        let target_path = target.0.to_string_lossy().into_owned();
        if !git(&source.0, &["clone", &source_path, &target_path]) {
            return;
        }
        std::fs::write(source.0.join("a.txt"), "user baseline\n").unwrap();
        std::fs::write(target.0.join("a.txt"), "user baseline\n").unwrap();
        let from = source.0.to_string_lossy().into_owned();
        let to = target.0.to_string_lossy().into_owned();
        let (_root, store) = store();

        store.ensure("worker", &from).unwrap();
        assert!(store.cleanup_safe("worker", &from).unwrap());
        store.prepare("worker", &from, &["a.txt".into()]).unwrap();
        std::fs::write(source.0.join("a.txt"), "worker result\n").unwrap();
        store.capture("worker", &from, &["a.txt".into()]).unwrap();
        assert!(!store.cleanup_safe("worker", &from).unwrap());

        let applied = store.apply("worker", &from, &to).unwrap();
        assert_eq!(applied.files, ["a.txt"]);
        assert_eq!(applied.already_applied, 0);
        assert_eq!(
            std::fs::read_to_string(target.0.join("a.txt")).unwrap(),
            "worker result\n"
        );
        let retried = store.apply("worker", &from, &to).unwrap();
        assert_eq!(retried.already_applied, 1);
    }

    #[test]
    fn isolated_worker_integration_keeps_both_sides_on_conflict_or_unknown_edit() {
        let source = tmp("apply-conflict-source");
        let target = tmp("apply-conflict-target");
        if !init_git_commit(&source.0, &[("a.txt", "head\n")]) {
            return;
        }
        let source_path = source.0.to_string_lossy().into_owned();
        let target_path = target.0.to_string_lossy().into_owned();
        if !git(&source.0, &["clone", &source_path, &target_path]) {
            return;
        }
        let from = source.0.to_string_lossy().into_owned();
        let to = target.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("worker", &from).unwrap();
        store.prepare("worker", &from, &["a.txt".into()]).unwrap();
        std::fs::write(source.0.join("a.txt"), "worker\n").unwrap();
        store.capture("worker", &from, &["a.txt".into()]).unwrap();
        std::fs::write(target.0.join("a.txt"), "lead changed\n").unwrap();

        let conflict = store.apply("worker", &from, &to).unwrap_err();
        assert!(conflict.contains("lead checkout changed"));
        assert_eq!(
            std::fs::read_to_string(source.0.join("a.txt")).unwrap(),
            "worker\n"
        );
        assert_eq!(
            std::fs::read_to_string(target.0.join("a.txt")).unwrap(),
            "lead changed\n"
        );

        std::fs::write(source.0.join("unreported.txt"), "unknown\n").unwrap();
        assert!(!store.cleanup_safe("worker", &from).unwrap());
        assert!(store
            .apply("worker", &from, &to)
            .unwrap_err()
            .contains("not captured"));
    }

    /// A worker checkout (`source`) and a lead clone (`target`) at one HEAD.
    fn worker_and_lead(label: &str, files: &[(&str, &str)]) -> Option<(Tmp, Tmp, String, String)> {
        let source = tmp(&format!("{label}-source"));
        let target = tmp(&format!("{label}-target"));
        if !init_git_commit(&source.0, files) {
            return None;
        }
        let from = source.0.to_string_lossy().into_owned();
        let to = target.0.to_string_lossy().into_owned();
        if !git(&source.0, &["clone", &from, &to]) {
            return None;
        }
        Some((source, target, from, to))
    }

    fn edit(store: &CheckpointStore, cwd: &str, root: &Path, path: &str, contents: Option<&str>) {
        store.prepare("worker", cwd, &[path.into()]).unwrap();
        match contents {
            Some(contents) => std::fs::write(root.join(path), contents).unwrap(),
            None => std::fs::remove_file(root.join(path)).unwrap(),
        }
        store.capture("worker", cwd, &[path.into()]).unwrap();
    }

    const LINES: &str = "1\n2\n3\n4\n5\n6\n7\n8\n9\n";

    #[test]
    fn integration_merges_separate_edits_to_one_file_idempotently() {
        let Some((source, target, from, to)) =
            worker_and_lead("merge-clean", &[("a.txt", LINES), ("b.txt", "b\n")])
        else {
            return;
        };
        let (_root, store) = store();
        store.ensure("worker", &from).unwrap();
        edit(
            &store,
            &from,
            &source.0,
            "a.txt",
            Some(&LINES.replace("1\n", "one\n")),
        );
        edit(&store, &from, &source.0, "b.txt", Some("worker b\n"));
        // The lead commits its own edit meanwhile; only the worker's HEAD is
        // part of its baseline.
        std::fs::write(target.0.join("a.txt"), LINES.replace("9\n", "nine\n")).unwrap();
        assert!(git(&target.0, &["commit", "-am", "lead edit"]));

        let applied = store.apply("worker", &from, &to).unwrap();
        assert_eq!(applied.files, ["a.txt", "b.txt"]);
        assert_eq!(applied.merged, ["a.txt"]);
        assert_eq!(applied.already_applied, 0);
        let merged = LINES.replace("1\n", "one\n").replace("9\n", "nine\n");
        assert_eq!(
            std::fs::read_to_string(target.0.join("a.txt")).unwrap(),
            merged
        );
        assert_eq!(
            std::fs::read_to_string(target.0.join("b.txt")).unwrap(),
            "worker b\n"
        );

        let retried = store.apply("worker", &from, &to).unwrap();
        assert_eq!(retried.already_applied, 2);
        assert!(retried.merged.is_empty());
        assert_eq!(
            std::fs::read_to_string(target.0.join("a.txt")).unwrap(),
            merged
        );

        // A partial application left the merge unwritten: retry merges again.
        std::fs::write(target.0.join("a.txt"), LINES.replace("9\n", "nine\n")).unwrap();
        assert_eq!(store.apply("worker", &from, &to).unwrap().merged, ["a.txt"]);
        assert_eq!(
            std::fs::read_to_string(target.0.join("a.txt")).unwrap(),
            merged
        );

        assert!(git(&source.0, &["commit", "-am", "worker commit"]));
        assert!(store
            .apply("worker", &from, &to)
            .unwrap_err()
            .contains("moved"));
    }

    #[test]
    fn integration_refuses_conflicting_or_deleted_edits_without_writing() {
        let Some((source, target, from, to)) = worker_and_lead(
            "merge-conflict",
            &[("a.txt", LINES), ("b.txt", "b\n"), ("c.txt", "c\n")],
        ) else {
            return;
        };
        let (_root, store) = store();
        store.ensure("worker", &from).unwrap();
        edit(
            &store,
            &from,
            &source.0,
            "a.txt",
            Some(&LINES.replace("5\n", "worker\n")),
        );
        edit(&store, &from, &source.0, "b.txt", Some("worker b\n"));
        edit(&store, &from, &source.0, "c.txt", None);
        std::fs::write(target.0.join("a.txt"), LINES.replace("5\n", "lead\n")).unwrap();
        std::fs::write(target.0.join("c.txt"), "lead c\n").unwrap();

        let error = store.apply("worker", &from, &to).unwrap_err();
        assert!(error.contains("lead checkout changed"));
        assert!(error.contains("a.txt, c.txt"));
        assert_eq!(
            std::fs::read_to_string(target.0.join("a.txt")).unwrap(),
            LINES.replace("5\n", "lead\n")
        );
        assert_eq!(
            std::fs::read_to_string(target.0.join("b.txt")).unwrap(),
            "b\n"
        );
        assert_eq!(
            std::fs::read_to_string(target.0.join("c.txt")).unwrap(),
            "lead c\n"
        );
        assert!(source.0.join("a.txt").exists());
    }

    #[test]
    fn patch_reports_session_changes_with_byte_limit() {
        let repo = tmp("patch");
        if !init_git_commit(
            &repo.0,
            &[
                ("a.txt", "1\n2\n3\n"),
                ("gone.txt", "bye\n"),
                ("keep.txt", "k\n"),
            ],
        ) {
            return;
        }
        std::fs::write(repo.0.join("keep.txt"), "user edit\n").unwrap();
        let cwd = repo.0.to_string_lossy().into_owned();
        let (_root, store) = store();
        store.ensure("worker", &cwd).unwrap();
        edit(&store, &cwd, &repo.0, "a.txt", Some("1\ntwo\n3\n"));
        edit(&store, &cwd, &repo.0, "new.txt", Some("fresh\n"));
        edit(&store, &cwd, &repo.0, "gone.txt", None);
        edit(&store, &cwd, &repo.0, "image.bin", Some("\0binary"));

        let full = store.patch("worker", &cwd, 1 << 20).unwrap();
        let names: Vec<_> = full
            .files
            .iter()
            .map(|file| file.relative.as_str())
            .collect();
        assert_eq!(names, ["a.txt", "gone.txt", "image.bin", "new.txt"]);
        assert!(!full.truncated);
        assert!(full.files[2].binary && !full.files[0].binary);
        assert_eq!((full.files[0].additions, full.files[0].deletions), (1, 1));
        assert!(full.patch.starts_with(
            "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n 1\n-2\n+two\n 3\n"
        ));
        assert!(full.patch.contains(
            "diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n"
        ));
        assert!(full.patch.contains(
            "diff --git a/image.bin b/image.bin\nnew file mode 100644\nBinary file changed\n"
        ));
        assert!(full
            .patch
            .contains("--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+fresh\n"));
        assert!(!full.patch.contains("keep.txt"));

        let none = store.patch("worker", &cwd, 0).unwrap();
        assert_eq!(none.files, full.files);
        assert!(none.patch.is_empty() && none.truncated);

        let cut = store.patch("worker", &cwd, 60).unwrap();
        assert!(cut.truncated);
        assert_eq!(cut.files.len(), 4);
        assert!(cut.patch.len() <= 60 && full.patch.starts_with(&cut.patch));
    }

    #[test]
    fn rejects_invalid_session_id() {
        let err = validate_id("../x", "session").unwrap_err();
        assert!(err.contains("Invalid"));
    }
}
