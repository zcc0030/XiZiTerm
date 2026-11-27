use chrono::Local;
use serde::{de::DeserializeOwned, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::{Notify, RwLock};
use uuid::Uuid;
use zeroize::Zeroize;

use crate::models::{
    CipherPayload, EncryptedEnvelope, HostConfig, HostGroup, HostGroupInput, HostInput, KdfParams,
    PreferencesPatch, Snippet, SnippetInput, SyncConfigMeta, SyncPushAcceptedItem, UserPreferences,
    VaultData, VaultItemsDisk, VaultMeta, VaultStatus,
};
use crate::services::crypto::{
    create_default_kdf_params, create_key_check, decrypt_vault_item, derive_master_key,
    encrypt_vault_item, verify_key_check, EnvelopeMetaInput, SCHEMA_VERSION,
};

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

async fn file_exists(path: &Path) -> bool {
    tokio::fs::metadata(path).await.is_ok()
}

async fn read_json_file<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    if !file_exists(path).await {
        return Ok(None);
    }
    let text = tokio::fs::read_to_string(path)
        .await
        .map_err(|e| format!("读取文件失败 ({}): {e}", path.display()))?;
    let parsed = serde_json::from_str::<T>(&text)
        .map_err(|e| format!("解析 JSON 文件失败 ({}): {e}", path.display()))?;
    Ok(Some(parsed))
}

async fn atomic_write_json<T: Serialize>(path: &Path, data: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let tmp_path = path.with_extension(format!("tmp.{}", Uuid::new_v4()));
    let serialized =
        serde_json::to_string_pretty(data).map_err(|e| format!("序列化 JSON 失败: {e}"))?;
    tokio::fs::write(&tmp_path, serialized)
        .await
        .map_err(|e| format!("写入临时文件失败: {e}"))?;
    tokio::fs::rename(&tmp_path, path)
        .await
        .map_err(|e| format!("原子替换文件失败: {e}"))?;
    Ok(())
}

fn resolve_app_data_root() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".config")
    })
}

struct VaultInner {
    master_key: Option<[u8; 32]>,
    meta: Option<VaultMeta>,
    envelopes: HashMap<String, EncryptedEnvelope>,
    groups: HashMap<String, HostGroup>,
    hosts: HashMap<String, HostConfig>,
    snippets: HashMap<String, Snippet>,
    preferences: Option<UserPreferences>,
    migration_checked: bool,
}

#[derive(Clone)]
pub struct VaultService {
    vault_dir: PathBuf,
    inner: Arc<RwLock<VaultInner>>,
    mutation_notify: Arc<Notify>,
}

pub struct SnapshotMergeOutcome {
    pub pulled_count: usize,
    pub conflict_count: usize,
    pub needs_push: bool,
}

pub struct SnapshotUploadPayload {
    pub items: HashMap<String, EncryptedEnvelope>,
    pub pushed_count: usize,
}

pub struct RemoteInitParams {
    pub master_password: String,
    pub kdf: KdfParams,
    pub key_check: CipherPayload,
    pub provider: String,
    pub server_url: String,
    pub username: String,
    pub webdav_remote_dir: Option<String>,
}

pub struct SyncMetaPatch {
    pub enabled: Option<bool>,
    pub provider: Option<String>,
    pub server_url: Option<String>,
    pub username: Option<String>,
    pub webdav_remote_dir: Option<String>,
    pub webdav_last_etag: Option<Option<String>>,
    pub last_server_seq: Option<i64>,
    pub last_synced_at: Option<Option<i64>>,
    pub auto_sync_on_unlock: Option<bool>,
    pub auto_push_on_change: Option<bool>,
}

impl Default for SyncMetaPatch {
    fn default() -> Self {
        Self {
            enabled: None,
            provider: None,
            server_url: None,
            username: None,
            webdav_remote_dir: None,
            webdav_last_etag: None,
            last_server_seq: None,
            last_synced_at: None,
            auto_sync_on_unlock: None,
            auto_push_on_change: None,
        }
    }
}

impl VaultService {
    pub fn new() -> Self {
        let vault_dir = resolve_app_data_root().join("XiZiTerm").join("vault");
        Self {
            vault_dir,
            inner: Arc::new(RwLock::new(VaultInner {
                master_key: None,
                meta: None,
                envelopes: HashMap::new(),
                groups: HashMap::new(),
                hosts: HashMap::new(),
                snippets: HashMap::new(),
                preferences: None,
                migration_checked: false,
            })),
            mutation_notify: Arc::new(Notify::new()),
        }
    }

    pub fn vault_dir(&self) -> &Path {
        &self.vault_dir
    }

    fn meta_path(&self) -> PathBuf {
        self.vault_dir.join("vault.meta.json")
    }

    fn items_path(&self) -> PathBuf {
        self.vault_dir.join("vault.items.enc.json")
    }

    pub fn mutation_notifier(&self) -> Arc<Notify> {
        self.mutation_notify.clone()
    }

    fn emit_local_mutation(&self) {
        self.mutation_notify.notify_waiters();
    }

    async fn ensure_legacy_vault_migrated(&self) {
        {
            let mut guard = self.inner.write().await;
            if guard.migration_checked {
                return;
            }
            guard.migration_checked = true;
        }

        if file_exists(&self.meta_path()).await {
            return;
        }

        let root = resolve_app_data_root();
        let candidates = [
            root.join("@xiziterm").join("desktop").join("vault"),
            root.join("xiziterm").join("vault"),
            root.join("@nexusterm").join("desktop").join("vault"),
            root.join("nexusterm").join("vault"),
            root.join("NexusTerm").join("vault"),
        ];

        for legacy_dir in candidates {
            let legacy_meta = legacy_dir.join("vault.meta.json");
            if file_exists(&legacy_meta).await {
                if tokio::fs::create_dir_all(&self.vault_dir).await.is_ok() {
                    for filename in ["vault.meta.json", "vault.items.enc.json"] {
                        let src = legacy_dir.join(filename);
                        let dst = self.vault_dir.join(filename);
                        if file_exists(&src).await {
                            let _ = tokio::fs::copy(&src, &dst).await;
                        }
                    }
                }
                return;
            }
        }
    }

