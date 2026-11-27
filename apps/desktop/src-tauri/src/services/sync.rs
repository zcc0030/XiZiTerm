use reqwest::{Client, Method};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, RwLock};

use crate::models::{
    ServerHealthInfo, SyncAuthResponse, SyncBindCredentials, SyncBindTokenPayload, SyncMeResponse,
    SyncNowOptions, SyncOptionsPatch, SyncPullResponse, SyncPushResponse, SyncRestorePayload,
    SyncRunResult, SyncStateChangedEvent, SyncStatusInfo, SyncWebDavBindPayload,
    SyncWebDavTestPayload, SyncWebDavTestResult, VaultData, WebDavVaultBundle,
    IPC_EVENT_SYNC_STATE,
};
use crate::services::crypto::SCHEMA_VERSION;
use crate::services::secret_store::{
    clear_sync_secret, load_sync_secret, save_sync_secret, StoredSyncSecret,
};
use crate::services::vault::{now_ms, RemoteInitParams, SyncMetaPatch, VaultService};
use crate::services::webdav::{
    get_webdav_vault_bundle, normalize_webdav_target, put_webdav_vault_bundle,
    test_webdav_connection, WebDavConnectionConfig, WebDavGetResult, WebDavPutError,
};

pub const REMOTE_MASTER_PASSWORD_REQUIRED_PREFIX: &str = "NEED_REMOTE_MASTER_PASSWORD:";

fn normalize_server_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Err("服务器地址必须以 http:// 或 https:// 开头".to_string());
    }
    Ok(trimmed.to_string())
}

#[derive(Deserialize)]
struct ErrorReply {
    error: Option<String>,
}

#[derive(Deserialize)]
struct HealthReply {
    status: Option<String>,
    version: Option<String>,
    timestamp: Option<i64>,
}

async fn http_json<T: DeserializeOwned>(
    client: &Client,
    method: Method,
    url: &str,
    token: Option<&str>,
    body: Option<serde_json::Value>,
    timeout_ms: u64,
) -> Result<T, String> {
    let mut req = client
        .request(method, url)
        .timeout(Duration::from_millis(timeout_ms))
        .header("Accept", "application/json");

    if let Some(tok) = token {
        req = req.header("Authorization", format!("Bearer {tok}"));
    }
    if let Some(b) = body {
        req = req.json(&b);
    }

    let res = req.send().await.map_err(|e| {
        if e.is_timeout() {
            "连接云同步服务器超时，请检查地址与网络".to_string()
        } else {
            format!("请求云同步服务器失败: {e}")
        }
    })?;

    let status = res.status();
    let text = res.text().await.unwrap_or_default();

    if !status.is_success() {
        if let Ok(err_obj) = serde_json::from_str::<ErrorReply>(&text) {
            if let Some(msg) = err_obj.error.filter(|s| !s.trim().is_empty()) {
                return Err(msg);
            }
        }
        return Err(format!("服务器返回错误 HTTP {}", status.as_u16()));
    }

    serde_json::from_str::<T>(&text).map_err(|e| format!("解析服务器响应 JSON 失败: {e}"))
}

struct SyncRuntimeInner {
    state: String,
    last_error: Option<String>,
    cached_secret: Option<StoredSyncSecret>,
}

#[derive(Clone)]
pub struct SyncService {
    http: Client,
    runtime: Arc<RwLock<SyncRuntimeInner>>,
    sync_lock: Arc<Mutex<()>>,
    debounce_gen: Arc<AtomicU64>,
}

