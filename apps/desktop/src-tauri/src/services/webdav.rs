use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use regex::Regex;
use reqwest::{Client, Method, Response};
use std::collections::HashSet;
use std::time::Duration;
use url::Url;

use crate::models::{SyncWebDavTestResult, WebDavVaultBundle};

pub const WEBDAV_VAULT_FILENAME: &str = "xiziterm-vault.enc.json";
const LEGACY_WEBDAV_VAULT_FILENAME: &str = "nexusterm-vault.enc.json";

const PROPFIND_BODY: &str = "<?xml version=\"1.0\" encoding=\"utf-8\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:resourcetype/><d:getetag/></d:prop></d:propfind>";

#[derive(Debug, Clone)]
pub struct WebDavConnectionConfig {
    pub server_url: String,
    pub username: String,
    pub password: String,
    pub remote_dir: String,
}

#[derive(Debug, Clone)]
pub struct NormalizedWebDavTarget {
    pub base_endpoint_url: String,
    pub collection_url: String,
    pub intermediate_dir_urls: Vec<String>,
    pub file_url: String,
    pub normalized_dir: String,
}

#[derive(Debug)]
pub enum WebDavPutError {
    Conflict,
    Other(String),
}

pub fn normalize_webdav_target(
    raw_server_url: &str,
    raw_remote_dir: &str,
) -> Result<NormalizedWebDavTarget, String> {
    let trimmed = raw_server_url.trim();
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Err("WebDAV 地址必须以 http:// 或 https:// 开头".to_string());
    }

    let parsed = Url::parse(trimmed).map_err(|_| "WebDAV 地址格式不正确".to_string())?;
    let base_endpoint_url = format!("{}/", parsed.as_str().trim_end_matches('/'));

    let fallback_dir = if raw_remote_dir.trim().is_empty() {
        "/XiZiTerm"
    } else {
        raw_remote_dir.trim()
    };

    let raw_segments: Vec<String> = fallback_dir
        .replace('\\', "/")
        .split('/')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();

    let base_path_lower = parsed.path().trim_end_matches('/').to_lowercase();
    let suffix_lower = if raw_segments.is_empty() {
        String::new()
    } else {
        format!("/{}", raw_segments.join("/").to_lowercase())
    };

    let effective_segments: &[String] =
        if !suffix_lower.is_empty() && base_path_lower.ends_with(&suffix_lower) {
            &[]
        } else {
            &raw_segments
        };

    let mut intermediate_dir_urls = Vec::new();
    let mut current_url = base_endpoint_url.clone();
    for seg in effective_segments {
        current_url.push_str(&urlencoding::encode(seg));
        current_url.push('/');
        intermediate_dir_urls.push(current_url.clone());
    }

    let collection_url = current_url;
    let file_url = format!("{collection_url}{WEBDAV_VAULT_FILENAME}");
    let normalized_dir = format!("/{}", raw_segments.join("/"));

    Ok(NormalizedWebDavTarget {
        base_endpoint_url,
        collection_url,
        intermediate_dir_urls,
        file_url,
        normalized_dir,
    })
}

fn format_webdav_http_error(status: u16, context: &str) -> String {
    match status {
        401 => "WebDAV 认证失败 (401)：请检查用户名与密码（若使用坚果云，必须在「账户信息 → 安全选项」中生成第三方应用专用密码，不能填登录密码）".to_string(),
        403 => format!("WebDAV 权限被拒绝 (403)：请确认该账号对目标目录有读写权限（{context}）"),
        405 => "目标地址不支持 WebDAV 协议 (405)：请检查 WebDAV URL 是否填写完整（例如坚果云需包含 /dav/）".to_string(),
        _ => format!("WebDAV 请求失败 ({context})：HTTP {status}"),
    }
}

