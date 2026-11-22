import { app, BrowserWindow, Menu, shell } from 'electron';
import path from 'path';
import { registerAllIpc } from './ipc';
import { sshService } from './services/ssh.service';
import { vaultService } from './services/vault.service';
import { monitorService } from './services/monitor.service';

app.setName('XiZiTerm');

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: '#090d16',
    title: 'XiZiTerm',
    icon: path.join(__dirname, '../../build/icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (
      details.url.startsWith('https://') ||
      details.url.startsWith('http://')
    ) {
      void shell.openExternal(details.url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  if (process.platform !== 'darwin') {
    // Prevent Electron's hidden default menu from intercepting terminal shortcuts
    // such as Ctrl+Shift+V (pasteAndMatchStyle double-paste), Ctrl+R, or Ctrl+W.
    Menu.setApplicationMenu(null);
  }
  registerAllIpc(() => mainWindow);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  monitorService.stopAll();
  sshService.disconnectAll();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  monitorService.stopAll();
  sshService.disconnectAll();
  vaultService.lock();
});
