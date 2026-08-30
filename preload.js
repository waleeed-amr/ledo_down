const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  getDefaultPath: () => ipcRenderer.invoke('get-default-path'),
  showQuickAdd: (url, cookies, ua) => ipcRenderer.send('show-quick-add', url, cookies, ua),
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('set-auto-launch', enabled),
  getSystemStats: () => ipcRenderer.invoke('get-system-stats'),
  onWindowFocusChange: (callback) => ipcRenderer.on('window-focus-change', (event, isFocused) => callback(isFocused))
});
