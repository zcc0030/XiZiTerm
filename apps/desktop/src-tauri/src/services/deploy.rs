use reqwest::Client;
use russh::{ChannelMsg, Disconnect};
use russh_sftp::client::SftpSession;
use serde::Deserialize;
use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::models::{
    ExportBundleResult, SyncDeployLogEvent, SyncDeployTemplates, SyncOneClickDeployPayload,
    SyncOneClickDeployResult, IPC_EVENT_DEPLOY_LOG,
};
use crate::services::ssh::{connect_and_authenticate, RawSshAuth, SshClientHandler, Utf8StreamDecoder};
use crate::services::vault::now_ms;

const EMBEDDED_BUNDLE_FILES: &[(&str, &str)] = &[
    ("package.json", include_str!("../../../../../package.json")),
    (
        "tsconfig.base.json",
        include_str!("../../../../../tsconfig.base.json"),
    ),
    (
        "docker-compose.yml",
        include_str!("../../../../../docker-compose.yml"),
    ),
    (
        "packages/shared/package.json",
        include_str!("../../../../../packages/shared/package.json"),
    ),
    (
        "packages/shared/tsconfig.json",
        include_str!("../../../../../packages/shared/tsconfig.json"),
    ),
    (
        "packages/shared/src/index.ts",
        include_str!("../../../../../packages/shared/src/index.ts"),
    ),
    (
        "packages/shared/src/crypto/constants.ts",
        include_str!("../../../../../packages/shared/src/crypto/constants.ts"),
    ),
    (
        "packages/shared/src/ipc/channels.ts",
        include_str!("../../../../../packages/shared/src/ipc/channels.ts"),
    ),
    (
        "packages/shared/src/types/monitor.ts",
        include_str!("../../../../../packages/shared/src/types/monitor.ts"),
    ),
    (
        "packages/shared/src/types/sftp.ts",
        include_str!("../../../../../packages/shared/src/types/sftp.ts"),
    ),
    (
        "packages/shared/src/types/ssh.ts",
        include_str!("../../../../../packages/shared/src/types/ssh.ts"),
    ),
    (
        "packages/shared/src/types/sync.ts",
        include_str!("../../../../../packages/shared/src/types/sync.ts"),
    ),
    (
        "packages/shared/src/types/vault.ts",
        include_str!("../../../../../packages/shared/src/types/vault.ts"),
    ),
    (
        "apps/server/package.json",
        include_str!("../../../../../apps/server/package.json"),
    ),
    (
        "apps/server/tsconfig.json",
        include_str!("../../../../../apps/server/tsconfig.json"),
    ),
    (
        "apps/server/Dockerfile",
        include_str!("../../../../../apps/server/Dockerfile"),
    ),
    (
        "apps/server/docker-compose.yml",
        include_str!("../../../../../apps/server/docker-compose.yml"),
    ),
    (
        "apps/server/.env.example",
        include_str!("../../../../../apps/server/.env.example"),
    ),
    (
        "apps/server/src/config.ts",
        include_str!("../../../../../apps/server/src/config.ts"),
    ),
    (
        "apps/server/src/index.ts",
        include_str!("../../../../../apps/server/src/index.ts"),
    ),
    (
        "apps/server/src/db/database.ts",
        include_str!("../../../../../apps/server/src/db/database.ts"),
    ),
    (
        "apps/server/src/routes/auth.routes.ts",
        include_str!("../../../../../apps/server/src/routes/auth.routes.ts"),
    ),
    (
        "apps/server/src/routes/sync.routes.ts",
        include_str!("../../../../../apps/server/src/routes/sync.routes.ts"),
    ),
    (
        "apps/server/src/utils/password.ts",
        include_str!("../../../../../apps/server/src/utils/password.ts"),
    ),
];

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn posix_join(base: &str, rel: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), rel.trim_start_matches('/'))
}

fn posix_dirname(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        None | Some(0) => "/".to_string(),
        Some(idx) => trimmed[..idx].to_string(),
    }
}

#[derive(Clone)]
pub struct DeployService {
    running: Arc<AtomicBool>,
    http: Client,
}

