use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
#[cfg(not(windows))]
use std::collections::HashSet;
use std::io::{Read, Write};
#[cfg(not(windows))]
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tauri::{AppHandle, Emitter};
use tokio::sync::{Notify, RwLock};

use crate::models::{
    LocalShellProfile, SshConnectRequest, SshConnectResult, SshDataEvent, SshStateEvent,
    IPC_EVENT_SSH_DATA, IPC_EVENT_SSH_STATE,
};
use crate::services::ssh::Utf8StreamDecoder;

fn first_existing_file(candidates: &[Option<PathBuf>]) -> Option<PathBuf> {
    for cand in candidates.iter().flatten() {
        if cand.is_file() {
            return Some(cand.clone());
        }
    }
    None
}

fn find_executable_in_path(bin_name: &str) -> Option<PathBuf> {
    let path_env = std::env::var_os("PATH")?;
    let dirs = std::env::split_paths(&path_env);

    #[cfg(windows)]
    {
        let exts: Vec<String> = if bin_name.contains('.') {
            vec![String::new()]
        } else {
            std::env::var("PATHEXT")
                .unwrap_or_else(|_| ".EXE;.CMD;.BAT".to_string())
                .split(';')
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect()
        };

        for dir in dirs {
            for ext in &exts {
                let full = dir.join(format!("{bin_name}{ext}"));
                if full.is_file() {
                    return Some(full);
                }
            }
        }
        None
    }

    #[cfg(not(windows))]
    {
        for dir in dirs {
            let full = dir.join(bin_name);
            if full.is_file() {
                return Some(full);
            }
        }
        None
    }
}

#[cfg(windows)]
fn discover_windows_shells() -> Vec<LocalShellProfile> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let mut profiles = Vec::new();
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("C:\\Users\\Default"));
    let sys_root = PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string()));
    let prog_files = PathBuf::from(
        std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".to_string()),
    );
    let prog_files_x86 = PathBuf::from(
        std::env::var("ProgramFiles(x86)")
            .unwrap_or_else(|_| "C:\\Program Files (x86)".to_string()),
    );

    // 1. PowerShell 7 (pwsh)
    if let Some(pwsh) = first_existing_file(&[
        find_executable_in_path("pwsh.exe"),
        Some(prog_files.join("PowerShell").join("7").join("pwsh.exe")),
        Some(home.join("scoop").join("apps").join("pwsh").join("current").join("pwsh.exe")),
    ]) {
        profiles.push(LocalShellProfile {
            id: "pwsh".to_string(),
            label: "PowerShell 7 (pwsh)".to_string(),
            command: pwsh.to_string_lossy().to_string(),
            args: vec!["-NoLogo".to_string()],
            platform: "win32".to_string(),
        });
    }

    // 2. Windows PowerShell 5.1
    if let Some(win_ps) = first_existing_file(&[
        Some(
            sys_root
                .join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe"),
        ),
        find_executable_in_path("powershell.exe"),
    ]) {
        profiles.push(LocalShellProfile {
            id: "powershell".to_string(),
            label: "Windows PowerShell".to_string(),
            command: win_ps.to_string_lossy().to_string(),
            args: vec!["-NoLogo".to_string()],
            platform: "win32".to_string(),
        });
    }

    // 3. Command Prompt (CMD)
    if let Some(cmd) = first_existing_file(&[
        std::env::var("COMSPEC").ok().map(PathBuf::from),
        Some(sys_root.join("System32").join("cmd.exe")),
    ]) {
        profiles.push(LocalShellProfile {
            id: "cmd".to_string(),
            label: "命令提示符 (CMD)".to_string(),
            command: cmd.to_string_lossy().to_string(),
            args: vec![],
            platform: "win32".to_string(),
        });
    }

    // 4. Git Bash
    if let Some(git_bash) = first_existing_file(&[
        Some(prog_files.join("Git").join("bin").join("bash.exe")),
        Some(prog_files_x86.join("Git").join("bin").join("bash.exe")),
        Some(
            home.join("AppData")
                .join("Local")
                .join("Programs")
                .join("Git")
                .join("bin")
                .join("bash.exe"),
        ),
        Some(
            home.join("scoop")
                .join("apps")
                .join("git")
                .join("current")
                .join("bin")
                .join("bash.exe"),
        ),
    ]) {
        profiles.push(LocalShellProfile {
            id: "git-bash".to_string(),
            label: "Git Bash".to_string(),
            command: git_bash.to_string_lossy().to_string(),
            args: vec!["--login".to_string(), "-i".to_string()],
            platform: "win32".to_string(),
        });
    }

    // 5. WSL + installed distros
    if let Some(wsl_exe) = first_existing_file(&[
        Some(sys_root.join("System32").join("wsl.exe")),
        find_executable_in_path("wsl.exe"),
    ]) {
        let mut distros = Vec::new();
        if let Ok(output) = std::process::Command::new(&wsl_exe)
            .args(["-l", "-q"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            if output.status.success() && !output.stdout.is_empty() {
                let decoded = if output.stdout.contains(&0u8) {
                    let u16s: Vec<u16> = output
                        .stdout
                        .chunks_exact(2)
                        .map(|c| u16::from_le_bytes([c[0], c[1]]))
                        .collect();
                    String::from_utf16_lossy(&u16s)
                } else {
                    String::from_utf8_lossy(&output.stdout).to_string()
                };

                for line in decoded.replace('\u{FEFF}', "").lines() {
                    let cleaned = line.replace('\0', "").trim().to_string();
                    if !cleaned.is_empty()
                        && !cleaned.to_lowercase().starts_with("docker-desktop")
                    {
                        distros.push(cleaned);
                    }
                }
            }
        }

        if !distros.is_empty() {
            for distro in distros {
                profiles.push(LocalShellProfile {
                    id: format!("wsl:{distro}"),
                    label: format!("WSL · {distro}"),
                    command: wsl_exe.to_string_lossy().to_string(),
                    args: vec![
                        "-d".to_string(),
                        distro,
                        "--cd".to_string(),
                        "~".to_string(),
                    ],
                    platform: "win32".to_string(),
                });
            }
        } else {
            profiles.push(LocalShellProfile {
                id: "wsl".to_string(),
                label: "WSL (Linux 子系统)".to_string(),
                command: wsl_exe.to_string_lossy().to_string(),
                args: vec!["--cd".to_string(), "~".to_string()],
                platform: "win32".to_string(),
            });
        }
    }

    // 6. MSYS2 Bash
    if let Some(msys) = first_existing_file(&[Some(PathBuf::from("C:\\msys64\\usr\\bin\\bash.exe"))])
    {
        profiles.push(LocalShellProfile {
            id: "msys2".to_string(),
            label: "MSYS2 Bash".to_string(),
            command: msys.to_string_lossy().to_string(),
            args: vec!["--login".to_string(), "-i".to_string()],
            platform: "win32".to_string(),
        });
    }

    profiles
}

