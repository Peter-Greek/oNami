package app.onami.flashcards;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Keeps WebView-backed Browse and Sync jobs alive after the activity is closed.
 * Java owns the foreground notification; JavaScript owns the durable transfer
 * queue and can therefore resume the exact job after a process death or force-stop.
 */
public class TransferService extends Service {
    private static final String CHANNEL_ID = "onami_transfers";
    private static final int FOREGROUND_NOTIFICATION_ID = 4201;
    private static final int COMPLETION_NOTIFICATION_ID = 4202;
    private static final String PREFS = "onami_transfer_service";
    private static final String ACTIVE = "active";
    private static final String TITLE = "title";
    private static final String MESSAGE = "message";
    private static final String ACTION_UPDATE = "app.onami.flashcards.UPDATE_TRANSFER";
    private static final String ACTION_PAUSE = "app.onami.flashcards.PAUSE_TRANSFER";
    private static final String ACTION_FINISH = "app.onami.flashcards.FINISH_TRANSFER";
    private static final String ACTION_RESUME_HEADLESS = "app.onami.flashcards.RESUME_HEADLESS";
    private static final String ACTION_ATTACH_ACTIVITY = "app.onami.flashcards.ATTACH_ACTIVITY";

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private WebView headlessWebView;
    private boolean activityAttached;

    public static void attachActivity(Context context) {
        if (!hasPendingTransfer(context)) return;
        start(context, new Intent(context, TransferService.class).setAction(ACTION_ATTACH_ACTIVITY));
    }

    public static void resumeHeadlessIfNeeded(Context context) {
        if (!hasPendingTransfer(context)) return;
        start(context, new Intent(context, TransferService.class).setAction(ACTION_RESUME_HEADLESS));
    }

    public static void update(
        Context context,
        String id,
        String title,
        String message,
        int current,
        int total
    ) {
        markActive(context, title, message);
        Intent intent = new Intent(context, TransferService.class)
            .setAction(ACTION_UPDATE)
            .putExtra("id", id)
            .putExtra(TITLE, title)
            .putExtra(MESSAGE, message)
            .putExtra("current", current)
            .putExtra("total", total);
        start(context, intent);
    }

    public static void pause(Context context, String id, String title, String message) {
        markActive(context, title, message);
        Intent intent = new Intent(context, TransferService.class)
            .setAction(ACTION_PAUSE)
            .putExtra("id", id)
            .putExtra(TITLE, title)
            .putExtra(MESSAGE, message);
        start(context, intent);
    }

    public static void finish(
        Context context,
        String id,
        String title,
        String message,
        boolean succeeded,
        boolean hasMore
    ) {
        if (hasMore) markActive(context, title, message);
        else context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().commit();
        Intent intent = new Intent(context, TransferService.class)
            .setAction(ACTION_FINISH)
            .putExtra("id", id)
            .putExtra(TITLE, title)
            .putExtra(MESSAGE, message)
            .putExtra("succeeded", succeeded)
            .putExtra("hasMore", hasMore);
        start(context, intent);
    }

