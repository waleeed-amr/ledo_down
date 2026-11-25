const { app, BrowserWindow, ipcMain, Tray, Menu, clipboard, dialog, session, globalShortcut, shell, safeStorage, powerSaveBlocker } = require('electron');
const path = require('path');
const { spawn, execFile } = require('child_process');
const WebSocket = require('ws');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const fs = require('fs-extra'); // 1. fs-extra: للتعامل المتقدم والآمن مع الملفات
const https = require('https');
const crypto = require('crypto');
const log = require('electron-log'); // 2. electron-log: لتسجيل الأحداث واكتشاف الأخطاء
const Store = require('electron-store'); // 3. electron-store: لحفظ الإعدادات
const { autoUpdater } = require('electron-updater'); // 4. electron-updater: للتحديث التلقائي
const contextMenu = require('electron-context-menu'); // 5. electron-context-menu: لقائمة الزر الأيمن
const os = require('os');
const axios = require('axios');
const FormData = require('form-data');
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
const localWsToken = store.get('localWsToken') || crypto.randomBytes(32).toString('hex');
if (!store.get('localWsToken')) store.set('localWsToken', localWsToken);

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
let engineSitePackagesAtStartup = '';
let tray = null;
let isQuiting = false;
let engineRepairScriptPath = '';
let mainPageLoaded = false;
let updaterStartupTimer = null;
let backendMonitorStarted = false;
let backendReadyPromise = null;
let quickAddSocket = null;
let quickAddSocketReconnectTimer = null;
let quickAddSocketReconnectDelay = 1000;
let quickAddShortcutLabel = 'Ctrl+Space';
let launchedAtLogin = false;
let clipboardInterval = null;
let lastClipboard = '';
let smartClipboardEnabled = true;
let smartPastePromptPending = false;
let lastCpuInfo = os.cpus();
let telegramPollTimer = null;
let telegramPollActive = false;
let telegramSending = false;
const telegramSendQueue = new Map();
const telegramSendingIds = new Set();
let telegramPowerSaveBlockerId = null;
let telegramPollRequestedAt = 0;
const mediaJobs = new Map();
const mediaOutputReservations = new Set();
const mediaWaveformJobs = new Map();
const DEFAULT_TELEGRAM_ADMIN_SETTINGS = Object.freeze({
  enabled: true,
  allowVideo: true,
  allowAudio: true,
  allowDirectFiles: true,
  allowMultipleLinks: true,
  maxLinks: 5,
  maxFileSizeMB: 50,
  pollIntervalSeconds: 3,
  videoQualities: ['best', '1080p', '720p', '480p', '360p'],
  audioFormats: ['audio-mp3', 'audio-m4a'],
  welcomeMessage: '',
  helpMessage: ''
});

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

  // Restore last window position/size from previous session
  if (!isStartup) {
    const savedBounds = store.get('windowBounds', null);
    if (savedBounds && typeof savedBounds === 'object') {
      try {
        const { screen } = require('electron');
        const displays = screen.getAllDisplays();
        const fits = displays.some(d => {
          const { x, y, width, height } = d.workArea;
          return savedBounds.x >= x - 10 && savedBounds.y >= y - 10 &&
                 savedBounds.x + savedBounds.width <= x + width + 10 &&
                 savedBounds.y + savedBounds.height <= y + height + 10;
        });
        if (fits && savedBounds.width >= 800 && savedBounds.height >= 500) {
          mainWindow.setBounds({
            x: Math.round(savedBounds.x),
            y: Math.round(savedBounds.y),
            width: Math.round(savedBounds.width),
            height: Math.round(savedBounds.height)
          });
        }
      } catch (_) {}
    }
  }

  // Save window bounds on resize/move (debounced)
  let _saveBoundsTimer = null;
  const saveBounds = () => {
    if (_saveBoundsTimer) clearTimeout(_saveBoundsTimer);
    _saveBoundsTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMaximized() && !mainWindow.isMinimized()) {
        store.set('windowBounds', mainWindow.getBounds());
      }
    }, 500);
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

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

  mainWindow.on('maximize', () => {
    try { mainWindow.webContents.send('window-maximized-change', true); } catch (_) {}
  });
  mainWindow.on('unmaximize', () => {
    try { mainWindow.webContents.send('window-maximized-change', false); } catch (_) {}
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

async function startPythonBackend() {
  const engineUpdateDir = path.join(app.getPath('userData'), 'engine-updates');
  const activeEngineManifest = path.join(engineUpdateDir, 'active.json');
  let stagedSitePackages = '';
  try {
    const manifest = fs.readJsonSync(activeEngineManifest);
    const candidateNames = [
      manifest.sitePackages?.directory,
      manifest.previousSitePackages?.directory
    ];
    for (const directoryName of candidateNames) {
      if (!directoryName || path.basename(directoryName) !== directoryName) continue;
      const candidate = path.join(engineUpdateDir, directoryName);
      if (!fs.existsSync(candidate)) continue;
      try {
        // Validate the full startup import graph before letting an external
        // package overlay shadow the bundled dependencies. A damaged ACL or
        // unreadable module falls back to the previous overlay, then bundled.
        await validateEngineUpdateOverlay(candidate);
        stagedSitePackages = candidate;
        break;
      } catch (error) {
        log.error(`Ignoring unreadable engine package overlay (${directoryName}); trying the next fallback.`, error);
      }
    }
  } catch (_) {}
  engineSitePackagesAtStartup = stagedSitePackages;
  const backendEnv = {
    ...process.env,
    LEDO_ENGINE_UPDATE_DIR: engineUpdateDir,
    LEDO_ENGINE_SITE_PACKAGES: stagedSitePackages,
    LEDO_WS_TOKEN: localWsToken
  };
  if (app.isPackaged) {
    const backendPath = path.join(process.resourcesPath, 'backend', 'dist', 'main.exe');
    pythonProcess = spawn(backendPath, [], { 
        cwd: path.dirname(backendPath),
        env: backendEnv,
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
        env: backendEnv,
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
  if (backendMonitorStarted) return backendReadyPromise || Promise.resolve(false);
  backendMonitorStarted = true;
  const healthUrl = 'http://127.0.0.1:8000/api/health';
  backendReadyPromise = (async () => {
    // Reuse an already-running local engine instead of launching another copy.
    if (!(await isBackendReady(healthUrl, 700))) {
      await startPythonBackend();
      if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.webContents.send('backend-startup-progress', { status: 'starting' }); } catch (_) {}
      }
    }
    await waitForBackend(healthUrl, 60000);
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('backend-startup-progress', { status: 'ready' }); } catch (_) {}
    }
    return true;
  })()
    .then(() => {
      log.info('Local download backend is ready.');
      connectQuickAddSocket();
      startTelegramPolling();
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

function getTelegramToken() {
  const encrypted = store.get('telegramTokenEncrypted', '');
  if (!encrypted || !safeStorage.isEncryptionAvailable()) return '';
  try { return safeStorage.decryptString(Buffer.from(encrypted, 'base64')); }
  catch (error) { log.warn('Could not decrypt Telegram bot token:', error.message); return ''; }
}

function getTelegramAdminSettings() {
  const saved = store.get('telegramAdminSettings', {});
  const videoQualities = Array.isArray(saved.videoQualities)
    ? saved.videoQualities.filter(value => DEFAULT_TELEGRAM_ADMIN_SETTINGS.videoQualities.includes(value))
    : DEFAULT_TELEGRAM_ADMIN_SETTINGS.videoQualities;
  const audioFormats = Array.isArray(saved.audioFormats)
    ? saved.audioFormats.filter(value => DEFAULT_TELEGRAM_ADMIN_SETTINGS.audioFormats.includes(value))
    : DEFAULT_TELEGRAM_ADMIN_SETTINGS.audioFormats;
  return {
    ...DEFAULT_TELEGRAM_ADMIN_SETTINGS,
    ...saved,
    enabled: saved.enabled !== false,
    allowVideo: saved.allowVideo !== false,
    allowAudio: saved.allowAudio !== false,
    allowDirectFiles: saved.allowDirectFiles !== false,
    allowMultipleLinks: saved.allowMultipleLinks !== false,
    maxLinks: Math.max(1, Math.min(5, Number(saved.maxLinks) || 5)),
    maxFileSizeMB: [10, 20, 50].includes(Number(saved.maxFileSizeMB)) ? Number(saved.maxFileSizeMB) : 50,
    pollIntervalSeconds: Math.max(1, Math.min(10, Number(saved.pollIntervalSeconds) || 3)),
    videoQualities,
    audioFormats,
    welcomeMessage: String(saved.welcomeMessage || '').slice(0, 1000),
    helpMessage: String(saved.helpMessage || '').slice(0, 3000)
  };
}

function normalizeTelegramAdminSettings(input = {}) {
  const previous = getTelegramAdminSettings();
  const settings = { ...previous };
  for (const key of ['enabled', 'allowVideo', 'allowAudio', 'allowDirectFiles', 'allowMultipleLinks']) {
    if (typeof input[key] === 'boolean') settings[key] = input[key];
  }
  if (Number.isFinite(Number(input.maxLinks))) settings.maxLinks = Math.max(1, Math.min(5, Math.round(Number(input.maxLinks))));
  if ([10, 20, 50].includes(Number(input.maxFileSizeMB))) settings.maxFileSizeMB = Number(input.maxFileSizeMB);
  if (Number.isFinite(Number(input.pollIntervalSeconds))) settings.pollIntervalSeconds = Math.max(1, Math.min(10, Math.round(Number(input.pollIntervalSeconds))));
  if (Array.isArray(input.videoQualities)) settings.videoQualities = input.videoQualities.filter(value => DEFAULT_TELEGRAM_ADMIN_SETTINGS.videoQualities.includes(value));
  if (Array.isArray(input.audioFormats)) settings.audioFormats = input.audioFormats.filter(value => DEFAULT_TELEGRAM_ADMIN_SETTINGS.audioFormats.includes(value));
  if (typeof input.welcomeMessage === 'string') settings.welcomeMessage = input.welcomeMessage.slice(0, 1000);
  if (typeof input.helpMessage === 'string') settings.helpMessage = input.helpMessage.slice(0, 3000);
  return settings;
}

function telegramApi(token, method) {
  return `https://api.telegram.org/bot${token}/${method}`;
}

function telegramErrorText(error, context = 'general') {
  const status = Number(error?.response?.status || error?.response?.data?.error_code || 0);
  const raw = String(error?.response?.data?.description || error?.response?.data?.detail || error?.message || '');
  if (/[\u0600-\u06FF]/.test(raw)) return raw;
  if (status === 401 || /unauthorized|invalid token/i.test(raw)) return 'التوكن غير صحيح أو تم إلغاؤه. راجعه في BotFather ثم أعد الربط.';
  if (status === 403 || /chat not found|bot was blocked|bot can't initiate/i.test(raw)) return 'تعذر إرسال الرسالة للمحادثة. افتح البوت واضغط Start ثم حاول مرة أخرى.';
  if (status === 429) return 'تيليجرام طلب الانتظار قليلًا. سيحاول التطبيق مرة أخرى تلقائيًا.';
  if (/50\s?mb|file is too big|request entity too large|413/i.test(raw) || status === 413) return 'حجم الملف أكبر من الحد المسموح لإرساله عبر البوت.';
  if (/ECONNREFUSED|127\.0\.0\.1|ECONNABORTED|timeout/i.test(raw)) return 'محرك التنزيل غير جاهز أو الاتصال انتهت مهلته. افتح التطبيق وحاول مرة أخرى.';
  if (context === 'download') return 'تعذر بدء تنزيل الرابط. تأكد من صحة الرابط وإمكانية الوصول إليه ثم حاول مرة أخرى.';
  if (context === 'upload') return 'تعذر إرسال الملف الآن. سيحاول التطبيق مرة أخرى عند عودة الاتصال.';
  return 'حصلت مشكلة في الاتصال بتيليجرام. حاول مرة أخرى.';
}

async function sendTelegramMessage(token, chatId, text) {
  const response = await axios.post(telegramApi(token, 'sendMessage'), { chat_id: chatId, text }, { timeout: 20000 });
  if (!response.data?.ok) throw new Error(telegramErrorText({ response: { data: response.data } }));
  return response.data.result;
}

async function startTelegramDownload(token, chatId, url, quality, requestId, downloadOptions = {}) {
  const target = new URL(downloadOptions.url || url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new Error('أرسل رابطًا عامًا يبدأ بـ http أو https.');
  }
  const tempFolder = path.join(app.getPath('temp'), 'LedoDownloaderBotRelay', `${requestId}-${crypto.randomUUID()}`);
  try {
    const response = await axios.post('http://127.0.0.1:8000/api/download', {
      url: target.toString(),
      save_path: tempFolder,
      is_yt_dlp: downloadOptions.isYtDlp !== false,
      quality,
      source: 'telegram',
      title: downloadOptions.title || target.hostname
    }, { timeout: 30000 });
    if (response.data?.status !== 'started' || !response.data?.id) {
      throw new Error(telegramErrorText({ response: { data: response.data } }, 'download'));
    }
    const pending = store.get('telegramPendingDownloads', {});
    pending[response.data.id] = {
      chatId: String(chatId), tempFolder, quality, createdAt: Date.now(),
      progressMessageId: downloadOptions.progressMessageId || null,
      title: downloadOptions.title || target.hostname,
      performer: downloadOptions.performer || '',
      lastProgressAt: 0,
      lastProgressValue: -1
    };
    store.set('telegramPendingDownloads', pending);
    updateTelegramPowerSaveBlocker();
    return response.data.id;
  } catch (error) {
    await fs.remove(tempFolder).catch(() => {});
    throw error;
  }
}

function formatTelegramBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return 'حجم غير محدد';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const size = bytes / (1024 ** unitIndex);
  return `${size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`;
}

function formatTelegramDuration(value) {
  const totalSeconds = Math.floor(Number(value));
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '';
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

async function fetchTelegramMediaInfo(url) {
  const response = await axios.post('http://127.0.0.1:8000/api/info', { url }, { timeout: 60000 });
  const data = response.data || {};
  if (data.status !== 'success') throw new Error(data.message || 'تعذر جلب معلومات الرابط.');
  return data.download_info || data;
}

function telegramChoiceKeyboard(requestId, choices, stage = 'quality') {
  return {
    inline_keyboard: choices.map(([label, value]) => [{ text: label, callback_data: `ld:${stage}:${requestId}:${value}` }])
  };
}

async function createTelegramMediaChoice(token, chatId, items, progressMessageId = null, leadingSummary = '') {
  const requestId = crypto.randomBytes(5).toString('hex');
  const requests = store.get('telegramChoiceRequests', {});
  const now = Date.now();
  for (const [id, request] of Object.entries(requests)) {
    if (Number(request.expiresAt) <= now || request.stage === 'starting') delete requests[id];
  }
  requests[requestId] = { chatId: String(chatId), items, stage: 'media', createdAt: now, expiresAt: now + 30 * 60 * 1000 };
  store.set('telegramChoiceRequests', requests);
  const adminSettings = getTelegramAdminSettings();
  const rows = [];
  if (adminSettings.allowVideo && adminSettings.videoQualities.length) rows.push([{ text: '🎬 فيديو', callback_data: `ld:media:${requestId}:video` }]);
  if (adminSettings.allowAudio && adminSettings.audioFormats.length) rows.push([{ text: '🎵 صوت', callback_data: `ld:media:${requestId}:audio` }]);
  rows.push([{ text: 'إلغاء', callback_data: `ld:cancel:${requestId}:cancel` }]);
  const first = items[0] || {};
  const sizes = first.sizes || {};
  const details = items.length === 1
    ? [`🎞 ${first.title || 'وسائط من الرابط'}`, first.duration ? `⏱ المدة: ${formatTelegramDuration(first.duration)}` : '', first.uploader ? `👤 ${first.uploader}` : '', sizes.best || sizes['1080p'] ? `📦 تقدير الحجم: أفضل جودة ${formatTelegramBytes(sizes.best || sizes['1080p'])} · صوت ${formatTelegramBytes(sizes.audio)}` : '']
      .filter(Boolean).join('\n')
    : `📋 ${items.slice(0, 5).map((item, index) => `${index + 1}. ${String(item.title || new URL(item.url).hostname).slice(0, 65)}${item.duration ? ` · ${formatTelegramDuration(item.duration)}` : ''}`).join('\n')}`;
  const body = {
    text: `${leadingSummary ? `${leadingSummary}\n\n` : ''}✨ تفاصيل الرابط\n${details}\n\n${items.length === 1 ? 'اختار نوع الملف للمتابعة:' : `وجدت ${items.length} وسائط. اختيار واحد سيُطبّق عليهم كلهم. اختار النوع للمتابعة:`}`,
    reply_markup: { inline_keyboard: rows }
  };
  const response = progressMessageId
    ? await axios.post(telegramApi(token, 'editMessageText'), { ...body, chat_id: chatId, message_id: progressMessageId }, { timeout: 20000 })
    : await axios.post(telegramApi(token, 'sendMessage'), { ...body, chat_id: chatId }, { timeout: 20000 });
  if (!response.data?.ok) throw new Error(telegramErrorText({ response: { data: response.data } }));
}

async function answerTelegramCallback(token, callbackId, text = '') {
  const body = { callback_query_id: callbackId };
  if (text) body.text = text;
  await axios.post(telegramApi(token, 'answerCallbackQuery'), body, { timeout: 15000 });
}

async function editTelegramCallbackMessage(token, callback, text, keyboard) {
  await axios.post(telegramApi(token, 'editMessageText'), {
    chat_id: callback.message.chat.id,
    message_id: callback.message.message_id,
    text,
    reply_markup: keyboard || { inline_keyboard: [] }
  }, { timeout: 20000 });
}

async function handleTelegramCallback(token, callback) {
  const callbackChatId = String(callback?.message?.chat?.id || '');
  const parts = String(callback?.data || '').match(/^ld:(media|quality|cancel|control):([a-f0-9]{10}):([a-z0-9-]+)$/i);
  if (!parts || !callbackChatId || callback?.message?.chat?.type !== 'private') {
    await answerTelegramCallback(token, callback.id, 'الزر غير صالح أو انتهت صلاحيته. أرسل الرابط مرة أخرى.');
    return;
  }

  const [, stage, requestId, choice] = parts;
  const adminSettings = getTelegramAdminSettings();
  if (!adminSettings.enabled) {
    await answerTelegramCallback(token, callback.id, 'البوت متوقف مؤقتًا من إعدادات الإدارة.');
    return;
  }
  if (stage === 'control') {
    const controlRequests = store.get('telegramControlRequests', {});
    const controlRequest = controlRequests[requestId];
    if (!controlRequest || controlRequest.chatId !== callbackChatId || Number(controlRequest.expiresAt) <= Date.now()) {
      delete controlRequests[requestId];
      store.set('telegramControlRequests', controlRequests);
      await answerTelegramCallback(token, callback.id, 'انتهت صلاحية الزر. أرسل /status من جديد.');
      return;
    }
    if (!['pause', 'resume', 'cancel'].includes(choice)) {
      await answerTelegramCallback(token, callback.id, 'هذا الأمر غير متاح.');
      return;
    }
    delete controlRequests[requestId];
    store.set('telegramControlRequests', controlRequests);
    await answerTelegramCallback(token, callback.id, '⏳ جاري تنفيذ الأمر…');
    await controlTelegramDownload(token, callbackChatId, choice, controlRequest.downloadId);
    return;
  }
  const requests = store.get('telegramChoiceRequests', {});
  const request = requests[requestId];
  if (!request || request.chatId !== callbackChatId || Number(request.expiresAt) <= Date.now()) {
    delete requests[requestId];
    store.set('telegramChoiceRequests', requests);
    await answerTelegramCallback(token, callback.id, 'انتهت صلاحية الاختيار. أرسل الرابط من جديد.');
    return;
  }

  if (stage === 'cancel' && choice === 'cancel') {
    delete requests[requestId];
    store.set('telegramChoiceRequests', requests);
    await answerTelegramCallback(token, callback.id, 'تم إلغاء الاختيار');
    await editTelegramCallbackMessage(token, callback, 'تم الإلغاء. ابعت الرابط وقت ما تحب نبدأ من جديد.');
    return;
  }

  if (stage === 'media' && request.stage === 'media' && ['video', 'audio'].includes(choice)) {
    if ((choice === 'video' && (!adminSettings.allowVideo || !adminSettings.videoQualities.length)) ||
        (choice === 'audio' && (!adminSettings.allowAudio || !adminSettings.audioFormats.length))) {
      await answerTelegramCallback(token, callback.id, 'هذا النوع غير متاح حاليًا.');
      return;
    }
    request.mode = choice;
    request.stage = 'quality';
    store.set('telegramChoiceRequests', requests);
    await answerTelegramCallback(token, callback.id);
    const sizes = request.items[0]?.sizes || {};
    const qualityLabel = quality => sizes[quality] ? ` · ~${formatTelegramBytes(sizes[quality])}` : '';
    const qualityChoices = [['🏆 أفضل جودة', 'best'], ['1080p', '1080p'], ['720p', '720p'], ['480p', '480p'], ['360p', '360p']];
    const audioChoices = [['🎧 MP3 — 192 kbps', 'audio-mp3'], ['🎼 M4A — أعلى جودة متاحة', 'audio-m4a']];
    const choices = (choice === 'video'
      ? qualityChoices.filter(([, value]) => adminSettings.videoQualities.includes(value))
      : audioChoices.filter(([, value]) => adminSettings.audioFormats.includes(value)))
      .map(([label, value]) => [`${label}${qualityLabel(value === 'audio-mp3' || value === 'audio-m4a' ? 'audio' : value)}`, value]);
    const keyboard = telegramChoiceKeyboard(requestId, choices);
    keyboard.inline_keyboard.push([{ text: 'إلغاء', callback_data: `ld:cancel:${requestId}:cancel` }]);
    await editTelegramCallbackMessage(token, callback,
      choice === 'video' ? '🎬 اختر جودة الفيديو:' : '🎵 اختر صيغة الصوت:',
      keyboard);
    return;
  }

  const validQuality = request.mode === 'video'
    ? adminSettings.allowVideo && adminSettings.videoQualities.includes(choice)
    : request.mode === 'audio' && adminSettings.allowAudio && adminSettings.audioFormats.includes(choice);
  if (stage !== 'quality' || request.stage !== 'quality' || !validQuality) {
    await answerTelegramCallback(token, callback.id, 'هذا الاختيار لم يعد متاحًا. أرسل الرابط مرة أخرى.');
    return;
  }

  const quality = choice === 'audio-mp3' ? 'audio' : choice === 'audio-m4a' ? 'audio-m4a' : choice;
  request.stage = 'starting';
  store.set('telegramChoiceRequests', requests);
  await answerTelegramCallback(token, callback.id, '⏳ بدأت تجهيز التنزيلات');
  const started = [];
  const failures = [];
  for (const item of request.items.slice(0, adminSettings.allowMultipleLinks ? adminSettings.maxLinks : 1)) {
    try {
      const id = await startTelegramDownload(token, callbackChatId, item.url, quality, requestId, {
        title: item.title || new URL(item.url).hostname,
        performer: item.uploader || '',
        progressMessageId: callback.message.message_id
      });
      started.push(id);
    } catch (error) {
      failures.push(`❌ ${String(item.title || item.url).slice(0, 120)} — ${telegramErrorText(error, 'download')}`);
    }
  }
  delete requests[requestId];
  store.set('telegramChoiceRequests', requests);
  const description = quality === 'audio' ? 'صوت MP3' : quality === 'audio-m4a' ? 'صوت M4A' : `فيديو ${quality === 'best' ? 'بأفضل جودة' : quality}`;
  const summary = [
    started.length ? `⏳ بدأ التنزيل (${description}) — ${started.length} ملف${started.length > 1 ? 'ات' : ''}.\n\nسأحدّث هذه الرسالة أثناء التنزيل، ثم أرسل الوسائط هنا عند اكتمالها. قد يستغرق تجهيز بعض الروابط دقيقة.` : 'لم يبدأ أي تنزيل، جرّب الرابط مرة أخرى.',
    ...failures
  ].join('\n');
  try { await editTelegramCallbackMessage(token, callback, summary); }
  catch (_) { await sendTelegramMessage(token, callbackChatId, summary).catch(error => log.warn('Could not send Telegram selection result:', error.message)); }
}

function getTelegramMessageLinks(message, text) {
  const links = [];
  const addLink = (value) => {
    const cleaned = String(value || '').trim().replace(/[.,!?;:]+$/g, '');
    if (!/^https?:\/\//i.test(cleaned)) return;
    try {
      const parsed = new URL(cleaned);
      if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) {
        const normalized = parsed.toString();
        if (!links.includes(normalized)) links.push(normalized);
      }
    } catch (_) {}
  };

  // Telegram can deliver clickable links as entities, including hidden text links.
  const entities = [...(message?.entities || []), ...(message?.caption_entities || [])];
  for (const entity of entities) {
    if (entity.type === 'text_link') addLink(entity.url);
    else if (entity.type === 'url') {
      const source = String(text || '');
      addLink(source.slice(entity.offset, entity.offset + entity.length));
    }
  }

  // Also accept links pasted into ordinary text, captions, or alongside a short note.
  for (const match of String(text || '').matchAll(/https?:\/\/[^\s<>"']+/gi)) addLink(match[0]);
  return links;
}

function isTelegramDirectFileUrl(url) {
  try {
    const extension = path.extname(new URL(url).pathname).toLowerCase();
    return new Set([
      '.apk', '.exe', '.msi', '.zip', '.rar', '.7z', '.tar', '.gz', '.iso', '.dmg',
      '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv',
      '.mp3', '.wav', '.flac', '.m4a', '.mp4', '.mkv', '.mov', '.webm', '.avi', '.wmv'
    ]).has(extension);
  } catch (_) { return false; }
}

function resolveTelegramPendingId(prefix, chatId) {
  const pending = store.get('telegramPendingDownloads', {});
  const normalized = String(prefix || '').toLowerCase().replace(/[^a-f0-9]/g, '');
  const ownedIds = Object.entries(pending)
    .filter(([, entry]) => String(entry.chatId || '') === String(chatId || ''))
    .map(([id]) => id);
  if (!normalized) {
    return ownedIds.length === 1 ? ownedIds[0] : null;
  }
  if (normalized.length < 6) return null;
  const matches = ownedIds.filter(id => id.toLowerCase().replace(/-/g, '').startsWith(normalized));
  return matches.length === 1 ? matches[0] : null;
}

async function controlTelegramDownload(token, chatId, action, idPrefix) {
  const id = resolveTelegramPendingId(idPrefix, chatId);
  if (!id) {
    await sendTelegramMessage(token, chatId, 'اكتب أول 6 حروف على الأقل من معرّف التنزيل الظاهر في /status. لو فيه تنزيل واحد فقط، الأمر يعمل من غير معرّف.');
    return;
  }
  const pending = store.get('telegramPendingDownloads', {});
  const entry = pending[id];
  if (action === 'cancel' && telegramSendingIds.has(id)) {
    await sendTelegramMessage(token, chatId, 'الملف بدأ يُرفع إلى تيليجرام؛ انتظر الإرسال ثم أرسل رابطًا جديدًا إذا لزم.');
    return;
  }
  try {
    const response = action === 'cancel'
      ? await axios.delete(`http://127.0.0.1:8000/api/cancel/${encodeURIComponent(id)}`, { timeout: 15000 })
      : await axios.post(`http://127.0.0.1:8000/api/${action}/${encodeURIComponent(id)}`, {}, { timeout: 15000 });
    const result = response.data?.status;
    if (action === 'pause' && result === 'pausing') {
      await sendTelegramMessage(token, chatId, `⏸ أوقفت مؤقتًا: ${entry?.title || id.slice(0, 8)} (${id.slice(0, 8)}). للاستئناف أرسل /resume ${id.slice(0, 8)}`);
      return;
    }
    if (action === 'resume' && ['resumed', 'already_running'].includes(result)) {
      await sendTelegramMessage(token, chatId, `▶️ استأنفت التنزيل: ${entry?.title || id.slice(0, 8)} (${id.slice(0, 8)}).`);
      return;
    }
    if (action === 'cancel' && result === 'canceled') {
      telegramSendQueue.delete(id);
      await removeTelegramTempFiles(entry);
      delete pending[id];
      store.set('telegramPendingDownloads', pending);
      updateTelegramPowerSaveBlocker();
      await sendTelegramMessage(token, chatId, `🗑 ألغيت التنزيل: ${entry?.title || id.slice(0, 8)} (${id.slice(0, 8)}).`);
      return;
    }
    await sendTelegramMessage(token, chatId, 'لم أستطع تنفيذ الأمر؛ قد يكون التنزيل انتهى أو لم يعد موجودًا. أرسل /status للتحديث.');
  } catch (error) {
    await sendTelegramMessage(token, chatId, `تعذر تنفيذ الأمر: ${telegramErrorText(error, 'download')}`);
  }
}

async function processTelegramLinkRequest(token, chatId, acceptedLinks, totalLinks, updateId) {
  const progressResponse = await axios.post(telegramApi(token, 'sendMessage'), {
    chat_id: chatId,
    text: `🔎 جاري فحص ${acceptedLinks.length} رابط${acceptedLinks.length > 1 ? 'ات' : ''} وتجهيز الاختيارات…\n\n▱▱▱▱▱▱▱▱▱▱ 0٪`
  }, { timeout: 20000 });
  const progressMessageId = progressResponse.data?.result?.message_id;
  const mediaItems = [];
  const automaticResults = [];
  const adminSettings = getTelegramAdminSettings();
  let inspectedCount = 0;
  let lastWaitUpdate = 0;
  let waitUpdateChain = Promise.resolve();
  const checkingActionTimer = setInterval(() => sendTelegramChatAction(token, chatId, 'typing'), 4500);
  let inspections;
  try {
    inspections = await Promise.all(acceptedLinks.map(async url => {
      try { return { url, info: await fetchTelegramMediaInfo(url), error: null }; }
      catch (error) { return { url, info: null, error }; }
      finally {
        inspectedCount += 1;
        if (progressMessageId && (Date.now() - lastWaitUpdate >= 1200 || inspectedCount === acceptedLinks.length)) {
          lastWaitUpdate = Date.now();
          const percent = Math.round(inspectedCount / acceptedLinks.length * 100);
          const filled = Math.round(percent / 10);
          const bar = `${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)}`;
          const completed = inspectedCount;
          waitUpdateChain = waitUpdateChain.then(() => axios.post(telegramApi(token, 'editMessageText'), {
            chat_id: chatId, message_id: progressMessageId,
            text: `🔎 جاري فحص الروابط وتجهيز الاختيارات…\n\n${bar} ${percent}٪\nاكتمل فحص ${completed} من ${acceptedLinks.length}.`
          }, { timeout: 12000 })).catch(error => log.debug('Could not update Telegram link inspection progress:', error.message));
          await waitUpdateChain;
        }
      }
    }));
  } finally {
    clearInterval(checkingActionTimer);
  }

  for (const { url, info, error: infoError } of inspections) {
    const isDirect = info?.is_direct === true || isTelegramDirectFileUrl(info?.direct_url || url);
    if (isDirect && !adminSettings.allowDirectFiles) {
      automaticResults.push('ℹ️ تنزيل الملفات المباشرة متوقف حاليًا من إعدادات البوت.');
    } else if (isDirect) {
      try {
        await startTelegramDownload(token, chatId, url, 'best', String(updateId), {
          url: info?.direct_url || url,
          isYtDlp: false,
          title: info?.title || new URL(url).hostname,
          progressMessageId
        });
        automaticResults.push(`✅ بدأت تنزيل الملف مباشرة: ${String(info?.title || new URL(url).hostname).slice(0, 90)}`);
      } catch (error) {
        automaticResults.push(`❌ تعذر تنزيل الملف: ${telegramErrorText(error, 'download')}`);
      }
    } else if (info) {
      mediaItems.push({
        url,
        title: info.title || new URL(url).hostname,
        duration: info.duration || info.tracks?.[0]?.duration,
        uploader: info.uploader,
        sizes: info.sizes || {}
      });
    } else {
      automaticResults.push(`❌ لم أستطع جلب معلومات ${url.slice(0, 120)}: ${telegramErrorText(infoError, 'download')}`);
    }
  }

  if (mediaItems.length) {
    await createTelegramMediaChoice(token, chatId, mediaItems, progressMessageId, automaticResults.join('\n'));
  } else if (progressMessageId) {
    const summary = automaticResults.length
      ? `${automaticResults.join('\n')}\n\n📦 الملفات العادية تبدأ فورًا بدون اختيار فيديو أو صوت. سأرسلها هنا بعد الاكتمال ثم أحذف النسخة المؤقتة.`
      : 'لم أتمكن من قراءة هذا الرابط. تأكد أنه يعمل ثم أرسله مرة أخرى.';
    await axios.post(telegramApi(token, 'editMessageText'), {
      chat_id: chatId, message_id: progressMessageId, text: summary
    }, { timeout: 20000 });
  }
  if (totalLinks > acceptedLinks.length) {
    await sendTelegramMessage(token, chatId, `ملاحظة: أقدر أفحص حتى ${acceptedLinks.length} رابط${acceptedLinks.length > 1 ? 'ات' : ''} في المرة. ابعت الباقي في رسالة جديدة.`)
      .catch(error => log.warn('Could not send Telegram link limit note:', error.message));
  }
}

async function processTelegramUpdates(token) {
  const chatId = String(store.get('telegramChatId', '')).trim();
  const pairing = store.get('telegramPairing', null);
  if (!chatId && (!pairing?.code || Number(pairing.expiresAt) <= Date.now())) return;
  const offset = Number(store.get('telegramUpdateOffset', 0)) || 0;
  telegramPollRequestedAt = Date.now();
  const response = await axios.post(telegramApi(token, 'getUpdates'), {
    offset,
    timeout: getTelegramAdminSettings().pollIntervalSeconds,
    allowed_updates: ['message', 'callback_query']
  }, { timeout: 20000 });
  if (!response.data?.ok) throw new Error(response.data?.description || 'Telegram polling failed');
  const handledUpdates = new Set(store.get('telegramHandledUpdateIds', []));
  let offlineNoticeSent = false;
  for (const update of response.data.result || []) {
    if (handledUpdates.has(update.update_id)) {
      store.set('telegramUpdateOffset', update.update_id + 1);
      continue;
    }
    if (update.callback_query) {
      try {
        await handleTelegramCallback(token, update.callback_query);
      } catch (error) {
        log.warn('Telegram choice callback failed:', error.message);
        try { await answerTelegramCallback(token, update.callback_query.id, 'حصلت مشكلة بسيطة. أرسل الرابط مرة أخرى.'); }
        catch (_) {}
      }
      store.set('telegramUpdateOffset', update.update_id + 1);
      continue;
    }
    const message = update.message;
    const senderChat = message?.chat;
    const text = String(message?.text || message?.caption || '').trim();
    try {
      const pairingMatch = !chatId
        && senderChat?.type === 'private'
        && pairing?.code
        && Number(pairing.expiresAt) > Date.now()
        && text === `/start ${pairing.code}`;
      if (pairingMatch) {
        const linkedChatId = String(senderChat.id);
        store.set('telegramChatId', linkedChatId);
        store.delete('telegramPairing');
        try { await sendTelegramMessage(token, linkedChatId, '✅ تم الربط بنجاح! ابعت أي رابط، اختار فيديو أو صوت، وبعدها حدّد الجودة. أرسل /help للمساعدة.'); }
        catch (error) { log.warn('Could not send Telegram pairing confirmation:', error.message); }
        store.set('telegramUpdateOffset', update.update_id + 1);
        continue;
      }
      if (senderChat?.type === 'private' && text) {
        const senderChatId = String(senderChat.id);
        if (!offlineNoticeSent && Number(message.date) > 0 && Number(message.date) * 1000 < telegramPollRequestedAt - 30000) {
          await sendTelegramMessage(token, senderChatId, '📴 وصلتني رسالتك بعد رجوع Ledo للعمل. كان الجهاز أو التطبيق غير متصل، وأنا متاح الآن وسأتابع طلبك.');
          offlineNoticeSent = true;
        }
        const adminSettings = getTelegramAdminSettings();
        if (/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) {
          await sendTelegramMessage(token, senderChatId, adminSettings.welcomeMessage || 'أهلاً بك في Ledo Downloader! البوت متاح للاستخدام من أي محادثة خاصة. ابعت الرابط مباشرة، اختار فيديو أو صوت، وبعدها الجودة. هتوصلك الفيديوهات كفيديو قابل للتشغيل والصوت كمقطع صوتي، مع تحديث للتقدم أثناء الانتظار. الملفات بتتنزل مؤقتًا ثم تُحذف. لازم التطبيق يفضل شغالًا على جهاز صاحب البوت؛ أثناء التنزيل سيمنع التطبيق السكون التلقائي.');
        } else if (/^\/help(?:@\w+)?(?:\s|$)/i.test(text)) {
          await sendTelegramMessage(token, senderChatId, adminSettings.helpMessage || `📥 ابعت الرابط مباشرة من غير أوامر؛ أقبله كمان وسط كلام أو في تعليق صورة. البوت متاح لأي مستخدم يراسله في محادثة خاصة.\n\n🎬 الفيديو: أجيب العنوان والمدة والحجم التقريبي، وبعدها تختار الجودة المتاحة، ويصلك كفيديو قابل للتشغيل.\n🎵 الصوت: MP3 أو M4A ويصلك كمقطع صوتي.\n📄 روابط الملفات العادية تبدأ تلقائيًا. تقدر تبعت حتى ${adminSettings.allowMultipleLinks ? adminSettings.maxLinks : 1} رابط في الرسالة.\n⏳ هتشوف تقدم فحص الرابط والتنزيل والرفع.\n\n/status — متابعة التنزيلات ومعرّفاتها\n/pause ID — إيقاف مؤقت\n/resume ID — استئناف\n/cancel ID — إلغاء وحذف النسخة المؤقتة\n\nالوسائط تُنزّل مؤقتًا، ثم تُرسل وتُحذف. لازم تطبيق Ledo يفضل شغالًا على جهاز صاحب البوت والجهاز متصلًا بالإنترنت.`);
        } else if (/^\/(pause|resume|cancel|stop)(?:@\w+)?(?:\s+([a-f0-9-]{6,36}))?\s*$/i.test(text)) {
          const [, rawAction, idPrefix] = text.match(/^\/(pause|resume|cancel|stop)(?:@\w+)?(?:\s+([a-f0-9-]{6,36}))?\s*$/i);
          await controlTelegramDownload(token, senderChatId, rawAction.toLowerCase() === 'stop' ? 'cancel' : rawAction.toLowerCase(), idPrefix);
        } else if (/^\/status(?:@\w+)?(?:\s|$)/i.test(text)) {
          const pending = store.get('telegramPendingDownloads', {});
          const pendingIds = Object.entries(pending)
            .filter(([, entry]) => String(entry.chatId || '') === senderChatId)
            .map(([id]) => id);
          if (!pendingIds.length) {
            await sendTelegramMessage(token, senderChatId, 'مافيش ملفات منتظرة حاليًا. ابعت أي رابط وسأعرض لك اختيارات الفيديو أو الصوت والجودة.');
          } else {
            try {
              const downloadsResponse = await axios.get('http://127.0.0.1:8000/api/downloads', { timeout: 7000 });
              const downloadsById = new Map((downloadsResponse.data || []).map(item => [String(item.id), item]));
              const controlRequests = store.get('telegramControlRequests', {});
              for (const [key, request] of Object.entries(controlRequests)) {
                if (Number(request.expiresAt) <= Date.now()) delete controlRequests[key];
              }
              const keyboardRows = [];
              const lines = pendingIds.slice(0, 8).map(id => {
                const item = downloadsById.get(String(id));
                const shortId = String(id).slice(0, 8);
                if (!item) return `• جارٍ تجهيز التنزيل [${shortId}]`;
                const name = String(item.filename || item.url || 'ملف').slice(0, 70);
                if (item.status === 'completed') return `✅ ${name} [${shortId}] — اكتمل، جارٍ الإرسال`;
                if (item.status === 'error') return `❌ ${name} [${shortId}] — ${String(item.error_hint || item.error_message || 'تعذر التنزيل').slice(0, 100)}`;
                const isPaused = item.status === 'paused';
                if (isPaused) {
                  // Keep the status and the resume action visible together.
                }
                const progress = Number(item.progress);
                const progressText = Number.isFinite(progress) && progress > 0 ? ` (${Math.min(100, Math.round(progress))}٪)` : '';
                const controlId = crypto.randomBytes(5).toString('hex');
                controlRequests[controlId] = { chatId: senderChatId, downloadId: id, expiresAt: Date.now() + 30 * 60 * 1000 };
                const controls = isPaused
                  ? [{ text: `▶️ ${shortId}`, callback_data: `ld:control:${controlId}:resume` }, { text: `🗑 ${shortId}`, callback_data: `ld:control:${controlId}:cancel` }]
                  : [{ text: `⏸ ${shortId}`, callback_data: `ld:control:${controlId}:pause` }, { text: `🗑 ${shortId}`, callback_data: `ld:control:${controlId}:cancel` }];
                keyboardRows.push(controls);
                return `${isPaused ? '⏸' : '⏳'} ${name} [${shortId}]${isPaused ? ' — متوقف مؤقتًا' : progressText}`;
              });
              if (pendingIds.length > lines.length) lines.push(`و ${pendingIds.length - lines.length} ملفات أخرى.`);
              store.set('telegramControlRequests', controlRequests);
              await axios.post(telegramApi(token, 'sendMessage'), {
                chat_id: senderChatId,
                text: `حالة التنزيلات (${pendingIds.length}):\n${lines.join('\n')}\n\nاضغط أزرار الإيقاف أو الاستئناف أو الإلغاء، أو استخدم /pause ID و/resume ID و/cancel ID.`,
                ...(keyboardRows.length ? { reply_markup: { inline_keyboard: keyboardRows } } : {})
              }, { timeout: 20000 });
            } catch (_) {
              await sendTelegramMessage(token, senderChatId, `يوجد ${pendingIds.length} ملفًا قيد التنزيل أو بانتظار الإرسال. اترك التطبيق مفتوحًا حتى يكتمل.`);
            }
          }
        } else if (/^\/download(?:@\w+)?(?:\s+|$)/i.test(text) || getTelegramMessageLinks(message, text).length) {
          const urls = getTelegramMessageLinks(message, text);
          if (!urls.length) {
            await sendTelegramMessage(token, senderChatId, 'أرسل الرابط بعد الأمر هكذا:\n/download https://example.com/video');
            store.set('telegramUpdateOffset', update.update_id + 1);
            continue;
          }
          const linkLimit = adminSettings.allowMultipleLinks ? adminSettings.maxLinks : 1;
          const acceptedLinks = urls.slice(0, linkLimit);
          handledUpdates.add(update.update_id);
          store.set('telegramHandledUpdateIds', [...handledUpdates].slice(-500));
          store.set('telegramUpdateOffset', update.update_id + 1);
          processTelegramLinkRequest(token, senderChatId, acceptedLinks, urls.length, update.update_id)
            .catch(async error => {
              log.warn('Telegram link inspection failed:', error.message);
              await sendTelegramMessage(token, senderChatId, `تعذر تجهيز الرابط الآن: ${telegramErrorText(error, 'download')}`)
                .catch(sendError => log.warn('Could not report Telegram link inspection failure:', sendError.message));
            });
          continue;
        } else if (text.startsWith('/')) {
          await sendTelegramMessage(token, senderChatId, 'مش فاهم الأمر. أرسل /help لعرض الأوامر.');
        }
      }
    } catch (error) {
      // Keep the update unacknowledged so transient Telegram failures are retried.
      log.warn('Telegram update handling failed:', error.message);
      break;
    }
    store.set('telegramUpdateOffset', update.update_id + 1);
  }
}

async function sendTelegramChatAction(token, chatId, action) {
  try {
    await axios.post(telegramApi(token, 'sendChatAction'), { chat_id: chatId, action }, { timeout: 10000 });
  } catch (error) {
    log.debug('Could not send Telegram chat action:', error.message);
  }
}

function telegramMediaKind(filePath, quality) {
  if (String(quality || '').startsWith('audio')) return 'audio';
  const extension = path.extname(filePath).toLowerCase();
  if (['.mp3', '.m4a'].includes(extension)) return 'audio';
  if (['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi'].includes(extension)) return 'video';
  return 'document';
}

async function prepareTelegramVideo(filePath) {
  if (path.extname(filePath).toLowerCase() === '.mp4') return { filePath, converted: false };
  const candidates = [path.join(__dirname, 'ffmpeg.exe')];
  if (process.resourcesPath) candidates.unshift(path.join(process.resourcesPath, 'ffmpeg.exe'));
  let ffmpegPath = '';
  for (const candidate of candidates) {
    if (await fs.pathExists(candidate)) { ffmpegPath = candidate; break; }
  }
  if (!ffmpegPath) return { filePath, converted: false };

  const outputPath = path.join(path.dirname(filePath), `${path.parse(filePath).name}-${crypto.randomUUID()}.mp4`);
  const baseArgs = ['-y', '-i', filePath, '-map', '0:v:0', '-map', '0:a?', '-movflags', '+faststart'];
  try {
    await execFileAsync(ffmpegPath, [...baseArgs, '-c', 'copy', outputPath], { timeout: 120000, windowsHide: true });
  } catch (_) {
    await fs.remove(outputPath).catch(() => {});
    await execFileAsync(ffmpegPath, [...baseArgs, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-c:a', 'aac', '-b:a', '128k', outputPath], {
      timeout: 180000, windowsHide: true
    });
  }
  if (!await fs.pathExists(outputPath)) throw new Error('تعذر تجهيز الفيديو بصيغة قابلة للتشغيل في تيليجرام.');
  return { filePath: outputPath, converted: true };
}

async function sendTelegramFile(token, chatId, filePath, caption, quality, metadata = {}) {
  let uploadPath = filePath;
  let convertedVideo = false;
  try {
    let stat = await fs.stat(uploadPath);
    if (!stat.isFile()) throw new Error('ملف التنزيل غير موجود.');
    const kind = telegramMediaKind(filePath, quality);
    if (kind === 'video' && path.extname(filePath).toLowerCase() !== '.mp4') {
      const prepared = await prepareTelegramVideo(filePath);
      uploadPath = prepared.filePath;
      convertedVideo = prepared.converted;
      stat = await fs.stat(uploadPath);
    }
    const maxFileSizeMB = getTelegramAdminSettings().maxFileSizeMB;
    if (stat.size > maxFileSizeMB * 1024 * 1024) throw new Error(`حجم الملف أكبر من حد البوت الحالي (${maxFileSizeMB} MB).`);
    return await uploadTelegramMedia(token, chatId, uploadPath, caption, kind, {
      title: metadata.title || path.basename(filePath, path.extname(filePath)),
      performer: metadata.performer || ''
    });
  } catch (error) {
    if (/ENOENT|no such file/i.test(error.message)) throw new Error('لم أجد الملف بعد اكتمال التنزيل. تحقق من مكان حفظ الملفات.');
    throw error;
  } finally {
    if (convertedVideo) await fs.remove(uploadPath).catch(error => log.warn('Could not remove converted Telegram video:', error.message));
  }
}

async function uploadTelegramMedia(token, chatId, filePath, caption, kind, metadata = {}) {
  const method = kind === 'video' ? 'sendVideo' : kind === 'audio' ? 'sendAudio' : 'sendDocument';
  const field = kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : 'document';
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', caption.slice(0, 900));
  if (kind === 'video') form.append('supports_streaming', 'true');
  if (kind === 'audio') {
    form.append('title', String(metadata.title || path.basename(filePath, path.extname(filePath))).slice(0, 64));
    if (metadata.performer) form.append('performer', String(metadata.performer).slice(0, 64));
  }
  const extension = path.extname(filePath).toLowerCase();
  const contentType = kind === 'video' ? 'video/mp4' : kind === 'audio'
    ? (extension === '.m4a' ? 'audio/mp4' : 'audio/mpeg') : 'application/octet-stream';
  form.append(field, fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 }), {
    filename: path.basename(filePath), contentType
  });
  const action = kind === 'video' ? 'upload_video' : kind === 'audio' ? 'upload_voice' : 'upload_document';
  await sendTelegramChatAction(token, chatId, action);
  const actionTimer = setInterval(() => sendTelegramChatAction(token, chatId, action), 4500);
  let response;
  try {
    response = await axios.post(telegramApi(token, method), form, {
      headers: form.getHeaders(), timeout: 180000, maxBodyLength: 55 * 1024 * 1024
    });
  } finally {
    clearInterval(actionTimer);
  }
  if (!response.data?.ok) throw new Error(telegramErrorText({ response: { data: response.data } }, 'upload'));
  return kind;
}

function telegramProgressLine(item, entry) {
  const name = String(item.filename || entry.title || 'الوسائط').slice(0, 55);
  if (item.status === 'completed') return `✅ ${name} — اكتمل التنزيل، جارٍ تجهيز الإرسال`;
  if (item.status === 'error') return `❌ ${name} — تعذر التنزيل`;
  const progress = Math.max(0, Math.min(100, Number(item.progress) || 0));
  const filled = Math.round(progress / 10);
  const bar = `${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)}`;
  const speed = Number(item.speed) > 0 ? ` · ${formatTelegramBytes(item.speed)}/ث` : '';
  const total = Number(item.total_size || item.totalSize || 0);
  const downloaded = Number(item.downloaded || 0);
  const size = total > 0 ? `\n${formatTelegramBytes(downloaded)} من ${formatTelegramBytes(total)}` : '';
  const etaSeconds = total > downloaded && Number(item.speed) > 0 ? (total - downloaded) / Number(item.speed) : 0;
  const eta = etaSeconds > 0 ? ` · متبقٍ ${formatTelegramDuration(etaSeconds)}` : '';
  const stage = item.status === 'resolving' || item.status === 'starting' ? 'جاري تجهيز الرابط' :
    item.status === 'processing' || item.status === 'preparing' ? 'جاري تجهيز الوسائط' :
      item.status === 'paused' ? 'التنزيل متوقف مؤقتًا' : 'جاري التنزيل';
  return `⏳ ${name}\n${stage}\n${bar} ${Math.round(progress)}٪${speed}${eta}${size}`;
}

async function updateTelegramDownloadProgress(token, downloads, pending) {
  const groups = new Map();
  for (const item of downloads) {
    const entry = pending[item.id];
    if (!entry?.progressMessageId || !['starting', 'downloading', 'resolving', 'paused', 'preparing', 'processing'].includes(item.status)) continue;
    const progress = Math.floor(Number(item.progress) || 0);
    if (Date.now() - Number(entry.lastProgressAt || 0) < 7000 && Math.abs(progress - Number(entry.lastProgressValue ?? -1)) < 5) continue;
    const key = `${entry.chatId}:${entry.progressMessageId}`;
    if (!groups.has(key)) groups.set(key, { entry, lines: [] });
    groups.get(key).lines.push(telegramProgressLine(item, entry));
    entry.lastProgressAt = Date.now();
    entry.lastProgressValue = progress;
  }
  for (const { entry, lines } of groups.values()) {
    try {
      await axios.post(telegramApi(token, 'editMessageText'), {
        chat_id: entry.chatId, message_id: entry.progressMessageId,
        text: `📥 التنزيل جارٍ\n\n${lines.join('\n\n')}\n\nLedo سيُرسل الملف هنا عند اكتماله.`
      }, { timeout: 12000 });
    } catch (error) {
      if (!/message is not modified/i.test(error?.response?.data?.description || '')) log.debug('Could not update Telegram download progress:', error.message);
    }
  }
  store.set('telegramPendingDownloads', pending);
}

async function removeTelegramTempFiles(entry) {
  if (!entry?.tempFolder) return;
  try { await fs.remove(entry.tempFolder); }
  catch (error) { log.warn('Could not remove temporary Telegram download:', error.message); }
}

function telegramQualityLabel(quality) {
  if (quality === 'audio') return 'صوت MP3 192 kbps';
  if (quality === 'audio-m4a') return 'صوت M4A';
  return quality === 'best' ? 'فيديو — أفضل جودة' : `فيديو ${quality || ''}`.trim();
}

async function processTelegramCompleted(downloads) {
  if (!Array.isArray(downloads)) return;
  const token = getTelegramToken();
  if (!token) return;
  const pending = store.get('telegramPendingDownloads', {});
  await updateTelegramDownloadProgress(token, downloads, pending);
  const finished = downloads.filter(item => ['completed', 'error'].includes(item.status) && pending[item.id]);
  for (const item of finished) {
    if (!telegramSendingIds.has(item.id) && !telegramSendQueue.has(item.id)) telegramSendQueue.set(item.id, item);
  }
  if (!telegramSendQueue.size || telegramSending) return;
  telegramSending = true;
  try {
    while (telegramSendQueue.size) {
      const [downloadId, item] = telegramSendQueue.entries().next().value;
      telegramSendQueue.delete(downloadId);
      const entry = pending[item.id];
      if (!entry) continue;
      telegramSendingIds.add(item.id);
      try {
        if (item.status === 'error') {
          const reason = String(item.error_hint || item.error_message || 'تعذر تنزيل الرابط. تأكد من صلاحية الرابط ثم حاول مرة أخرى.').slice(0, 700);
          await sendTelegramMessage(token, entry.chatId, `❌ فشل تنزيل ${item.filename || 'الرابط'}: ${reason}`);
          await removeTelegramTempFiles(entry);
        } else {
          await sendTelegramFile(token, entry.chatId, item.save_path,
            `✅ ${telegramQualityLabel(entry.quality)}\nتم الإرسال عبر Ledo Downloader`, entry.quality, {
              title: entry.title,
              performer: entry.performer
            });
          await removeTelegramTempFiles(entry);
        }
        delete pending[item.id];
        store.set('telegramPendingDownloads', pending);
        updateTelegramPowerSaveBlocker();
      } catch (error) {
        if (/50 MB|أكبر من حد|لم أجد الملف/.test(error.message)) {
          await sendTelegramMessage(token, entry.chatId, `تعذر إرسال ${item.filename || 'الملف'}: ${error.message}`);
          await removeTelegramTempFiles(entry);
          delete pending[item.id];
          store.set('telegramPendingDownloads', pending);
          updateTelegramPowerSaveBlocker();
        } else {
          log.warn('Telegram file send deferred:', error.message);
        }
      } finally {
        telegramSendingIds.delete(item.id);
      }
    }
  } finally {
    telegramSending = false;
    if (telegramSendQueue.size) processTelegramCompleted([]).catch(error => log.warn('Telegram send queue failed:', error.message));
  }
}

function updateTelegramPowerSaveBlocker() {
  const shouldKeepAwake = Object.keys(store.get('telegramPendingDownloads', {})).length > 0;
  if (shouldKeepAwake && telegramPowerSaveBlockerId === null) {
    telegramPowerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!shouldKeepAwake && telegramPowerSaveBlockerId !== null) {
    powerSaveBlocker.stop(telegramPowerSaveBlockerId);
    telegramPowerSaveBlockerId = null;
  }
}

function startTelegramPolling() {
  if (telegramPollActive) return;
  telegramPollActive = true;
  updateTelegramPowerSaveBlocker();
  const poll = async () => {
    if (!telegramPollActive || isQuiting) return;
    const token = getTelegramToken();
    const linkedChat = String(store.get('telegramChatId', '')).trim();
    const pairing = store.get('telegramPairing', null);
    const adminSettings = getTelegramAdminSettings();
    const canPollUpdates = !!token && adminSettings.enabled && (linkedChat || (pairing?.code && Number(pairing.expiresAt) > Date.now()));
    if (canPollUpdates) {
      try {
        await ensureBackendStarted();
        await processTelegramUpdates(token);
        if (Object.keys(store.get('telegramPendingDownloads', {})).length) {
          const downloadsResponse = await axios.get('http://127.0.0.1:8000/api/downloads', { timeout: 7000 });
          processTelegramCompleted(downloadsResponse.data).catch(error => log.warn('Telegram completion processing failed:', error.message));
        }
      }
      catch (error) { log.warn('Telegram polling will retry:', error.message); }
    }
    telegramPollTimer = setTimeout(poll, canPollUpdates ? 100 : adminSettings.pollIntervalSeconds * 1000);
  };
  poll();
}

// Keep browser-extension Quick Add independent from the renderer window. The
// main window is intentionally not loaded during a hidden Windows startup, so
// a renderer-owned WebSocket would otherwise miss requests sent in the tray.
function connectQuickAddSocket() {
  if (isQuiting || (quickAddSocket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(quickAddSocket.readyState))) return;
  if (quickAddSocketReconnectTimer) {
    clearTimeout(quickAddSocketReconnectTimer);
    quickAddSocketReconnectTimer = null;
  }

  const socket = new WebSocket(`ws://127.0.0.1:8000/ws?token=${encodeURIComponent(localWsToken)}`, { origin: 'file://' });
  quickAddSocket = socket;
  socket.on('open', () => {
    quickAddSocketReconnectDelay = 1000;
    log.info('Quick Add command channel connected.');
  });
  socket.on('message', (rawMessage) => {
    try {
      const payload = JSON.parse(rawMessage.toString());
      if (payload.type === 'downloads' || payload.type === 'state') {
        const downloads = Array.isArray(payload.downloads) ? payload.downloads : [];
        processTelegramCompleted(downloads).catch(error => log.warn('Telegram completion processing failed:', error.message));
        const activeCount = downloads.filter(download =>
          ['downloading', 'starting', 'resolving', 'preparing', 'processing'].includes(download.status)
        ).length;
        updateTrayDownloadCount(activeCount);
        return;
      }
      if (payload.type !== 'open_quick_add') return;
      openQuickAddWindow({
        url: payload.url,
        cookies: payload.cookies,
        user_agent: payload.user_agent,
        referer: payload.referer,
        filename: payload.filename,
        file_size: payload.file_size,
        mime_type: payload.mime_type,
        native_browser_download: payload.native_browser_download === true,
        native_download_paused: payload.native_download_paused === true,
        native_download_id: Number.isInteger(payload.native_download_id) ? payload.native_download_id : null
      });
    } catch (err) {
      log.warn('Could not handle a Quick Add command:', err);
    }
  });
  socket.on('error', (err) => {
    log.debug('Quick Add command channel error:', err.message);
  });
  socket.on('close', () => {
    if (quickAddSocket === socket) quickAddSocket = null;
    if (isQuiting || quickAddSocketReconnectTimer) return;
    const delay = quickAddSocketReconnectDelay;
    quickAddSocketReconnectDelay = Math.min(quickAddSocketReconnectDelay * 2, 30000);
    quickAddSocketReconnectTimer = setTimeout(() => {
      quickAddSocketReconnectTimer = null;
      connectQuickAddSocket();
    }, delay);
  });
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
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  
  quickAddWindow.loadFile(path.join(__dirname, 'frontend', 'quick_add.html'));
}

async function readClipboardUrl() {
  try {
    const text = (await clipboard.readText()).trim();
    const match = text.match(/https?:\/\/[^\s<>"'`]+/i);
    if (!match) return '';
    const candidate = match[0].replace(/[),.;!?]+$/, '');
    const parsed = new URL(candidate);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
  } catch (_) {
    return '';
  }
}

function openQuickAddWindow(payload = null, toggleWhenVisible = false) {
  ensureBackendStarted();
  if (!quickAddWindow || quickAddWindow.isDestroyed()) createQuickAddWindow();

  if (toggleWhenVisible && quickAddWindow.isVisible()) {
    quickAddWindow.hide();
    return;
  }

  const activate = () => {
    if (!quickAddWindow || quickAddWindow.isDestroyed()) return;
    if (payload) quickAddWindow.webContents.send('quick-add-payload', payload);
    quickAddWindow.webContents.send('quick-add-focus-url');
    quickAddWindow.show();
    quickAddWindow.focus();
    quickAddWindow.moveTop();
  };

  if (quickAddWindow.webContents.isLoading()) {
    quickAddWindow.webContents.once('did-finish-load', activate);
  } else {
    activate();
  }
}

function createMiniProgressWindow() {
  if (miniProgressWindow && !miniProgressWindow.isDestroyed()) return miniProgressWindow;

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
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // This hidden window owns the download WebSocket and fallback polling.
      backgroundThrottling: false
    }
  });
  
  miniProgressWindow.loadFile(path.join(__dirname, 'frontend', 'mini_progress.html'));
  return miniProgressWindow;
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

function updateTrayDownloadCount(activeCount) {
  if (!tray) return;
  const count = Math.max(0, Number(activeCount) || 0);
  const label = count > 0
    ? `Ledo Downloader — ${count} download${count === 1 ? '' : 's'} active`
    : 'Ledo Downloader';
  try { tray.setToolTip(label); } catch (_) {}
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
      label: `Quick Add (${quickAddShortcutLabel})`,
      click: async () => openQuickAddWindow({ url: await readClipboardUrl() })
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

function getHttpsBuffer(url, maxBytes = 16 * 1024 * 1024, redirects = 0, onProgress = null) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects while contacting the package service.'));
    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error('Invalid package download URL.')); }
    if (parsed.protocol !== 'https:') return reject(new Error('Package updates must use HTTPS.'));
    const request = https.get(parsed, { headers: { 'User-Agent': 'Ledo-Downloader', 'Accept': '*/*' } }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        return resolve(getHttpsBuffer(new URL(response.headers.location, parsed).toString(), maxBytes, redirects + 1, onProgress));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`Package service returned HTTP ${response.statusCode}.`));
      }
      const expectedLength = Number(response.headers['content-length']) || 0;
      if (expectedLength > maxBytes) {
        response.destroy();
        return reject(new Error('The package update exceeds the allowed download size.'));
      }
      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          response.destroy(new Error('The package update exceeds the allowed download size.'));
          return;
        }
        chunks.push(chunk);
        onProgress?.(total, expectedLength);
      });
      response.on('end', () => resolve(Buffer.concat(chunks, total)));
      response.on('error', reject);
    });
    request.setTimeout(60000, () => request.destroy(new Error('Package update request timed out.')));
    request.on('error', reject);
  });
}

