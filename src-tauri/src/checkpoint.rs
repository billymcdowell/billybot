//! Undo for the agent's file changes.
//!
//! Before `write_file`, `edit_file` or `multi_edit` changes a file, the write command itself
//! keeps a copy of what was there (or notes that the file didn't exist), the first time that
//! file is touched in a run. If the copy can't be made, the file is not changed. Nothing in the
//! frontend can skip this.
//!
//!   <app data>/checkpoints/<chat id>/<run id>/manifest.json
//!                                          /<hash>.bin       (one saved copy per file)
//!
//! "Revert" puts files back, but only files still exactly as the agent left them: if you (or a
//! command) changed one since, it is reported as a conflict and left alone unless you force it.
//! Every path is checked with the same project lock as the file tools, again at revert time.
//!
//! What this does not cover: anything a command did (installs, deleted files, git operations).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::{project_root, resolve};

const MAX_COPY_BYTES: u64 = 50_000_000;

// Subagents write at the same time; this keeps two of them from overwriting each other's manifest.
static LOCK: Mutex<()> = Mutex::new(());

/// Which run a write belongs to, sent by the frontend with each write.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointArg {
    pub chat_id: String,
    pub run_id: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct Entry {
    project: String,
    path: String,              // inside the project, with / separators
    existed: bool,             // false: the agent created it
    blob: Option<String>,      // the saved copy, when it existed
    hash_after: Option<String>, // what the file held when the agent last wrote it
}

#[derive(Serialize, Deserialize, Default)]
struct Manifest {
    workspace: String,
    entries: Vec<Entry>,
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in bytes {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}
fn hash_hex(bytes: &[u8]) -> String {
    format!("{:016x}", fnv1a(bytes))
}

/// Where `file` is inside `root`, written with `/` separators.
pub fn relative(root: &Path, file: &Path) -> String {
    let rel = file.strip_prefix(root).unwrap_or(file);
    rel.components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect::<Vec<_>>().join("/")
}

/// One run's saved copies. Created by the write commands.
pub struct Ckpt {
    base: PathBuf,
    chat_id: String,
    run_id: String,
    workspace: String,
}

fn run_dir(base: &Path, chat_id: &str, run_id: &str) -> Result<PathBuf, String> {
    if !crate::chats::is_valid_name(chat_id) || !crate::chats::is_valid_name(run_id) {
        return Err("Invalid checkpoint id".into());
    }
    Ok(base.join("checkpoints").join(chat_id).join(run_id))
}

fn load(dir: &Path) -> Result<Manifest, String> {
    match fs::read_to_string(dir.join("manifest.json")) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("The undo information is damaged: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Manifest::default()),
        Err(e) => Err(e.to_string()),
    }
}

fn store(dir: &Path, manifest: &Manifest) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let temp = dir.join("manifest.json.tmp");
    let mut file = fs::File::create(&temp).map_err(|e| e.to_string())?;
    file.write_all(serde_json::to_string(manifest).map_err(|e| e.to_string())?.as_bytes())
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(&temp, dir.join("manifest.json")).map_err(|e| e.to_string())
}

impl Ckpt {
    pub fn new(base: &Path, arg: &CheckpointArg, workspace: &str) -> Result<Ckpt, String> {
        run_dir(base, &arg.chat_id, &arg.run_id)?; // validates the ids
        Ok(Ckpt { base: base.to_path_buf(), chat_id: arg.chat_id.clone(), run_id: arg.run_id.clone(), workspace: workspace.to_string() })
    }

    fn dir(&self) -> Result<PathBuf, String> {
        run_dir(&self.base, &self.chat_id, &self.run_id)
    }