    pub async fn is_unlocked(&self) -> bool {
        self.inner.read().await.master_key.is_some()
    }

    pub async fn get_meta(&self) -> Option<VaultMeta> {
        let mut guard = self.inner.write().await;
        if guard.meta.is_none() {
            if let Ok(Some(disk_meta)) = read_json_file::<VaultMeta>(&self.meta_path()).await {
                guard.meta = Some(disk_meta);
            }
        }
        guard.meta.clone()
    }

    pub async fn get_status(&self) -> VaultStatus {
        self.ensure_legacy_vault_migrated().await;
        let initialized = file_exists(&self.meta_path()).await;
        let mut guard = self.inner.write().await;
        if initialized && guard.meta.is_none() {
            if let Ok(Some(meta)) = read_json_file::<VaultMeta>(&self.meta_path()).await {
                guard.meta = Some(meta);
            }
        }
        VaultStatus {
            initialized,
            unlocked: guard.master_key.is_some(),
            vault_dir: self.vault_dir.to_string_lossy().to_string(),
            device_id: guard.meta.as_ref().map(|m| m.device_id.clone()),
            kdf_algorithm: guard.meta.as_ref().map(|m| m.kdf.algorithm.clone()),
            kdf_iterations: guard.meta.as_ref().map(|m| m.kdf.iterations),
        }
    }

    pub async fn initialize(&self, master_password: String) -> Result<VaultData, String> {
        if master_password.chars().count() < 6 {
            return Err("主密码长度至少为 6 个字符".to_string());
        }
        if file_exists(&self.meta_path()).await {
            return Err("保险库已初始化，请使用主密码解锁".to_string());
        }

        tokio::fs::create_dir_all(&self.vault_dir)
            .await
            .map_err(|e| format!("创建保险库目录失败: {e}"))?;

        let kdf = create_default_kdf_params();
        let derived_key = derive_master_key(master_password, kdf.clone()).await?;
        let key_check = create_key_check(&derived_key)?;
        let now = now_ms();

        let meta = VaultMeta {
            schema_version: SCHEMA_VERSION,
            device_id: Uuid::new_v4().to_string(),
            created_at: now,
            kdf,
            key_check,
            sync: SyncConfigMeta {
                enabled: false,
                provider: None,
                server_url: String::new(),
                username: String::new(),
                webdav_remote_dir: None,
                webdav_last_etag: None,
                last_server_seq: 0,
                last_synced_at: None,
                auto_sync_on_unlock: Some(true),
                auto_push_on_change: Some(true),
            },
        };

        let default_prefs = UserPreferences::default_with_time(now, 1);
        let prefs_env = encrypt_vault_item(
            &derived_key,
            "preferences",
            &default_prefs.id,
            &default_prefs,
            EnvelopeMetaInput {
                is_deleted: false,
                client_updated_at: now,
                dirty: Some(true),
                server_seq: None,
            },
        )?;

        let default_group = HostGroup {
            id: Uuid::new_v4().to_string(),
            name: "默认服务器".to_string(),
            parent_id: None,
            color: "#06b6d4".to_string(),
            sort_order: 0,
            created_at: now,
            updated_at: now,
            deleted_at: None,
            sync_version: 1,
        };
        let group_env = encrypt_vault_item(
            &derived_key,
            "group",
            &default_group.id,
            &default_group,
            EnvelopeMetaInput {
                is_deleted: false,
                client_updated_at: now,
                dirty: Some(true),
                server_seq: None,
            },
        )?;

        let mut envelopes = HashMap::new();
        envelopes.insert(default_prefs.id.clone(), prefs_env);
        envelopes.insert(default_group.id.clone(), group_env);

        atomic_write_json(&self.meta_path(), &meta).await?;
        atomic_write_json(
            &self.items_path(),
            &VaultItemsDisk {
                schema_version: SCHEMA_VERSION,
                envelopes: envelopes.clone(),
            },
        )
        .await?;

        {
            let mut guard = self.inner.write().await;
            guard.master_key = Some(derived_key);
            guard.meta = Some(meta);
            guard.envelopes = envelopes;
            guard.groups.clear();
            guard.groups.insert(default_group.id.clone(), default_group);
            guard.hosts.clear();
            guard.snippets.clear();
            guard.preferences = Some(default_prefs);
        }

        self.get_active_data().await
    }

    pub async fn unlock(&self, master_password: String) -> Result<VaultData, String> {
        self.ensure_legacy_vault_migrated().await;
        let meta = read_json_file::<VaultMeta>(&self.meta_path())
            .await?
            .ok_or_else(|| "未找到本地保险库，请先初始化主密码".to_string())?;

        let mut derived_key = derive_master_key(master_password, meta.kdf.clone()).await?;
        if !verify_key_check(&derived_key, &meta.key_check) {
            derived_key.zeroize();
            return Err("主密码不正确，请重试".to_string());
        }

        let disk = read_json_file::<VaultItemsDisk>(&self.items_path()).await?;
        let mut envelopes = disk.map(|d| d.envelopes).unwrap_or_default();

        let mut groups = HashMap::new();
        let mut hosts = HashMap::new();
        let mut snippets = HashMap::new();
        let mut preferences: Option<UserPreferences> = None;

        for env in envelopes.values() {
            match env.item_type.as_str() {
                "group" => {
                    let g: HostGroup = decrypt_vault_item(&derived_key, env)?;
                    groups.insert(g.id.clone(), g);
                }
                "host" => {
                    let h: HostConfig = decrypt_vault_item(&derived_key, env)?;
                    hosts.insert(h.id.clone(), h);
                }
                "snippet" => {
                    let s: Snippet = decrypt_vault_item(&derived_key, env)?;
                    snippets.insert(s.id.clone(), s);
                }
                "preferences" => {
                    let p: UserPreferences = decrypt_vault_item(&derived_key, env)?;
                    preferences = Some(p);
                }
                _ => {}
            }
        }

        let mut needs_persist = false;
        if preferences.is_none() {
            let now = now_ms();
            let default_prefs = UserPreferences::default_with_time(now, 1);
            let env = encrypt_vault_item(
                &derived_key,
                "preferences",
                &default_prefs.id,
                &default_prefs,
                EnvelopeMetaInput {
                    is_deleted: false,
                    client_updated_at: now,
                    dirty: Some(true),
                    server_seq: None,
                },
            )?;
            envelopes.insert(default_prefs.id.clone(), env);
            preferences = Some(default_prefs);
            needs_persist = true;
        }

        if needs_persist {
            atomic_write_json(
                &self.items_path(),
                &VaultItemsDisk {
                    schema_version: SCHEMA_VERSION,
                    envelopes: envelopes.clone(),
                },
            )
            .await?;
        }

        {
            let mut guard = self.inner.write().await;
            if let Some(mut old_key) = guard.master_key.take() {
                old_key.zeroize();
            }
            guard.master_key = Some(derived_key);
            guard.meta = Some(meta);
            guard.envelopes = envelopes;
            guard.groups = groups;
            guard.hosts = hosts;
            guard.snippets = snippets;
            guard.preferences = preferences;
        }

        self.get_active_data().await
    }