async fn webdav_request(
    client: &Client,
    method_str: &str,
    url: &str,
    config: &WebDavConnectionConfig,
    headers: &[(&str, &str)],
    body: Option<String>,
    timeout_ms: u64,
) -> Result<Response, String> {
    let method = Method::from_bytes(method_str.as_bytes())
        .map_err(|e| format!("无效的 HTTP 方法 ({method_str}): {e}"))?;
    let basic = B64.encode(format!("{}:{}", config.username.trim(), config.password));

    let mut req = client
        .request(method, url)
        .timeout(Duration::from_millis(timeout_ms))
        .header("Authorization", format!("Basic {basic}"));

    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    if let Some(b) = body {
        req = req.body(b);
    }

    req.send().await.map_err(|e| {
        if e.is_timeout() {
            "连接 WebDAV 服务器超时，请检查地址与网络".to_string()
        } else {
            format!("无法连接 WebDAV 服务器: {e}")
        }
    })
}

async fn list_child_collections(
    client: &Client,
    base_endpoint_url: &str,
    config: &WebDavConnectionConfig,
) -> Vec<String> {
    let Ok(res) = webdav_request(
        client,
        "PROPFIND",
        base_endpoint_url,
        config,
        &[
            ("Depth", "1"),
            ("Content-Type", "application/xml; charset=utf-8"),
        ],
        Some(PROPFIND_BODY.to_string()),
        8_000,
    )
    .await
    else {
        return Vec::new();
    };

    let code = res.status().as_u16();
    if code != 207 && code != 200 {
        return Vec::new();
    }

    let Ok(xml) = res.text().await else {
        return Vec::new();
    };
    let Ok(parsed_base) = Url::parse(base_endpoint_url) else {
        return Vec::new();
    };
    let base_pathname = parsed_base.path().trim_end_matches('/');

    let Ok(re) = Regex::new(r"(?i)<[^:>]*:?href>([^<]+)</[^:>]*:?href>") else {
        return Vec::new();
    };

    let mut seen = HashSet::new();
    let mut names = Vec::new();

    for cap in re.captures_iter(&xml) {
        let Some(m) = cap.get(1) else { continue };
        let mut raw_href = m.as_str().trim().to_string();
        if raw_href.starts_with("http://") || raw_href.starts_with("https://") {
            if let Ok(u) = Url::parse(&raw_href) {
                raw_href = u.path().to_string();
            }
        }
        let Ok(decoded_cow) = urlencoding::decode(&raw_href) else {
            continue;
        };
        let decoded = decoded_cow.trim_end_matches('/');
        if decoded.is_empty() || decoded == base_pathname {
            continue;
        }
        let rel = if !base_pathname.is_empty()
            && decoded.starts_with(&format!("{base_pathname}/"))
        {
            &decoded[base_pathname.len() + 1..]
        } else {
            decoded.trim_start_matches('/')
        };
        if !rel.is_empty() && !rel.contains('/') && !rel.starts_with('.') && seen.insert(rel.to_string()) {
            names.push(rel.to_string());
        }
    }
    names
}

