'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const { Store } = require('./store');
const { ExcelService } = require('./excel');
const { Fetcher, testConnection } = require('./fetcher');
const { friendlyError } = require('./util');

app.setName('发票捕手');
if (process.platform === 'win32') app.setAppUserModelId('com.jello.invoicecatcher');

let mainWindow = null;
let store = null;
let excel = null;
let fetcher = null;
let retentionTimer = null;

function broadcast(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

const log = (level, text) => broadcast('fetch:log', { time: Date.now(), level, text });

function createWindow() {
  const isWindows = process.platform === 'win32';
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 830,
    minWidth: 1000,
    minHeight: 720,
    show: false,
    backgroundColor: '#070b14',
    ...(isWindows
      ? {
          titleBarStyle: 'hidden',
          titleBarOverlay: { color: '#070b14', symbolColor: '#c7d4e8', height: 54 },
        }
      : {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: 19, y: 21 },
        }),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });

  if (process.env.INVOICE_CAPTURE) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const image = await mainWindow.webContents.capturePage();
          fs.writeFileSync(process.env.INVOICE_CAPTURE, image.toPNG());
        } catch (error) {
          console.error('capture failed', error);
        }
      }, 1500);
    });
  }

}

function registerIpc() {
  ipcMain.handle('app:bootstrap', () => ({
    config: store.getPublicConfig(),
    cycle: store.getCycleSummary(),
    paths: { excel: store.getExcelPath(), saveDir: store.getConfig().saveDir },
    running: fetcher.running,
    stats: fetcher.stats,
    version: app.getVersion(),
  }));

  ipcMain.handle('settings:save', (event, payload = {}) => {
    try {
      const config = store.saveSettings(payload.config || payload);
      if (payload.password) store.setPassword(payload.password);
      broadcast('settings:updated', { config });
      log('success', '邮箱设置已保存。');
      return { ok: true, config };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('settings:chooseDir', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择发票 PDF 保存文件夹',
      buttonLabel: '选择此文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false };
    const config = store.setSaveDir(result.filePaths[0]);
    broadcast('settings:updated', { config });
    return { ok: true, config };
  });

  ipcMain.handle('settings:test', async (event, payload = {}) => {
    const config = { ...store.getConfig(), ...(payload.config || {}) };
    const password = payload.password || store.getPassword();
    try {
      const result = await testConnection(config, password);
      log('success', result.message);
      return result;
    } catch (error) {
      const message = friendlyError(error);
      log('error', message);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('fetch:start', (_event, options) => {
    const result = fetcher.start(options || {});
    if (!result.ok) {
      log('error', result.error);
    } else {
      broadcast('cycle:updated', {
        cycle: store.getCycleSummary(),
        paths: { excel: store.getExcelPath(), saveDir: store.getConfig().saveDir },
      });
    }
    return result;
  });

  ipcMain.handle('fetch:stop', () => fetcher.stop());

  ipcMain.handle('cycle:reset', async () => {
    await fetcher.stop();
    const cycle = store.resetCycle();
    await excel.reset();
    broadcast('cycle:updated', {
      cycle,
      paths: { excel: store.getExcelPath(), saveDir: store.getConfig().saveDir },
    });
    log('success', `已开启第 ${cycle.number} 个周期：发票文件、去重记录与总览表均已清空。`);
    return { ok: true, cycle };
  });

  ipcMain.handle('shell:open', async (event, target) => {
    try {
      if (target === 'excel') {
        const file = store.getExcelPath();
        if (!fs.existsSync(file)) await excel.reset();
        const error = await shell.openPath(file);
        return error ? { ok: false, error } : { ok: true };
      }
      if (target === 'saveDir') {
        const dir = store.getConfig().saveDir;
        fs.mkdirSync(dir, { recursive: true });
        const error = await shell.openPath(dir);
        return error ? { ok: false, error } : { ok: true };
      }
      if (target === 'dataDir') {
        const error = await shell.openPath(app.getPath('userData'));
        return error ? { ok: false, error } : { ok: true };
      }
      return { ok: false, error: '未知的打开目标' };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
}

function buildMenu() {
  const template = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function init() {
  store = new Store();
  excel = new ExcelService(store, log);
  fetcher = new Fetcher({ store, excel, emit: broadcast });
  if (process.platform === 'win32') Menu.setApplicationMenu(null);

  registerIpc();
  buildMenu();
  createWindow();

  const cleanup = store.cleanupExpired(30);
  if (cleanup.removedCount > 0) {
    log('info', `已清理 ${cleanup.removedCount} 张超过 30 天的发票（截止 ${cleanup.cutoff}）。`);
  }
  excel.request();


  // 每 6 小时检查一次过期数据，保证程序长期开着也只保留最近 30 天
  retentionTimer = setInterval(() => {
    const result = store.cleanupExpired(30);
    if (result.removedCount > 0) {
      log('info', `定时清理：移除 ${result.removedCount} 张超过 30 天的发票（截止 ${result.cutoff}）。`);
      excel.request();
      broadcast('cycle:updated', {
        cycle: store.getCycleSummary(),
        paths: { excel: store.getExcelPath(), saveDir: store.getConfig().saveDir },
      });
    }
  }, 6 * 60 * 60 * 1000);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(init);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    if (retentionTimer) clearInterval(retentionTimer);
    if (fetcher && fetcher.running) fetcher.stop();
  });
}
