package dev.askii.app.plugins;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import java.nio.ByteBuffer;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * ScreenCaptureService — a foreground service that owns the MediaProjection
 * session and captures on-demand screenshots of the entire screen.
 *
 * Android 14+ (API 34+) requires MediaProjection to run inside a foreground
 * service of type `mediaProjection`. This service:
 *  1. Is started with the result code + data Intent from the permission dialog
 *  2. Creates a `MediaProjection` + `VirtualDisplay` + `ImageReader`
 *  3. Captures a single frame on demand via `captureFrame()`
 *  4. Is stopped when Control mode ends
 */
public class ScreenCaptureService extends Service {

    private static final String TAG = "ScreenCapture";
    private static final String CHANNEL_ID = "askii_screen_capture";
    private static final int NOTIFICATION_ID = 0xA5C2;
    private static final int VIRTUAL_DISPLAY_WIDTH = 1080;
    private static final int VIRTUAL_DISPLAY_HEIGHT = 1920;
    private static final int SCREENSHOT_TIMEOUT_MS = 3000;

    private static volatile ScreenCaptureService instance;

    private MediaProjection mediaProjection;
    private VirtualDisplay virtualDisplay;
    private ImageReader imageReader;
    private Handler uiHandler;

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        uiHandler = new Handler(Looper.getMainLooper());
        createNotificationChannel();
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        stopCapture();
        instance = null;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @SuppressLint("ForegroundServiceType")
    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && intent.hasExtra("resultCode")) {
            int resultCode = intent.getIntExtra("resultCode", 0);
            Intent data = intent.getParcelableExtra("data");
            if (data != null) {
                startForegroundWithNotification();
                startCapture(resultCode, data);
            }
        }
        return START_NOT_STICKY;
    }

    public static ScreenCaptureService getInstance() {
        return instance;
    }

    public static boolean isActive() {
        return instance != null && instance.mediaProjection != null;
    }

    // ── Capture lifecycle ──────────────────────────────────────────────────────

    private void startCapture(int resultCode, Intent data) {
        try {
            MediaProjectionManager manager = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            mediaProjection = manager.getMediaProjection(resultCode, data);
            if (mediaProjection == null) {
                Log.e(TAG, "Failed to get MediaProjection");
                stopSelf();
                return;
            }

            mediaProjection.registerCallback(new MediaProjection.Callback() {
                @Override
                public void onStop() {
                    stopCapture();
                    stopSelf();
                }
            }, uiHandler);

            imageReader = ImageReader.newInstance(
                    VIRTUAL_DISPLAY_WIDTH,
                    VIRTUAL_DISPLAY_HEIGHT,
                    PixelFormat.RGBA_8888,
                    2
            );

            virtualDisplay = mediaProjection.createVirtualDisplay(
                    "AskiiScreenCapture",
                    VIRTUAL_DISPLAY_WIDTH,
                    VIRTUAL_DISPLAY_HEIGHT,
                    getResources().getDisplayMetrics().densityDpi,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                    imageReader.getSurface(),
                    null,
                    uiHandler
            );

            Log.i(TAG, "MediaProjection started");
        } catch (Exception e) {
            Log.e(TAG, "startCapture failed: " + e.getMessage());
            stopSelf();
        }
    }

    private void stopCapture() {
        if (virtualDisplay != null) {
            virtualDisplay.release();
            virtualDisplay = null;
        }
        if (imageReader != null) {
            imageReader.setOnImageAvailableListener(null, null);
            imageReader.close();
            imageReader = null;
        }
        if (mediaProjection != null) {
            mediaProjection.stop();
            mediaProjection = null;
        }
    }

    // ── Screenshot capture ────────────────────────────────────────────────────

    /**
     * Capture a single frame from the VirtualDisplay. Returns a Bitmap or null
     * on failure. Must be called while the service is active.
     */
    public Bitmap captureFrame() {
        if (imageReader == null) return null;

        final CountDownLatch latch = new CountDownLatch(1);
        final AtomicReference<Bitmap> result = new AtomicReference<>(null);

        ImageReader.OnImageAvailableListener listener = reader -> {
            Image image = null;
            try {
                image = reader.acquireLatestImage();
                if (image != null) {
                    Bitmap bitmap = imageToBitmap(image);
                    result.set(bitmap);
                }
            } catch (Exception e) {
                Log.e(TAG, "captureFrame: " + e.getMessage());
            } finally {
                if (image != null) image.close();
                latch.countDown();
            }
        };

        imageReader.setOnImageAvailableListener(listener, uiHandler);

        try {
            latch.await(SCREENSHOT_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }

        imageReader.setOnImageAvailableListener(null, null);
        return result.get();
    }

    private Bitmap imageToBitmap(Image image) {
        Image.Plane[] planes = image.getPlanes();
        if (planes.length == 0) return null;

        ByteBuffer buffer = planes[0].getBuffer();
        int pixelStride = planes[0].getPixelStride();
        int rowStride = planes[0].getRowStride();
        int rowPadding = rowStride - pixelStride * image.getWidth();

        Bitmap bitmap = Bitmap.createBitmap(
                image.getWidth() + rowPadding / pixelStride,
                image.getHeight(),
                Bitmap.Config.ARGB_8888
        );
        buffer.rewind();
        bitmap.copyPixelsFromBuffer(buffer);

        // Crop to the actual width (remove padding)
        if (rowPadding > 0) {
            bitmap = Bitmap.createBitmap(bitmap, 0, 0, image.getWidth(), image.getHeight());
        }

        return bitmap;
    }

    // ── Notification ──────────────────────────────────────────────────────────

    private void createNotificationChannel() {
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                getString(R.string.askii_screen_capture_channel),
                NotificationManager.IMPORTANCE_LOW
        );
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private void startForegroundWithNotification() {
        Notification notification = new Notification.Builder(this, CHANNEL_ID)
                .setContentTitle(getString(R.string.askii_screen_capture_notification_title))
                .setContentText(getString(R.string.askii_screen_capture_notification_text))
                .setSmallIcon(android.R.drawable.ic_menu_camera)
                .setOngoing(true)
                .build();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }
}