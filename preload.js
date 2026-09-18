const { contextBridge, ipcRenderer, clipboard } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

contextBridge.exposeInMainWorld('electronAPI', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  getDefaultPath: () => ipcRenderer.invoke('get-default-path'),
  showQuickAdd: (payload) => ipcRenderer.send('show-quick-add', payload),
  hideQuickAdd: () => ipcRenderer.send('hide-quick-add'),
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('set-auto-launch', enabled),
  setSmartClipboard: (enabled) => ipcRenderer.send('set-smart-clipboard', enabled),
  getSystemStats: () => ipcRenderer.invoke('get-system-stats'),
  onWindowFocusChange: (callback) => ipcRenderer.on('window-focus-change', (event, isFocused) => callback(isFocused)),
  showNotification: (title, body) => ipcRenderer.send('show-notification', title, body),
  openPath: (folderPath) => ipcRenderer.invoke('open-path', folderPath),
  showItemInFolder: (filePath) => ipcRenderer.invoke('show-item-in-folder', filePath),
  openExtensionFolder: () => ipcRenderer.invoke('open-extension-folder'),
  showMainWindow: () => ipcRenderer.send('show-main-window'),
  windowControl: (action) => ipcRenderer.send('window-control', action),
  sendMiniProgressAction: (action) => ipcRenderer.send('mini-progress-action', action),
  sendMiniProgressResize: (height) => ipcRenderer.send('mini-progress-resize', height),
  writeClipboardText: (text) => clipboard.writeText(text),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  // Safe path & os wrappers
  pathExtname: (p) => path.extname(p),
  pathBasename: (p) => path.basename(p),
  pathJoin: (...paths) => path.join(...paths),
  pathDirname: (p) => path.dirname(p),
  osHomedir: () => os.homedir(),
  // Safe fs wrappers (only what's needed)
  fsExistsSync: (p) => fs.existsSync(p),
  fsMkdirSync: (p) => fs.mkdirSync(p, { recursive: true })
});
