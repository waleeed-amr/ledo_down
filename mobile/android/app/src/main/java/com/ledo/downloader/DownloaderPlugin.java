package com.ledo.downloader;

import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Capacitor plugin that exposes multi-threaded download functionality to JavaScript.
 *
 * Methods:
 * - addDownload({ url, filename?, threads? }) → { taskId }
 * - pauseDownload({ taskId })
 * - resumeDownload({ taskId })
 * - cancelDownload({ taskId })
 * - getActiveDownloads() → { downloads: [...] }
 * - getCompletedDownloads() → { downloads: [...] }
 * - openFile({ filePath }) → opens in default app
 * - deleteFile({ filePath })
 *
 * Events:
 * - "downloadProgress" → { taskId, percent, speedBps, downloaded, total }
 * - "downloadComplete" → { taskId, filePath }
 * - "downloadError" → { taskId, error }
 * - "downloadStatus" → { taskId, status }
 */
@CapacitorPlugin(name = "Downloader")
public class DownloaderPlugin extends Plugin {
    private static final String TAG = "DownloaderPlugin";

    private final Map<String, DownloadTask> activeTasks = new ConcurrentHashMap<>();
    private final List<CompletedDownload> completedDownloads = new ArrayList<>();
    private DownloadService downloadService;

    @Override
    public void load() {
        super.load();
        downloadService = new DownloadService(getContext());
        Log.i(TAG, "DownloaderPlugin loaded");
    }

    @PluginMethod
    public void addDownload(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("URL is required");
            return;
        }

        String filename = call.getString("filename");
        Integer threads = call.getInt("threads");
        int threadCount = threads != null ? threads : 8;

        DownloadTask task = new DownloadTask(url, filename, threadCount, getContext());
        task.setCallback(new DownloadTask.Callback() {
            @Override
            public void onProgress(String taskId, double percent, long speedBps, long downloaded, long total) {
                JSObject data = new JSObject();
                data.put("taskId", taskId);
                data.put("percent", percent);
                data.put("speedBps", speedBps);
                data.put("downloaded", downloaded);
                data.put("total", total);
                notifyListeners("downloadProgress", data);
            }

            @Override
            public void onComplete(String taskId, String filePath) {
                activeTasks.remove(taskId);
                completedDownloads.add(new CompletedDownload(filePath, System.currentTimeMillis()));

                JSObject data = new JSObject();
                data.put("taskId", taskId);
                data.put("filePath", filePath);
                notifyListeners("downloadComplete", data);
            }

            @Override
            public void onError(String taskId, String error) {
                activeTasks.remove(taskId);

                JSObject data = new JSObject();
                data.put("taskId", taskId);
                data.put("error", error);
                notifyListeners("downloadError", data);
            }

            @Override
            public void onStatusChange(String taskId, DownloadTask.Status status) {
                JSObject data = new JSObject();
                data.put("taskId", taskId);
                data.put("status", status.name());
                notifyListeners("downloadStatus", data);
            }
        });

        activeTasks.put(task.id, task);

        // Start foreground service to keep downloads running
        downloadService.startService();

        // Start the download
        task.start();