#[cfg(not(windows))]
fn discover_unix_shells() -> Vec<LocalShellProfile> {
    let platform = if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let mut profiles = Vec::new();
    let mut seen = HashSet::new();

    let mut add_cand = |id: &str, label: &str, cands: Vec<Option<PathBuf>>, args: Vec<&str>| {
        if let Some(resolved) = first_existing_file(&cands) {
            let cmd_str = resolved.to_string_lossy().to_string();
            if seen.insert(cmd_str.clone()) {
                profiles.push(LocalShellProfile {
                    id: id.to_string(),
                    label: label.to_string(),
                    command: cmd_str,
                    args: args.into_iter().map(String::from).collect(),
                    platform: platform.to_string(),
                });
            }
        }
    };

    if let Ok(env_shell) = std::env::var("SHELL") {
        let trimmed = env_shell.trim();
        if !trimmed.is_empty() {
            let base = Path::new(trimmed)
                .file_name()
                .map(|s| s.to_string_lossy().to_lowercase())
                .unwrap_or_else(|| "shell".to_string());
            let args = if base == "pwsh" {
                vec!["-NoLogo"]
            } else {
                vec!["-l"]
            };
            add_cand(
                &format!("default:{base}"),
                &format!("{} (系统默认)", base.to_uppercase()),
                vec![Some(PathBuf::from(trimmed))],
                args,
            );
        }
    }

    if cfg!(target_os = "macos") {
        add_cand(
            "zsh",
            "Zsh",
            vec![
                Some(PathBuf::from("/opt/homebrew/bin/zsh")),
                Some(PathBuf::from("/usr/local/bin/zsh")),
                Some(PathBuf::from("/bin/zsh")),
            ],
            vec!["-l"],
        );
        add_cand(
            "bash",
            "Bash",
            vec![
                Some(PathBuf::from("/opt/homebrew/bin/bash")),
                Some(PathBuf::from("/usr/local/bin/bash")),
                Some(PathBuf::from("/bin/bash")),
            ],
            vec!["-l"],
        );
    } else {
        add_cand(
            "bash",
            "Bash",
            vec![
                Some(PathBuf::from("/bin/bash")),
                Some(PathBuf::from("/usr/bin/bash")),
            ],
            vec!["-l"],
        );
        add_cand(
            "zsh",
            "Zsh",
            vec![
                Some(PathBuf::from("/usr/bin/zsh")),
                Some(PathBuf::from("/bin/zsh")),
            ],
            vec!["-l"],
        );
    }

    add_cand(
        "fish",
        "Fish Shell",
        vec![
            find_executable_in_path("fish"),
            Some(PathBuf::from("/opt/homebrew/bin/fish")),
            Some(PathBuf::from("/usr/local/bin/fish")),
            Some(PathBuf::from("/usr/bin/fish")),
        ],
        vec!["-l"],
    );
    add_cand(
        "pwsh",
        "PowerShell (pwsh)",
        vec![
            find_executable_in_path("pwsh"),
            Some(PathBuf::from("/opt/homebrew/bin/pwsh")),
            Some(PathBuf::from("/usr/local/bin/pwsh")),
            Some(PathBuf::from("/usr/bin/pwsh")),
        ],
        vec!["-NoLogo"],
    );
    add_cand(
        "nu",
        "Nushell (nu)",
        vec![
            find_executable_in_path("nu"),
            Some(PathBuf::from("/opt/homebrew/bin/nu")),
            Some(PathBuf::from("/usr/bin/nu")),
        ],
        vec![],
    );
    add_cand(
        "sh",
        "POSIX Sh (/bin/sh)",
        vec![Some(PathBuf::from("/bin/sh"))],
        vec![],
    );

    profiles
}

