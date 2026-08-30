# Ledo Downloader Mobile — Improved Plan

> **المبدأ**: App native حقيقي على الموبايل، 100% offline، مفيش سيرفر خالص. كل حاجة شغالة locally على الجهاز.

---

## 🎯 الأهداف

1. ❌ **بدون سيرفر** — لا backend، لا API calls خارجية (غير الـ URL نفسه)
2. ❌ **بدون اشتراك** — مجاني تماماً
3. ✅ **Multi-threaded downloads** — مثل Desktop
4. ✅ **Background downloads** — تفضل شغالة حتى لو قفلت الـ app
5. ✅ **Smart URL detection** — يفرّق بين ملف مباشر و media
6. ✅ **Pause/Resume** — للملفات الكبيرة
7. ✅ **Share intent** — استقبال URLs من أي app

---

## 🏗️ Architecture

```
┌────────────────────────────────────────────────┐
│         Ledo Downloader Mobile APK             │
│                                                │
│  ┌──────────────────────────────────────────┐ │
│  │  Web UI (Capacitor + Vanilla JS)         │ │
│  │  - URL bar                               │ │
│  │  - Active downloads list                 │ │
│  │  - Completed files browser               │ │
│  │  - Settings                              │ │
│  └──────────────────────────────────────────┘ │
│                    ↕ Capacitor Bridge          │
│  ┌──────────────────────────────────────────┐ │
│  │  Native Plugins (Kotlin)                 │ │
│  │                                          │ │
│  │  [DownloaderPlugin]                      │ │
│  │    • Multi-threaded HTTP (OkHttp)        │ │
│  │    • Range requests (parallel chunks)    │ │
│  │    • Pause/Resume support                │ │
│  │    • Progress callbacks to JS            │ │
│  │                                          │ │
│  │  [UrlDetectorPlugin]                     │ │
│  │    • Smart URL classification            │ │
│  │    • HTTP file vs Media URL              │ │
│  │    • Extract filename from URL           │ │
│  │                                          │ │
│  │  [FileManagerPlugin]                     │ │
│  │    • Read/downloaded files               │ │
│  │    • Delete operations                   │ │
│  │    • Share to other apps                 │ │
│  └──────────────────────────────────────────┘ │
│                    ↕                           │
│  ┌──────────────────────────────────────────┐ │
│  │  DownloadService (Foreground Service)    │ │
│  │  - Keeps downloads running when closed   │ │
│  │  - Persistent notification               │ │
│  │  - Auto-restart on device boot           │ │
│  └──────────────────────────────────────────┘ │
│                    ↕                           │
│  ┌──────────────────────────────────────────┐ │
│  │  Android Storage                         │ │
│  │  /storage/emulated/0/Download/Ledo/      │ │
│  └──────────────────────────────────────────┘ │
└────────────────────────────────────────────────┘
```

---

## 📁 File Structure

```
mobile/
├── www/                          # Frontend
│   ├── index.html                # Single-screen UI (no connect screen)
│   ├── app.js                    # Main logic
│   ├── style.css                 # Dark theme
│   ├── url-detector.js           # Smart URL detection
│   ├── downloader-ui.js          # Download list rendering
│   ├── player.html               # In-app video player
│   └── icons/                    # SVG icons
│
├── android/                      # Native Android
│   └── app/src/main/
│       ├── AndroidManifest.xml   # Permissions + Service registration
│       ├── java/com/ledo/downloader/
│       │   ├── MainActivity.java # Register plugins
│       │   ├── DownloaderPlugin.java
│       │   ├── DownloadService.java
│       │   ├── DownloadTask.java
│       │   ├── UrlDetector.java
│       │   └── FileManager.java
│       └── res/
│           ├── layout/
│           │   └── notification.xml
│           └── values/
│               └── strings.xml
│
└── IMPROVED_PLAN.md              # This file
```

---

## 🔄 Flow Diagram

### User adds URL:
```
1. User pastes URL
   ↓
2. UrlDetector classifies it
   ├─→ HTTP file (e.g., example.com/file.zip)
   │   ↓
   │   DownloaderPlugin.addDownload(url, filename)
   │   ↓
   │   Returns taskId, starts in background
   │   ↓
   │   UI shows progress via listeners
   │
   └─→ Media URL (e.g., youtube.com/...)
       ↓
       Opens in Capacitor Browser
       (or routes to yt-dlp if installed)
```

