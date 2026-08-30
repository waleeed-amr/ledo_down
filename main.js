const { app, BrowserWindow, ipcMain, Tray, Menu, clipboard, dialog, session, globalShortcut } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs-extra'); // 1. fs-extra: للتعامل المتقدم والآمن مع الملفات
const log = require('electron-log'); // 2. electron-log: لتسجيل الأحداث واكتشاف الأخطاء
const Store = require('electron-store'); // 3. electron-store: لحفظ الإعدادات
const { autoUpdater } = require('electron-updater'); // 4. electron-updater: للتحديث التلقائي
const contextMenu = require('electron-context-menu'); // 5. electron-context-menu: لقائمة الزر الأيمن
const os = require('os');

// تهيئة الإعدادات
const store = new Store();

// تهيئة قائمة الزر الأيمن
contextMenu({
  showSaveImageAs: true,
  showCopyImage: true,
  showCopyImageAddress: true,
  showSelectAll: true,
});

// تحويل أخطاء console إلى ملف السجل في الإنتاج
console.log = log.log;
console.error = log.error;

// Helper: register / unregister the app as a Windows login item.
// Only safe to call when the app is packaged — in dev mode getPath('exe')
// points at electron.exe inside node_modules, which would create a broken
// startup entry like the one shown in the user's Task Manager screenshot.
function applyAutoLaunch(enabled) {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({
    openAtLogin: !!enabled,
    path: app.getPath('exe'),
    args: ['--hidden']
  });
}

// Set the App User Model ID for Windows Notifications.
// Use the reverse-DNS AppId from package.json so Task Manager groups
// the app under a stable identity (helps with publisher + impact measurement).
app.setAppUserModelId('com.ledo.downloader');

// Fill the "About" panel — Windows uses this to populate the Publisher
// column in Task Manager → Startup apps when the binary isn't code-signed.
app.setAboutPanelOptions({
  applicationName: 'Ledo Downloader',
  applicationVersion: app.getVersion(),
  copyright: '© 2026 Waleed amr',
  credits: 'Ledo Downloader',
  authors: ['Waleed amr'],
  website: 'https://github.com/waleedamr/ledo-downloader'
});

let mainWindow;
let quickAddWindow;
let miniProgressWindow;
let pythonProcess;
let tray = null;
let isQuiting = false;
let clipboardInterval = null;
let lastClipboard = '';
let lastCpuInfo = os.cpus();

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', (event, commandLine, workingDirectory) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  }
});