impl SyncService {
    pub fn new() -> Self {
        let http = Client::builder()
            .user_agent("XiZiTerm/0.2.0")
            .build()
            .unwrap_or_default();

        Self {
            http,
            runtime: Arc::new(RwLock::new(SyncRuntimeInner {
                state: "idle".to_string(),
                last_error: None,
                cached_secret: None,
            })),
            sync_lock: Arc::new(Mutex::new(())),
            debounce_gen: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn spawn_auto_push_watcher(&self, app: AppHandle, vault: VaultService) {
        let sync_clone = self.clone();
        let notify = vault.mutation_notifier();

        tauri::async_runtime::spawn(async move {
            loop {
                notify.notified().await;
                let meta = vault.get_meta().await;
                let should_push = vault.is_unlocked().await
                    && meta.as_ref().is_some_and(|m| {
                        m.sync.enabled && m.sync.auto_push_on_change.unwrap_or(true)
                    });
                if !should_push {
                    continue;
                }

                let my_gen = sync_clone.debounce_gen.fetch_add(1, Ordering::SeqCst) + 1;
                let sync_inner = sync_clone.clone();
                let app_inner = app.clone();
                let vault_inner = vault.clone();

                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(1500)).await;
                    if sync_inner.debounce_gen.load(Ordering::SeqCst) == my_gen {
                        let _ = sync_inner.sync_now(&app_inner, &vault_inner, false).await;
                    }
                });
            }
        });
    }

    async fn load_secret(&self, vault: &VaultService) -> Option<StoredSyncSecret> {
        {
            let guard = self.runtime.read().await;
            if let Some(ref s) = guard.cached_secret {
                return Some(s.clone());
            }
        }
        let loaded = load_sync_secret(vault.vault_dir()).await;
        if let Some(ref s) = loaded {
            self.runtime.write().await.cached_secret = Some(s.clone());
        }
        loaded
    }

    async fn save_secret(&self, vault: &VaultService, secret: StoredSyncSecret) -> Result<(), String> {
        save_sync_secret(vault.vault_dir(), &secret).await?;
        self.runtime.write().await.cached_secret = Some(secret);
        Ok(())
    }

    async fn clear_secret(&self, vault: &VaultService) {
        self.runtime.write().await.cached_secret = None;
        clear_sync_secret(vault.vault_dir()).await;
    }

    pub async fn get_token(&self, vault: &VaultService) -> Option<String> {
        match self.load_secret(vault).await {
            Some(StoredSyncSecret::SelfHosted { token }) => Some(token),
            _ => None,
        }
    }

    pub async fn get_status(&self, vault: &VaultService) -> SyncStatusInfo {
        let meta = vault.get_meta().await;
        let sync = meta.as_ref().map(|m| &m.sync);
        let secret = self.load_secret(vault).await;
        let provider = sync
            .and_then(|s| s.provider.clone())
            .unwrap_or_else(|| "self-hosted".to_string());

        let has_token = if provider == "self-hosted" {
            matches!(secret, Some(StoredSyncSecret::SelfHosted { ref token }) if !token.is_empty())
        } else {
            matches!(secret, Some(StoredSyncSecret::Webdav { ref password }) if !password.is_empty())
        };

        let rt = self.runtime.read().await;
        SyncStatusInfo {
            enabled: sync.map(|s| s.enabled).unwrap_or(false),
            provider,
            server_url: sync.map(|s| s.server_url.clone()).unwrap_or_default(),
            username: sync.map(|s| s.username.clone()).unwrap_or_default(),
            webdav_remote_dir: Some(
                sync.and_then(|s| s.webdav_remote_dir.clone())
                    .unwrap_or_else(|| "/XiZiTerm".to_string()),
            ),
            last_server_seq: sync.map(|s| s.last_server_seq).unwrap_or(0),
            last_synced_at: sync.and_then(|s| s.last_synced_at),
            auto_sync_on_unlock: sync.and_then(|s| s.auto_sync_on_unlock).unwrap_or(true),
            auto_push_on_change: sync.and_then(|s| s.auto_push_on_change).unwrap_or(true),
            pending_count: vault.get_pending_count().await,
            state: rt.state.clone(),
            last_error: rt.last_error.clone(),
            has_token,
        }
    }

    async fn emit_state(&self, app: &AppHandle, vault: &VaultService, vault_updated: bool) {
        let status = self.get_status(vault).await;
        let _ = app.emit(
            IPC_EVENT_SYNC_STATE,
            SyncStateChangedEvent {
                status,
                vault_updated,
            },
        );
    }

    pub async fn on_vault_unlocked(&self, app: &AppHandle, vault: &VaultService) {
        let meta = vault.get_meta().await;
        if meta
            .as_ref()
            .is_some_and(|m| m.sync.enabled && m.sync.auto_sync_on_unlock.unwrap_or(true))
        {
            let sync_clone = self.clone();
            let app_clone = app.clone();
            let vault_clone = vault.clone();
            tauri::async_runtime::spawn(async move {
                let _ = sync_clone.sync_now(&app_clone, &vault_clone, false).await;
            });
        } else {
            self.emit_state(app, vault, false).await;
        }
    }

    pub async fn on_vault_locked(&self) {
        self.debounce_gen.fetch_add(1, Ordering::SeqCst);
        let mut rt = self.runtime.write().await;
        rt.state = "idle".to_string();
        rt.last_error = None;
    }

    pub async fn test_server(&self, server_url: &str) -> Result<ServerHealthInfo, String> {
        let base = normalize_server_url(server_url)?;
        let res: HealthReply = http_json(
            &self.http,
            Method::GET,
            &format!("{base}/api/health"),
            None,
            None,
            8_000,
        )
        .await?;

        if res.status.as_deref() != Some("ok") {
            return Err("目标地址不是有效的 XiZiTerm 云同步服务端".to_string());
        }
        Ok(ServerHealthInfo {
            version: res.version.unwrap_or_else(|| "0.1.0".to_string()),
            timestamp: res.timestamp.unwrap_or_else(now_ms),
        })
    }

    pub async fn register_and_bind(
        &self,
        app: &AppHandle,
        vault: &VaultService,
        payload: SyncBindCredentials,
    ) -> Result<SyncStatusInfo, String> {
        if !vault.is_unlocked().await {
            return Err("请先解锁本地保险库".to_string());
        }
        let meta = vault
            .get_meta()
            .await
            .ok_or_else(|| "未找到本地保险库元数据".to_string())?;
        let base = normalize_server_url(&payload.server_url)?;

        let auth: SyncAuthResponse = http_json(
            &self.http,
            Method::POST,
            &format!("{base}/api/auth/register"),
            None,
            Some(serde_json::json!({
                "username": payload.username.trim(),
                "password": payload.password,
                "deviceId": meta.device_id,
                "kdf": meta.kdf,
                "keyCheck": meta.key_check,
                "inviteCode": payload.invite_code.as_deref().map(str::trim).filter(|s| !s.is_empty()),
            })),
            15_000,
        )
        .await?;

        self.save_secret(vault, StoredSyncSecret::SelfHosted { token: auth.token })
            .await?;
        vault
            .update_sync_meta(SyncMetaPatch {
                enabled: Some(true),
                provider: Some("self-hosted".to_string()),
                server_url: Some(base),
                username: Some(auth.username),
                webdav_last_etag: Some(None),
                last_server_seq: Some(0),
                auto_sync_on_unlock: Some(true),
                auto_push_on_change: Some(true),
                ..Default::default()
            })
            .await?;

        self.sync_now(app, vault, true).await?;
        Ok(self.get_status(vault).await)
    }

    pub async fn login_and_bind(
        &self,
        app: &AppHandle,
        vault: &VaultService,
        payload: SyncBindCredentials,
    ) -> Result<SyncStatusInfo, String> {
        if !vault.is_unlocked().await {
            return Err("请先解锁本地保险库".to_string());
        }
        let meta = vault
            .get_meta()
            .await
            .ok_or_else(|| "未找到本地保险库元数据".to_string())?;
        let base = normalize_server_url(&payload.server_url)?;

        let auth: SyncAuthResponse = http_json(
            &self.http,
            Method::POST,
            &format!("{base}/api/auth/login"),
            None,
            Some(serde_json::json!({
                "username": payload.username.trim(),
                "password": payload.password,
                "deviceId": meta.device_id,
            })),
            15_000,
        )
        .await?;

        let key_ok = vault.verify_master_key_against(&auth.key_check).await?;
        if auth.kdf.salt != meta.kdf.salt || !key_ok {
            if let Some(mp) = payload.master_password.filter(|s| !s.is_empty()) {
                vault
                    .adopt_remote_kdf(mp, auth.kdf, auth.key_check)
                    .await?;
            } else {
                return Err(format!(
                    "{REMOTE_MASTER_PASSWORD_REQUIRED_PREFIX}检测到该云端账号已有加密保险库（加密盐值与本机不同），请在下方输入云端保险库的主密码以验证并自动合并数据"
                ));
            }
        }

        self.save_secret(vault, StoredSyncSecret::SelfHosted { token: auth.token })
            .await?;
        vault
            .update_sync_meta(SyncMetaPatch {
                enabled: Some(true),
                provider: Some("self-hosted".to_string()),
                server_url: Some(base),
                username: Some(auth.username),
                webdav_last_etag: Some(None),
                last_server_seq: Some(0),
                auto_sync_on_unlock: Some(true),
                auto_push_on_change: Some(true),
                ..Default::default()
            })
            .await?;

        self.sync_now(app, vault, true).await?;
        Ok(self.get_status(vault).await)
    }

    pub async fn bind_with_token(
        &self,
        app: &AppHandle,
        vault: &VaultService,
        payload: SyncBindTokenPayload,
    ) -> Result<SyncStatusInfo, String> {
        if !vault.is_unlocked().await {
            return Err("请先解锁本地保险库".to_string());
        }
        let meta = vault
            .get_meta()
            .await
            .ok_or_else(|| "未找到本地保险库元数据".to_string())?;
        let base = normalize_server_url(&payload.server_url)?;
        let token = payload.token.trim().to_string();
        if token.is_empty() {
            return Err("请输入有效的认证 Token".to_string());
        }

        let me: SyncMeResponse = http_json(
            &self.http,
            Method::GET,
            &format!("{base}/api/auth/me"),
            Some(&token),
            None,
            15_000,
        )
        .await?;

        let key_ok = vault.verify_master_key_against(&me.key_check).await?;
        if me.kdf.salt != meta.kdf.salt || !key_ok {
            if let Some(mp) = payload.master_password.filter(|s| !s.is_empty()) {
                vault.adopt_remote_kdf(mp, me.kdf, me.key_check).await?;
            } else {
                return Err(format!(
                    "{REMOTE_MASTER_PASSWORD_REQUIRED_PREFIX}检测到该 Token 对应的云端已有加密保险库（盐值与本机不同），请在下方输入云端保险库的主密码以验证并合并"
                ));
            }
        }

        self.save_secret(vault, StoredSyncSecret::SelfHosted { token })
            .await?;
        vault
            .update_sync_meta(SyncMetaPatch {
                enabled: Some(true),
                provider: Some("self-hosted".to_string()),
                server_url: Some(base),
                username: Some(me.username),
                webdav_last_etag: Some(None),
                last_server_seq: Some(0),
                auto_sync_on_unlock: Some(true),
                auto_push_on_change: Some(true),
                ..Default::default()
            })
            .await?;

        self.sync_now(app, vault, true).await?;
        Ok(self.get_status(vault).await)
    }

    pub async fn test_webdav(
        &self,
        payload: SyncWebDavTestPayload,
    ) -> Result<SyncWebDavTestResult, String> {
        test_webdav_connection(
            &self.http,
            &WebDavConnectionConfig {
                server_url: payload.server_url,
                username: payload.username,
                password: payload.password,
                remote_dir: payload.remote_dir,
            },
        )
        .await
    }

    pub async fn bind_webdav(
        &self,
        app: &AppHandle,
        vault: &VaultService,
        payload: SyncWebDavBindPayload,
    ) -> Result<SyncStatusInfo, String> {
        if !vault.is_unlocked().await {
            return Err("请先解锁本地保险库".to_string());
        }
        let meta = vault
            .get_meta()
            .await
            .ok_or_else(|| "未找到本地保险库元数据".to_string())?;

        let remote_dir = if payload.remote_dir.trim().is_empty() {
            "/XiZiTerm".to_string()
        } else {
            payload.remote_dir.trim().to_string()
        };

        let config = WebDavConnectionConfig {
            server_url: payload.server_url.trim().to_string(),
            username: payload.username.trim().to_string(),
            password: payload.password,
            remote_dir,
        };

        let target = normalize_webdav_target(&config.server_url, &config.remote_dir)?;
        let check = test_webdav_connection(&self.http, &config).await?;
        if !check.writable {
            let hint = check
                .available_shares
                .as_ref()
                .filter(|s| !s.is_empty())
                .map(|shares| {
                    let list = shares
                        .iter()
                        .take(6)
                        .map(|s| format!("/{s}/XiZiTerm"))
                        .collect::<Vec<_>>()
                        .join("、");
                    format!("（检测到可用共享目录：{list}）")
                })
                .unwrap_or_default();
            return Err(format!("{}{}", check.message, hint));
        }

        if let WebDavGetResult::Ok { bundle, .. } =
            get_webdav_vault_bundle(&self.http, &config, None).await?
        {
            let key_ok = vault.verify_master_key_against(&bundle.key_check).await?;
            if bundle.kdf.salt != meta.kdf.salt || !key_ok {
                if let Some(mp) = payload.master_password.filter(|s| !s.is_empty()) {
                    vault
                        .adopt_remote_kdf(mp, bundle.kdf, bundle.key_check)
                        .await?;
                } else {
                    return Err(format!(
                        "{REMOTE_MASTER_PASSWORD_REQUIRED_PREFIX}检测到该 WebDAV 目录中已存在加密保险库，请在下方输入该云端保险库的主密码以验证并自动合并本地与云端数据"
                    ));
                }
            }
        }

        self.save_secret(
            vault,
            StoredSyncSecret::Webdav {
                password: config.password.clone(),
            },
        )
        .await?;
        vault
            .update_sync_meta(SyncMetaPatch {
                enabled: Some(true),
                provider: Some("webdav".to_string()),
                server_url: Some(config.server_url),
                username: Some(config.username),
                webdav_remote_dir: Some(target.normalized_dir),
                webdav_last_etag: Some(None),
                last_server_seq: Some(0),
                auto_sync_on_unlock: Some(true),
                auto_push_on_change: Some(true),
                ..Default::default()
            })
            .await?;

        self.sync_now(app, vault, true).await?;
        Ok(self.get_status(vault).await)
    }

    pub async fn restore_vault_from_cloud(
        &self,
        app: &AppHandle,
        vault: &VaultService,
        payload: SyncRestorePayload,
    ) -> Result<VaultData, String> {
        let provider = payload
            .provider
            .unwrap_or_else(|| "self-hosted".to_string());

        if provider == "webdav" {
            let username = payload.username.unwrap_or_default().trim().to_string();
            let password = payload.password.unwrap_or_default();
            if username.is_empty() || password.is_empty() {
                return Err("请输入 WebDAV 账号和应用密码".to_string());
            }
            let remote_dir = payload
                .webdav_remote_dir
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("/XiZiTerm")
                .to_string();

            let config = WebDavConnectionConfig {
                server_url: payload.server_url.trim().to_string(),
                username: username.clone(),
                password: password.clone(),
                remote_dir,
            };

            let target = normalize_webdav_target(&config.server_url, &config.remote_dir)?;
            let WebDavGetResult::Ok { bundle, etag } =
                get_webdav_vault_bundle(&self.http, &config, None).await?
            else {
                return Err(format!(
                    "在 WebDAV 目录 {} 中未找到加密保险库文件 (xiziterm-vault.enc.json)",
                    target.normalized_dir
                ));
            };

            vault
                .initialize_from_remote(RemoteInitParams {
                    master_password: payload.master_password,
                    kdf: bundle.kdf,
                    key_check: bundle.key_check,
                    provider: "webdav".to_string(),
                    server_url: config.server_url,
                    username,
                    webdav_remote_dir: Some(target.normalized_dir),
                })
                .await?;

            self.save_secret(vault, StoredSyncSecret::Webdav { password })
                .await?;
            vault.merge_snapshot_envelopes(&bundle.items).await?;
            vault.mark_snapshot_uploaded(bundle.revision, etag).await?;

            {
                let mut rt = self.runtime.write().await;
                rt.state = "synced".to_string();
                rt.last_error = None;
            }
            self.emit_state(app, vault, true).await;
            return vault.get_active_data().await;
        }

        let base = normalize_server_url(&payload.server_url)?;
        let (token, username, kdf, key_check) = if payload.mode == "token" {
            let tok = payload.token.unwrap_or_default().trim().to_string();
            if tok.is_empty() {
                return Err("请输入认证 Token".to_string());
            }
            let me: SyncMeResponse = http_json(
                &self.http,
                Method::GET,
                &format!("{base}/api/auth/me"),
                Some(&tok),
                None,
                15_000,
            )
            .await?;
            (tok, me.username, me.kdf, me.key_check)
        } else {
            let auth: SyncAuthResponse = http_json(
                &self.http,
                Method::POST,
                &format!("{base}/api/auth/login"),
                None,
                Some(serde_json::json!({
                    "username": payload.username.unwrap_or_default().trim(),
                    "password": payload.password.unwrap_or_default(),
                    "deviceId": "restore-device",
                })),
                15_000,
            )
            .await?;
            (auth.token, auth.username, auth.kdf, auth.key_check)
        };

        vault
            .initialize_from_remote(RemoteInitParams {
                master_password: payload.master_password,
                kdf,
                key_check,
                provider: "self-hosted".to_string(),
                server_url: base,
                username,
                webdav_remote_dir: None,
            })
            .await?;

        self.save_secret(vault, StoredSyncSecret::SelfHosted { token })
            .await?;
        self.sync_now(app, vault, true).await?;
        vault.get_active_data().await
    }

    pub async fn update_options(
        &self,
        app: &AppHandle,
        vault: &VaultService,
        patch: SyncOptionsPatch,
    ) -> Result<SyncStatusInfo, String> {
        vault
            .update_sync_meta(SyncMetaPatch {
                auto_sync_on_unlock: patch.auto_sync_on_unlock,
                auto_push_on_change: patch.auto_push_on_change,
                ..Default::default()
            })
            .await?;
        self.emit_state(app, vault, false).await;
        Ok(self.get_status(vault).await)
    }

    pub async fn disconnect(
        &self,
        app: &AppHandle,
        vault: &VaultService,
    ) -> Result<SyncStatusInfo, String> {
        self.debounce_gen.fetch_add(1, Ordering::SeqCst);
        let meta = vault.get_meta().await;
        let secret = self.load_secret(vault).await;
        let provider = meta
            .as_ref()
            .and_then(|m| m.sync.provider.clone())
            .unwrap_or_else(|| "self-hosted".to_string());

        if provider == "self-hosted" {
            if let (Some(m), Some(StoredSyncSecret::SelfHosted { token })) = (&meta, secret) {
                if !m.sync.server_url.is_empty() && !token.is_empty() {
                    let _ = http_json::<serde_json::Value>(
                        &self.http,
                        Method::POST,
                        &format!("{}/api/auth/logout", m.sync.server_url),
                        Some(&token),
                        None,
                        4_000,
                    )
                    .await;
                }
            }
        }

        self.clear_secret(vault).await;
        vault
            .update_sync_meta(SyncMetaPatch {
                enabled: Some(false),
                webdav_last_etag: Some(None),
                last_server_seq: Some(0),
                ..Default::default()
            })
            .await?;

        {
            let mut rt = self.runtime.write().await;
            rt.state = "idle".to_string();
            rt.last_error = None;
        }
        self.emit_state(app, vault, false).await;
        Ok(self.get_status(vault).await)
    }

    pub async fn sync_now(
        &self,
        app: &AppHandle,
        vault: &VaultService,
        force_full: bool,
    ) -> Result<SyncRunResult, String> {
        let _guard = self.sync_lock.lock().await;
        if !vault.is_unlocked().await {
            return Err("保险库处于锁定状态，无法执行同步".to_string());
        }
        let meta = vault
            .get_meta()
            .await
            .filter(|m| m.sync.enabled && !m.sync.server_url.is_empty())
            .ok_or_else(|| "尚未配置云同步服务".to_string())?;

        let provider = meta
            .sync
            .provider
            .clone()
            .unwrap_or_else(|| "self-hosted".to_string());

        {
            let mut rt = self.runtime.write().await;
            rt.state = "syncing".to_string();
            rt.last_error = None;
        }
        self.emit_state(app, vault, false).await;

        let res = if provider == "webdav" {
            self.execute_webdav_sync(vault, force_full).await
        } else {
            self.execute_self_hosted_sync(vault, force_full).await
        };

        match res {
            Ok(outcome) => {
                {
                    let mut rt = self.runtime.write().await;
                    rt.state = "synced".to_string();
                    rt.last_error = None;
                }
                self.emit_state(
                    app,
                    vault,
                    outcome.pulled_count > 0 || outcome.conflict_count > 0,
                )
                .await;
                Ok(outcome)
            }
            Err(err_msg) => {
                {
                    let mut rt = self.runtime.write().await;
                    rt.state = "error".to_string();
                    rt.last_error = Some(err_msg.clone());
                }
                self.emit_state(app, vault, false).await;
                Err(err_msg)
            }
        }
    }

    async fn execute_self_hosted_sync(
        &self,
        vault: &VaultService,
        force_full: bool,
    ) -> Result<SyncRunResult, String> {
        let meta = vault
            .get_meta()
            .await
            .ok_or_else(|| "未找到保险库元数据".to_string())?;
        let Some(StoredSyncSecret::SelfHosted { token }) = self.load_secret(vault).await else {
            return Err("缺少认证 Token，请重新登录云同步账号".to_string());
        };
        if token.is_empty() {
            return Err("缺少认证 Token，请重新登录云同步账号".to_string());
        }

        let base = &meta.sync.server_url;
        let since_seq = if force_full {
            0
        } else {
            meta.sync.last_server_seq
        };

        let pull_res: SyncPullResponse = http_json(
            &self.http,
            Method::GET,
            &format!("{base}/api/sync/pull?sinceSeq={since_seq}"),
            Some(&token),
            None,
            15_000,
        )
        .await?;

        let mut pulled_count = 0usize;
        let mut conflict_count = 0usize;

        if !pull_res.items.is_empty() || pull_res.latest_seq > meta.sync.last_server_seq {
            let (applied, conflicts) = vault
                .apply_remote_envelopes(&pull_res.items, pull_res.latest_seq)
                .await?;
            pulled_count += applied;
            conflict_count += conflicts;
        }

        let latest_base_seq = vault
            .get_meta()
            .await
            .map(|m| m.sync.last_server_seq)
            .unwrap_or(pull_res.latest_seq);
        let to_push = vault.get_envelopes_for_push(force_full).await?;
        let mut pushed_count = 0usize;
        let mut final_seq = latest_base_seq;

        if !to_push.is_empty() {
            #[derive(Serialize)]
            #[serde(rename_all = "camelCase")]
            struct PushBody<T> {
                base_seq: i64,
                items: T,
            }

            let push_val = serde_json::to_value(PushBody {
                base_seq: latest_base_seq,
                items: to_push,
            })
            .map_err(|e| e.to_string())?;

            let push_res: SyncPushResponse = http_json(
                &self.http,
                Method::POST,
                &format!("{base}/api/sync/push"),
                Some(&token),
                Some(push_val),
                20_000,
            )
            .await?;

            pushed_count = push_res.accepted.len();
            final_seq = final_seq.max(push_res.accepted_seq);

            if !push_res.accepted.is_empty() {
                vault
                    .mark_envelopes_accepted(&push_res.accepted, push_res.accepted_seq)
                    .await?;
            }
            if !push_res.conflicts.is_empty() {
                let (applied, conflicts) = vault
                    .apply_remote_envelopes(&push_res.conflicts, final_seq)
                    .await?;
                pulled_count += applied;
                conflict_count += conflicts;
            }
        } else {
            vault
                .update_sync_meta(SyncMetaPatch {
                    last_synced_at: Some(Some(now_ms())),
                    ..Default::default()
                })
                .await?;
        }

        Ok(SyncRunResult {
            pulled_count,
            pushed_count,
            conflict_count,
            latest_seq: final_seq,
            synced_at: now_ms(),
        })
    }

    async fn execute_webdav_sync(
        &self,
        vault: &VaultService,
        force_full: bool,
    ) -> Result<SyncRunResult, String> {
        let Some(StoredSyncSecret::Webdav { password }) = self.load_secret(vault).await else {
            return Err("缺少 WebDAV 密码凭据，请重新绑定 WebDAV 同步".to_string());
        };
        if password.is_empty() {
            return Err("缺少 WebDAV 密码凭据，请重新绑定 WebDAV 同步".to_string());
        }

        let mut total_pulled = 0usize;
        let mut total_conflict = 0usize;

        for attempt in 0..2 {
            let current_meta = vault
                .get_meta()
                .await
                .ok_or_else(|| "未找到保险库元数据".to_string())?;
            let config = WebDavConnectionConfig {
                server_url: current_meta.sync.server_url.clone(),
                username: current_meta.sync.username.clone(),
                password: password.clone(),
                remote_dir: current_meta
                    .sync
                    .webdav_remote_dir
                    .clone()
                    .unwrap_or_else(|| "/XiZiTerm".to_string()),
            };

            let has_pending = vault.get_pending_count().await > 0;
            let cached_etag = if !force_full && !has_pending && attempt == 0 {
                current_meta.sync.webdav_last_etag.as_deref()
            } else {
                None
            };

            let get_res = get_webdav_vault_bundle(&self.http, &config, cached_etag).await?;

            match get_res {
                WebDavGetResult::NotModified => {
                    let synced_at = now_ms();
                    vault
                        .update_sync_meta(SyncMetaPatch {
                            last_synced_at: Some(Some(synced_at)),
                            ..Default::default()
                        })
                        .await?;
                    return Ok(SyncRunResult {
                        pulled_count: total_pulled,
                        pushed_count: 0,
                        conflict_count: total_conflict,
                        latest_seq: current_meta.sync.last_server_seq,
                        synced_at,
                    });
                }
                WebDavGetResult::NotFound => {
                    let next_rev = 1i64;
                    let snapshot = vault.build_snapshot_map_for_upload(next_rev).await?;
                    let total_items = snapshot.items.len();
                    let bundle = WebDavVaultBundle {
                        format: "xiziterm-e2ee-webdav-v1".to_string(),
                        schema_version: SCHEMA_VERSION,
                        updated_at: now_ms(),
                        updated_by_device_id: current_meta.device_id,
                        revision: next_rev,
                        kdf: current_meta.kdf,
                        key_check: current_meta.key_check,
                        items: snapshot.items,
                    };
                    let new_etag =
                        put_webdav_vault_bundle(&self.http, &config, &bundle, None, None)
                            .await
                            .map_err(|e| match e {
                                WebDavPutError::Conflict => "WebDAV 并发写入冲突".to_string(),
                                WebDavPutError::Other(m) => m,
                            })?;
                    vault.mark_snapshot_uploaded(next_rev, new_etag).await?;
                    return Ok(SyncRunResult {
                        pulled_count: total_pulled,
                        pushed_count: total_items,
                        conflict_count: total_conflict,
                        latest_seq: next_rev,
                        synced_at: now_ms(),
                    });
                }
                WebDavGetResult::Ok {
                    bundle: remote_bundle,
                    etag,
                } => {
                    let key_ok = vault
                        .verify_master_key_against(&remote_bundle.key_check)
                        .await?;
                    if remote_bundle.kdf.salt != current_meta.kdf.salt || !key_ok {
                        return Err(
                            "WebDAV 远端保险库的加密盐值或主密码与本机不一致，已中止同步以保护数据安全"
                                .to_string(),
                        );
                    }

                    let merged = vault.merge_snapshot_envelopes(&remote_bundle.items).await?;
                    total_pulled += merged.pulled_count;
                    total_conflict += merged.conflict_count;

                    if !force_full && !merged.needs_push {
                        let synced_at = now_ms();
                        vault
                            .update_sync_meta(SyncMetaPatch {
                                last_server_seq: Some(remote_bundle.revision),
                                webdav_last_etag: Some(etag),
                                last_synced_at: Some(Some(synced_at)),
                                ..Default::default()
                            })
                            .await?;
                        return Ok(SyncRunResult {
                            pulled_count: total_pulled,
                            pushed_count: 0,
                            conflict_count: total_conflict,
                            latest_seq: remote_bundle.revision,
                            synced_at,
                        });
                    }

                    let next_rev = remote_bundle.revision.max(0) + 1;
                    let snapshot = vault.build_snapshot_map_for_upload(next_rev).await?;
                    let total_items = snapshot.items.len();
                    let updated_bundle = WebDavVaultBundle {
                        format: "xiziterm-e2ee-webdav-v1".to_string(),
                        schema_version: SCHEMA_VERSION,
                        updated_at: now_ms(),
                        updated_by_device_id: current_meta.device_id,
                        revision: next_rev,
                        kdf: current_meta.kdf,
                        key_check: current_meta.key_check,
                        items: snapshot.items,
                    };

                    match put_webdav_vault_bundle(
                        &self.http,
                        &config,
                        &updated_bundle,
                        etag.as_deref(),
                        Some(remote_bundle.revision),
                    )
                    .await
                    {
                        Ok(new_etag) => {
                            vault.mark_snapshot_uploaded(next_rev, new_etag).await?;
                            let pushed = if snapshot.pushed_count > 0 {
                                snapshot.pushed_count
                            } else if force_full {
                                total_items
                            } else {
                                0
                            };
                            return Ok(SyncRunResult {
                                pulled_count: total_pulled,
                                pushed_count: pushed,
                                conflict_count: total_conflict,
                                latest_seq: next_rev,
                                synced_at: now_ms(),
                            });
                        }
                        Err(WebDavPutError::Conflict) if attempt == 0 => {
                            continue;
                        }
                        Err(WebDavPutError::Conflict) => {
                            return Err("WebDAV 并发写入冲突重试失败，请稍后再试".to_string());
                        }
                        Err(WebDavPutError::Other(m)) => {
                            return Err(m);
                        }
                    }
                }
            }
        }

        Err("WebDAV 并发写入冲突重试失败，请稍后再试".to_string())
    }
}

pub fn unwrap_force_full(options: Option<SyncNowOptions>) -> bool {
    options.and_then(|o| o.force_full).unwrap_or(false)
}
