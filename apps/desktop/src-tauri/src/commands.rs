use std::path::Path;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::models::*;
use crate::services::{
    deploy::DeployService,
    local_pty::LocalPtyService,
    monitor::MonitorService,
    sftp::SftpService,
    ssh::SshService,
    sync::{unwrap_force_full, SyncService},
    vault::VaultService,
};

pub struct AppState {
    pub vault: VaultService,
    pub ssh: SshService,
    pub local_pty: LocalPtyService,
    pub sftp: SftpService,
    pub monitor: MonitorService,
    pub sync: SyncService,
    pub deploy: DeployService,
}

// --- Vault & Dialog Commands ---

#[tauri::command]
pub async fn vault_status(state: State<'_, AppState>) -> Result<VaultStatus, String> {
    Ok(state.vault.get_status().await)
}

#[tauri::command]
pub async fn vault_init(
    state: State<'_, AppState>,
    master_password: String,
) -> Result<ActionResult<VaultData>, String> {
    Ok(match state.vault.initialize(master_password).await {
        Ok(data) => ActionResult::ok(data),
        Err(e) => ActionResult::err(e),
    })
}

#[tauri::command]
pub async fn vault_unlock(
    app: AppHandle,
    state: State<'_, AppState>,
    master_password: String,
) -> Result<ActionResult<VaultData>, String> {
    match state.vault.unlock(master_password).await {
        Ok(data) => {
            state.sync.on_vault_unlocked(&app, &state.vault).await;
            Ok(ActionResult::ok(data))
        }
        Err(e) => Ok(ActionResult::err(e)),
    }
}

#[tauri::command]
pub async fn vault_lock(state: State<'_, AppState>) -> Result<ActionResult<()>, String> {
    state.sync.on_vault_locked().await;
    state.monitor.stop_all().await;
    state.ssh.disconnect_all().await;
    state.vault.lock().await;
    Ok(ActionResult::ok_unit())
}

#[tauri::command]
pub async fn vault_get_data(state: State<'_, AppState>) -> Result<ActionResult<VaultData>, String> {
    Ok(match state.vault.get_active_data().await {
        Ok(data) => ActionResult::ok(data),
        Err(e) => ActionResult::err(e),
    })
}

#[tauri::command]
pub async fn vault_save_group(
    state: State<'_, AppState>,
    input: HostGroupInput,
) -> Result<ActionResult<HostGroup>, String> {
    Ok(match state.vault.save_group(input).await {
        Ok(group) => ActionResult::ok(group),
        Err(e) => ActionResult::err(e),
    })
}

#[tauri::command]
pub async fn vault_delete_group(
    state: State<'_, AppState>,
    group_id: String,
) -> Result<ActionResult<()>, String> {
    Ok(match state.vault.delete_group(&group_id).await {
        Ok(()) => ActionResult::ok_unit(),
        Err(e) => ActionResult::err(e),
    })
}

#[tauri::command]
pub async fn vault_save_host(
    state: State<'_, AppState>,
    input: HostInput,
) -> Result<ActionResult<HostConfig>, String> {
    Ok(match state.vault.save_host(input).await {
        Ok(host) => ActionResult::ok(host),
        Err(e) => ActionResult::err(e),
    })
}

#[tauri::command]
pub async fn vault_delete_host(
    state: State<'_, AppState>,
    host_id: String,
) -> Result<ActionResult<()>, String> {
    Ok(match state.vault.delete_host(&host_id).await {
        Ok(()) => ActionResult::ok_unit(),
        Err(e) => ActionResult::err(e),
    })
}

#[tauri::command]
pub async fn vault_save_snippet(
    state: State<'_, AppState>,
    input: SnippetInput,
) -> Result<ActionResult<Snippet>, String> {
    Ok(match state.vault.save_snippet(input).await {
        Ok(snippet) => ActionResult::ok(snippet),
        Err(e) => ActionResult::err(e),
    })
}