        JSObject ret = new JSObject();
        ret.put("taskId", task.id);
        ret.put("filename", task.filename);
        ret.put("url", task.url);
        call.resolve(ret);
    }

    @PluginMethod
    public void pauseDownload(PluginCall call) {
        String taskId = call.getString("taskId");
        if (taskId == null) {
            call.reject("taskId is required");
            return;
        }

        DownloadTask task = activeTasks.get(taskId);
        if (task != null) {
            task.pause();
            call.resolve();
        } else {
            call.reject("Task not found");
        }
    }

    @PluginMethod
    public void resumeDownload(PluginCall call) {
        String taskId = call.getString("taskId");
        if (taskId == null) {
            call.reject("taskId is required");
            return;
        }

        DownloadTask task = activeTasks.get(taskId);
        if (task != null) {
            task.resume();
            call.resolve();
        } else {
            call.reject("Task not found");
        }
    }

    @PluginMethod
    public void cancelDownload(PluginCall call) {
        String taskId = call.getString("taskId");
        if (taskId == null) {
            call.reject("taskId is required");
            return;
        }

        DownloadTask task = activeTasks.remove(taskId);
        if (task != null) {
            task.cancel();
            call.resolve();
        } else {
            call.reject("Task not found");
        }
    }

    @PluginMethod
    public void getActiveDownloads(PluginCall call) {
        JSArray tasks = new JSArray();
        for (DownloadTask task : activeTasks.values()) {
            JSObject taskObj = new JSObject();
            taskObj.put("taskId", task.id);
            taskObj.put("url", task.url);
            taskObj.put("filename", task.filename);
            taskObj.put("status", task.getStatus().name());
            taskObj.put("totalSize", task.getTotalSize());
            tasks.put(taskObj);
        }

        JSObject ret = new JSObject();
        ret.put("downloads", tasks);
        call.resolve(ret);
    }

    @PluginMethod
    public void getCompletedDownloads(PluginCall call) {
        JSArray tasks = new JSArray();
        synchronized (completedDownloads) {
            for (CompletedDownload download : completedDownloads) {
                JSObject taskObj = new JSObject();
                taskObj.put("filePath", download.filePath);
                taskObj.put("filename", download.filePath.substring(download.filePath.lastIndexOf("/") + 1));
                taskObj.put("completedAt", download.completedAt);
                tasks.put(taskObj);
            }
        }

        JSObject ret = new JSObject();
        ret.put("downloads", tasks);
        call.resolve(ret);
    }

    @PluginMethod
    public void openFile(PluginCall call) {
        String filePath = call.getString("filePath");
        if (filePath == null) {
            call.reject("filePath is required");
            return;
        }

        try {
            java.io.File file = new java.io.File(filePath);
            if (!file.exists()) {
                call.reject("File not found");
                return;
            }

            android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_VIEW);
            android.net.Uri uri = androidx.core.content.FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                file
            );

            String mimeType = android.webkit.MimeTypeMap.getSingleton()
                .getMimeTypeFromExtension(
                    filePath.substring(filePath.lastIndexOf(".") + 1).toLowerCase()
                );
            if (mimeType == null) mimeType = "*/*";

            intent.setDataAndType(uri, mimeType);
            intent.addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);

            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "Failed to open file", e);
            call.reject("Failed to open file: " + e.getMessage());
        }
    }

    @PluginMethod
    public void deleteFile(PluginCall call) {
        String filePath = call.getString("filePath");
        if (filePath == null) {
            call.reject("filePath is required");
            return;
        }

        java.io.File file = new java.io.File(filePath);
        if (file.exists() && file.delete()) {
            call.resolve();
        } else {
            call.reject("Failed to delete file");
        }
    }

    @PluginMethod
    public void getStorageInfo(PluginCall call) {
        try {
            android.os.StatFs stat = new android.os.StatFs(
                android.os.Environment.getExternalStorageDirectory().getPath()
            );
            long total = (long) stat.getBlockCountLong() * stat.getBlockSizeLong();
            long free = (long) stat.getAvailableBlocksLong() * stat.getBlockSizeLong();

            JSObject ret = new JSObject();
            ret.put("total", total);
            ret.put("free", free);
            ret.put("used", total - free);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to get storage info: " + e.getMessage());
        }
    }

    @PluginMethod
    public void shareFile(PluginCall call) {
        String filePath = call.getString("filePath");
        if (filePath == null) {
            call.reject("filePath is required");
            return;
        }

        try {
            java.io.File file = new java.io.File(filePath);
            if (!file.exists()) {
                call.reject("File not found");
                return;
            }

            android.content.Intent shareIntent = new android.content.Intent(android.content.Intent.ACTION_SEND);
            android.net.Uri uri = androidx.core.content.FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                file
            );

            shareIntent.setType("*/*");
            shareIntent.putExtra(android.content.Intent.EXTRA_STREAM, uri);
            shareIntent.addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);

            android.content.Intent chooser = android.content.Intent.createChooser(shareIntent, "Share file");
            chooser.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(chooser);

            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "Failed to share file", e);
            call.reject("Failed to share file: " + e.getMessage());
        }
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        // Cancel all active downloads when plugin is destroyed
        for (DownloadTask task : activeTasks.values()) {
            task.cancel();
        }
        activeTasks.clear();
        downloadService.stopService();
    }

    private static class CompletedDownload {
        final String filePath;
        final long completedAt;

        CompletedDownload(String filePath, long completedAt) {
            this.filePath = filePath;
            this.completedAt = completedAt;
        }
    }
}
