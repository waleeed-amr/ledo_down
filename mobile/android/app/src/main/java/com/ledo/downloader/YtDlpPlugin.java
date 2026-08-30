package com.ledo.downloader;

import android.os.Environment;
import timber.log.Timber;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.yausername.youtubedl_android.YoutubeDL;
import com.yausername.youtubedl_android.YoutubeDLException;
import com.yausername.youtubedl_android.YoutubeDLRequest;
import com.yausername.youtubedl_android.mapper.VideoFormat;
import com.yausername.youtubedl_android.mapper.VideoInfo;

import java.io.File;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import android.webkit.CookieManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.app.NotificationManager;
import android.app.NotificationChannel;
import android.content.Context;
import android.os.Build;
import android.os.PowerManager;
import android.app.PendingIntent;
import android.content.Intent;
import androidx.core.app.NotificationCompat;

@CapacitorPlugin(name = "YtDlp")
public class YtDlpPlugin extends Plugin {
    private static final String TAG = "YtDlpPlugin";
    // Reuse threads to drastically reduce RAM consumption
    private final ExecutorService executorService = Executors.newFixedThreadPool(4);

    // -----------------------------------------------------------
    // Init race-condition guard
    // -----------------------------------------------------------
    // YoutubeDL.getInstance() throws "instance not initialized" if you
    // call getInfo()/execute() before init() finishes. init() extracts
    // the bundled yt-dlp binary and can take a few seconds on first
    // launch. We track the state with a flag + CountDownLatch so any
    // request that arrives before init completes waits (or fails with
    // a clear error) instead of crashing with a cryptic message.
    private volatile boolean isInitialized = false;
    private volatile String initError = null;
    private final CountDownLatch initLatch = new CountDownLatch(1);

    private void awaitInit() throws InterruptedException {
        if (isInitialized) return;
        // Wait up to 15s; the AAR extraction + chmod is the slow part.
        initLatch.await(15, TimeUnit.SECONDS);
    }

