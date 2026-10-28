//! Chat storage: one JSON file per chat, so saving one chat never rewrites the others and a
//! bad write can't lose them all. Files live in the app's data folder, in a folder per
//! workspace:
//!
//!   <app data>/chats/<workspace name>-<hash>/<name>.json
//!
//! The frontend decides what goes in a file. This side only guarantees that names are safe,
//! that a write is all-or-nothing (temp file, then rename), and that nothing outside the
//! chats folder can be reached.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::Manager;

/// A file name is letters, digits, `-` and `_` only. Chat ids are UUIDs; the index is `_index`.
pub(crate) fn is_valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 100 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn check_name(name: &str) -> Result<(), String> {
    if is_valid_name(name) { Ok(()) } else { Err(format!("\"{name}\" is not a valid chat name")) }
}

/// 64-bit FNV-1a. Not for security: it only has to be the same on every run and platform,
/// which `std`'s hashers don't promise.
fn fnv1a(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in text.as_bytes() {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// A folder name for a workspace: its last path part (so you can find it by eye) plus a hash
/// of the full path (so two workspaces with the same name stay apart).
fn workspace_folder(workspace: &str) -> String {
    let workspace = workspace.trim_end_matches(['/', '\\']); // "/a/b/" and "/a/b" are one workspace
    let last = workspace.rsplit(['/', '\\']).next().unwrap_or("");
    let readable: String = last
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .take(30)
        .collect();
    format!("{}-{:016x}", if readable.is_empty() { "workspace" } else { &readable }, fnv1a(workspace))
}

fn chat_dir(base: &Path, workspace: &str) -> PathBuf {
    base.join("chats").join(workspace_folder(workspace))
}

fn file_path(base: &Path, workspace: &str, name: &str) -> Result<PathBuf, String> {
    check_name(name)?;
    Ok(chat_dir(base, workspace).join(format!("{name}.json")))
}

fn write(base: &Path, workspace: &str, name: &str, data: &str) -> Result<(), String> {
    let path = file_path(base, workspace, name)?;
    let dir = path.parent().ok_or("Invalid chat folder")?;
    fs::create_dir_all(dir).map_err(|e| format!("Couldn't create the chats folder: {e}"))?;
    // Write beside the real file, flush it to disk, then rename over it. A crash leaves either
    // the old file or the new one, never half of each.
    let temp = dir.join(format!("{name}.json.tmp"));
    let mut file = fs::File::create(&temp).map_err(|e| e.to_string())?;
    file.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(&temp, &path).map_err(|e| {
        let _ = fs::remove_file(&temp);
        e.to_string()
    })
}

fn read(base: &Path, workspace: &str, name: &str) -> Result<Option<String>, String> {
    match fs::read_to_string(file_path(base, workspace, name)?) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn delete(base: &Path, workspace: &str, name: &str) -> Result<(), String> {
    match fs::remove_file(file_path(base, workspace, name)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// The names (without `.json`) of every file in the workspace's chat folder.
fn names(base: &Path, workspace: &str) -> Result<Vec<String>, String> {
    let entries = match fs::read_dir(chat_dir(base, workspace)) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    let mut out: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".json")).map(String::from))
        .filter(|n| check_name(n).is_ok())
        .collect();
    out.sort();
    Ok(out)
}

fn base(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn chat_write(app: tauri::AppHandle, workspace: String, name: String, data: String) -> Result<(), String> {
    write(&base(&app)?, &workspace, &name, &data)
}

#[tauri::command]
pub fn chat_read(app: tauri::AppHandle, workspace: String, name: String) -> Result<Option<String>, String> {
    read(&base(&app)?, &workspace, &name)
}

#[tauri::command]
pub fn chat_delete(app: tauri::AppHandle, workspace: String, name: String) -> Result<(), String> {
    delete(&base(&app)?, &workspace, &name)
}

#[tauri::command]
pub fn chat_names(app: tauri::AppHandle, workspace: String) -> Result<Vec<String>, String> {
    names(&base(&app)?, &workspace)
}

// ---------- Export ----------

const MAX_EXPORT_BYTES: usize = 50_000_000;

/// Where an export may be written: a new or existing plain `.md` or `.json` file, in a folder
/// that exists. The save dialog picks the path; this keeps a stray call from writing anything else.
fn check_export_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("Choose a full path for the export".into());
    }
    let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
    if !matches!(ext.as_deref(), Some("md" | "json")) {
        return Err("Exports are saved as .md or .json files".into());
    }
    let parent = path.parent().ok_or("Invalid path")?;
    if !parent.is_dir() {
        return Err(format!("Folder does not exist: {}", parent.display()));
    }
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Err("Refused: that file is a link".into()),
        Ok(meta) if !meta.is_file() => Err("That path is not a file".into()),
        _ => Ok(()),
    }
}

