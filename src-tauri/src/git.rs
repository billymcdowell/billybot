//! Git, for the app's own buttons: which branch a project is on, what has changed, a branch for
//! a chat, and a commit. The agent does not call this; it has `run_command` for git, with
//! approval. Nothing here ever pushes, pulls, stashes, resets or discards.
//!
//! git is started with an argument list, never through a shell, so a branch name or commit
//! message can't be taken for a command. A repository can name programs for git to run (filters,
//! diff drivers). Since this runs git without asking, a project whose config does that is left
//! alone, and the file tools can't write inside `.git` (see `refuse_git_data` in lib.rs).

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::procgroup::ProcessGroup;
use crate::project_root;

const DIFF_LIMIT: usize = 200_000;
const QUICK: Duration = Duration::from_secs(20);
const COMMIT_TIMEOUT: Duration = Duration::from_secs(120);

struct Output {
    stdout: String,
    stderr: String,
    ok: bool,
    timed_out: bool,
}

/// Runs `git <args>` in `root`. Settings given with -c win over the repository's own config.
fn run_git(root: &Path, args: &[&str], timeout: Duration) -> Result<Output, String> {
    let mut cmd = Command::new("git");
    cmd.args(["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.pager=cat", "-c", "core.quotePath=false"])
        .args(args)
        .current_dir(crate::strip_verbatim(&root.to_string_lossy()))
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_EDITOR", "true")
        .env("GIT_ASKPASS", "true")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    ProcessGroup::configure(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound { "git is not installed".to_string() } else { e.to_string() }
    })?;
    let group = ProcessGroup::attach(&child);
    let read = |mut pipe: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            String::from_utf8_lossy(&buf).to_string()
        })
    };
    let out = read(Box::new(child.stdout.take().ok_or("no output")?));
    let err = read(Box::new(child.stderr.take().ok_or("no output")?));

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
        std::thread::sleep(Duration::from_millis(10));
    };
    group.kill(); // anything git (or a hook) left running
    let _ = child.wait();
    Ok(Output {
        stdout: out.join().unwrap_or_default(),
        stderr: err.join().unwrap_or_default(),
        ok: status.is_some_and(|s| s.success()),
        timed_out,
    })
}

fn failure(out: &Output, what: &str) -> String {
    if out.timed_out {
        return format!("{what} timed out");
    }
    let text = if out.stderr.trim().is_empty() { out.stdout.trim() } else { out.stderr.trim() };
    let tail: String = text.chars().rev().take(600).collect::<Vec<_>>().into_iter().rev().collect();
    format!("{what} failed: {tail}")
}

/// Config keys that make git run another program. Anything git is told on the command line (the
/// -c options above, --no-ext-diff) already beats these, so they are the ones that remain.
const PROGRAM_KEYS: [&str; 8] = ["clean", "smudge", "process", "command", "cmd", "driver", "program", "textconv"];

/// Why git should not be run automatically in this repository, if so.
fn config_risk(root: &Path) -> Option<String> {
    let dot_git = root.join(".git");
    let git_dir = if dot_git.is_dir() {
        dot_git
    } else {
        // a file reading "gitdir: path" (a worktree or submodule)
        let text = std::fs::read_to_string(&dot_git).ok()?;
        let target = text.trim().strip_prefix("gitdir:")?.trim().to_string();
        let path = Path::new(&target);
        if path.is_absolute() { path.to_path_buf() } else { root.join(path) }
    };
    let config = std::fs::read_to_string(git_dir.join("config")).ok()?;
    for line in config.lines() {
        let line = line.trim();
        if line.to_ascii_lowercase().starts_with("[include") {
            return Some("its config includes other config files".into());
        }
        if line.starts_with(['#', ';', '[']) {
            continue;
        }
        let Some((key, _)) = line.split_once('=') else { continue };
        let key = key.trim().to_ascii_lowercase();
        if PROGRAM_KEYS.contains(&key.as_str()) {
            return Some(format!("its config sets \"{key}\", which makes git run another program"));
        }
    }
    None
}

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub has_git: bool,
    pub is_repo: bool,
    pub branch: Option<String>,
    pub detached: bool,
    pub changed: usize,
    pub untracked: usize,
    /// Why billybot isn't running git here, when it isn't
    pub blocked: Option<String>,
}

