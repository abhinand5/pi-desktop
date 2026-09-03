//! Usage aggregation over the harness's own session files.
//!
//! Everything here is derived from JSONL already on disk — the desktop keeps no
//! telemetry of its own and writes nothing. That also means the numbers cover
//! whatever the agent did, whether it was driven from this app or its TUI.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::Arc;

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
    /// Per-machine split, so a report that spans hosts says where the work
    /// happened rather than only that it happened.
    pub by_machine: Vec<MachineUsage>,
    /// Machines that could not be read this time. Named rather than silently
    /// dropped: a total that quietly excludes a box is worse than one that
    /// says which box it is missing.
    pub unreachable: Vec<String>,
    pub by_day: Vec<DayUsage>,
    pub first_day: Option<String>,
    pub last_day: Option<String>,
}

/// The machine a slice of usage came from. `None` is this one.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MachineUsage {
    /// The host alias, or "this machine".
    pub machine: String,
    pub sessions: u64,
    pub messages: u64,
    pub tokens: Tokens,
    pub cost: f64,
}

/// What one session file contributes, bucketed by day.
///
/// This is the unit that gets cached. Bucketing by day is what makes the
/// window filter free: "the last 7 days" is a sum over the buckets that
/// qualify, not another pass over 57 MB of JSONL. And because a file only
/// changes by being appended to, its buckets stay valid until its mtime or
/// length moves.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FileUsage {
    days: BTreeMap<String, DayBucket>,
}

#[derive(Debug, Clone, Default, PartialEq)]
struct DayBucket {
    messages: u64,
    user_messages: u64,
    assistant_messages: u64,
    tool_calls: u64,
    tokens: Tokens,
    cost: f64,
    hours: [u64; 24],
    by_model: HashMap<String, ModelUsage>,
}

