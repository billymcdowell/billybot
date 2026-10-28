mod procgroup;
mod stt;

use std::fs;
use std::path::{Path, PathBuf};
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use procgroup::ProcessGroup;

// Where the API key lives in the system credential store: macOS Keychain, Windows Credential
// Manager, or the Secret Service (GNOME Keyring, KWallet) on Linux. keyring 4's default `v1`
// feature picks the store for the platform on first use.
const SERVICE: &str = "billybot";
const ACCOUNT: &str = "openrouter";

// ---------- API key (system credential store) ----------

/// Turns a keyring error into text for the user. On Linux the usual cause is that no keyring
/// service is running (a minimal desktop or a headless session), which deserves a real hint.
fn keyring_error_text(err: &keyring::Error, linux: bool) -> String {
    use keyring::Error::{NoDefaultStore, NoStorageAccess, PlatformFailure};
    let detail = match err {
        NoDefaultStore => match keyring::Entry::store_status() {
            Err(cause) => cause.to_string(),
            Ok(()) => err.to_string(),
        },
        _ => err.to_string(),
    };
    if linux && matches!(err, NoDefaultStore | NoStorageAccess(_) | PlatformFailure(_)) {
        format!(
            "Couldn't reach the system keyring, which billybot uses to store your API key. \
             Install and unlock a Secret Service provider such as GNOME Keyring or KWallet, \
             then restart billybot. ({detail})"
        )
    } else {
        detail
    }
}

fn keyring_error(err: keyring::Error) -> String {
    keyring_error_text(&err, cfg!(target_os = "linux"))
}

/// Returns the saved key, or None if you haven't saved one yet.
#[tauri::command]
fn get_api_key() -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(SERVICE, ACCOUNT).map_err(keyring_error)?;
    match entry.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(keyring_error(e)),
    }
}

/// Saves (or replaces) the key in the system credential store.
#[tauri::command]
fn set_api_key(key: String) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, ACCOUNT).map_err(keyring_error)?;
    entry.set_password(key.trim()).map_err(keyring_error)
}

// ---------- The workspace (outer wall) ----------

/// On Windows `fs::canonicalize` returns `\\?\C:\dir` (or `\\?\UNC\server\share`). That form is
/// right for comparing paths, but cmd.exe, node and git mishandle it as a working directory,
/// and it is ugly in the UI. This gives the ordinary spelling when that is equivalent, and
/// leaves anything else (including paths too long for the ordinary form) alone.
fn strip_verbatim(path: &str) -> String {
    const MAX_PLAIN: usize = 259; // MAX_PATH minus the terminator
    if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        let plain = format!(r"\\{unc}");
        return if plain.len() <= MAX_PLAIN { plain } else { path.to_string() };
    }
    if let Some(rest) = path.strip_prefix(r"\\?\") {
        let b = rest.as_bytes();
        let drive = b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\';
        if drive && rest.len() <= MAX_PLAIN {
            return rest.to_string();
        }
    }
    path.to_string()
}

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
    // std's home_dir reads $HOME on Unix and the user profile on Windows, where $HOME is unset.
    if let Some(home) = std::env::home_dir() {
        if fs::canonicalize(home).map(|h| h == ws).unwrap_or(false) {
            return Err("Choose a folder inside your home folder, not the whole home folder".into());
        }
    }
    Ok(strip_verbatim(&ws.to_string_lossy()))
}

