import { BrowserWindow, dialog, ipcMain } from 'electron';
import {
  IPC_CHANNELS,
  type ActionResult,
  type SyncBindCredentials,
  type SyncBindTokenPayload,
  type SyncOneClickDeployPayload,
  type SyncRestorePayload,
  type SyncWebDavBindPayload,
  type SyncWebDavTestPayload,
} from '@xiziterm/shared';
import { syncService } from '../services/sync.service';
import { deployService } from '../services/deploy.service';

async function safeHandle<T>(
  fn: () => Promise<T> | T
): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function registerSyncIpc(
  getMainWindow: () => BrowserWindow | null
): void {
  syncService.setStateListener((payload) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.SYNC_STATE_EVENT, payload);
    }
  });

  deployService.setLogListener((logEvent) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.SYNC_DEPLOY_LOG, logEvent);
    }
  });

  ipcMain.handle(IPC_CHANNELS.SYNC_STATUS, async () => {
    return safeHandle(() => syncService.getStatus());
  });

  ipcMain.handle(
    IPC_CHANNELS.SYNC_TEST_SERVER,
    async (_event, serverUrl: string) => {
      return safeHandle(() => syncService.testServer(serverUrl));
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SYNC_REGISTER,
    async (_event, payload: SyncBindCredentials) => {
      return safeHandle(() => syncService.registerAndBind(payload));
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SYNC_LOGIN,
    async (_event, payload: SyncBindCredentials) => {
      return safeHandle(() => syncService.loginAndBind(payload));
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SYNC_BIND_TOKEN,
    async (_event, payload: SyncBindTokenPayload) => {
      return safeHandle(() => syncService.bindWithToken(payload));
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SYNC_TEST_WEBDAV,
    async (_event, payload: SyncWebDavTestPayload) => {
      return safeHandle(() => syncService.testWebdav(payload));
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SYNC_BIND_WEBDAV,
    async (_event, payload: SyncWebDavBindPayload) => {
      return safeHandle(() => syncService.bindWebdav(payload));
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SYNC_NOW,
    async (_event, options?: { forceFull?: boolean }) => {
      return safeHandle(() => syncService.syncNow(options));
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SYNC_UPDATE_OPTIONS,
    async (
      _event,
      patch: { autoSyncOnUnlock?: boolean; autoPushOnChange?: boolean }
    ) => {
      return safeHandle(() => syncService.updateOptions(patch));
    }
  );

  ipcMain.handle(IPC_CHANNELS.SYNC_GET_TOKEN, async () => {
    return safeHandle(() => syncService.getToken());
  });

  ipcMain.handle(IPC_CHANNELS.SYNC_DISCONNECT, async () => {
    return safeHandle(() => syncService.disconnect());
  });

  ipcMain.handle(
    IPC_CHANNELS.SYNC_RESTORE_VAULT,
    async (_event, payload: SyncRestorePayload) => {
      return safeHandle(() => syncService.restoreVaultFromCloud(payload));
    }
  );

  ipcMain.handle(IPC_CHANNELS.SYNC_GET_DEPLOY_TEMPLATES, async () => {
    return safeHandle(() => deployService.getDeployTemplates());
  });

  ipcMain.handle(IPC_CHANNELS.SYNC_EXPORT_DEPLOY_BUNDLE, async () => {
    return safeHandle(async () => {
      const win = getMainWindow();
      const picker = win
        ? await dialog.showOpenDialog(win, {
            title: '选择导出云同步 Docker 部署包的目录',
            properties: ['openDirectory', 'createDirectory'],
          })
        : await dialog.showOpenDialog({
            title: '选择导出云同步 Docker 部署包的目录',
            properties: ['openDirectory', 'createDirectory'],
          });

      if (picker.canceled || picker.filePaths.length === 0) {
        return null;
      }
      return deployService.exportDeployBundle(picker.filePaths[0]);
    });
  });

  ipcMain.handle(
    IPC_CHANNELS.SYNC_ONE_CLICK_DEPLOY,
    async (_event, payload: SyncOneClickDeployPayload) => {
      return safeHandle(() => deployService.oneClickDeploy(payload));
    }
  );
}
