package com.ledo.downloader;

import android.content.Context;
import android.os.Environment;
import android.util.Log;

import androidx.annotation.NonNull;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Represents a single download task with multi-threaded chunked downloading.
 * Splits file into N parallel chunks using HTTP Range requests.
 */
public class DownloadTask {
    public enum Status {
        PENDING, DOWNLOADING, PAUSED, COMPLETED, FAILED, CANCELLED
    }

    public interface Callback {
        void onProgress(String taskId, double percent, long speedBps, long downloaded, long total);
        void onComplete(String taskId, String filePath);
        void onError(String taskId, String error);
        void onStatusChange(String taskId, Status status);
    }

    private static final String TAG = "DownloadTask";
    private static final int CONNECT_TIMEOUT = 30;
    private static final int READ_TIMEOUT = 60;

    public final String id;
    public final String url;
    public final String filename;
    public final int threadCount;
    public final Context context;

    private final List<ChunkState> chunks = new ArrayList<>();
    private final AtomicLong totalDownloaded = new AtomicLong(0);
    private final AtomicBoolean isPaused = new AtomicBoolean(false);
    private final AtomicBoolean isCancelled = new AtomicBoolean(false);

    private long totalSize = 0;
    private long lastUpdateTime = 0;
    private long lastUpdateDownloaded = 0;
    private String filePath;
    private Status status = Status.PENDING;
    private Callback callback;
    private ExecutorService executor;
    private List<Future<?>> futures;

    public DownloadTask(String url, String filename, int threadCount, Context context) {
        this.id = UUID.randomUUID().toString();
        this.url = url;
        this.filename = filename != null ? filename : extractFilenameFromUrl(url);
        this.threadCount = Math.max(1, Math.min(threadCount, 16));
        this.context = context.getApplicationContext();
    }

    public void setCallback(Callback callback) {
        this.callback = callback;
    }

    public Status getStatus() {
        return status;
    }

    public String getFilePath() {
        return filePath;
    }

    public long getTotalSize() {
        return totalSize;
    }

    /**
     * Start the download in background thread.
     */
    public void start() {
        Thread starter = new Thread(() -> {
            try {
                // 1. Get file size
                totalSize = getFileSize(url);
                if (totalSize <= 0) {
                    fail("Could not determine file size (server may not support HEAD)");
                    return;
                }

                // 2. Setup output file
                File outputFile = createOutputFile();
                filePath = outputFile.getAbsolutePath();

                // 3. Calculate chunks
                long chunkSize = totalSize / threadCount;
                for (int i = 0; i < threadCount; i++) {
                    long start = i * chunkSize;
                    long end = (i == threadCount - 1) ? totalSize - 1 : (i + 1) * chunkSize - 1;
                    chunks.add(new ChunkState(i, start, end));
                }

                // 4. Update status
                setStatus(Status.DOWNLOADING);

                // 5. Start parallel chunk downloads
                executor = Executors.newFixedThreadPool(threadCount);
                futures = new ArrayList<>();

                for (ChunkState chunk : chunks) {
                    futures.add(executor.submit(() -> downloadChunk(chunk, outputFile)));
                }

                // 6. Wait for all chunks
                for (Future<?> future : futures) {
                    future.get();
                }

                executor.shutdown();
                executor.awaitTermination(5, TimeUnit.SECONDS);

                if (isCancelled.get()) {
                    outputFile.delete();
                    return;
                }

                if (isPaused.get()) {
                    // Should not reach here if paused correctly
                    return;
                }

                // 7. Verify file size
                if (outputFile.length() != totalSize) {
                    fail("File size mismatch: expected " + totalSize + " got " + outputFile.length());
                    return;
                }

                // 8. Mark complete
                setStatus(Status.COMPLETED);
                if (callback != null) callback.onComplete(id, filePath);

            } catch (Exception e) {
                Log.e(TAG, "Download failed", e);
                fail(e.getMessage() != null ? e.getMessage() : "Unknown error");
            }
        });
        starter.setName("DownloadTask-" + id);
        starter.start();
    }

