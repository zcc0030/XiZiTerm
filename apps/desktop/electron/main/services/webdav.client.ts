import type {
  SyncWebDavTestResult,
  WebDavVaultBundle,
} from '@xiziterm/shared';

export const WEBDAV_VAULT_FILENAME = 'xiziterm-vault.enc.json';
const LEGACY_WEBDAV_VAULT_FILENAME = 'nexusterm-vault.enc.json';

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/></d:prop></d:propfind>';

export interface WebDavConnectionConfig {
  serverUrl: string;
  username: string;
  password: string;
  remoteDir: string;
}

export interface NormalizedWebDavTarget {
  baseEndpointUrl: string;
  collectionUrl: string;
  intermediateDirUrls: string[];
  fileUrl: string;
  normalizedDir: string;
}

export class WebDavConflictError extends Error {
  constructor(message = '远端 WebDAV 文件已被其他设备更新，需要重新合并') {
    super(message);
    this.name = 'WebDavConflictError';
  }
}

export function normalizeWebDavTarget(
  rawServerUrl: string,
  rawRemoteDir: string
): NormalizedWebDavTarget {
  const trimmedUrl = rawServerUrl.trim();
  if (!/^https?:\/\/.+/i.test(trimmedUrl)) {
    throw new Error('WebDAV 地址必须以 http:// 或 https:// 开头');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmedUrl);
  } catch {
    throw new Error('WebDAV 地址格式不正确');
  }

  const baseEndpointUrl = parsedUrl.toString().replace(/\/+$/, '') + '/';

  const rawSegments = (rawRemoteDir || '/XiZiTerm')
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);

  // Avoid duplicating folder if user already appended the same folder in serverUrl
  const basePathLower = parsedUrl.pathname.replace(/\/+$/, '').toLowerCase();
  const suffixLower =
    rawSegments.length > 0 ? '/' + rawSegments.join('/').toLowerCase() : '';
  const effectiveSegments =
    suffixLower && basePathLower.endsWith(suffixLower) ? [] : rawSegments;

  const intermediateDirUrls: string[] = [];
  let currentUrl = baseEndpointUrl;
  for (const seg of effectiveSegments) {
    currentUrl += `${encodeURIComponent(seg)}/`;
    intermediateDirUrls.push(currentUrl);
  }

  const collectionUrl = currentUrl;
  const fileUrl = `${collectionUrl}${WEBDAV_VAULT_FILENAME}`;
  const normalizedDir =
    '/' + (rawSegments.length > 0 ? rawSegments.join('/') : '');

  return {
    baseEndpointUrl,
    collectionUrl,
    intermediateDirUrls,
    fileUrl,
    normalizedDir,
  };
}

function buildBasicAuthHeader(username: string, password: string): string {
  const encoded = Buffer.from(`${username}:${password}`, 'utf8').toString(
    'base64'
  );
  return `Basic ${encoded}`;
}

function formatWebDavHttpError(status: number, context: string): string {
  if (status === 401) {
    return 'WebDAV 认证失败 (401)：请检查用户名与密码（若使用坚果云，必须在「账户信息 → 安全选项」中生成第三方应用专用密码，不能填登录密码）';
  }
  if (status === 403) {
    return `WebDAV 权限被拒绝 (403)：请确认该账号对目标目录有读写权限（${context}）`;
  }
  if (status === 405) {
    return '目标地址不支持 WebDAV 协议 (405)：请检查 WebDAV URL 是否填写完整（例如坚果云需包含 /dav/）';
  }
  return `WebDAV 请求失败 (${context})：HTTP ${status}`;
}

