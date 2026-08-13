package app.onami.flashcards;

import android.app.Activity;
import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {
    private static final String TAG = "oNami";
    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        TransferService.attachActivity(this);

        int nightMode = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        applySystemBarTheme(nightMode == Configuration.UI_MODE_NIGHT_YES);

        webView = new WebView(this);
        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage consoleMessage) {
                Log.d(
                    TAG,
                    consoleMessage.message()
                        + " -- "
                        + consoleMessage.sourceId()
                        + ":"
                        + consoleMessage.lineNumber()
                );
                return true;
            }
        });

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowUniversalAccessFromFileURLs(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);

        webView.addJavascriptInterface(new AndroidBridge(), "onamiAndroid");
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        setContentView(webView);

        webView.loadUrl("file:///android_asset/public/index.html");
    }

    private void applySystemBarTheme(boolean dark) {
        Window window = getWindow();
        int backgroundColor = Color.parseColor(dark ? "#15171D" : "#FBF7EF");
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        window.setStatusBarColor(backgroundColor);
        window.setNavigationBarColor(backgroundColor);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.setNavigationBarDividerColor(backgroundColor);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setStatusBarContrastEnforced(false);
            window.setNavigationBarContrastEnforced(false);
        }

        int lightBarFlags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            lightBarFlags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }

        View decorView = window.getDecorView();
        int visibility = decorView.getSystemUiVisibility();
        visibility = dark ? visibility & ~lightBarFlags : visibility | lightBarFlags;
        decorView.setSystemUiVisibility(visibility);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = decorView.getWindowInsetsController();
            if (controller != null) {
                int appearanceMask =
                    WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                controller.setSystemBarsAppearance(dark ? 0 : appearanceMask, appearanceMask);
            }
        }

        if (webView != null) {
            webView.setBackgroundColor(backgroundColor);
        }
    }

    private class AndroidBridge {
        @JavascriptInterface
        public void setKeepScreenAwake(boolean enabled) {
            runOnUiThread(() -> {
                if (enabled) {
                    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } else {
                    getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }

        @JavascriptInterface
        public void setSystemBarTheme(boolean dark) {
            runOnUiThread(() -> applySystemBarTheme(dark));
        }

        @JavascriptInterface
        public void updateTransfer(String id, String title, String message, int current, int total) {
            TransferService.update(MainActivity.this, id, title, message, current, total);
        }

        @JavascriptInterface
        public void pauseTransfer(String id, String title, String message) {
            TransferService.pause(MainActivity.this, id, title, message);
        }

        @JavascriptInterface
        public void finishTransfer(
            String id,
            String title,
            String message,
            boolean succeeded,
            boolean hasMore
        ) {
            TransferService.finish(MainActivity.this, id, title, message, succeeded, hasMore);
        }
    }

    @Override
    protected void onDestroy() {
        if (!isChangingConfigurations()) TransferService.resumeHeadlessIfNeeded(this);
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }
}
