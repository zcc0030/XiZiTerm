import type { BrowserWindow } from 'electron';
import { registerVaultIpc } from './vault.ipc';
import { registerSshIpc } from './ssh.ipc';
import { registerSftpIpc } from './sftp.ipc';
import { registerMonitorIpc } from './monitor.ipc';
import { registerSyncIpc } from './sync.ipc';

export function registerAllIpc(getMainWindow: () => BrowserWindow | null): void {
  registerVaultIpc();
  registerSshIpc(getMainWindow);
  registerSftpIpc(getMainWindow);
  registerMonitorIpc(getMainWindow);
  registerSyncIpc(getMainWindow);
}
