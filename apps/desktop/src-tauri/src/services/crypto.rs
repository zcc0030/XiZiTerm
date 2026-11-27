use aes_gcm::{
    aead::{AeadInPlace, KeyInit},
    Aes256Gcm, Nonce, Tag,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use serde::{de::DeserializeOwned, Serialize};
use sha2::Sha512;

use crate::models::{CipherPayload, EncryptedEnvelope, KdfParams};

pub const SCHEMA_VERSION: u32 = 1;
pub const KDF_ALGORITHM: &str = "pbkdf2-sha512";
pub const KDF_ITERATIONS: u32 = 600_000;
pub const KDF_KEY_LENGTH: usize = 32;
pub const SALT_BYTES: usize = 32;
pub const IV_BYTES: usize = 12;
pub const AUTH_TAG_BYTES: usize = 16;
pub const KEY_CHECK_PLAINTEXT: &str = "XIZITERM_KEY_CHECK_V1";
pub const LEGACY_KEY_CHECK_PLAINTEXT: &str = "NEXUSTERM_KEY_CHECK_V1";
pub const KEY_CHECK_ITEM_ID: &str = "__key_check__";

pub fn build_envelope_aad(item_type: &str, item_id: &str, schema_version: u32) -> String {
    format!("xiziterm:v{schema_version}:{item_type}:{item_id}")
}

pub fn build_legacy_envelope_aad(item_type: &str, item_id: &str, schema_version: u32) -> String {
    format!("nexusterm:v{schema_version}:{item_type}:{item_id}")
}

pub fn generate_salt() -> String {
    let mut salt = [0u8; SALT_BYTES];
    rand::thread_rng().fill_bytes(&mut salt);
    B64.encode(salt)
}

pub fn create_default_kdf_params() -> KdfParams {
    KdfParams {
        algorithm: KDF_ALGORITHM.to_string(),
        iterations: KDF_ITERATIONS,
        key_length: KDF_KEY_LENGTH,
        salt: generate_salt(),
    }
}

pub fn derive_master_key_sync(password: &str, kdf: &KdfParams) -> Result<[u8; 32], String> {
    if kdf.key_length != KDF_KEY_LENGTH {
        return Err(format!("不支持的密钥长度: {}", kdf.key_length));
    }
    let salt = B64
        .decode(kdf.salt.trim())
        .map_err(|e| format!("KDF 盐值 Base64 解码失败: {e}"))?;
    let mut derived = [0u8; 32];
    pbkdf2_hmac::<Sha512>(password.as_bytes(), &salt, kdf.iterations, &mut derived);
    Ok(derived)
}

pub async fn derive_master_key(password: String, kdf: KdfParams) -> Result<[u8; 32], String> {
    tokio::task::spawn_blocking(move || derive_master_key_sync(&password, &kdf))
        .await
        .map_err(|e| format!("密钥派生任务异常: {e}"))?
}

pub fn encrypt_payload(
    key: &[u8; 32],
    plaintext: &str,
    aad: &str,
) -> Result<CipherPayload, String> {
    let mut iv = [0u8; IV_BYTES];
    rand::thread_rng().fill_bytes(&mut iv);

    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("初始化加密器失败: {e}"))?;
    let mut buffer = plaintext.as_bytes().to_vec();
    let tag = cipher
        .encrypt_in_place_detached(Nonce::from_slice(&iv), aad.as_bytes(), &mut buffer)
        .map_err(|_| "AES-256-GCM 加密失败".to_string())?;

    Ok(CipherPayload {
        iv: B64.encode(iv),
        auth_tag: B64.encode(tag.as_slice()),
        ciphertext: B64.encode(buffer),
    })
}

pub fn decrypt_payload(
    key: &[u8; 32],
    payload: &CipherPayload,
    aad: &str,
) -> Result<String, String> {
    let iv = B64
        .decode(payload.iv.trim())
        .map_err(|_| "IV Base64 解码失败".to_string())?;
    if iv.len() != IV_BYTES {
        return Err("IV 长度不合法".to_string());
    }

    let auth_tag = B64
        .decode(payload.auth_tag.trim())
        .map_err(|_| "AuthTag Base64 解码失败".to_string())?;
    if auth_tag.len() != AUTH_TAG_BYTES {
        return Err("AuthTag 长度不合法".to_string());
    }

    let mut buffer = B64
        .decode(payload.ciphertext.trim())
        .map_err(|_| "密文 Base64 解码失败".to_string())?;

    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("初始化解密器失败: {e}"))?;
    cipher
        .decrypt_in_place_detached(
            Nonce::from_slice(&iv),
            aad.as_bytes(),
            &mut buffer,
            Tag::from_slice(&auth_tag),
        )
        .map_err(|_| "AES-256-GCM 完整性校验或解密失败".to_string())?;

    String::from_utf8(buffer).map_err(|_| "解密后的数据不是有效的 UTF-8 文本".to_string())
}