/// Reads one session file's contribution. Pure: no clock, no filesystem beyond
/// the bytes handed in, so the same function serves a local file and one
/// streamed from a remote.
pub fn parse_file(bytes: &[u8]) -> FileUsage {
    let mut out = FileUsage::default();
    let mut current_model: Option<String> = None;

    for line in split_lines(bytes) {
        let Ok(v) = serde_json::from_slice::<serde_json::Value>(line) else { continue };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("model_change") => {
                current_model = normalize_model(&v);
            }
            Some("message") => {
                let Some(msg) = v.get("message") else { continue };
                let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("");
                let ts = v.get("timestamp").and_then(|t| t.as_str()).unwrap_or("");
                let Some(day) = ts.get(..10).filter(|d| !d.is_empty()) else { continue };

                let bucket = out.days.entry(day.to_string()).or_default();
                match role {
                    "user" => {
                        bucket.user_messages += 1;
                        bucket.messages += 1;
                    }
                    "assistant" => {
                        bucket.assistant_messages += 1;
                        bucket.messages += 1;
                        if let Some(hour) = ts.get(11..13).and_then(|h| h.parse::<u32>().ok()) {
                            if hour < 24 {
                                bucket.hours[hour as usize] += 1;
                            }
                        }
                        let tokens = read_tokens(msg.get("usage"));
                        let cost =
                            msg.pointer("/usage/cost/total").and_then(|c| c.as_f64()).unwrap_or(0.0);
                        bucket.tokens.add(&tokens);
                        bucket.cost += cost;

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
                            let row = bucket.by_model.entry(model.clone()).or_insert_with(|| {
                                ModelUsage { model, messages: 0, tokens: Tokens::default(), cost: 0.0 }
                            });
                            row.messages += 1;
                            row.tokens.add(&tokens);
                            row.cost += cost;
                        }
                    }
                    "toolResult" => {
                        bucket.tool_calls += 1;
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    out
}

/// One machine's parsed files, ready to be merged into a report.
pub struct MachineFiles {
    pub machine: String,
    pub files: Vec<FileUsage>,
}

/// Folds parsed files into the report the UI reads.
///
/// The window is applied to the day buckets, not to file names: a long-running
/// session started before the cutoff still has recent turns in it. A session
/// counts once, on its earliest day that falls inside the window — the same
/// rule the single-pass version applied to the first message it did not skip.
pub fn merge(machines: &[MachineFiles], since_days: Option<u32>) -> UsageReport {
    let cutoff = since_days.and_then(cutoff_date);
    let inside = |day: &str| cutoff.as_deref().is_none_or(|c| day >= c);

    let mut out = UsageReport::default();
    let mut by_model: HashMap<String, ModelUsage> = HashMap::new();
    let mut by_day: BTreeMap<String, DayUsage> = BTreeMap::new();
    let mut hours = [0u64; 24];

    for machine in machines {
        let mut row = MachineUsage {
            machine: machine.machine.clone(),
            sessions: 0,
            messages: 0,
            tokens: Tokens::default(),
            cost: 0.0,
        };

        for file in &machine.files {
            // The session lands on its first day inside the window.
            if let Some(first) = file.days.keys().find(|d| inside(d)) {
                out.sessions += 1;
                row.sessions += 1;
                by_day.entry(first.clone()).or_insert_with(|| blank_day(first)).sessions += 1;
            }

            for (day, bucket) in &file.days {
                if !inside(day) {
                    continue;
                }
                let entry = by_day.entry(day.clone()).or_insert_with(|| blank_day(day));
                entry.messages += bucket.messages;
                entry.tokens += bucket.tokens.total;

                out.messages += bucket.messages;
                out.user_messages += bucket.user_messages;
                out.assistant_messages += bucket.assistant_messages;
                out.tool_calls += bucket.tool_calls;
                out.tokens.add(&bucket.tokens);
                out.cost += bucket.cost;
                row.messages += bucket.messages;
                row.tokens.add(&bucket.tokens);
                row.cost += bucket.cost;

                for (h, n) in bucket.hours.iter().enumerate() {
                    hours[h] += n;
                }
                for (name, model) in &bucket.by_model {
                    let acc = by_model.entry(name.clone()).or_insert_with(|| ModelUsage {
                        model: name.clone(),
                        messages: 0,
                        tokens: Tokens::default(),
                        cost: 0.0,
                    });
                    acc.messages += model.messages;
                    acc.tokens.add(&model.tokens);
                    acc.cost += model.cost;
                }
            }
        }

        // A machine with nothing in the window is still worth naming: "this
        // remote did nothing this week" is an answer, not an absence.
        out.by_machine.push(row);
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
    out.by_machine.sort_by(|a, b| b.tokens.total.cmp(&a.tokens.total).then_with(|| a.machine.cmp(&b.machine)));
    out
}

/// Every session file for the given harnesses, on this machine.
pub fn local_files(harnesses: &[Arc<dyn Harness>]) -> Vec<std::path::PathBuf> {
    let mut files = Vec::new();
    for harness in harnesses {
        collect_files(&harness.sessions_root(), &mut files);
    }
    files
}

/// Scans every session file for the given harnesses. `since_days` limits the
/// window; `None` covers everything on disk. Several harnesses merge into one
/// report, so the numbers cover everything the desktop drives.
pub fn report(harnesses: &[Arc<dyn Harness>], since_days: Option<u32>) -> Result<UsageReport> {
    let files = local_files(harnesses)
        .iter()
        .filter_map(|f| read_capped(f, FILE_CAP).ok())
        .map(|bytes| parse_file(&bytes))
        .collect();
    Ok(merge(&[MachineFiles { machine: THIS_MACHINE.into(), files }], since_days))
}

/// What the local machine is called in a report that spans several.
pub const THIS_MACHINE: &str = "this machine";

/// A file as the filesystem describes it, without reading it.
#[derive(Debug, Clone, PartialEq)]
pub struct FileStamp {
    pub path: String,
    /// Seconds since the epoch. Remote listings report it the same way.
    pub mtime: i64,
    pub len: u64,
}

/// Per-file results, kept between calls.
///
/// A usage report is a pass over every session file the agents have ever
/// written — tens of megabytes of JSONL that grows forever, re-read on every
/// visit to the page and again on every change of the window filter. Almost
/// none of it changes between two of those: session files are append-only, and
/// only the handful you have touched today move at all.
///
/// So the parse is cached per file and invalidated by mtime and length, which
/// is what an append changes. The window filter then costs nothing: the day
/// buckets are already there.
///
/// Keyed by machine as well as path, because two machines can hold different
/// files at identical paths — `~/.pi/agent/sessions/x.jsonl` exists on every
/// one of them.
#[derive(Default)]
pub struct UsageCache {
    files: std::sync::Mutex<HashMap<(String, String), CachedFile>>,
}

struct CachedFile {
    mtime: i64,
    len: u64,
    usage: Arc<FileUsage>,
}

impl UsageCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// The files whose parse is missing or out of date.
    pub fn stale(&self, machine: &str, listing: &[FileStamp]) -> Vec<FileStamp> {
        let files = self.files.lock().expect("usage cache poisoned");
        listing
            .iter()
            .filter(|stamp| {
                files
                    .get(&(machine.to_string(), stamp.path.clone()))
                    .is_none_or(|c| c.mtime != stamp.mtime || c.len != stamp.len)
            })
            .cloned()
            .collect()
    }

    pub fn insert(&self, machine: &str, stamp: &FileStamp, usage: FileUsage) {
        self.files.lock().expect("usage cache poisoned").insert(
            (machine.to_string(), stamp.path.clone()),
            CachedFile { mtime: stamp.mtime, len: stamp.len, usage: Arc::new(usage) },
        );
    }

    /// The machine's parsed files, and the release of anything the listing no
    /// longer mentions — a deleted session should leave the totals.
    pub fn collect(&self, machine: &str, listing: &[FileStamp]) -> MachineFiles {
        let mut files = self.files.lock().expect("usage cache poisoned");
        let live: std::collections::HashSet<&str> =
            listing.iter().map(|s| s.path.as_str()).collect();
        files.retain(|(m, path), _| m != machine || live.contains(path.as_str()));

        let parsed = listing
            .iter()
            .filter_map(|stamp| files.get(&(machine.to_string(), stamp.path.clone())))
            .map(|c| (*c.usage).clone())
            .collect();
        MachineFiles { machine: machine.to_string(), files: parsed }
    }
}

/// Parses files in parallel and folds them into the cache.
///
/// The first visit still has to read everything; after that this list is
/// usually one file long. Threads rather than a work-stealing dependency: the
/// unit is a whole file, and there are only ever as many as there are sessions.
pub fn parse_into_cache(
    cache: &UsageCache,
    machine: &str,
    stale: &[FileStamp],
    read: impl Fn(&FileStamp) -> Option<Vec<u8>> + Sync,
) {
    if stale.is_empty() {
        return;
    }
    let workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(stale.len());
    let next = std::sync::atomic::AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let Some(stamp) = stale.get(i) else { return };
                if let Some(bytes) = read(stamp) {
                    cache.insert(machine, stamp, parse_file(&bytes));
                }
            });
        }
    });
}