fn has_git() -> bool {
    Command::new("git").arg("--version").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
}

fn status_in(root: &Path) -> Result<GitInfo, String> {
    let mut info = GitInfo { has_git: has_git(), ..Default::default() };
    // Only a repository that starts at the project's own folder counts. A project inside a
    // bigger repository would show everyone else's changes.
    if !info.has_git || !root.join(".git").exists() {
        return Ok(info);
    }
    info.is_repo = true;
    if let Some(reason) = config_risk(root) {
        info.blocked = Some(format!("billybot isn't running git in this project because {reason}. You can still use git through the agent's commands."));
        return Ok(info);
    }
    let out = run_git(root, &["status", "--porcelain=v2", "--branch"], QUICK)?;
    if !out.ok {
        info.blocked = Some(failure(&out, "git status"));
        return Ok(info);
    }
    let mut oid = String::new();
    for line in out.stdout.lines() {
        if let Some(head) = line.strip_prefix("# branch.head ") {
            if head == "(detached)" { info.detached = true } else { info.branch = Some(head.to_string()) }
        } else if let Some(o) = line.strip_prefix("# branch.oid ") {
            oid = o.to_string();
        } else if line.starts_with(['1', '2', 'u']) && line.as_bytes().get(1) == Some(&b' ') {
            info.changed += 1;
        } else if line.starts_with("? ") {
            info.untracked += 1;
        }
    }
    if info.detached {
        info.branch = Some(oid.chars().take(7).collect());
    }
    Ok(info)
}

#[derive(Serialize, Debug, PartialEq)]
pub struct FileChange {
    pub path: String,
    /// modified, added, deleted, renamed, untracked or conflict
    pub status: String,
}

#[derive(Serialize, Debug, Default)]
pub struct Changes {
    pub files: Vec<FileChange>,
    pub diff: String,
}

fn kind(xy: &str) -> &'static str {
    let (x, y) = (xy.as_bytes()[0], xy.as_bytes()[1]);
    if x == b'U' || y == b'U' || (x == b'A' && y == b'A') || (x == b'D' && y == b'D') {
        "conflict"
    } else if x == b'R' || y == b'R' {
        "renamed"
    } else if x == b'D' || y == b'D' {
        "deleted"
    } else if x == b'A' || y == b'A' {
        "added"
    } else {
        "modified"
    }
}

fn changes_in(root: &Path) -> Result<Changes, String> {
    if let Some(reason) = config_risk(root) {
        return Err(format!("billybot isn't running git in this project because {reason}"));
    }
    let status = run_git(root, &["status", "--porcelain=v2"], QUICK)?;
    if !status.ok {
        return Err(failure(&status, "git status"));
    }
    let mut files = Vec::new();
    for line in status.stdout.lines() {
        let fields: Vec<&str> = line.splitn(if line.starts_with('2') { 10 } else { 9 }, ' ').collect();
        match line.chars().next() {
            Some('1' | 'u') if fields.len() >= 9 => files.push(FileChange { path: fields[8].to_string(), status: kind(fields[1]).to_string() }),
            Some('2') if fields.len() >= 10 => {
                let new = fields[9].split('\t').next().unwrap_or(fields[9]);
                files.push(FileChange { path: new.to_string(), status: "renamed".into() });
            }
            Some('?') => files.push(FileChange { path: line[2..].to_string(), status: "untracked".into() }),
            _ => {}
        }
    }
    // Before the first commit there is no HEAD to compare with, so show what is not yet staged.
    let has_head = run_git(root, &["rev-parse", "--verify", "-q", "HEAD"], QUICK)?.ok;
    let mut args = vec!["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-U3"];
    if has_head {
        args.push("HEAD");
    }
    let diff = run_git(root, &args, QUICK)?;
    if !diff.ok {
        return Err(failure(&diff, "git diff"));
    }
    let mut text = diff.stdout;
    if text.len() > DIFF_LIMIT {
        let mut cut = DIFF_LIMIT;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push_str("\n[... the diff is longer than 200 KB and was cut off here ...]\n");
    }
    Ok(Changes { files, diff: text })
}

