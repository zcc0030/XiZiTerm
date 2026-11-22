import { BrowserWindow, ipcMain } from 'electron';
import { IPC_CHANNELS, type ActionResult } from '@xiziterm/shared';
import { monitorService } from '../services/monitor.service';

export function registerMonitorIpc(
  getMainWindow: () => BrowserWindow | null
): void {
  monitorService.setCallbacks(
    (snapshot) => {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.MONITOR_SAMPLE, snapshot);
      }
    },
    (errorEvent) => {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.MONITOR_ERROR, errorEvent);
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.MONITOR_START,
    async (
      _event,
      sessionId: string,
      intervalMs?: number
    ): Promise<ActionResult> => {
      try {
        monitorService.start(sessionId, intervalMs);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.MONITOR_STOP,
    async (_event, sessionId: string): Promise<ActionResult> => {
      monitorService.stop(sessionId);
      return { ok: true };
    }
  );
}
