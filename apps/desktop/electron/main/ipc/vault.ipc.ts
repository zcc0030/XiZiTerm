import { dialog, ipcMain } from 'electron';
import { promises as fs } from 'fs';
import {
  IPC_CHANNELS,
  type ActionResult,
  type HostGroupInput,
  type HostInput,
  type SnippetInput,
  type UserPreferences,
} from '@xiziterm/shared';
import { vaultService } from '../services/vault.service';
import { sshService } from '../services/ssh.service';
import { syncService } from '../services/sync.service';

async function safeHandle<T>(fn: () => Promise<T> | T): Promise<ActionResult<T>> {
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

export function registerVaultIpc(): void {
  ipcMain.handle(IPC_CHANNELS.VAULT_STATUS, async () => {
    return vaultService.getStatus();
  });

  ipcMain.handle(
    IPC_CHANNELS.VAULT_INIT,
    async (_event, masterPassword: string) => {
      return safeHandle(() => vaultService.initialize(masterPassword));
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.VAULT_UNLOCK,
    async (_event, masterPassword: string) => {
      return safeHandle(async () => {
        const data = await vaultService.unlock(masterPassword);
        syncService.onVaultUnlocked();
        return data;
      });
    }
  );

  ipcMain.handle(IPC_CHANNELS.VAULT_LOCK, async () => {
    return safeHandle(() => {
      syncService.onVaultLocked();
      sshService.disconnectAll();
      vaultService.lock();
    });
  });

  ipcMain.handle(IPC_CHANNELS.VAULT_GET_DATA, async () => {
    return safeHandle(() => vaultService.getActiveData());
  });

  ipcMain.handle(
    IPC_CHANNELS.VAULT_SAVE_GROUP,
    async (_event, input: HostGroupInput) => {
      return safeHandle(() => vaultService.saveGroup(input));
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.VAULT_DELETE_GROUP,
    async (_event, groupId: string) => {
      return safeHandle(() => vaultService.deleteGroup(groupId));
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.VAULT_SAVE_HOST,
    async (_event, input: HostInput) => {
      return safeHandle(() => vaultService.saveHost(input));
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.VAULT_DELETE_HOST,
    async (_event, hostId: string) => {
      return safeHandle(() => vaultService.deleteHost(hostId));
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.VAULT_SAVE_SNIPPET,
    async (_event, input: SnippetInput) => {
      return safeHandle(() => vaultService.saveSnippet(input));
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.VAULT_DELETE_SNIPPET,
    async (_event, snippetId: string) => {
      return safeHandle(() => vaultService.deleteSnippet(snippetId));
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.VAULT_UPDATE_PREFERENCES,
    async (
      _event,
      patch: Partial<
        Omit<
          UserPreferences,
          'id' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'syncVersion'
        >
      >
    ) => {
      return safeHandle(() => vaultService.updatePreferences(patch));
    }
  );

  ipcMain.handle(IPC_CHANNELS.DIALOG_OPEN_KEY_FILE, async () => {
    return safeHandle(async () => {
      const res = await dialog.showOpenDialog({
        title: '选择 SSH 私钥文件',
        properties: ['openFile', 'showHiddenFiles'],
        filters: [
          { name: 'SSH Keys', extensions: ['pem', 'key', 'ppk', 'id_rsa', 'ed25519'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });
      if (res.canceled || res.filePaths.length === 0) {
        return null;
      }
      const filePath = res.filePaths[0];
      const stat = await fs.stat(filePath);
      if (stat.size > 256 * 1024) {
        throw new Error('所选文件过大（>256KB），请确认是否为有效的 SSH 私钥文件');
      }
      const content = await fs.readFile(filePath, 'utf8');
      return { filePath, content };
    });
  });
}
