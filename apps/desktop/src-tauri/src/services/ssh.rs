use russh::client::{AuthResult, Handle, KeyboardInteractiveAuthResponse, Msg};
use russh::keys::{decode_secret_key, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{Channel, ChannelMsg, ChannelWriteHalf, Disconnect};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::{Notify, RwLock};

use crate::models::{
    SshConnectRequest, SshConnectResult, SshDataEvent, SshStateEvent, SshTestConnectionRequest,
    SshTestConnectionResult, IPC_EVENT_SSH_DATA, IPC_EVENT_SSH_STATE,
};
use crate::services::vault::VaultService;

pub struct SshClientHandler;

impl russh::client::Handler for SshClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

/// Converts streaming byte chunks into valid UTF-8 strings while buffering
/// trailing incomplete multi-byte UTF-8 sequences across packet boundaries.
pub struct Utf8StreamDecoder {
    carry: Vec<u8>,
}

impl Utf8StreamDecoder {
    pub fn new() -> Self {
        Self {
            carry: Vec::with_capacity(4),
        }
    }

    pub fn push(&mut self, chunk: &[u8]) -> String {
        if chunk.is_empty() {
            return String::new();
        }
        let mut combined = Vec::with_capacity(self.carry.len() + chunk.len());
        combined.extend_from_slice(&self.carry);
        combined.extend_from_slice(chunk);
        self.carry.clear();

        let mut out = String::with_capacity(combined.len());
        let mut cursor = &combined[..];

        while !cursor.is_empty() {
            match std::str::from_utf8(cursor) {
                Ok(valid) => {
                    out.push_str(valid);
                    break;
                }
                Err(err) => {
                    let valid_up_to = err.valid_up_to();
                    if valid_up_to > 0 {
                        if let Ok(valid_prefix) = std::str::from_utf8(&cursor[..valid_up_to]) {
                            out.push_str(valid_prefix);
                        }
                    }
                    match err.error_len() {
                        None => {
                            // Incomplete UTF-8 sequence at the very end -> buffer for next packet
                            self.carry.extend_from_slice(&cursor[valid_up_to..]);
                            break;
                        }
                        Some(invalid_len) => {
                            out.push('\u{FFFD}');
                            cursor = &cursor[valid_up_to + invalid_len..];
                        }
                    }
                }
            }
        }
        out
    }
}

pub fn format_ssh_error(raw: &str) -> String {
    let lower = raw.to_lowercase();
    if lower.contains("auth") {
        return "身份认证失败：请检查用户名、密码或 SSH 私钥/Passphrase".to_string();
    }
    if lower.contains("key") && (lower.contains("encrypted") || lower.contains("decrypt") || lower.contains("decode")) {
        return "SSH 私钥解析失败：请检查私钥格式，或确认私钥口令 (Passphrase) 是否正确".to_string();
    }
    if lower.contains("connection refused") || lower.contains("积极拒绝") {
        return "连接被拒绝：请检查目标 IP、端口以及 SSH 服务是否开启".to_string();
    }
    if lower.contains("timed out") || lower.contains("timeout") {
        return "连接超时：无法到达目标服务器，请检查网络或防火墙".to_string();
    }
    if lower.contains("failed to lookup") || lower.contains("no such host") || lower.contains("不知道这样的主机") {
        return "无法解析主机名：请检查域名或 IP 地址是否正确".to_string();
    }
    raw.to_string()
}

pub struct RawSshAuth<'a> {
    pub hostname: &'a str,
    pub port: u16,
    pub username: &'a str,
    pub auth_type: &'a str,
    pub password: Option<&'a str>,
    pub private_key: Option<&'a str>,
    pub passphrase: Option<&'a str>,
    pub keepalive_secs: u64,
    pub connect_timeout: Duration,
}