    pub async fn lock(&self) {
        let mut guard = self.inner.write().await;
        if let Some(mut key) = guard.master_key.take() {
            key.zeroize();
        }
        guard.groups.clear();
        guard.hosts.clear();
        guard.snippets.clear();
        guard.preferences = None;
        guard.envelopes.clear();
    }

    pub async fn get_active_data(&self) -> Result<VaultData, String> {
        let guard = self.inner.read().await;
        if guard.master_key.is_none() {
            return Err("保险库处于锁定状态，请先解锁".to_string());
        }

        let mut groups: Vec<HostGroup> = guard
            .groups
            .values()
            .filter(|g| g.deleted_at.is_none())
            .cloned()
            .collect();
        groups.sort_by(|a, b| a.sort_order.cmp(&b.sort_order).then_with(|| a.name.cmp(&b.name)));

        let mut hosts: Vec<HostConfig> = guard
            .hosts
            .values()
            .filter(|h| h.deleted_at.is_none())
            .cloned()
            .collect();
        hosts.sort_by(|a, b| a.name.cmp(&b.name));

        let mut snippets: Vec<Snippet> = guard
            .snippets
            .values()
            .filter(|s| s.deleted_at.is_none())
            .cloned()
            .collect();
        snippets.sort_by(|a, b| a.title.cmp(&b.title));

        let preferences = guard
            .preferences
            .clone()
            .unwrap_or_else(|| UserPreferences::default_with_time(now_ms(), 1));

        Ok(VaultData {
            groups,
            hosts,
            snippets,
            preferences,
        })
    }

    pub async fn get_host_by_id(&self, host_id: &str) -> Result<Option<HostConfig>, String> {
        let guard = self.inner.read().await;
        if guard.master_key.is_none() {
            return Err("保险库处于锁定状态，请先解锁".to_string());
        }
        Ok(guard
            .hosts
            .get(host_id)
            .filter(|h| h.deleted_at.is_none())
            .cloned())
    }

    async fn persist_envelopes(&self, envelopes: &HashMap<String, EncryptedEnvelope>) -> Result<(), String> {
        atomic_write_json(
            &self.items_path(),
            &VaultItemsDisk {
                schema_version: SCHEMA_VERSION,
                envelopes: envelopes.clone(),
            },
        )
        .await
    }

    pub async fn save_group(&self, input: HostGroupInput) -> Result<HostGroup, String> {
        let trimmed_name = input.name.trim().to_string();
        if trimmed_name.is_empty() {
            return Err("分组名称不能为空".to_string());
        }

        let now = now_ms();
        let (record, snapshot_envelopes) = {
            let mut guard = self.inner.write().await;
            let key = guard
                .master_key
                .ok_or_else(|| "保险库处于锁定状态，请先解锁".to_string())?;

            let existing = input.id.as_ref().and_then(|id| guard.groups.get(id)).cloned();
            let record = if let Some(ex) = existing {
                HostGroup {
                    id: ex.id,
                    name: trimmed_name,
                    parent_id: input.parent_id,
                    color: if input.color.trim().is_empty() {
                        ex.color
                    } else {
                        input.color
                    },
                    sort_order: input.sort_order.unwrap_or(ex.sort_order),
                    created_at: ex.created_at,
                    updated_at: now,
                    deleted_at: None,
                    sync_version: ex.sync_version + 1,
                }
            } else {
                HostGroup {
                    id: input
                        .id
                        .filter(|s| !s.trim().is_empty())
                        .unwrap_or_else(|| Uuid::new_v4().to_string()),
                    name: trimmed_name,
                    parent_id: input.parent_id,
                    color: if input.color.trim().is_empty() {
                        "#06b6d4".to_string()
                    } else {
                        input.color
                    },
                    sort_order: input.sort_order.unwrap_or(guard.groups.len() as i32),
                    created_at: now,
                    updated_at: now,
                    deleted_at: None,
                    sync_version: 1,
                }
            };

            let prev_seq = guard.envelopes.get(&record.id).and_then(|e| e.server_seq);
            let env = encrypt_vault_item(
                &key,
                "group",
                &record.id,
                &record,
                EnvelopeMetaInput {
                    is_deleted: false,
                    client_updated_at: now,
                    dirty: Some(true),
                    server_seq: prev_seq,
                },
            )?;

            guard.groups.insert(record.id.clone(), record.clone());
            guard.envelopes.insert(record.id.clone(), env);
            (record, guard.envelopes.clone())
        };

        self.persist_envelopes(&snapshot_envelopes).await?;
        self.emit_local_mutation();
        Ok(record)
    }