    private String getCookiesWithWebView(String url) {
        final String[] cookies = new String[1];
        final CountDownLatch latch = new CountDownLatch(1);
        
        getActivity().runOnUiThread(() -> {
            try {
                WebView webView = new WebView(getContext());
                webView.getSettings().setJavaScriptEnabled(true);
                webView.getSettings().setDomStorageEnabled(true);
                webView.setWebViewClient(new WebViewClient() {
                    @Override
                    public void onPageFinished(WebView view, String loadedUrl) {
                        cookies[0] = CookieManager.getInstance().getCookie(url);
                        latch.countDown();
                        // Deep clean to prevent memory leaks
                        view.clearCache(true);
                        view.clearHistory();
                        view.destroy(); 
                    }
                });
                webView.loadUrl(url);
            } catch (Exception e) {
                latch.countDown();
            }
        });
        
        try {
            latch.await(8, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            e.printStackTrace();
        }
        return cookies[0];
    }

    private void updateLiveNotification(int id, String title, String text, int progress) {
        try {
            NotificationManager manager = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) return;
            
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                NotificationChannel channel = new NotificationChannel("ledo_downloads", "Downloads", NotificationManager.IMPORTANCE_LOW);
                manager.createNotificationChannel(channel);
            }
            
            Intent openIntent = new Intent(getContext(), MainActivity.class);
            openIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent pendingIntent = PendingIntent.getActivity(
                getContext(), 0, openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );

            NotificationCompat.Builder builder = new NotificationCompat.Builder(getContext(), "ledo_downloads")
                .setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentIntent(pendingIntent)
                .setOngoing(progress < 100)
                .setOnlyAlertOnce(true)
                .setProgress(100, progress, progress == 0)
                .setPriority(NotificationCompat.PRIORITY_LOW);
                
            manager.notify(id, builder.build());
        } catch (Exception e) {
            Timber.e(e, "Notification error");
        }
    }

    @Override
    public void load() {
        super.load();
        executorService.execute(() -> {
            // Use the application context — YoutubeDL.init() stores paths
            // derived from it (getNoBackupFilesDir(), nativeLibraryDir)
            // and an activity context can be destroyed before the executor
            // task finishes, which is one of the documented ways init
            // throws on cold start.
            android.content.Context appCtx = getContext().getApplicationContext();
            try {
                // Defensive: pre-flight checks so we know which step
                // actually broke if init() still fails.
                Timber.i("YtDlp init step 1/3: appContext=%s, noBackup=%s",
                        appCtx.getPackageName(),
                        appCtx.getNoBackupFilesDir().getAbsolutePath());

                File noBackup = new File(appCtx.getNoBackupFilesDir(), "youtubedl-android");
                Timber.i("YtDlp init step 2/3: noBackup dir exists=%s writable=%s",
                        noBackup.exists(), noBackup.canWrite() || noBackup.mkdirs());

                YoutubeDL.getInstance().init(appCtx);
                isInitialized = true;
                initError = null;
                Timber.i("YoutubeDL initialized successfully (step 3/3 done)");
            } catch (Exception e) {
                // Walk the cause chain — YoutubeDL.init() wraps the real
                // problem (e.g. missing R.raw.ytdlp, libpython.zip.so unzip
                // failure, disk full) in a generic
                // YoutubeDLException("failed to initialize", cause).
                initError = describeError(e);
                Timber.e(e, "Failed to initialize YoutubeDL");
            } finally {
                initLatch.countDown();
            }
        });
    }

    /**
     * Concatenate every link in the exception chain so the JS layer
     * (and ultimately the user) sees the real reason instead of a
     * generic "failed to initialize" message.
     */
    private static String describeError(Throwable t) {
        if (t == null) return "unknown error";
        StringBuilder sb = new StringBuilder();
        sb.append(t.getClass().getSimpleName());
        if (t.getMessage() != null) sb.append(": ").append(t.getMessage());
        Throwable c = t.getCause();
        int depth = 0;
        while (c != null && depth < 6) {
            sb.append(" <- ");
            sb.append(c.getClass().getSimpleName());
            if (c.getMessage() != null) sb.append(": ").append(c.getMessage());
            c = c.getCause();
            depth++;
        }
        return sb.toString();
    }

    @PluginMethod
    public void fetchInfo(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("URL is required");
            return;
        }

        executorService.execute(() -> {
            try {
                // Wait for init — bounded so we never hang the plugin channel
                if (!isInitialized) {
                    awaitInit();
                    if (!isInitialized) {
                        String msg = "yt-dlp not ready" + (initError != null ? (": " + initError) : "");
                        call.reject(msg);
                        return;
                    }
                }

                YoutubeDLRequest request = new YoutubeDLRequest(url);
                String cookies = getCookiesWithWebView(url);
                if (cookies != null && !cookies.isEmpty()) {
                    request.addOption("--add-header", "Cookie:" + cookies);
                }
                VideoInfo streamInfo = YoutubeDL.getInstance().getInfo(request);

                JSObject result = new JSObject();
                result.put("title", streamInfo.getTitle());
                result.put("duration", streamInfo.getDuration());
                result.put("thumbnail", streamInfo.getThumbnail());

                JSArray formatsArray = new JSArray();
                if (streamInfo.getFormats() != null) {
                    for (VideoFormat f : streamInfo.getFormats()) {
                        JSObject fmt = new JSObject();
                        fmt.put("format_id", f.getFormatId());
                        fmt.put("ext", f.getExt());
                        fmt.put("format", f.getFormat()); // e.g. "303 - 1920x1080 (1080p)"
                        // VideoFormat.getFileSize() returns primitive long in this
                        // library version; 0 means "unknown". The bridge layer in
                        // mobile-bridge.js already falls back to 0 cleanly.
                        long sz = f.getFileSize();
                        fmt.put("filesize", sz);
                        fmt.put("vcodec", f.getVcodec());
                        fmt.put("acodec", f.getAcodec());
                        formatsArray.put(fmt);
                    }
                }
                result.put("formats", formatsArray);
                call.resolve(result);

            } catch (Exception e) {
                Timber.e(e, "Error fetching info");
                String msg = describeError(e);
                call.reject(msg);
            }
        });
    }

    @PluginMethod
    public void startDownload(PluginCall call) {
        String url = call.getString("url");
        String formatId = call.getString("formatId");

        if (url == null || url.isEmpty()) {
            call.reject("URL is required");
            return;
        }

        String taskId = UUID.randomUUID().toString();

        File downloadDir = new File(
            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
            "Ledo"
        );
        if (!downloadDir.exists()) {
            downloadDir.mkdirs();
        }

        executorService.execute(() -> {
            PowerManager powerManager = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            PowerManager.WakeLock wakeLock = null;
            if (powerManager != null) {
                wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Ledo::DownloadWakeLock");
                wakeLock.acquire(30 * 60 * 1000L); // 30 minutes max timeout as safety
            }

            try {
                // Wait for init before touching YoutubeDL — otherwise we crash
                // with "instance not initialized" on cold start.
                if (!isInitialized) {
                    awaitInit();
                    if (!isInitialized) {
                        String msg = "yt-dlp not ready" + (initError != null ? (": " + initError) : "");
                        throw new IllegalStateException(msg);
                    }
                }

                YoutubeDLRequest request = new YoutubeDLRequest(url);
                String cookies = getCookiesWithWebView(url);
                if (cookies != null && !cookies.isEmpty()) {
                    request.addOption("--add-header", "Cookie:" + cookies);
                }

                // Audio extraction: download ONLY audio stream, convert to MP3
                if ("audio".equals(formatId)) {
                    request.addOption("-f", "bestaudio/best");
                    request.addOption("--extract-audio");
                    request.addOption("--audio-format", "mp3");
                    request.addOption("--audio-quality", "5"); // Compact VBR ~130kbps (small file)
                } else if (formatId != null && !formatId.isEmpty()) {
                    request.addOption("-f", formatId);
                }

                // Speed and Stability optimizations (Maximized)
                request.addOption("--concurrent-fragments", "16");
                request.addOption("--http-chunk-size", "10M");
                request.addOption("--retries", "10");
                request.addOption("--fragment-retries", "10");
                request.addOption("--no-mtime");
                request.addOption("-o", downloadDir.getAbsolutePath() + "/%(title)s.%(ext)s");

                // Start event
                JSObject startData = new JSObject();
                startData.put("taskId", taskId);
                startData.put("status", "DOWNLOADING");
                notifyListeners("downloadStatus", startData);

                int notifyId = taskId.hashCode();
                updateLiveNotification(notifyId, "Starting Download...", url, 0);

                YoutubeDL.getInstance().execute(request, taskId, (progress, etaInSeconds, line) -> {
                    JSObject progressData = new JSObject();
                    progressData.put("taskId", taskId);
                    progressData.put("percent", progress);
                    progressData.put("eta", etaInSeconds);
                    notifyListeners("downloadProgress", progressData);

                    String statusText = String.format("%d%% | ETA: %ds", (int)(float)progress, etaInSeconds);
                    updateLiveNotification(notifyId, "Downloading", statusText, (int)(float)progress);
                    return kotlin.Unit.INSTANCE;
                });

                // Complete event
                updateLiveNotification(notifyId, "Download Complete", "Finished", 100);

                JSObject completeData = new JSObject();
                completeData.put("taskId", taskId);
                notifyListeners("downloadComplete", completeData);

            } catch (Exception e) {
                Timber.e(e, "Error downloading");
                String msg = describeError(e);
                updateLiveNotification(taskId.hashCode(), "Download Error", msg, 0);
                JSObject errorData = new JSObject();
                errorData.put("taskId", taskId);
                errorData.put("error", msg);
                notifyListeners("downloadError", errorData);
            } finally {
                if (wakeLock != null && wakeLock.isHeld()) {
                    wakeLock.release();
                }
            }
        });

        JSObject ret = new JSObject();
        ret.put("taskId", taskId);
        call.resolve(ret);
    }
}
