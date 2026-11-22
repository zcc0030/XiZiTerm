import path from 'path';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { IPC_CHANNELS, type ActionResult } from '@xiziterm/shared';
import { sftpService } from '../services/sftp.service';

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

export function registerSftpIpc(
  getMainWindow: () => BrowserWindow | null
): void {
  sftpService.setProgressCallback((event) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.SFTP_TRANSFER_PROGRESS, event);
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.SFTP_LIST,
    async (_event, sessionId: string, remotePath?: string) => {
      return safeHandle(() => sftpService.list(sessionId, remotePath));
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SFTP_MKDIR,
    async (_event, sessionId: string, remotePath: string) => {
      return safeHandle(() => sftpService.mkdir(sessionId, remotePath));
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SFTP_CREATE_FILE,
    async (_event, sessionId: string, remotePath: string) => {
      return safeHandle(() => sftpService.createFile(sessionId, remotePath));
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SFTP_RENAME,
    async (_event, sessionId: string, oldPath: string, newPath: string) => {
      return safeHandle(() => sftpService.rename(sessionId, oldPath, newPath));
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SFTP_DELETE,
    async (
      _event,
      sessionId: string,
      remotePath: string,
      isDirectory: boolean
    ) => {
      return safeHandle(() =>
        sftpService.deleteEntry(sessionId, remotePath, isDirectory)
      );
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SFTP_CHMOD,
    async (_event, sessionId: string, remotePath: string, octalMode: string) => {
      return safeHandle(() =>
        sftpService.chmod(sessionId, remotePath, octalMode)
      );
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SFTP_UPLOAD_PICK,
    async (_event, sessionId: string, remoteDir: string) => {
      return safeHandle(async () => {
        const win = getMainWindow();
        const picker = win
          ? await dialog.showOpenDialog(win, {
              title: '选择要上传的文件',
              properties: ['openFile', 'multiSelections', 'showHiddenFiles'],
            })
          : await dialog.showOpenDialog({
              title: '选择要上传的文件',
              properties: ['openFile', 'multiSelections', 'showHiddenFiles'],
            });

        if (picker.canceled || picker.filePaths.length === 0) {
          return { uploadedCount: 0 };
        }
        return sftpService.uploadLocalPaths(
          sessionId,
          picker.filePaths,
          remoteDir
        );
      });
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SFTP_UPLOAD_PATHS,
    async (
      _event,
      sessionId: string,
      localPaths: string[],
      remoteDir: string
    ) => {
      return safeHandle(() =>
        sftpService.uploadLocalPaths(sessionId, localPaths, remoteDir)
      );
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SFTP_DOWNLOAD,
    async (
      _event,
      sessionId: string,
      remotePath: string,
      suggestedName: string
    ) => {
      return safeHandle(async () => {
        const win = getMainWindow();
        const safeName = path.basename(suggestedName || remotePath);
        const ext = path.extname(safeName).replace(/^\./, '');
        const defaultPath = path.join(app.getPath('downloads'), safeName);
        const filters = ext
          ? [
              {
                name: `${ext.toUpperCase()} 文件 (*.${ext})`,
                extensions: [ext],
              },
              { name: '所有文件 (*.*)', extensions: ['*'] },
            ]
          : [{ name: '所有文件 (*.*)', extensions: ['*'] }];

        const dialogOptions: Electron.SaveDialogOptions = {
          title: '保存远程文件到本地',
          defaultPath,
          filters,
        };

        const save = win
          ? await dialog.showSaveDialog(win, dialogOptions)
          : await dialog.showSaveDialog(dialogOptions);

        if (save.canceled || !save.filePath) {
          return null;
        }
        await sftpService.downloadFile(sessionId, remotePath, save.filePath);
        return { localPath: save.filePath };
      });
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SFTP_READ_TEXT,
    async (_event, sessionId: string, remotePath: string) => {
      return safeHandle(() => sftpService.readTextFile(sessionId, remotePath));
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SFTP_WRITE_TEXT,
    async (_event, sessionId: string, remotePath: string, content: string) => {
      return safeHandle(() =>
        sftpService.writeTextFile(sessionId, remotePath, content)
      );
    }
  );
}