    /// Call before changing `file`. Does nothing if this run already saved it.
    pub fn before(&self, project: &str, rel: &str, file: &Path) -> Result<(), String> {
        let _guard = LOCK.lock().map_err(|_| "Lock failed")?;
        let dir = self.dir()?;
        let mut manifest = load(&dir)?;
        manifest.workspace = self.workspace.clone();
        if manifest.entries.iter().any(|e| e.project == project && e.path == rel) {
            return Ok(());
        }
        let (existed, blob) = match fs::metadata(file) {
            Ok(meta) if !meta.is_file() => return Err("that path is not a file".into()),
            Ok(meta) if meta.len() > MAX_COPY_BYTES => {
                return Err(format!("the file is {} MB, too big to keep a copy of", meta.len() / 1_000_000));
            }
            Ok(_) => {
                let bytes = fs::read(file).map_err(|e| e.to_string())?;
                let name = format!("{}.bin", hash_hex(format!("{project}/{rel}").as_bytes()));
                fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                fs::write(dir.join(&name), bytes).map_err(|e| e.to_string())?;
                (true, Some(name))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (false, None),
            Err(e) => return Err(e.to_string()),
        };
        manifest.entries.push(Entry { project: project.to_string(), path: rel.to_string(), existed, blob, hash_after: None });
        store(&dir, &manifest)
    }

    /// Call after changing `file`: remembers what the agent left there.
    pub fn after(&self, project: &str, rel: &str, file: &Path) -> Result<(), String> {
        let _guard = LOCK.lock().map_err(|_| "Lock failed")?;
        let dir = self.dir()?;
        let mut manifest = load(&dir)?;
        let hash = hash_hex(&fs::read(file).map_err(|e| e.to_string())?);
        match manifest.entries.iter_mut().find(|e| e.project == project && e.path == rel) {
            Some(entry) => entry.hash_after = Some(hash),
            None => return Err("no undo copy was made for this file".into()),
        }
        store(&dir, &manifest)
    }
}

/// The checkpoint for a write, if the frontend sent a run to file it under.
pub fn ckpt_from(app: &tauri::AppHandle, arg: Option<CheckpointArg>, workspace: &str) -> Result<Option<Ckpt>, String> {
    match arg {
        None => Ok(None),
        Some(arg) => {
            let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
            Ckpt::new(&base, &arg, workspace).map(Some)
        }
    }
}

// ---------- Reverting ----------

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FilePlan {
    pub run_id: String,
    pub project: String,
    pub path: String,
    /// restore, delete, nothing, conflict_changed, conflict_missing or blocked
    pub action: String,
}

fn plan_entry(manifest: &Manifest, dir: &Path, entry: &Entry) -> (String, Option<PathBuf>) {
    let Ok(root) = project_root(&manifest.workspace, &entry.project) else { return ("blocked".into(), None) };
    let Ok(file) = resolve(&root, &entry.path) else { return ("blocked".into(), None) };
    // A link in the way, or something that isn't a plain file, is never touched.
    if fs::symlink_metadata(&file).is_ok_and(|m| m.file_type().is_symlink() || m.is_dir()) {
        return ("blocked".into(), None);
    }
    let current = match fs::read(&file) {
        Ok(bytes) => Some(hash_hex(&bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return ("blocked".into(), None),
    };
    let saved = entry.blob.as_ref().and_then(|b| fs::read(dir.join(b)).ok()).map(|b| hash_hex(&b));
    let action = match (entry.existed, current) {
        (true, Some(now)) if Some(&now) == saved.as_ref() => "nothing", // already back to how it was
        (true, Some(now)) if Some(&now) == entry.hash_after.as_ref() => "restore",
        (true, Some(_)) => "conflict_changed",
        (true, None) => "conflict_missing",
        (false, Some(now)) if Some(&now) == entry.hash_after.as_ref() => "delete",
        (false, Some(_)) => "conflict_changed",
        (false, None) => "nothing",
    };
    (action.into(), Some(file))
}

/// What reverting these runs would do, file by file, without doing it.
pub fn preview(base: &Path, chat_id: &str, run_ids: &[String]) -> Result<Vec<FilePlan>, String> {
    let mut out = Vec::new();
    for run_id in run_ids {
        let dir = run_dir(base, chat_id, run_id)?;
        let manifest = load(&dir)?;
        for entry in &manifest.entries {
            let (action, _) = plan_entry(&manifest, &dir, entry);
            out.push(FilePlan { run_id: run_id.clone(), project: entry.project.clone(), path: entry.path.clone(), action });
        }
    }
    Ok(out)
}

#[derive(Serialize, Default, Debug, PartialEq)]
pub struct RevertResult {
    pub restored: usize,
    pub deleted: usize,
    /// files left alone, each as "project/path: why"
    pub skipped: Vec<String>,
}

/// Puts files back, newest run first (pass them in that order). With `force`, files that
/// changed since the agent wrote them are put back too.
pub fn revert(base: &Path, chat_id: &str, run_ids: &[String], force: bool) -> Result<RevertResult, String> {
    let _guard = LOCK.lock().map_err(|_| "Lock failed")?;
    let mut result = RevertResult::default();
    for run_id in run_ids {
        let dir = run_dir(base, chat_id, run_id)?;
        let mut manifest = load(&dir)?;
        let mut remaining = Vec::new();
        for entry in manifest.entries.clone() {
            let (action, file) = plan_entry(&manifest, &dir, &entry);
            let name = format!("{}/{}", entry.project, entry.path);
            let go = |what: &str| -> Result<(), String> {
                let file = file.clone().ok_or("no path")?;
                match what {
                    "delete" => match fs::remove_file(&file) {
                        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
                        _ => Ok(()),
                    },
                    _ => {
                        let blob = entry.blob.as_ref().ok_or("no saved copy")?;
                        fs::write(&file, fs::read(dir.join(blob)).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
                    }
                }
            };
            let outcome = match action.as_str() {
                "nothing" => Ok(None),
                "restore" => go("restore").map(|_| Some(true)),
                "delete" => go("delete").map(|_| Some(false)),
                "conflict_changed" | "conflict_missing" if force => {
                    go(if entry.existed { "restore" } else { "delete" }).map(|_| Some(entry.existed))
                }
                "conflict_changed" => Err(format!("{name}: changed since the agent wrote it")),
                "conflict_missing" => Err(format!("{name}: deleted since the agent wrote it")),
                _ => Err(format!("{name}: can't be reached safely")),
            };
            match outcome {
                Ok(None) => {}
                Ok(Some(true)) => result.restored += 1,
                Ok(Some(false)) => result.deleted += 1,
                Err(why) => {
                    result.skipped.push(why);
                    remaining.push(entry);
                }
            }
        }
        if remaining.is_empty() {
            let _ = fs::remove_dir_all(&dir);
        } else {
            manifest.entries = remaining;
            store(&dir, &manifest)?;
        }
    }
    Ok(result)
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunStatus {
    pub run_id: String,
    pub files: usize,
}

/// How many files each run changed (0 for a run that changed none, or was already reverted).
pub fn status(base: &Path, chat_id: &str, run_ids: &[String]) -> Result<Vec<RunStatus>, String> {
    run_ids
        .iter()
        .map(|run_id| {
            let files = load(&run_dir(base, chat_id, run_id)?).map(|m| m.entries.len()).unwrap_or(0);
            Ok(RunStatus { run_id: run_id.clone(), files })
        })
        .collect()
}

pub fn delete_chat(base: &Path, chat_id: &str) -> Result<(), String> {
    if !crate::chats::is_valid_name(chat_id) {
        return Err("Invalid chat id".into());
    }
    match fs::remove_dir_all(base.join("checkpoints").join(chat_id)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

fn dir_size(path: &Path) -> u64 {
    fs::read_dir(path)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .map(|e| match e.metadata() {
                    Ok(m) if m.is_dir() => dir_size(&e.path()),
                    Ok(m) => m.len(),
                    Err(_) => 0,
                })
                .sum()
        })
        .unwrap_or(0)
}

/// Removes saved copies older than `max_age`, then the oldest until the rest fit in `max_bytes`.
/// Returns how many runs were removed.
pub fn prune(base: &Path, max_age: Duration, max_bytes: u64, now: SystemTime) -> usize {
    let root = base.join("checkpoints");
    let mut runs: Vec<(SystemTime, u64, PathBuf)> = Vec::new();
    for chat in fs::read_dir(&root).into_iter().flatten().flatten() {
        for run in fs::read_dir(chat.path()).into_iter().flatten().flatten() {
            let path = run.path();
            if !path.is_dir() {
                continue;
            }
            let modified = fs::metadata(path.join("manifest.json")).and_then(|m| m.modified()).or_else(|_| run.metadata().and_then(|m| m.modified())).unwrap_or(now);
            runs.push((modified, dir_size(&path), path));
        }
    }
    runs.sort_by_key(|r| r.0); // oldest first
    let mut removed = 0;
    let mut total: u64 = runs.iter().map(|r| r.1).sum();
    for (modified, size, path) in runs {
        let too_old = now.duration_since(modified).is_ok_and(|age| age > max_age);
        if (too_old || total > max_bytes) && fs::remove_dir_all(&path).is_ok() {
            total = total.saturating_sub(size);
            removed += 1;
            if let Some(chat) = path.parent() {
                let _ = fs::remove_dir(chat); // only succeeds if the chat has no runs left
            }
        }
    }
    removed
}

fn base(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn checkpoint_status(app: tauri::AppHandle, chat_id: String, run_ids: Vec<String>) -> Result<Vec<RunStatus>, String> {
    status(&base(&app)?, &chat_id, &run_ids)
}

#[tauri::command]
pub fn checkpoint_preview(app: tauri::AppHandle, chat_id: String, run_ids: Vec<String>) -> Result<Vec<FilePlan>, String> {
    preview(&base(&app)?, &chat_id, &run_ids)
}

#[tauri::command]
pub fn checkpoint_revert(app: tauri::AppHandle, chat_id: String, run_ids: Vec<String>, force: bool) -> Result<RevertResult, String> {
    revert(&base(&app)?, &chat_id, &run_ids, force)
}

#[tauri::command]
pub fn checkpoint_delete_chat(app: tauri::AppHandle, chat_id: String) -> Result<(), String> {
    delete_chat(&base(&app)?, &chat_id)
}

#[tauri::command]
pub fn checkpoint_prune(app: tauri::AppHandle, max_age_days: u64, max_megabytes: u64) -> Result<usize, String> {
    Ok(prune(
        &base(&app)?,
        Duration::from_secs(max_age_days.saturating_mul(86_400)),
        max_megabytes.saturating_mul(1_000_000),
        SystemTime::now(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{do_edit_file, do_multi_edit, do_write_file, Edit};
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// A data folder and a workspace holding a project called "proj".
    struct Env {
        base: PathBuf,
        ws: String,
        proj: PathBuf,
    }

    fn env() -> Env {
        let id = format!("{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst));
        let root = std::env::temp_dir().join(format!("billybot-ckpt-{id}"));
        let _ = fs::remove_dir_all(&root);
        let proj = root.join("ws/proj");
        fs::create_dir_all(&proj).unwrap();
        fs::create_dir_all(root.join("data")).unwrap();
        Env { base: root.join("data"), ws: root.join("ws").to_string_lossy().to_string(), proj }
    }

    fn ckpt(e: &Env, run: &str) -> Ckpt {
        Ckpt::new(&e.base, &CheckpointArg { chat_id: "chat1".into(), run_id: run.into() }, &e.ws).unwrap()
    }

    fn write(e: &Env, run: &str, path: &str, content: &str) -> Result<String, String> {
        do_write_file(&e.ws, "proj", path, content, Some(&ckpt(e, run)))
    }

    fn runs(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    fn actions(e: &Env, ids: &[&str]) -> Vec<String> {
        preview(&e.base, "chat1", &runs(ids)).unwrap().into_iter().map(|p| format!("{}:{}", p.path, p.action)).collect()
    }

    fn read(e: &Env, name: &str) -> String {
        fs::read_to_string(e.proj.join(name)).unwrap()
    }

    #[test]
    fn reverting_puts_an_overwritten_file_back() {
        let e = env();
        fs::write(e.proj.join("a.txt"), "original").unwrap();
        write(&e, "r1", "a.txt", "changed").unwrap();
        assert_eq!(read(&e, "a.txt"), "changed");
        assert_eq!(actions(&e, &["r1"]), ["a.txt:restore"]);
        let result = revert(&e.base, "chat1", &runs(&["r1"]), false).unwrap();
        assert_eq!(result, RevertResult { restored: 1, deleted: 0, skipped: vec![] });
        assert_eq!(read(&e, "a.txt"), "original");
    }

    #[test]
    fn reverting_removes_a_file_the_agent_created() {
        let e = env();
        write(&e, "r1", "new.txt", "hello").unwrap();
        assert_eq!(actions(&e, &["r1"]), ["new.txt:delete"]);
        let result = revert(&e.base, "chat1", &runs(&["r1"]), false).unwrap();
        assert_eq!((result.restored, result.deleted), (0, 1));
        assert!(!e.proj.join("new.txt").exists());
    }

    #[test]
    fn the_first_copy_is_kept_however_many_times_the_file_changes_in_a_run() {
        let e = env();
        fs::write(e.proj.join("a.txt"), "v0").unwrap();
        write(&e, "r1", "a.txt", "v1").unwrap();
        write(&e, "r1", "a.txt", "v2").unwrap();
        do_edit_file(&e.ws, "proj", "a.txt", "v2".into(), "v3".into(), Some(&ckpt(&e, "r1"))).unwrap();
        assert_eq!(status(&e.base, "chat1", &runs(&["r1"])).unwrap()[0].files, 1);
        revert(&e.base, "chat1", &runs(&["r1"]), false).unwrap();
        assert_eq!(read(&e, "a.txt"), "v0");
    }

    #[test]
    fn edit_and_multi_edit_are_covered_too() {
        let e = env();
        fs::write(e.proj.join("a.txt"), "one two").unwrap();
        fs::write(e.proj.join("b.txt"), "x y").unwrap();
        do_edit_file(&e.ws, "proj", "a.txt", "one".into(), "1".into(), Some(&ckpt(&e, "r1"))).unwrap();
        let edits = vec![Edit { old_text: "x".into(), new_text: "X".into() }, Edit { old_text: "y".into(), new_text: "Y".into() }];
        do_multi_edit(&e.ws, "proj", "b.txt", edits, Some(&ckpt(&e, "r1"))).unwrap();
        assert_eq!((read(&e, "a.txt"), read(&e, "b.txt")), ("1 two".into(), "X Y".into()));
        revert(&e.base, "chat1", &runs(&["r1"]), false).unwrap();
        assert_eq!((read(&e, "a.txt"), read(&e, "b.txt")), ("one two".into(), "x y".into()));
    }

    #[test]
    fn an_edit_that_fails_leaves_no_undo_entry() {
        let e = env();
        fs::write(e.proj.join("a.txt"), "text").unwrap();
        assert!(do_edit_file(&e.ws, "proj", "a.txt", "missing".into(), "x".into(), Some(&ckpt(&e, "r1"))).is_err());
        assert_eq!(status(&e.base, "chat1", &runs(&["r1"])).unwrap()[0].files, 0);
    }

    #[test]
    fn a_file_changed_since_the_agent_wrote_it_is_left_alone_unless_forced() {
        let e = env();
        fs::write(e.proj.join("a.txt"), "original").unwrap();
        write(&e, "r1", "a.txt", "agent").unwrap();
        fs::write(e.proj.join("a.txt"), "agent plus my edit").unwrap();
        assert_eq!(actions(&e, &["r1"]), ["a.txt:conflict_changed"]);

        let result = revert(&e.base, "chat1", &runs(&["r1"]), false).unwrap();
        assert_eq!(result.skipped, ["proj/a.txt: changed since the agent wrote it"]);
        assert_eq!(read(&e, "a.txt"), "agent plus my edit");
        assert_eq!(status(&e.base, "chat1", &runs(&["r1"])).unwrap()[0].files, 1, "still there to retry");

        let forced = revert(&e.base, "chat1", &runs(&["r1"]), true).unwrap();
        assert_eq!((forced.restored, forced.skipped.len()), (1, 0));
        assert_eq!(read(&e, "a.txt"), "original");
        assert_eq!(status(&e.base, "chat1", &runs(&["r1"])).unwrap()[0].files, 0);
    }

    #[test]
    fn a_file_deleted_since_is_a_conflict_and_forcing_brings_it_back() {
        let e = env();
        fs::write(e.proj.join("a.txt"), "original").unwrap();
        write(&e, "r1", "a.txt", "agent").unwrap();
        fs::remove_file(e.proj.join("a.txt")).unwrap();
        assert_eq!(actions(&e, &["r1"]), ["a.txt:conflict_missing"]);
        assert_eq!(revert(&e.base, "chat1", &runs(&["r1"]), false).unwrap().skipped.len(), 1);
        assert!(!e.proj.join("a.txt").exists());
        revert(&e.base, "chat1", &runs(&["r1"]), true).unwrap();
        assert_eq!(read(&e, "a.txt"), "original");
    }

    #[test]
    fn a_created_file_you_have_since_edited_is_only_deleted_when_forced() {
        let e = env();
        write(&e, "r1", "new.txt", "agent").unwrap();
        fs::write(e.proj.join("new.txt"), "mine now").unwrap();
        assert_eq!(actions(&e, &["r1"]), ["new.txt:conflict_changed"]);
        revert(&e.base, "chat1", &runs(&["r1"]), false).unwrap();
        assert!(e.proj.join("new.txt").exists());
        revert(&e.base, "chat1", &runs(&["r1"]), true).unwrap();
        assert!(!e.proj.join("new.txt").exists());
        // already gone: nothing to do
        write(&e, "r2", "gone.txt", "x").unwrap();
        fs::remove_file(e.proj.join("gone.txt")).unwrap();
        assert_eq!(actions(&e, &["r2"]), ["gone.txt:nothing"]);
    }

    #[test]
    fn a_file_already_back_to_how_it_was_needs_nothing() {
        let e = env();
        fs::write(e.proj.join("a.txt"), "original").unwrap();
        write(&e, "r1", "a.txt", "agent").unwrap();
        fs::write(e.proj.join("a.txt"), "original").unwrap();
        assert_eq!(actions(&e, &["r1"]), ["a.txt:nothing"]);
        let result = revert(&e.base, "chat1", &runs(&["r1"]), false).unwrap();
        assert_eq!((result.restored, result.skipped.len()), (0, 0));
    }

    #[test]
    fn two_runs_on_the_same_file_revert_newest_first() {
        let e = env();
        fs::write(e.proj.join("a.txt"), "v0").unwrap();
        write(&e, "r1", "a.txt", "v1").unwrap();
        write(&e, "r2", "a.txt", "v2").unwrap();
        let result = revert(&e.base, "chat1", &runs(&["r2", "r1"]), false).unwrap();
        assert_eq!(result.restored, 2);
        assert_eq!(read(&e, "a.txt"), "v0");
    }

    #[test]
    fn reverting_the_older_run_alone_is_a_conflict_while_the_newer_one_exists() {
        let e = env();
        fs::write(e.proj.join("a.txt"), "v0").unwrap();
        write(&e, "r1", "a.txt", "v1").unwrap();
        write(&e, "r2", "a.txt", "v2").unwrap();
        assert_eq!(actions(&e, &["r1"]), ["a.txt:conflict_changed"]);
    }

    #[test]
    fn a_finished_revert_clears_its_saved_copies() {
        let e = env();
        fs::write(e.proj.join("a.txt"), "o").unwrap();
        write(&e, "r1", "a.txt", "n").unwrap();
        revert(&e.base, "chat1", &runs(&["r1"]), false).unwrap();
        assert!(!e.base.join("checkpoints/chat1/r1").exists());
        assert_eq!(status(&e.base, "chat1", &runs(&["r1", "never-ran"])).unwrap().iter().map(|s| s.files).collect::<Vec<_>>(), [0, 0]);
    }

    #[test]
    fn writes_from_several_threads_in_one_run_are_all_recorded() {
        let e = env();
        for i in 0..8 {
            fs::write(e.proj.join(format!("f{i}.txt")), format!("o{i}")).unwrap();
        }
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let (base, ws) = (e.base.clone(), e.ws.clone());
                std::thread::spawn(move || {
                    let c = Ckpt::new(&base, &CheckpointArg { chat_id: "chat1".into(), run_id: "r1".into() }, &ws).unwrap();
                    do_write_file(&ws, "proj", &format!("f{i}.txt"), "new", Some(&c)).unwrap();
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(status(&e.base, "chat1", &runs(&["r1"])).unwrap()[0].files, 8);
        assert_eq!(revert(&e.base, "chat1", &runs(&["r1"]), false).unwrap().restored, 8);
        assert_eq!(read(&e, "f3.txt"), "o3");
    }

    #[test]
    fn a_write_is_refused_if_the_undo_copy_cannot_be_made() {
        let e = env();
        fs::write(e.proj.join("a.txt"), "original").unwrap();
        // a plain file where the run's folder should be
        fs::create_dir_all(e.base.join("checkpoints/chat1")).unwrap();
        fs::write(e.base.join("checkpoints/chat1/r1"), "in the way").unwrap();
        let err = write(&e, "r1", "a.txt", "changed").unwrap_err();
        assert!(err.contains("nothing was changed"), "{err}");
        assert_eq!(read(&e, "a.txt"), "original");
    }

    #[test]
    fn a_file_too_big_to_copy_is_refused() {
        let e = env();
        let big = fs::File::create(e.proj.join("big.bin")).unwrap();
        big.set_len(MAX_COPY_BYTES + 1).unwrap();
        let err = write(&e, "r1", "big.bin", "x").unwrap_err();
        assert!(err.contains("too big"), "{err}");
        assert_eq!(fs::metadata(e.proj.join("big.bin")).unwrap().len(), MAX_COPY_BYTES + 1);
    }

    #[test]
    fn writes_without_a_run_still_work_and_keep_no_copy() {
        let e = env();
        fs::write(e.proj.join("a.txt"), "o").unwrap();
        do_write_file(&e.ws, "proj", "a.txt", "n", None).unwrap();
        assert!(!e.base.join("checkpoints").exists());
    }

    #[test]
    fn git_data_is_off_limits_to_the_file_tools() {
        let e = env();
        fs::create_dir_all(e.proj.join(".git")).unwrap();
        fs::write(e.proj.join(".git/config"), "[core]\n").unwrap();
        for path in [".git/config", ".git/hooks/pre-commit", ".GIT/config", "sub/../.git/config"] {
            let err = do_write_file(&e.ws, "proj", path, "x", None).unwrap_err();
            assert!(err.contains(".git is git's own data") || err.contains("does not exist"), "{path}: {err}");
        }
        assert!(do_edit_file(&e.ws, "proj", ".git/config", "[core]".into(), "x".into(), None).unwrap_err().contains(".git"));
        assert!(do_multi_edit(&e.ws, "proj", ".git/config", vec![Edit { old_text: "[core]".into(), new_text: "x".into() }], None).unwrap_err().contains(".git"));
        assert_eq!(fs::read_to_string(e.proj.join(".git/config")).unwrap(), "[core]\n");
        // names that merely contain ".git" are fine
        assert!(do_write_file(&e.ws, "proj", ".gitignore", "node_modules\n", None).is_ok());
        assert!(do_write_file(&e.ws, "proj", "a.git", "x", None).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_put_in_the_way_is_never_followed_when_reverting() {
        let e = env();
        let outside = e.base.parent().unwrap().join("outside.txt");
        fs::write(&outside, "precious").unwrap();
        fs::write(e.proj.join("a.txt"), "original").unwrap();
        write(&e, "r1", "a.txt", "agent").unwrap();
        fs::remove_file(e.proj.join("a.txt")).unwrap();
        std::os::unix::fs::symlink(&outside, e.proj.join("a.txt")).unwrap();
        assert_eq!(actions(&e, &["r1"]), ["a.txt:blocked"]);
        for force in [false, true] {
            let result = revert(&e.base, "chat1", &runs(&["r1"]), force).unwrap();
            assert_eq!(result.restored + result.deleted, 0);
            assert_eq!(result.skipped.len(), 1);
        }
        assert_eq!(fs::read_to_string(&outside).unwrap(), "precious");
    }

    #[test]
    fn ids_are_checked() {
        let e = env();
        for bad in ["../x", "a/b", "", "a b"] {
            assert!(Ckpt::new(&e.base, &CheckpointArg { chat_id: bad.into(), run_id: "r".into() }, &e.ws).is_err(), "{bad}");
            assert!(Ckpt::new(&e.base, &CheckpointArg { chat_id: "c".into(), run_id: bad.into() }, &e.ws).is_err(), "{bad}");
            assert!(preview(&e.base, "c", &runs(&[bad])).is_err());
        }
        assert!(delete_chat(&e.base, "../x").is_err());
    }

    #[test]
    fn deleting_a_chat_removes_its_copies() {
        let e = env();
        write(&e, "r1", "a.txt", "x").unwrap();
        delete_chat(&e.base, "chat1").unwrap();
        assert!(!e.base.join("checkpoints/chat1").exists());
        delete_chat(&e.base, "chat1").unwrap(); // already gone: fine
    }

    #[test]
    fn old_copies_and_then_the_oldest_are_pruned() {
        let e = env();
        let now = SystemTime::now();
        let make = |chat: &str, run: &str, age_days: u64, bytes: usize| {
            let dir = e.base.join("checkpoints").join(chat).join(run);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("x.bin"), vec![0u8; bytes]).unwrap();
            let manifest = fs::File::create(dir.join("manifest.json")).unwrap();
            manifest.set_modified(now - Duration::from_secs(age_days * 86_400)).unwrap();
        };
        make("c1", "old", 40, 10);
        make("c1", "mid", 5, 1000);
        make("c2", "new", 1, 1000);
        // by age: only "old" goes, and nothing else while everything fits
        assert_eq!(prune(&e.base, Duration::from_secs(30 * 86_400), 10_000_000, now), 1);
        assert!(!e.base.join("checkpoints/c1/old").exists());
        assert!(e.base.join("checkpoints/c1/mid").exists());
        // by size: the oldest of what is left goes first
        assert_eq!(prune(&e.base, Duration::from_secs(30 * 86_400), 1500, now), 1);
        assert!(!e.base.join("checkpoints/c1").exists(), "an emptied chat folder is removed");
        assert!(e.base.join("checkpoints/c2/new").exists());
        assert_eq!(prune(&e.base, Duration::from_secs(86_400), 10_000_000, now + Duration::from_secs(3 * 86_400)), 1);
    }

    #[test]
    fn paths_are_stored_with_forward_slashes() {
        let root = Path::new("/ws/proj");
        assert_eq!(relative(root, Path::new("/ws/proj/src/a.ts")), "src/a.ts");
        assert_eq!(relative(root, Path::new("/ws/proj/a.ts")), "a.ts");
    }
}