#[tauri::command]
pub async fn vault_delete_snippet(
    state: State<'_, AppState>,
    snippet_id: String,
) -> Result<ActionResult<()>, String> {
    Ok(match state.vault.delete_snippet(&snippet_id).await {
        Ok(()) => ActionResult::ok_unit(),
        Err(e) => ActionResult::err(e),
    })
}

#[tauri::command]
pub async fn vault_update_preferences(
    state: State<'_, AppState>,
    patch: PreferencesPatch,
) -> Result<ActionResult<UserPreferences>, String> {
    Ok(match state.vault.update_preferences(patch).await {
        Ok(prefs) => ActionResult::ok(prefs),
        Err(e) => ActionResult::err(e),
    })
}

#[tauri::command]
pub async fn dialog_open_key_file(
    app: AppHandle,
) -> Result<ActionResult<Option<KeyFileSelection>>, String> {
    let picked = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("选择 SSH 私钥文件")
            .blocking_pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(file_path_obj) = picked else {
        return Ok(ActionResult::ok(None));
    };
    let Some(path_buf) = file_path_obj.into_path().ok() else {
        return Ok(ActionResult::err("无法解析所选文件路径"));
    };

    let meta = match tokio::fs::metadata(&path_buf).await {
        Ok(m) => m,
        Err(e) => return Ok(ActionResult::err(format!("读取私钥文件失败: {e}"))),
    };
    if meta.len() > 256 * 1024 {
        return Ok(ActionResult::err(
            "所选文件过大（>256KB），请确认是否为有效的 SSH 私钥文件",
        ));
    }

    match tokio::fs::read_to_string(&path_buf).await {
        Ok(content) => Ok(ActionResult::ok(Some(KeyFileSelection {
            file_path: path_buf.to_string_lossy().to_string(),
            content,
        }))),
        Err(e) => Ok(ActionResult::err(format!("读取私钥文本失败: {e}"))),
    }
}

// --- SSH & Local PTY Commands ---

#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    req: SshConnectRequest,
) -> Result<SshConnectResult, String> {
    if req.host_id == LOCAL_HOST_ID {
        return Ok(state.local_pty.connect(&app, req).await);
    }
    Ok(state.ssh.connect(&app, &state.vault, req).await)
}

#[tauri::command]
pub async fn ssh_test_connection(
    state: State<'_, AppState>,
    req: SshTestConnectionRequest,
) -> Result<SshTestConnectionResult, String> {
    Ok(state.ssh.test_connection(req).await)
}

#[tauri::command]
pub async fn local_list_shells(
    state: State<'_, AppState>,
    refresh: Option<bool>,
) -> Result<Vec<LocalShellProfile>, String> {
    Ok(state.local_pty.list_shells(refresh.unwrap_or(false)).await)
}

