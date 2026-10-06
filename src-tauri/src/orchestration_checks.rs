//! Acceptance checks the app runs in a worker checkout after the worker
//! finishes, such as a project's tests or type check.
use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::Semaphore;

const MAX_COMMAND_CHARS: usize = 2000;
const MAX_OUTPUT_CHARS: usize = 16_000;
/// Enough bytes for the character tail even when every character is 4 bytes.
const TAIL_BYTES: usize = MAX_OUTPUT_CHARS * 4 + 4;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 30 * 60 * 1_000;
/// How long output may keep arriving from leftovers after the shell exits.
const OUTPUT_GRACE: Duration = Duration::from_secs(1);
/// Variables that would let a check reach the orchestration or app channel.
const CONTROL_ENV: [&str; 4] = [
    "MONOCODE_CONTROL_ENDPOINT",
    "MONOCODE_CONTROL_TOKEN",
    "MONOCODE_APP_ENDPOINT",
    "MONOCODE_APP_TOKEN",
];

/// Test suites and type checks can each take gigabytes, so only two run at
/// once however many workers finish together.
static CHECKS: Semaphore = Semaphore::const_new(2);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRunResult {
    /// None when the check timed out or ended by a signal.
    exit_code: Option<i32>,
    /// Combined stdout and stderr, keeping only the tail.
    output: String,
    timed_out: bool,
    duration_ms: u64,
}

struct CheckRequest {
    cwd: PathBuf,
    command: String,
    timeout: Duration,
    scratch_dir: Option<PathBuf>,
}

impl CheckRequest {
    fn new(
        cwd: &str,
        command: String,
        timeout_ms: u64,
        scratch_dir: Option<String>,
    ) -> Result<Self, String> {
        let cwd = crate::fs::expand_home(cwd.trim());
        if !cwd.is_dir() {
            return Err(format!("{}: Not a directory", cwd.display()));
        }
        if command.trim().is_empty() {
            return Err("The check command is empty".into());
        }
        if command.chars().count() > MAX_COMMAND_CHARS {
            return Err(format!(
                "The check command is longer than {MAX_COMMAND_CHARS} characters"
            ));
        }
        let scratch_dir = match scratch_dir {
            Some(path) => {
                let path = crate::fs::expand_home(path.trim());
                if !path.is_dir() {
                    return Err(format!("{}: Not a directory", path.display()));
                }
                Some(path)
            }
            None => None,
        };
        Ok(Self {
            cwd,
            command,
            timeout: Duration::from_millis(timeout_ms.clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)),
            scratch_dir,
        })
    }
}

/// Run `command` in `cwd` through the user's login shell, so it finds the
/// same tools as their terminal. Output is the combined stdout/stderr tail.
#[tauri::command]
pub async fn orchestration_run_check(
    cwd: String,
    command: String,
    timeout_ms: u64,
    scratch_dir: Option<String>,
) -> Result<CheckRunResult, String> {
    let request = CheckRequest::new(&cwd, command, timeout_ms, scratch_dir)?;
    let _permit = CHECKS.acquire().await.map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || run_check(&request))
        .await
        .map_err(|e| e.to_string())?
}

fn shell_command(command: &str) -> Command {
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|shell| shell.starts_with('/') && std::path::Path::new(shell).is_file())
            .unwrap_or_else(|| "/bin/sh".into());
        let mut cmd = Command::new(shell);
        cmd.arg("-lc").arg(command);
        cmd
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").raw_arg(command);
        cmd
    }
}

fn run_check(request: &CheckRequest) -> Result<CheckRunResult, String> {
    let mut cmd = shell_command(&request.command);
    // Tests keep the inherited PATH instead of probing the login shell.
    #[cfg(not(test))]
    crate::harness::apply_gui_env(&mut cmd);
    cmd.current_dir(&request.cwd).stdin(Stdio::null());
    for key in CONTROL_ENV {
        cmd.env_remove(key);
    }
    if let Some(scratch) = &request.scratch_dir {
        cmd.env("TMPDIR", scratch)
            .env("TMP", scratch)
            .env("TEMP", scratch);
    }
    // One process group, so a timeout reaches everything the check started.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }
    let (reader, writer) = std::io::pipe().map_err(|e| e.to_string())?;
    cmd.stdout(writer.try_clone().map_err(|e| e.to_string())?)
        .stderr(writer);

    let started = Instant::now();
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    // The command keeps copies of the pipe's write end; drop them so the
    // reader sees EOF once the check's own processes exit.
    drop(cmd);
    let tail = Arc::new(Mutex::new(Vec::new()));
    let done = read_tail(reader, tail.clone());

    let deadline = started + request.timeout;
    let mut timed_out = false;
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => break status,
            None if Instant::now() >= deadline => {
                timed_out = true;
                kill_tree(&child);
                break child.wait().map_err(|e| e.to_string())?;
            }
            None => std::thread::sleep(Duration::from_millis(25)),
        }
    };
    // Background processes the check left behind can hold the pipe open.
    if done.recv_timeout(OUTPUT_GRACE).is_err() {
        kill_tree(&child);
        let _ = done.recv_timeout(OUTPUT_GRACE);
    }
    let duration_ms = started.elapsed().as_millis() as u64;
    let bytes = std::mem::take(&mut *tail.lock().map_err(|_| "Check output unavailable")?);
    Ok(CheckRunResult {
        exit_code: if timed_out { None } else { status.code() },
        output: tail_chars(&String::from_utf8_lossy(&bytes), MAX_OUTPUT_CHARS).to_string(),
        timed_out,
        duration_ms,
    })
}

