use std::fs;
use std::path::PathBuf;

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

// ---------- The folder lock ----------

/// Turns a path the model gave us into a real path, and refuses
/// anything that ends up outside the project folder
/// (`../`, absolute paths, symlinks pointing elsewhere).
fn resolve(root: &str, path: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|e| format!("Project folder not found: {e}"))?;
    let full = root.join(path);
    let resolved = match fs::canonicalize(&full) {
        // The path exists: canonicalize follows symlinks and removes `..`.
        Ok(p) => p,
        // The path doesn't exist yet (a new file): check its folder instead.
        Err(_) => {
            let parent = full.parent().ok_or("Invalid path")?;
            let name = full.file_name().ok_or("Invalid path")?;
            let parent = fs::canonicalize(parent)
                .map_err(|_| format!("Folder does not exist: {}", parent.display()))?;
            parent.join(name)
        }
    };
    if !resolved.starts_with(&root) {
        return Err(format!("Refused: {path} is outside the project folder"));
    }
    Ok(resolved)
}

// ---------- The three tools ----------

#[tauri::command]
fn list_dir(root: String, path: String) -> Result<Vec<String>, String> {
    let dir = resolve(&root, &path)?;
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
fn read_file(root: String, path: String) -> Result<String, String> {
    let file = resolve(&root, &path)?;
    fs::read_to_string(file).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(root: String, path: String, content: String) -> Result<String, String> {
    let file = resolve(&root, &path)?;
    fs::write(&file, &content).map_err(|e| e.to_string())?;
    Ok(format!("Wrote {} bytes to {path}", content.len()))
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
            list_dir,
            read_file,
            write_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