    pub async fn delete_group(&self, group_id: &str) -> Result<(), String> {
        let now = now_ms();
        let snapshot_envelopes = {
            let mut guard = self.inner.write().await;
            let key = guard
                .master_key
                .ok_or_else(|| "保险库处于锁定状态，请先解锁".to_string())?;

            let Some(existing) = guard.groups.get(group_id).cloned() else {
                return Ok(());
            };

            let tombstone = HostGroup {
                deleted_at: Some(now),
                updated_at: now,
                sync_version: existing.sync_version + 1,
                ..existing
            };
            let prev_seq = guard.envelopes.get(group_id).and_then(|e| e.server_seq);
            let env = encrypt_vault_item(
                &key,
                "group",
                group_id,
                &tombstone,
                EnvelopeMetaInput {
                    is_deleted: true,
                    client_updated_at: now,
                    dirty: Some(true),
                    server_seq: prev_seq,
                },
            )?;
            guard.groups.insert(group_id.to_string(), tombstone);
            guard.envelopes.insert(group_id.to_string(), env);

            let affected_ids: Vec<String> = guard
                .hosts
                .values()
                .filter(|h| h.deleted_at.is_none() && h.group_id.as_deref() == Some(group_id))
                .map(|h| h.id.clone())
                .collect();

            for hid in affected_ids {
                if let Some(h) = guard.hosts.get(&hid).cloned() {
                    let updated = HostConfig {
                        group_id: None,
                        updated_at: now,
                        sync_version: h.sync_version + 1,
                        ..h
                    };
                    let h_seq = guard.envelopes.get(&hid).and_then(|e| e.server_seq);
                    let h_env = encrypt_vault_item(
                        &key,
                        "host",
                        &hid,
                        &updated,
                        EnvelopeMetaInput {
                            is_deleted: false,
                            client_updated_at: now,
                            dirty: Some(true),
                            server_seq: h_seq,
                        },
                    )?;
                    guard.hosts.insert(hid.clone(), updated);
                    guard.envelopes.insert(hid, h_env);
                }
            }

            guard.envelopes.clone()
        };

        self.persist_envelopes(&snapshot_envelopes).await?;
        self.emit_local_mutation();
        Ok(())
    }

    fn normalize_tags(tags: Vec<String>) -> Vec<String> {
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for t in tags {
            let trimmed = t.trim().to_string();
            if !trimmed.is_empty() && seen.insert(trimmed.clone()) {
                out.push(trimmed);
            }
        }
        out
    }

    pub async fn save_host(&self, input: HostInput) -> Result<HostConfig, String> {
        let name = input.name.trim().to_string();
        let hostname = input.hostname.trim().to_string();
        let username = input.username.trim().to_string();

        if name.is_empty() {
            return Err("主机别名不能为空".to_string());
        }
        if hostname.is_empty() {
            return Err("主机地址 (IP/域名) 不能为空".to_string());
        }
        if username.is_empty() {
            return Err("用户名不能为空".to_string());
        }
        if input.port < 1 || input.port > 65535 {
            return Err("端口必须是 1-65535 之间的整数".to_string());
        }
        let port = input.port as u16;
        let keep_alive = input.keep_alive_interval.max(0) as u64;
        let tags = Self::normalize_tags(input.tags);
        let is_password = input.auth_type == "password";

        let now = now_ms();
        let (record, snapshot_envelopes) = {
            let mut guard = self.inner.write().await;
            let key = guard
                .master_key
                .ok_or_else(|| "保险库处于锁定状态，请先解锁".to_string())?;

            let existing = input.id.as_ref().and_then(|id| guard.hosts.get(id)).cloned();
            let record = if let Some(ex) = existing {
                HostConfig {
                    id: ex.id,
                    group_id: input.group_id,
                    name,
                    hostname,
                    port,
                    username,
                    auth_type: input.auth_type,
                    password: if is_password {
                        Some(input.password.unwrap_or_default())
                    } else {
                        None
                    },
                    private_key: if !is_password {
                        Some(input.private_key.unwrap_or_default())
                    } else {
                        None
                    },
                    passphrase: if !is_password {
                        Some(input.passphrase.unwrap_or_default())
                    } else {
                        None
                    },
                    tags,
                    notes: input.notes,
                    keep_alive_interval: keep_alive,
                    created_at: ex.created_at,
                    updated_at: now,
                    deleted_at: None,
                    sync_version: ex.sync_version + 1,
                }
            } else {
                HostConfig {
                    id: input
                        .id
                        .filter(|s| !s.trim().is_empty())
                        .unwrap_or_else(|| Uuid::new_v4().to_string()),
                    group_id: input.group_id,
                    name,
                    hostname,
                    port,
                    username,
                    auth_type: input.auth_type,
                    password: if is_password {
                        Some(input.password.unwrap_or_default())
                    } else {
                        None
                    },
                    private_key: if !is_password {
                        Some(input.private_key.unwrap_or_default())
                    } else {
                        None
                    },
                    passphrase: if !is_password {
                        Some(input.passphrase.unwrap_or_default())
                    } else {
                        None
                    },
                    tags,
                    notes: input.notes,
                    keep_alive_interval: keep_alive,
                    created_at: now,
                    updated_at: now,
                    deleted_at: None,
                    sync_version: 1,
                }
            };

            let prev_seq = guard.envelopes.get(&record.id).and_then(|e| e.server_seq);
            let env = encrypt_vault_item(
                &key,
                "host",
                &record.id,
                &record,
                EnvelopeMetaInput {
                    is_deleted: false,
                    client_updated_at: now,
                    dirty: Some(true),
                    server_seq: prev_seq,
                },
            )?;

            guard.hosts.insert(record.id.clone(), record.clone());
            guard.envelopes.insert(record.id.clone(), env);
            (record, guard.envelopes.clone())
        };

        self.persist_envelopes(&snapshot_envelopes).await?;
        self.emit_local_mutation();
        Ok(record)
    }

    pub async fn delete_host(&self, host_id: &str) -> Result<(), String> {
        let now = now_ms();
        let snapshot_envelopes = {
            let mut guard = self.inner.write().await;
            let key = guard
                .master_key
                .ok_or_else(|| "保险库处于锁定状态，请先解锁".to_string())?;
            let Some(existing) = guard.hosts.get(host_id).cloned() else {
                return Ok(());
            };
            let tombstone = HostConfig {
                deleted_at: Some(now),
                updated_at: now,
                sync_version: existing.sync_version + 1,
                ..existing
            };
            let prev_seq = guard.envelopes.get(host_id).and_then(|e| e.server_seq);
            let env = encrypt_vault_item(
                &key,
                "host",
                host_id,
                &tombstone,
                EnvelopeMetaInput {
                    is_deleted: true,
                    client_updated_at: now,
                    dirty: Some(true),
                    server_seq: prev_seq,
                },
            )?;
            guard.hosts.insert(host_id.to_string(), tombstone);
            guard.envelopes.insert(host_id.to_string(), env);
            guard.envelopes.clone()
        };

        self.persist_envelopes(&snapshot_envelopes).await?;
        self.emit_local_mutation();
        Ok(())
    }

