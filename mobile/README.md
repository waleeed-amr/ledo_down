# Ledo Downloader Mobile

> **Standalone download manager for Android** — 100% offline, no server, no tracking.

A native mobile app that downloads files directly on your phone using multi-threaded
chunked downloading (like IDM for desktop). No cloud backend, no subscription, no
laptop required.

---

## ✨ Features

- 🚀 **Multi-threaded downloads** — 4 to 16 parallel chunks per file
- ⏸️ **Pause / Resume** — anytime, even mid-chunk
- 🎯 **Smart URL detection** — auto-classifies HTTP files vs media URLs
- 📱 **Background downloads** — continues when app is closed (foreground service)
- 🔗 **Share intent** — receive URLs from any app (browser, social media, etc.)
- 📋 **Clipboard monitoring** — auto-detect URLs when copied
- 📂 **Built-in file manager** — open, share, delete downloaded files
- 💾 **Storage info** — see free space in real-time
- 🌙 **Dark mode** — modern, native-feel UI
- 📴 **100% offline** — no analytics, no network calls (other than downloads)

---

## 🏗️ Architecture

```
Ledo Downloader Mobile APK
│
├── Web UI (Capacitor + Vanilla JS)
│   ├── index.html          Single-screen UI (no "connect to server")
│   ├── app.js              Main logic, plugin bridge
│   ├── style.css           Dark theme
│   └── url-detector.js     Smart URL classification
│
├── Native Plugins (Java)
│   ├── DownloaderPlugin    Capacitor bridge → native download manager
│   ├── DownloadTask        Single download w/ multi-threaded chunks
│   ├── DownloadService     Foreground service (keeps downloads running)
│   └── MainActivity        Plugin registration + share intent
│
└── Android Storage
    └── /storage/emulated/0/Android/data/com.ledo.downloader/files/Download/Ledo/
```

---

## 📦 Build

### Requirements
- **Java JDK 17+** (tested with 21.0.11)
- **Android SDK** (API 34+)
- **Node.js 18+** with npm
- **Gradle 8+** (bundled via wrapper)

### Build APK

```bash
cd mobile
npm install
npm run build
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`

### Quick build (one command)
```bash
build-apk.bat
```

### Install on device
```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

---

## 🚀 How It Works

### 1. User adds URL
The user pastes a URL into the input field. The `UrlDetector` classifies it:

| Type | Strategy | Example |
|------|----------|---------|
| **HTTP file** | Multi-threaded native download | `https://example.com/file.zip` |
| **Media URL** | Opens in browser (YouTube, etc.) | `https://youtube.com/watch?v=...` |
| **Direct video/audio** | Native download with format detection | `https://example.com/video.mp4` |
| **Unknown** | Tries HTTP download | Any other URL |

### 2. Native download starts
- `DownloaderPlugin.addDownload(url, filename, threads)` is called
- `DownloadTask` is created with the URL and thread count
- `DownloadService` is started as a foreground service (persistent notification)
- HEAD request gets the file size
- File is split into N chunks
- Each chunk downloads in parallel via HTTP Range requests
- Progress is reported to JS at 10fps via `notifyListeners`

### 3. Background execution
- App can be closed/swiped away
- `DownloadService` keeps running (Android foreground service contract)
- Notification shows current progress
- Tapping notification reopens the app

### 4. Completion
- Native side calls `onComplete` callback
- JS receives the file path
- File is moved to "Completed" tab
- User can Open, Share, or Delete

---

## 🎨 UI Design

The UI follows a **native Material Design 3** aesthetic with:

- **Dark theme by default** — easier on the eyes, saves battery on AMOLED
- **Single-screen layout** — no nested screens, everything in one view
- **Tabs** for Active / Completed downloads
- **Real-time progress** — speed, percentage, ETA via native callbacks
- **Toast notifications** — non-intrusive status updates
- **Bottom sheet** for settings (mobile-native pattern)

---

## 🔌 Plugin API (Capacitor)

The native `DownloaderPlugin` exposes the following methods to JavaScript:

```typescript
// Start a download
Downloader.addDownload({
    url: string,
    filename?: string,    // Auto-extracted from URL if not provided
    threads?: number      // Default: 8, max: 16
}) => Promise<{ taskId: string, filename: string, url: string }>

// Control
Downloader.pauseDownload({ taskId })
Downloader.resumeDownload({ taskId })
Downloader.cancelDownload({ taskId })

// Query
Downloader.getActiveDownloads() => { downloads: [...] }
Downloader.getCompletedDownloads() => { downloads: [...] }
Downloader.getStorageInfo() => { total, free, used }

// File operations
Downloader.openFile({ filePath })   // Open with default app
Downloader.shareFile({ filePath })  // Share via system sheet
Downloader.deleteFile({ filePath })

// Events
Downloader.onProgress(callback)  // { taskId, percent, speedBps, downloaded, total }
Downloader.onComplete(callback)  // { taskId, filePath }
Downloader.onError(callback)     // { taskId, error }
Downloader.onStatus(callback)    // { taskId, status }
```

---

## 📂 File Storage

Downloaded files are saved to:
```
/storage/emulated/0/Android/data/com.ledo.downloader/files/Download/Ledo/
```

This is the **app-specific external storage** — accessible to the user via:
- The app's "Completed" tab
- File managers (under `Android/data/com.ledo.downloader/`)
- The share menu

Files are NOT saved to public `Downloads/` to avoid Android 10+ scoped storage
restrictions. The app uses `FileProvider` to share files with other apps.

---

## 🔐 Permissions

Declared in `AndroidManifest.xml`:

```xml
<!-- Network -->
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />

<!-- Storage (Android 13+) -->
<uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />
<uses-permission android:name="android.permission.READ_MEDIA_AUDIO" />
<uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />

<!-- Foreground service for background downloads -->
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

All permissions are runtime-requested on first use (no upfront prompt).

---

## 🐛 Troubleshooting

### "Native plugin not available" warning
- Make sure you're running the **APK** (not the browser)
- Run `npm run sync` after pulling new code
- Reinstall the APK

### Downloads stuck at 0%
- Check your internet connection
- Some servers don't support `Range` requests — try a different URL
- Server might be rate-limiting

### File not found after download
- Files are in app-specific storage, not public Downloads
- Open via the "Completed" tab in the app
- Or use a file manager to navigate to `Android/data/com.ledo.downloader/`

### App crashes on start
- Check logcat: `adb logcat | grep Downloader`
- Make sure min SDK is 22+

---

## 🛠️ Development

### File structure
```
mobile/
├── www/                          # Frontend (Capacitor webDir)
│   ├── index.html                # Main UI
│   ├── app.js                    # Logic + plugin bridge
│   ├── url-detector.js           # URL classification
│   └── style.css                 # Styling
│
├── android/                      # Android native
│   └── app/src/main/
│       ├── AndroidManifest.xml   # Permissions + service
│       ├── java/com/ledo/downloader/
│       │   ├── MainActivity.java # Plugin registration
│       │   ├── DownloaderPlugin.java
│       │   ├── DownloadService.java
│       │   └── DownloadTask.java
│       └── res/xml/file_paths.xml
│
├── build-apk.bat                 # Quick build script
├── sync.js                       # Capacitor sync helper
└── package.json                  # npm dependencies
```

### Live reload during development
```bash
npm run dev    # Not configured yet — see TODO
```

For now, rebuild the APK after each change:
```bash
npm run build
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

---

## 📋 Roadmap

### ✅ Phase 1 (Done)
- [x] Multi-threaded HTTP downloader
- [x] Foreground service for background downloads
- [x] UI refactor (standalone, no server)
- [x] Smart URL detection
- [x] Share intent receiver
- [x] Pause/Resume/Cancel
- [x] File management (open/share/delete)
- [x] Storage info

### 🚧 Phase 2 (Future)
- [ ] yt-dlp integration for media downloads (YouTube, Instagram, etc.)
- [ ] Built-in video player
- [ ] Download queue with priorities
- [ ] Speed limiter + scheduler
- [ ] WiFi-only mode
- [ ] Auto-retry on failure

### 💡 Phase 3 (Ideas)
- [ ] Built-in browser (link grabber)
- [ ] QR code scanner (send URL from phone to laptop)
- [ ] iOS port (Capacitor supports it)
- [ ] Cloud sync of download history

---

## 📜 License

ISC © Waleed Amr

---

## 🙏 Credits

Built with:
- [Capacitor](https://capacitorjs.com/) — Native bridge
- [OkHttp](https://square.github.io/okhttp/) — HTTP client
- [AndroidX](https://developer.android.com/jetpack/androidx) — Core libraries
