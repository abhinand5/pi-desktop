//! Usage aggregation over the harness's own session files.
//!
//! Everything here is derived from JSONL already on disk — the desktop keeps no
//! telemetry of its own and writes nothing. That also means the numbers cover
//! whatever the agent did, whether it was driven from this app or its TUI.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use serde::Serialize;

use crate::error::Result;
use crate::harness::Harness;
use crate::sessions::{read_capped, split_lines};

const FILE_CAP: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub total: u64,
}

impl Tokens {
    fn add(&mut self, other: &Tokens) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_write += other.cache_write;
        self.total += other.total;
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model: String,
    pub messages: u64,
    pub tokens: Tokens,
    pub cost: f64,
}

/// One calendar day, for the activity grid.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DayUsage {
    /// `YYYY-MM-DD`, in the timestamps' own (UTC) frame.
    pub date: String,
    pub sessions: u64,
    pub messages: u64,
    pub tokens: u64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub sessions: u64,
    pub messages: u64,
    pub user_messages: u64,
    pub assistant_messages: u64,
    pub tool_calls: u64,
    pub tokens: Tokens,
    pub cost: f64,
    /// Days with at least one message.
    pub active_days: u64,
    pub current_streak: u64,
    pub longest_streak: u64,
    /// Hour of day, 0–23, with the most assistant messages.
    pub peak_hour: Option<u32>,
    pub favorite_model: Option<String>,
    pub by_model: Vec<ModelUsage>,
    pub by_day: Vec<DayUsage>,
    pub first_day: Option<String>,
    pub last_day: Option<String>,
}

