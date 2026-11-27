use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "provider", rename_all = "kebab-case")]
pub enum StoredSyncSecret {
    SelfHosted { token: String },
    Webdav { password: String },
}

const SECRET_FILE_NAME: &str = "sync.secret.bin";

#[cfg(windows)]
fn protect_bytes(plain: &[u8]) -> Result<Vec<u8>, String> {
    use std::ptr;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    unsafe {
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: plain.len() as u32,
            pbData: plain.as_ptr() as *mut u8,
        };
        let mut out_blob = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        };

        let ok = CryptProtectData(
            &in_blob,
            ptr::null(),
            ptr::null(),
            ptr::null_mut(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        );
        if ok == 0 || out_blob.pbData.is_null() {
            return Err("Windows DPAPI 凭据加密失败".to_string());
        }

        let slice = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize);
        let out = slice.to_vec();
        LocalFree(out_blob.pbData as _);
        Ok(out)
    }
}

#[cfg(windows)]
fn unprotect_bytes(cipher: &[u8]) -> Result<Vec<u8>, String> {
    use std::ptr;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    unsafe {
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: cipher.len() as u32,
            pbData: cipher.as_ptr() as *mut u8,
        };
        let mut out_blob = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        };

        let ok = CryptUnprotectData(
            &in_blob,
            ptr::null_mut(),
            ptr::null(),
            ptr::null_mut(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        );
        if ok == 0 || out_blob.pbData.is_null() {
            return Err("Windows DPAPI 凭据解密失败".to_string());
        }

        let slice = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize);
        let out = slice.to_vec();
        LocalFree(out_blob.pbData as _);
        Ok(out)
    }
}

#[cfg(not(windows))]
fn local_machine_key() -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"xiziterm:local-secret-store:v2:");
    if let Some(home) = dirs::home_dir() {
        hasher.update(home.to_string_lossy().as_bytes());
    }
    if let Ok(user) = std::env::var("USER") {
        hasher.update(user.as_bytes());
    }
    let host = sysinfo::System::host_name().unwrap_or_else(|_| "unix-host".to_string());
    hasher.update(host.as_bytes());
    let digest = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

#[cfg(not(windows))]
fn protect_bytes(plain: &[u8]) -> Result<Vec<u8>, String> {
    let key = local_machine_key();
    let text = std::str::from_utf8(plain).map_err(|_| "无效的凭据文本".to_string())?;
    let payload = super::crypto::encrypt_payload(&key, text, "xiziterm:sync-secret:v2")?;
    serde_json::to_vec(&payload).map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn unprotect_bytes(cipher: &[u8]) -> Result<Vec<u8>, String> {
    let key = local_machine_key();
    let payload: crate::models::CipherPayload =
        serde_json::from_slice(cipher).map_err(|e| e.to_string())?;
    let text = super::crypto::decrypt_payload(&key, &payload, "xiziterm:sync-secret:v2")?;
    Ok(text.into_bytes())
}

pub async fn save_sync_secret(vault_dir: &Path, secret: &StoredSyncSecret) -> Result<(), String> {
    tokio::fs::create_dir_all(vault_dir)
        .await
        .map_err(|e| format!("创建凭据目录失败: {e}"))?;
    let json = serde_json::to_vec(secret).map_err(|e| e.to_string())?;
    let encrypted = protect_bytes(&json)?;
    let target = vault_dir.join(SECRET_FILE_NAME);
    tokio::fs::write(&target, encrypted)
        .await
        .map_err(|e| format!("保存同步凭据失败: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600));
    }

    Ok(())
}

pub async fn load_sync_secret(vault_dir: &Path) -> Option<StoredSyncSecret> {
    let target = vault_dir.join(SECRET_FILE_NAME);
    let raw = tokio::fs::read(&target).await.ok()?;
    let plain = unprotect_bytes(&raw).ok()?;
    serde_json::from_slice::<StoredSyncSecret>(&plain).ok()
}

pub async fn clear_sync_secret(vault_dir: &Path) {
    let target = vault_dir.join(SECRET_FILE_NAME);
    let _ = tokio::fs::remove_file(target).await;
}