pub async fn connect_and_authenticate(
    params: RawSshAuth<'_>,
) -> Result<Handle<SshClientHandler>, String> {
    let mut config = russh::client::Config {
        inactivity_timeout: None,
        keepalive_interval: if params.keepalive_secs > 0 {
            Some(Duration::from_secs(params.keepalive_secs))
        } else {
            None
        },
        keepalive_max: 3,
        ..Default::default()
    };
    config.window_size = 2 * 1024 * 1024;
    config.maximum_packet_size = 65535;

    let mut handle = tokio::time::timeout(
        params.connect_timeout,
        russh::client::connect(
            Arc::new(config),
            (params.hostname, params.port),
            SshClientHandler,
        ),
    )
    .await
    .map_err(|_| {
        format!(
            "连接超时：{} 秒内未能完成握手，请检查地址、端口与防火墙",
            params.connect_timeout.as_secs()
        )
    })?
    .map_err(|e| format_ssh_error(&e.to_string()))?;

    if params.auth_type == "password" {
        let pwd = params.password.unwrap_or("");
        let pw_res = handle
            .authenticate_password(params.username, pwd)
            .await
            .map_err(|e| format_ssh_error(&e.to_string()))?;

        if matches!(pw_res, AuthResult::Success) {
            return Ok(handle);
        }

        // Fallback to keyboard-interactive (PAM / Ubuntu / 2FA prompts)
        let mut ki_res = handle
            .authenticate_keyboard_interactive_start(params.username, None::<String>)
            .await
            .map_err(|e| format_ssh_error(&e.to_string()))?;

        for _ in 0..5 {
            match ki_res {
                KeyboardInteractiveAuthResponse::Success => return Ok(handle),
                KeyboardInteractiveAuthResponse::Failure { .. } => break,
                KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                    let responses = vec![pwd.to_string(); prompts.len()];
                    ki_res = handle
                        .authenticate_keyboard_interactive_respond(responses)
                        .await
                        .map_err(|e| format_ssh_error(&e.to_string()))?;
                }
            }
        }

        return Err("身份认证失败：请检查用户名与密码是否正确".to_string());
    }

    let raw_key = params
        .private_key
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "该主机未配置 SSH 私钥内容".to_string())?;

    let pass = params.passphrase.filter(|s| !s.is_empty());
    let decoded_key = decode_secret_key(raw_key, pass).map_err(|e| {
        format!(
            "SSH 私钥解析失败：请检查私钥格式或口令 (Passphrase) 是否正确 ({e})"
        )
    })?;
    let key_arc = Arc::new(decoded_key);

    let best_rsa_hash = if key_arc.algorithm().is_rsa() {
        handle.best_supported_rsa_hash().await.ok().flatten().flatten()
    } else {
        None
    };

    let res = handle
        .authenticate_publickey(
            params.username,
            PrivateKeyWithHashAlg::new(key_arc.clone(), best_rsa_hash),
        )
        .await
        .map_err(|e| format_ssh_error(&e.to_string()))?;

    if matches!(res, AuthResult::Success) {
        return Ok(handle);
    }

    // Fallback to legacy SHA-1 ssh-rsa if modern hash failed on an older SSH daemon
    if key_arc.algorithm().is_rsa() && best_rsa_hash.is_some() {
        let fallback = handle
            .authenticate_publickey(params.username, PrivateKeyWithHashAlg::new(key_arc, None))
            .await
            .map_err(|e| format_ssh_error(&e.to_string()))?;
        if matches!(fallback, AuthResult::Success) {
            return Ok(handle);
        }
    }

    Err("公钥认证被服务器拒绝：请确认服务器 ~/.ssh/authorized_keys 已添加对应公钥".to_string())
}

pub async fn exec_on_handle(
    handle: &Handle<SshClientHandler>,
    command: &str,
    timeout: Duration,
) -> Result<(i32, String, String), String> {
    let fut = async {
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("打开命令通道失败: {e}"))?;
        channel
            .exec(true, command)
            .await
            .map_err(|e| format!("发送远程命令失败: {e}"))?;

        let mut stdout_dec = Utf8StreamDecoder::new();
        let mut stderr_dec = Utf8StreamDecoder::new();
        let mut stdout = String::new();
        let mut stderr = String::new();
        let mut exit_code = 0i32;

        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => {
                    stdout.push_str(&stdout_dec.push(&data));
                }
                ChannelMsg::ExtendedData { data, .. } => {
                    stderr.push_str(&stderr_dec.push(&data));
                }
                ChannelMsg::ExitStatus { exit_status } => {
                    exit_code = exit_status as i32;
                }
                ChannelMsg::Close | ChannelMsg::Eof => {}
                _ => {}
            }
        }
        Ok::<(i32, String, String), String>((exit_code, stdout, stderr))
    };

    tokio::time::timeout(timeout, fut)
        .await
        .map_err(|_| "远程命令执行超时".to_string())?
}

struct ActiveSshSession {
    handle: Arc<Handle<SshClientHandler>>,
    writer: ChannelWriteHalf<Msg>,
    intentional_close: Arc<AtomicBool>,
    closed_notify: Arc<Notify>,
}

#[derive(Clone)]
pub struct SshService {
    sessions: Arc<RwLock<HashMap<String, ActiveSshSession>>>,
}

impl SshService {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
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

