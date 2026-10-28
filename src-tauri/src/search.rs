//! The `grep` and `glob` tools: finding things inside one project without a shell.
//!
//! Both walk the project the way ripgrep does: `.gitignore` files are honoured (even outside a
//! git repository), `.git` and `node_modules` are always skipped, and links are never followed,
//! so a symlink can't lead the search outside the project. Every start path goes through the
//! same `resolve` lock as the file tools.

use std::cmp::Reverse;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use ignore::{WalkBuilder, overrides::OverrideBuilder};
use regex::RegexBuilder;

use crate::{project_root, resolve};

const MAX_FILES_WALKED: usize = 200_000;
const MAX_SEARCH_FILE_BYTES: u64 = 5_000_000;
const MAX_LINE_CHARS: usize = 300;
const MAX_CONTEXT: usize = 5;
const DEFAULT_MAX_MATCHES: usize = 200;
const ABSOLUTE_MAX_MATCHES: usize = 1000;
const DEFAULT_MAX_FILES: usize = 500;
const SKIPPED_DIRS: [&str; 2] = [".git", "node_modules"];

/// Every file under `start` (sorted), optionally only those matching a gitignore-style `glob`
/// such as `*.ts` or `src/**/*.rs`. The flag says the walk stopped at a safety limit.
fn walk_files(start: &Path, glob: Option<&str>) -> Result<(Vec<PathBuf>, bool), String> {
    if start.is_file() {
        return Ok((vec![start.to_path_buf()], false));
    }
    let mut builder = WalkBuilder::new(start);
    builder
        .hidden(false)
        .parents(false)
        .git_global(false)
        .git_exclude(false)
        .require_git(false)
        .follow_links(false)
        .sort_by_file_path(|a, b| a.cmp(b))
        .filter_entry(|e| {
            let is_dir = e.file_type().is_some_and(|t| t.is_dir());
            !(e.depth() > 0 && is_dir && SKIPPED_DIRS.iter().any(|d| e.file_name() == *d))
        });
    if let Some(glob) = glob.filter(|g| !g.trim().is_empty()) {
        let mut overrides = OverrideBuilder::new(start);
        overrides.add(glob).map_err(|e| format!("Invalid glob \"{glob}\": {e}"))?;
        builder.overrides(overrides.build().map_err(|e| format!("Invalid glob \"{glob}\": {e}"))?);
    }
    let mut files = Vec::new();
    for entry in builder.build() {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        if files.len() >= MAX_FILES_WALKED {
            return Ok((files, true));
        }
        files.push(entry.into_path());
    }
    Ok((files, false))
}

/// "proj/src/a.ts": the form the file tools take, so results can be passed straight to them.
fn display(root: &Path, project: &str, file: &Path) -> String {
    let rel = file.strip_prefix(root).unwrap_or(file);
    let rel: Vec<_> = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect();
    format!("{project}/{}", rel.join("/"))
}