/// A project name must be one plain folder name: no slashes, no "..", not hidden.
fn check_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.starts_with('.') || name.contains('/') || name.contains('\\') {
        return Err(format!("\"{name}\" is not a valid project name"));
    }
    // On Windows "C:x" is a drive prefix that makes join() discard the workspace, and "x:y" is
    // an alternate data stream. (project_root's parent check would catch the first anyway.)
    if cfg!(windows) && name.chars().any(|c| matches!(c, ':' | '<' | '>' | '"' | '|' | '?' | '*') || c.is_control()) {
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
            // canonicalize also fails for a link whose target is missing, and writing through
            // such a link would create the target, wherever it points.
            if fs::symlink_metadata(&full).is_ok() {
                return Err(format!("Refused: {path} is a link that doesn't lead anywhere"));
            }
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

/// Replaces one exact snippet in a file. The snippet must appear exactly once, so an
/// edit can never land in the wrong place or silently change several spots.
#[tauri::command]
fn edit_file(
    workspace: String,
    project: String,
    path: String,
    old_text: String,
    new_text: String,
) -> Result<String, String> {
    if old_text.is_empty() {
        return Err("old_text must not be empty. To create or replace a whole file, use write_file.".into());
    }
    let file = resolve(&project_root(&workspace, &project)?, &path)?;
    let content = fs::read_to_string(&file).map_err(|e| e.to_string())?;
    match content.matches(&old_text).count() {
        0 => Err("old_text was not found. Read the file again and copy the snippet exactly, including spaces and line breaks.".into()),
        1 => {
            fs::write(&file, content.replacen(&old_text, &new_text, 1)).map_err(|e| e.to_string())?;
            Ok(format!("Edited {project}/{path}"))
        }
        n => Err(format!(
            "old_text appears {n} times. Include more surrounding lines so it matches exactly once."
        )),
    }
}

// ---------- Running commands ----------
//
// Unlike the file tools, this is NOT locked to the project folder: a shell command can
// reach anything your user account can. The project is only where it starts. The
// protection is the approval prompt in the app, so keep that in place.

const DEFAULT_TIMEOUT_SECS: u64 = 60;
const MAX_TIMEOUT_SECS: u64 = 300;
const READ_LIMIT: usize = 1_000_000; // bytes kept while a command runs; the rest is thrown away
const HEAD_CHARS: usize = 10_000;
const TAIL_CHARS: usize = 20_000;

/// The shell that runs commands, and whether it is started as a login shell (so it reads the
/// user's profile and gets their real PATH). macOS keeps zsh, the macOS default. Elsewhere the
/// model writes POSIX syntax, so we prefer bash over $SHELL, which could be fish or nushell.
#[cfg(unix)]
fn unix_shell() -> (&'static str, bool) {
    if cfg!(target_os = "macos") {
        return ("/bin/zsh", true);
    }
    for bash in ["/bin/bash", "/usr/bin/bash"] {
        if Path::new(bash).exists() {
            return (bash, true);
        }
    }
    ("/bin/sh", false) // not every sh (e.g. dash) understands -l
}

#[cfg(unix)]
fn shell_command(command: &str) -> Command {
    let (shell, login) = unix_shell();
    let mut cmd = Command::new(shell);
    if login {
        cmd.arg("-l");
    }
    cmd.args(["-c", command]);
    cmd
}

/// Base64 (standard alphabet, padded). Only used to pass a script to PowerShell.
#[cfg_attr(not(windows), allow(dead_code))]
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16
            | (*chunk.get(1).unwrap_or(&0) as u32) << 8
            | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// The script PowerShell runs for a command: UTF-8 output (the default is the OEM code page),
/// and an exit code that reflects the command. `-Command` alone turns every native exit code
/// into 1, so we pass the real one on.
#[cfg_attr(not(windows), allow(dead_code))]
fn powershell_script(command: &str) -> String {
    format!(
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n\
         $global:LASTEXITCODE = $null\n\
         {command}\n\
         $ok = $?; $code = $LASTEXITCODE\n\
         if ($code) {{ exit $code }} elseif (-not $ok) {{ exit 1 }} else {{ exit 0 }}\n"
    )
}

/// Windows PowerShell 5.1 ships with every Windows. The script goes in as UTF-16 base64
/// (-EncodedCommand) so quotes in the command survive Windows' command-line parsing.
#[cfg(windows)]
fn shell_command(command: &str) -> Command {
    let utf16: Vec<u8> = powershell_script(command).encode_utf16().flat_map(u16::to_le_bytes).collect();
    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", &base64(&utf16)]);
    cmd
}

/// Keeps the start and the end of long output, which is where errors usually are.
fn shorten(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= HEAD_CHARS + TAIL_CHARS {
        return text.to_string();
    }
    let head: String = chars[..HEAD_CHARS].iter().collect();
    let tail: String = chars[chars.len() - TAIL_CHARS..].iter().collect();
    format!("{head}\n[... {} characters omitted ...]\n{tail}", chars.len() - HEAD_CHARS - TAIL_CHARS)
}

/// One flag per command that is running right now. Stop sets them all, and each command's
/// wait loop notices and kills its own process group.
static RUNNING: Mutex<Vec<Arc<AtomicBool>>> = Mutex::new(Vec::new());

/// Runs a command with the project as its starting folder and returns its exit code and
/// combined output. Nothing is typed into it, and after it finishes, times out or is
/// cancelled (by setting `cancel`) anything it left running is killed.
fn run_shell(root: &Path, command: &str, timeout: Duration, cancel: &AtomicBool) -> Result<String, String> {
    // One pipe for both stdout and stderr, so the output keeps its real order.
    let (mut reader, writer) = std::io::pipe().map_err(|e| e.to_string())?;
    let mut cmd = shell_command(command);
    ProcessGroup::configure(&mut cmd);
    cmd.current_dir(strip_verbatim(&root.to_string_lossy()))
        .env("NO_COLOR", "1")
        .env("TERM", "dumb")
        .stdin(Stdio::null())
        .stdout(writer.try_clone().map_err(|e| e.to_string())?)
        .stderr(writer);
    let mut child = cmd.spawn().map_err(|e| format!("Couldn't start the shell: {e}"))?;
    let group = ProcessGroup::attach(&child);
    drop(cmd); // closes our copies of the pipe's write end, so reading stops when the command does

    let collector = std::thread::spawn(move || {
        let mut kept = Vec::new();
        let mut capped = false;
        let mut chunk = [0u8; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let room = READ_LIMIT.saturating_sub(kept.len());
                    kept.extend_from_slice(&chunk[..n.min(room)]);
                    capped |= n > room; // keep draining so the command never blocks on a full pipe
                }
            }
        }
        (kept, capped)
    });

    let start = Instant::now();
    let mut timed_out = false;
    let mut cancelled = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(e) => return Err(e.to_string()),
        }
        if cancel.load(Ordering::SeqCst) {
            cancelled = true;
            break None;
        }
        if start.elapsed() >= timeout {
            timed_out = true;
            break None;
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    // Kill whatever is left in the command's group: everything on a timeout, or stray
    // background jobs after a normal exit. Without this, a leftover process would keep
    // the output pipe open and we would wait on it forever.
    group.kill();
    let _ = child.wait();
    let (bytes, capped) = collector.join().map_err(|_| "Couldn't read the command's output")?;

    let header = if cancelled {
        "Cancelled: the user pressed Stop, so the command was killed. Output so far:".to_string()
    } else if timed_out {
        format!("Timed out after {}s and was killed.", timeout.as_secs())
    } else {
        match status.and_then(|s| s.code()) {
            Some(code) => format!("Exit code {code}"),
            None => "Exit code unknown (stopped by a signal)".to_string(),
        }
    };
    let output = shorten(String::from_utf8_lossy(&bytes).trim_end());
    let note = if capped { "\n[output cut off after 1 MB]" } else { "" };
    Ok(format!("{header}\n{}{note}", if output.is_empty() { "(no output)" } else { &output }))
}