function createWindow() {
  const isStartup = process.argv.includes('--hidden');

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: !isStartup, // Show normally if opened manually, hide if startup
    title: "Ledo Downloader",
    backgroundColor: '#111111',
    icon: path.join(__dirname, 'frontend', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true
    }
  });

  // Smart startup on login is now driven by the Settings toggle
  // (see IPC handler 'set-auto-launch' below). Doing it here on every
  // window creation forced a re-registration of the dev electron.exe
  // and produced a broken entry in Task Manager → Startup apps.
  // We just sync the state from disk on first run.
  if (app.isPackaged) {
    const stored = store.get('launchOnStartup', true);
    applyAutoLaunch(stored);
  }

  mainWindow.setMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'frontend', 'index.html'));
  
  // F12 to toggle DevTools
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      mainWindow.webContents.toggleDevTools();
    }
  });

  mainWindow.on('close', (event) => {
    if (!isQuiting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('blur', () => {
    mainWindow.webContents.send('window-focus-change', false);
  });
  
  mainWindow.on('focus', () => {
    mainWindow.webContents.send('window-focus-change', true);
  });

  
  ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory']
    });
    if (result.canceled) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle('get-default-path', () => {
    return path.join(app.getPath('downloads'), 'Ledo Downloader');
  });

  // Toggle the Windows "Run at startup" login item from the Settings UI.
  // The setting is persisted in electron-store so it survives reinstalls.
  ipcMain.handle('get-auto-launch', () => {
    return {
      available: app.isPackaged,
      enabled: app.isPackaged ? app.getLoginItemSettings().openAtLogin : false
    };
  });

  ipcMain.handle('set-auto-launch', (_event, enabled) => {
    if (!app.isPackaged) return false;
    applyAutoLaunch(!!enabled);
    store.set('launchOnStartup', !!enabled);
    return app.getLoginItemSettings().openAtLogin;
  });

  ipcMain.handle('get-system-stats', () => {
    const cpus = os.cpus();
    let idle = 0;
    let total = 0;
    for (let i = 0, len = cpus.length; i < len; i++) {
        const cpu = cpus[i];
        const lastCpu = lastCpuInfo[i] || cpu;
        for (let type in cpu.times) {
            total += cpu.times[type] - lastCpu.times[type];
        }
        idle += cpu.times.idle - lastCpu.times.idle;
    }
    const cpuUsage = total === 0 ? 0 : 100 - ~~(100 * idle / total);
    lastCpuInfo = cpus;

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memUsage = 100 - ~~(100 * freeMem / totalMem);

    return {
        cpu: cpuUsage,
        ram: memUsage,
        totalRam: totalMem,
        freeRam: freeMem
    };
  });

  ipcMain.on('show-quick-add', (event, url, cookies, ua) => {
    if (!quickAddWindow || quickAddWindow.isDestroyed()) {
      createQuickAddWindow();
    }
    if (url) {
        const safeUrl = JSON.stringify(url);
        const safeCookies = JSON.stringify(cookies || '');
        const safeUa = JSON.stringify(ua || '');
        quickAddWindow.webContents.executeJavaScript(`
            document.getElementById('url-input').value = ${safeUrl};
            document.getElementById('url-input').focus();
            window.tempCookies = ${safeCookies};
            window.tempUA = ${safeUa};
        `);
    }
    quickAddWindow.show();
    quickAddWindow.focus();
  });
}

function startPythonBackend() {
  if (app.isPackaged) {
    const backendPath = path.join(process.resourcesPath, 'backend', 'dist', 'main.exe');
    pythonProcess = spawn(backendPath, [], { cwd: path.dirname(backendPath) });
  } else {
    let pythonExecutable = 'python';
    const venvPythonPath = path.join(__dirname, '.venv', 'Scripts', 'python.exe');
    if (fs.existsSync(venvPythonPath)) {
      pythonExecutable = venvPythonPath;
    }
    pythonProcess = spawn(pythonExecutable, [path.join(__dirname, 'backend', 'main.py')], { cwd: __dirname });
  }
  
  pythonProcess.stdout.on('data', (data) => {
    log.info(`Python: ${data}`);
  });

  pythonProcess.stderr.on('data', (data) => {
    log.error(`Python Error: ${data}`);
  });
}

function waitForBackend(url, timeout = 60000) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const req = http.get(url, (res) => {
        if (res.statusCode === 200) {
            resolve();
        } else {
            if (Date.now() - start > timeout) reject(new Error('Timeout')); else setTimeout(check, 500);
        }
      });
      req.on('error', () => {
        if (Date.now() - start > timeout) {
          reject(new Error('Timeout'));
        } else {
          setTimeout(check, 500);
        }
      });
      req.setTimeout(1000, () => {
        req.destroy();
      });
    };
    check();
  });
}

function createQuickAddWindow() {
  quickAddWindow = new BrowserWindow({
    width: 620,
    height: 165,
    frame: false,
    transparent: true,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: false
    }
  });
  
  quickAddWindow.loadFile(path.join(__dirname, 'frontend', 'quick_add.html'));
  
  quickAddWindow.on('blur', () => {
    quickAddWindow.hide();
  });
}