/// Keep the last bytes of the combined output; signals completion on EOF.
fn read_tail(mut reader: std::io::PipeReader, tail: Arc<Mutex<Vec<u8>>>) -> mpsc::Receiver<()> {
    let (done, finished) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    let Ok(mut tail) = tail.lock() else { break };
                    tail.extend_from_slice(&buffer[..read]);
                    if tail.len() > TAIL_BYTES {
                        let excess = tail.len() - TAIL_BYTES;
                        tail.drain(..excess);
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
        let _ = done.send(());
    });
    finished
}

fn kill_tree(child: &Child) {
    #[cfg(unix)]
    {
        // The group id is the shell's pid, so this reaches every descendant
        // that did not start its own session.
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
    }
    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        crate::hide_window_console(&mut cmd);
        cmd.args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let _ = cmd.status();
    }
}

fn tail_chars(text: &str, max: usize) -> &str {
    if max == 0 {
        return "";
    }
    text.char_indices()
        .rev()
        .nth(max - 1)
        .map_or(text, |(start, _)| &text[start..])
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn run(command: &str, timeout_ms: u64, scratch: Option<String>) -> CheckRunResult {
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        run_check(&CheckRequest::new(&cwd, command.into(), timeout_ms, scratch).unwrap()).unwrap()
    }

    #[test]
    fn reports_exit_code_and_combined_output() {
        let ok = run("echo out; echo err >&2", 10_000, None);
        assert_eq!(ok.exit_code, Some(0));
        assert!(!ok.timed_out);
        assert!(ok.output.contains("out\n") && ok.output.contains("err\n"));
        assert_eq!(run("exit 3", 10_000, None).exit_code, Some(3));
    }

    #[test]
    fn keeps_only_the_output_tail() {
        let long = run(
            "i=0; while [ $i -lt 2500 ]; do echo \"line $i é\"; i=$((i+1)); done",
            20_000,
            None,
        );
        assert_eq!(long.output.chars().count(), MAX_OUTPUT_CHARS);
        assert!(long.output.ends_with("line 2499 é\n"));
        assert_eq!(tail_chars("aéb", 2), "éb");
        assert_eq!(tail_chars("ab", 5), "ab");
    }

    #[test]
    fn timeout_kills_the_whole_process_group() {
        let pid_file =
            std::env::temp_dir().join(format!("monocode-check-{}.pid", uuid::Uuid::new_v4()));
        let started = Instant::now();
        let result = run(
            &format!(
                "sleep 30 & echo $! > '{}'; sleep 30; echo never",
                pid_file.display()
            ),
            1,
            None,
        );
        assert!(result.timed_out);
        assert_eq!(result.exit_code, None);
        assert!(!result.output.contains("never"));
        assert!(started.elapsed() < Duration::from_secs(5));
        let pid: i32 = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let _ = std::fs::remove_file(&pid_file);
        // SIGKILL is delivered at once; the orphan is reaped by init shortly.
        let mut alive = true;
        for _ in 0..40 {
            alive = unsafe { libc::kill(pid, 0) } == 0;
            if !alive {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!alive, "background process survived the timeout");
    }

    #[test]
    fn strips_control_credentials_and_uses_scratch() {
        let scratch = std::env::temp_dir().join(format!("monocode-check-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&scratch).unwrap();
        // No other test reads these variables.
        std::env::set_var("MONOCODE_CONTROL_TOKEN", "secret");
        std::env::set_var("MONOCODE_APP_TOKEN", "secret");
        let result = run(
            "echo \"[${MONOCODE_CONTROL_TOKEN-unset}][${MONOCODE_APP_TOKEN-unset}][$TMPDIR]\"",
            10_000,
            Some(scratch.to_string_lossy().into_owned()),
        );
        std::env::remove_var("MONOCODE_CONTROL_TOKEN");
        std::env::remove_var("MONOCODE_APP_TOKEN");
        let _ = std::fs::remove_dir_all(&scratch);
        assert!(result
            .output
            .contains(&format!("[unset][unset][{}]", scratch.display())));
    }

    #[test]
    fn rejects_invalid_requests() {
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        assert!(CheckRequest::new("/definitely/not/here", "true".into(), 1, None).is_err());
        assert!(CheckRequest::new(&cwd, "  ".into(), 1, None).is_err());
        assert!(CheckRequest::new(&cwd, "x".repeat(2001), 1, None).is_err());
        let clamped = CheckRequest::new(&cwd, "true".into(), u64::MAX, None).unwrap();
        assert_eq!(clamped.timeout, Duration::from_millis(MAX_TIMEOUT_MS));
    }
}