    pub async fn save_snippet(&self, input: SnippetInput) -> Result<Snippet, String> {
        let title = input.title.trim().to_string();
        let command = input.command.replace("\r\n", "\n");
        let category = {
            let c = input.category.trim();
            if c.is_empty() {
                "常用命令".to_string()
            } else {
                c.to_string()
            }
        };

        if title.is_empty() {
            return Err("快捷命令标题不能为空".to_string());
        }
        if command.trim().is_empty() {
            return Err("命令内容不能为空".to_string());
        }

        let tags = Self::normalize_tags(input.tags);
        let description = input.description.trim().to_string();
        let now = now_ms();

        let (record, snapshot_envelopes) = {
            let mut guard = self.inner.write().await;
            let key = guard
                .master_key
                .ok_or_else(|| "保险库处于锁定状态，请先解锁".to_string())?;

            let existing = input.id.as_ref().and_then(|id| guard.snippets.get(id)).cloned();
            let record = if let Some(ex) = existing {
                Snippet {
                    id: ex.id,
                    title,
                    command,
                    category,
                    tags,
                    description,
                    created_at: ex.created_at,
                    updated_at: now,
                    deleted_at: None,
                    sync_version: ex.sync_version + 1,
                }
            } else {
                Snippet {
                    id: input
                        .id
                        .filter(|s| !s.trim().is_empty())
                        .unwrap_or_else(|| Uuid::new_v4().to_string()),
                    title,
                    command,
                    category,
                    tags,
                    description,
                    created_at: now,
                    updated_at: now,
                    deleted_at: None,
                    sync_version: 1,
                }
            };

            let prev_seq = guard.envelopes.get(&record.id).and_then(|e| e.server_seq);
            let env = encrypt_vault_item(
                &key,
                "snippet",
                &record.id,
                &record,
                EnvelopeMetaInput {
                    is_deleted: false,
                    client_updated_at: now,
                    dirty: Some(true),
                    server_seq: prev_seq,
                },
            )?;

            guard.snippets.insert(record.id.clone(), record.clone());
            guard.envelopes.insert(record.id.clone(), env);
            (record, guard.envelopes.clone())
        };

        self.persist_envelopes(&snapshot_envelopes).await?;
        self.emit_local_mutation();
        Ok(record)
    }

    pub async fn delete_snippet(&self, snippet_id: &str) -> Result<(), String> {
        let now = now_ms();
        let snapshot_envelopes = {
            let mut guard = self.inner.write().await;
            let key = guard
                .master_key
                .ok_or_else(|| "保险库处于锁定状态，请先解锁".to_string())?;
            let Some(existing) = guard.snippets.get(snippet_id).cloned() else {
                return Ok(());
            };
            let tombstone = Snippet {
                deleted_at: Some(now),
                updated_at: now,
                sync_version: existing.sync_version + 1,
                ..existing
            };
            let prev_seq = guard.envelopes.get(snippet_id).and_then(|e| e.server_seq);
            let env = encrypt_vault_item(
                &key,
                "snippet",
                snippet_id,
                &tombstone,
                EnvelopeMetaInput {
                    is_deleted: true,
                    client_updated_at: now,
                    dirty: Some(true),
                    server_seq: prev_seq,
                },
            )?;
            guard.snippets.insert(snippet_id.to_string(), tombstone);
            guard.envelopes.insert(snippet_id.to_string(), env);
            guard.envelopes.clone()
        };

        self.persist_envelopes(&snapshot_envelopes).await?;
        self.emit_local_mutation();
        Ok(())
    }

    pub async fn update_preferences(&self, patch: PreferencesPatch) -> Result<UserPreferences, String> {
        let now = now_ms();
        let (next, snapshot_envelopes) = {
            let mut guard = self.inner.write().await;
            let key = guard
                .master_key
                .ok_or_else(|| "保险库处于锁定状态，请先解锁".to_string())?;

            let current = guard
                .preferences
                .clone()
                .unwrap_or_else(|| UserPreferences::default_with_time(now, 0));

            let next = UserPreferences {
                id: "preferences".to_string(),
                font_family: patch.font_family.unwrap_or(current.font_family),
                font_size: patch.font_size.unwrap_or(current.font_size),
                line_height: patch.line_height.unwrap_or(current.line_height),
                cursor_style: patch.cursor_style.unwrap_or(current.cursor_style),
                cursor_blink: patch.cursor_blink.unwrap_or(current.cursor_blink),
                copy_on_select: patch.copy_on_select.unwrap_or(current.copy_on_select),
                right_click_paste: patch.right_click_paste.unwrap_or(current.right_click_paste),
                right_click_action: patch.right_click_action.or(current.right_click_action),
                auto_reconnect_prompt: patch
                    .auto_reconnect_prompt
                    .unwrap_or(current.auto_reconnect_prompt),
                scrollback: patch.scrollback.unwrap_or(current.scrollback),
                created_at: current.created_at,
                updated_at: now,
                deleted_at: None,
                sync_version: current.sync_version + 1,
            };

            let prev_seq = guard.envelopes.get(&next.id).and_then(|e| e.server_seq);
            let env = encrypt_vault_item(
                &key,
                "preferences",
                &next.id,
                &next,
                EnvelopeMetaInput {
                    is_deleted: false,
                    client_updated_at: now,
                    dirty: Some(true),
                    server_seq: prev_seq,
                },
            )?;

            guard.preferences = Some(next.clone());
            guard.envelopes.insert(next.id.clone(), env);
            (next, guard.envelopes.clone())
        };

        self.persist_envelopes(&snapshot_envelopes).await?;
        self.emit_local_mutation();
        Ok(next)
    }

    // --- Cloud Sync Helpers ---