    /**
     * Download a single chunk with Range request.
     */
    private void downloadChunk(ChunkState chunk, File outputFile) {
        HttpURLConnection connection = null;
        InputStream input = null;
        RandomAccessFile raf = null;

        try {
            URL urlObj = new URL(url);
            connection = (HttpURLConnection) urlObj.openConnection();
            connection.setConnectTimeout(CONNECT_TIMEOUT * 1000);
            connection.setReadTimeout(READ_TIMEOUT * 1000);
            connection.setRequestProperty("Range", "bytes=" + chunk.start + "-" + chunk.end);
            connection.setRequestProperty("User-Agent", "LedoDownloader/1.0 (Android)");

            int responseCode = connection.getResponseCode();
            if (responseCode != 200 && responseCode != 206) {
                throw new IOException("Server returned " + responseCode);
            }

            input = connection.getInputStream();
            raf = new RandomAccessFile(outputFile, "rw");
            raf.seek(chunk.start);

            byte[] buffer = new byte[8192];
            int read;
            long chunkDownloaded = 0;

            while ((read = input.read(buffer)) != -1) {
                if (isCancelled.get()) {
                    return;
                }

                if (isPaused.get()) {
                    // Wait for resume
                    while (isPaused.get() && !isCancelled.get()) {
                        try { Thread.sleep(500); } catch (InterruptedException ignored) {}
                    }
                    if (isCancelled.get()) return;
                }

                raf.write(buffer, 0, read);
                chunkDownloaded += read;
                chunk.downloaded.set(chunk.start + chunkDownloaded);

                // Update total downloaded atomically
                long newTotal = 0;
                for (ChunkState c : chunks) {
                    newTotal += c.downloaded.get() - c.start;
                }
                totalDownloaded.set(newTotal);

                // Throttle progress updates to ~10fps
                long now = System.currentTimeMillis();
                if (now - lastUpdateTime > 100) {
                    long deltaTime = now - lastUpdateTime;
                    long deltaDownloaded = newTotal - lastUpdateDownloaded;
                    long speed = deltaTime > 0 ? (deltaDownloaded * 1000 / deltaTime) : 0;
                    double percent = (newTotal * 100.0) / totalSize;

                    lastUpdateTime = now;
                    lastUpdateDownloaded = newTotal;

                    if (callback != null) {
                        callback.onProgress(id, percent, speed, newTotal, totalSize);
                    }
                }
            }

        } catch (Exception e) {
            Log.e(TAG, "Chunk " + chunk.index + " failed", e);
            if (!isCancelled.get()) {
                fail("Chunk " + chunk.index + ": " + e.getMessage());
            }
        } finally {
            try { if (input != null) input.close(); } catch (IOException ignored) {}
            try { if (raf != null) raf.close(); } catch (IOException ignored) {}
            if (connection != null) connection.disconnect();
        }
    }

    public void pause() {
        if (status == Status.DOWNLOADING) {
            isPaused.set(true);
            setStatus(Status.PAUSED);
        }
    }

    public void resume() {
        if (status == Status.PAUSED) {
            isPaused.set(false);
            setStatus(Status.DOWNLOADING);
        }
    }

    public void cancel() {
        isCancelled.set(true);
        isPaused.set(false); // Unblock paused threads
        setStatus(Status.CANCELLED);

        if (executor != null) {
            executor.shutdownNow();
        }

        // Delete partial file
        if (filePath != null) {
            new File(filePath).delete();
        }
    }

    private long getFileSize(String urlString) throws IOException {
        HttpURLConnection connection = null;
        try {
            URL urlObj = new URL(urlString);
            connection = (HttpURLConnection) urlObj.openConnection();
            connection.setConnectTimeout(CONNECT_TIMEOUT * 1000);
            connection.setReadTimeout(READ_TIMEOUT * 1000);
            connection.setRequestMethod("HEAD");
            connection.setRequestProperty("User-Agent", "LedoDownloader/1.0 (Android)");

            int responseCode = connection.getResponseCode();
            if (responseCode == 200) {
                String contentLength = connection.getHeaderField("Content-Length");
                if (contentLength != null) {
                    return Long.parseLong(contentLength);
                }
            } else if (responseCode == 206) {
                // Partial Content: Content-Length is the range size, not the
                // full file size. The total is in `Content-Range: bytes a-b/TOTAL`.
                String contentRange = connection.getHeaderField("Content-Range");
                if (contentRange != null && contentRange.contains("/")) {
                    String total = contentRange.split("/")[1];
                    return Long.parseLong(total);
                }
            }
            return -1;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private File createOutputFile() {
        File downloadsDir = new File(
            context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS),
            "Ledo"
        );
        if (!downloadsDir.exists()) {
            downloadsDir.mkdirs();
        }
        return new File(downloadsDir, filename);
    }

    private void setStatus(Status newStatus) {
        this.status = newStatus;
        if (callback != null) {
            callback.onStatusChange(id, newStatus);
        }
    }

    private void fail(String error) {
        setStatus(Status.FAILED);
        if (callback != null) {
            callback.onError(id, error);
        }
    }

    private String extractFilenameFromUrl(String url) {
        try {
            String path = new URL(url).getPath();
            int lastSlash = path.lastIndexOf('/');
            if (lastSlash >= 0 && lastSlash < path.length() - 1) {
                String name = path.substring(lastSlash + 1);
                if (name.contains(".")) {
                    // Decode any percent-encoded characters (e.g. %20 → space)
                    try {
                        name = java.net.URLDecoder.decode(name, "UTF-8");
                    } catch (Exception ignored) { /* keep raw name */ }
                    return name;
                }
            }
        } catch (Exception ignored) {}
        return "download_" + System.currentTimeMillis() + ".bin";
    }

    private static class ChunkState {
        final int index;
        final long start;
        final long end;
        final AtomicLong downloaded;

        ChunkState(int index, long start, long end) {
            this.index = index;
            this.start = start;
            this.end = end;
            this.downloaded = new AtomicLong(start);
        }
    }
}