#[tauri::command]
pub async fn ssh_write(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    if state.local_pty.has_session(&session_id).await {
        state.local_pty.write(&session_id, &data).await;
    } else {
        state.ssh.write(&session_id, &data).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_resize(
    state: State<'_, AppState>,
    payload: SshResizePayload,
) -> Result<(), String> {
    if state.local_pty.has_session(&payload.session_id).await {
        state
            .local_pty
            .resize(&payload.session_id, payload.cols, payload.rows)
            .await;
    } else {
        state
            .ssh
            .resize(&payload.session_id, payload.cols, payload.rows)
            .await;
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_disconnect(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    state.monitor.stop(&session_id).await;
    state.sftp.drop_session(&session_id).await;
    if state.local_pty.has_session(&session_id).await {
        state.local_pty.disconnect(&session_id).await;
    } else {
        state.ssh.disconnect(&session_id).await;
    }
    Ok(())
}

// --- SFTP Commands ---

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, AppState>,
    session_id: String,
    remote_path: Option<String>,
) -> Result<ActionResult<SftpListResult>, String> {
    Ok(match state.sftp.list(&state.ssh, &session_id, remote_path).await {
        Ok(res) => ActionResult::ok(res),
        Err(e) => ActionResult::err(e),
    })
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
) -> Result<ActionResult<()>, String> {
    Ok(match state.sftp.mkdir(&state.ssh, &session_id, &remote_path).await {
        Ok(()) => ActionResult::ok_unit(),
        Err(e) => ActionResult::err(e),
    })
}

#[tauri::command]
pub async fn sftp_create_file(
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
) -> Result<ActionResult<()>, String> {
    Ok(
        match state
            .sftp
            .create_file(&state.ssh, &session_id, &remote_path)
            .await
        {
            Ok(()) => ActionResult::ok_unit(),
            Err(e) => ActionResult::err(e),
        },
    )
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    session_id: String,
    old_path: String,
    new_path: String,
) -> Result<ActionResult<()>, String> {
    Ok(
        match state
            .sftp
            .rename(&state.ssh, &session_id, &old_path, &new_path)
            .await
        {
            Ok(()) => ActionResult::ok_unit(),
            Err(e) => ActionResult::err(e),
        },
    )
}

#[tauri::command]
pub async fn sftp_delete(
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
    is_directory: bool,
) -> Result<ActionResult<()>, String> {
    Ok(
        match state
            .sftp
            .delete_entry(&state.ssh, &session_id, &remote_path, is_directory)
            .await
        {
            Ok(()) => ActionResult::ok_unit(),
            Err(e) => ActionResult::err(e),
        },
    )
}

#[tauri::command]
pub async fn sftp_chmod(
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
    octal_mode: String,
) -> Result<ActionResult<()>, String> {
    Ok(
        match state
            .sftp
            .chmod(&state.ssh, &session_id, &remote_path, &octal_mode)
            .await
        {
            Ok(()) => ActionResult::ok_unit(),
            Err(e) => ActionResult::err(e),
        },
    )
}

#[tauri::command]
pub async fn sftp_upload_pick(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    remote_dir: String,
) -> Result<ActionResult<UploadCountResult>, String> {
    let app_dialog = app.clone();
    let picked = tokio::task::spawn_blocking(move || {
        app_dialog
            .dialog()
            .file()
            .set_title("选择要上传的文件")
            .blocking_pick_files()
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(files) = picked else {
        return Ok(ActionResult::ok(UploadCountResult { uploaded_count: 0 }));
    };

    let paths: Vec<String> = files
        .into_iter()
        .filter_map(|f| f.into_path().ok().map(|p| p.to_string_lossy().to_string()))
        .collect();

    if paths.is_empty() {
        return Ok(ActionResult::ok(UploadCountResult { uploaded_count: 0 }));
    }

    Ok(
        match state
            .sftp
            .upload_local_paths(&app, &state.ssh, &session_id, paths, &remote_dir)
            .await
        {
            Ok(uploaded_count) => ActionResult::ok(UploadCountResult { uploaded_count }),
            Err(e) => ActionResult::err(e),
        },
    )
}

#[tauri::command]
pub async fn sftp_upload_paths(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    local_paths: Vec<String>,
    remote_dir: String,
) -> Result<ActionResult<UploadCountResult>, String> {
    Ok(
        match state
            .sftp
            .upload_local_paths(&app, &state.ssh, &session_id, local_paths, &remote_dir)
            .await
        {
            Ok(uploaded_count) => ActionResult::ok(UploadCountResult { uploaded_count }),
            Err(e) => ActionResult::err(e),
        },
    )
}

#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
    suggested_name: String,
) -> Result<ActionResult<Option<DownloadPathResult>>, String> {
    let safe_name = Path::new(if suggested_name.trim().is_empty() {
        &remote_path
    } else {
        &suggested_name
    })
    .file_name()
    .map(|s| s.to_string_lossy().to_string())
    .unwrap_or_else(|| "download.bin".to_string());

    let app_dialog = app.clone();
    let saved = tokio::task::spawn_blocking(move || {
        let mut builder = app_dialog
            .dialog()
            .file()
            .set_title("保存远程文件到本地")
            .set_file_name(&safe_name);
        if let Some(dl_dir) = dirs::download_dir() {
            builder = builder.set_directory(dl_dir);
        }
        builder.blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(file_path_obj) = saved else {
        return Ok(ActionResult::ok(None));
    };
    let Some(local_path) = file_path_obj.into_path().ok() else {
        return Ok(ActionResult::err("无法解析保存路径"));
    };

    match state
        .sftp
        .download_file(&app, &state.ssh, &session_id, &remote_path, &local_path)
        .await
    {
        Ok(()) => Ok(ActionResult::ok(Some(DownloadPathResult {
            local_path: local_path.to_string_lossy().to_string(),
        }))),
        Err(e) => Ok(ActionResult::err(e)),
    }
}

#[tauri::command]
pub async fn sftp_read_text(
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
) -> Result<ActionResult<SftpReadTextResult>, String> {
    Ok(
        match state
            .sftp
            .read_text_file(&state.ssh, &session_id, &remote_path)
            .await
        {
            Ok(res) => ActionResult::ok(res),
            Err(e) => ActionResult::err(e),
        },
    )
}

#[tauri::command]
pub async fn sftp_write_text(
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
    content: String,
) -> Result<ActionResult<()>, String> {
    Ok(
        match state
            .sftp
            .write_text_file(&state.ssh, &session_id, &remote_path, &content)
            .await
        {
            Ok(()) => ActionResult::ok_unit(),
            Err(e) => ActionResult::err(e),
        },
    )
}

// --- Monitor Commands ---

#[tauri::command]
pub async fn monitor_start(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    interval_ms: Option<u64>,
) -> Result<ActionResult<()>, String> {
    Ok(
        match state
            .monitor
            .start(
                &app,
                &state.ssh,
                &state.local_pty,
                session_id,
                interval_ms.unwrap_or(2500),
            )
            .await
        {
            Ok(()) => ActionResult::ok_unit(),
            Err(e) => ActionResult::err(e),
        },
    )
}

#[tauri::command]
pub async fn monitor_stop(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<ActionResult<()>, String> {
    state.monitor.stop(&session_id).await;
    Ok(ActionResult::ok_unit())
}

// --- Cloud Sync & Deploy Commands ---

#[tauri::command]
pub async fn sync_status(
    state: State<'_, AppState>,
) -> Result<ActionResult<SyncStatusInfo>, String> {
    Ok(ActionResult::ok(state.sync.get_status(&state.vault).await))
}

#[tauri::command]
pub async fn sync_test_server(
    state: State<'_, AppState>,
    server_url: String,
) -> Result<ActionResult<ServerHealthInfo>, String> {
    Ok(match state.sync.test_server(&server_url).await {
        Ok(info) => ActionResult::ok(info),
        Err(e) => ActionResult::err(e),
    })
}

#[tauri::command]
pub async fn sync_register(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: SyncBindCredentials,
) -> Result<ActionResult<SyncStatusInfo>, String> {
    Ok(
        match state.sync.register_and_bind(&app, &state.vault, payload).await {
            Ok(st) => ActionResult::ok(st),
            Err(e) => ActionResult::err(e),
        },
    )
}

#[tauri::command]
pub async fn sync_login(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: SyncBindCredentials,
) -> Result<ActionResult<SyncStatusInfo>, String> {
    Ok(
        match state.sync.login_and_bind(&app, &state.vault, payload).await {
            Ok(st) => ActionResult::ok(st),
            Err(e) => ActionResult::err(e),
        },
    )
}

#[tauri::command]
pub async fn sync_bind_token(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: SyncBindTokenPayload,
) -> Result<ActionResult<SyncStatusInfo>, String> {
    Ok(
        match state.sync.bind_with_token(&app, &state.vault, payload).await {
            Ok(st) => ActionResult::ok(st),
            Err(e) => ActionResult::err(e),
        },
    )
}

#[tauri::command]
pub async fn sync_test_webdav(
    state: State<'_, AppState>,
    payload: SyncWebDavTestPayload,
) -> Result<ActionResult<SyncWebDavTestResult>, String> {
    Ok(match state.sync.test_webdav(payload).await {
        Ok(res) => ActionResult::ok(res),
        Err(e) => ActionResult::err(e),
    })
}

#[tauri::command]
pub async fn sync_bind_webdav(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: SyncWebDavBindPayload,
) -> Result<ActionResult<SyncStatusInfo>, String> {
    Ok(
        match state.sync.bind_webdav(&app, &state.vault, payload).await {
            Ok(st) => ActionResult::ok(st),
            Err(e) => ActionResult::err(e),
        },
    )
}

#[tauri::command]
pub async fn sync_now(
    app: AppHandle,
    state: State<'_, AppState>,
    options: Option<SyncNowOptions>,
) -> Result<ActionResult<SyncRunResult>, String> {
    let force_full = unwrap_force_full(options);
    Ok(match state.sync.sync_now(&app, &state.vault, force_full).await {
        Ok(res) => ActionResult::ok(res),
        Err(e) => ActionResult::err(e),
    })
}

#[tauri::command]
pub async fn sync_update_options(
    app: AppHandle,
    state: State<'_, AppState>,
    patch: SyncOptionsPatch,
) -> Result<ActionResult<SyncStatusInfo>, String> {
    Ok(
        match state.sync.update_options(&app, &state.vault, patch).await {
            Ok(st) => ActionResult::ok(st),
            Err(e) => ActionResult::err(e),
        },
    )
}

#[tauri::command]
pub async fn sync_get_token(
    state: State<'_, AppState>,
) -> Result<ActionResult<Option<String>>, String> {
    Ok(ActionResult::ok(state.sync.get_token(&state.vault).await))
}

#[tauri::command]
pub async fn sync_disconnect(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ActionResult<SyncStatusInfo>, String> {
    Ok(match state.sync.disconnect(&app, &state.vault).await {
        Ok(st) => ActionResult::ok(st),
        Err(e) => ActionResult::err(e),
    })
}

#[tauri::command]
pub async fn sync_restore_vault(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: SyncRestorePayload,
) -> Result<ActionResult<VaultData>, String> {
    Ok(
        match state
            .sync
            .restore_vault_from_cloud(&app, &state.vault, payload)
            .await
        {
            Ok(data) => ActionResult::ok(data),
            Err(e) => ActionResult::err(e),
        },
    )
}

#[tauri::command]
pub async fn sync_get_deploy_templates(
    state: State<'_, AppState>,
) -> Result<ActionResult<SyncDeployTemplates>, String> {
    Ok(ActionResult::ok(state.deploy.get_deploy_templates()))
}

#[tauri::command]
pub async fn sync_export_deploy_bundle(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ActionResult<Option<ExportBundleResult>>, String> {
    let picked = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("选择导出云同步 Docker 部署包的目录")
            .blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(folder_obj) = picked else {
        return Ok(ActionResult::ok(None));
    };
    let Some(dir_path) = folder_obj.into_path().ok() else {
        return Ok(ActionResult::err("无法解析所选导出目录路径"));
    };

    Ok(match state.deploy.export_deploy_bundle(&dir_path).await {
        Ok(res) => ActionResult::ok(Some(res)),
        Err(e) => ActionResult::err(e),
    })
}

#[tauri::command]
pub async fn sync_one_click_deploy(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: SyncOneClickDeployPayload,
) -> Result<ActionResult<SyncOneClickDeployResult>, String> {
    Ok(match state.deploy.one_click_deploy(&app, payload).await {
        Ok(res) => ActionResult::ok(res),
        Err(e) => ActionResult::err(e),
    })
}
