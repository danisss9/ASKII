package dev.askii.app.plugins;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Base64;
import android.view.Display;
import android.view.WindowManager;

import com.getcapacitor.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;

/**
 * AskiiScreen — screen-control agent plugin for Android.
 *
 * Combines two native capabilities:
 *  1. **Screenshots** via `MediaProjection` (managed by `ScreenCaptureService`,
 *     a foreground service). Requires a one-time permission dialog.
 *  2. **Gesture/keyboard dispatch** via `AskiiAccessibilityService`. Requires
 *     the user to enable the ASKII accessibility service in Settings →
 *     Accessibility.
 *
 * `requestPermissions()` handles both: it launches the MediaProjection dialog
 * and checks/redirects to the Accessibility settings if the service isn't
 * enabled yet.
 *
 * `screenshot()` captures a single frame and returns it as a PNG data URL.
 * `execute(action)` dispatches a gesture or key input via the accessibility
 * service.
 */
@CapacitorPlugin(name = "AskiiScreen")
public class AskiiScreenPlugin extends Plugin {

    private static final int REQUEST_SCREEN_CAPTURE = 9001;
    private static final int SCREENSHOT_QUALITY = 80;

    private final Handler uiHandler = new Handler(Looper.getMainLooper());
    private boolean screenCaptureGranted = false;
    private PluginCall pendingPermissionsCall;

    // ── requestPermissions ────────────────────────────────────────────────────

    @PluginMethod
    public void requestPermissions(PluginCall call) {
        // Check accessibility service
        boolean accessibilityEnabled = AskiiAccessibilityService.isEnabled();

        // Request MediaProjection permission
        MediaProjectionManager manager = (MediaProjectionManager) getActivity()
                .getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        Intent screenCaptureIntent = manager.createScreenCaptureIntent();

        pendingPermissionsCall = call;
        startActivityForResult(call, screenCaptureIntent, "onScreenCaptureResult");
    }

    @ActivityCallback
    private void onScreenCaptureResult(PluginCall call, ActivityResult result) {
        if (result.getResultCode() == Activity.RESULT_OK && result.getData() != null) {
            screenCaptureGranted = true;

            // Start the ScreenCaptureService with the granted permission
            Intent serviceIntent = new Intent(getActivity(), ScreenCaptureService.class);
            serviceIntent.putExtra("resultCode", result.getResultCode());
            serviceIntent.putExtra("data", result.getData());
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getActivity().startForegroundService(serviceIntent);
            } else {
                getActivity().startService(serviceIntent);
            }
        }

        // Check accessibility
        boolean accessibilityEnabled = AskiiAccessibilityService.isEnabled();

        JSObject ret = new JSObject();
        ret.put("screenCapture", screenCaptureGranted);
        ret.put("accessibility", accessibilityEnabled);

        if (!accessibilityEnabled) {
            // Prompt user to enable accessibility
            ret.put("accessibilitySettingsUrl", "android.settings.ACCESSIBILITY_SETTINGS");
        }