    pub async fn verify_master_key_against(&self, remote_key_check: &CipherPayload) -> Result<bool, String> {
        let guard = self.inner.read().await;
        let key = guard
            .master_key
            .ok_or_else(|| "保险库处于锁定状态，请先解锁".to_string())?;
        Ok(verify_key_check(&key, remote_key_check))
    }

    pub async fn get_pending_count(&self) -> usize {
        let guard = self.inner.read().await;
        if guard.master_key.is_none() {
            return 0;
        }
        guard
            .envelopes
            .values()
            .filter(|env| env.dirty != Some(false))
            .count()
    }

    pub async fn get_envelopes_for_push(&self, force_all: bool) -> Result<Vec<EncryptedEnvelope>, String> {
        let guard = self.inner.read().await;
        if guard.master_key.is_none() {
            return Err("保险库处于锁定状态，请先解锁".to_string());
        }
        Ok(guard
            .envelopes
            .values()
            .filter(|env| force_all || env.dirty != Some(false))
            .cloned()
            .collect())
    }

    pub async fn update_sync_meta(&self, patch: SyncMetaPatch) -> Result<VaultMeta, String> {
        let meta = {
            let mut guard = self.inner.write().await;
            if guard.meta.is_none() {
                let disk_meta = read_json_file::<VaultMeta>(&self.meta_path())
                    .await?
                    .ok_or_else(|| "本地保险库尚未初始化".to_string())?;
                guard.meta = Some(disk_meta);
            }
            let m = guard.meta.as_mut().unwrap();
            if let Some(v) = patch.enabled {
                m.sync.enabled = v;
            }
            if let Some(v) = patch.provider {
                m.sync.provider = Some(v);
            }
            if let Some(v) = patch.server_url {
                m.sync.server_url = v;
            }
            if let Some(v) = patch.username {
                m.sync.username = v;
            }
            if let Some(v) = patch.webdav_remote_dir {
                m.sync.webdav_remote_dir = Some(v);
            }
            if let Some(v) = patch.webdav_last_etag {
                m.sync.webdav_last_etag = v;
            }
            if let Some(v) = patch.last_server_seq {
                m.sync.last_server_seq = v;
            }
            if let Some(v) = patch.last_synced_at {
                m.sync.last_synced_at = v;
            }
            if let Some(v) = patch.auto_sync_on_unlock {
                m.sync.auto_sync_on_unlock = Some(v);
            }
            if let Some(v) = patch.auto_push_on_change {
                m.sync.auto_push_on_change = Some(v);
            }
            m.clone()
        };

        atomic_write_json(&self.meta_path(), &meta).await?;
        Ok(meta)
    }

    pub async fn initialize_from_remote(&self, params: RemoteInitParams) -> Result<(), String> {
        if file_exists(&self.meta_path()).await {
            return Err("本地保险库已存在，请先解锁后再登录绑定云同步".to_string());
        }

        let mut derived_key =
            derive_master_key(params.master_password, params.kdf.clone()).await?;
        if !verify_key_check(&derived_key, &params.key_check) {
            derived_key.zeroize();
            return Err("主密码与云端保险库不匹配，无法解密数据".to_string());
        }

        tokio::fs::create_dir_all(&self.vault_dir)
            .await
            .map_err(|e| format!("创建保险库目录失败: {e}"))?;

        let now = now_ms();
        let meta = VaultMeta {
            schema_version: SCHEMA_VERSION,
            device_id: Uuid::new_v4().to_string(),
            created_at: now,
            kdf: params.kdf,
            key_check: params.key_check,
            sync: SyncConfigMeta {
                enabled: true,
                provider: Some(params.provider),
                server_url: params.server_url,
                username: params.username,
                webdav_remote_dir: params.webdav_remote_dir,
                webdav_last_etag: None,
                last_server_seq: 0,
                last_synced_at: None,
                auto_sync_on_unlock: Some(true),
                auto_push_on_change: Some(true),
            },
        };

        let empty_envelopes = HashMap::new();
        atomic_write_json(&self.meta_path(), &meta).await?;
        self.persist_envelopes(&empty_envelopes).await?;

        let mut guard = self.inner.write().await;
        guard.master_key = Some(derived_key);
        guard.meta = Some(meta);
        guard.envelopes = empty_envelopes;
        guard.groups.clear();
        guard.hosts.clear();
        guard.snippets.clear();
        guard.preferences = Some(UserPreferences::default_with_time(now, 0));
        Ok(())
    }

