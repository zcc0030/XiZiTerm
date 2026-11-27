use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, FileMode};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::models::{
    SftpEntry, SftpListResult, SftpReadTextResult, SftpTransferProgressEvent,
    IPC_EVENT_SFTP_PROGRESS,
};
use crate::services::ssh::SshService;
use crate::services::vault::now_ms;

const MAX_INLINE_TEXT_BYTES: u64 = 2 * 1024 * 1024;

fn format_octal_mode(mode: u32) -> String {
    format!("{:03o}", mode & 0o777)
}

fn format_permissions(mode: u32) -> String {
    let bits = mode & 0o777;
    let chars = ['r', 'w', 'x'];
    let mut out = String::with_capacity(9);
    for i in (0..9).rev() {
        if (bits & (1 << i)) != 0 {
            out.push(chars[(8 - i) % 3]);
        } else {
            out.push('-');
        }
    }
    out
}

fn parse_octal_mode(input: &str) -> Result<u32, String> {
    let cleaned = input.trim();
    if cleaned.len() < 3 || cleaned.len() > 4 || !cleaned.chars().all(|c| ('0'..='7').contains(&c))
    {
        return Err("权限格式无效，请输入 3~4 位八进制数（例如 755 或 0644）".to_string());
    }
    u32::from_str_radix(cleaned, 8).map_err(|_| "解析八进制权限失败".to_string())
}

fn join_posix(base: &str, name: &str) -> String {
    if base == "/" {
        format!("/{name}")
    } else {
        format!("{}/{}", base.trim_end_matches('/'), name)
    }
}

fn parent_posix(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() || trimmed == "/" {
        return None;
    }
    match trimmed.rfind('/') {
        None => None,
        Some(0) => Some("/".to_string()),
        Some(idx) => Some(trimmed[..idx].to_string()),
    }
}

fn basename_posix(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    trimmed
        .rsplit('/')
        .next()
        .unwrap_or(trimmed)
        .to_string()
}

#[derive(Clone)]
pub struct SftpService {
    sessions: Arc<RwLock<HashMap<String, Arc<SftpSession>>>>,
}

impl SftpService {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn drop_session(&self, session_id: &str) {
        self.sessions.write().await.remove(session_id);
    }