fn clip(line: &str) -> String {
    match line.char_indices().nth(MAX_LINE_CHARS) {
        Some((i, _)) => format!("{}…", &line[..i]),
        None => line.to_string(),
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Output {
    Content,
    Files,
    Count,
}

pub struct GrepOptions {
    pub pattern: String,
    pub glob: Option<String>,
    pub case_insensitive: bool,
    pub context: usize,
    pub output: Option<String>,
    pub max_results: Option<usize>,
}

fn grep_in(root: &Path, project: &str, start: &Path, o: &GrepOptions) -> Result<String, String> {
    let re = RegexBuilder::new(&o.pattern)
        .case_insensitive(o.case_insensitive)
        .size_limit(10_000_000)
        .build()
        .map_err(|e| format!("Invalid pattern: {e}"))?;
    let mode = match o.output.as_deref() {
        None | Some("content") => Output::Content,
        Some("files") => Output::Files,
        Some("count") => Output::Count,
        Some(other) => return Err(format!("output must be \"content\", \"files\" or \"count\", not \"{other}\"")),
    };
    let max = o.max_results.unwrap_or(DEFAULT_MAX_MATCHES).clamp(1, ABSOLUTE_MAX_MATCHES);
    let context = o.context.min(MAX_CONTEXT);
    let (files, walk_cut) = walk_files(start, o.glob.as_deref())?;

    let mut out: Vec<String> = Vec::new();
    let mut shown = 0; // matching lines (content), or files (files, count)
    let mut truncated = false;
    for file in files {
        if shown >= max {
            truncated = true;
            break;
        }
        if fs::metadata(&file).map_or(true, |m| m.len() > MAX_SEARCH_FILE_BYTES) {
            continue;
        }
        let Ok(bytes) = fs::read(&file) else { continue };
        if bytes.iter().take(8192).any(|&b| b == 0) {
            continue; // binary
        }
        let text = String::from_utf8_lossy(&bytes);
        let lines: Vec<&str> = text.lines().collect();
        let hits: Vec<usize> = (0..lines.len()).filter(|&i| re.is_match(lines[i])).collect();
        if hits.is_empty() {
            continue;
        }
        let name = display(root, project, &file);
        match mode {
            Output::Files => {
                out.push(name);
                shown += 1;
            }
            Output::Count => {
                out.push(format!("{name}:{}", hits.len()));
                shown += 1;
            }
            Output::Content => {
                let room = max - shown;
                if hits.len() > room {
                    truncated = true;
                }
                let take = hits.len().min(room);
                shown += take;
                let mut last_printed: Option<usize> = None;
                for &h in &hits[..take] {
                    let mut from = h.saturating_sub(context);
                    if let Some(lp) = last_printed {
                        from = from.max(lp + 1);
                        if context > 0 && from > lp + 1 {
                            out.push("--".to_string());
                        }
                    }
                    let to = (h + context).min(lines.len() - 1);
                    for (i, line) in lines.iter().enumerate().take(to + 1).skip(from) {
                        let sep = if hits.binary_search(&i).is_ok() { ':' } else { '-' };
                        out.push(format!("{name}{sep}{}{sep} {}", i + 1, clip(line)));
                        last_printed = Some(i);
                    }
                }
            }
        }
    }

    if out.is_empty() {
        return Ok("No matches.".to_string());
    }
    if truncated {
        out.push(format!("[Stopped at {max} results. Use a narrower pattern, path or glob to see the rest.]"));
    }
    if walk_cut {
        out.push(format!("[Only the first {MAX_FILES_WALKED} files were searched. Use a narrower path.]"));
    }
    Ok(out.join("\n"))
}

fn glob_in(root: &Path, project: &str, start: &Path, pattern: &str, max: usize) -> Result<String, String> {
    if pattern.trim().is_empty() {
        return Err("pattern must not be empty".into());
    }
    let (files, walk_cut) = walk_files(start, Some(pattern))?;
    let mut found: Vec<(SystemTime, PathBuf)> = files
        .into_iter()
        .map(|f| (fs::metadata(&f).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH), f))
        .collect();
    if found.is_empty() {
        return Ok("No files matched.".to_string());
    }
    // Newest first: what the user was working on lately is usually what matters.
    found.sort_by(|a, b| (Reverse(a.0), &a.1).cmp(&(Reverse(b.0), &b.1)));
    let total = found.len();
    let mut out: Vec<String> = found.iter().take(max).map(|(_, f)| display(root, project, f)).collect();
    if total > max {
        out.push(format!("[{total} files matched; showing the {max} most recently changed. Use a narrower pattern.]"));
    }
    if walk_cut {
        out.push(format!("[Only the first {MAX_FILES_WALKED} files were searched. Use a narrower path.]"));
    }
    Ok(out.join("\n"))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn grep_files(
    workspace: String,
    project: String,
    path: String,
    pattern: String,
    glob: Option<String>,
    case_insensitive: Option<bool>,
    context: Option<usize>,
    output: Option<String>,
    max_results: Option<usize>,
) -> Result<String, String> {
    let root = project_root(&workspace, &project)?;
    let start = resolve(&root, &path)?;
    let options = GrepOptions {
        pattern,
        glob,
        case_insensitive: case_insensitive.unwrap_or(false),
        context: context.unwrap_or(0),
        output,
        max_results,
    };
    grep_in(&root, &project, &start, &options)
}

#[tauri::command]
pub fn glob_files(
    workspace: String,
    project: String,
    path: String,
    pattern: String,
    max_results: Option<usize>,
) -> Result<String, String> {
    let root = project_root(&workspace, &project)?;
    let start = resolve(&root, &path)?;
    glob_in(&root, &project, &start, &pattern, max_results.unwrap_or(DEFAULT_MAX_FILES).clamp(1, DEFAULT_MAX_FILES))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh workspace containing a project "proj" laid out like a small web app.
    fn workspace(name: &str) -> (String, PathBuf) {
        let ws = std::env::temp_dir().join(format!("billybot-search-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&ws);
        let proj = ws.join("proj");
        fs::create_dir_all(proj.join("src/deep")).unwrap();
        fs::create_dir_all(proj.join("node_modules/pkg")).unwrap();
        fs::create_dir_all(proj.join(".git")).unwrap();
        fs::create_dir_all(proj.join("dist")).unwrap();
        fs::write(proj.join("src/a.ts"), "const alpha = 1;\nconst beta = 2;\nexport { alpha };\n").unwrap();
        fs::write(proj.join("src/deep/b.ts"), "// alpha again\n").unwrap();
        fs::write(proj.join("src/c.md"), "Alpha in docs\n").unwrap();
        fs::write(proj.join("node_modules/pkg/index.js"), "alpha\n").unwrap();
        fs::write(proj.join(".git/config"), "alpha\n").unwrap();
        fs::write(proj.join("dist/out.js"), "alpha\n").unwrap();
        fs::write(proj.join(".gitignore"), "dist/\n").unwrap();
        fs::write(proj.join("blob.bin"), b"alpha\0\0\0").unwrap();
        (ws.to_string_lossy().to_string(), proj)
    }

    fn grep(ws: &str, pattern: &str, tweak: impl FnOnce(&mut GrepOptions)) -> Result<String, String> {
        let mut o = GrepOptions { pattern: pattern.into(), glob: None, case_insensitive: false, context: 0, output: None, max_results: None };
        tweak(&mut o);
        let root = project_root(ws, "proj")?;
        grep_in(&root, "proj", &root, &o)
    }

    fn glob(ws: &str, pattern: &str, max: usize) -> Result<String, String> {
        let root = project_root(ws, "proj")?;
        glob_in(&root, "proj", &root, pattern, max)
    }

    #[test]
    fn grep_finds_lines_with_project_relative_paths() {
        let (ws, _) = workspace("lines");
        let out = grep(&ws, "alpha", |_| {}).unwrap();
        assert_eq!(out, "proj/src/a.ts:1: const alpha = 1;\nproj/src/a.ts:3: export { alpha };\nproj/src/deep/b.ts:1: // alpha again");
    }

    #[test]
    fn grep_skips_ignored_hidden_git_node_modules_and_binary_files() {
        let (ws, _) = workspace("skips");
        let out = grep(&ws, "alpha", |o| o.output = Some("files".into())).unwrap();
        assert!(!out.contains("node_modules") && !out.contains(".git/") && !out.contains("dist") && !out.contains("blob.bin"), "{out}");
        assert!(out.contains("proj/src/a.ts"));
    }

    #[test]
    fn grep_can_be_case_insensitive_and_limited_by_glob() {
        let (ws, _) = workspace("glob");
        assert!(!grep(&ws, "alpha", |_| {}).unwrap().contains("c.md"));
        let out = grep(&ws, "alpha", |o| {
            o.case_insensitive = true;
            o.glob = Some("*.md".into());
        })
        .unwrap();
        assert_eq!(out, "proj/src/c.md:1: Alpha in docs");
    }

    #[test]
    fn grep_counts_and_shows_context() {
        let (ws, _) = workspace("ctx");
        assert_eq!(
            grep(&ws, "alpha", |o| o.output = Some("count".into())).unwrap(),
            "proj/src/a.ts:2\nproj/src/deep/b.ts:1"
        );
        let out = grep(&ws, "beta", |o| o.context = 1).unwrap();
        assert_eq!(out, "proj/src/a.ts-1- const alpha = 1;\nproj/src/a.ts:2: const beta = 2;\nproj/src/a.ts-3- export { alpha };");
    }

    #[test]
    fn grep_separates_distant_context_groups() {
        let (ws, proj) = workspace("groups");
        fs::write(proj.join("long.txt"), "hit\n1\n2\n3\n4\n5\nhit\n").unwrap();
        let out = grep(&ws, "hit", |o| {
            o.context = 1;
            o.glob = Some("long.txt".into());
        })
        .unwrap();
        assert_eq!(out, "proj/long.txt:1: hit\nproj/long.txt-2- 1\n--\nproj/long.txt-6- 5\nproj/long.txt:7: hit");
    }

    #[test]
    fn grep_stops_at_the_result_limit_and_says_so() {
        let (ws, _) = workspace("limit");
        let out = grep(&ws, "alpha", |o| o.max_results = Some(2)).unwrap();
        assert_eq!(out.lines().filter(|l| l.contains(": ")).count(), 2);
        assert!(out.contains("Stopped at 2 results"));
    }

    #[test]
    fn grep_clips_very_long_lines() {
        let (ws, proj) = workspace("clip");
        fs::write(proj.join("min.js"), format!("{}needle\n", "x".repeat(1000))).unwrap();
        let out = grep(&ws, "x{10}", |o| o.glob = Some("min.js".into())).unwrap();
        assert!(out.chars().count() < 400 && out.ends_with('…'), "{out}");
    }

    #[test]
    fn grep_reports_no_matches_and_bad_input() {
        let (ws, _) = workspace("bad");
        assert_eq!(grep(&ws, "zzzz", |_| {}).unwrap(), "No matches.");
        assert!(grep(&ws, "(", |_| {}).unwrap_err().starts_with("Invalid pattern"));
        assert!(grep(&ws, "a", |o| o.output = Some("lines".into())).is_err());
        assert!(grep(&ws, "a", |o| o.glob = Some("[".into())).unwrap_err().starts_with("Invalid glob"));
    }

    #[test]
    fn grep_searches_a_single_file_or_subfolder() {
        let (ws, _) = workspace("start");
        let root = project_root(&ws, "proj").unwrap();
        let o = GrepOptions { pattern: "alpha".into(), glob: None, case_insensitive: false, context: 0, output: None, max_results: None };
        let sub = resolve(&root, "src/deep").unwrap();
        assert_eq!(grep_in(&root, "proj", &sub, &o).unwrap(), "proj/src/deep/b.ts:1: // alpha again");
        let file = resolve(&root, "src/a.ts").unwrap();
        assert!(grep_in(&root, "proj", &file, &o).unwrap().starts_with("proj/src/a.ts:1:"));
    }

    #[test]
    fn grep_command_refuses_paths_outside_the_project() {
        let (ws, _) = workspace("outside");
        let run = |path: &str| grep_files(ws.clone(), "proj".into(), path.into(), "a".into(), None, None, None, None, None);
        assert!(run("..").unwrap_err().contains("outside the project"));
        assert!(run("/etc").unwrap_err().contains("outside the project"));
    }

    #[cfg(unix)]
    #[test]
    fn grep_does_not_follow_links_out_of_the_project() {
        let (ws, proj) = workspace("links");
        let outside = std::env::temp_dir().join(format!("billybot-search-secret-{}", std::process::id()));
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "alpha secret\n").unwrap();
        std::os::unix::fs::symlink(&outside, proj.join("linked-dir")).unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), proj.join("linked-file.txt")).unwrap();
        let out = grep(&ws, "secret", |_| {}).unwrap();
        assert_eq!(out, "No matches.");
        assert!(!glob(&ws, "*.txt", 10).unwrap().contains("linked"));
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn glob_matches_at_any_depth_and_skips_junk() {
        let (ws, _) = workspace("glob-any");
        let out = glob(&ws, "*.ts", 10).unwrap();
        let mut names: Vec<_> = out.lines().collect();
        names.sort();
        assert_eq!(names, ["proj/src/a.ts", "proj/src/deep/b.ts"]);
        assert!(!glob(&ws, "*.js", 10).unwrap().contains("node_modules"));
        assert_eq!(glob(&ws, "*.js", 10).unwrap(), "No files matched.");
    }

    #[test]
    fn glob_can_anchor_to_a_folder() {
        let (ws, _) = workspace("glob-dir");
        assert_eq!(glob(&ws, "src/deep/**", 10).unwrap(), "proj/src/deep/b.ts");
    }

    #[test]
    fn glob_lists_the_most_recently_changed_first_and_caps() {
        let (ws, proj) = workspace("glob-new");
        let old = fs::File::options().write(true).open(proj.join("src/a.ts")).unwrap();
        old.set_modified(SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1000)).unwrap();
        let out = glob(&ws, "*.ts", 10).unwrap();
        assert_eq!(out.lines().last(), Some("proj/src/a.ts"));
        let capped = glob(&ws, "*.ts", 1).unwrap();
        assert!(capped.contains("2 files matched; showing the 1 most recently changed"), "{capped}");
        assert!(glob(&ws, "  ", 10).is_err());
    }
}