    pub async fn adopt_remote_kdf(
        &self,
        remote_master_password: String,
        remote_kdf: KdfParams,
        remote_key_check: CipherPayload,
    ) -> Result<(), String> {
        let mut new_key = derive_master_key(remote_master_password, remote_kdf.clone()).await?;
        if !verify_key_check(&new_key, &remote_key_check) {
            new_key.zeroize();
            return Err("输入的云端主密码不正确，无法解密并合并云端保险库".to_string());
        }

        let (next_meta, next_envelopes) = {
            let mut guard = self.inner.write().await;
            if guard.master_key.is_none() {
                new_key.zeroize();
                return Err("保险库处于锁定状态，请先解锁".to_string());
            }
            if guard.meta.is_none() {
                new_key.zeroize();
                return Err("未找到本地保险库元数据".to_string());
            }

            let mut next_envelopes = HashMap::new();
            let untouched_group_ids: Vec<String> = guard
                .groups
                .values()
                .filter(|g| {
                    g.name == "默认服务器"
                        && g.sync_version == 1
                        && g.deleted_at.is_none()
                        && !guard
                            .hosts
                            .values()
                            .any(|h| h.group_id.as_deref() == Some(g.id.as_str()))
                })
                .map(|g| g.id.clone())
                .collect();

            for gid in untouched_group_ids {
                guard.groups.remove(&gid);
            }

            for group in guard.groups.values() {
                let env = encrypt_vault_item(
                    &new_key,
                    "group",
                    &group.id,
                    group,
                    EnvelopeMetaInput {
                        is_deleted: group.deleted_at.is_some(),
                        client_updated_at: group.updated_at,
                        dirty: Some(true),
                        server_seq: None,
                    },
                )?;
                next_envelopes.insert(group.id.clone(), env);
            }

            for host in guard.hosts.values() {
                let env = encrypt_vault_item(
                    &new_key,
                    "host",
                    &host.id,
                    host,
                    EnvelopeMetaInput {
                        is_deleted: host.deleted_at.is_some(),
                        client_updated_at: host.updated_at,
                        dirty: Some(true),
                        server_seq: None,
                    },
                )?;
                next_envelopes.insert(host.id.clone(), env);
            }

            for snippet in guard.snippets.values() {
                let env = encrypt_vault_item(
                    &new_key,
                    "snippet",
                    &snippet.id,
                    snippet,
                    EnvelopeMetaInput {
                        is_deleted: snippet.deleted_at.is_some(),
                        client_updated_at: snippet.updated_at,
                        dirty: Some(true),
                        server_seq: None,
                    },
                )?;
                next_envelopes.insert(snippet.id.clone(), env);
            }

            if let Some(prefs) = &guard.preferences {
                if prefs.sync_version > 1 {
                    let env = encrypt_vault_item(
                        &new_key,
                        "preferences",
                        &prefs.id,
                        prefs,
                        EnvelopeMetaInput {
                            is_deleted: false,
                            client_updated_at: prefs.updated_at,
                            dirty: Some(true),
                            server_seq: None,
                        },
                    )?;
                    next_envelopes.insert(prefs.id.clone(), env);
                }
            }

            if let Some(mut old_key) = guard.master_key.take() {
                old_key.zeroize();
            }
            guard.master_key = Some(new_key);
            guard.envelopes = next_envelopes.clone();

            let m = guard.meta.as_mut().unwrap();
            m.kdf = remote_kdf;
            m.key_check = remote_key_check;
            (m.clone(), next_envelopes)
        };

        atomic_write_json(&self.meta_path(), &next_meta).await?;
        self.persist_envelopes(&next_envelopes).await?;
        Ok(())
    }

    fn store_decoded_envelope(guard: &mut VaultInner, key: &[u8; 32], remote: &EncryptedEnvelope) -> Result<(), String> {
        match remote.item_type.as_str() {
            "group" => {
                let g: HostGroup = decrypt_vault_item(key, remote)?;
                guard.groups.insert(g.id.clone(), g);
            }
            "host" => {
                let h: HostConfig = decrypt_vault_item(key, remote)?;
                guard.hosts.insert(h.id.clone(), h);
            }
            "snippet" => {
                let s: Snippet = decrypt_vault_item(key, remote)?;
                guard.snippets.insert(s.id.clone(), s);
            }
            "preferences" => {
                let p: UserPreferences = decrypt_vault_item(key, remote)?;
                guard.preferences = Some(p);
            }
            _ => {}
        }
        Ok(())
    }

    fn save_conflict_copy_if_needed(guard: &mut VaultInner, key: &[u8; 32], local_env: &EncryptedEnvelope) {
        if local_env.is_deleted {
            return;
        }
        let now = now_ms();
        let stamp = Local::now().format("%m-%d %H:%M").to_string();

        if local_env.item_type == "host" {
            if let Some(local_host) = guard.hosts.get(&local_env.item_id).cloned() {
                if local_host.deleted_at.is_none() {
                    let copy = HostConfig {
                        id: Uuid::new_v4().to_string(),
                        name: format!("{} (冲突副本 {})", local_host.name, stamp),
                        created_at: now,
                        updated_at: now,
                        sync_version: 1,
                        ..local_host
                    };
                    if let Ok(env) = encrypt_vault_item(
                        key,
                        "host",
                        &copy.id,
                        &copy,
                        EnvelopeMetaInput {
                            is_deleted: false,
                            client_updated_at: now,
                            dirty: Some(true),
                            server_seq: None,
                        },
                    ) {
                        guard.hosts.insert(copy.id.clone(), copy.clone());
                        guard.envelopes.insert(copy.id, env);
                    }
                }
            }
        } else if local_env.item_type == "snippet" {
            if let Some(local_snippet) = guard.snippets.get(&local_env.item_id).cloned() {
                if local_snippet.deleted_at.is_none() {
                    let copy = Snippet {
                        id: Uuid::new_v4().to_string(),
                        title: format!("{} (冲突副本 {})", local_snippet.title, stamp),
                        created_at: now,
                        updated_at: now,
                        sync_version: 1,
                        ..local_snippet
                    };
                    if let Ok(env) = encrypt_vault_item(
                        key,
                        "snippet",
                        &copy.id,
                        &copy,
                        EnvelopeMetaInput {
                            is_deleted: false,
                            client_updated_at: now,
                            dirty: Some(true),
                            server_seq: None,
                        },
                    ) {
                        guard.snippets.insert(copy.id.clone(), copy.clone());
                        guard.envelopes.insert(copy.id, env);
                    }
                }
            }
        }
    }

