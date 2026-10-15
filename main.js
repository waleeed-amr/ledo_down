const { app, BrowserWindow, ipcMain, Tray, Menu, clipboard, dialog, session, globalShortcut, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs-extra'); // 1. fs-extra: للتعامل المتقدم والآمن مع الملفات
const log = require('electron-log'); // 2. electron-log: لتسجيل الأحداث واكتشاف الأخطاء
const Store = require('electron-store'); // 3. electron-store: لحفظ الإعدادات
const { autoUpdater } = require('electron-updater'); // 4. electron-updater: للتحديث التلقائي
const contextMenu = require('electron-context-menu'); // 5. electron-context-menu: لقائمة الزر الأيمن
const os = require('os');
const { checkIntegrity } = require('./integrity_check.js');

// Use the branded name in Windows taskbar, notifications, and app identity.
app.setName('Ledo Downloader');

// Keep renderer heaps bounded and let Chromium throttle hidden windows.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=160');

// ── Auto-Updater Configuration ──────────────────────────────────────────
autoUpdater.autoDownload = true;        // تنزيل التحديث تلقائياً فور اكتشافه
autoUpdater.allowDowngrade = false;     // عدم السماح بالتخفيض
autoUpdater.autoInstallOnAppQuit = true; // تثبيت التحديث عند إغلاق التطبيق
autoUpdater.logger = log;               // استخدام electron-log للتسجيل
autoUpdater.logger.transports.file.level = 'info';

// تهيئة الإعدادات
const store = new Store();

// تهيئة قائمة الزر الأيمن
contextMenu({
  showSaveImageAs: true,
  showCopyImage: true,
  showCopyImageAddress: true,
  showSelectAll: false,
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
let mainPageLoaded = false;
let backendStartTimer = null;
let updaterStartupTimer = null;
let backendMonitorStarted = false;
let backendReadyPromise = null;
let launchedAtLogin = false;
let clipboardInterval = null;
let lastClipboard = '';
let smartClipboardEnabled = true;
let smartPastePromptPending = false;
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
  const loginSettings = app.getLoginItemSettings();
  const isStartup = process.argv.includes('--hidden') || process.argv.includes('-hidden') || loginSettings.wasOpenedAtLogin;

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: !isStartup, // Show normally if opened manually, hide if startup
    title: "Ledo Downloader",
    backgroundColor: '#111111',
    frame: false, // Custom title bar
    icon: path.join(__dirname, 'frontend', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true,  // Throttle timers/animations when window is hidden
      sandbox: false
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
  if (!isStartup) loadMainPage();
  
  // F12 to toggle DevTools
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      mainWindow.webContents.toggleDevTools();
    }
  });

  mainWindow.on('close', (event) => {
    if (!isQuiting && store.get('closeToTray', true)) {
      event.preventDefault();
      mainWindow.hide();
      mainWindow.setSkipTaskbar(true);
      notifyTrayMinimized();
    } else if (!isQuiting) {
      isQuiting = true;
      app.quit();
    }
  });

  mainWindow.on('show', () => {
    mainWindow.setSkipTaskbar(false);
    loadMainPage();
    ensureBackendStarted();
    // Resume rendering immediately so UI is responsive
    try { mainWindow.webContents.resume(); } catch(e) {}
    try { mainWindow.webContents.setBackgroundThrottling(false); } catch(e) {}
  });

  mainWindow.on('hide', () => {
    mainWindow.setSkipTaskbar(true);
    // Suspend rendering to drop GPU/CPU usage to near zero
    try { mainWindow.webContents.setBackgroundThrottling(true); } catch(e) {}
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        try { mainWindow.webContents.suspend(); } catch(e) {}
      }
    }, 500); // Small delay to let the hide animation finish first
  });

  mainWindow.on('blur', () => {
    mainWindow.webContents.send('window-focus-change', false);
  });
  
  mainWindow.on('focus', () => {
    mainWindow.webContents.send('window-focus-change', true);
  });
}