pub async fn test_webdav_connection(
    client: &Client,
    config: &WebDavConnectionConfig,
) -> Result<SyncWebDavTestResult, String> {
    if config.username.trim().is_empty() || config.password.is_empty() {
        return Err("请输入 WebDAV 用户名和密码/应用密码".to_string());
    }

    let target = normalize_webdav_target(&config.server_url, &config.remote_dir)?;

    let col_res = webdav_request(
        client,
        "PROPFIND",
        &target.collection_url,
        config,
        &[
            ("Depth", "0"),
            ("Content-Type", "application/xml; charset=utf-8"),
        ],
        Some(PROPFIND_BODY.to_string()),
        10_000,
    )
    .await?;

    let col_status = col_res.status().as_u16();
    if col_status == 207 || col_status == 200 {
        if target.collection_url == target.base_endpoint_url {
            let probe_dir_url = format!("{}.__xiziterm_check__/", target.base_endpoint_url);
            let mk_check = webdav_request(
                client,
                "MKCOL",
                &probe_dir_url,
                config,
                &[],
                None,
                6_000,
            )
            .await?;
            let mk_code = mk_check.status().as_u16();
            if mk_code == 201 || mk_code == 200 || mk_code == 204 {
                let _ = webdav_request(client, "DELETE", &probe_dir_url, config, &[], None, 5_000).await;
            } else {
                let shares = list_child_collections(client, &target.base_endpoint_url, config).await;
                return Ok(SyncWebDavTestResult {
                    folder_exists: true,
                    has_vault_file: false,
                    writable: false,
                    available_shares: Some(shares),
                    message: "认证成功，但 NAS 根目录不可直接写入，请点击下方共享文件夹选择同步路径".to_string(),
                });
            }
        }

        let file_res = webdav_request(
            client,
            "PROPFIND",
            &target.file_url,
            config,
            &[
                ("Depth", "0"),
                ("Content-Type", "application/xml; charset=utf-8"),
            ],
            Some(PROPFIND_BODY.to_string()),
            8_000,
        )
        .await?;
        let mut has_vault_file = matches!(file_res.status().as_u16(), 200 | 207);
        if !has_vault_file {
            let legacy_url = format!("{}{}", target.collection_url, LEGACY_WEBDAV_VAULT_FILENAME);
            if let Ok(legacy_res) = webdav_request(
                client,
                "PROPFIND",
                &legacy_url,
                config,
                &[
                    ("Depth", "0"),
                    ("Content-Type", "application/xml; charset=utf-8"),
                ],
                Some(PROPFIND_BODY.to_string()),
                6_000,
            )
            .await
            {
                has_vault_file = matches!(legacy_res.status().as_u16(), 200 | 207);
            }
        }

        return Ok(SyncWebDavTestResult {
            folder_exists: true,
            has_vault_file,
            writable: true,
            available_shares: None,
            message: if has_vault_file {
                format!("连接成功 · 已检测到云端加密保险库 ({})", target.normalized_dir)
            } else {
                format!("连接成功 · 目录 {} 可正常读写", target.normalized_dir)
            },
        });
    }

    if col_status == 404 && target.collection_url != target.base_endpoint_url {
        let base_res = webdav_request(
            client,
            "PROPFIND",
            &target.base_endpoint_url,
            config,
            &[
                ("Depth", "0"),
                ("Content-Type", "application/xml; charset=utf-8"),
            ],
            Some(PROPFIND_BODY.to_string()),
            10_000,
        )
        .await?;
        let base_status = base_res.status().as_u16();
        if base_status == 207 || base_status == 200 {
            for dir_url in &target.intermediate_dir_urls {
                let sub_check = webdav_request(
                    client,
                    "PROPFIND",
                    dir_url,
                    config,
                    &[
                        ("Depth", "0"),
                        ("Content-Type", "application/xml; charset=utf-8"),
                    ],
                    Some(PROPFIND_BODY.to_string()),
                    8_000,
                )
                .await?;
                if matches!(sub_check.status().as_u16(), 200 | 207) {
                    continue;
                }

                let mk_probe = webdav_request(client, "MKCOL", dir_url, config, &[], None, 8_000).await?;
                let mk_code = mk_probe.status().as_u16();
                if matches!(mk_code, 200 | 201 | 204) {
                    let _ = webdav_request(client, "DELETE", dir_url, config, &[], None, 5_000).await;
                    return Ok(SyncWebDavTestResult {
                        folder_exists: false,
                        has_vault_file: false,
                        writable: true,
                        available_shares: None,
                        message: format!(
                            "认证与写入权限验证通过 · 首次同步时将自动创建目录 {}",
                            target.normalized_dir
                        ),
                    });
                }

                let shares = list_child_collections(client, &target.base_endpoint_url, config).await;
                let msg = if !shares.is_empty() {
                    format!(
                        "账号认证成功，但飞牛 fnOS / NAS 根目录不允许直接创建「{}」。请从下方选择一个已开启 WebDAV 权限的共享文件夹：",
                        target.normalized_dir
                    )
                } else {
                    format!(
                        "账号认证成功，但服务器拒绝创建目录 {} (HTTP {})，请先在网盘/NAS 中指定已有共享目录",
                        target.normalized_dir, mk_code
                    )
                };
                return Ok(SyncWebDavTestResult {
                    folder_exists: false,
                    has_vault_file: false,
                    writable: false,
                    available_shares: Some(shares),
                    message: msg,
                });
            }
        }
        if base_status == 404 {
            return Err("WebDAV 根地址不存在 (404)，请检查服务器 URL 是否正确".to_string());
        }
        return Err(format_webdav_http_error(base_status, "检测根路径"));
    }

    if col_status == 404 {
        return Err("WebDAV 地址不存在 (404)，请检查 URL 是否正确".to_string());
    }
    Err(format_webdav_http_error(col_status, "检测同步目录"))
}