#[tauri::command]
async fn run_command(
    workspace: String,
    project: String,
    command: String,
    timeout_seconds: Option<u64>,
) -> Result<String, String> {
    if command.trim().is_empty() {
        return Err("command must not be empty".into());
    }
    let root = project_root(&workspace, &project)?;
    let secs = timeout_seconds.unwrap_or(DEFAULT_TIMEOUT_SECS).clamp(1, MAX_TIMEOUT_SECS);
    // Register a cancel flag so Stop can reach this command while it runs.
    let cancel = Arc::new(AtomicBool::new(false));
    RUNNING.lock().map_err(|_| "Lock failed")?.push(cancel.clone());
    let flag = cancel.clone();
    // Commands take a while, so run off the main thread.
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_shell(&root, &command, Duration::from_secs(secs), &flag)
    })
    .await
    .map_err(|e| e.to_string());
    if let Ok(mut running) = RUNNING.lock() {
        running.retain(|f| !Arc::ptr_eq(f, &cancel));
    }
    result?
}

/// Called by the Stop button: cancels every command that is running. Returns how many.
#[tauri::command]
fn cancel_commands() -> usize {
    let running = RUNNING.lock().map(|r| r.clone()).unwrap_or_default();
    for flag in &running {
        flag.store(true, Ordering::SeqCst);
    }
    running.len()
}