/// `billybot/` plus lowercase letters, digits and dashes: nothing git or a shell could read as an option or path trick.
fn valid_branch(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("billybot/") else { return false };
    !rest.is_empty()
        && rest.len() <= 60
        && !rest.starts_with('-')
        && !rest.ends_with('-')
        && rest.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn create_branch_in(root: &Path, name: &str) -> Result<(), String> {
    if !valid_branch(name) {
        return Err("A chat's branch is named billybot/ followed by lowercase letters, digits and dashes".into());
    }
    let info = status_in(root)?;
    if !info.is_repo {
        return Err("This project isn't a git repository".into());
    }
    if let Some(why) = info.blocked {
        return Err(why);
    }
    if info.changed > 0 {
        let files = if info.changed == 1 { "1 file".to_string() } else { format!("{} files", info.changed) };
        return Err(format!(
            "{files} in this project {} uncommitted changes. Commit or stash them yourself first, so the branch holds only the agent's work.",
            if info.changed == 1 { "has" } else { "have" }
        ));
    }
    let out = run_git(root, &["checkout", "-b", name], QUICK)?;
    if out.ok { Ok(()) } else { Err(failure(&out, "Creating the branch")) }
}

/// Stages everything and commits it. Hooks run, as they would if you committed yourself.
fn commit_in(root: &Path, message: &str, timeout: Duration) -> Result<String, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("Write a commit message first".into());
    }
    if message.len() > 5000 {
        return Err("That commit message is too long".into());
    }
    let info = status_in(root)?;
    if !info.is_repo {
        return Err("This project isn't a git repository".into());
    }
    if let Some(why) = info.blocked {
        return Err(why);
    }
    if info.changed + info.untracked == 0 {
        return Err("Nothing to commit".into());
    }
    let add = run_git(root, &["add", "-A"], QUICK)?;
    if !add.ok {
        return Err(failure(&add, "Staging the changes"));
    }
    let commit = run_git(root, &["commit", "-m", message], timeout)?;
    if !commit.ok {
        return Err(failure(&commit, "The commit"));
    }
    let head = run_git(root, &["log", "-1", "--pretty=%h %s"], QUICK)?;
    Ok(head.stdout.trim().to_string())
}

