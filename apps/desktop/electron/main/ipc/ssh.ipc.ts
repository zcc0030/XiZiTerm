import { BrowserWindow, ipcMain } from 'electron';
import {
  IPC_CHANNELS,
  LOCAL_HOST_ID,
  type SshConnectRequest,
  type SshResizePayload,
  type SshTestConnectionRequest,
} from '@xiziterm/shared';
import { sshService } from '../services/ssh.service';
import { localPtyService } from '../services/local-pty.service';

export function registerSshIpc(getMainWindow: () => BrowserWindow | null): void {
  const forwardData = (dataEvent: { sessionId: string; data: string }) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.SSH_DATA, dataEvent);
    }
  };

  const forwardState = (stateEvent: {
    sessionId: string;
    state: 'connecting' | 'connected' | 'disconnected' | 'error';
    message?: string;
    code?: number | null;
  }) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.SSH_STATE, stateEvent);
    }
  };

  sshService.setCallbacks(forwardData, forwardState);
  localPtyService.setCallbacks(forwardData, forwardState);

  ipcMain.handle(
    IPC_CHANNELS.LOCAL_LIST_SHELLS,
    async (_event, refresh?: boolean) => {
      return localPtyService.listShells(Boolean(refresh));
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SSH_CONNECT,
    async (_event, req: SshConnectRequest) => {
      if (req.hostId === LOCAL_HOST_ID) {
        return localPtyService.connect(req);
      }
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
      if (localPtyService.hasSession(payload.sessionId)) {
        localPtyService.write(payload.sessionId, payload.data);
      } else {
        sshService.write(payload.sessionId, payload.data);
      }
    }
  );

  ipcMain.on(IPC_CHANNELS.SSH_RESIZE, (_event, payload: SshResizePayload) => {
    if (localPtyService.hasSession(payload.sessionId)) {
      localPtyService.resize(payload.sessionId, payload.cols, payload.rows);
    } else {
      sshService.resize(payload.sessionId, payload.cols, payload.rows);
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.SSH_DISCONNECT,
    async (_event, sessionId: string) => {
      if (localPtyService.hasSession(sessionId)) {
        localPtyService.disconnect(sessionId);
      } else {
        await sshService.disconnect(sessionId);
      }
    }
  );
}