function loadMainPage() {
  if (!mainWindow || mainWindow.isDestroyed() || mainPageLoaded) return;
  mainPageLoaded = true;
  mainWindow.loadFile(path.join(__dirname, 'frontend', 'index.html'))
    .catch((err) => {
      mainPageLoaded = false;
      log.error('Failed to load main window:', err);
    });
}

function startPythonBackend() {
  if (app.isPackaged) {
    const backendPath = path.join(process.resourcesPath, 'backend', 'dist', 'main.exe');
    pythonProcess = spawn(backendPath, [], { 
        cwd: path.dirname(backendPath),
        windowsHide: true 
    });
  } else {
    let pythonExecutable = 'python';
    const venvPythonPath = path.join(__dirname, '.venv', 'Scripts', 'python.exe');
    if (fs.existsSync(venvPythonPath)) {
      pythonExecutable = venvPythonPath;
    }
    pythonProcess = spawn(pythonExecutable, [path.join(__dirname, 'backend', 'main.py')], { 
        cwd: __dirname,
        windowsHide: true 
    });
  }
  
  pythonProcess.stdout.on('data', (data) => {
    log.info(`Python: ${data}`);
  });

  pythonProcess.stderr.on('data', (data) => {
    log.error(`Python Error: ${data}`);
  });

  pythonProcess.on('error', (err) => {
    log.error(`Python process spawn error: ${err.message}`);
  });
}

function ensureBackendStarted() {
  if (backendStartTimer) {
    clearTimeout(backendStartTimer);
    backendStartTimer = null;
  }
  if (backendMonitorStarted) return backendReadyPromise || Promise.resolve(false);
  backendMonitorStarted = true;
  const healthUrl = 'http://127.0.0.1:8000/api/health';
  backendReadyPromise = (async () => {
    // Reuse an already-running local engine instead of launching another copy.
    if (!(await isBackendReady(healthUrl, 700))) startPythonBackend();
    await waitForBackend(healthUrl, 60000);
    return true;
  })()
    .then(() => {
      log.info('Local download backend is ready.');
      return true;
    })
    .catch((err) => {
      log.error('Local download backend startup failed:', err);
      if (!isQuiting) {
        dialog.showErrorBox("Startup Error", "The backend server took too long to start or the port is in use. Please check if Ledo Downloader is already running or restart the application.");
        app.quit();
      }
      return false;
    });
  return backendReadyPromise;
}

function isBackendReady(url, timeout = 700) {
  const http = require('http');
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeout, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function waitForBackend(url, timeout = 60000) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const req = http.get(url, (res) => {
        res.resume();
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
    width: 680,
    height: 480,
    frame: false,
    transparent: true,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  
  quickAddWindow.loadFile(path.join(__dirname, 'frontend', 'quick_add.html'));
}

function createMiniProgressWindow() {
  miniProgressWindow = new BrowserWindow({
    width: 350,
    height: 160,
    frame: false,
    transparent: true,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: true
    }
  });
  
  miniProgressWindow.loadFile(path.join(__dirname, 'frontend', 'mini_progress.html'));
}

function notifyTrayMinimized() {
  if (tray) {
    try {
      tray.displayBalloon({
        title: 'Ledo Downloader',
        content: 'Ledo Downloader is running in the background next to the clock.'
      });
    } catch (e) {}
  }
}

function setupTray() {
  if (tray) return;
  const iconPath = path.join(__dirname, 'frontend', 'icon.ico');
  if (!fs.existsSync(iconPath)) {
    log.error('Tray icon not found at', iconPath);
    return;
  }

  tray = new Tray(iconPath);

  const toggleMainWindow = () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    } else {
      mainWindow.show();
      mainWindow.setSkipTaskbar(false);
      mainWindow.focus();
    }
  };

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open Ledo Downloader',
      click: () => toggleMainWindow()
    },
    {
      label: 'Quick Add (Ctrl+Space)',
      click: () => {
        ensureBackendStarted();
        if (!quickAddWindow || quickAddWindow.isDestroyed()) createQuickAddWindow();
        quickAddWindow.show();
        quickAddWindow.focus();
      }
    },
    { type: 'separator' },
    {
      label: 'Exit Ledo Downloader',
      click: () => {
        isQuiting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('Ledo Downloader');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    toggleMainWindow();
  });

  tray.on('double-click', () => {
    toggleMainWindow();
  });
}

