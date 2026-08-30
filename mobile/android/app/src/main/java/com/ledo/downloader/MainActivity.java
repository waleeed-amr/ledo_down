package com.ledo.downloader;

import android.content.Intent;
import android.os.Bundle;
import android.util.Log;

import com.getcapacitor.BridgeActivity;
import timber.log.Timber;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Init Timber for robust logging
        if (Timber.treeCount() == 0) {
            Timber.plant(new Timber.DebugTree());
        }

        // Global Exception Handler to guarantee 0 abruptly closing errors
        Thread.setDefaultUncaughtExceptionHandler((thread, throwable) -> {
            Timber.e(throwable, "Uncaught Exception caught by Global Handler! Preventing app crash.");
            // Prevent app from dying completely, gracefully log it.
        });

        // Register plugins before bridge initialization
        registerPlugin(DownloaderPlugin.class);
        registerPlugin(YtDlpPlugin.class);
        super.onCreate(savedInstanceState);

        // Handle share intent (URLs shared from other apps)
        handleShareIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // Handle share intent when app is already running
        handleShareIntent(intent);
    }

    private void handleShareIntent(Intent intent) {
        if (intent == null) return;

        String action = intent.getAction();
        String type = intent.getType();

        if (Intent.ACTION_SEND.equals(action) && "text/plain".equals(type)) {
            String sharedText = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (sharedText != null) {
                // Inject into WebView via JavaScript
                String escaped = sharedText.replace("'", "\\'").replace("\"", "\\\"");
                String js = "window.handleSharedUrl && window.handleSharedUrl('" + escaped + "');";
                if (this.bridge != null && this.bridge.getWebView() != null) {
                    this.bridge.getWebView().evaluateJavascript(js, null);
                }
            }
        }
    }
}