#[tauri::command]
pub async fn git_status(workspace: String, project: String) -> Result<GitInfo, String> {
    let root = project_root(&workspace, &project)?;
    tauri::async_runtime::spawn_blocking(move || status_in(&root)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_changes(workspace: String, project: String) -> Result<Changes, String> {
    let root = project_root(&workspace, &project)?;
    tauri::async_runtime::spawn_blocking(move || changes_in(&root)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_create_branch(workspace: String, project: String, name: String) -> Result<(), String> {
    let root = project_root(&workspace, &project)?;
    tauri::async_runtime::spawn_blocking(move || create_branch_in(&root, &name)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_commit(workspace: String, project: String, message: String) -> Result<String, String> {
    let root = project_root(&workspace, &project)?;
    tauri::async_runtime::spawn_blocking(move || commit_in(&root, &message, COMMIT_TIMEOUT)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("billybot-git-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn git(root: &Path, args: &[&str]) {
        let out = Command::new("git").args(args).current_dir(root).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// A repository with one commit containing a.txt.
    fn repo(name: &str) -> PathBuf {
        let root = dir(name);
        git(&root, &["init", "-q", "-b", "main"]);
        git(&root, &["config", "user.name", "Test"]);
        git(&root, &["config", "user.email", "test@example.com"]);
        git(&root, &["config", "commit.gpgsign", "false"]);
        fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-q", "-m", "first"]);
        root
    }

    fn append_config(root: &Path, text: &str) {
        let path = root.join(".git/config");
        let old = fs::read_to_string(&path).unwrap();
        fs::write(path, format!("{old}\n{text}\n")).unwrap();
    }

    #[test]
    fn a_folder_that_is_not_a_repository_says_so() {
        let root = dir("plain");
        let info = status_in(&root).unwrap();
        assert!(info.has_git && !info.is_repo && info.branch.is_none());
    }

    #[test]
    fn status_reports_the_branch_and_what_has_changed() {
        let root = repo("status");
        let clean = status_in(&root).unwrap();
        assert_eq!((clean.is_repo, clean.branch.as_deref(), clean.changed, clean.untracked), (true, Some("main"), 0, 0));
        fs::write(root.join("a.txt"), "one\nchanged\n").unwrap();
        fs::write(root.join("new.txt"), "x").unwrap();
        fs::write(root.join("new2.txt"), "x").unwrap();
        let dirty = status_in(&root).unwrap();
        assert_eq!((dirty.changed, dirty.untracked), (1, 2));
    }

    #[test]
    fn a_detached_head_shows_the_short_commit_and_a_new_repo_has_a_branch() {
        let root = repo("detached");
        git(&root, &["checkout", "-q", "--detach"]);
        let info = status_in(&root).unwrap();
        assert!(info.detached);
        assert_eq!(info.branch.as_ref().map(|b| b.len()), Some(7));
        let fresh = dir("unborn");
        git(&fresh, &["init", "-q", "-b", "trunk"]);
        let info = status_in(&fresh).unwrap();
        assert_eq!((info.is_repo, info.branch.as_deref()), (true, Some("trunk")));
    }

    #[test]
    fn a_project_inside_a_bigger_repository_is_not_treated_as_one() {
        let outer = repo("outer");
        let inner = outer.join("project");
        fs::create_dir_all(&inner).unwrap();
        assert!(!status_in(&inner).unwrap().is_repo);
    }

    #[test]
    fn changes_lists_files_with_their_state_and_shows_the_diff() {
        let root = repo("changes");
        fs::write(root.join("a.txt"), "one\nchanged\n").unwrap();
        fs::write(root.join("new.txt"), "x").unwrap();
        fs::write(root.join("b.txt"), "b").unwrap();
        git(&root, &["add", "b.txt"]);
        let c = changes_in(&root).unwrap();
        let mut files: Vec<_> = c.files.iter().map(|f| format!("{}:{}", f.path, f.status)).collect();
        files.sort();
        assert_eq!(files, ["a.txt:modified", "b.txt:added", "new.txt:untracked"]);
        assert!(c.diff.contains("-two") && c.diff.contains("+changed"), "{}", c.diff);
        assert!(c.diff.contains("+b"), "staged changes are in the diff too");
        assert!(!c.diff.contains("\x1b["), "no colour codes");
    }

    #[test]
    fn changes_notices_deletes_and_renames_and_copes_with_spaces_in_names() {
        let root = repo("rename");
        git(&root, &["mv", "a.txt", "has space.txt"]);
        fs::write(root.join("other file.txt"), "x").unwrap();
        let c = changes_in(&root).unwrap();
        assert!(c.files.contains(&FileChange { path: "has space.txt".into(), status: "renamed".into() }), "{:?}", c.files);
        assert!(c.files.contains(&FileChange { path: "other file.txt".into(), status: "untracked".into() }));
        fs::remove_file(root.join("has space.txt")).unwrap();
        let c = changes_in(&root).unwrap();
        assert!(c.files.iter().any(|f| f.status == "deleted" || f.status == "renamed"));
    }

    #[test]
    fn a_long_diff_is_cut_with_a_note_and_a_repo_with_no_commits_still_works() {
        let root = repo("long");
        fs::write(root.join("a.txt"), "é".repeat(150_000)).unwrap();
        let c = changes_in(&root).unwrap();
        assert!(c.diff.len() < DIFF_LIMIT + 200);
        assert!(c.diff.ends_with("cut off here ...]\n"));
        let fresh = dir("nocommit");
        git(&fresh, &["init", "-q"]);
        fs::write(fresh.join("f.txt"), "x").unwrap();
        git(&fresh, &["add", "f.txt"]);
        assert_eq!(changes_in(&fresh).unwrap().files.len(), 1);
    }

    #[test]
    fn branch_names_are_tightly_limited() {
        for ok in ["billybot/fix-login", "billybot/a1-b2", "billybot/x"] {
            assert!(valid_branch(ok), "{ok}");
        }
        for bad in ["main", "billybot/", "billybot/-x", "billybot/x-", "billybot/Fix", "billybot/a b", "billybot/a;rm", "billybot/../x", "billybot/a.b", "billybot/a/b", "--billybot/x", "billybot/$(x)", &format!("billybot/{}", "a".repeat(61))] {
            assert!(!valid_branch(bad), "{bad}");
        }
    }

    #[test]
    fn creating_a_branch_works_on_a_clean_tree_and_refuses_otherwise() {
        let root = repo("branch");
        assert!(create_branch_in(&root, "main").is_err());
        assert!(create_branch_in(&root, "billybot/fix").is_ok());
        assert_eq!(status_in(&root).unwrap().branch.as_deref(), Some("billybot/fix"));
        assert!(create_branch_in(&root, "billybot/fix").unwrap_err().contains("failed"), "a branch that exists");
        git(&root, &["checkout", "-q", "main"]);
        fs::write(root.join("a.txt"), "dirty").unwrap();
        let err = create_branch_in(&root, "billybot/other").unwrap_err();
        assert!(err.contains("uncommitted"), "{err}");
        assert_eq!(status_in(&root).unwrap().branch.as_deref(), Some("main"));
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "dirty", "nothing was stashed or discarded");
        // untracked files alone don't block it
        git(&root, &["checkout", "-q", "--", "a.txt"]);
        fs::write(root.join("scratch.txt"), "x").unwrap();
        assert!(create_branch_in(&root, "billybot/other").is_ok());
    }

    #[test]
    fn a_non_repository_cannot_get_a_branch_or_a_commit() {
        let root = dir("nope");
        assert!(create_branch_in(&root, "billybot/x").unwrap_err().contains("isn't a git repository"));
        assert!(commit_in(&root, "m", COMMIT_TIMEOUT).unwrap_err().contains("isn't a git repository"));
    }

    #[test]
    fn commit_stages_everything_including_new_files_and_uses_the_message_as_given() {
        let root = repo("commit");
        fs::write(root.join("a.txt"), "changed").unwrap();
        fs::write(root.join("new.txt"), "new").unwrap();
        let msg = "-n \"quoted\" $(whoami) `x`; --amend\n\nbody line";
        let summary = commit_in(&root, msg, COMMIT_TIMEOUT).unwrap();
        assert!(summary.contains("-n \"quoted\" $(whoami)"), "{summary}");
        let full = Command::new("git").args(["log", "-1", "--pretty=%B"]).current_dir(&root).output().unwrap();
        assert!(String::from_utf8_lossy(&full.stdout).contains("body line"));
        let after = status_in(&root).unwrap();
        assert_eq!((after.changed, after.untracked), (0, 0));
        let count = Command::new("git").args(["rev-list", "--count", "HEAD"]).current_dir(&root).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&count.stdout).trim(), "2", "a new commit, nothing amended");
    }

    #[test]
    fn commit_refuses_an_empty_message_a_clean_tree_and_a_huge_message() {
        let root = repo("commit-refuse");
        assert!(commit_in(&root, "   ", COMMIT_TIMEOUT).unwrap_err().contains("message"));
        assert_eq!(commit_in(&root, "m", COMMIT_TIMEOUT).unwrap_err(), "Nothing to commit");
        fs::write(root.join("a.txt"), "x").unwrap();
        assert!(commit_in(&root, &"m".repeat(5001), COMMIT_TIMEOUT).unwrap_err().contains("too long"));
    }

    #[cfg(unix)]
    #[test]
    fn a_failing_hook_is_reported_and_a_slow_one_is_stopped() {
        use std::os::unix::fs::PermissionsExt;
        let root = repo("hooks");
        let hook = root.join(".git/hooks/pre-commit");
        fs::write(&hook, "#!/bin/sh\necho 'lint failed: bad thing' >&2\nexit 1\n").unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(root.join("a.txt"), "x").unwrap();
        let err = commit_in(&root, "m", COMMIT_TIMEOUT).unwrap_err();
        assert!(err.contains("lint failed: bad thing"), "{err}");

        fs::write(&hook, "#!/bin/sh\nsleep 10\n").unwrap();
        let started = Instant::now();
        let err = commit_in(&root, "m", Duration::from_millis(500)).unwrap_err();
        assert!(err.contains("timed out"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_repository_that_names_programs_to_run_is_left_alone() {
        for (name, config) in [
            ("clean", "[filter \"x\"]\n\tclean = ./evil.sh"),
            ("smudge", "[filter \"x\"]\n\tsmudge = ./evil.sh"),
            ("process", "[filter \"x\"]\n\tprocess = ./evil.sh"),
            ("driver", "[merge \"x\"]\n\tdriver = ./evil.sh"),
            ("textconv", "[diff \"x\"]\n\ttextconv = ./evil.sh"),
            ("program", "[gpg]\n\tprogram = ./evil.sh"),
            ("command", "[diff \"x\"]\n\tcommand = ./evil.sh"),
            ("include", "[include]\n\tpath = ../elsewhere"),
            ("includeif", "[includeIf \"gitdir:~/\"]\n\tpath = ../elsewhere"),
        ] {
            let root = repo(&format!("risky-{name}"));
            append_config(&root, config);
            let info = status_in(&root).unwrap();
            assert!(info.is_repo && info.blocked.is_some(), "{name}: {info:?}");
            assert_eq!((info.branch, info.changed), (None, 0), "git was not run");
            assert!(changes_in(&root).is_err(), "{name}");
            assert!(create_branch_in(&root, "billybot/x").is_err(), "{name}");
            fs::write(root.join("a.txt"), "x").unwrap();
            assert!(commit_in(&root, "m", COMMIT_TIMEOUT).is_err(), "{name}");
        }
    }

    #[test]
    fn ordinary_local_config_is_fine() {
        let root = repo("benign");
        append_config(&root, "[remote \"origin\"]\n\turl = https://example.com/x.git\n[branch \"main\"]\n\tremote = origin\n[core]\n\tfsmonitor = true\n\teditor = vim");
        let info = status_in(&root).unwrap();
        assert!(info.blocked.is_none(), "{info:?}");
        assert_eq!(info.branch.as_deref(), Some("main"));
    }

    #[cfg(unix)]
    #[test]
    fn a_program_named_as_fsmonitor_is_never_run() {
        use std::os::unix::fs::PermissionsExt;
        let root = repo("fsmonitor");
        let marker = root.join("RAN");
        let script = root.join("evil.sh");
        fs::write(&script, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        append_config(&root, &format!("[core]\n\tfsmonitor = {}", script.display()));
        fs::write(root.join("a.txt"), "x").unwrap();
        status_in(&root).unwrap();
        changes_in(&root).unwrap();
        assert!(!marker.exists(), "git ran the fsmonitor program from the repository's config");
    }

    #[test]
    fn a_gitfile_pointing_at_a_worktree_is_understood() {
        let root = repo("gitfile-main");
        let wt = dir("gitfile-wt");
        let _ = fs::remove_dir_all(&wt);
        git(&root, &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "other"]);
        let info = status_in(&wt).unwrap();
        assert_eq!((info.is_repo, info.branch.as_deref()), (true, Some("other")));
    }

    #[test]
    fn errors_name_what_failed_and_keep_the_end_of_long_output() {
        let out = Output { stdout: String::new(), stderr: format!("{}the real problem", "x".repeat(2000)), ok: false, timed_out: false };
        let text = failure(&out, "The commit");
        assert!(text.starts_with("The commit failed: ") && text.ends_with("the real problem") && text.len() < 700);
        assert_eq!(failure(&Output { timed_out: true, ..out }, "git status"), "git status timed out");
    }
}
