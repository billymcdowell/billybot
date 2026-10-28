//! The audit log: every tool call, approval and request the agent makes, one JSON object per
//! line, in a file per month under the app's data folder:
//!
//!   <app data>/audit/2026-10.jsonl
//!
//! The frontend builds the lines (already redacted and clipped). This side appends them and
//! reads one chat's lines back for the activity panel. It never deletes anything.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::Manager;

const MAX_LINES_PER_CALL: usize = 5000;
const MAX_LINE_BYTES: usize = 50_000;
const MAX_FILE_BYTES: u64 = 200_000_000; // a month this big is skipped when reading, not loaded

/// Year and month (1-12) of a Unix time in UTC. (Howard Hinnant's "civil from days".)
fn year_month(secs: u64) -> (i64, u32) {
    let z = (secs / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    (year, month)
}

fn file_name(secs: u64) -> String {
    let (y, m) = year_month(secs);
    format!("{y:04}-{m:02}.jsonl")
}

fn dir(base: &Path) -> PathBuf {
    base.join("audit")
}

fn append(base: &Path, now_secs: u64, lines: &[String]) -> Result<(), String> {
    if lines.len() > MAX_LINES_PER_CALL {
        return Err("Too many log lines at once".into());
    }
    let mut data = String::new();
    for line in lines {
        if line.len() > MAX_LINE_BYTES {
            return Err("A log line is too long".into());
        }
        if !line.starts_with('{') || line.contains('\n') || line.contains('\r') {
            return Err("Log lines must each be one JSON object".into());
        }
        data.push_str(line);
        data.push('\n');
    }
    if data.is_empty() {
        return Ok(());
    }
    let dir = dir(base);
    fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create the audit folder: {e}"))?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(file_name(now_secs)))
        .map_err(|e| e.to_string())?;
    // One write call, so lines from two saves can't be interleaved mid-line.
    file.write_all(data.as_bytes()).map_err(|e| e.to_string())
}

/// The newest `limit` lines for one chat, oldest first, looking back through the months.
fn read_chat(base: &Path, chat_id: &str, limit: usize) -> Result<Vec<String>, String> {
    if !crate::chats::is_valid_name(chat_id) {
        return Err("Invalid chat id".into());
    }
    let needle = format!("\"chatId\":\"{chat_id}\"");
    let mut files: Vec<PathBuf> = match fs::read_dir(dir(base)) {
        Ok(entries) => entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.len() == 13 && n.ends_with(".jsonl") && n[..4].bytes().all(|b| b.is_ascii_digit()))
            })
            .collect(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    files.sort();
    files.reverse(); // newest month first

    let mut found: Vec<String> = Vec::new(); // newest first while collecting
    for file in files {
        if found.len() >= limit {
            break;
        }
        if fs::metadata(&file).map_or(true, |m| m.len() > MAX_FILE_BYTES) {
            continue;
        }
        let Ok(text) = fs::read_to_string(&file) else { continue };
        for line in text.lines().rev().filter(|l| l.contains(&needle)) {
            found.push(line.to_string());
            if found.len() >= limit {
                break;
            }
        }
    }
    found.reverse();
    Ok(found)
}

fn base(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

#[tauri::command]
pub fn audit_append(app: tauri::AppHandle, lines: Vec<String>) -> Result<(), String> {
    append(&base(&app)?, now(), &lines)
}

#[tauri::command]
pub fn audit_read(app: tauri::AppHandle, chat_id: String, limit: usize) -> Result<Vec<String>, String> {
    read_chat(&base(&app)?, &chat_id, limit.clamp(1, 5000))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("billybot-audit-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn line(chat: &str, n: u32) -> String {
        format!("{{\"id\":\"e{n}\",\"chatId\":\"{chat}\",\"summary\":\"event {n}\"}}")
    }

    #[test]
    fn months_come_out_right_including_leap_days_and_year_ends() {
        assert_eq!(year_month(0), (1970, 1));
        assert_eq!(year_month(1_709_164_800), (2024, 2)); // 2024-02-29
        assert_eq!(year_month(1_709_251_200), (2024, 3)); // 2024-03-01
        assert_eq!(year_month(1_700_000_000), (2023, 11));
        assert_eq!(year_month(1_767_225_599), (2025, 12)); // 2025-12-31 23:59:59
        assert_eq!(year_month(1_767_225_600), (2026, 1));
        assert_eq!(file_name(1_793_000_000), "2026-10.jsonl");
    }

    #[test]
    fn lines_are_appended_to_the_months_file() {
        let base = temp("append");
        append(&base, 1_793_000_000, &[line("a", 1), line("a", 2)]).unwrap();
        append(&base, 1_793_000_100, &[line("a", 3)]).unwrap();
        let text = fs::read_to_string(base.join("audit/2026-10.jsonl")).unwrap();
        assert_eq!(text.lines().count(), 3);
        assert!(text.ends_with("event 3\"}\n"));
    }

    #[test]
    fn only_single_line_json_objects_are_accepted() {
        let base = temp("reject");
        assert!(append(&base, 0, &["not json".into()]).is_err());
        assert!(append(&base, 0, &["{\"a\":1}\n{\"b\":2}".into()]).is_err());
        assert!(append(&base, 0, &["{\"a\":\"x\r\"}".into()]).is_err());
        assert!(append(&base, 0, &["{\"a\":\"".to_string() + &"x".repeat(MAX_LINE_BYTES) + "\"}"]).is_err());
        assert!(append(&base, 0, &vec![line("a", 1); MAX_LINES_PER_CALL + 1]).is_err());
        assert!(!base.join("audit").exists(), "nothing is written when a call is refused");
        assert!(append(&base, 0, &[]).is_ok());
    }

    #[test]
    fn a_chats_lines_come_back_oldest_first_and_only_its_own() {
        let base = temp("read");
        append(&base, 1_793_000_000, &[line("a", 1), line("b", 2), line("a", 3)]).unwrap();
        assert_eq!(read_chat(&base, "a", 10).unwrap(), [line("a", 1), line("a", 3)]);
        assert_eq!(read_chat(&base, "b", 10).unwrap(), [line("b", 2)]);
        assert!(read_chat(&base, "nobody", 10).unwrap().is_empty());
    }

    #[test]
    fn the_limit_keeps_the_newest_lines_across_months() {
        let base = temp("months");
        append(&base, 1_790_000_000, &[line("a", 1), line("a", 2)]).unwrap(); // 2026-09
        append(&base, 1_793_000_000, &[line("a", 3), line("a", 4)]).unwrap(); // 2026-10
        assert_eq!(read_chat(&base, "a", 3).unwrap(), [line("a", 2), line("a", 3), line("a", 4)]);
        assert_eq!(read_chat(&base, "a", 1).unwrap(), [line("a", 4)]);
        assert_eq!(read_chat(&base, "a", 99).unwrap().len(), 4);
    }

    #[test]
    fn reading_is_safe_with_no_log_stray_files_and_bad_ids() {
        let base = temp("safe");
        assert!(read_chat(&base, "a", 5).unwrap().is_empty());
        fs::create_dir_all(base.join("audit")).unwrap();
        fs::write(base.join("audit/notes.txt"), line("a", 1)).unwrap();
        assert!(read_chat(&base, "a", 5).unwrap().is_empty());
        assert!(read_chat(&base, "../a", 5).is_err());
        assert!(read_chat(&base, "a\",\"x", 5).is_err());
    }
}