    pub async fn open_sftp_channel(&self, session_id: &str) -> Result<Channel<Msg>, String> {
        let handle = {
            let guard = self.sessions.read().await;
            guard
                .get(session_id)
                .map(|s| s.handle.clone())
                .ok_or_else(|| "当前 SSH 会话未连接，无法打开 SFTP 通道".to_string())?
        };
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("打开 SFTP 会话通道失败: {e}"))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| format!("启动 SFTP 子系统失败: {e}"))?;
        Ok(channel)
    }

    pub async fn exec_command(
        &self,
        session_id: &str,
        command: &str,
        timeout_ms: u64,
    ) -> Result<String, String> {
        let handle = {
            let guard = self.sessions.read().await;
            guard
                .get(session_id)
                .map(|s| s.handle.clone())
                .ok_or_else(|| "当前 SSH 会话未连接".to_string())?
        };
        let (_code, stdout, stderr) =
            exec_on_handle(&handle, command, Duration::from_millis(timeout_ms)).await?;
        if stdout.is_empty() && !stderr.trim().is_empty() {
            return Err(stderr.trim().to_string());
        }
        Ok(stdout)
    }

    pub async fn connect(
        &self,
        app: &AppHandle,
        vault: &VaultService,
        req: SshConnectRequest,
    ) -> SshConnectResult {
        let host = match vault.get_host_by_id(&req.host_id).await {
            Ok(Some(h)) => h,
            Ok(None) => {
                return SshConnectResult {
                    ok: false,
                    error: Some("找不到主机配置，或保险库已锁定".to_string()),
                };
            }
            Err(e) => {
                return SshConnectResult {
                    ok: false,
                    error: Some(e),
                };
            }
        };

        if self.has_session(&req.session_id).await {
            self.disconnect(&req.session_id).await;
        }

        let _ = app.emit(
            IPC_EVENT_SSH_STATE,
            SshStateEvent {
                session_id: req.session_id.clone(),
                state: "connecting".to_string(),
                message: Some(format!(
                    "正在连接 {}@{}:{} ...",
                    host.username, host.hostname, host.port
                )),
                code: None,
            },
        );

        let handle = match connect_and_authenticate(RawSshAuth {
            hostname: &host.hostname,
            port: host.port,
            username: &host.username,
            auth_type: &host.auth_type,
            password: host.password.as_deref(),
            private_key: host.private_key.as_deref(),
            passphrase: host.passphrase.as_deref(),
            keepalive_secs: host.keep_alive_interval,
            connect_timeout: Duration::from_secs(20),
        })
        .await
        {
            Ok(h) => Arc::new(h),
            Err(err_msg) => {
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
        };

        let cols = req.cols.max(20) as u32;
        let rows = req.rows.max(5) as u32;

        let channel = match handle.channel_open_session().await {
            Ok(ch) => ch,
            Err(e) => {
                let msg = format!("打开 SSH 会话通道失败: {e}");
                let _ = app.emit(
                    IPC_EVENT_SSH_STATE,
                    SshStateEvent {
                        session_id: req.session_id,
                        state: "error".to_string(),
                        message: Some(msg.clone()),
                        code: None,
                    },
                );
                return SshConnectResult {
                    ok: false,
                    error: Some(msg),
                };
            }
        };

        if let Err(e) = channel
            .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
            .await
        {
            let msg = format!("请求远程 PTY 失败: {e}");
            let _ = app.emit(
                IPC_EVENT_SSH_STATE,
                SshStateEvent {
                    session_id: req.session_id,
                    state: "error".to_string(),
                    message: Some(msg.clone()),
                    code: None,
                },
            );
            return SshConnectResult {
                ok: false,
                error: Some(msg),
            };
        }

        if let Err(e) = channel.request_shell(true).await {
            let msg = format!("启动远程 Shell 失败: {e}");
            let _ = app.emit(
                IPC_EVENT_SSH_STATE,
                SshStateEvent {
                    session_id: req.session_id,
                    state: "error".to_string(),
                    message: Some(msg.clone()),
                    code: None,
                },
            );
            return SshConnectResult {
                ok: false,
                error: Some(msg),
            };
        }

        let (mut rx, writer) = channel.split();
        let intentional_close = Arc::new(AtomicBool::new(false));
        let closed_notify = Arc::new(Notify::new());

        let active = ActiveSshSession {
            handle: handle.clone(),
            writer,
            intentional_close: intentional_close.clone(),
            closed_notify: closed_notify.clone(),
        };

        self.sessions
            .write()
            .await
            .insert(req.session_id.clone(), active);

        let _ = app.emit(
            IPC_EVENT_SSH_STATE,
            SshStateEvent {
                session_id: req.session_id.clone(),
                state: "connected".to_string(),
                message: Some(format!(
                    "已连接到 {}@{}:{}",
                    host.username, host.hostname, host.port
                )),
                code: None,
            },
        );

        let sessions_map = self.sessions.clone();
        let app_clone = app.clone();
        let sid = req.session_id.clone();

        tauri::async_runtime::spawn(async move {
            let mut decoder = Utf8StreamDecoder::new();
            let mut exit_code: Option<i32> = None;

            while let Some(msg) = rx.wait().await {
                match msg {
                    ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                        let text = decoder.push(&data);
                        if !text.is_empty() {
                            let _ = app_clone.emit(
                                IPC_EVENT_SSH_DATA,
                                SshDataEvent {
                                    session_id: sid.clone(),
                                    data: text,
                                },
                            );
                        }
                    }
                    ChannelMsg::ExitStatus { exit_status } => {
                        exit_code = Some(exit_status as i32);
                    }
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }

            let removed = {
                let mut guard = sessions_map.write().await;
                if guard
                    .get(&sid)
                    .is_some_and(|cur| Arc::ptr_eq(&cur.handle, &handle))
                {
                    guard.remove(&sid)
                } else {
                    None
                }
            };

            closed_notify.notify_waiters();

            if removed.is_some() {
                let _ = handle
                    .disconnect(Disconnect::ByApplication, "closed", "en")
                    .await;
                let was_intentional = intentional_close.load(Ordering::Relaxed);
                let _ = app_clone.emit(
                    IPC_EVENT_SSH_STATE,
                    SshStateEvent {
                        session_id: sid,
                        state: "disconnected".to_string(),
                        message: Some(if was_intentional {
                            "会话已关闭".to_string()
                        } else {
                            "SSH 会话已断开".to_string()
                        }),
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
        let guard = self.sessions.read().await;
        if let Some(sess) = guard.get(session_id) {
            let _ = sess.writer.data(data.as_bytes()).await;
        }
    }

    pub async fn resize(&self, session_id: &str, cols: u16, rows: u16) {
        let guard = self.sessions.read().await;
        if let Some(sess) = guard.get(session_id) {
            let _ = sess
                .writer
                .window_change(cols.max(20) as u32, rows.max(5) as u32, 0, 0)
                .await;
        }
    }

    pub async fn disconnect(&self, session_id: &str) {
        let removed = self.sessions.write().await.remove(session_id);
        if let Some(sess) = removed {
            sess.intentional_close.store(true, Ordering::Relaxed);
            sess.closed_notify.notify_waiters();
            let _ = sess.writer.eof().await;
            let _ = sess.writer.close().await;
            let _ = sess
                .handle
                .disconnect(Disconnect::ByApplication, "user disconnect", "en")
                .await;
        }
    }

    pub async fn disconnect_all(&self) {
        let keys: Vec<String> = self.sessions.read().await.keys().cloned().collect();
        for sid in keys {
            self.disconnect(&sid).await;
        }
    }

    pub async fn test_connection(
        &self,
        req: SshTestConnectionRequest,
    ) -> SshTestConnectionResult {
        let hostname = req.hostname.trim();
        let username = req.username.trim();
        if hostname.is_empty() {
            return SshTestConnectionResult {
                ok: false,
                latency_ms: None,
                remote_info: None,
                error: Some("请先输入主机地址 (IP 或域名)".to_string()),
            };
        }
        if req.port < 1 || req.port > 65535 {
            return SshTestConnectionResult {
                ok: false,
                latency_ms: None,
                remote_info: None,
                error: Some("端口必须是 1-65535 之间的整数".to_string()),
            };
        }
        if username.is_empty() {
            return SshTestConnectionResult {
                ok: false,
                latency_ms: None,
                remote_info: None,
                error: Some("请先输入 SSH 用户名".to_string()),
            };
        }
        if req.auth_type == "privateKey"
            && req
                .private_key
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .is_empty()
        {
            return SshTestConnectionResult {
                ok: false,
                latency_ms: None,
                remote_info: None,
                error: Some("请粘贴或导入 SSH 私钥内容后再测试".to_string()),
            };
        }

        let started = Instant::now();
        let handle = match connect_and_authenticate(RawSshAuth {
            hostname,
            port: req.port as u16,
            username,
            auth_type: &req.auth_type,
            password: req.password.as_deref(),
            private_key: req.private_key.as_deref(),
            passphrase: req.passphrase.as_deref(),
            keepalive_secs: 0,
            connect_timeout: Duration::from_secs(10),
        })
        .await
        {
            Ok(h) => h,
            Err(err_msg) => {
                return SshTestConnectionResult {
                    ok: false,
                    latency_ms: None,
                    remote_info: None,
                    error: Some(err_msg),
                };
            }
        };

        let latency_ms = started.elapsed().as_millis() as u64;
        let remote_info = exec_on_handle(&handle, "uname -srm 2>/dev/null", Duration::from_secs(2))
            .await
            .ok()
            .and_then(|(_code, stdout, _stderr)| {
                stdout
                    .lines()
                    .next()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|s| s.chars().take(80).collect::<String>())
            });

        let _ = handle
            .disconnect(Disconnect::ByApplication, "test ok", "en")
            .await;

        SshTestConnectionResult {
            ok: true,
            latency_ms: Some(latency_ms),
            remote_info,
            error: None,
        }
    }
}
