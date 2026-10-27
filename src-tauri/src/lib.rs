use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

// Where the API key lives in macOS Keychain.
const SERVICE: &str = "billybot";
const ACCOUNT: &str = "openrouter";

// ---------- API key (macOS Keychain) ----------

/// Returns the saved key, or None if you haven't saved one yet.
#[tauri::command]
fn get_api_key() -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Saves (or replaces) the key in Keychain.
#[tauri::command]
fn set_api_key(key: String) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())?;
    entry.set_password(key.trim()).map_err(|e| e.to_string())
}

// ---------- The workspace (outer wall) ----------

/// Checks a folder is a sensible workspace and returns its real path.
/// Refuses the whole disk and your whole home folder.
#[tauri::command]
fn check_workspace(path: String) -> Result<String, String> {
    let ws = fs::canonicalize(&path).map_err(|e| format!("Folder not found: {e}"))?;
    if !ws.is_dir() {
        return Err("That isn't a folder".into());
    }
    if ws.parent().is_none() {
        return Err("Choose a folder, not the whole disk".into());
    }
    if let Some(home) = std::env::var_os("HOME") {
        if fs::canonicalize(home).map(|h| h == ws).unwrap_or(false) {
            return Err("Choose a folder inside your home folder, not the whole home folder".into());
        }
    }
    Ok(ws.to_string_lossy().to_string())
}

/// A project name must be one plain folder name: no slashes, no "..", not hidden.
fn check_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.starts_with('.') || name.contains('/') || name.contains('\\') {
        return Err(format!("\"{name}\" is not a valid project name"));
    }
    Ok(())
}

/// The real path of a project, guaranteed to be a folder directly inside the workspace.
/// This also catches a project folder that is a symlink pointing somewhere else.
fn project_root(workspace: &str, project: &str) -> Result<PathBuf, String> {
    check_name(project)?;
    let ws = fs::canonicalize(workspace).map_err(|e| format!("Workspace not found: {e}"))?;
    let root = fs::canonicalize(ws.join(project))
        .map_err(|_| format!("No project called \"{project}\""))?;
    if root.parent() != Some(ws.as_path()) || !root.is_dir() {
        return Err(format!("\"{project}\" is not a project in the workspace"));
    }
    Ok(root)
}

// ---------- Projects ----------

#[derive(serde::Serialize)]
struct ProjectInfo {
    name: String,
    modified: u64,   // seconds since 1970
    summary: String, // first line of the README, if any
}

fn readme_summary(dir: &Path) -> String {
    for file in ["README.md", "readme.md", "README.txt", "README"] {
        if let Ok(text) = fs::read_to_string(dir.join(file)) {
            let line = text
                .lines()
                .map(|l| l.trim().trim_start_matches('#').trim())
                .find(|l| !l.is_empty())
                .unwrap_or("");
            return line.chars().take(120).collect();
        }
    }
    String::new()
}

/// Every visible folder directly inside the workspace, most recently changed first.
#[tauri::command]
fn list_projects(workspace: String) -> Result<Vec<ProjectInfo>, String> {
    let mut projects = Vec::new();
    for entry in fs::read_dir(&workspace).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        // file_type() doesn't follow symlinks, so symlinked folders are skipped.
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if name.starts_with('.') || !is_dir {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let summary = readme_summary(&entry.path());
        projects.push(ProjectInfo { name, modified, summary });
    }
    projects.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(projects)
}

/// Errors unless `name` is an existing project in the workspace.
#[tauri::command]
fn check_project(workspace: String, name: String) -> Result<(), String> {
    project_root(&workspace, &name).map(|_| ())
}

/// Makes a new project folder. Names are kept simple: letters, numbers, - and _.
#[tauri::command]
fn create_project(workspace: String, name: String) -> Result<String, String> {
    let name = name.trim().to_string();
    check_name(&name)?;
    if name.len() > 64 || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Project names may only use letters, numbers, - and _ (max 64)".into());
    }
    let ws = fs::canonicalize(&workspace).map_err(|e| format!("Workspace not found: {e}"))?;
    let path = ws.join(&name);
    if path.exists() {
        return Err(format!("A project called \"{name}\" already exists. Open it instead."));
    }
    fs::create_dir(&path).map_err(|e| e.to_string())?;
    Ok(name)
}

// ---------- The project lock (inner wall) ----------

/// Turns a path inside a project into a real path, and refuses anything
/// that ends up outside that project (`../`, absolute paths, symlinks).
fn resolve(root: &Path, path: &str) -> Result<PathBuf, String> {
    let full = root.join(path);
    let resolved = match fs::canonicalize(&full) {
        Ok(p) => p,
        Err(_) => {
            let parent = full.parent().ok_or("Invalid path")?;
            let name = full.file_name().ok_or("Invalid path")?;
            let parent = fs::canonicalize(parent)
                .map_err(|_| format!("Folder does not exist: {}", parent.display()))?;
            parent.join(name)
        }
    };
    if !resolved.starts_with(root) {
        return Err(format!("Refused: {path} is outside the project"));
    }
    Ok(resolved)
}

// ---------- The three file tools ----------

#[tauri::command]
fn list_dir(workspace: String, project: String, path: String) -> Result<Vec<String>, String> {
    let dir = resolve(&project_root(&workspace, &project)?, &path)?;
    let mut names = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        names.push(if is_dir { format!("{name}/") } else { name });
    }
    names.sort();
    Ok(names)
}

#[tauri::command]
fn read_file(workspace: String, project: String, path: String) -> Result<String, String> {
    let file = resolve(&project_root(&workspace, &project)?, &path)?;
    fs::read_to_string(file).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(workspace: String, project: String, path: String, content: String) -> Result<String, String> {
    let file = resolve(&project_root(&workspace, &project)?, &path)?;
    fs::write(&file, &content).map_err(|e| e.to_string())?;
    Ok(format!("Wrote {} bytes to {project}/{path}", content.len()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_api_key,
            set_api_key,
            check_workspace,
            list_projects,
            check_project,
            create_project,
            list_dir,
            read_file,
            write_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