    pub async fn merge_snapshot_envelopes(
        &self,
        remote_items: &HashMap<String, EncryptedEnvelope>,
    ) -> Result<SnapshotMergeOutcome, String> {
        let (pulled_count, conflict_count, needs_push, maybe_persist) = {
            let mut guard = self.inner.write().await;
            let key = guard
                .master_key
                .ok_or_else(|| "保险库处于锁定状态，请先解锁".to_string())?;

            let mut pulled_count = 0usize;
            let mut conflict_count = 0usize;
            let mut changed = false;

            for (item_id, remote) in remote_items {
                let local_opt = guard.envelopes.get(item_id).cloned();
                let Some(mut local_env) = local_opt else {
                    Self::store_decoded_envelope(&mut guard, &key, remote)?;
                    let mut clean = remote.clone();
                    clean.dirty = Some(false);
                    guard.envelopes.insert(item_id.clone(), clean);
                    pulled_count += 1;
                    changed = true;
                    continue;
                };

                if local_env.ciphertext == remote.ciphertext {
                    if local_env.dirty != Some(false) {
                        local_env.dirty = Some(false);
                        guard.envelopes.insert(item_id.clone(), local_env);
                        changed = true;
                    }
                    continue;
                }

                if local_env.dirty != Some(true) {
                    if remote.client_updated_at >= local_env.client_updated_at {
                        Self::store_decoded_envelope(&mut guard, &key, remote)?;
                        let mut clean = remote.clone();
                        clean.dirty = Some(false);
                        guard.envelopes.insert(item_id.clone(), clean);
                        pulled_count += 1;
                        changed = true;
                    }
                    continue;
                }

                // Both local dirty and remote modified
                if remote.client_updated_at > local_env.client_updated_at {
                    conflict_count += 1;
                    Self::save_conflict_copy_if_needed(&mut guard, &key, &local_env);
                    Self::store_decoded_envelope(&mut guard, &key, remote)?;
                    let mut clean = remote.clone();
                    clean.dirty = Some(false);
                    guard.envelopes.insert(item_id.clone(), clean);
                    pulled_count += 1;
                    changed = true;
                } else {
                    conflict_count += 1;
                }
            }

            let needs_push = guard.envelopes.iter().any(|(id, env)| {
                if env.dirty != Some(false) {
                    return true;
                }
                match remote_items.get(id) {
                    None => true,
                    Some(r) => r.ciphertext != env.ciphertext,
                }
            });

            let persist = if changed {
                Some(guard.envelopes.clone())
            } else {
                None
            };
            (pulled_count, conflict_count, needs_push, persist)
        };

        if let Some(envelopes) = maybe_persist {
            self.persist_envelopes(&envelopes).await?;
        }

        Ok(SnapshotMergeOutcome {
            pulled_count,
            conflict_count,
            needs_push,
        })
    }

    pub async fn build_snapshot_map_for_upload(
        &self,
        next_revision: i64,
    ) -> Result<SnapshotUploadPayload, String> {
        let guard = self.inner.read().await;
        if guard.master_key.is_none() {
            return Err("保险库处于锁定状态，请先解锁".to_string());
        }

        let mut items = HashMap::new();
        let mut pushed_count = 0usize;

        for (id, env) in &guard.envelopes {
            let is_dirty = env.dirty != Some(false);
            if is_dirty {
                pushed_count += 1;
            }
            let mut copy = env.clone();
            copy.dirty = Some(false);
            copy.server_seq = Some(if is_dirty {
                next_revision
            } else {
                env.server_seq.unwrap_or(next_revision)
            });
            items.insert(id.clone(), copy);
        }

        Ok(SnapshotUploadPayload {
            items,
            pushed_count,
        })
    }

    pub async fn mark_snapshot_uploaded(
        &self,
        revision: i64,
        etag: Option<String>,
    ) -> Result<(), String> {
        let snapshot_envelopes = {
            let mut guard = self.inner.write().await;
            if guard.master_key.is_none() {
                return Err("保险库处于锁定状态，请先解锁".to_string());
            }
            for env in guard.envelopes.values_mut() {
                if env.dirty != Some(false) {
                    env.dirty = Some(false);
                    env.server_seq = Some(revision);
                }
            }
            guard.envelopes.clone()
        };

        self.persist_envelopes(&snapshot_envelopes).await?;
        self.update_sync_meta(SyncMetaPatch {
            last_server_seq: Some(revision),
            webdav_last_etag: Some(etag),
            last_synced_at: Some(Some(now_ms())),
            ..Default::default()
        })
        .await?;
        Ok(())
    }

    pub async fn apply_remote_envelopes(
        &self,
        remote_envelopes: &[EncryptedEnvelope],
        latest_seq: i64,
    ) -> Result<(usize, usize), String> {
        let (applied_count, conflict_count, maybe_persist, current_seq) = {
            let mut guard = self.inner.write().await;
            let key = guard
                .master_key
                .ok_or_else(|| "保险库处于锁定状态，请先解锁".to_string())?;

            let mut applied_count = 0usize;
            let mut conflict_count = 0usize;
            let mut changed = false;

            for remote in remote_envelopes {
                if let Some(local_env) = guard.envelopes.get(&remote.item_id).cloned() {
                    if local_env.dirty == Some(true) {
                        if local_env.client_updated_at > remote.client_updated_at {
                            conflict_count += 1;
                            continue;
                        }
                        conflict_count += 1;
                        Self::save_conflict_copy_if_needed(&mut guard, &key, &local_env);
                    }
                }

                Self::store_decoded_envelope(&mut guard, &key, remote)?;
                let mut clean = remote.clone();
                clean.dirty = Some(false);
                guard.envelopes.insert(remote.item_id.clone(), clean);
                applied_count += 1;
                changed = true;
            }

            let cur_seq = guard
                .meta
                .as_ref()
                .map(|m| m.sync.last_server_seq)
                .unwrap_or(0);
            let persist = if changed {
                Some(guard.envelopes.clone())
            } else {
                None
            };
            (applied_count, conflict_count, persist, cur_seq)
        };

        if let Some(envelopes) = maybe_persist {
            self.persist_envelopes(&envelopes).await?;
        }

        self.update_sync_meta(SyncMetaPatch {
            last_server_seq: Some(current_seq.max(latest_seq)),
            last_synced_at: Some(Some(now_ms())),
            ..Default::default()
        })
        .await?;

        Ok((applied_count, conflict_count))
    }

    pub async fn mark_envelopes_accepted(
        &self,
        accepted: &[SyncPushAcceptedItem],
        accepted_seq: i64,
    ) -> Result<(), String> {
        let (snapshot_envelopes, current_seq) = {
            let mut guard = self.inner.write().await;
            if guard.master_key.is_none() {
                return Err("保险库处于锁定状态，请先解锁".to_string());
            }
            for item in accepted {
                if let Some(env) = guard.envelopes.get_mut(&item.item_id) {
                    env.dirty = Some(false);
                    env.server_seq = Some(item.server_seq);
                }
            }
            let cur_seq = guard
                .meta
                .as_ref()
                .map(|m| m.sync.last_server_seq)
                .unwrap_or(0);
            (guard.envelopes.clone(), cur_seq)
        };

        self.persist_envelopes(&snapshot_envelopes).await?;
        self.update_sync_meta(SyncMetaPatch {
            last_server_seq: Some(current_seq.max(accepted_seq)),
            last_synced_at: Some(Some(now_ms())),
            ..Default::default()
        })
        .await?;
        Ok(())
    }
}