function sendEngineUpdateStatus(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('engine-update-status', payload);
  }
}

function validateEngineUpdateOverlay(sitePackagesPath) {
  return new Promise((resolve, reject) => {
    const backendPath = path.join(process.resourcesPath, 'backend', 'dist', 'main.exe');
    const venvPythonPath = path.join(__dirname, '.venv', 'Scripts', 'python.exe');
    const packaged = app.isPackaged;
    const command = packaged ? backendPath : (fs.existsSync(venvPythonPath) ? venvPythonPath : 'python');
    const args = packaged
      ? ['--validate-engine-overlay']
      : [path.join(__dirname, 'backend', 'main.py'), '--validate-engine-overlay'];
    const validationEnv = { ...process.env, LEDO_ENGINE_SITE_PACKAGES: sitePackagesPath };
    const child = spawn(command, args, {
      cwd: packaged ? path.dirname(backendPath) : __dirname,
      env: validationEnv,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    const collect = (chunk) => { output = (output + chunk.toString()).slice(-5000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('The updated backend libraries took too long to validate.'));
    }, 60000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(new Error(`Could not start the backend library validation: ${error.message}`));
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(output.trim());
      else reject(new Error(`The updated libraries failed the backend import check.${output ? ` ${output.trim()}` : ''}`));
    });
  });
}