pub async fn ensure_webdav_collection(
    client: &Client,
    config: &WebDavConnectionConfig,
) -> Result<NormalizedWebDavTarget, String> {
    let target = normalize_webdav_target(&config.server_url, &config.remote_dir)?;
    let probe = webdav_request(
        client,
        "PROPFIND",
        &target.collection_url,
        config,
        &[
            ("Depth", "0"),
            ("Content-Type", "application/xml; charset=utf-8"),
        ],
        Some(PROPFIND_BODY.to_string()),
        15_000,
    )
    .await?;
    let status = probe.status().as_u16();
    if status == 207 || status == 200 {
        return Ok(target);
    }
    if status != 404 {
        return Err(format_webdav_http_error(status, "检查远程目录"));
    }

    for dir_url in &target.intermediate_dir_urls {
        let mk_res = webdav_request(client, "MKCOL", dir_url, config, &[], None, 12_000).await?;
        let mk_code = mk_res.status().as_u16();
        if !matches!(mk_code, 200 | 201 | 204) {
            let check = webdav_request(
                client,
                "PROPFIND",
                dir_url,
                config,
                &[
                    ("Depth", "0"),
                    ("Content-Type", "application/xml; charset=utf-8"),
                ],
                Some(PROPFIND_BODY.to_string()),
                8_000,
            )
            .await?;
            if !matches!(check.status().as_u16(), 200 | 207) {
                let shares = list_child_collections(client, &target.base_endpoint_url, config).await;
                if !shares.is_empty() {
                    let examples = shares
                        .iter()
                        .take(4)
                        .map(|s| format!("/{s}/XiZiTerm"))
                        .collect::<Vec<_>>()
                        .join(" 或 ");
                    return Err(format!(
                        "无法在 NAS/WebDAV 根目录直接创建顶级文件夹（HTTP {mk_code}）。请将「远程同步目录」改为已有共享文件夹下的子路径，例如：{examples}"
                    ));
                }
                return Err(format_webdav_http_error(
                    mk_code,
                    &format!("创建目录 {}", target.normalized_dir),
                ));
            }
        }
    }

    Ok(target)
}

pub enum WebDavGetResult {
    NotFound,
    NotModified,
    Ok {
        bundle: WebDavVaultBundle,
        etag: Option<String>,
    },
}