function createMiniProgressWindow() {
  miniProgressWindow = new BrowserWindow({
    width: 320,
    height: 120,
    frame: false,
    transparent: true,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: false
    }
  });
  
  miniProgressWindow.loadFile(path.join(__dirname, 'frontend', 'mini_progress.html'));
  
  ipcMain.on('mini-progress-action', (event, action) => {
    if (action === 'show') {
      if (mainWindow && mainWindow.isVisible() && mainWindow.isFocused()) {
          return;
      }
      const { screen } = require('electron');
      const primaryDisplay = screen.getPrimaryDisplay();
      const { width, height } = primaryDisplay.workAreaSize;
      const bounds = miniProgressWindow.getBounds();
      
      const x = width - bounds.width - 20;
      const y = height - bounds.height - 20;
      
      miniProgressWindow.setPosition(x, y);
      miniProgressWindow.showInactive();
    } else if (action === 'hide') {
      miniProgressWindow.hide();
    }
  });

  ipcMain.on('mini-progress-resize', (event, targetHeight) => {
    const bounds = miniProgressWindow.getBounds();
    if (bounds.height !== targetHeight) {
      const { screen } = require('electron');
      const primaryDisplay = screen.getPrimaryDisplay();
      const { width, height } = primaryDisplay.workAreaSize;
      
      const newY = height - targetHeight - 20;
      miniProgressWindow.setBounds({
        x: bounds.x,
        y: newY,
        width: bounds.width,
        height: targetHeight
      });
    }
  });
}

app.whenReady().then(async () => {
  // فحص وتنزيل التحديثات تلقائيا إذا توفرت
  autoUpdater.checkForUpdatesAndNotify();

  startPythonBackend();
  try {
      await waitForBackend('http://127.0.0.1:8000/api/health', 60000);
  } catch (err) {
      dialog.showErrorBox("Startup Error", "The backend server took too long to start or the port is in use. Please check if Ledo Downloader is already running or restart the application.");
      app.quit();
      return;
  }
  createWindow();
  createQuickAddWindow();
  createMiniProgressWindow();

  // Register Global Shortcut
  globalShortcut.register('CommandOrControl+Space', () => {
    if (!quickAddWindow || quickAddWindow.isDestroyed()) {
      createQuickAddWindow();
    }
    if (quickAddWindow.isVisible()) {
      quickAddWindow.hide();
    } else {
      quickAddWindow.show();
      quickAddWindow.focus();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  
  // System Tray Setup
  tray = new Tray(path.join(__dirname, 'frontend', 'icon.ico'));
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show App', click: () => { mainWindow.show(); } },
    { label: 'Quit', click: () => { isQuiting = true; app.quit(); } }
  ]);
  tray.setToolTip('Ledo Downloader is running in background');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => { mainWindow.show(); });

  // Clipboard Monitor (Smart Paste)
  clipboardInterval = setInterval(() => {
    const text = clipboard.readText();
    if (text !== lastClipboard && (text.includes('tiktok.com') || text.includes('youtube.com') || text.includes('instagram.com') || text.includes('fb.watch') || text.includes('x.com'))) {
        lastClipboard = text;
        dialog.showMessageBox(mainWindow, {
            type: 'question',
            buttons: ['Yes', 'No'],
            title: 'Smart Paste Detected',
            message: `Do you want to download this video?\n${text}`
        }).then(result => {
            if (result.response === 0) {
                mainWindow.show();
                mainWindow.webContents.executeJavaScript(`
                    document.getElementById('url-input').value = '${text}';
                    document.getElementById('btn-fetch-info').click();
                `);
            }
        });
    }
  }, 2000);
  

});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (clipboardInterval) {
    clearInterval(clipboardInterval);
    clipboardInterval = null;
  }
  if (pythonProcess) {
    try {
      // On Windows, kill the entire process tree
      const { execSync } = require('child_process');
      execSync(`taskkill /PID ${pythonProcess.pid} /T /F`, { stdio: 'ignore' });
    } catch (e) {
      // Fallback to regular kill
      pythonProcess.kill();
    }
    pythonProcess = null;
  }
});