/// Dictation records from the microphone in the webview. WebKitGTK ships with MediaStream off
/// and denies every permission request nobody handles, so on Linux we turn it on and allow
/// the microphone (and only the microphone). macOS and Windows keep their own system prompts.
#[cfg(target_os = "linux")]
fn allow_microphone_on_linux(
    builder: tauri::Builder<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
    use tauri::webview::{PermissionKind, PermissionResponse};
    use tauri::Manager;
    builder
        .on_permission_request(|_, kind| match kind {
            PermissionKind::Microphone => PermissionResponse::Allow,
            _ => PermissionResponse::Default,
        })
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                window.with_webview(|webview| {
                    use webkit2gtk::{SettingsExt, WebViewExt};
                    if let Some(settings) = webview.inner().settings() {
                        settings.set_enable_media_stream(true);
                    }
                })?;
            }
            Ok(())
        })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "linux")]
    let builder = allow_microphone_on_linux(builder);
    builder
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(stt::Stt::default())
        .invoke_handler(tauri::generate_handler![
            get_api_key,
            set_api_key,
            check_workspace,
            list_projects,
            check_project,
            create_project,
            list_dir,
            read_file,
            write_file,
            edit_file,
            run_command,
            cancel_commands,
            stt::transcribe_local,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh workspace in the temp folder containing one project called "proj".
    fn workspace(name: &str) -> String {
        let ws = std::env::temp_dir().join(format!("billybot-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&ws);
        fs::create_dir_all(ws.join("proj")).unwrap();
        ws.to_string_lossy().to_string()
    }

    fn edit(ws: &str, path: &str, old: &str, new: &str) -> Result<String, String> {
        edit_file(ws.into(), "proj".into(), path.into(), old.into(), new.into())
    }

    #[test]
    fn edit_replaces_a_single_match() {
        let ws = workspace("single");
        let file = format!("{ws}/proj/a.txt");
        fs::write(&file, "one two three").unwrap();
        assert!(edit(&ws, "a.txt", "two", "2").is_ok());
        assert_eq!(fs::read_to_string(&file).unwrap(), "one 2 three");
    }

    #[test]
    fn edit_refuses_a_missing_snippet() {
        let ws = workspace("missing");
        let file = format!("{ws}/proj/a.txt");
        fs::write(&file, "one two three").unwrap();
        assert!(edit(&ws, "a.txt", "four", "4").unwrap_err().contains("not found"));
        assert_eq!(fs::read_to_string(&file).unwrap(), "one two three");
    }

    #[test]
    fn edit_refuses_an_ambiguous_snippet() {
        let ws = workspace("ambiguous");
        let file = format!("{ws}/proj/a.txt");
        fs::write(&file, "x x").unwrap();
        assert!(edit(&ws, "a.txt", "x", "y").unwrap_err().contains("2 times"));
        assert_eq!(fs::read_to_string(&file).unwrap(), "x x");
    }

    #[test]
    fn edit_refuses_an_empty_snippet() {
        let ws = workspace("empty");
        fs::write(format!("{ws}/proj/a.txt"), "abc").unwrap();
        assert!(edit(&ws, "a.txt", "", "y").is_err());
    }

    #[test]
    fn edit_cannot_leave_the_project() {
        let ws = workspace("escape");
        fs::create_dir_all(format!("{ws}/other")).unwrap();
        let outside = format!("{ws}/other/b.txt");
        fs::write(&outside, "secret").unwrap();
        assert!(edit(&ws, "../other/b.txt", "secret", "hacked").is_err());
        assert_eq!(fs::read_to_string(&outside).unwrap(), "secret");
    }

    #[test]
    fn edit_cannot_leave_the_project_with_an_absolute_path() {
        let ws = workspace("absolute");
        fs::create_dir_all(format!("{ws}/other")).unwrap();
        let outside = fs::canonicalize(format!("{ws}/other")).unwrap().join("b.txt");
        fs::write(&outside, "secret").unwrap();
        // Joining an absolute path replaces the project root, so this must be caught afterwards.
        let target = outside.to_string_lossy().to_string();
        assert!(edit(&ws, &target, "secret", "hacked").unwrap_err().contains("outside the project"));
        assert!(write_file(ws.clone(), "proj".into(), target, "x".into()).is_err());
        assert_eq!(fs::read_to_string(&outside).unwrap(), "secret");
    }

    #[test]
    fn a_new_file_cannot_be_created_outside_the_project() {
        let ws = workspace("new-outside");
        assert!(write_file(ws.clone(), "proj".into(), "../new.txt".into(), "x".into()).is_err());
        assert!(write_file(ws.clone(), "proj".into(), "sub/../../new.txt".into(), "x".into()).is_err());
        assert!(!Path::new(&format!("{ws}/new.txt")).exists());
    }

    #[test]
    fn project_names_must_be_one_plain_folder_name() {
        for bad in ["", ".hidden", "a/b", "a\\b", "..", "../proj"] {
            assert!(check_name(bad).is_err(), "{bad:?} was accepted");
        }
        assert!(check_name("my-app_2").is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn windows_drive_and_stream_names_are_not_project_names() {
        for bad in ["C:evil", "x:stream", "a|b", "a*"] {
            assert!(check_name(bad).is_err(), "{bad:?} was accepted");
        }
    }

    #[test]
    fn verbatim_prefixes_are_stripped_only_when_equivalent() {
        assert_eq!(strip_verbatim(r"\\?\C:\Users\me\ws"), r"C:\Users\me\ws");
        assert_eq!(strip_verbatim(r"\\?\UNC\server\share\ws"), r"\\server\share\ws");
        // Already plain, not a drive path, or too long for the plain form: unchanged.
        assert_eq!(strip_verbatim(r"C:\Users\me"), r"C:\Users\me");
        assert_eq!(strip_verbatim("/Users/me/ws"), "/Users/me/ws");
        assert_eq!(strip_verbatim(r"\\?\Volume{1234}\x"), r"\\?\Volume{1234}\x");
        let long = format!(r"\\?\C:\{}", "a".repeat(300));
        assert_eq!(strip_verbatim(&long), long);
    }

    #[test]
    fn workspace_check_returns_a_usable_path_and_refuses_the_home_folder() {
        let ws = workspace("check-ws");
        let shown = check_workspace(ws.clone()).unwrap();
        assert_eq!(fs::canonicalize(&shown).unwrap(), fs::canonicalize(&ws).unwrap());
        assert!(!shown.starts_with(r"\\?\C:"), "{shown}");
        let home = std::env::home_dir().expect("a home folder");
        assert!(check_workspace(home.to_string_lossy().to_string()).unwrap_err().contains("home folder"));
        assert!(check_workspace(ws + "/missing").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_to_nowhere_cannot_be_used_to_create_a_file_outside_the_project() {
        let ws = workspace("dangling");
        let target = format!("{ws}/created-by-link.txt");
        std::os::unix::fs::symlink(&target, format!("{ws}/proj/link.txt")).unwrap();
        let result = write_file(ws.clone(), "proj".into(), "link.txt".into(), "x".into());
        assert!(result.is_err(), "{result:?}");
        assert!(!Path::new(&target).exists(), "the file was created through the link");
    }

    #[cfg(unix)]
    #[test]
    fn a_project_folder_that_is_a_link_elsewhere_is_refused() {
        let ws = workspace("linked-project");
        let outside = workspace("linked-project-outside"); // a different workspace entirely
        std::os::unix::fs::symlink(format!("{outside}/proj"), format!("{ws}/linked")).unwrap();
        assert!(project_root(&ws, "linked").is_err());
    }

    // Shell snippets that mean the same thing in zsh/bash and in PowerShell.
    fn sleep_cmd(secs: u64) -> String {
        if cfg!(windows) { format!("Start-Sleep {secs}") } else { format!("sleep {secs}") }
    }

    /// How long to let a shell start before cancelling it. PowerShell is much slower to start.
    fn settle_secs() -> u64 {
        if cfg!(windows) { 8 } else { 2 }
    }

    fn run(ws: &str, command: &str, secs: u64) -> String {
        let root = project_root(ws, "proj").unwrap();
        run_shell(&root, command, Duration::from_secs(secs), &AtomicBool::new(false)).unwrap()
    }

    #[test]
    fn command_can_be_cancelled() {
        let ws = workspace("cmd-cancel");
        let root = project_root(&ws, "proj").unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        let start = Instant::now();
        let command = format!("echo before; {}", sleep_cmd(30));
        let job = std::thread::spawn(move || run_shell(&root, &command, Duration::from_secs(60), &flag));
        std::thread::sleep(Duration::from_secs(settle_secs())); // a login shell takes ~0.5s to start
        cancel.store(true, Ordering::SeqCst);
        let out = job.join().unwrap().unwrap();
        assert!(out.starts_with("Cancelled"), "{out}");
        assert!(out.contains("before"), "output so far is kept: {out}");
        assert!(start.elapsed() < Duration::from_secs(settle_secs() + 3), "took {:?}", start.elapsed());
    }

    #[test]
    fn cancelling_one_command_leaves_others_alone() {
        let ws = workspace("cmd-isolated");
        let root = project_root(&ws, "proj").unwrap();
        let cancelled = AtomicBool::new(true);
        let untouched = AtomicBool::new(false);
        assert!(run_shell(&root, &sleep_cmd(30), Duration::from_secs(60), &cancelled).unwrap().starts_with("Cancelled"));
        assert!(run_shell(&root, "echo fine", Duration::from_secs(10), &untouched).unwrap().starts_with("Exit code 0"));
    }

    #[test]
    fn command_reports_output_and_exit_code() {
        let ws = workspace("cmd-ok");
        let out = run(&ws, "echo hello", 10);
        assert!(out.starts_with("Exit code 0"), "{out}");
        assert!(out.contains("hello"));
    }

    #[test]
    fn command_reports_failure_and_stderr() {
        let ws = workspace("cmd-fail");
        let failing = if cfg!(windows) {
            "[Console]::Error.WriteLine('oops'); exit 3"
        } else {
            "echo oops 1>&2; exit 3"
        };
        let out = run(&ws, failing, 20);
        assert!(out.starts_with("Exit code 3"), "{out}");
        assert!(out.contains("oops"));
    }

    #[test]
    fn command_starts_in_the_project_folder() {
        let ws = workspace("cmd-cwd");
        // The shell is started in the ordinary spelling of the path (no \\?\ prefix on Windows).
        let expected = strip_verbatim(project_root(&ws, "proj").unwrap().to_str().unwrap());
        let print_cwd = if cfg!(windows) { "(Get-Location).Path" } else { "pwd" };
        let out = run(&ws, print_cwd, 20);
        assert!(out.contains(&expected), "{out}");
    }

    #[test]
    fn command_times_out_and_is_killed() {
        let ws = workspace("cmd-timeout");
        let start = Instant::now();
        let out = run(&ws, &sleep_cmd(30), 1);
        assert!(out.starts_with("Timed out after 1s"), "{out}");
        assert!(start.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn command_cannot_leave_a_background_job_running() {
        let ws = workspace("cmd-bg");
        let start = Instant::now();
        // The background process inherits the output pipe, so it must be killed for us to finish.
        let background = if cfg!(windows) {
            "Start-Process -NoNewWindow -FilePath ping.exe -ArgumentList '-n','30','127.0.0.1'; echo started"
        } else {
            "sleep 30 & echo started"
        };
        let out = run(&ws, background, 20);
        assert!(out.contains("started"), "{out}");
        // Without the group kill we would sit here until the background sleep ended.
        assert!(start.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn command_gets_no_input() {
        let ws = workspace("cmd-stdin");
        let start = Instant::now();
        // Would wait forever for input if stdin were open.
        let read_stdin = if cfg!(windows) { "[Console]::In.ReadToEnd() | Out-Null" } else { "cat" };
        let out = run(&ws, read_stdin, 20);
        assert!(out.starts_with("Exit code 0"), "{out}");
        assert!(start.elapsed() < Duration::from_secs(15));
    }

    #[test]
    fn command_output_is_shortened() {
        let ws = workspace("cmd-long");
        let long_line = if cfg!(windows) {
            "Write-Output ('a' * 100000)"
        } else {
            "head -c 100000 /dev/zero | tr '\\0' a"
        };
        let out = run(&ws, long_line, 30);
        assert!(out.contains("characters omitted"), "{}", &out[..80.min(out.len())]);
        assert!(out.len() < 35_000);
    }

    #[test]
    fn claude_md_is_read_normally() {
        let ws = workspace("claude-md-plain");
        // A missing file is simply "no instructions".
        assert!(read_file(ws.clone(), "proj".into(), "CLAUDE.md".into()).is_err());
        // A normal file is read.
        fs::write(format!("{ws}/proj/CLAUDE.md"), "Use tabs.").unwrap();
        assert_eq!(read_file(ws, "proj".into(), "CLAUDE.md".into()).unwrap(), "Use tabs.");
    }

    // Creating symlinks on Windows needs a privilege, so there the same boundary is tested
    // with directory junctions instead (see the windows_junction tests below).
    #[cfg(unix)]
    #[test]
    fn claude_md_is_not_read_through_a_symlink_out_of_the_project() {
        let ws = workspace("claude-md");
        let note = format!("{ws}/proj/CLAUDE.md");
        // A CLAUDE.md that is really a link to a private file elsewhere must not be read, or its
        // contents would be sent to the model.
        fs::write(format!("{ws}/secret.txt"), "top secret").unwrap();
        std::os::unix::fs::symlink(format!("{ws}/secret.txt"), &note).unwrap();
        let result = read_file(ws, "proj".into(), "CLAUDE.md".into());
        assert!(result.is_err(), "the symlink was followed: {result:?}");
    }

    #[test]
    fn keyring_errors_get_a_linux_hint_only_on_linux() {
        let none = keyring::Error::NoDefaultStore;
        let on_linux = keyring_error_text(&none, true);
        assert!(on_linux.contains("Secret Service"), "{on_linux}");
        assert!(!keyring_error_text(&none, false).contains("Secret Service"));
        // An ordinary "wrong value" error is never dressed up as a missing keyring.
        let bad = keyring::Error::Invalid("x".into(), "y".into());
        assert_eq!(keyring_error_text(&bad, true), bad.to_string());
    }

    #[test]
    fn base64_matches_the_standard_test_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn powershell_script_runs_the_command_verbatim_and_keeps_its_exit_code() {
        let script = powershell_script("Write-Output \"hi\" # trailing comment");
        assert!(script.contains("\nWrite-Output \"hi\" # trailing comment\n"), "{script}");
        // The exit-code logic must come after the command, on its own line.
        assert!(script.find("trailing comment").unwrap() < script.find("exit $code").unwrap());
    }

    /// Makes `link` a directory junction to `target` (no special privilege needed, unlike symlinks).
    #[cfg(windows)]
    fn junction(link: &str, target: &str) {
        let status = Command::new("cmd").args(["/C", "mklink", "/J", link, target]).output().unwrap();
        assert!(status.status.success(), "mklink failed: {status:?}");
    }

    #[cfg(windows)]
    #[test]
    fn windows_junction_out_of_the_project_is_not_followed() {
        let ws = workspace("junction");
        fs::create_dir_all(format!("{ws}/other")).unwrap();
        fs::write(format!("{ws}/other/secret.txt"), "top secret").unwrap();
        junction(&format!("{ws}/proj/out"), &format!("{ws}/other"));
        assert!(read_file(ws.clone(), "proj".into(), "out/secret.txt".into()).is_err());
        assert!(write_file(ws.clone(), "proj".into(), "out/new.txt".into(), "x".into()).is_err());
        assert!(!Path::new(&format!("{ws}/other/new.txt")).exists());
    }

    #[cfg(windows)]
    #[test]
    fn windows_project_junction_to_another_workspace_is_refused() {
        let ws = workspace("junction-project");
        let outside = workspace("junction-project-outside");
        junction(&format!("{ws}/linked"), &format!("{outside}/proj"));
        assert!(project_root(&ws, "linked").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_that_look_inside_but_are_not_are_refused() {
        let ws = workspace("win-paths");
        fs::create_dir_all(format!("{ws}/other")).unwrap();
        fs::write(format!("{ws}/other/b.txt"), "secret").unwrap();
        // Backslash traversal, a drive-qualified path, and a rooted path with no drive.
        let canonical = fs::canonicalize(format!("{ws}/other/b.txt")).unwrap();
        let rooted = canonical.to_string_lossy().trim_start_matches(r"\\?\").split_once(':').unwrap().1.to_string();
        for path in [r"..\other\b.txt".to_string(), canonical.to_string_lossy().to_string(), rooted] {
            assert!(read_file(ws.clone(), "proj".into(), path.clone()).is_err(), "{path} was readable");
        }
    }

    #[test]
    fn command_needs_a_real_project() {
        let ws = workspace("cmd-noproject");
        assert!(project_root(&ws, "../etc").is_err());
        assert!(project_root(&ws, "missing").is_err());
    }
}