struct ActiveLocalSession {
    master: Arc<StdMutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<StdMutex<Box<dyn Write + Send>>>,
    killer: Arc<StdMutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>>,
    intentional_close: Arc<AtomicBool>,
    closed_notify: Arc<Notify>,
}

#[derive(Clone)]
pub struct LocalPtyService {
    sessions: Arc<RwLock<HashMap<String, ActiveLocalSession>>>,
    cached_shells: Arc<RwLock<Option<Vec<LocalShellProfile>>>>,
}

impl LocalPtyService {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            cached_shells: Arc::new(RwLock::new(None)),
        }
    }

    pub async fn has_session(&self, session_id: &str) -> bool {
        self.sessions.read().await.contains_key(session_id)
    }

    pub async fn closed_notifier(&self, session_id: &str) -> Option<Arc<Notify>> {
        self.sessions
            .read()
            .await
            .get(session_id)
            .map(|s| s.closed_notify.clone())
    }

    pub async fn list_shells(&self, refresh: bool) -> Vec<LocalShellProfile> {
        if !refresh {
            if let Some(cached) = self.cached_shells.read().await.as_ref() {
                if !cached.is_empty() {
                    return cached.clone();
                }
            }
        }

        let discovered = tokio::task::spawn_blocking(|| {
            #[cfg(windows)]
            {
                discover_windows_shells()
            }
            #[cfg(not(windows))]
            {
                discover_unix_shells()
            }
        })
        .await
        .unwrap_or_default();

        *self.cached_shells.write().await = Some(discovered.clone());
        discovered
    }

    pub async fn connect(&self, app: &AppHandle, req: SshConnectRequest) -> SshConnectResult {
        if self.has_session(&req.session_id).await {
            self.disconnect(&req.session_id).await;
        }

        let shells = self.list_shells(false).await;
        if shells.is_empty() {
            return SshConnectResult {
                ok: false,
                error: Some("未能在当前系统检测到可用的本地终端程序".to_string()),
            };
        }

        let chosen = req
            .shell_id
            .as_ref()
            .and_then(|id| shells.iter().find(|s| &s.id == id))
            .unwrap_or(&shells[0])
            .clone();

        let cols = req.cols.max(20);
        let rows = req.rows.max(5);
        let cwd = req
            .cwd
            .as_deref()
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .or_else(dirs::home_dir)
            .unwrap_or_else(|| PathBuf::from("."));

        let chosen_for_spawn = chosen.clone();
        let spawn_res = tokio::task::spawn_blocking(
            move || -> Result<
                (
                    Box<dyn MasterPty + Send>,
                    Box<dyn Read + Send>,
                    Box<dyn Write + Send>,
                    Box<dyn Child + Send + Sync>,
                ),
                String,
            > {
                let pty_system = native_pty_system();
                let pair = pty_system
                    .openpty(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                    .map_err(|e| format!("创建本地伪终端失败: {e}"))?;

                let mut cmd = CommandBuilder::new(&chosen_for_spawn.command);
                cmd.args(&chosen_for_spawn.args);
                cmd.cwd(cwd);
                cmd.env("TERM", "xterm-256color");
                cmd.env("COLORTERM", "truecolor");

                let child = pair
                    .slave
                    .spawn_command(cmd)
                    .map_err(|e| format!("启动终端进程失败: {e}"))?;
                drop(pair.slave);

                let reader = pair
                    .master
                    .try_clone_reader()
                    .map_err(|e| format!("获取终端输出流失败: {e}"))?;
                let writer = pair
                    .master
                    .take_writer()
                    .map_err(|e| format!("获取终端输入流失败: {e}"))?;

                Ok((pair.master, reader, writer, child))
            },
        )
        .await;

        let (master, mut reader, writer, mut child) = match spawn_res {
            Ok(Ok(parts)) => parts,
            Ok(Err(err_msg)) => {
                let _ = app.emit(
                    IPC_EVENT_SSH_STATE,
                    SshStateEvent {
                        session_id: req.session_id,
                        state: "error".to_string(),
                        message: Some(err_msg.clone()),
                        code: None,
                    },
                );
                return SshConnectResult {
                    ok: false,
                    error: Some(err_msg),
                };
            }
            Err(e) => {
                let msg = format!("启动本机终端异常: {e}");
                return SshConnectResult {
                    ok: false,
                    error: Some(msg),
                };
            }
        };

        let killer = child.clone_killer();
        let master_arc = Arc::new(StdMutex::new(master));
        let writer_arc = Arc::new(StdMutex::new(writer));
        let killer_arc = Arc::new(StdMutex::new(killer));
        let intentional_close = Arc::new(AtomicBool::new(false));
        let closed_notify = Arc::new(Notify::new());

        self.sessions.write().await.insert(
            req.session_id.clone(),
            ActiveLocalSession {
                master: master_arc.clone(),
                writer: writer_arc,
                killer: killer_arc,
                intentional_close: intentional_close.clone(),
                closed_notify: closed_notify.clone(),
            },
        );

        let _ = app.emit(
            IPC_EVENT_SSH_STATE,
            SshStateEvent {
                session_id: req.session_id.clone(),
                state: "connected".to_string(),
                message: Some(format!("已启动本机终端: {}", chosen.label)),
                code: None,
            },
        );

        // Blocking reader thread -> emits IPC_EVENT_SSH_DATA
        let app_reader = app.clone();
        let sid_reader = req.session_id.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut decoder = Utf8StreamDecoder::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let text = decoder.push(&buf[..n]);
                        if !text.is_empty() {
                            let _ = app_reader.emit(
                                IPC_EVENT_SSH_DATA,
                                SshDataEvent {
                                    session_id: sid_reader.clone(),
                                    data: text,
                                },
                            );
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        // Child exit watcher -> cleans up session & emits IPC_EVENT_SSH_STATE
        let app_wait = app.clone();
        let sid_wait = req.session_id;
        let sessions_map = self.sessions.clone();
        tauri::async_runtime::spawn(async move {
            let exit_code = tokio::task::spawn_blocking(move || {
                child.wait().ok().map(|st| st.exit_code() as i32)
            })
            .await
            .ok()
            .flatten();

            let removed = {
                let mut guard = sessions_map.write().await;
                if guard
                    .get(&sid_wait)
                    .is_some_and(|cur| Arc::ptr_eq(&cur.master, &master_arc))
                {
                    guard.remove(&sid_wait)
                } else {
                    None
                }
            };

            closed_notify.notify_waiters();

            if removed.is_some() {
                let was_intentional = intentional_close.load(Ordering::Relaxed);
                let msg = if was_intentional {
                    "本机终端已关闭".to_string()
                } else {
                    format!("本机终端进程已退出 (退出码 {})", exit_code.unwrap_or(0))
                };
                let _ = app_wait.emit(
                    IPC_EVENT_SSH_STATE,
                    SshStateEvent {
                        session_id: sid_wait,
                        state: "disconnected".to_string(),
                        message: Some(msg),
                        code: exit_code,
                    },
                );
            }
        });

        SshConnectResult {
            ok: true,
            error: None,
        }
    }

    pub async fn write(&self, session_id: &str, data: &str) {
        let writer_opt = self
            .sessions
            .read()
            .await
            .get(session_id)
            .map(|s| s.writer.clone());
        if let Some(writer_arc) = writer_opt {
            if let Ok(mut w) = writer_arc.lock() {
                let _ = w.write_all(data.as_bytes());
                let _ = w.flush();
            }
        }
    }

    pub async fn resize(&self, session_id: &str, cols: u16, rows: u16) {
        let master_opt = self
            .sessions
            .read()
            .await
            .get(session_id)
            .map(|s| s.master.clone());
        if let Some(master_arc) = master_opt {
            if let Ok(m) = master_arc.lock() {
                let _ = m.resize(PtySize {
                    rows: rows.max(5),
                    cols: cols.max(20),
                    pixel_width: 0,
                    pixel_height: 0,
                });
            }
        }
    }

    pub async fn disconnect(&self, session_id: &str) {
        let removed = self.sessions.write().await.remove(session_id);
        if let Some(sess) = removed {
            sess.intentional_close.store(true, Ordering::Relaxed);
            sess.closed_notify.notify_waiters();
            if let Ok(mut k) = sess.killer.lock() {
                let _ = k.kill();
            }
        }
    }

    pub async fn disconnect_all(&self) {
        let keys: Vec<String> = self.sessions.read().await.keys().cloned().collect();
        for sid in keys {
            self.disconnect(&sid).await;
        }
    }
}
