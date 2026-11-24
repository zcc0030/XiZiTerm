import { BrowserWindow, ipcMain } from 'electron';
import {
  IPC_CHANNELS,
  type SshConnectRequest,
  type SshResizePayload,
  type SshTestConnectionRequest,
} from '@xiziterm/shared';
import { sshService } from '../services/ssh.service';

export function registerSshIpc(getMainWindow: () => BrowserWindow | null): void {
  sshService.setCallbacks(
    (dataEvent) => {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.SSH_DATA, dataEvent);
      }
    },
    (stateEvent) => {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.SSH_STATE, stateEvent);
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SSH_CONNECT,
    async (_event, req: SshConnectRequest) => {
      return sshService.connect(req);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SSH_TEST_CONNECTION,
    async (_event, req: SshTestConnectionRequest) => {
      return sshService.testConnection(req);
    }
  );

  ipcMain.on(
    IPC_CHANNELS.SSH_WRITE,
    (_event, payload: { sessionId: string; data: string }) => {
      sshService.write(payload.sessionId, payload.data);
    }
  );

  ipcMain.on(IPC_CHANNELS.SSH_RESIZE, (_event, payload: SshResizePayload) => {
    sshService.resize(payload.sessionId, payload.cols, payload.rows);
  });

  ipcMain.handle(
    IPC_CHANNELS.SSH_DISCONNECT,
    async (_event, sessionId: string) => {
      await sshService.disconnect(sessionId);
    }
  );
}