/// Stamps every local session file for the given harnesses.
pub fn local_listing(harnesses: &[Arc<dyn Harness>]) -> Vec<FileStamp> {
    local_files(harnesses)
        .into_iter()
        .filter_map(|path| {
            let meta = std::fs::metadata(&path).ok()?;
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            Some(FileStamp { path: path.to_string_lossy().into_owned(), mtime, len: meta.len() })
        })
        .collect()
}

/// Reads a local session file, capped the way the scanner has always capped it.
pub fn read_local(stamp: &FileStamp) -> Option<Vec<u8>> {
    read_capped(Path::new(&stamp.path), FILE_CAP).ok()
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

    fn session(day: &str, tokens: u64) -> Vec<u8> {
        format!(
            r#"{{"type":"message","timestamp":"{day}T10:00:00Z","message":{{"role":"user","content":"hi"}}}}
{{"type":"message","timestamp":"{day}T10:00:05Z","message":{{"role":"assistant","model":"m","provider":"p","usage":{{"input":1,"output":2,"totalTokens":{tokens},"cost":{{"total":0.5}}}}}}}}
"#
        )
        .into_bytes()
    }

    fn one(machine: &str, files: Vec<FileUsage>) -> Vec<MachineFiles> {
        vec![MachineFiles { machine: machine.into(), files }]
    }

    #[test]
    fn a_window_is_a_fold_over_day_buckets_not_another_read() {
        // One file spanning two days: the narrow window keeps the later day
        // only, and the session counts once, on its first day inside it.
        let mut file = parse_file(&session("2020-01-01", 100));
        let later = parse_file(&session("2020-01-02", 40));
        file.days.extend(later.days);

        let all = merge(&one(THIS_MACHINE, vec![file.clone()]), None);
        assert_eq!(all.sessions, 1);
        assert_eq!(all.tokens.total, 140);
        assert_eq!(all.by_day.len(), 2);
        assert_eq!(all.by_day[0].sessions, 1, "the session lands on its first day");
        assert_eq!(all.by_day[1].sessions, 0);
    }

    #[test]
    fn machines_are_totalled_together_and_reported_apart() {
        let machines = vec![
            MachineFiles { machine: THIS_MACHINE.into(), files: vec![parse_file(&session("2020-03-01", 100))] },
            MachineFiles { machine: "build-box".into(), files: vec![parse_file(&session("2020-03-01", 25))] },
        ];
        let report = merge(&machines, None);

        assert_eq!(report.sessions, 2);
        assert_eq!(report.tokens.total, 125, "the totals span every machine");
        assert_eq!(report.by_machine.len(), 2);
        let build = report.by_machine.iter().find(|m| m.machine == "build-box").unwrap();
        assert_eq!(build.tokens.total, 25, "and each machine's share is still separable");
        assert_eq!(build.sessions, 1);
    }

    #[test]
    fn a_cached_file_is_not_parsed_again_until_it_changes() {
        let cache = UsageCache::new();
        let stamp = FileStamp { path: "/s/a.jsonl".into(), mtime: 10, len: 200 };

        assert_eq!(cache.stale("m", std::slice::from_ref(&stamp)).len(), 1);
        cache.insert("m", &stamp, parse_file(&session("2020-04-01", 70)));
        assert!(cache.stale("m", std::slice::from_ref(&stamp)).is_empty(), "unchanged: no re-read");

        // Appending moves the length, which is what invalidates it.
        let grown = FileStamp { len: 260, ..stamp.clone() };
        assert_eq!(cache.stale("m", std::slice::from_ref(&grown)).len(), 1);

        assert_eq!(merge(&one("m", cache.collect("m", std::slice::from_ref(&stamp)).files), None).tokens.total, 70);
    }

    #[test]
    fn the_same_path_on_two_machines_is_two_files() {
        // Every machine has `~/.pi/agent/sessions`, so a path alone would let
        // one host's numbers stand in for another's.
        let cache = UsageCache::new();
        let stamp = FileStamp { path: "/home/me/.pi/agent/sessions/x.jsonl".into(), mtime: 0, len: 9 };
        cache.insert("this machine", &stamp, parse_file(&session("2020-05-01", 10)));

        assert_eq!(cache.stale("build-box", std::slice::from_ref(&stamp)).len(), 1);
        assert!(cache.collect("build-box", std::slice::from_ref(&stamp)).files.is_empty());
    }

    #[test]
    fn a_deleted_session_leaves_the_totals() {
        let cache = UsageCache::new();
        let stamp = FileStamp { path: "/s/gone.jsonl".into(), mtime: 1, len: 5 };
        cache.insert("m", &stamp, parse_file(&session("2020-06-01", 30)));
        assert_eq!(cache.collect("m", std::slice::from_ref(&stamp)).files.len(), 1);

        // The file is no longer in the listing.
        assert!(cache.collect("m", &[]).files.is_empty());
    }

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