    async fn get_sftp(&self, ssh: &SshService, session_id: &str) -> Result<Arc<SftpSession>, String> {
        if !ssh.has_session(session_id).await {
            self.sessions.write().await.remove(session_id);
            return Err("当前 SSH 会话未连接，无法打开 SFTP 通道".to_string());
        }

        if let Some(existing) = self.sessions.read().await.get(session_id).cloned() {
            // Quick liveness check via cached session
            if existing.canonicalize(".").await.is_ok() {
                return Ok(existing);
            }
            self.sessions.write().await.remove(session_id);
        }

        let channel = ssh.open_sftp_channel(session_id).await?;
        let sftp = SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| format!("初始化 SFTP 协议会话失败: {e}"))?;
        let arc = Arc::new(sftp);
        self.sessions
            .write()
            .await
            .insert(session_id.to_string(), arc.clone());
        Ok(arc)
    }

    pub async fn list(
        &self,
        ssh: &SshService,
        session_id: &str,
        remote_path: Option<String>,
    ) -> Result<SftpListResult, String> {
        let sftp = self.get_sftp(ssh, session_id).await?;
        let requested = remote_path.as_deref().map(str::trim).unwrap_or("");
        let target = if requested.is_empty() || requested == "~" {
            "."
        } else {
            requested
        };

        let cwd = sftp
            .canonicalize(target)
            .await
            .map_err(|e| format!("无法解析远程目录路径 ({target}): {e}"))?;
        let read_dir = sftp
            .read_dir(cwd.clone())
            .await
            .map_err(|e| format!("读取远程目录失败 ({cwd}): {e}"))?;

        let mut entries = Vec::new();
        for item in read_dir {
            let name = item.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let full_path = join_posix(&cwd, &name);
            let attrs = item.metadata();
            let raw_mode = attrs.permissions.unwrap_or(0);
            let is_symlink = attrs.is_symlink();
            let mut is_directory = attrs.is_dir();
            let mut size = attrs.size.unwrap_or(0);

            if is_symlink {
                if let Ok(target_meta) = sftp.metadata(full_path.clone()).await {
                    is_directory = target_meta.is_dir();
                    if !is_directory {
                        size = target_meta.size.unwrap_or(size);
                    }
                }
            }

            entries.push(SftpEntry {
                name,
                path: full_path,
                is_directory,
                is_symlink,
                size,
                mode: raw_mode,
                permissions: format_permissions(raw_mode),
                octal_mode: format_octal_mode(raw_mode),
                uid: attrs.uid.unwrap_or(0),
                gid: attrs.gid.unwrap_or(0),
                modified_at: (attrs.mtime.unwrap_or(0) as i64) * 1000,
            });
        }

        entries.sort_by(|a, b| match (a.is_directory, b.is_directory) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });

        Ok(SftpListResult { cwd, entries })
    }

    pub async fn mkdir(
        &self,
        ssh: &SshService,
        session_id: &str,
        remote_path: &str,
    ) -> Result<(), String> {
        let sftp = self.get_sftp(ssh, session_id).await?;
        sftp.create_dir(remote_path)
            .await
            .map_err(|e| format!("创建远程目录失败: {e}"))
    }

    async fn ensure_remote_dir(sftp: &SftpSession, remote_path: &str) -> Result<(), String> {
        if let Ok(meta) = sftp.metadata(remote_path).await {
            if meta.is_dir() {
                return Ok(());
            }
        }
        if let Some(parent) = parent_posix(remote_path) {
            if parent != "/" && parent != remote_path {
                Box::pin(Self::ensure_remote_dir(sftp, &parent)).await?;
            }
        }
        match sftp.create_dir(remote_path).await {
            Ok(()) => Ok(()),
            Err(e) => {
                if let Ok(meta) = sftp.metadata(remote_path).await {
                    if meta.is_dir() {
                        return Ok(());
                    }
                }
                Err(format!("创建远程目录失败 ({remote_path}): {e}"))
            }
        }
    }

    pub async fn create_file(
        &self,
        ssh: &SshService,
        session_id: &str,
        remote_path: &str,
    ) -> Result<(), String> {
        let sftp = self.get_sftp(ssh, session_id).await?;
        sftp.write(remote_path, &[])
            .await
            .map_err(|e| format!("创建远程文件失败: {e}"))
    }

    pub async fn rename(
        &self,
        ssh: &SshService,
        session_id: &str,
        old_path: &str,
        new_path: &str,
    ) -> Result<(), String> {
        let sftp = self.get_sftp(ssh, session_id).await?;
        sftp.rename(old_path, new_path)
            .await
            .map_err(|e| format!("重命名失败: {e}"))
    }

    pub async fn delete_entry(
        &self,
        ssh: &SshService,
        session_id: &str,
        remote_path: &str,
        is_directory: bool,
    ) -> Result<(), String> {
        if remote_path.trim().is_empty() || remote_path.trim() == "/" {
            return Err("拒绝删除根目录".to_string());
        }
        let sftp = self.get_sftp(ssh, session_id).await?;
        if !is_directory {
            return sftp
                .remove_file(remote_path)
                .await
                .map_err(|e| format!("删除文件失败: {e}"));
        }
        Self::delete_dir_recursive(&sftp, remote_path).await
    }

    async fn delete_dir_recursive(sftp: &SftpSession, dir_path: &str) -> Result<(), String> {
        let entries = sftp
            .read_dir(dir_path)
            .await
            .map_err(|e| format!("读取目录失败 ({dir_path}): {e}"))?;

        for entry in entries {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let child_path = join_posix(dir_path, &name);
            let attrs = entry.metadata();
            // Do not follow symlinks when deleting recursively!
            if attrs.is_dir() && !attrs.is_symlink() {
                Box::pin(Self::delete_dir_recursive(sftp, &child_path)).await?;
            } else {
                sftp.remove_file(&child_path)
                    .await
                    .map_err(|e| format!("删除文件失败 ({child_path}): {e}"))?;
            }
        }

        sftp.remove_dir(dir_path)
            .await
            .map_err(|e| format!("删除目录失败 ({dir_path}): {e}"))
    }

    pub async fn chmod(
        &self,
        ssh: &SshService,
        session_id: &str,
        remote_path: &str,
        octal_mode: &str,
    ) -> Result<(), String> {
        let sftp = self.get_sftp(ssh, session_id).await?;
        let mode_bits = parse_octal_mode(octal_mode)?;
        let current = sftp
            .symlink_metadata(remote_path)
            .await
            .map_err(|e| format!("读取目标权限属性失败: {e}"))?;
        let type_bits = current.permissions.unwrap_or(0) & FileMode::all().bits();
        let attrs = FileAttributes {
            permissions: Some(type_bits | (mode_bits & 0o7777)),
            ..Default::default()
        };
        sftp.set_metadata(remote_path, attrs)
            .await
            .map_err(|e| format!("修改权限失败: {e}"))
    }

    pub async fn upload_local_paths(
        &self,
        app: &AppHandle,
        ssh: &SshService,
        session_id: &str,
        local_paths: Vec<String>,
        remote_dir: &str,
    ) -> Result<usize, String> {
        let sftp = self.get_sftp(ssh, session_id).await?;
        let mut uploaded_count = 0usize;

        for raw_local in local_paths {
            let trimmed = raw_local.trim();
            if trimmed.is_empty() {
                continue;
            }
            let local_path = PathBuf::from(trimmed);
            let meta = tokio::fs::metadata(&local_path)
                .await
                .map_err(|e| format!("无法读取本地文件 ({trimmed}): {e}"))?;
            let base_name = local_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .ok_or_else(|| format!("无效的本地路径: {trimmed}"))?;
            let target_remote = join_posix(remote_dir, &base_name);

            if meta.is_dir() {
                uploaded_count += Self::upload_dir_recursive(
                    app,
                    session_id,
                    &sftp,
                    &local_path,
                    &target_remote,
                )
                .await?;
            } else {
                Self::upload_single_file(
                    app,
                    session_id,
                    &sftp,
                    &local_path,
                    &target_remote,
                    meta.len(),
                )
                .await?;
                uploaded_count += 1;
            }
        }

        Ok(uploaded_count)
    }

    async fn upload_dir_recursive(
        app: &AppHandle,
        session_id: &str,
        sftp: &SftpSession,
        local_dir: &Path,
        remote_dir: &str,
    ) -> Result<usize, String> {
        Self::ensure_remote_dir(sftp, remote_dir).await?;
        let mut rd = tokio::fs::read_dir(local_dir)
            .await
            .map_err(|e| format!("读取本地目录失败 ({}): {e}", local_dir.display()))?;
        let mut count = 0usize;

        while let Some(entry) = rd
            .next_entry()
            .await
            .map_err(|e| format!("遍历本地目录失败: {e}"))?
        {
            let local_child = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let remote_child = join_posix(remote_dir, &name);
            let ft = entry
                .file_type()
                .await
                .map_err(|e| format!("读取本地文件类型失败: {e}"))?;

            if ft.is_dir() {
                count += Box::pin(Self::upload_dir_recursive(
                    app,
                    session_id,
                    sftp,
                    &local_child,
                    &remote_child,
                ))
                .await?;
            } else if ft.is_file() {
                let st = entry
                    .metadata()
                    .await
                    .map_err(|e| format!("读取本地文件大小失败: {e}"))?;
                Self::upload_single_file(
                    app,
                    session_id,
                    sftp,
                    &local_child,
                    &remote_child,
                    st.len(),
                )
                .await?;
                count += 1;
            }
        }
        Ok(count)
    }

    async fn upload_single_file(
        app: &AppHandle,
        session_id: &str,
        sftp: &SftpSession,
        local_path: &Path,
        remote_path: &str,
        total_size: u64,
    ) -> Result<(), String> {
        let transfer_id = format!("up_{}", Uuid::new_v4());
        let file_name = local_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| basename_posix(remote_path));
        let local_str = local_path.to_string_lossy().to_string();

        let _ = app.emit(
            IPC_EVENT_SFTP_PROGRESS,
            SftpTransferProgressEvent {
                transfer_id: transfer_id.clone(),
                session_id: session_id.to_string(),
                direction: "upload".to_string(),
                file_name: file_name.clone(),
                remote_path: remote_path.to_string(),
                local_path: local_str.clone(),
                transferred: 0,
                total: total_size,
                status: "running".to_string(),
                error: None,
            },
        );

        let res: Result<(), String> = async {
            let mut local_file = tokio::fs::File::open(local_path)
                .await
                .map_err(|e| format!("打开本地文件失败: {e}"))?;
            let mut remote_file = sftp
                .create(remote_path)
                .await
                .map_err(|e| format!("创建远程文件失败: {e}"))?;

            let mut buf = vec![0u8; 65536];
            let mut transferred = 0u64;
            let mut last_emit = 0i64;

            loop {
                let n = local_file
                    .read(&mut buf)
                    .await
                    .map_err(|e| format!("读取本地文件数据失败: {e}"))?;
                if n == 0 {
                    break;
                }
                remote_file
                    .write_all(&buf[..n])
                    .await
                    .map_err(|e| format!("写入远程文件失败: {e}"))?;
                transferred += n as u64;

                let now = now_ms();
                if now - last_emit >= 80 || transferred >= total_size {
                    last_emit = now;
                    let _ = app.emit(
                        IPC_EVENT_SFTP_PROGRESS,
                        SftpTransferProgressEvent {
                            transfer_id: transfer_id.clone(),
                            session_id: session_id.to_string(),
                            direction: "upload".to_string(),
                            file_name: file_name.clone(),
                            remote_path: remote_path.to_string(),
                            local_path: local_str.clone(),
                            transferred,
                            total: total_size,
                            status: "running".to_string(),
                            error: None,
                        },
                    );
                }
            }

            remote_file
                .shutdown()
                .await
                .map_err(|e| format!("刷新关闭远程文件失败: {e}"))?;
            Ok(())
        }
        .await;

        match res {
            Ok(()) => {
                let _ = app.emit(
                    IPC_EVENT_SFTP_PROGRESS,
                    SftpTransferProgressEvent {
                        transfer_id,
                        session_id: session_id.to_string(),
                        direction: "upload".to_string(),
                        file_name,
                        remote_path: remote_path.to_string(),
                        local_path: local_str,
                        transferred: total_size,
                        total: total_size,
                        status: "completed".to_string(),
                        error: None,
                    },
                );
                Ok(())
            }
            Err(err_msg) => {
                let _ = app.emit(
                    IPC_EVENT_SFTP_PROGRESS,
                    SftpTransferProgressEvent {
                        transfer_id,
                        session_id: session_id.to_string(),
                        direction: "upload".to_string(),
                        file_name,
                        remote_path: remote_path.to_string(),
                        local_path: local_str,
                        transferred: 0,
                        total: total_size,
                        status: "error".to_string(),
                        error: Some(err_msg.clone()),
                    },
                );
                Err(err_msg)
            }
        }
    }

    pub async fn download_file(
        &self,
        app: &AppHandle,
        ssh: &SshService,
        session_id: &str,
        remote_path: &str,
        local_path: &Path,
    ) -> Result<(), String> {
        let sftp = self.get_sftp(ssh, session_id).await?;
        let meta = sftp
            .metadata(remote_path)
            .await
            .map_err(|e| format!("读取远程文件信息失败: {e}"))?;
        let total_size = meta.size.unwrap_or(0);
        let transfer_id = format!("dl_{}", Uuid::new_v4());
        let file_name = basename_posix(remote_path);
        let local_str = local_path.to_string_lossy().to_string();

        let _ = app.emit(
            IPC_EVENT_SFTP_PROGRESS,
            SftpTransferProgressEvent {
                transfer_id: transfer_id.clone(),
                session_id: session_id.to_string(),
                direction: "download".to_string(),
                file_name: file_name.clone(),
                remote_path: remote_path.to_string(),
                local_path: local_str.clone(),
                transferred: 0,
                total: total_size,
                status: "running".to_string(),
                error: None,
            },
        );

        let res: Result<(), String> = async {
            let mut remote_file = sftp
                .open(remote_path)
                .await
                .map_err(|e| format!("打开远程文件失败: {e}"))?;
            let mut local_file = tokio::fs::File::create(local_path)
                .await
                .map_err(|e| format!("创建本地文件失败: {e}"))?;

            let mut buf = vec![0u8; 65536];
            let mut transferred = 0u64;
            let mut last_emit = 0i64;

            loop {
                let n = remote_file
                    .read(&mut buf)
                    .await
                    .map_err(|e| format!("读取远程文件数据失败: {e}"))?;
                if n == 0 {
                    break;
                }
                local_file
                    .write_all(&buf[..n])
                    .await
                    .map_err(|e| format!("写入本地文件失败: {e}"))?;
                transferred += n as u64;

                let now = now_ms();
                if now - last_emit >= 80 || transferred >= total_size {
                    last_emit = now;
                    let _ = app.emit(
                        IPC_EVENT_SFTP_PROGRESS,
                        SftpTransferProgressEvent {
                            transfer_id: transfer_id.clone(),
                            session_id: session_id.to_string(),
                            direction: "download".to_string(),
                            file_name: file_name.clone(),
                            remote_path: remote_path.to_string(),
                            local_path: local_str.clone(),
                            transferred,
                            total: total_size,
                            status: "running".to_string(),
                            error: None,
                        },
                    );
                }
            }

            local_file
                .flush()
                .await
                .map_err(|e| format!("刷新本地文件缓存失败: {e}"))?;
            Ok(())
        }
        .await;

        match res {
            Ok(()) => {
                let _ = app.emit(
                    IPC_EVENT_SFTP_PROGRESS,
                    SftpTransferProgressEvent {
                        transfer_id,
                        session_id: session_id.to_string(),
                        direction: "download".to_string(),
                        file_name,
                        remote_path: remote_path.to_string(),
                        local_path: local_str,
                        transferred: total_size,
                        total: total_size,
                        status: "completed".to_string(),
                        error: None,
                    },
                );
                Ok(())
            }
            Err(err_msg) => {
                let _ = app.emit(
                    IPC_EVENT_SFTP_PROGRESS,
                    SftpTransferProgressEvent {
                        transfer_id,
                        session_id: session_id.to_string(),
                        direction: "download".to_string(),
                        file_name,
                        remote_path: remote_path.to_string(),
                        local_path: local_str,
                        transferred: 0,
                        total: total_size,
                        status: "error".to_string(),
                        error: Some(err_msg.clone()),
                    },
                );
                Err(err_msg)
            }
        }
    }

    pub async fn read_text_file(
        &self,
        ssh: &SshService,
        session_id: &str,
        remote_path: &str,
    ) -> Result<SftpReadTextResult, String> {
        let sftp = self.get_sftp(ssh, session_id).await?;
        let stats = sftp
            .metadata(remote_path)
            .await
            .map_err(|e| format!("读取远程文件属性失败: {e}"))?;
        if stats.is_dir() {
            return Err("不能以文本模式打开目录".to_string());
        }
        let file_size = stats.size.unwrap_or(0);
        if file_size > MAX_INLINE_TEXT_BYTES {
            return Err(format!(
                "文件过大（{:.2} MB），在线编辑器仅支持 2 MB 以内的文本文件",
                file_size as f64 / 1024.0 / 1024.0
            ));
        }

        let bytes = sftp
            .read(remote_path)
            .await
            .map_err(|e| format!("读取远程文件失败: {e}"))?;

        let sample_len = bytes.len().min(8192);
        if bytes[..sample_len].contains(&0u8) {
            return Err("检测到二进制文件内容，请使用下载功能在本地查看".to_string());
        }

        let content = String::from_utf8(bytes.clone())
            .unwrap_or_else(|_| String::from_utf8_lossy(&bytes).to_string());
        let size = bytes.len();

        Ok(SftpReadTextResult {
            path: remote_path.to_string(),
            content,
            size,
        })
    }

    pub async fn write_text_file(
        &self,
        ssh: &SshService,
        session_id: &str,
        remote_path: &str,
        content: &str,
    ) -> Result<(), String> {
        let sftp = self.get_sftp(ssh, session_id).await?;
        sftp.write(remote_path, content.as_bytes())
            .await
            .map_err(|e| format!("保存远程文件失败: {e}"))
    }
}