pub fn create_key_check(key: &[u8; 32]) -> Result<CipherPayload, String> {
    let aad = build_envelope_aad("key_check", KEY_CHECK_ITEM_ID, SCHEMA_VERSION);
    encrypt_payload(key, KEY_CHECK_PLAINTEXT, &aad)
}

pub fn verify_key_check(key: &[u8; 32], key_check: &CipherPayload) -> bool {
    let aad = build_envelope_aad("key_check", KEY_CHECK_ITEM_ID, SCHEMA_VERSION);
    if let Ok(plain) = decrypt_payload(key, key_check, &aad) {
        if plain == KEY_CHECK_PLAINTEXT {
            return true;
        }
    }

    let legacy_aad = build_legacy_envelope_aad("key_check", KEY_CHECK_ITEM_ID, SCHEMA_VERSION);
    if let Ok(plain) = decrypt_payload(key, key_check, &legacy_aad) {
        if plain == LEGACY_KEY_CHECK_PLAINTEXT {
            return true;
        }
    }

    false
}

pub struct EnvelopeMetaInput {
    pub is_deleted: bool,
    pub client_updated_at: i64,
    pub dirty: Option<bool>,
    pub server_seq: Option<i64>,
}

pub fn encrypt_vault_item<T: Serialize>(
    key: &[u8; 32],
    item_type: &str,
    item_id: &str,
    record: &T,
    meta: EnvelopeMetaInput,
) -> Result<EncryptedEnvelope, String> {
    let aad = build_envelope_aad(item_type, item_id, SCHEMA_VERSION);
    let json_str =
        serde_json::to_string(record).map_err(|e| format!("序列化数据项失败: {e}"))?;
    let cipher = encrypt_payload(key, &json_str, &aad)?;

    Ok(EncryptedEnvelope {
        item_id: item_id.to_string(),
        item_type: item_type.to_string(),
        schema_version: SCHEMA_VERSION,
        iv: cipher.iv,
        auth_tag: cipher.auth_tag,
        ciphertext: cipher.ciphertext,
        is_deleted: meta.is_deleted,
        client_updated_at: meta.client_updated_at,
        dirty: Some(meta.dirty.unwrap_or(true)),
        server_seq: meta.server_seq,
    })
}

pub fn decrypt_vault_item<T: DeserializeOwned>(
    key: &[u8; 32],
    envelope: &EncryptedEnvelope,
) -> Result<T, String> {
    let cipher_payload = CipherPayload {
        iv: envelope.iv.clone(),
        auth_tag: envelope.auth_tag.clone(),
        ciphertext: envelope.ciphertext.clone(),
    };
    let aad = build_envelope_aad(
        &envelope.item_type,
        &envelope.item_id,
        envelope.schema_version,
    );

    let plaintext = match decrypt_payload(key, &cipher_payload, &aad) {
        Ok(p) => p,
        Err(_) => {
            let legacy_aad = build_legacy_envelope_aad(
                &envelope.item_type,
                &envelope.item_id,
                envelope.schema_version,
            );
            decrypt_payload(key, &cipher_payload, &legacy_aad)?
        }
    };

    serde_json::from_str(&plaintext).map_err(|e| format!("解析解密后 JSON 失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_key_check_and_legacy_aad() {
        let kdf = KdfParams {
            algorithm: KDF_ALGORITHM.to_string(),
            iterations: 10_000,
            key_length: 32,
            salt: generate_salt(),
        };
        let key = derive_master_key_sync("test-master-pass", &kdf).unwrap();
        let check = create_key_check(&key).unwrap();
        assert!(verify_key_check(&key, &check));

        let wrong_key = derive_master_key_sync("wrong-pass", &kdf).unwrap();
        assert!(!verify_key_check(&wrong_key, &check));

        // Verify legacy NexusTerm domain tag compatibility
        let legacy_aad = build_legacy_envelope_aad("key_check", KEY_CHECK_ITEM_ID, 1);
        let legacy_check = encrypt_payload(&key, LEGACY_KEY_CHECK_PLAINTEXT, &legacy_aad).unwrap();
        assert!(verify_key_check(&key, &legacy_check));
    }
}