/// Scans every session file for a harness. `since_days` limits the window;
/// `None` covers everything on disk.
pub fn report(harness: &dyn Harness, since_days: Option<u32>) -> Result<UsageReport> {
    let root = harness.sessions_root();
    let mut files = Vec::new();
    collect_files(&root, &mut files);

    let mut out = UsageReport::default();
    let mut by_model: HashMap<String, ModelUsage> = HashMap::new();
    let mut by_day: BTreeMap<String, DayUsage> = BTreeMap::new();
    let mut hours = [0u64; 24];

    // The window is applied to entry dates, not file names: a long-running
    // session started before the cutoff still has recent turns in it.
    let cutoff = since_days.and_then(cutoff_date);

    for file in files {
        let Ok(bytes) = read_capped(&file, FILE_CAP) else { continue };
        let mut counted_session = false;
        let mut current_model: Option<String> = None;

        for line in split_lines(&bytes) {
            let Ok(v) = serde_json::from_slice::<serde_json::Value>(line) else { continue };
            match v.get("type").and_then(|t| t.as_str()) {
                Some("model_change") => {
                    current_model = normalize_model(&v);
                }
                Some("message") => {
                    let Some(msg) = v.get("message") else { continue };
                    let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("");
                    let ts = v.get("timestamp").and_then(|t| t.as_str()).unwrap_or("");
                    let day = ts.get(..10).unwrap_or("");
                    if day.is_empty() {
                        continue;
                    }
                    if let Some(cutoff) = &cutoff {
                        if day < cutoff.as_str() {
                            continue;
                        }
                    }

                    if !counted_session {
                        counted_session = true;
                        out.sessions += 1;
                        by_day.entry(day.to_string()).or_insert_with(|| blank_day(day)).sessions += 1;
                    }

                    let entry = by_day.entry(day.to_string()).or_insert_with(|| blank_day(day));
                    match role {
                        "user" => {
                            out.user_messages += 1;
                            out.messages += 1;
                            entry.messages += 1;
                        }
                        "assistant" => {
                            out.assistant_messages += 1;
                            out.messages += 1;
                            entry.messages += 1;
                            if let Some(hour) = ts.get(11..13).and_then(|h| h.parse::<u32>().ok()) {
                                if hour < 24 {
                                    hours[hour as usize] += 1;
                                }
                            }
                            let tokens = read_tokens(msg.get("usage"));
                            let cost = msg
                                .pointer("/usage/cost/total")
                                .and_then(|c| c.as_f64())
                                .unwrap_or(0.0);
                            out.tokens.add(&tokens);
                            out.cost += cost;
                            entry.tokens += tokens.total;

                            // pi splits provider/model on the message; omp too.
                            let model = msg
                                .get("model")
                                .and_then(|m| m.as_str())
                                .map(|m| match msg.get("provider").and_then(|p| p.as_str()) {
                                    Some(p) if !m.contains('/') => format!("{p}/{m}"),
                                    _ => m.to_string(),
                                })
                                .or_else(|| current_model.clone());
                            if let Some(model) = model {
                                let row = by_model.entry(model.clone()).or_insert_with(|| ModelUsage {
                                    model,
                                    messages: 0,
                                    tokens: Tokens::default(),
                                    cost: 0.0,
                                });
                                row.messages += 1;
                                row.tokens.add(&tokens);
                                row.cost += cost;
                            }
                        }
                        "toolResult" => {
                            out.tool_calls += 1;
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
    }

    out.by_day = by_day.into_values().collect();
    out.active_days = out.by_day.iter().filter(|d| d.messages > 0).count() as u64;
    out.first_day = out.by_day.first().map(|d| d.date.clone());
    out.last_day = out.by_day.last().map(|d| d.date.clone());
    let (current, longest) = streaks(&out.by_day);
    out.current_streak = current;
    out.longest_streak = longest;
    out.peak_hour = (out.assistant_messages > 0)
        .then(|| {
            hours
                .iter()
                .enumerate()
                .max_by_key(|(_, n)| **n)
                .filter(|(_, n)| **n > 0)
                .map(|(h, _)| h as u32)
        })
        .flatten();

    let mut models: Vec<ModelUsage> = by_model.into_values().collect();
    models.sort_by(|a, b| b.tokens.total.cmp(&a.tokens.total).then_with(|| a.model.cmp(&b.model)));
    out.favorite_model = models.first().map(|m| m.model.clone());
    out.by_model = models;
    Ok(out)
}

fn blank_day(date: &str) -> DayUsage {
    DayUsage { date: date.to_string(), sessions: 0, messages: 0, tokens: 0 }
}

fn read_tokens(usage: Option<&serde_json::Value>) -> Tokens {
    let Some(u) = usage else { return Tokens::default() };
    let get = |k: &str| u.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
    let mut t = Tokens {
        input: get("input"),
        output: get("output"),
        cache_read: get("cacheRead"),
        cache_write: get("cacheWrite"),
        total: get("totalTokens"),
    };
    // Older sessions omit the rollup; reconstruct it so totals stay comparable.
    if t.total == 0 {
        t.total = t.input + t.output + t.cache_read + t.cache_write;
    }
    t
}

fn normalize_model(entry: &serde_json::Value) -> Option<String> {
    if let (Some(p), Some(m)) = (
        entry.get("provider").and_then(|v| v.as_str()),
        entry.get("modelId").and_then(|v| v.as_str()),
    ) {
        return Some(format!("{p}/{m}"));
    }
    entry.get("model").and_then(|v| v.as_str()).map(str::to_string)
}

/// Longest run of consecutive active days, and the run ending today or
/// yesterday (a streak survives a day that is not over yet).
fn streaks(days: &[DayUsage]) -> (u64, u64) {
    let active: Vec<&str> =
        days.iter().filter(|d| d.messages > 0).map(|d| d.date.as_str()).collect();
    if active.is_empty() {
        return (0, 0);
    }
    let mut longest = 1u64;
    let mut run = 1u64;
    for pair in active.windows(2) {
        if is_next_day(pair[0], pair[1]) {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 1;
        }
    }
    let today = today_utc();
    let last = active[active.len() - 1];
    let current = if last == today || is_next_day(last, &today) { run } else { 0 };
    (current, longest)
}

// Dates are handled as plain `YYYY-MM-DD` strings against a civil-calendar
// conversion, so the crate keeps its zero non-essential dependencies.
fn to_days(date: &str) -> Option<i64> {
    let mut parts = date.split('-');
    let y: i64 = parts.next()?.parse().ok()?;
    let m: i64 = parts.next()?.parse().ok()?;
    let d: i64 = parts.next()?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    // Howard Hinnant's days_from_civil.
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

fn from_days(days: i64) -> String {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

fn is_next_day(a: &str, b: &str) -> bool {
    match (to_days(a), to_days(b)) {
        (Some(x), Some(y)) => y - x == 1,
        _ => false,
    }
}

fn today_utc() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    from_days(secs / 86_400)
}

fn cutoff_date(days_back: u32) -> Option<String> {
    let today = to_days(&today_utc())?;
    Some(from_days(today - i64::from(days_back) + 1))
}

fn collect_files(root: &Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_dates_round_trip() {
        for date in ["1970-01-01", "2000-02-29", "2026-08-31", "2024-12-31"] {
            assert_eq!(from_days(to_days(date).unwrap()), date, "{date}");
        }
        assert!(is_next_day("2026-02-28", "2026-03-01"), "2026 is not a leap year");
        assert!(is_next_day("2024-02-28", "2024-02-29"), "2024 is");
        assert!(!is_next_day("2026-08-01", "2026-08-03"));
    }

    #[test]
    fn rejects_nonsense_dates() {
        assert_eq!(to_days("not-a-date"), None);
        assert_eq!(to_days("2026-13-01"), None);
        assert_eq!(to_days("2026-01-99"), None);
    }

    #[test]
    fn streak_counts_only_a_run_that_reaches_today() {
        let days = |dates: &[&str]| -> Vec<DayUsage> {
            dates.iter().map(|d| DayUsage { date: d.to_string(), sessions: 1, messages: 3, tokens: 10 }).collect()
        };
        // An old run is the longest, but the current streak is zero.
        let (current, longest) = streaks(&days(&["2020-01-01", "2020-01-02", "2020-01-03"]));
        assert_eq!(longest, 3);
        assert_eq!(current, 0);

        let today = today_utc();
        let (current, _) = streaks(&days(&[&today]));
        assert_eq!(current, 1, "a run ending today counts");
    }

    #[test]
    fn ignores_days_with_no_messages() {
        let days = vec![
            DayUsage { date: "2026-01-01".into(), sessions: 1, messages: 0, tokens: 0 },
            DayUsage { date: "2026-01-02".into(), sessions: 1, messages: 2, tokens: 5 },
        ];
        assert_eq!(streaks(&days).1, 1);
    }

    #[test]
    fn reconstructs_a_missing_token_rollup() {
        let usage = serde_json::json!({ "input": 10, "output": 5, "cacheRead": 2, "cacheWrite": 1 });
        assert_eq!(read_tokens(Some(&usage)).total, 18);
        let with_total = serde_json::json!({ "input": 10, "output": 5, "totalTokens": 99 });
        assert_eq!(read_tokens(Some(&with_total)).total, 99);
        assert_eq!(read_tokens(None), Tokens::default());
    }
}
