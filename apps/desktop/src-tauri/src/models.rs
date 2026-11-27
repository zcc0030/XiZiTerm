use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const LOCAL_HOST_ID: &str = "__local_terminal__";

pub const IPC_EVENT_SSH_DATA: &str = "ssh:data";
pub const IPC_EVENT_SSH_STATE: &str = "ssh:state";
pub const IPC_EVENT_SFTP_PROGRESS: &str = "sftp:transfer-progress";
pub const IPC_EVENT_MONITOR_SAMPLE: &str = "monitor:sample";
pub const IPC_EVENT_MONITOR_ERROR: &str = "monitor:error";
pub const IPC_EVENT_SYNC_STATE: &str = "sync:state-event";
pub const IPC_EVENT_DEPLOY_LOG: &str = "sync:deploy-log";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult<T> {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl<T> ActionResult<T> {
    pub fn ok(data: T) -> Self {
        Self {
            ok: true,
            data: Some(data),
            error: None,
        }
    }

    pub fn err(msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            data: None,
            error: Some(msg.into()),
        }
    }
}

impl ActionResult<()> {
    pub fn ok_unit() -> Self {
        Self {
            ok: true,
            data: None,
            error: None,
        }
    }
}

// --- Crypto & Vault Metadata ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KdfParams {
    pub algorithm: String,
    pub iterations: u32,
    pub key_length: usize,
    pub salt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CipherPayload {
    pub iv: String,
    pub auth_tag: String,
    pub ciphertext: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedEnvelope {
    pub item_id: String,
    pub item_type: String,
    pub schema_version: u32,
    pub iv: String,
    pub auth_tag: String,
    pub ciphertext: String,
    pub is_deleted: bool,
    pub client_updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_seq: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dirty: Option<bool>,
}

fn default_true_opt() -> Option<bool> {
    Some(true)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfigMeta {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default)]
    pub server_url: String,
    #[serde(default)]
    pub username: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webdav_remote_dir: Option<String>,
    #[serde(default)]
    pub webdav_last_etag: Option<String>,
    #[serde(default)]
    pub last_server_seq: i64,
    #[serde(default)]
    pub last_synced_at: Option<i64>,
    #[serde(default = "default_true_opt", skip_serializing_if = "Option::is_none")]
    pub auto_sync_on_unlock: Option<bool>,
    #[serde(default = "default_true_opt", skip_serializing_if = "Option::is_none")]
    pub auto_push_on_change: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultMeta {
    pub schema_version: u32,
    pub device_id: String,
    pub created_at: i64,
    pub kdf: KdfParams,
    pub key_check: CipherPayload,
    pub sync: SyncConfigMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultItemsDisk {
    pub schema_version: u32,
    pub envelopes: HashMap<String, EncryptedEnvelope>,
}

// --- Vault Domain Records ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostGroup {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub color: String,
    pub sort_order: i32,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
    pub sync_version: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostGroupInput {
    pub id: Option<String>,
    pub name: String,
    pub parent_id: Option<String>,
    pub color: String,
    pub sort_order: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostConfig {
    pub id: String,
    pub group_id: Option<String>,
    pub name: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passphrase: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub keep_alive_interval: u64,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
    pub sync_version: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInput {
    pub id: Option<String>,
    pub group_id: Option<String>,
    pub name: String,
    pub hostname: String,
    pub port: i32,
    pub username: String,
    pub auth_type: String,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub keep_alive_interval: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub title: String,
    pub command: String,
    pub category: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub description: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
    pub sync_version: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetInput {
    pub id: Option<String>,
    pub title: String,
    pub command: String,
    pub category: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub description: String,
}

fn default_font_family() -> String {
    "'JetBrains Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace".to_string()
}
fn default_font_size() -> u32 {
    14
}
fn default_line_height() -> f64 {
    1.25
}
fn default_cursor_style() -> String {
    "bar".to_string()
}
fn default_true() -> bool {
    true
}
fn default_scrollback() -> u32 {
    5000
}
fn default_right_click_action() -> Option<String> {
    Some("menu".to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserPreferences {
    pub id: String,
    #[serde(default = "default_font_family")]
    pub font_family: String,
    #[serde(default = "default_font_size")]
    pub font_size: u32,
    #[serde(default = "default_line_height")]
    pub line_height: f64,
    #[serde(default = "default_cursor_style")]
    pub cursor_style: String,
    #[serde(default = "default_true")]
    pub cursor_blink: bool,
    #[serde(default)]
    pub copy_on_select: bool,
    #[serde(default)]
    pub right_click_paste: bool,
    #[serde(default = "default_right_click_action", skip_serializing_if = "Option::is_none")]
    pub right_click_action: Option<String>,
    #[serde(default = "default_true")]
    pub auto_reconnect_prompt: bool,
    #[serde(default = "default_scrollback")]
    pub scrollback: u32,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
    pub sync_version: i64,
}

impl UserPreferences {
    pub fn default_with_time(now: i64, sync_version: i64) -> Self {
        Self {
            id: "preferences".to_string(),
            font_family: default_font_family(),
            font_size: default_font_size(),
            line_height: default_line_height(),
            cursor_style: default_cursor_style(),
            cursor_blink: true,
            copy_on_select: false,
            right_click_paste: false,
            right_click_action: Some("menu".to_string()),
            auto_reconnect_prompt: true,
            scrollback: 5000,
            created_at: now,
            updated_at: now,
            deleted_at: None,
            sync_version,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferencesPatch {
    pub font_family: Option<String>,
    pub font_size: Option<u32>,
    pub line_height: Option<f64>,
    pub cursor_style: Option<String>,
    pub cursor_blink: Option<bool>,
    pub copy_on_select: Option<bool>,
    pub right_click_paste: Option<bool>,
    pub right_click_action: Option<String>,
    pub auto_reconnect_prompt: Option<bool>,
    pub scrollback: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultData {
    pub groups: Vec<HostGroup>,
    pub hosts: Vec<HostConfig>,
    pub snippets: Vec<Snippet>,
    pub preferences: UserPreferences,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub initialized: bool,
    pub unlocked: bool,
    pub vault_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kdf_algorithm: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kdf_iterations: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyFileSelection {
    pub file_path: String,
    pub content: String,
}

// --- SSH & Local PTY Models ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalShellProfile {
    pub id: String,
    pub label: String,
    pub command: String,
    pub args: Vec<String>,
    pub platform: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectRequest {
    pub session_id: String,
    pub host_id: String,
    pub cols: u16,
    pub rows: u16,
    pub shell_id: Option<String>,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTestConnectionRequest {
    pub hostname: String,
    pub port: i32,
    pub username: String,
    pub auth_type: String,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTestConnectionResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_info: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshResizePayload {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshDataEvent {
    pub session_id: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshStateEvent {
    pub session_id: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<i32>,
}

// --- SFTP Models ---

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub mode: u32,
    pub permissions: String,
    pub octal_mode: String,
    pub uid: u32,
    pub gid: u32,
    pub modified_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpListResult {
    pub cwd: String,
    pub entries: Vec<SftpEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpReadTextResult {
    pub path: String,
    pub content: String,
    pub size: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpTransferProgressEvent {
    pub transfer_id: String,
    pub session_id: String,
    pub direction: String,
    pub file_name: String,
    pub remote_path: String,
    pub local_path: String,
    pub transferred: u64,
    pub total: u64,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadCountResult {
    pub uploaded_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadPathResult {
    pub local_path: String,
}

// --- Cockpit Monitor Models ---

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskPartitionUsage {
    pub filesystem: String,
    pub mount: String,
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub available_bytes: u64,
    pub used_percent: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetInterfaceRate {
    pub name: String,
    pub rx_bytes_per_sec: f64,
    pub tx_bytes_per_sec: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostMetricsSnapshot {
    pub session_id: String,
    pub timestamp: i64,
    pub hostname: String,
    pub os_pretty_name: String,
    pub kernel: String,
    pub uptime_seconds: u64,
    pub cpu_cores: usize,
    pub cpu_usage_percent: f64,
    pub load_average: [f64; 3],
    pub mem_total_bytes: u64,
    pub mem_used_bytes: u64,
    pub mem_available_bytes: u64,
    pub mem_usage_percent: f64,
    pub swap_total_bytes: u64,
    pub swap_used_bytes: u64,
    pub swap_usage_percent: f64,
    pub disks: Vec<DiskPartitionUsage>,
    pub net_rx_bytes_per_sec: f64,
    pub net_tx_bytes_per_sec: f64,
    pub net_interfaces: Vec<NetInterfaceRate>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorErrorEvent {
    pub session_id: String,
    pub error: String,
    pub timestamp: i64,
}

// --- Cloud Sync & Deploy Models ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncAuthResponse {
    pub token: String,
    pub user_id: String,
    pub username: String,
    pub kdf: KdfParams,
    pub key_check: CipherPayload,
    #[serde(default)]
    pub latest_seq: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncMeResponse {
    pub user_id: String,
    pub username: String,
    pub kdf: KdfParams,
    pub key_check: CipherPayload,
    #[serde(default)]
    pub latest_seq: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPullResponse {
    pub latest_seq: i64,
    pub items: Vec<EncryptedEnvelope>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPushAcceptedItem {
    pub item_id: String,
    pub server_seq: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPushResponse {
    pub accepted_seq: i64,
    pub accepted: Vec<SyncPushAcceptedItem>,
    pub conflicts: Vec<EncryptedEnvelope>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatusInfo {
    pub enabled: bool,
    pub provider: String,
    pub server_url: String,
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webdav_remote_dir: Option<String>,
    pub last_server_seq: i64,
    pub last_synced_at: Option<i64>,
    pub auto_sync_on_unlock: bool,
    pub auto_push_on_change: bool,
    pub pending_count: usize,
    pub state: String,
    pub last_error: Option<String>,
    pub has_token: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStateChangedEvent {
    pub status: SyncStatusInfo,
    pub vault_updated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRunResult {
    pub pulled_count: usize,
    pub pushed_count: usize,
    pub conflict_count: usize,
    pub latest_seq: i64,
    pub synced_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncBindCredentials {
    pub server_url: String,
    pub username: String,
    pub password: String,
    pub invite_code: Option<String>,
    pub master_password: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncBindTokenPayload {
    pub server_url: String,
    pub token: String,
    pub master_password: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncWebDavTestPayload {
    pub server_url: String,
    pub username: String,
    pub password: String,
    pub remote_dir: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncWebDavTestResult {
    pub folder_exists: bool,
    pub has_vault_file: bool,
    pub writable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available_shares: Option<Vec<String>>,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncWebDavBindPayload {
    pub server_url: String,
    pub username: String,
    pub password: String,
    pub remote_dir: String,
    pub master_password: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavVaultBundle {
    pub format: String,
    pub schema_version: u32,
    pub updated_at: i64,
    pub updated_by_device_id: String,
    pub revision: i64,
    pub kdf: KdfParams,
    pub key_check: CipherPayload,
    pub items: HashMap<String, EncryptedEnvelope>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRestorePayload {
    pub provider: Option<String>,
    pub server_url: String,
    pub mode: String,
    pub username: Option<String>,
    pub password: Option<String>,
    pub token: Option<String>,
    pub webdav_remote_dir: Option<String>,
    pub master_password: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncNowOptions {
    pub force_full: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOptionsPatch {
    pub auto_sync_on_unlock: Option<bool>,
    pub auto_push_on_change: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerHealthInfo {
    pub version: String,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDeployTemplates {
    pub dockerfile: String,
    pub docker_compose: String,
    pub env_example: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportBundleResult {
    pub target_dir: String,
    pub file_count: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOneClickDeployPayload {
    pub host: String,
    pub ssh_port: i32,
    pub username: String,
    pub password: String,
    pub sync_port: i32,
    pub remote_dir: String,
    pub invite_code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDeployLogEvent {
    pub deploy_id: String,
    pub level: String,
    pub message: String,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOneClickDeployResult {
    pub server_url: String,
    pub remote_health_ok: bool,
    pub client_reachable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}