        call.resolve(ret);
    }

    // ── screenshot ────────────────────────────────────────────────────────────

    @PluginMethod
    public void screenshot(PluginCall call) {
        if (!ScreenCaptureService.isActive()) {
            call.reject("Screen capture not active. Call requestPermissions first.");
            return;
        }

        // Capture on the UI thread (MediaProjection requires it)
        uiHandler.post(() -> {
            try {
                Bitmap bitmap = ScreenCaptureService.getInstance().captureFrame();
                if (bitmap == null) {
                    call.reject("Failed to capture screen");
                    return;
                }

                // Get screen dimensions
                WindowManager wm = (WindowManager) getActivity().getSystemService(Context.WINDOW_SERVICE);
                Display display = wm.getDefaultDisplay();
                int width = display.getWidth();
                int height = display.getHeight();

                String dataUrl = bitmapToDataUrl(bitmap);

                JSObject result = new JSObject();
                result.put("dataUrl", dataUrl);
                result.put("width", width);
                result.put("height", height);
                call.resolve(result);
            } catch (Exception e) {
                call.reject("Screenshot error: " + e.getMessage());
            }
        });
    }

    // ── execute ───────────────────────────────────────────────────────────────

    @PluginMethod
    public void execute(PluginCall call) {
        JSObject actionObj = call.getObject("action");
        if (actionObj == null) {
            // If not passed as an object, try individual fields
            String actionType = call.getString("action", "");
            actionObj = new JSObject();
            actionObj.put("action", actionType);
        }

        String action = actionObj.optString("action", call.getString("action", ""));
        if (action.isEmpty()) {
            call.reject("action is required");
            return;
        }

        if (!AskiiAccessibilityService.isEnabled()) {
            call.reject("Accessibility service not enabled. Open Settings → Accessibility → ASKII to enable it.");
            return;
        }

        AskiiAccessibilityService a11y = AskiiAccessibilityService.getInstance();
        if (a11y == null) {
            call.reject("Accessibility service unavailable");
            return;
        }

        try {
            switch (action) {
                case "tap":
                case "mouse_left_click":
                case "mouse_move": {
                    float x = (float) actionObj.optDouble("x", call.getDouble("x", 0));
                    float y = (float) actionObj.optDouble("y", call.getDouble("y", 0));
                    boolean ok = a11y.dispatchTap(x, y);
                    if (ok) call.resolve();
                    else call.reject("Tap gesture failed");
                    break;
                }
                case "mouse_double_click": {
                    float x = (float) actionObj.optDouble("x", call.getDouble("x", 0));
                    float y = (float) actionObj.optDouble("y", call.getDouble("y", 0));
                    boolean ok = a11y.dispatchDoubleTap(x, y);
                    if (ok) call.resolve();
                    else call.reject("Double-tap gesture failed");
                    break;
                }
                case "mouse_drag": {
                    float fromX = (float) actionObj.optDouble("fromX", call.getDouble("fromX", 0));
                    float fromY = (float) actionObj.optDouble("fromY", call.getDouble("fromY", 0));
                    float toX = (float) actionObj.optDouble("toX", call.getDouble("toX", 0));
                    float toY = (float) actionObj.optDouble("toY", call.getDouble("toY", 0));
                    boolean ok = a11y.dispatchSwipe(fromX, fromY, toX, toY, 500);
                    if (ok) call.resolve();
                    else call.reject("Drag gesture failed");
                    break;
                }
                case "mouse_scroll": {
                    float x = (float) actionObj.optDouble("x", call.getDouble("x", 0));
                    float y = (float) actionObj.optDouble("y", call.getDouble("y", 0));
                    String direction = actionObj.optString("direction", call.getString("direction", "down"));
                    int amount = actionObj.optInt("amount", call.getInt("amount", 3));
                    boolean ok = a11y.dispatchScroll(x, y, direction, amount);
                    if (ok) call.resolve();
                    else call.reject("Scroll gesture failed");
                    break;
                }
                case "keyboard_input": {
                    String text = actionObj.optString("text", call.getString("text", ""));
                    boolean ok = a11y.inputText(text);
                    if (ok) call.resolve();
                    else call.reject("Text input failed — no focused editable field");
                    break;
                }
                case "key_press": {
                    String key = actionObj.optString("key", call.getString("key", ""));
                    boolean ok = a11y.pressKey(key);
                    if (ok) call.resolve();
                    else call.reject("Key press failed: " + key);
                    break;
                }
                case "click_text": {
                    String text = actionObj.optString("text", call.getString("text", ""));
                    boolean ok = a11y.clickText(text);
                    if (ok) call.resolve();
                    else call.reject("Element with text \"" + text + "\" not found");
                    break;
                }
                default:
                    call.reject("Unknown action: " + action);
            }
        } catch (Exception e) {
            call.reject("Execute error: " + e.getMessage());
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private String bitmapToDataUrl(Bitmap bitmap) {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        bitmap.compress(Bitmap.CompressFormat.PNG, SCREENSHOT_QUALITY, baos);
        byte[] bytes = baos.toByteArray();
        String base64 = Base64.encodeToString(bytes, Base64.NO_WRAP);
        return "data:image/png;base64," + base64;
    }
}