### Background download:
```
1. App closed by user
   ↓
2. DownloadService still running (Foreground Service)
   ↓
3. Notification shows progress
   ↓
4. User can tap notification to reopen app
   ↓
5. On completion → notification with "Open" action
```

---

## 🎨 UI Design Principles

1. **Single-screen** — لا "connect to server" screen
2. **Material Design 3** — native feel
3. **Dark mode first** — matching Ledo Player aesthetic
4. **Smooth animations** — 60fps transitions
5. **Pull-to-refresh** — sync UI with native state
6. **Bottom sheet** — for download details
7. **FAB** — floating action button for "Add URL"

---

## 🔐 Permissions

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE"
    android:maxSdkVersion="28" />
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE"
    android:maxSdkVersion="32" />
<uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />
<uses-permission android:name="android.permission.READ_MEDIA_AUDIO" />
<uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
```

---

## 📦 Distribution

### Free Channels:
1. **GitHub Releases** — APK download
2. **Telegram Channel** — link + notifications
3. **F-Droid** (later) — open source app store
4. **Direct APK** — WhatsApp/Telegram sharing

### Build:
```bash
cd mobile
npm run build
# Output: android/app/build/outputs/apk/release/app-release.apk
```

---

## 🚀 Implementation Phases

### Phase 1: Core HTTP Downloader (MUST)
- [x] Plan & architecture
- [ ] DownloaderPlugin (Kotlin)
- [ ] DownloadService (background)
- [ ] AndroidManifest updates
- [ ] MainActivity registration
- [ ] Build & test

### Phase 2: UI Refactor (MUST)
- [ ] New index.html (single-screen)
- [ ] Remove "Connect to Server"
- [ ] Smart URL input
- [ ] Download list with progress
- [ ] Settings page

### Phase 3: Enhancements (SHOULD)
- [ ] UrlDetector plugin
- [ ] Share intent handler (JS)
- [ ] In-app video player
- [ ] File manager
- [ ] Speed graph

### Phase 4: Media Downloads (COULD)
- [ ] yt-dlp binary integration
- [ ] Platform-specific extractors
- [ ] Format selection UI

### Phase 5: Distribution (FINAL)
- [ ] Self-signed APK
- [ ] GitHub Releases
- [ ] Telegram bot for updates
- [ ] Documentation

---

## 🧪 Testing Checklist

- [ ] Download small file (< 10MB)
- [ ] Download large file (> 100MB)
- [ ] Pause and resume
- [ ] Cancel mid-download
- [ ] Background download (close app)
- [ ] Multiple concurrent downloads
- [ ] Network change (WiFi → 4G)
- [ ] Share URL from browser
- [ ] Smart clipboard detection
- [ ] Open completed file

---

## 💡 Improvements over Original

| الميزة | القديم (Remote Control) | الجديد (Standalone) |
|--------|------------------------|---------------------|
| Backend | يحتاج PC شغال | ❌ مفيش |
| WiFi | لازم نفس الشبكة | ✅ أي مكان |
| السرعة | حسب PC | حسب الموبايل مباشرة |
| Battery | يستهلك PC + Mobile | الموبايل بس |
| Privacy | URLs تروح على PC | 100% local |
| Offline | ❌ لازم online للـ backend | ✅ الـ app offline، بس الـ download online |
| Multiple users | ❌ جهاز واحد بس | ✅ كل واحد عنده app مستقل |
| Setup | Install PC + Mobile | Install Mobile بس |

---

## 📊 Expected Performance

- **Download speed**: limited by network (not by app)
- **Memory**: ~50-100MB (depends on concurrent downloads)
- **APK size**: ~8-10MB
- **Battery**: moderate (foreground service)

---

## 🎯 Success Criteria

✅ App يفتح ويبدأ فوراً (no setup)
✅ User يلصق URL ويبدأ download
✅ Download يفضل شغال حتى لو قفل الـ app
✅ User يقدر يعمل pause/resume/cancel
✅ Files بتتحفظ في `/Download/Ledo/`
✅ User يقدر يفتح الـ file بعد ما يخلص
✅ App بيشتغل 100% بدون internet connection (غير للتحميل نفسه)
✅ Smart detection: HTTP file → native downloader، Media URL → browser