#[tauri::command]
pub fn write_export(path: String, contents: String) -> Result<(), String> {
    if contents.len() > MAX_EXPORT_BYTES {
        return Err("That export is too large to save".into());
    }
    let path = PathBuf::from(path);
    check_export_path(&path)?;
    fs::write(&path, contents).map_err(|e| format!("Couldn't save the export: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("billybot-chats-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn names_are_plain_ids_only() {
        for ok in ["a", "0b1c-2d", "_index", "A_b-9"] {
            assert!(check_name(ok).is_ok(), "{ok}");
        }
        for bad in ["", "../x", "a/b", "a\\b", "a.json", "a b", ".hidden", "é", &"x".repeat(101)] {
            assert!(check_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_workspace_folder_is_readable_stable_and_unique() {
        let a = workspace_folder("/Users/me/Projects");
        assert!(a.starts_with("Projects-"));
        assert_eq!(a, workspace_folder("/Users/me/Projects"));
        assert_ne!(a, workspace_folder("/Users/you/Projects"));
        assert_eq!(a, workspace_folder("/Users/me/Projects/"));
    }

    #[test]
    fn workspace_folders_cannot_escape_the_chats_folder() {
        for ws in ["../../etc", "C:\\Users\\me\\..\\..", "", "/", "weird name \u{1F600}"] {
            let f = workspace_folder(ws);
            assert!(!f.contains('/') && !f.contains('\\') && !f.contains(".."), "{f}");
        }
    }

    #[test]
    fn write_then_read_round_trips_and_overwrites() {
        let base = temp("round");
        assert_eq!(read(&base, "/ws", "c1").unwrap(), None);
        write(&base, "/ws", "c1", "{\"a\":1}").unwrap();
        assert_eq!(read(&base, "/ws", "c1").unwrap().as_deref(), Some("{\"a\":1}"));
        write(&base, "/ws", "c1", "{\"a\":2}").unwrap();
        assert_eq!(read(&base, "/ws", "c1").unwrap().as_deref(), Some("{\"a\":2}"));
        // no temp file left behind
        assert_eq!(names(&base, "/ws").unwrap(), ["c1"]);
        assert!(fs::read_dir(chat_dir(&base, "/ws")).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
    }

    #[test]
    fn workspaces_are_kept_apart() {
        let base = temp("apart");
        write(&base, "/ws/a", "c1", "A").unwrap();
        write(&base, "/ws/b", "c1", "B").unwrap();
        assert_eq!(read(&base, "/ws/a", "c1").unwrap().as_deref(), Some("A"));
        assert_eq!(read(&base, "/ws/b", "c1").unwrap().as_deref(), Some("B"));
    }

    #[test]
    fn delete_removes_one_chat_and_is_fine_if_it_is_already_gone() {
        let base = temp("delete");
        write(&base, "/ws", "c1", "1").unwrap();
        write(&base, "/ws", "c2", "2").unwrap();
        delete(&base, "/ws", "c1").unwrap();
        delete(&base, "/ws", "c1").unwrap();
        assert_eq!(names(&base, "/ws").unwrap(), ["c2"]);
    }

    #[test]
    fn names_lists_only_chat_files() {
        let base = temp("names");
        assert!(names(&base, "/ws").unwrap().is_empty());
        write(&base, "/ws", "b", "1").unwrap();
        write(&base, "/ws", "a", "1").unwrap();
        write(&base, "/ws", "_index", "[]").unwrap();
        fs::write(chat_dir(&base, "/ws").join("notes.txt"), "x").unwrap();
        fs::write(chat_dir(&base, "/ws").join("stray.json.tmp"), "x").unwrap();
        fs::write(chat_dir(&base, "/ws").join("bad name.json"), "x").unwrap();
        assert_eq!(names(&base, "/ws").unwrap(), ["_index", "a", "b"]);
    }

    #[test]
    fn unsafe_names_are_refused_everywhere() {
        let base = temp("unsafe");
        assert!(write(&base, "/ws", "../escape", "x").is_err());
        assert!(read(&base, "/ws", "../escape").is_err());
        assert!(delete(&base, "/ws", "a/b").is_err());
        assert!(!base.join("escape.json").exists());
    }

    #[test]
    fn a_failed_write_leaves_the_old_file_alone() {
        let base = temp("failed");
        write(&base, "/ws", "c1", "old").unwrap();
        // Make the rename fail by putting a directory where the file should go.
        let dir = chat_dir(&base, "/ws");
        fs::remove_file(dir.join("c1.json")).unwrap();
        fs::create_dir(dir.join("c1.json")).unwrap();
        assert!(write(&base, "/ws", "c1", "new").is_err());
        assert!(!dir.join("c1.json.tmp").exists());
    }

    #[test]
    fn exports_go_only_to_md_or_json_files_in_existing_folders() {
        let dir = temp("export");
        fs::create_dir_all(&dir).unwrap();
        let ok = dir.join("chat.md");
        assert!(check_export_path(&ok).is_ok());
        assert!(check_export_path(&dir.join("chat.JSON")).is_ok());
        assert!(check_export_path(&dir.join("chat.sh")).is_err());
        assert!(check_export_path(&dir.join("chat")).is_err());
        assert!(check_export_path(&dir.join("missing/chat.md")).is_err());
        assert!(check_export_path(Path::new("relative/chat.md")).is_err());
        fs::create_dir(dir.join("folder.md")).unwrap();
        assert!(check_export_path(&dir.join("folder.md")).is_err());
        write_export(ok.to_string_lossy().into(), "# hi".into()).unwrap();
        assert_eq!(fs::read_to_string(&ok).unwrap(), "# hi");
        // overwriting an existing export is fine (the save dialog already asked)
        write_export(ok.to_string_lossy().into(), "# again".into()).unwrap();
        assert_eq!(fs::read_to_string(&ok).unwrap(), "# again");
    }

    #[cfg(unix)]
    #[test]
    fn an_export_will_not_write_through_a_link() {
        let dir = temp("export-link");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("target.txt"), "keep").unwrap();
        std::os::unix::fs::symlink(dir.join("target.txt"), dir.join("chat.md")).unwrap();
        assert!(write_export(dir.join("chat.md").to_string_lossy().into(), "x".into()).is_err());
        assert_eq!(fs::read_to_string(dir.join("target.txt")).unwrap(), "keep");
    }
}
