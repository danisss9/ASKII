package dev.askii.app.plugins;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Path;
import android.os.Bundle;
import android.util.Log;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * AskiiAccessibilityService — the Android AccessibilityService that backs
 * ASKII Control mode.
 *
 * The user must enable this service in Settings → Accessibility before Control
 * mode can work. Once enabled, the system binds to it and the static
 * `instance` field becomes non-null, allowing `AskiiScreenPlugin` to dispatch
 * gestures and inspect the screen tree.
 *
 * Supported actions:
 * - Tap / click at (x, y)          → dispatchGesture with a 50ms pointer
 * - Swipe / drag                   → dispatchGesture with a path
 * - Scroll up/down/left/right      → swipe in the scroll direction
 * - Type text into focused field   → ACTION_SET_TEXT on the focused editable
 * - Press key (Back/Home/Recents)  → performGlobalAction
 * - Click element by text          → traverse accessibility tree, ACTION_CLICK
 */
public class AskiiAccessibilityService extends AccessibilityService {

    private static final String TAG = "AskiiA11y";
    private static final long GESTURE_TIMEOUT_MS = 2000;

    private static volatile AskiiAccessibilityService instance;

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
        Log.i(TAG, "Accessibility service connected");
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        instance = null;
        Log.i(TAG, "Accessibility service destroyed");
    }

    public static boolean isEnabled() {
        return instance != null;
    }

    public static AskiiAccessibilityService getInstance() {
        return instance;
    }

    // ── Gesture dispatch ──────────────────────────────────────────────────────

    /** Dispatch a tap at (x, y). Returns true if the gesture was dispatched. */
    public boolean dispatchTap(float x, float y) {
        Path path = new Path();
        path.moveTo(x, y);
        GestureDescription.StrokeDescription stroke = new GestureDescription.StrokeDescription(path, 0, 50);
        GestureDescription gesture = new GestureDescription.Builder().addStroke(stroke).build();
        return dispatchGestureSync(gesture);
    }

    /** Dispatch a swipe/drag from (fromX, fromY) to (toX, toY). */
    public boolean dispatchSwipe(float fromX, float fromY, float toX, float toY, long durationMs) {
        Path path = new Path();
        path.moveTo(fromX, fromY);
        path.lineTo(toX, toY);
        GestureDescription.StrokeDescription stroke = new GestureDescription.StrokeDescription(path, 0, durationMs);
        GestureDescription gesture = new GestureDescription.Builder().addStroke(stroke).build();
        return dispatchGestureSync(gesture);
    }

    /** Dispatch a scroll by swiping in the given direction. */
    public boolean dispatchScroll(float x, float y, String direction, int amount) {
        int distance = amount * 200;
        float fromX = x, fromY = y, toX = x, toY = y;
        switch (direction) {
            case "up":
                fromY = y + distance;
                toY = y - distance;
                break;
            case "down":
                fromY = y - distance;
                toY = y + distance;
                break;
            case "left":
                fromX = x + distance;
                toX = x - distance;
                break;
            case "right":
                fromX = x - distance;
                toX = x + distance;
                break;
        }
        return dispatchSwipe(fromX, fromY, toX, toY, 300);
    }

    /** Dispatch a double-tap at (x, y). */
    public boolean dispatchDoubleTap(float x, float y) {
        Path path = new Path();
        path.moveTo(x, y);
        GestureDescription.StrokeDescription stroke1 = new GestureDescription.StrokeDescription(path, 0, 50);
        GestureDescription.StrokeDescription stroke2 = new GestureDescription.StrokeDescription(path, 100, 50);
        GestureDescription gesture = new GestureDescription.Builder()
                .addStroke(stroke1)
                .addStroke(stroke2)
                .build();
        return dispatchGestureSync(gesture);
    }

    private boolean dispatchGestureSync(GestureDescription gesture) {
        final CountDownLatch latch = new CountDownLatch(1);
        final AtomicBoolean success = new AtomicBoolean(false);

        dispatchGesture(gesture, new GestureResultCallback() {
            @Override
            public void onCompleted(GestureDescription gestureDescription) {
                success.set(true);
                latch.countDown();
            }

            @Override
            public void onCancelled(GestureDescription gestureDescription) {
                latch.countDown();
            }
        }, null);

        try {
            latch.await(GESTURE_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return success.get();
    }

    // ── Text input ────────────────────────────────────────────────────────────

    /** Type text into the currently focused editable field. */
    public boolean inputText(String text) {
        AccessibilityNodeInfo focused = getFocusedEditable();
        if (focused == null) {
            Log.w(TAG, "inputText: no focused editable found");
            return false;
        }
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        return focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
    }

    private AccessibilityNodeInfo getFocusedEditable() {
        // Start from the root window and search for a focused editable
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return null;
        return findFocusedEditable(root);
    }

    private AccessibilityNodeInfo findFocusedEditable(AccessibilityNodeInfo node) {
        if (node == null) return null;
        if (node.isEditable() && node.isFocused()) return node;
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo found = findFocusedEditable(node.getChild(i));
            if (found != null) return found;
        }
        return null;
    }

    // ── Key press ─────────────────────────────────────────────────────────────

    /** Press a key by name. Supports common keys via performGlobalAction. */
    public boolean pressKey(String key) {
        if (key == null) return false;
        String k = key.trim();
        // Handle combos and common keys
        if (k.equalsIgnoreCase("Back") || k.equalsIgnoreCase("Escape")) {
            return performGlobalAction(GLOBAL_ACTION_BACK);
        }
        if (k.equalsIgnoreCase("Home")) {
            return performGlobalAction(GLOBAL_ACTION_HOME);
        }
        if (k.equalsIgnoreCase("Recents") || k.equalsIgnoreCase("Win")) {
            return performGlobalAction(GLOBAL_ACTION_RECENTS);
        }
        if (k.equalsIgnoreCase("Enter")) {
            // Try to click the focused element or send action click
            AccessibilityNodeInfo focused = getFocusedEditable();
            if (focused != null) {
                return focused.performAction(AccessibilityNodeInfo.ACTION_CLICK);
            }
            return false;
        }
        if (k.equalsIgnoreCase("Delete") || k.equalsIgnoreCase("Backspace")) {
            AccessibilityNodeInfo focused = getFocusedEditable();
            if (focused != null && focused.getText() != null) {
                CharSequence text = focused.getText();
                if (text.length() > 0) {
                    String newText = text.subSequence(0, text.length() - 1).toString();
                    Bundle args = new Bundle();
                    args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, newText);
                    return focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
                }
            }
            return false;
        }
        // For other keys, try shell input keyevent (best-effort, may require ADB/root)
        try {
            String keyCode = mapKeyToKeyCode(k);
            if (keyCode != null) {
                Runtime.getRuntime().exec(new String[]{"input", "keyevent", keyCode});
                return true;
            }
        } catch (Exception e) {
            Log.w(TAG, "pressKey: shell input failed for " + k + ": " + e.getMessage());
        }
        return false;
    }

    private String mapKeyToKeyCode(String key) {
        // Map common key names to Android keycodes
        switch (key.toLowerCase()) {
            case "tab": return "KEYCODE_TAB";
            case "space": return "KEYCODE_SPACE";
            case "up": return "KEYCODE_DPAD_UP";
            case "down": return "KEYCODE_DPAD_DOWN";
            case "left": return "KEYCODE_DPAD_LEFT";
            case "right": return "KEYCODE_DPAD_RIGHT";
            case "pageup": return "KEYCODE_PAGE_UP";
            case "pagedown": return "KEYCODE_PAGE_DOWN";
            case "home": return "KEYCODE_MOVE_HOME";
            case "end": return "KEYCODE_MOVE_END";
            case "f1": return "KEYCODE_F1";
            case "f2": return "KEYCODE_F2";
            case "f3": return "KEYCODE_F3";
            case "f4": return "KEYCODE_F4";
            case "f5": return "KEYCODE_F5";
            case "f6": return "KEYCODE_F6";
            case "f7": return "KEYCODE_F7";
            case "f8": return "KEYCODE_F8";
            case "f9": return "KEYCODE_F9";
            case "f10": return "KEYCODE_F10";
            case "f11": return "KEYCODE_F11";
            case "f12": return "KEYCODE_F12";
            default: return null;
        }
    }

    // ── Click by text ─────────────────────────────────────────────────────────

    /** Find an element by its visible text and click it. */
    public boolean clickText(String text) {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return false;
        return findAndClick(root, text);
    }

    private boolean findAndClick(AccessibilityNodeInfo node, String text) {
        if (node == null) return false;
        CharSequence nodeText = node.getText();
        CharSequence nodeDesc = node.getContentDescription();
        if ((nodeText != null && nodeText.toString().trim().equals(text)) ||
            (nodeDesc != null && nodeDesc.toString().trim().equals(text))) {
            // Try click, then click parent if this node isn't clickable
            if (node.isClickable()) {
                return node.performAction(AccessibilityNodeInfo.ACTION_CLICK);
            }
            AccessibilityNodeInfo parent = node.getParent();
            if (parent != null && parent.isClickable()) {
                return parent.performAction(AccessibilityNodeInfo.ACTION_CLICK);
            }
        }
        for (int i = 0; i < node.getChildCount(); i++) {
            if (findAndClick(node.getChild(i), text)) return true;
        }
        return false;
    }
}