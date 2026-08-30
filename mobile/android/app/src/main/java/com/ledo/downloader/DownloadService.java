package com.ledo.downloader;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

/**
 * Foreground service that keeps downloads running when the app is closed.
 * Shows a persistent notification with download progress.
 */
public class DownloadService extends Service {
    private static final String CHANNEL_ID = "ledo_downloads";
    private static final int NOTIFICATION_ID = 1;
    private static final String ACTION_START = "com.ledo.downloader.START";
    private static final String ACTION_STOP = "com.ledo.downloader.STOP";

    public DownloadService() {
        super();
    }

    // Called when started from plugin (no Service binding needed)
    public DownloadService(Context context) {
        this();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        startForeground(NOTIFICATION_ID, buildNotification("Ledo Downloader", "Downloading..."));
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    public void startService() {
        try {
            Intent intent = new Intent(getContext(), DownloadService.class);
            intent.setAction(ACTION_START);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getContext().startForegroundService(intent);
            } else {
                getContext().startService(intent);
            }
        } catch (Exception e) {
            android.util.Log.e("DownloadService", "Failed to start service", e);
        }
    }

    public void stopService() {
        try {
            Intent intent = new Intent(getContext(), DownloadService.class);
            intent.setAction(ACTION_STOP);
            getContext().startService(intent);
        } catch (Exception e) {
            android.util.Log.e("DownloadService", "Failed to stop service", e);
        }
    }

    public void updateNotification(String title, String content) {
        updateProgressNotification(title, content, 100, 0, true);
    }

    public void updateProgressNotification(String title, String content, int max, int progress, boolean indeterminate) {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.notify(NOTIFICATION_ID, buildProgressNotification(title, content, max, progress, indeterminate));
        }
    }

    private Notification buildNotification(String title, String content) {
        return buildProgressNotification(title, content, 100, 0, true);
    }

    private Notification buildProgressNotification(String title, String content, int max, int progress, boolean indeterminate) {
        // Intent to open MainActivity when notification is tapped
        Intent openIntent = new Intent(getContext(), MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            getContext(), 0, openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        // Intent to stop service (action button)
        Intent stopIntent = new Intent(getContext(), DownloadService.class);
        stopIntent.setAction(ACTION_STOP);
        PendingIntent stopPendingIntent = PendingIntent.getService(
            getContext(), 1, stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(content)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setProgress(max, progress, indeterminate)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stopPendingIntent)
            .build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Downloads",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Active download progress");
            channel.setShowBadge(false);

            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    private Context getContext() {
        return this;
    }
}
