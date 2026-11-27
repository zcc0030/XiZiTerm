#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod models;
mod services;

use commands::AppState;
use services::{
    deploy::DeployService, local_pty::LocalPtyService, monitor::MonitorService, sftp::SftpService,
    ssh::SshService, sync::SyncService, vault::VaultService,
};
use tauri::{Manager, RunEvent};

fn main() {
    let vault = VaultService::new();
    let ssh = SshService::new();
    let local_pty = LocalPtyService::new();
    let sftp = SftpService::new();
    let monitor = MonitorService::new();
    let sync = SyncService::new();
    let deploy = DeployService::new();

    let app_state = AppState {
        vault: vault.clone(),
        ssh,
        local_pty,
        sftp,
        monitor,
        sync: sync.clone(),
        deploy,
    };

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state)
        .setup(move |app| {
            sync.spawn_auto_push_watcher(app.handle().clone(), vault.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::vault_status,
            commands::vault_init,
            commands::vault_unlock,
            commands::vault_lock,
            commands::vault_get_data,
            commands::vault_save_group,
            commands::vault_delete_group,
            commands::vault_save_host,
            commands::vault_delete_host,
            commands::vault_save_snippet,
            commands::vault_delete_snippet,
            commands::vault_update_preferences,
            commands::dialog_open_key_file,
            commands::ssh_connect,
            commands::ssh_test_connection,
            commands::local_list_shells,
            commands::ssh_write,
            commands::ssh_resize,
            commands::ssh_disconnect,
            commands::sftp_list,
            commands::sftp_mkdir,
            commands::sftp_create_file,
            commands::sftp_rename,
            commands::sftp_delete,
            commands::sftp_chmod,
            commands::sftp_upload_pick,
            commands::sftp_upload_paths,
            commands::sftp_download,
            commands::sftp_read_text,
            commands::sftp_write_text,
            commands::monitor_start,
            commands::monitor_stop,
            commands::sync_status,
            commands::sync_test_server,
            commands::sync_register,
            commands::sync_login,
            commands::sync_bind_token,
            commands::sync_test_webdav,
            commands::sync_bind_webdav,
            commands::sync_now,
            commands::sync_update_options,
            commands::sync_get_token,
            commands::sync_disconnect,
            commands::sync_restore_vault,
            commands::sync_get_deploy_templates,
            commands::sync_export_deploy_bundle,
            commands::sync_one_click_deploy,
        ])
        .build(tauri::generate_context!())
        .expect("Failed to initialize XiZiTerm Tauri application");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            let state = app_handle.state::<AppState>();
            tauri::async_runtime::block_on(async {
                state.monitor.stop_all().await;
                state.local_pty.disconnect_all().await;
                state.ssh.disconnect_all().await;
                state.vault.lock().await;
            });
        }
    });
}
