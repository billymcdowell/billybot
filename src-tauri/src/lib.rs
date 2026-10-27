mod stt;

use std::fs;
use std::path::{Path, PathBuf};
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, UNIX_EPOCH};

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

const SHELL: &str = "/bin/zsh";
const DEFAULT_TIMEOUT_SECS: u64 = 60;
const MAX_TIMEOUT_SECS: u64 = 300;
const READ_LIMIT: usize = 1_000_000; // bytes kept while a command runs; the rest is thrown away
const HEAD_CHARS: usize = 10_000;
const TAIL_CHARS: usize = 20_000;

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

/// Runs a command with the project as its starting folder and returns its exit code and
/// combined output. Nothing is typed into it, and after it finishes (or times out) anything
/// it left running is killed.
fn run_shell(root: &Path, command: &str, timeout: Duration) -> Result<String, String> {
    // One pipe for both stdout and stderr, so the output keeps its real order.
    let (mut reader, writer) = std::io::pipe().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(SHELL);
    cmd.args(["-l", "-c", command])
        .current_dir(root)
        .env("NO_COLOR", "1")
        .env("TERM", "dumb")
        .stdin(Stdio::null())
        .stdout(writer.try_clone().map_err(|e| e.to_string())?)
        .stderr(writer)
        .process_group(0); // its own group, so we can stop everything it starts
    let mut child = cmd.spawn().map_err(|e| format!("Couldn't start the shell: {e}"))?;
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

    let pid = child.id() as i32;
    let start = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(e) => return Err(e.to_string()),
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
    unsafe {
        libc::killpg(pid, libc::SIGKILL);
    }
    let _ = child.wait();
    let (bytes, capped) = collector.join().map_err(|_| "Couldn't read the command's output")?;

    let header = if timed_out {
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
    // Commands take a while, so run off the main thread.
    tauri::async_runtime::spawn_blocking(move || run_shell(&root, &command, Duration::from_secs(secs)))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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

    fn run(ws: &str, command: &str, secs: u64) -> String {
        let root = project_root(ws, "proj").unwrap();
        run_shell(&root, command, Duration::from_secs(secs)).unwrap()
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
        let out = run(&ws, "echo oops 1>&2; exit 3", 10);
        assert!(out.starts_with("Exit code 3"), "{out}");
        assert!(out.contains("oops"));
    }

    #[test]
    fn command_starts_in_the_project_folder() {
        let ws = workspace("cmd-cwd");
        let expected = project_root(&ws, "proj").unwrap();
        let out = run(&ws, "pwd", 10);
        assert!(out.contains(expected.to_str().unwrap()), "{out}");
    }

    #[test]
    fn command_times_out_and_is_killed() {
        let ws = workspace("cmd-timeout");
        let start = Instant::now();
        let out = run(&ws, "sleep 30", 1);
        assert!(out.starts_with("Timed out after 1s"), "{out}");
        assert!(start.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn command_cannot_leave_a_background_job_running() {
        let ws = workspace("cmd-bg");
        let start = Instant::now();
        let out = run(&ws, "sleep 30 & echo started", 10);
        assert!(out.contains("started"), "{out}");
        // Without the group kill we would sit here until the background sleep ended.
        assert!(start.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn command_gets_no_input() {
        let ws = workspace("cmd-stdin");
        let start = Instant::now();
        let out = run(&ws, "cat", 10); // would wait forever for input if stdin were open
        assert!(out.starts_with("Exit code 0"), "{out}");
        assert!(start.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn command_output_is_shortened() {
        let ws = workspace("cmd-long");
        let out = run(&ws, "head -c 100000 /dev/zero | tr '\\0' a", 20);
        assert!(out.contains("characters omitted"), "{}", &out[..80.min(out.len())]);
        assert!(out.len() < 35_000);
    }

    #[test]
    fn command_needs_a_real_project() {
        let ws = workspace("cmd-noproject");
        assert!(project_root(&ws, "../etc").is_err());
        assert!(project_root(&ws, "missing").is_err());
    }
}
