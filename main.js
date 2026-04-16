const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

let mainWindow;
let forceQuit = false; // set to true when renderer has already saved

// ── Paths ──────────────────────────────────────────────────────────────────

function getProgressPath() {
  return path.join(app.getPath('userData'), 'progress.json');
}

function getAnnotationsPath(filePath) {
  const hash = crypto.createHash('md5').update(filePath).digest('hex');
  const dir = path.join(app.getPath('userData'), 'annotations');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${hash}.json`);
}

// ── Progress ───────────────────────────────────────────────────────────────

function loadAllProgress() {
  const p = getProgressPath();
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return {}; }
}

function saveAllProgress(data) {
  fs.writeFileSync(getProgressPath(), JSON.stringify(data, null, 2), 'utf-8');
}

// ── Window state ───────────────────────────────────────────────────────────

function getWindowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  try { return JSON.parse(fs.readFileSync(getWindowStatePath(), 'utf-8')); }
  catch { return { width: 1280, height: 860 }; }
}

function saveWindowState(win) {
  if (!win || win.isMaximized() || win.isMinimized() || win.isDestroyed()) return;
  try { fs.writeFileSync(getWindowStatePath(), JSON.stringify(win.getBounds(), null, 2)); }
  catch {}
}

// ── Window ─────────────────────────────────────────────────────────────────

function createWindow() {
  const state = loadWindowState();

  mainWindow = new BrowserWindow({
    width:     state.width  || 1280,
    height:    state.height || 860,
    x:         state.x,
    y:         state.y,
    minWidth:  700,
    minHeight: 500,
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'PDFXS',
  });

  // Save window bounds on resize/move (debounced)
  let boundsTimer = null;
  const debounceSave = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => saveWindowState(mainWindow), 500);
  };
  mainWindow.on('resize', debounceSave);
  mainWindow.on('move',   debounceSave);

  // Intercept close: ask renderer to save first, then really quit
  mainWindow.on('close', (e) => {
    if (forceQuit) return;          // renderer already saved, allow close
    e.preventDefault();
    saveWindowState(mainWindow);    // save bounds before hiding
    mainWindow.webContents.send('app-close');
  });

  mainWindow.loadFile('renderer/index.html');
  // F12 / Ctrl+Shift+I 打开开发者工具
  mainWindow.webContents.on('before-input-event', (_, input) => {
    if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
      mainWindow.webContents.toggleDevTools();
    }
  });

  const menu = Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        {
          label: '打开 PDF',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              filters: [
                { name: 'PDF / EPUB / Markdown', extensions: ['pdf', 'epub', 'md', 'markdown'] },
                { name: 'PDF 文件',              extensions: ['pdf'] },
                { name: 'EPUB 文件',             extensions: ['epub'] },
                { name: 'Markdown 文件',         extensions: ['md', 'markdown'] },
              ],
              properties: ['openFile'],
            });
            if (!result.canceled && result.filePaths.length > 0) {
              mainWindow.webContents.send('open-file', result.filePaths[0]);
            }
          },
        },
        {
          label: '新标签页',
          accelerator: 'CmdOrCtrl+T',
          click: () => mainWindow.webContents.send('new-tab'),
        },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '放大', accelerator: 'CmdOrCtrl+Plus', click: () => mainWindow.webContents.send('zoom-in') },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => mainWindow.webContents.send('zoom-out') },
        { label: '适应窗口', accelerator: 'CmdOrCtrl+0', click: () => mainWindow.webContents.send('zoom-fit') },
        { type: 'separator' },
        { label: '上一页', accelerator: 'CmdOrCtrl+Left', click: () => mainWindow.webContents.send('prev-page') },
        { label: '下一页', accelerator: 'CmdOrCtrl+Right', click: () => mainWindow.webContents.send('next-page') },
        { type: 'separator' },
        { label: '目录', accelerator: 'CmdOrCtrl+B', click: () => mainWindow.webContents.send('toggle-toc') },
        { label: '搜索', accelerator: 'CmdOrCtrl+F', click: () => mainWindow.webContents.send('toggle-search') },
        { label: '夜间模式', accelerator: 'CmdOrCtrl+D', click: () => mainWindow.webContents.send('night-mode') },
      ],
    },
    {
      label: '注释',
      submenu: [
        { label: '高亮 (黄)', accelerator: 'CmdOrCtrl+H', click: () => mainWindow.webContents.send('highlight', '#ffff00') },
        { label: '高亮 (绿)', click: () => mainWindow.webContents.send('highlight', '#90ee90') },
        { label: '高亮 (蓝)', click: () => mainWindow.webContents.send('highlight', '#add8e6') },
        { type: 'separator' },
        { label: '添加签名', click: () => mainWindow.webContents.send('open-signature') },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
// Menu "Quit" sets forceQuit so the close handler doesn't intercept
app.on('before-quit', () => { forceQuit = true; });

// ── IPC Handlers ───────────────────────────────────────────────────────────

ipcMain.handle('dialog:openFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    filters: [
      { name: 'PDF / EPUB / Markdown', extensions: ['pdf', 'epub', 'md', 'markdown'] },
      { name: 'PDF 文件',              extensions: ['pdf'] },
      { name: 'EPUB 文件',             extensions: ['epub'] },
      { name: 'Markdown 文件',         extensions: ['md', 'markdown'] },
    ],
    properties: ['openFile'],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('file:read', (_, filePath) => {
  const buf = fs.readFileSync(filePath);
  // 切出独立的 ArrayBuffer，IPC 可正确传输
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

ipcMain.handle('progress:load', (_, filePath) => {
  const all = loadAllProgress();
  return all[filePath] || null;
});

ipcMain.handle('progress:save', (_, filePath, page, zoom) => {
  const all = loadAllProgress();
  all[filePath] = { page, zoom, updatedAt: Date.now() };
  saveAllProgress(all);
});

ipcMain.handle('annotations:load', (_, filePath) => {
  const p = getAnnotationsPath(filePath);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
});

ipcMain.handle('annotations:save', (_, filePath, data) => {
  const p = getAnnotationsPath(filePath);
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
});

// Renderer calls this after saving all open tabs; we then allow the close
ipcMain.handle('app:quit', () => {
  forceQuit = true;
  mainWindow.close();
});

ipcMain.handle('dialog:saveFile', async (_, opts) => {
  const result = await dialog.showSaveDialog(mainWindow, opts);
  return result.canceled ? null : result.filePath;
});

ipcMain.handle('file:write', (_, filePath, content) => {
  fs.writeFileSync(filePath, content, 'utf-8');
});

// ── Recent Files ───────────────────────────────────────────────────────────

function getRecentPath() {
  return path.join(app.getPath('userData'), 'recent.json');
}

ipcMain.handle('recent:load', () => {
  const p = getRecentPath();
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return []; }
});

ipcMain.handle('recent:add', (_, filePath) => {
  const p = getRecentPath();
  let list = [];
  try { list = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch {}
  list = [filePath, ...list.filter(f => f !== filePath)].slice(0, 12);
  fs.writeFileSync(p, JSON.stringify(list, null, 2), 'utf-8');
  return list;
});

ipcMain.handle('recent:remove', (_, filePath) => {
  const p = getRecentPath();
  let list = [];
  try { list = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch {}
  list = list.filter(f => f !== filePath);
  fs.writeFileSync(p, JSON.stringify(list, null, 2), 'utf-8');
  return list;
});