async function webdavRequest(
  url: string,
  config: WebDavConnectionConfig,
  options: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  }
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 15_000
  );

  try {
    return await fetch(url, {
      method: options.method,
      headers: {
        Authorization: buildBasicAuthHeader(
          config.username.trim(),
          config.password
        ),
        ...options.headers,
      },
      body: options.body,
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error('连接 WebDAV 服务器超时，请检查地址与网络');
    }
    throw new Error(
      `无法连接 WebDAV 服务器: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  } finally {
    clearTimeout(timer);
  }
}

async function listChildCollections(
  baseEndpointUrl: string,
  config: WebDavConnectionConfig
): Promise<string[]> {
  try {
    const res = await webdavRequest(baseEndpointUrl, config, {
      method: 'PROPFIND',
      headers: {
        Depth: '1',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body: PROPFIND_BODY,
      timeoutMs: 8_000,
    });
    if (res.status !== 207 && res.status !== 200) return [];

    const xml = await res.text();
    const basePathname = new URL(baseEndpointUrl).pathname.replace(/\/+$/, '');
    const hrefMatches = [
      ...xml.matchAll(/<[^:>]*:?href>([^<]+)<\/[^:>]*:?href>/gi),
    ];

    const names: string[] = [];
    for (const m of hrefMatches) {
      let rawHref = m[1].trim();
      try {
        if (/^https?:\/\//i.test(rawHref)) {
          rawHref = new URL(rawHref).pathname;
        }
        const decoded = decodeURIComponent(rawHref).replace(/\/+$/, '');
        if (!decoded || decoded === basePathname) continue;
        const rel = basePathname && decoded.startsWith(basePathname + '/')
          ? decoded.slice(basePathname.length + 1)
          : decoded.replace(/^\/+/, '');
        if (rel && !rel.includes('/') && !rel.startsWith('.')) {
          names.push(rel);
        }
      } catch {
        // ignore malformed href
      }
    }
    return Array.from(new Set(names));
  } catch {
    return [];
  }
}

export async function testWebDavConnection(
  config: WebDavConnectionConfig
): Promise<SyncWebDavTestResult> {
  if (!config.username.trim() || !config.password) {
    throw new Error('请输入 WebDAV 用户名和密码/应用密码');
  }

  const target = normalizeWebDavTarget(config.serverUrl, config.remoteDir);

  // 1. Probe target collection directory
  const colRes = await webdavRequest(target.collectionUrl, config, {
    method: 'PROPFIND',
    headers: {
      Depth: '0',
      'Content-Type': 'application/xml; charset=utf-8',
    },
    body: PROPFIND_BODY,
    timeoutMs: 10_000,
  });

  if (colRes.status === 207 || colRes.status === 200) {
    // If user pointed remoteDir to "/" on a virtual NAS root, verify write permission
    if (target.collectionUrl === target.baseEndpointUrl) {
      const probeDirUrl = `${target.baseEndpointUrl}.__xiziterm_check__/`;
      const mkCheck = await webdavRequest(probeDirUrl, config, {
        method: 'MKCOL',
        timeoutMs: 6_000,
      });
      if (mkCheck.status === 201 || mkCheck.status === 200 || mkCheck.status === 204) {
        await webdavRequest(probeDirUrl, config, { method: 'DELETE' }).catch(
          () => {}
        );
      } else {
        const shares = await listChildCollections(target.baseEndpointUrl, config);
        return {
          folderExists: true,
          hasVaultFile: false,
          writable: false,
          availableShares: shares,
          message:
            '认证成功，但 NAS 根目录不可直接写入，请点击下方共享文件夹选择同步路径',
        };
      }
    }

    // Check if vault file already exists inside the collection (check xiziterm first, then legacy filename)
    const fileRes = await webdavRequest(target.fileUrl, config, {
      method: 'PROPFIND',
      headers: {
        Depth: '0',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body: PROPFIND_BODY,
      timeoutMs: 8_000,
    });
    let hasVaultFile = fileRes.status === 207 || fileRes.status === 200;
    if (!hasVaultFile) {
      const legacyFileRes = await webdavRequest(
        `${target.collectionUrl}${LEGACY_WEBDAV_VAULT_FILENAME}`,
        config,
        {
          method: 'PROPFIND',
          headers: {
            Depth: '0',
            'Content-Type': 'application/xml; charset=utf-8',
          },
          body: PROPFIND_BODY,
          timeoutMs: 6_000,
        }
      );
      hasVaultFile =
        legacyFileRes.status === 207 || legacyFileRes.status === 200;
    }
    return {
      folderExists: true,
      hasVaultFile,
      writable: true,
      message: hasVaultFile
        ? `连接成功 · 已检测到云端加密保险库 (${target.normalizedDir})`
        : `连接成功 · 目录 ${target.normalizedDir} 可正常读写`,
    };
  }

  if (colRes.status === 404 && target.collectionUrl !== target.baseEndpointUrl) {
    // Target subdirectory does not exist yet -> verify base endpoint auth first
    const baseRes = await webdavRequest(target.baseEndpointUrl, config, {
      method: 'PROPFIND',
      headers: {
        Depth: '0',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body: PROPFIND_BODY,
      timeoutMs: 10_000,
    });

    if (baseRes.status === 207 || baseRes.status === 200) {
      // Find first missing intermediate directory and verify MKCOL permission!
      for (const dirUrl of target.intermediateDirUrls) {
        const subCheck = await webdavRequest(dirUrl, config, {
          method: 'PROPFIND',
          headers: {
            Depth: '0',
            'Content-Type': 'application/xml; charset=utf-8',
          },
          body: PROPFIND_BODY,
          timeoutMs: 8_000,
        });
        if (subCheck.status === 207 || subCheck.status === 200) {
          continue;
        }

        // First missing folder: test MKCOL and clean up immediately
        const mkProbe = await webdavRequest(dirUrl, config, {
          method: 'MKCOL',
          timeoutMs: 8_000,
        });
        if (
          mkProbe.status === 201 ||
          mkProbe.status === 200 ||
          mkProbe.status === 204
        ) {
          await webdavRequest(dirUrl, config, { method: 'DELETE' }).catch(
            () => {}
          );
          return {
            folderExists: false,
            hasVaultFile: false,
            writable: true,
            message: `认证与写入权限验证通过 · 首次同步时将自动创建目录 ${target.normalizedDir}`,
          };
        }

        // MKCOL rejected (e.g. 405/403 on fnOS / Synology virtual root!) -> list shares
        const shares = await listChildCollections(target.baseEndpointUrl, config);
        return {
          folderExists: false,
          hasVaultFile: false,
          writable: false,
          availableShares: shares,
          message:
            shares.length > 0
              ? `账号认证成功，但飞牛 fnOS / NAS 根目录不允许直接创建「${target.normalizedDir}」。请从下方选择一个已开启 WebDAV 权限的共享文件夹：`
              : `账号认证成功，但服务器拒绝创建目录 ${target.normalizedDir} (HTTP ${mkProbe.status})，请先在网盘/NAS 中指定已有共享目录`,
        };
      }
    }

    if (baseRes.status === 404) {
      throw new Error('WebDAV 根地址不存在 (404)，请检查服务器 URL 是否正确');
    }
    throw new Error(formatWebDavHttpError(baseRes.status, '检测根路径'));
  }

  if (colRes.status === 404) {
    throw new Error('WebDAV 地址不存在 (404)，请检查 URL 是否正确');
  }

  throw new Error(formatWebDavHttpError(colRes.status, '检测同步目录'));
}

export async function ensureWebDavCollection(
  config: WebDavConnectionConfig
): Promise<NormalizedWebDavTarget> {
  const target = normalizeWebDavTarget(config.serverUrl, config.remoteDir);

  const probe = await webdavRequest(target.collectionUrl, config, {
    method: 'PROPFIND',
    headers: {
      Depth: '0',
      'Content-Type': 'application/xml; charset=utf-8',
    },
    body: PROPFIND_BODY,
  });

  if (probe.status === 207 || probe.status === 200) {
    return target;
  }

  if (probe.status !== 404) {
    throw new Error(formatWebDavHttpError(probe.status, '检查远程目录'));
  }

  // Create intermediate directories via MKCOL and strictly verify existence when status != 201/200/204
  for (const dirUrl of target.intermediateDirUrls) {
    const mkRes = await webdavRequest(dirUrl, config, {
      method: 'MKCOL',
    });
    if (
      mkRes.status !== 201 &&
      mkRes.status !== 200 &&
      mkRes.status !== 204
    ) {
      const check = await webdavRequest(dirUrl, config, {
        method: 'PROPFIND',
        headers: {
          Depth: '0',
          'Content-Type': 'application/xml; charset=utf-8',
        },
        body: PROPFIND_BODY,
      });
      if (check.status !== 207 && check.status !== 200) {
        const shares = await listChildCollections(target.baseEndpointUrl, config);
        if (shares.length > 0) {
          const examples = shares
            .slice(0, 4)
            .map((s) => `/${s}/XiZiTerm`)
            .join(' 或 ');
          throw new Error(
            `无法在 NAS/WebDAV 根目录直接创建顶级文件夹（HTTP ${mkRes.status}）。请将「远程同步目录」改为已有共享文件夹下的子路径，例如：${examples}`
          );
        }
        throw new Error(
          formatWebDavHttpError(mkRes.status, `创建目录 ${target.normalizedDir}`)
        );
      }
    }
  }

  return target;
}

export type WebDavGetResult =
  | { status: 'not_found' }
  | { status: 'not_modified'; etag: string | null }
  | { status: 'ok'; bundle: WebDavVaultBundle; etag: string | null };

export async function getWebDavVaultBundle(
  config: WebDavConnectionConfig,
  ifNoneMatchEtag?: string | null
): Promise<WebDavGetResult> {
  const target = normalizeWebDavTarget(config.serverUrl, config.remoteDir);
  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    'Cache-Control': 'no-cache',
  };
  if (ifNoneMatchEtag) {
    headers['If-None-Match'] = ifNoneMatchEtag;
  }

  let res = await webdavRequest(target.fileUrl, config, {
    method: 'GET',
    headers,
  });

  if (res.status === 404) {
    // Fallback to legacy filename if upgrading an existing WebDAV directory
    const legacyHeaders = { ...headers };
    delete legacyHeaders['If-None-Match'];
    const legacyRes = await webdavRequest(
      `${target.collectionUrl}${LEGACY_WEBDAV_VAULT_FILENAME}`,
      config,
      {
        method: 'GET',
        headers: legacyHeaders,
      }
    );
    if (legacyRes.status !== 404) {
      res = legacyRes;
    }
  }

  if (res.status === 304) {
    return {
      status: 'not_modified',
      etag: res.headers.get('etag') ?? ifNoneMatchEtag ?? null,
    };
  }

  if (res.status === 404) {
    return { status: 'not_found' };
  }

  if (!res.ok) {
    throw new Error(formatWebDavHttpError(res.status, '下载加密同步文件'));
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('远端 WebDAV 保险库文件不是有效的 JSON 格式');
  }

  const bundle = parsed as WebDavVaultBundle;
  if (
    !bundle ||
    (bundle.format !== 'xiziterm-e2ee-webdav-v1' &&
      bundle.format !== 'nexusterm-e2ee-webdav-v1') ||
    !bundle.kdf?.salt ||
    !bundle.keyCheck?.ciphertext ||
    typeof bundle.items !== 'object'
  ) {
    throw new Error('远端 WebDAV 保险库文件结构无效或版本不兼容');
  }

  return {
    status: 'ok',
    bundle,
    etag: res.headers.get('etag'),
  };
}

function isStrongEtag(etag: string | null | undefined): etag is string {
  return Boolean(etag && !etag.trim().startsWith('W/'));
}

export async function putWebDavVaultBundle(
  config: WebDavConnectionConfig,
  bundle: WebDavVaultBundle,
  options: {
    expectedEtag?: string | null;
    expectedRevision?: number;
  } = {}
): Promise<{ etag: string | null }> {
  const target = await ensureWebDavCollection(config);
  const body = JSON.stringify(bundle, null, 2);

  const baseHeaders: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
  };

  const useIfMatch = isStrongEtag(options.expectedEtag);
  const headers = useIfMatch
    ? { ...baseHeaders, 'If-Match': options.expectedEtag! }
    : baseHeaders;

  const res = await webdavRequest(target.fileUrl, config, {
    method: 'PUT',
    headers,
    body,
    timeoutMs: 20_000,
  });

  if (res.status === 412 && useIfMatch) {
    // Verify whether remote file genuinely changed or if server has quirky If-Match support
    const latest = await getWebDavVaultBundle(config);
    if (
      latest.status === 'ok' &&
      options.expectedRevision !== undefined &&
      latest.bundle.revision !== options.expectedRevision
    ) {
      throw new WebDavConflictError();
    }

    // Remote revision did not change -> retry plain PUT without If-Match
    const retryRes = await webdavRequest(target.fileUrl, config, {
      method: 'PUT',
      headers: baseHeaders,
      body,
      timeoutMs: 20_000,
    });
    if (!retryRes.ok) {
      throw new Error(formatWebDavHttpError(retryRes.status, '上传加密同步文件'));
    }
    return { etag: retryRes.headers.get('etag') };
  }

  if (!res.ok) {
    throw new Error(formatWebDavHttpError(res.status, '上传加密同步文件'));
  }

  return { etag: res.headers.get('etag') };
}