impl DeployService {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            http: Client::builder()
                .timeout(Duration::from_secs(8))
                .build()
                .unwrap_or_default(),
        }
    }

    fn emit_log(app: &AppHandle, deploy_id: &str, level: &str, message: impl Into<String>) {
        let _ = app.emit(
            IPC_EVENT_DEPLOY_LOG,
            SyncDeployLogEvent {
                deploy_id: deploy_id.to_string(),
                level: level.to_string(),
                message: message.into(),
                timestamp: now_ms(),
            },
        );
    }

    pub fn get_deploy_templates(&self) -> SyncDeployTemplates {
        SyncDeployTemplates {
            dockerfile: include_str!("../../../../../apps/server/Dockerfile").to_string(),
            docker_compose: include_str!("../../../../../docker-compose.yml").to_string(),
            env_example: include_str!("../../../../../apps/server/.env.example").to_string(),
        }
    }

    pub async fn export_deploy_bundle(&self, dest_parent_dir: &Path) -> Result<ExportBundleResult, String> {
        let target_dir = dest_parent_dir.join("xiziterm-sync-deploy");
        tokio::fs::create_dir_all(target_dir.join("apps/server/data"))
            .await
            .map_err(|e| format!("创建导出目录失败: {e}"))?;

        for (rel, content) in EMBEDDED_BUNDLE_FILES {
            let dst = target_dir.join(rel);
            if let Some(parent) = dst.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|e| format!("创建子目录失败: {e}"))?;
            }
            tokio::fs::write(&dst, content.as_bytes())
                .await
                .map_err(|e| format!("写入部署文件失败 ({rel}): {e}"))?;
        }

        let env_example = include_str!("../../../../../apps/server/.env.example");
        tokio::fs::write(target_dir.join(".env"), env_example.as_bytes())
            .await
            .map_err(|e| format!("写入 .env 文件失败: {e}"))?;

        Ok(ExportBundleResult {
            target_dir: target_dir.to_string_lossy().to_string(),
            file_count: EMBEDDED_BUNDLE_FILES.len() + 1,
        })
    }

    async fn exec_remote(
        app: &AppHandle,
        deploy_id: &str,
        handle: &russh::client::Handle<SshClientHandler>,
        username: &str,
        password: &str,
        cmd: &str,
        use_sudo: bool,
        stream_output: bool,
    ) -> Result<(i32, String, String), String> {
        let is_root = username == "root";
        let quoted_cmd = shell_quote(cmd);
        let actual_cmd = if use_sudo && !is_root {
            format!("sudo -S -p '' bash -lc {quoted_cmd}")
        } else {
            format!("bash -lc {quoted_cmd}")
        };

        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("打开远程执行通道失败: {e}"))?;
        channel
            .exec(true, actual_cmd)
            .await
            .map_err(|e| format!("执行远程命令失败: {e}"))?;

        if use_sudo && !is_root {
            let sudo_in = format!("{password}\n");
            let _ = channel.data(sudo_in.as_bytes()).await;
            let _ = channel.eof().await;
        }

        let mut out_dec = Utf8StreamDecoder::new();
        let mut err_dec = Utf8StreamDecoder::new();
        let mut stdout = String::new();
        let mut stderr = String::new();
        let mut line_buf = String::new();
        let mut exit_code = 0i32;

        let mut flush_lines = |chunk_str: &str| {
            line_buf.push_str(chunk_str);
            while let Some(pos) = line_buf.find('\n') {
                let line = line_buf[..pos].trim().to_string();
                line_buf = line_buf[pos + 1..].to_string();
                if !line.is_empty() && stream_output {
                    Self::emit_log(app, deploy_id, "info", line);
                }
            }
        };

        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => {
                    let s = out_dec.push(&data);
                    stdout.push_str(&s);
                    flush_lines(&s);
                }
                ChannelMsg::ExtendedData { data, .. } => {
                    let s = err_dec.push(&data);
                    stderr.push_str(&s);
                    flush_lines(&s);
                }
                ChannelMsg::ExitStatus { exit_status } => {
                    exit_code = exit_status as i32;
                }
                ChannelMsg::Close => break,
                _ => {}
            }
        }

        let rem = line_buf.trim();
        if !rem.is_empty() && stream_output {
            Self::emit_log(app, deploy_id, "info", rem);
        }

        Ok((exit_code, stdout, stderr))
    }

    pub async fn one_click_deploy(
        &self,
        app: &AppHandle,
        payload: SyncOneClickDeployPayload,
    ) -> Result<SyncOneClickDeployResult, String> {
        if self
            .running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("当前已有部署任务正在运行，请等待完成".to_string());
        }

        struct RunningGuard(Arc<AtomicBool>);
        impl Drop for RunningGuard {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let _guard = RunningGuard(self.running.clone());

        let host = payload.host.trim().to_string();
        let username = payload.username.trim().to_string();
        let password = payload.password;
        let ssh_port = if payload.ssh_port <= 0 {
            22
        } else {
            payload.ssh_port
        };
        let sync_port = if payload.sync_port <= 0 {
            8787
        } else {
            payload.sync_port
        };
        let raw_remote_dir = if payload.remote_dir.trim().is_empty() {
            "~/xiziterm-sync".to_string()
        } else {
            payload.remote_dir.trim().to_string()
        };

        if host.is_empty() {
            return Err("请输入 VPS IP 或域名".to_string());
        }
        if username.is_empty() {
            return Err("请输入 VPS SSH 用户名".to_string());
        }
        if password.is_empty() {
            return Err("请输入 VPS SSH 密码".to_string());
        }
        if !(1..=65535).contains(&ssh_port) {
            return Err("SSH 端口必须在 1-65535 之间".to_string());
        }
        if !(1024..=65535).contains(&sync_port) {
            return Err("云同步服务端口建议在 1024-65535 之间（避免系统保留端口）".to_string());
        }

        let deploy_id = format!("deploy_{}", Uuid::new_v4());

        let outcome: Result<SyncOneClickDeployResult, String> = async {
            Self::emit_log(
                app,
                &deploy_id,
                "step",
                format!("[1/6] 正在通过 SSH 连接 {username}@{host}:{ssh_port} ..."),
            );

            let handle = connect_and_authenticate(RawSshAuth {
                hostname: &host,
                port: ssh_port as u16,
                username: &username,
                auth_type: "password",
                password: Some(&password),
                private_key: None,
                passphrase: None,
                keepalive_secs: 15,
                connect_timeout: Duration::from_secs(20),
            })
            .await?;

            Self::emit_log(app, &deploy_id, "success", "SSH 连接认证成功");

            let (_c, env_stdout, _) = Self::exec_remote(
                app,
                &deploy_id,
                &handle,
                &username,
                &password,
                "echo \"HOME=$HOME\"; grep -m1 \"^PRETTY_NAME=\" /etc/os-release 2>/dev/null || uname -a",
                false,
                false,
            )
            .await?;

            let remote_home = env_stdout
                .lines()
                .find_map(|l| l.strip_prefix("HOME="))
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from)
                .unwrap_or_else(|| format!("/home/{username}"));

            let remote_dir = if let Some(rest) = raw_remote_dir.strip_prefix("~/") {
                posix_join(&remote_home, rest)
            } else if raw_remote_dir == "~" {
                posix_join(&remote_home, "xiziterm-sync")
            } else {
                raw_remote_dir.clone()
            };

            let os_line = env_stdout
                .lines()
                .find_map(|l| l.strip_prefix("PRETTY_NAME="))
                .map(|s| s.trim_matches('"').to_string())
                .unwrap_or_else(|| "Linux".to_string());

            Self::emit_log(
                app,
                &deploy_id,
                "info",
                format!("目标系统: {os_line} · 部署路径: {remote_dir}"),
            );

            // Step 2: Check port conflict
            Self::emit_log(
                app,
                &deploy_id,
                "step",
                format!("[2/6] 检测端口 {sync_port} 是否被其他服务占用..."),
            );
            let (_, port_stdout, _) = Self::exec_remote(
                app,
                &deploy_id,
                &handle,
                &username,
                &password,
                &format!("ss -tln 2>/dev/null | grep -E ':{sync_port}[[:space:]]' || true"),
                false,
                false,
            )
            .await?;

            let (_, container_stdout, _) = Self::exec_remote(
                app,
                &deploy_id,
                &handle,
                &username,
                &password,
                "docker ps --filter \"name=sync-server\" --format \"{{.Names}} {{.Ports}}\" 2>/dev/null || true",
                true,
                false,
            )
            .await?;

            let is_own_container = (container_stdout.contains("xiziterm-sync-server")
                || container_stdout.contains("nexusterm-sync-server"))
                && container_stdout.contains(&format!(":{sync_port}->"));

            if !port_stdout.trim().is_empty() && !is_own_container {
                let _ = handle
                    .disconnect(Disconnect::ByApplication, "port conflict", "en")
                    .await;
                return Err(format!(
                    "端口 {sync_port} 已被 VPS 上其他服务占用，已中止部署以避免干扰原服务，请更换其他同步端口后重试！"
                ));
            }
            Self::emit_log(
                app,
                &deploy_id,
                "success",
                format!("端口 {sync_port} 检查通过，不会冲突"),
            );

            // Step 3: Check or install Docker + Compose v2
            Self::emit_log(
                app,
                &deploy_id,
                "step",
                "[3/6] 检测 Docker 与 Docker Compose 环境...",
            );
            let (dc_code, dc_out, _) = Self::exec_remote(
                app,
                &deploy_id,
                &handle,
                &username,
                &password,
                "docker --version && docker compose version",
                false,
                false,
            )
            .await?;

            if dc_code != 0 {
                Self::emit_log(
                    app,
                    &deploy_id,
                    "warn",
                    "未检测到完整 Docker / Compose v2 环境，正在尝试通过 apt 自动安装（Ubuntu / Debian）...",
                );
                let install_cmd = format!(
                    "if ! command -v apt-get >/dev/null 2>&1; then echo \"UNSUPPORTED_DISTRO\"; exit 2; fi; DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose-v2 && systemctl enable --now docker && (usermod -aG docker {} || true)",
                    shell_quote(&username)
                );
                let (inst_code, inst_out, _) = Self::exec_remote(
                    app,
                    &deploy_id,
                    &handle,
                    &username,
                    &password,
                    &install_cmd,
                    true,
                    true,
                )
                .await?;
                if inst_code != 0 {
                    let _ = handle
                        .disconnect(Disconnect::ByApplication, "docker install err", "en")
                        .await;
                    if inst_out.contains("UNSUPPORTED_DISTRO") {
                        return Err("目标服务器不是 Ubuntu/Debian（无 apt-get），请先手动安装 Docker 与 Docker Compose v2 后再重试".to_string());
                    }
                    return Err(format!(
                        "安装 Docker 失败（退出码 {inst_code}），请确认该用户具有 sudo 权限且网络正常"
                    ));
                }
                Self::emit_log(app, &deploy_id, "success", "Docker 与 Docker Compose v2 安装完成");
            } else {
                Self::emit_log(
                    app,
                    &deploy_id,
                    "success",
                    format!(
                        "已就绪: {}",
                        dc_out.lines().map(str::trim).collect::<Vec<_>>().join(" | ")
                    ),
                );
            }

            // Step 4: Upload embedded sync server bundle via SFTP
            Self::emit_log(
                app,
                &deploy_id,
                "step",
                format!(
                    "[4/6] 上传云同步服务端源码与 Docker 配置 ({} 个文件)...",
                    EMBEDDED_BUNDLE_FILES.len()
                ),
            );

            let mut dir_set = HashSet::new();
            dir_set.insert(remote_dir.clone());
            dir_set.insert(posix_join(&remote_dir, "apps/server/data"));
            for (rel, _) in EMBEDDED_BUNDLE_FILES {
                dir_set.insert(posix_dirname(&posix_join(&remote_dir, rel)));
            }
            let mkdir_args = dir_set
                .iter()
                .map(|d| shell_quote(d))
                .collect::<Vec<_>>()
                .join(" ");
            let (mk_code, _, mk_err) = Self::exec_remote(
                app,
                &deploy_id,
                &handle,
                &username,
                &password,
                &format!("mkdir -p {mkdir_args}"),
                false,
                false,
            )
            .await?;
            if mk_code != 0 {
                return Err(format!("创建远程目录失败: {mk_err}"));
            }

            let sftp_ch = handle
                .channel_open_session()
                .await
                .map_err(|e| format!("打开 SFTP 通道失败: {e}"))?;
            sftp_ch
                .request_subsystem(true, "sftp")
                .await
                .map_err(|e| format!("启动 SFTP 子系统失败: {e}"))?;
            let sftp = SftpSession::new(sftp_ch.into_stream())
                .await
                .map_err(|e| format!("初始化部署 SFTP 失败: {e}"))?;

            for (rel, content) in EMBEDDED_BUNDLE_FILES {
                let target_file = posix_join(&remote_dir, rel);
                sftp.write(target_file, content.as_bytes())
                    .await
                    .map_err(|e| format!("上传文件失败 ({rel}): {e}"))?;
            }

            let invite = payload.invite_code.as_deref().unwrap_or("").trim();
            let env_content = format!(
                "XIZITERM_PORT={sync_port}\nALLOW_REGISTRATION=true\nINVITE_CODE={invite}\nTOKEN_TTL_DAYS=365\nLOG_LEVEL=info\n"
            );
            sftp.write(posix_join(&remote_dir, ".env"), env_content.as_bytes())
                .await
                .map_err(|e| format!("写入远程 .env 失败: {e}"))?;
            let _ = sftp.close().await;

            Self::emit_log(app, &deploy_id, "success", "服务端文件上传与 .env 配置写入完成");

            // Step 5: docker compose up -d --build
            Self::emit_log(
                app,
                &deploy_id,
                "step",
                format!("[5/6] 执行 docker compose up -d --build（端口 {sync_port}，首次构建约需 15~45 秒）..."),
            );
            let up_cmd = format!("cd {} && docker compose up -d --build", shell_quote(&remote_dir));
            let (up_code, _, _) = Self::exec_remote(
                app,
                &deploy_id,
                &handle,
                &username,
                &password,
                &up_cmd,
                true,
                true,
            )
            .await?;
            if up_code != 0 {
                return Err(format!("Docker 构建或启动失败（退出码 {up_code}）"));
            }
            Self::emit_log(app, &deploy_id, "success", "容器 xiziterm-sync-server 已启动");

            // Step 6: Verify health
            Self::emit_log(
                app,
                &deploy_id,
                "step",
                format!("[6/6] 验证服务端健康状态与本机到 http://{host}:{sync_port} 的连通性..."),
            );
            tokio::time::sleep(Duration::from_millis(2500)).await;

            let (hc_code, hc_out, hc_err) = Self::exec_remote(
                app,
                &deploy_id,
                &handle,
                &username,
                &password,
                &format!("curl -fsS http://127.0.0.1:{sync_port}/api/health"),
                false,
                false,
            )
            .await?;

            let _ = handle
                .disconnect(Disconnect::ByApplication, "deploy complete", "en")
                .await;

            let remote_health_ok = hc_code == 0 && hc_out.contains("\"ok\"");
            if !remote_health_ok {
                return Err(format!(
                    "容器已启动但健康检查未通过: {}",
                    if hc_err.trim().is_empty() {
                        hc_out.trim()
                    } else {
                        hc_err.trim()
                    }
                ));
            }
            Self::emit_log(
                app,
                &deploy_id,
                "success",
                format!("VPS 内部健康检查通过: {}", hc_out.trim()),
            );

            let server_url = format!("http://{host}:{sync_port}");
            let mut client_reachable = false;
            let mut version = None;
            let mut warning = None;

            #[derive(Deserialize)]
            struct HealthJson {
                status: Option<String>,
                version: Option<String>,
            }

            if let Ok(resp) = self.http.get(format!("{server_url}/api/health")).send().await {
                if resp.status().is_success() {
                    if let Ok(json) = resp.json::<HealthJson>().await {
                        if json.status.as_deref() == Some("ok") {
                            client_reachable = true;
                            version = json.version;
                        }
                    }
                }
            }

            if client_reachable {
                Self::emit_log(
                    app,
                    &deploy_id,
                    "success",
                    format!("本机直连测试通过！云同步地址: {server_url}"),
                );
            } else {
                let w = format!(
                    "服务端已在 VPS 内部运行正常，但当前电脑无法直连 {server_url}。请在云厂商安全组或 VPS 防火墙放行 TCP {sync_port} 端口。"
                );
                Self::emit_log(app, &deploy_id, "warn", w.clone());
                warning = Some(w);
            }

            Ok(SyncOneClickDeployResult {
                server_url,
                remote_health_ok,
                client_reachable,
                version,
                warning,
            })
        }
        .await;

        if let Err(ref err_msg) = outcome {
            Self::emit_log(app, &deploy_id, "error", err_msg.clone());
        }
        outcome
    }
}