    private static void start(Context context, Intent intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent);
        else context.startService(intent);
    }

    private static boolean hasPendingTransfer(Context context) {
        return context.getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(ACTIVE, false);
    }

    private static void markActive(Context context, String title, String message) {
        // Commit synchronously before dispatching the service intent. If the user
        // swipes the activity away immediately, onDestroy can already see that a
        // headless handoff is required.
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(ACTIVE, true)
            .putString(TITLE, title == null ? "oNami transfer" : title)
            .putString(MESSAGE, message == null ? "Transfer in progress" : message)
            .commit();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_RESUME_HEADLESS : intent.getAction();
        SharedPreferences preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
        String savedTitle = preferences.getString(TITLE, "oNami transfer");
        String savedMessage = preferences.getString(MESSAGE, "Restoring transfer…");

        if (ACTION_ATTACH_ACTIVITY.equals(action)) {
            activityAttached = true;
            if (preferences.getBoolean(ACTIVE, false)) {
                startForeground(FOREGROUND_NOTIFICATION_ID, buildNotification(savedTitle, savedMessage, 0, 0, true, true));
            }
            destroyHeadlessWebView();
            return START_STICKY;
        }

        if (ACTION_FINISH.equals(action)) {
            boolean hasMore = intent.getBooleanExtra("hasMore", false);
            boolean succeeded = intent.getBooleanExtra("succeeded", false);
            String title = intent.getStringExtra(TITLE);
            String message = intent.getStringExtra(MESSAGE);
            if (hasMore) {
                saveActive(title, message);
                startForeground(
                    FOREGROUND_NOTIFICATION_ID,
                    buildNotification(title, message, 0, 0, true, true)
                );
            } else {
                // Every intent is dispatched with startForegroundService on
                // Android 8+. Even a duplicate terminal intent must promote
                // itself before stopping, or Android can terminate the app with
                // ForegroundServiceDidNotStartInTimeException.
                startForeground(
                    FOREGROUND_NOTIFICATION_ID,
                    buildNotification(title, message, 1, 1, true, false)
                );
                preferences.edit().clear().apply();
                stopForeground(true);
                notificationManager().notify(
                    COMPLETION_NOTIFICATION_ID,
                    buildNotification(title, message, 1, 1, false, !succeeded)
                );
                destroyHeadlessWebView();
                stopSelf();
            }
            return START_NOT_STICKY;
        }

        if (ACTION_UPDATE.equals(action) || ACTION_PAUSE.equals(action)) {
            String title = intent.getStringExtra(TITLE);
            String message = intent.getStringExtra(MESSAGE);
            int current = intent.getIntExtra("current", 0);
            int total = intent.getIntExtra("total", 0);
            boolean paused = ACTION_PAUSE.equals(action);
            saveActive(title, message);
            startForeground(
                FOREGROUND_NOTIFICATION_ID,
                buildNotification(title, message, current, total, true, paused || total <= 0)
            );
            return START_STICKY;
        }

        if (preferences.getBoolean(ACTIVE, false)) {
            activityAttached = false;
            startForeground(FOREGROUND_NOTIFICATION_ID, buildNotification(savedTitle, savedMessage, 0, 0, true, true));
            mainHandler.postDelayed(this::startHeadlessWebView, 400);
            return START_STICKY;
        }

        stopSelf();
        return START_NOT_STICKY;
    }

    private void saveActive(String title, String message) {
        getSharedPreferences(PREFS, MODE_PRIVATE)
            .edit()
            .putBoolean(ACTIVE, true)
            .putString(TITLE, title == null ? "oNami transfer" : title)
            .putString(MESSAGE, message == null ? "Transfer in progress" : message)
            .apply();
    }

    private void startHeadlessWebView() {
        if (activityAttached || headlessWebView != null || !hasPendingTransfer(this)) return;
        headlessWebView = new WebView(getApplicationContext());
        WebSettings settings = headlessWebView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowUniversalAccessFromFileURLs(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        headlessWebView.setWebViewClient(new WebViewClient());
        headlessWebView.addJavascriptInterface(new ServiceBridge(), "onamiAndroid");
        headlessWebView.loadUrl("file:///android_asset/public/index.html?headless=1");
    }

    private void destroyHeadlessWebView() {
        if (headlessWebView == null) return;
        headlessWebView.stopLoading();
        headlessWebView.removeJavascriptInterface("onamiAndroid");
        headlessWebView.destroy();
        headlessWebView = null;
    }

    private Notification buildNotification(
        String title,
        String message,
        int current,
        int total,
        boolean ongoing,
        boolean indeterminate
    ) {
        Intent launchIntent = new Intent(this, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
            this,
            0,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0)
        );
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);
        builder
            .setSmallIcon(R.drawable.onami_icon)
            .setContentTitle(title == null ? "oNami transfer" : title)
            .setContentText(message == null ? "Transfer in progress" : message)
            .setStyle(new Notification.BigTextStyle().bigText(message))
            .setContentIntent(contentIntent)
            .setOnlyAlertOnce(true)
            .setOngoing(ongoing)
            .setAutoCancel(!ongoing)
            .setCategory(Notification.CATEGORY_PROGRESS);
        if (ongoing) builder.setProgress(Math.max(total, 0), Math.max(current, 0), indeterminate || total <= 0);
        return builder.build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Downloads and uploads",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Live progress for oNami Browse and Sync transfers");
        notificationManager().createNotificationChannel(channel);
    }

    private NotificationManager notificationManager() {
        return (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    }

    @Override
    public void onDestroy() {
        destroyHeadlessWebView();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private class ServiceBridge {
        @JavascriptInterface
        public void setKeepScreenAwake(boolean enabled) {
            // A foreground service keeps transfers alive without holding the display awake.
        }

        @JavascriptInterface
        public void setSystemBarTheme(boolean dark) {
            // The headless WebView has no system bars.
        }

        @JavascriptInterface
        public void updateTransfer(String id, String title, String message, int current, int total) {
            mainHandler.post(() -> TransferService.update(TransferService.this, id, title, message, current, total));
        }

        @JavascriptInterface
        public void pauseTransfer(String id, String title, String message) {
            mainHandler.post(() -> TransferService.pause(TransferService.this, id, title, message));
        }

        @JavascriptInterface
        public void finishTransfer(
            String id,
            String title,
            String message,
            boolean succeeded,
            boolean hasMore
        ) {
            mainHandler.post(() -> TransferService.finish(TransferService.this, id, title, message, succeeded, hasMore));
        }
    }
}