async function readEnginePackageVersions(sitePackagesPath) {
  const versions = {};
  for (const entry of await fs.readdir(sitePackagesPath).catch(() => [])) {
    if (!entry.toLowerCase().endsWith('.dist-info')) continue;
    const metadataPath = path.join(sitePackagesPath, entry, 'METADATA');
    const metadata = await fs.readFile(metadataPath, 'utf8').catch(() => '');
    const name = metadata.match(/^Name:\s*(.+)$/im)?.[1]?.trim();
    const version = metadata.match(/^Version:\s*(.+)$/im)?.[1]?.trim();
    if (name && version) versions[name.toLowerCase().replace(/[-_.]+/g, '-')] = version;
  }
  return versions;
}

function sameEnginePackageVersions(left, right) {
  const leftNames = Object.keys(left).sort();
  const rightNames = Object.keys(right).sort();
  return leftNames.length > 0
    && leftNames.length === rightNames.length
    && leftNames.every((name, index) => name === rightNames[index] && left[name] === right[name]);
}

function setupIpcHandlers() {
  const resolveMediaBinary = async (name) => {
    const candidates = [];
    if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, name));
    candidates.push(path.join(__dirname, name));
    candidates.push(path.join(__dirname, 'dist', 'win-unpacked', 'resources', name));
    for (const candidate of candidates) if (await fs.pathExists(candidate)) return candidate;
    if (process.platform === 'win32') {
      try {
        const result = await execFileAsync('where.exe', [name], { timeout: 5000, windowsHide: true });
        const systemPath = String(result.stdout || '').split(/\r?\n/).map(value => value.trim()).find(Boolean);
        if (systemPath && await fs.pathExists(systemPath)) return systemPath;
      } catch (_) { /* Use the clear missing-binary error below. */ }
    }
    throw new Error(`${name} is missing. Reinstall the app with the media engine included.`);
  };

  ipcMain.handle('media-status', async () => {
    const hasBinary = async name => {
      const candidates = [];
      if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, name));
      candidates.push(path.join(__dirname, name));
      candidates.push(path.join(__dirname, 'dist', 'win-unpacked', 'resources', name));
      for (const candidate of candidates) if (await fs.pathExists(candidate)) return true;
      if (process.platform === 'win32') {
        try {
          const result = await execFileAsync('where.exe', [name], { timeout: 5000, windowsHide: true });
          const systemPath = String(result.stdout || '').split(/\r?\n/).map(value => value.trim()).find(Boolean);
          if (systemPath && await fs.pathExists(systemPath)) return true;
        } catch (_) { /* Binary is not installed on PATH. */ }
      }
      return false;
    };
    return { ffmpeg: await hasBinary('ffmpeg.exe'), ffprobe: await hasBinary('ffprobe.exe') };
  });

  ipcMain.handle('media-probe', async (_event, filePath) => {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('Choose a local media file.');
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error('The selected item is not a file.');
    const ffprobe = await resolveMediaBinary('ffprobe.exe');
    const { stdout } = await execFileAsync(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath], { timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    const data = JSON.parse(stdout);
    const isRealVideo = (data.streams || []).some(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
    const video = isRealVideo ? (data.streams || []).find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic) : null;
    return {
      path: filePath, name: path.basename(filePath), extension: path.extname(filePath).slice(1).toUpperCase() || 'MEDIA',
      size: stat.size, duration: Math.max(0, Number(data.format?.duration) || 0),
      width: Number(video?.width) || 0, height: Number(video?.height) || 0,
      attachedPictureIndex: (data.streams || []).find(stream => stream.disposition?.attached_pic)?.index ?? null,
      hasVideo: isRealVideo, hasAudio: (data.streams || []).some(stream => stream.codec_type === 'audio')
    };
  });

  ipcMain.handle('media-formats', async () => {
    const catalog = [
      { id: 'mp4', label: 'MP4', group: 'video', muxer: 'mp4', encoders: ['libx264','aac'] }, { id: 'mkv', label: 'MKV', group: 'video', muxer: 'matroska', encoders: ['libx264','aac'] },
      { id: 'mov', label: 'MOV', group: 'video', muxer: 'mov', encoders: ['libx264','aac'] }, { id: 'webm', label: 'WebM', group: 'video', muxer: 'webm', encoders: ['libvpx-vp9','libopus'] },
      { id: 'avi', label: 'AVI', group: 'video', muxer: 'avi', encoders: ['mpeg4','libmp3lame'] }, { id: 'mpg', label: 'MPEG', group: 'video', muxer: 'mpeg', encoders: ['mpeg2video','mp2'] },
      { id: '3gp', label: '3GP', group: 'video', muxer: '3gp', encoders: ['h263','aac'] }, { id: 'flv', label: 'FLV', group: 'video', muxer: 'flv', encoders: ['flv','libmp3lame'] },
      { id: 'ts', label: 'MPEG-TS', group: 'video', muxer: 'mpegts', encoders: ['libx264','aac'] }, { id: 'ogv', label: 'OGV', group: 'video', muxer: 'ogg', encoders: ['libtheora','libvorbis'] },
      { id: 'gif', label: 'GIF', group: 'video', muxer: 'gif', encoders: ['gif'] }, { id: 'mp3', label: 'MP3', group: 'audio', muxer: 'mp3', encoders: ['libmp3lame'] },
      { id: 'wav', label: 'WAV', group: 'audio', muxer: 'wav', encoders: ['pcm_s16le'] }, { id: 'flac', label: 'FLAC', group: 'audio', muxer: 'flac', encoders: ['flac'] },
      { id: 'm4a', label: 'M4A', group: 'audio', muxer: 'ipod', encoders: ['aac'] }, { id: 'aac', label: 'AAC', group: 'audio', muxer: 'adts', encoders: ['aac'] },
      { id: 'ogg', label: 'OGG', group: 'audio', muxer: 'ogg', encoders: ['libvorbis'] }, { id: 'opus', label: 'OPUS', group: 'audio', muxer: 'opus', encoders: ['libopus'] },
      { id: 'aiff', label: 'AIFF', group: 'audio', muxer: 'aiff', encoders: ['pcm_s16be'] }, { id: 'ac3', label: 'AC3', group: 'audio', muxer: 'ac3', encoders: ['ac3'] }
    ];
    let stdout = '';
    try {
      const ffmpeg = await resolveMediaBinary('ffmpeg.exe');
      const [muxerResult, encoderResult] = await Promise.all([
        execFileAsync(ffmpeg, ['-hide_banner', '-muxers'], { timeout: 15000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }),
        execFileAsync(ffmpeg, ['-hide_banner', '-encoders'], { timeout: 15000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 })
      ]);
      stdout = `${muxerResult.stdout || ''}\n${muxerResult.stderr || ''}`;
      const encoderText = `${encoderResult.stdout || ''}\n${encoderResult.stderr || ''}`;
      const encoders = new Set([...encoderText.matchAll(/^\s*[A-Z.]{5,6}\s+(\S+)\s+/gm)].map(match => match[1].toLowerCase()));
      if (encoders.size) catalog.forEach(item => { item.encodersReady = item.encoders.every(encoder => encoders.has(encoder)); });
    } catch (_) { return catalog.map(({ id, label, group }) => ({ id, label, group })); }
    const muxers = new Set(stdout.split(/\r?\n/).map(line => {
      const parts = line.trim().split(/\s+/);
      return /^[.DE]{1,2}$/.test(parts[0] || '') && parts[0].includes('E') ? String(parts[1] || '').toLowerCase() : '';
    }).filter(Boolean));
    return catalog.filter(item => muxers.has(item.muxer) && item.encodersReady !== false).map(({ id, label, group }) => ({ id, label, group }));
  });

  // Generate a strip of video thumbnails for the CapCut-style timeline
  ipcMain.handle('media-thumbnails', async (_event, payload = {}) => {
    const filePath = String(payload.filePath || '');
    const count = Math.min(Math.max(1, Number(payload.count) || 20), 60);
    const duration = Math.max(0, Number(payload.duration) || 0);
    if (!path.isAbsolute(filePath) || !await fs.pathExists(filePath)) throw new Error('Choose an available local media file.');
    const ffmpeg = await resolveMediaBinary('ffmpeg.exe');
    const thumbnails = [];
    const height = 80;
    const width = Math.round(height * 16 / 9);
    // Generate all thumbnails in a single ffmpeg call using the fps filter
    const fps = count / Math.max(0.1, duration);
    const args = [
      '-hide_banner', '-nostdin', '-i', filePath,
      '-vf', `fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`,
      '-frames:v', String(count), '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'
    ];
    return await new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const buffer = [];
      let totalBytes = 0;
      const timeout = setTimeout(() => {
        try { child.kill(); } catch (_) {}
        resolve([]);
      }, 15000);
      child.stdout.on('data', chunk => { totalBytes += chunk.length; if (totalBytes <= 20 * 1024 * 1024) buffer.push(chunk); });
      child.stderr.on('data', () => {}); // discard
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('close', code => {
        clearTimeout(timeout);
        if (code !== 0 || totalBytes === 0) { resolve([]); return; }
        // Split the concatenated JPEG stream by JPEG SOI/EOI markers
        const raw = Buffer.concat(buffer);
        const frames = [];
        let start = -1;
        for (let i = 0; i < raw.length - 1; i++) {
          if (raw[i] === 0xFF && raw[i + 1] === 0xD8) { start = i; }
          else if (raw[i] === 0xFF && raw[i + 1] === 0xD9 && start >= 0) {
            frames.push(`data:image/jpeg;base64,${raw.subarray(start, i + 2).toString('base64')}`);
            start = -1;
          }
        }
        resolve(frames.slice(0, count));
      });
    });
  });

  ipcMain.handle('media-waveform', async (event, payload = {}) => {
    const requestId = String(payload.requestId || crypto.randomUUID());
    if (mediaWaveformJobs.has(requestId)) throw new Error('A waveform request with this identifier is already running.');
    const filePath = String(payload.filePath || '');
    if (!path.isAbsolute(filePath) || !await fs.pathExists(filePath)) throw new Error('Choose an available local media file.');
    const ffmpeg = await resolveMediaBinary('ffmpeg.exe');
    const duration = Math.max(0, Number(payload.duration) || 0);
    const args = ['-hide_banner', '-nostdin', '-stats', '-stats_period', '0.5', '-filter_threads', '1', '-i', filePath, '-filter_complex', '[0:a:0]aformat=channel_layouts=mono,showwavespic=s=1600x128:colors=0x76a9ff[wave]', '-map', '[wave]', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'];
    return await new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let settled = false;
      let timeout;
      const cleanup = () => {
        clearTimeout(timeout);
        mediaWaveformJobs.delete(requestId);
        event.sender.removeListener('destroyed', cancelForClosedWindow);
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const cancelForClosedWindow = () => {
        try { child.kill(); } catch (_) {}
        finish(reject, new Error('Waveform generation was canceled because its window closed.'));
      };
      mediaWaveformJobs.set(requestId, { child, sender: event.sender });
      event.sender.once('destroyed', cancelForClosedWindow);
      timeout = setTimeout(() => {
        try { child.kill(); } catch (_) {}
        finish(reject, new Error('Waveform generation timed out.'));
      }, 120000);
      const chunks = []; let bytes = 0; let stderrTail = '';
      child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes <= 5 * 1024 * 1024) chunks.push(chunk); });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => {
        stderrTail = (stderrTail + chunk).slice(-4000);
        const timeMatches = [...stderrTail.matchAll(/time=(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/g)];
        const speedMatches = [...stderrTail.matchAll(/speed=\s*([\d.]+)x/g)];
        if (timeMatches.length && duration > 0 && !event.sender.isDestroyed()) {
          const parts = timeMatches.at(-1)[1].split(':').map(Number);
          const seconds = (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
          event.sender.send('media-preparation-progress', { requestId, stage: 'waveform', progress: Math.min(99, Math.floor(seconds / duration * 100)), speed: speedMatches.at(-1)?.[1] || '' });
        }
      });
      child.once('error', error => finish(reject, error));
      child.once('close', code => {
        if (code === 0 && bytes > 0 && bytes <= 5 * 1024 * 1024) finish(resolve, `data:image/png;base64,${Buffer.concat(chunks).toString('base64')}`);
        else finish(reject, new Error(stderrTail.trim().split('\n').slice(-2).join(' ').slice(-400) || 'No audio stream was found for the waveform.'));
      });
    });
  });

  ipcMain.handle('media-start', async (event, options = {}) => {
    const jobId = crypto.randomUUID();
    const tool = ['convert', 'trim', 'compress'].includes(options.tool) ? options.tool : '';
    const mode = String(options.mode || '');
    const sourcePath = String(options.sourcePath || '');
    if (!tool || !path.isAbsolute(sourcePath) || !await fs.pathExists(sourcePath)) throw new Error('Choose a valid source file first.');
    const sourceStat = await fs.stat(sourcePath);
    if (!sourceStat.isFile()) throw new Error('The selected source is not a file.');
    const ffmpeg = await resolveMediaBinary('ffmpeg.exe');
    const destination = options.destination === 'custom' && path.isAbsolute(String(options.outputDirectory || ''))
      ? String(options.outputDirectory) : path.dirname(sourcePath);
    await fs.ensureDir(destination);
    let suffix = '_converted';
    let extension = '';
    const args = ['-hide_banner', '-nostdin'];
    let totalDuration = Math.max(0, Number(options.duration) || 0);

    if (tool === 'convert') {
      const format = ['mp4', 'mkv', 'mov', 'webm', 'avi', 'mpg', '3gp', 'flv', 'ts', 'ogv', 'gif', 'mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'aiff', 'ac3'].includes(options.format) ? options.format : 'mp4';
      extension = `.${format}`;
      if (options.fastRemux && ['mp4', 'mkv', 'mov'].includes(format)) args.push('-i', sourcePath, '-map', '0', '-c', 'copy');
      else if (['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'aiff', 'ac3'].includes(format)) {
        const bitrate = ['320k', '192k', '128k'].includes(options.bitrate) ? options.bitrate : '192k';
        const audioOptions = {
          mp3: ['-c:a', 'libmp3lame', '-b:a', bitrate], wav: ['-c:a', 'pcm_s16le'], flac: ['-c:a', 'flac', '-compression_level', '5'],
          m4a: ['-c:a', 'aac', '-b:a', bitrate], aac: ['-c:a', 'aac', '-b:a', bitrate], ogg: ['-c:a', 'libvorbis', '-q:a', '5'],
          opus: ['-c:a', 'libopus', '-b:a', bitrate], aiff: ['-c:a', 'pcm_s16be'], ac3: ['-c:a', 'ac3', '-b:a', '192k']
        };
        args.push('-i', sourcePath, '-map', '0:a:0');
        const coverIndex = options.attachedPictureIndex;
        const artworkFormat = ['mp3', 'm4a'].includes(format);
        const supportsCover = artworkFormat && Number.isInteger(coverIndex) && coverIndex >= 0;
        const makeVideoCover = artworkFormat && !supportsCover && options.hasVideo === true;
        if (supportsCover) args.push('-map', `0:${coverIndex}?`);
        else if (makeVideoCover) args.push('-map', '0:v:0?');
        else args.push('-vn');
        args.push(...audioOptions[format]);
        if (supportsCover) args.push('-c:v', 'copy', '-disposition:v:0', 'attached_pic');
        else if (makeVideoCover) args.push('-vf', "scale='min(640,iw)':-2", '-frames:v', '1', '-c:v', 'mjpeg', '-disposition:v:0', 'attached_pic');
      } else if (format === 'gif') args.push('-i', sourcePath, '-map', '0:v:0', '-an', '-vf', 'fps=12,scale=720:-1:flags=lanczos');
      else {
        const videoOptions = {
          mp4: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'],
          mov: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-c:a', 'aac', '-b:a', '192k'],
          mkv: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-c:a', 'aac', '-b:a', '192k'],
          webm: ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-c:a', 'libopus', '-b:a', '128k'],
          avi: ['-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'libmp3lame', '-b:a', '192k'],
          mpg: ['-c:v', 'mpeg2video', '-q:v', '5', '-c:a', 'mp2', '-b:a', '192k'],
          '3gp': ['-c:v', 'h263', '-c:a', 'aac', '-b:a', '96k'], flv: ['-c:v', 'flv', '-c:a', 'libmp3lame', '-b:a', '128k'],
          ts: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-c:a', 'aac', '-b:a', '160k'],
          ogv: ['-c:v', 'libtheora', '-q:v', '6', '-c:a', 'libvorbis', '-q:a', '4']
        };
        args.push('-i', sourcePath, '-map', '0:v:0?', '-map', '0:a?', ...videoOptions[format]);
      }
    } else if (tool === 'trim' && mode === 'mux') {
      const audioPath = String(options.audioPath || '');
      if (!path.isAbsolute(audioPath) || !await fs.pathExists(audioPath)) throw new Error('Choose an audio track for the merge slot.');
      extension = options.format === 'mkv' ? '.mkv' : '.mp4'; suffix = '_merged';
      args.push('-i', sourcePath, '-i', audioPath, '-map', '0:v:0?', '-map', '1:a:0?', '-c:v', 'copy', '-c:a', 'aac', '-shortest');
    } else if (tool === 'trim') {
      const start = Math.max(0, Number(options.start) || 0);
      const end = Number(options.end);
      if (!Number.isFinite(end) || end <= start) throw new Error('End time must be later than start time.');
      totalDuration = end - start; suffix = '_trimmed'; extension = path.extname(sourcePath) || '.mp4';
      args.push('-ss', String(start), '-i', sourcePath, '-t', String(totalDuration));
      if (options.lossless) args.push('-c', 'copy');
      else args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-c:a', 'aac');
    } else if (tool === 'compress') {
      const preset = ['balanced', 'social', 'maximum'].includes(options.preset) ? options.preset : 'balanced';
      const presets = { balanced: { crf: '23', scale: '' }, social: { crf: '28', scale: 'scale=-2:720:force_original_aspect_ratio=decrease' }, maximum: { crf: '32', scale: 'scale=-2:480:force_original_aspect_ratio=decrease' } };
      suffix = '_compressed'; extension = path.extname(sourcePath) || '.mp4';
      args.push('-i', sourcePath, '-map', '0:v:0?', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'medium', '-crf', presets[preset].crf, '-c:a', 'aac', '-b:a', '128k');
      if (presets[preset].scale) args.push('-vf', presets[preset].scale);
      if (extension.toLowerCase() === '.mp4' || extension.toLowerCase() === '.m4v') args.push('-movflags', '+faststart');
    } else throw new Error('Choose a supported media operation.');

    const base = path.parse(sourcePath).name + suffix;
    let outputPath = '';
    let outputReservation = '';
    let outputIndex = 1;
    while (!outputPath) {
      const candidate = path.join(destination, `${base}${outputIndex === 1 ? '' : ` (${outputIndex})`}${extension}`);
      const reservation = path.resolve(candidate).toLowerCase();
      if (mediaOutputReservations.has(reservation)) {
        if (options.autoRename === false) throw new Error('That output is already being created by another task.');
        outputIndex += 1;
        continue;
      }
      // Claim the name before the filesystem check yields to another job.
      mediaOutputReservations.add(reservation);
      let candidateExists;
      try {
        candidateExists = await fs.pathExists(candidate);
      } catch (error) {
        mediaOutputReservations.delete(reservation);
        throw error;
      }
      if (candidateExists) {
        mediaOutputReservations.delete(reservation);
        if (options.autoRename === false) throw new Error('That output already exists. Enable auto-rename or remove the existing export.');
        outputIndex += 1;
        continue;
      }
      outputPath = candidate;
      outputReservation = reservation;
    }
    const tempOutputPath = `${outputPath}.ledo-${jobId}${extension}`;
    args.push('-n', tempOutputPath);

    let child;
    try {
      child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      mediaOutputReservations.delete(outputReservation);
      await fs.remove(tempOutputPath).catch(() => {});
      throw error;
    }
    mediaJobs.set(jobId, { child, sender: event.sender });
    let stderrTail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      stderrTail = (stderrTail + chunk).slice(-12000);
      const timeMatches = [...stderrTail.matchAll(/time=(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/g)];
      const speedMatches = [...stderrTail.matchAll(/speed=\s*([\d.]+)x/g)];
      const time = timeMatches[timeMatches.length - 1];
      const speed = speedMatches[speedMatches.length - 1];
      if (time || speed) {
        const parts = (time?.[1] || '00:00:00').split(':').map(Number);
        const seconds = (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
        const progress = totalDuration > 0 ? Math.min(99, Math.round(seconds / totalDuration * 100)) : 0;
        if (!event.sender.isDestroyed()) event.sender.send('media-progress', { jobId, progress, speed: speed ? `${speed[1]}x` : '' });
      }
    });
    child.once('error', error => {
      mediaJobs.delete(jobId);
      mediaOutputReservations.delete(outputReservation);
      fs.remove(tempOutputPath).catch(() => {});
      if (!event.sender.isDestroyed()) event.sender.send('media-progress', { jobId, error: error.message });
    });
    child.once('close', async code => {
      mediaJobs.delete(jobId);
      let succeeded = false;
      if (code === 0 && await fs.pathExists(tempOutputPath).catch(() => false)) {
        try {
          await fs.move(tempOutputPath, outputPath, { overwrite: false });
          succeeded = true;
        } catch (error) {
          stderrTail = (stderrTail + ` ${error.message}`).slice(-12000);
        }
      }
      if (!succeeded) await fs.remove(tempOutputPath).catch(() => {});
      mediaOutputReservations.delete(outputReservation);
      if (!event.sender.isDestroyed()) event.sender.send('media-progress', succeeded
        ? { jobId, progress: 100, speed: '', done: true, outputPath }
        : { jobId, error: stderrTail.trim().split('\n').slice(-3).join(' ').slice(-500) || `FFmpeg exited with code ${code}.` });
    });
    return { jobId, outputPath };
  });

  ipcMain.handle('media-cancel', (_event, jobId) => {
    const job = mediaJobs.get(String(jobId || ''));
    const waveformJob = mediaWaveformJobs.get(String(jobId || ''));
    if (job) job.child.kill();
    else if (waveformJob) waveformJob.child.kill();
    else return false;
    return true;
  });

  ipcMain.handle('telegram-get-config', () => ({
    configured: !!store.get('telegramTokenEncrypted', ''),
    linked: !!store.get('telegramChatId', ''),
    awaitingPairing: !!store.get('telegramPairing') && Number(store.get('telegramPairing').expiresAt) > Date.now(),
    botUsername: String(store.get('telegramBotUsername', '')),
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    pendingCount: Object.keys(store.get('telegramPendingDownloads', {})).length,
    adminSettings: getTelegramAdminSettings()
  }));

  ipcMain.handle('telegram-admin-settings-apply', (_event, input = {}) => {
    const settings = normalizeTelegramAdminSettings(input);
    store.set('telegramAdminSettings', settings);
    return { success: true, settings };
  });

  ipcMain.handle('telegram-begin-pairing', async (_event, input = {}) => {
    try {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('التخزين المشفّر غير متاح على هذا الجهاز.');
      const token = String(input.token || '').trim() || getTelegramToken();
      if (!token || !/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('اكتب توكن البوت أولاً.');
      const response = await axios.get(telegramApi(token, 'getMe'), { timeout: 15000 });
      if (!response.data?.ok || !response.data.result?.username) throw new Error('تيليجرام لم يقبل التوكن أو لم يُرجع اسم البوت.');
      await axios.post(telegramApi(token, 'setMyCommands'), {
        commands: [
          { command: 'start', description: 'بدء استخدام Ledo Downloader' },
          { command: 'help', description: 'المساعدة وأوامر التحكم' },
          { command: 'download', description: 'تنزيل رابط محدد' },
          { command: 'status', description: 'متابعة التنزيلات والتحكم فيها' },
          { command: 'pause', description: 'إيقاف تنزيل مؤقتًا' },
          { command: 'resume', description: 'استئناف تنزيل متوقف' },
          { command: 'cancel', description: 'إلغاء تنزيل' }
        ]
      }, { timeout: 15000 }).catch(error => log.warn('Could not register Telegram bot commands:', error.message));
      const encrypted = safeStorage.encryptString(token).toString('base64');
      store.set('telegramTokenEncrypted', encrypted);
      const username = response.data.result.username;
      const code = crypto.randomBytes(24).toString('hex');
      store.set('telegramBotUsername', username);
      store.set('telegramPairing', { code, expiresAt: Date.now() + 10 * 60 * 1000 });
      store.delete('telegramChatId');
      store.set('telegramUpdateOffset', Number(store.get('telegramUpdateOffset', 0)) || 0);
      startTelegramPolling();
      return { success: true, username, link: `https://t.me/${username}?start=${code}` };
    } catch (error) {
      return { success: false, error: telegramErrorText(error, 'pairing') };
    }
  });

  ipcMain.handle('telegram-disconnect', () => {
    store.delete('telegramTokenEncrypted');
    store.delete('telegramChatId');
    store.delete('telegramBotUsername');
    store.delete('telegramPairing');
    store.delete('telegramUpdateOffset');
    store.delete('telegramHandledUpdateIds');
    store.delete('telegramPendingDownloads');
    updateTelegramPowerSaveBlocker();
    return { success: true };
  });

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
  ipcMain.handle('get-local-ws-token', (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    const trustedWindows = [mainWindow, miniProgressWindow].filter(Boolean);
    const senderUrl = event.senderFrame?.url || '';
    if (!senderWindow || !trustedWindows.includes(senderWindow) || !senderUrl.startsWith('file://')) {
      throw new Error('Untrusted renderer requested local backend access.');
    }
    return localWsToken;
  });

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

  ipcMain.handle('get-engine-update-report', async () => {
    const reportPath = path.join(app.getPath('userData'), 'engine-updates', 'last-report.json');
    const report = await fs.readJson(reportPath).catch(() => null);
    if (!report) return null;
    if (report.restartRequired) {
      const activeManifest = await fs.readJson(path.join(app.getPath('userData'), 'engine-updates', 'active.json')).catch(() => ({}));
      const activeName = activeManifest.sitePackages?.directory;
      if (activeName && engineSitePackagesAtStartup && path.basename(engineSitePackagesAtStartup) === activeName) {
        const appliedReport = { ...report, status: 'applied', restartRequired: false, appliedAt: new Date().toISOString() };
        await fs.writeJson(reportPath, appliedReport, { spaces: 2 }).catch(() => {});
        return appliedReport;
      }
    }
    return report;
  });

  ipcMain.handle('check-engine-updates', async () => {
    let stageDir = '';
    let requirementsPath = '';
    let engineUpdateDir = '';
    let reportPath = '';
    let pythonCommand = '';
    let pythonArgs = [];
    try {
      sendEngineUpdateStatus({ status: 'checking' });
      if (!await ensureBackendStarted()) throw new Error('The download engine did not start. Restart Ledo and try again.');
      engineUpdateDir = path.join(app.getPath('userData'), 'engine-updates');
      await fs.ensureDir(engineUpdateDir);
      reportPath = path.join(engineUpdateDir, 'last-report.json');
      requirementsPath = app.isPackaged
        ? path.join(process.resourcesPath, 'backend', 'requirements.txt')
        : path.join(__dirname, 'backend', 'requirements.txt');
      if (!await fs.pathExists(requirementsPath)) throw new Error('The bundled backend/requirements.txt file is missing.');

      // The frozen backend is built with CPython 3.13. Install into a user-writable
      // overlay so the app directory (often under Program Files) is never modified.
      for (const candidate of [
        { command: 'py', args: ['-3.13', '--version'] },
        { command: 'python', args: ['--version'] }
      ]) {
        try {
          const { stdout, stderr } = await execFileAsync(candidate.command, candidate.args, { windowsHide: true, timeout: 10000 });
          if (/Python 3\.13\./.test(`${stdout} ${stderr}`)) {
            pythonCommand = candidate.command;
            pythonArgs = candidate.args.slice(0, -1);
            break;
          }
        } catch (_) {}
      }
      if (!pythonCommand) {
        throw new Error('Updating all backend libraries requires Python 3.13. Install Python 3.13, then retry. No administrator access is needed.');
      }

      const activeManifestPath = path.join(engineUpdateDir, 'active.json');
      const previousManifest = await fs.readJson(activeManifestPath).catch(() => ({}));
      const previousDirectory = previousManifest.sitePackages?.directory;
      const previousSitePackages = previousDirectory && path.basename(previousDirectory) === previousDirectory
        ? path.join(engineUpdateDir, previousDirectory)
        : '';
      if (previousSitePackages && await fs.pathExists(previousSitePackages)) {
        sendEngineUpdateStatus({ status: 'checking', detail: 'Checking for newer library versions…' });
        const requiredNames = new Set((await fs.readFile(requirementsPath, 'utf8'))
          .split(/\r?\n/)
          .map(line => line.trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/))
          .filter(Boolean)
          .map(match => match[1].toLowerCase().replace(/[-_.]+/g, '-')));
        const { stdout } = await execFileAsync(pythonCommand, [
          ...pythonArgs, '-m', 'pip', 'list', '--outdated', '--path', previousSitePackages, '--format=json'
        ], { windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
        const outdatedPackages = JSON.parse(stdout || '[]').filter(pkg =>
          requiredNames.has(String(pkg.name || '').toLowerCase().replace(/[-_.]+/g, '-'))
        );
        const currentVersions = await readEnginePackageVersions(previousSitePackages);
        const missingPackages = [...requiredNames].some(name => !currentVersions[name]);
        if (outdatedPackages.length === 0 && !missingPackages) {
          const restartRequired = Boolean(path.resolve(previousSitePackages) !== path.resolve(engineSitePackagesAtStartup || ''));
          const previousReport = await fs.readJson(reportPath).catch(() => ({}));
          const result = {
            success: true,
            status: restartRequired ? 'staged' : 'up-to-date',
            checkedAt: new Date().toISOString(),
            restartRequired,
            packageCount: Object.keys(currentVersions).length,
            currentVersion: currentVersions['yt-dlp'] || 'current',
            changes: restartRequired ? (previousReport.changes || []) : [],
            packageVersions: currentVersions
          };
          await fs.writeJson(reportPath, result, { spaces: 2 });
          sendEngineUpdateStatus(result);
          return result;
        }
      }

      const stageName = `site-packages-${Date.now()}.pending`;
      stageDir = path.join(engineUpdateDir, stageName);
      await fs.ensureDir(stageDir);
      sendEngineUpdateStatus({ status: 'downloading', packageCount: 0, percent: 0 });
      const args = [...pythonArgs, '-m', 'pip', 'install', '--upgrade', '--ignore-installed', '--no-deps', '--require-hashes', '--index-url', 'https://pypi.org/simple', '--disable-pip-version-check', '--no-warn-script-location', '--target', stageDir, '-r', requirementsPath];
      await new Promise((resolve, reject) => {
        const installer = spawn(pythonCommand, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        let lineBuffer = '';
        const onData = (chunk) => {
          const text = chunk.toString();
          output = (output + text).slice(-12000);
          lineBuffer = (lineBuffer + text).slice(-4000);
          const lastLine = lineBuffer.trim().split(/\r?\n/).slice(-1)[0];
          sendEngineUpdateStatus({ status: 'downloading', detail: lastLine });
        };
        installer.stdout.on('data', onData);
        installer.stderr.on('data', onData);
        installer.once('error', reject);
        installer.once('close', (code) => code === 0 ? resolve() : reject(new Error(`pip could not update the backend requirements. ${output.slice(-1800)}`)));
      });
      sendEngineUpdateStatus({ status: 'validating' });
      await validateEngineUpdateOverlay(stageDir);

      const stagedVersions = await readEnginePackageVersions(stageDir);
      const currentVersions = previousSitePackages && await readEnginePackageVersions(previousSitePackages);
      if (previousSitePackages && sameEnginePackageVersions(currentVersions, stagedVersions)) {
        await fs.remove(stageDir);
        stageDir = '';
        const restartRequired = path.resolve(previousSitePackages) !== path.resolve(engineSitePackagesAtStartup || '');
        const previousReport = await fs.readJson(reportPath).catch(() => ({}));
        const result = {
          success: true,
          status: restartRequired ? 'staged' : 'up-to-date',
          checkedAt: new Date().toISOString(),
          restartRequired,
          packageCount: Object.keys(stagedVersions).length,
          currentVersion: stagedVersions['yt-dlp'] || 'current',
          changes: restartRequired ? (previousReport.changes || []) : [],
          packageVersions: stagedVersions
        };
        await fs.writeJson(reportPath, result, { spaces: 2 });
        sendEngineUpdateStatus(result);
        return result;
      }

      const changes = Object.entries(stagedVersions)
        .filter(([name, version]) => !currentVersions || currentVersions[name] !== version)
        .map(([name, version]) => ({ name, from: currentVersions?.[name] || null, to: version }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const activeName = `site-packages-${Date.now()}`;
      const activeDir = path.join(engineUpdateDir, activeName);
      await fs.move(stageDir, activeDir);
      stageDir = '';
      const nextManifest = {
        sitePackages: { directory: activeName, stagedAt: new Date().toISOString(), source: 'backend/requirements.txt' },
        previousSitePackages: previousManifest.sitePackages || null
      };
      const temporaryManifestPath = `${activeManifestPath}.${process.pid}.tmp`;
      await fs.writeJson(temporaryManifestPath, nextManifest, { spaces: 2 });
      await fs.move(temporaryManifestPath, activeManifestPath, { overwrite: true });

      const result = {
        success: true,
        status: 'staged',
        checkedAt: new Date().toISOString(),
        restartRequired: true,
        packageCount: Object.keys(stagedVersions).length,
        currentVersion: stagedVersions['yt-dlp'] || 'current',
        changes,
        packageVersions: stagedVersions
      };
      await fs.writeJson(reportPath, result, { spaces: 2 });
      sendEngineUpdateStatus(result);
      return result;
    } catch (err) {
      if (stageDir) await fs.remove(stageDir).catch(() => {});
      log.error('Engine update failed:', err);
      let powerShellFallback = false;
      if (requirementsPath && engineUpdateDir) {
        try {
          const repairDirName = `site-packages-powershell-${Date.now()}`;
          const repairDir = path.join(engineUpdateDir, repairDirName);
          const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
          const repairPythonCommand = pythonCommand || 'py';
          const repairPythonArgs = pythonCommand ? pythonArgs : ['-3.13'];
          const pipArgs = [...repairPythonArgs, '-m', 'pip', 'install', '--upgrade', '--ignore-installed', '--no-deps', '--require-hashes', '--index-url', 'https://pypi.org/simple', '--disable-pip-version-check', '--no-warn-script-location', '--target', repairDir, '-r', requirementsPath];
          const argArray = `@(${pipArgs.map(psQuote).join(', ')})`;
          const manifestPath = path.join(engineUpdateDir, 'active.json');
          const validatorPath = app.isPackaged
            ? path.join(process.resourcesPath, 'backend', 'dist', 'main.exe')
            : (fs.existsSync(path.join(__dirname, '.venv', 'Scripts', 'python.exe'))
              ? path.join(__dirname, '.venv', 'Scripts', 'python.exe')
              : 'python');
          const validatorArgs = app.isPackaged
            ? ['--validate-engine-overlay']
            : [path.join(__dirname, 'backend', 'main.py'), '--validate-engine-overlay'];
          const script = [
            "$ErrorActionPreference = 'Stop'",
            `$python = ${psQuote(repairPythonCommand)}`,
            `$argsList = ${argArray}`,
            `& $python @argsList`,
            'if ($LASTEXITCODE -ne 0) { throw "pip failed with exit code $LASTEXITCODE" }',
            `$env:LEDO_ENGINE_SITE_PACKAGES = ${psQuote(repairDir)}`,
            `$validator = ${psQuote(validatorPath)}`,
            `$validatorArgs = @(${validatorArgs.map(psQuote).join(', ')})`,
            '& $validator @validatorArgs',
            'if ($LASTEXITCODE -ne 0) { throw "The updated backend libraries did not pass validation." }',
            '$env:LEDO_ENGINE_SITE_PACKAGES = $null',
            `$oldManifest = $null; if (Test-Path ${psQuote(manifestPath)}) { try { $oldManifest = Get-Content -Raw ${psQuote(manifestPath)} | ConvertFrom-Json } catch {} }`,
            `$manifest = @{ sitePackages = @{ directory = ${psQuote(repairDirName)}; stagedAt = (Get-Date).ToUniversalTime().ToString('o'); source = 'backend/requirements.txt' }; previousSitePackages = $oldManifest.sitePackages } | ConvertTo-Json -Depth 4`,
            `$temporaryManifestPath = ${psQuote(manifestPath)} + '.' + $PID + '.tmp'`,
            `[System.IO.File]::WriteAllText($temporaryManifestPath, $manifest, [System.Text.UTF8Encoding]::new($false))`,
            `Move-Item -LiteralPath $temporaryManifestPath -Destination ${psQuote(manifestPath)} -Force`,
            "Write-Host 'All backend libraries are updated. Close and reopen Ledo Downloader.' -ForegroundColor Green"
          ].join('\r\n');
          engineRepairScriptPath = path.join(engineUpdateDir, 'repair-engine-updates.ps1');
          await fs.writeFile(engineRepairScriptPath, script, 'utf8');
          powerShellFallback = true;
        } catch (scriptError) {
          log.error('Could not prepare PowerShell repair steps:', scriptError);
        }
      }
      const previousReport = reportPath ? await fs.readJson(reportPath).catch(() => ({})) : {};
      const result = {
        ...previousReport,
        success: false,
        status: 'error',
        checkedAt: new Date().toISOString(),
        error: err.message || 'Unknown engine update error',
        powerShellFallback
      };
      if (reportPath) await fs.writeJson(reportPath, result, { spaces: 2 }).catch(reportError => log.warn('Could not save engine update report:', reportError));
      sendEngineUpdateStatus(result);
      return result;
    }
  });

  ipcMain.handle('open-engine-update-powershell', async () => {
    if (!engineRepairScriptPath || !await fs.pathExists(engineRepairScriptPath)) {
      return { success: false, error: 'PowerShell repair steps are not available. Retry the library update first.' };
    }
    try {
      const shellProcess = spawn('powershell.exe', ['-NoExit', '-ExecutionPolicy', 'Bypass', '-File', engineRepairScriptPath], { detached: true, stdio: 'ignore', windowsHide: false });
      await new Promise((resolve, reject) => {
        shellProcess.once('spawn', resolve);
        shellProcess.once('error', reject);
      });
      shellProcess.unref();
      return { success: true };
    } catch (err) {
      log.error('Could not open PowerShell for engine repair:', err);
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
  // Update tray tooltip with active download count
  ipcMain.on('update-tray-status', (_event, activeCount) => {
    updateTrayDownloadCount(activeCount);
  });

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
      // Notify renderer so the maximize icon can toggle correctly
      try { win.webContents.send('window-maximized-change', win.isMaximized()); } catch (_) {}
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
    openQuickAddWindow(payload || {});
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
        checkedAt: new Date().toISOString(),
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
        version: info.version,
        checkedAt: new Date().toISOString()
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
        checkedAt: new Date().toISOString(),
        message: err.message || 'Unknown error'
      });
    }
  });

  // Register the preferred shortcut first, then try alternatives if Windows
  // or another app has already claimed Ctrl+Space.
  const quickAddShortcuts = [
    { accelerator: 'CommandOrControl+Space', label: 'Ctrl+Space' },
    { accelerator: 'Alt+Shift+Q', label: 'Alt+Shift+Q' },
    { accelerator: 'CommandOrControl+Shift+Space', label: 'Ctrl+Shift+Space' }
  ];
  let shortcutRegistered = false;
  for (const shortcut of quickAddShortcuts) {
    if (globalShortcut.register(shortcut.accelerator, async () => {
      openQuickAddWindow({ url: await readClipboardUrl() }, true);
    })) {
      quickAddShortcutLabel = shortcut.label;
      shortcutRegistered = true;
      log.info(`Quick Add shortcut registered: ${shortcut.label}`);
      break;
    }
  }
  if (!shortcutRegistered) {
    quickAddShortcutLabel = 'use tray menu';
    log.error('Could not register a Quick Add global shortcut; use the tray menu.');
  }

  setupTray();

  createWindow();
  // Start the download engine even when Windows launches the app hidden in the
  // tray. Browser-extension requests can then reach it without opening the UI.
  ensureBackendStarted();
  // The monitor has to exist before it can receive download updates and show
  // itself. It stays hidden until its first active download arrives.
  createMiniProgressWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Clipboard Monitor (Smart Paste)
  let clipboardReadInFlight = false;
  clipboardInterval = setInterval(async () => {
    if (!smartClipboardEnabled) return;
    if (clipboardReadInFlight) return;
    clipboardReadInFlight = true;
    let text = '';
    try { text = await clipboard.readText(); } catch (_) { clipboardReadInFlight = false; return; }
    clipboardReadInFlight = false;
    if (text !== lastClipboard && (text.includes('tiktok.com') || text.includes('youtube.com') || text.includes('instagram.com') || text.includes('fb.watch') || text.includes('x.com') || text.includes('spotify.com'))) {
        lastClipboard = text;
        if (smartPastePromptPending || !mainWindow || mainWindow.isDestroyed()) return;
        // Don't interrupt the user if they're actively working in the app window
        if (mainWindow.isVisible() && mainWindow.isFocused()) return;
        smartPastePromptPending = true;
        if (mainWindow.isMinimized()) mainWindow.restore();
        if (!mainWindow.isVisible()) mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send('smart-paste-detected', text);
    }
  }, 2000);
});

app.on('will-quit', () => {
  isQuiting = true;
  globalShortcut.unregisterAll();
  if (quickAddSocketReconnectTimer) {
    clearTimeout(quickAddSocketReconnectTimer);
    quickAddSocketReconnectTimer = null;
  }
  if (quickAddSocket) {
    quickAddSocket.removeAllListeners();
    quickAddSocket.terminate();
    quickAddSocket = null;
  }
  if (updaterStartupTimer) {
    clearTimeout(updaterStartupTimer);
    updaterStartupTimer = null;
  }
  if (clipboardInterval) {
    clearInterval(clipboardInterval);
    clipboardInterval = null;
  }
  for (const job of mediaWaveformJobs.values()) {
    try { job.child.kill(); } catch (_) {}
  }
  for (const job of mediaJobs.values()) {
    try { job.child.kill(); } catch (_) {}
  }
  mediaWaveformJobs.clear();
  mediaJobs.clear();
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