pub async fn get_webdav_vault_bundle(
    client: &Client,
    config: &WebDavConnectionConfig,
    if_none_match_etag: Option<&str>,
) -> Result<WebDavGetResult, String> {
    let target = normalize_webdav_target(&config.server_url, &config.remote_dir)?;
    let mut headers = vec![
        ("Accept", "application/json, text/plain, */*"),
        ("Cache-Control", "no-cache"),
    ];
    if let Some(etag) = if_none_match_etag {
        headers.push(("If-None-Match", etag));
    }

    let mut res = webdav_request(
        client,
        "GET",
        &target.file_url,
        config,
        &headers,
        None,
        15_000,
    )
    .await?;

    if res.status().as_u16() == 404 {
        let legacy_url = format!("{}{}", target.collection_url, LEGACY_WEBDAV_VAULT_FILENAME);
        let legacy_res = webdav_request(
            client,
            "GET",
            &legacy_url,
            config,
            &[
                ("Accept", "application/json, text/plain, */*"),
                ("Cache-Control", "no-cache"),
            ],
            None,
            15_000,
        )
        .await?;
        if legacy_res.status().as_u16() != 404 {
            res = legacy_res;
        }
    }

    let code = res.status().as_u16();
    if code == 304 {
        return Ok(WebDavGetResult::NotModified);
    }
    if code == 404 {
        return Ok(WebDavGetResult::NotFound);
    }
    if !res.status().is_success() {
        return Err(format_webdav_http_error(code, "下载加密同步文件"));
    }

    let etag = res
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .map(String::from);

    let text = res
        .text()
        .await
        .map_err(|e| format!("读取远端 WebDAV 响应失败: {e}"))?;
    let bundle: WebDavVaultBundle = serde_json::from_str(&text)
        .map_err(|_| "远端 WebDAV 保险库文件不是有效的 JSON 格式".to_string())?;

    if bundle.format != "xiziterm-e2ee-webdav-v1" && bundle.format != "nexusterm-e2ee-webdav-v1" {
        return Err("远端 WebDAV 保险库文件结构无效或版本不兼容".to_string());
    }

    Ok(WebDavGetResult::Ok { bundle, etag })
}

fn is_strong_etag(etag: Option<&str>) -> bool {
    matches!(etag, Some(s) if !s.trim().is_empty() && !s.trim().starts_with("W/"))
}

pub async fn put_webdav_vault_bundle(
    client: &Client,
    config: &WebDavConnectionConfig,
    bundle: &WebDavVaultBundle,
    expected_etag: Option<&str>,
    expected_revision: Option<i64>,
) -> Result<Option<String>, WebDavPutError> {
    let target = ensure_webdav_collection(client, config)
        .await
        .map_err(WebDavPutError::Other)?;
    let body = serde_json::to_string_pretty(bundle)
        .map_err(|e| WebDavPutError::Other(e.to_string()))?;

    let use_if_match = is_strong_etag(expected_etag);
    let mut headers = vec![("Content-Type", "application/json; charset=utf-8")];
    if use_if_match {
        if let Some(et) = expected_etag {
            headers.push(("If-Match", et));
        }
    }

    let res = webdav_request(
        client,
        "PUT",
        &target.file_url,
        config,
        &headers,
        Some(body.clone()),
        20_000,
    )
    .await
    .map_err(WebDavPutError::Other)?;

    if res.status().as_u16() == 412 && use_if_match {
        if let Ok(WebDavGetResult::Ok { bundle: latest, .. }) =
            get_webdav_vault_bundle(client, config, None).await
        {
            if let Some(exp_rev) = expected_revision {
                if latest.revision != exp_rev {
                    return Err(WebDavPutError::Conflict);
                }
            }
        }

        let retry = webdav_request(
            client,
            "PUT",
            &target.file_url,
            config,
            &[("Content-Type", "application/json; charset=utf-8")],
            Some(body),
            20_000,
        )
        .await
        .map_err(WebDavPutError::Other)?;

        if !retry.status().is_success() {
            return Err(WebDavPutError::Other(format_webdav_http_error(
                retry.status().as_u16(),
                "上传加密同步文件",
            )));
        }
        return Ok(retry
            .headers()
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .map(String::from));
    }

    if !res.status().is_success() {
        return Err(WebDavPutError::Other(format_webdav_http_error(
            res.status().as_u16(),
            "上传加密同步文件",
        )));
    }

    Ok(res
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .map(String::from))
}