function setupIpcHandlers() {
  // Select folder dialog
  ipcMain.handle('select-folder', async (event) => {
    try {
      const senderWin = event ? BrowserWindow.fromWebContents(event.sender) : null;
      const targetWindow = senderWin || mainWindow;
      const result = await dialog.showOpenDialog(targetWindow, {
        properties: ['openDirectory']
      });
      if (!result || result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return null;
      }
      return result.filePaths[0];
    } catch (err) {
      log.error('select-folder error:', err);
      return null;
    }
  });

  // Default downloads path
  ipcMain.handle('get-default-path', () => {
    return path.join(app.getPath('downloads'), 'Ledo Downloader');
  });

  // Auto-launch startup settings
  ipcMain.handle('get-auto-launch', () => {
    try {
      const loginSettings = app.getLoginItemSettings();
      return {
        available: true,
        enabled: !!loginSettings.openAtLogin
      };
    } catch (e) {
      log.error('get-auto-launch error:', e);
      return { available: false, enabled: false };
    }
  });

  ipcMain.handle('set-auto-launch', (_event, enabled) => {
    try {
      if (!app.isPackaged) return { available: false, enabled: false };
      applyAutoLaunch(!!enabled);
      return { available: true, enabled: !!app.getLoginItemSettings().openAtLogin };
    } catch (e) {
      log.error('set-auto-launch error:', e);
      return { available: false, enabled: false };
    }
  });

  ipcMain.handle('set-close-to-tray', (_event, enabled) => {
    try {
      store.set('closeToTray', !!enabled);
      return { success: true, enabled: !!store.get('closeToTray', true) };
    } catch (e) {
      log.error('set-close-to-tray error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('ensure-backend-ready', async () => ({ success: await ensureBackendStarted() }));

  // Smart clipboard control
  ipcMain.on('set-smart-clipboard', (_event, enabled) => {
    smartClipboardEnabled = !!enabled;
    log.info(`Smart clipboard monitor set to: ${smartClipboardEnabled}`);
  });
  ipcMain.on('smart-paste-dismissed', () => {
    smartPastePromptPending = false;
  });

  // Open Extension Folder
  ipcMain.handle('open-extension-folder', async () => {
    try {
      const extPath = app.isPackaged
        ? path.join(process.resourcesPath, 'browser_extension')
        : path.join(__dirname, 'browser_extension');
      if (fs.existsSync(extPath)) {
        const error = await shell.openPath(extPath);
        return { success: !error, error: error || null };
      }
      return { success: false, error: `Extension folder not found: ${extPath}` };
    } catch (e) {
      log.error('open-extension-folder error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('get-extension-package-status', () => {
    try {
      const extPath = app.isPackaged
        ? path.join(process.resourcesPath, 'browser_extension')
        : path.join(__dirname, 'browser_extension');
      const manifestPath = path.join(extPath, 'manifest.json');
      if (!fs.existsSync(manifestPath)) {
        return { available: false, error: 'ملف تعريف الإضافة غير موجود.' };
      }
      const manifest = fs.readJsonSync(manifestPath);
      const declaredFiles = [
        manifest.background?.service_worker,
        manifest.action?.default_popup,
        ...(manifest.content_scripts || []).flatMap(script => script.js || []),
        ...Object.values(manifest.icons || {})
      ].filter(Boolean);
      const requiredFiles = declaredFiles.map(file => path.join(extPath, file));
      const missingFiles = requiredFiles.filter(file => !fs.existsSync(file));
      if (missingFiles.length) {
        return { available: false, error: 'بعض ملفات الإضافة ناقصة.' };
      }
      return { available: true, name: manifest.name, version: manifest.version, path: extPath };
    } catch (e) {
      log.error('get-extension-package-status error:', e);
      return { available: false, error: e.message };
    }
  });

  ipcMain.handle('open-extension-setup', async () => {
    try {
      const extPath = app.isPackaged
        ? path.join(process.resourcesPath, 'browser_extension')
        : path.join(__dirname, 'browser_extension');
      if (!fs.existsSync(extPath)) {
        return { success: false, error: `Extension folder not found: ${extPath}` };
      }

      const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
        .filter(Boolean);
      const browsers = [
        ...roots.map(root => ({
          name: 'Chrome',
          path: path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')
        })),
        ...roots.map(root => ({
          name: 'Edge',
          path: path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
        }))
      ];
      const browser = browsers.find(candidate => fs.existsSync(candidate.path));
      if (!browser) return { success: false, error: 'لم يتم العثور على Chrome أو Edge.' };

      const child = spawn(browser.path, ['chrome://extensions'], { detached: true, stdio: 'ignore' });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();
      const folderError = await shell.openPath(extPath);
      if (folderError) return { success: false, error: folderError };
      return { success: true, browser: browser.name, extensionPath: extPath };
    } catch (e) {
      log.error('open-extension-setup error:', e);
      return { success: false, error: e.message };
    }
  });

  // App Version
  ipcMain.handle('get-app-version', () => {
    return app.getVersion();
  });

  // Manual Update Check (from renderer settings button)
  ipcMain.handle('manual-check-update', async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      return { success: true, version: result?.updateInfo?.version };
    } catch (err) {
      log.error('Manual check update error:', err);
      return { success: false, error: err.message };
    }
  });

  // Install downloaded update
  ipcMain.on('install-update', () => {
    log.info('User requested update install. Quitting and installing...');
    isQuiting = true;
    autoUpdater.quitAndInstall(false, true);
  });

  // Open External Links
  ipcMain.handle('open-external', async (_event, url) => {
    try {
      if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
        await shell.openExternal(url);
        return true;
      }
    } catch (e) {
      log.error('open-external error:', e);
    }
    return false;
  });

  // System Stats for hardware monitoring dashboard
  ipcMain.handle('get-system-stats', () => {
    try {
      const cpus = os.cpus() || [];
      let idle = 0;
      let total = 0;
      for (let i = 0, len = cpus.length; i < len; i++) {
        const cpu = cpus[i];
        const lastCpu = (lastCpuInfo && lastCpuInfo[i]) || cpu;
        if (cpu && cpu.times && lastCpu && lastCpu.times) {
          for (let type in cpu.times) {
            total += (cpu.times[type] || 0) - (lastCpu.times[type] || 0);
          }
          idle += (cpu.times.idle || 0) - (lastCpu.times.idle || 0);
        }
      }
      const cpuUsage = total <= 0 ? 0 : Math.min(100, Math.max(0, 100 - ~~(100 * idle / total)));
      lastCpuInfo = cpus;

      const totalMem = os.totalmem() || 1;
      const freeMem = os.freemem() || 0;
      const memUsage = Math.min(100, Math.max(0, 100 - ~~(100 * freeMem / totalMem)));

      return {
        cpu: cpuUsage,
        ram: memUsage,
        totalRam: totalMem,
        freeRam: freeMem
      };
    } catch (err) {
      log.error('get-system-stats error:', err);
      return {
        cpu: 0,
        ram: 0,
        totalRam: os.totalmem() || 0,
        freeRam: os.freemem() || 0
      };
    }
  });

  // Path opening helpers
  ipcMain.handle('open-path', async (_event, folderPath) => {
    try {
      if (folderPath && fs.existsSync(folderPath)) {
        await shell.openPath(folderPath);
        return true;
      }
    } catch (e) {
      log.error('open-path error:', e);
    }
    return false;
  });

  ipcMain.handle('show-item-in-folder', async (_event, filePath) => {
    try {
      if (filePath && fs.existsSync(filePath)) {
        shell.showItemInFolder(filePath);
        return true;
      }
    } catch (e) {
      log.error('show-item-in-folder error:', e);
    }
    return false;
  });

  // Notifications
  ipcMain.on('show-notification', (_event, title, body) => {
    try {
      const { Notification } = require('electron');
      if (Notification.isSupported()) {
        new Notification({
          title: title || 'Ledo Downloader',
          body: body || '',
          icon: path.join(__dirname, 'frontend', 'icon.ico')
        }).show();
      }
    } catch (e) {
      log.error('Notification error:', e);
    }
  });

  // Main window focus request
  ipcMain.on('show-main-window', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.setSkipTaskbar(false);
      mainWindow.focus();
    }
  });

  // Window Controls (minimize, maximize, close)
  ipcMain.on('window-control', (event, action) => {
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    if (!win) return;

    if (action === 'minimize') {
      win.minimize();
    } else if (action === 'maximize') {
      if (win.isMaximized()) {
        win.unmaximize();
      } else {
        win.maximize();
      }
    } else if (action === 'close') {
      if (win === mainWindow) {
        if (!isQuiting) {
          if (store.get('closeToTray', true)) {
            mainWindow.hide();
            mainWindow.setSkipTaskbar(true);
            notifyTrayMinimized();
          } else {
            isQuiting = true;
            app.quit();
          }
        } else {
          mainWindow.close();
        }
      } else if (win === quickAddWindow) {
        quickAddWindow.hide();
      } else {
        win.close();
      }
    }
  });

  // Quick Add IPC
  ipcMain.on('show-quick-add', (_event, payload) => {
    ensureBackendStarted();
    if (!quickAddWindow || quickAddWindow.isDestroyed()) {
      createQuickAddWindow();
    }

    const sendPayload = () => {
      quickAddWindow.webContents.executeJavaScript(`
        if (typeof window.updateQuickAddInfo === 'function') {
          window.updateQuickAddInfo(${JSON.stringify(payload || {})});
        } else {
          window.tempMetadata = ${JSON.stringify(payload || {})};
        }
      `).catch(e => log.error('Failed to update quick add info:', e));
    };

    if (quickAddWindow.webContents.isLoading()) {
      quickAddWindow.webContents.once('did-finish-load', sendPayload);
    } else {
      sendPayload();
    }

    quickAddWindow.show();
    quickAddWindow.focus();
  });

  ipcMain.on('hide-quick-add', () => {
    if (quickAddWindow && !quickAddWindow.isDestroyed()) {
      quickAddWindow.hide();
    }
  });

  // Mini Progress IPC
  ipcMain.on('mini-progress-action', (_event, action) => {
    if (!miniProgressWindow || miniProgressWindow.isDestroyed()) {
      createMiniProgressWindow();
    }
    if (action === 'show') {
      const doShow = () => {
        if (!miniProgressWindow || miniProgressWindow.isDestroyed()) return;
        const { screen } = require('electron');
        const primaryDisplay = screen.getPrimaryDisplay();
        const { width, height } = primaryDisplay.workAreaSize;
        const bounds = miniProgressWindow.getBounds();

        const x = width - bounds.width - 24;
        const y = height - bounds.height - 24;

        miniProgressWindow.setPosition(x, y);
        miniProgressWindow.setAlwaysOnTop(true, 'screen-saver');
        miniProgressWindow.showInactive();
      };

      if (miniProgressWindow.webContents.isLoading()) {
        miniProgressWindow.webContents.once('did-finish-load', doShow);
      } else {
        doShow();
      }
    } else if (action === 'hide') {
      if (miniProgressWindow && !miniProgressWindow.isDestroyed()) {
        miniProgressWindow.hide();
      }
    }
  });

  ipcMain.on('mini-progress-resize', (_event, targetHeight) => {
    if (!miniProgressWindow || miniProgressWindow.isDestroyed()) return;
    const bounds = miniProgressWindow.getBounds();
    const { screen } = require('electron');
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;

    const newY = Math.max(10, height - targetHeight - 24);
    miniProgressWindow.setBounds({
      x: bounds.x || (width - bounds.width - 24),
      y: newY,
      width: bounds.width || 350,
      height: targetHeight
    });
  });
}

app.whenReady().then(async () => {
  // Run integrity check before proceeding
  if (!checkIntegrity()) {
    app.quit();
    return;
  }

  // Ensure IPC handlers are registered before anything else might fail
  setupIpcHandlers();

  const loginSettings = app.getLoginItemSettings();
  launchedAtLogin = process.argv.includes('--hidden') || process.argv.includes('-hidden') || loginSettings.wasOpenedAtLogin;
  // The mini progress window is created on demand when the first download starts.
  
  const checkForUpdates = () => {
    try {
      // فحص وتنزيل التحديثات تلقائيا إذا توفرت
      autoUpdater.checkForUpdatesAndNotify();
    } catch (err) {
      log.warn('Auto updater error:', err);
    }
  };
  if (launchedAtLogin) updaterStartupTimer = setTimeout(checkForUpdates, 30000);
  else checkForUpdates();

  // ── Auto-Updater Events → Renderer ──────────────────────────────────────
  autoUpdater.on('checking-for-update', () => {
    log.info('Checking for update...');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-status', { status: 'checking' });
    }
  });

  autoUpdater.on('update-available', (info) => {
    log.info('Update available:', info.version);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-status', {
        status: 'available',
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: info.releaseNotes
      });
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    log.info('Update not available. Current is latest.');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-status', {
        status: 'not-available',
        version: info.version
      });
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    log.info(`Update download: ${progress.percent.toFixed(1)}% @ ${(progress.bytesPerSecond / 1024).toFixed(0)} KB/s`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-status', {
        status: 'downloading',
        percent: progress.percent,
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info('Update downloaded:', info.version);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-status', {
        status: 'downloaded',
        version: info.version,
        releaseNotes: info.releaseNotes
      });
    }
  });

  autoUpdater.on('error', (err) => {
    log.error('Auto-updater error:', err);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-status', {
        status: 'error',
        message: err.message || 'Unknown error'
      });
    }
  });

  setupTray();

  createWindow();
  if (launchedAtLogin) {
    // Keep Windows login startup lightweight: don't load the hidden renderer or
    // import the Python engine until the user opens Ledo, then warm it shortly after login.
    backendStartTimer = setTimeout(ensureBackendStarted, 12000);
  } else {
    ensureBackendStarted();
  }

  // Windows are created lazily on demand to save memory

  // Register Global Shortcut
  const shortcutRegistered = globalShortcut.register('CommandOrControl+Space', () => {
    ensureBackendStarted();
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
  
  if (!shortcutRegistered) {
    log.error('Failed to register global shortcut CommandOrControl+Space');
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Clipboard Monitor (Smart Paste)
  clipboardInterval = setInterval(() => {
    if (!smartClipboardEnabled) return;
    const text = clipboard.readText();
    if (text !== lastClipboard && (text.includes('tiktok.com') || text.includes('youtube.com') || text.includes('instagram.com') || text.includes('fb.watch') || text.includes('x.com') || text.includes('spotify.com'))) {
        lastClipboard = text;
        if (smartPastePromptPending || !mainWindow || mainWindow.isDestroyed()) return;
        smartPastePromptPending = true;
        if (mainWindow.isMinimized()) mainWindow.restore();
        if (!mainWindow.isVisible()) mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send('smart-paste-detected', text);
    }
  }, 2000);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (backendStartTimer) {
    clearTimeout(backendStartTimer);
    backendStartTimer = null;
  }
  if (updaterStartupTimer) {
    clearTimeout(updaterStartupTimer);
    updaterStartupTimer = null;
  }
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
