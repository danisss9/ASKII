package dev.askii.app.plugins;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;

/**
 * AskiiBrowser — in-app WebView agent plugin.
 *
 * Manages a dedicated Android WebView (separate from the Capacitor bridge's
 * own WebView) that the browser agent drives: navigation, CSS-selector
 * clicks/types, scrolling, text-based clicks, and per-step screenshots.
 *
 * The WebView is shown as a full-screen overlay while the agent is active so
 * the user can watch it work (mirroring the extension's visible-Puppeteer
 * mode). `reset()` hides it.
 *
 * Screenshots are captured via `View.draw(Canvas)` with a temporary software
 * layer type, which reliably captures WebView content across all API levels
 * (≥ 24) without requiring PixelCopy.
 */
@CapacitorPlugin(name = "AskiiBrowser")
public class AskiiBrowserPlugin extends Plugin {

    private static final String TAG = "AskiiBrowser";
    private static final int SCREENSHOT_MAX_WIDTH = 1280;
    private static final int SCREENSHOT_MAX_HEIGHT = 1920;
    private static final long WAIT_FOR_POLL_MS = 500;
    private static final long WAIT_FOR_TIMEOUT_MS = 15000;
    private static final long ACTION_SETTLE_MS = 1500;

    private WebView agentWebView;
    private FrameLayout overlayContainer;
    private final Handler uiHandler = new Handler(Looper.getMainLooper());

    // ── WebView lifecycle ────────────────────────────────────────────────────

    private void ensureWebViewOnUiThread() {
        if (agentWebView != null) return;

        uiHandler.post(() -> {
            if (agentWebView != null) return;

            agentWebView = new WebView(getActivity());
            WebSettings settings = agentWebView.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setUseWideViewPort(true);
            settings.setLoadWithOverviewMode(true);
            settings.setSupportZoom(true);
            settings.setBuiltInZoomControls(true);
            settings.setDisplayZoomControls(false);
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            settings.setJavaScriptCanOpenWindowsAutomatically(true);

            agentWebView.setWebViewClient(new WebViewClient() {
                @Override
                public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                    Log.w(TAG, "WebView error: " + error.getDescription());
                }
            });
            agentWebView.setWebChromeClient(new WebChromeClient());
            agentWebView.layoutParams = new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
            );

            // Add as a full-screen overlay on top of the Capacitor WebView
            overlayContainer = new FrameLayout(getActivity());
            overlayContainer.setLayoutParams(new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
            ));
            overlayContainer.addView(agentWebView);
            ((ViewGroup) getActivity().findViewById(android.R.id.content)).addView(overlayContainer);
        });

        // Wait for the UI thread to finish
        try {
            Thread.sleep(100);
        } catch (InterruptedException ignored) {
        }
    }

    // ── Plugin methods ───────────────────────────────────────────────────────

    @PluginMethod
    public void execute(PluginCall call) {
        String action = call.getString("action", "");
        if (action.isEmpty()) {
            call.reject("action is required");
            return;
        }

        if ("DONE".equals(action)) {
            call.resolve();
            return;
        }

        ensureWebViewOnUiThread();

        uiHandler.post(() -> {
            try {
                switch (action) {
                    case "goto":
                        handleGoto(call);
                        break;
                    case "click":
                        handleClick(call);
                        break;
                    case "type":
                        handleType(call);
                        break;
                    case "wait_for":
                        handleWaitFor(call);
                        break;
                    case "back":
                        agentWebView.goBack();
                        call.resolve();
                        break;
                    case "forward":
                        agentWebView.goForward();
                        call.resolve();
                        break;
                    case "scroll":
                        handleScroll(call);
                        break;
                    case "click_text":
                        handleClickText(call);
                        break;
                    default:
                        call.reject("Unknown action: " + action);
                }
            } catch (Exception e) {
                call.reject("Execute error: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void screenshot(PluginCall call) {
        ensureWebViewOnUiThread();

        uiHandler.post(() -> {
            try {
                Bitmap bitmap = captureWebView();
                if (bitmap == null) {
                    call.reject("Failed to capture WebView");
                    return;
                }

                String dataUrl = bitmapToDataUrl(bitmap);
                JSObject result = new JSObject();
                result.put("dataUrl", dataUrl);
                result.put("url", agentWebView.getUrl() != null ? agentWebView.getUrl() : "about:blank");
                result.put("width", bitmap.getWidth());
                result.put("height", bitmap.getHeight());
                call.resolve(result);
            } catch (Exception e) {
                call.reject("Screenshot error: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void reset(PluginCall call) {
        uiHandler.post(() -> {
            if (agentWebView != null) {
                agentWebView.loadUrl("about:blank");
            }
            if (overlayContainer != null) {
                overlayContainer.setVisibility(View.GONE);
            }
            call.resolve();
        });
    }

    // ── Action handlers ──────────────────────────────────────────────────────

    private void handleGoto(PluginCall call) {
        String url = call.getString("url", "");
        if (url.isEmpty()) {
            call.reject("goto requires url");
            return;
        }
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "https://" + url;
        }
        if (overlayContainer != null) overlayContainer.setVisibility(View.VISIBLE);
        agentWebView.loadUrl(url);
        call.resolve();
    }

    private void handleClick(PluginCall call) {
        String selector = call.getString("selector", "");
        if (selector.isEmpty()) {
            call.reject("click requires selector");
            return;
        }
        String js = "(function(){var el=document.querySelector(" + jsonStr(selector) + ");if(el){el.click();return 'ok';}return 'not found';})()";
        evalJs(js, call);
    }

    private void handleType(PluginCall call) {
        String selector = call.getString("selector", "");
        String text = call.getString("text", "");
        if (selector.isEmpty()) {
            call.reject("type requires selector");
            return;
        }
        String js = "(function(){var el=document.querySelector(" + jsonStr(selector) + ");if(!el)return 'not found';"
                + "el.focus();el.value='';"
                + "var nativeSetter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');"
                + "if(!nativeSetter)nativeSetter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value');"
                + "if(nativeSetter&&nativeSetter.set){nativeSetter.set.call(el," + jsonStr(text) + ");}"
                + "else{el.value=" + jsonStr(text) + ";}"
                + "el.dispatchEvent(new Event('input',{bubbles:true}));"
                + "el.dispatchEvent(new Event('change',{bubbles:true}));"
                + "return 'ok';})()";
        evalJs(js, call);
    }

    private void handleWaitFor(PluginCall call) {
        String selector = call.getString("selector", "");
        if (selector.isEmpty()) {
            call.reject("wait_for requires selector");
            return;
        }
        String js = "(function(){return document.querySelector(" + jsonStr(selector) + ") ? 'found' : 'not found';})()";

        // Poll until the selector appears or timeout
        final long startTime = System.currentTimeMillis();
        pollJs(js, "found", WAIT_FOR_POLL_MS, WAIT_FOR_TIMEOUT_MS, new PollCallback() {
            @Override
            public void onResult(boolean success, String result) {
                if (success) call.resolve();
                else call.reject("wait_for timed out for selector: " + selector);
            }
        });
    }

    private void handleScroll(PluginCall call) {
        String direction = call.getString("direction", "down");
        int amount = call.getInt("amount", 3);
        int scrollPx = amount * 200;
        String js = "window.scrollBy(0," + ("down".equals(direction) ? scrollPx : -scrollPx) + ");'ok'";
        evalJs(js, call);
    }

    private void handleClickText(PluginCall call) {
        String text = call.getString("text", "");
        if (text.isEmpty()) {
            call.reject("click_text requires text");
            return;
        }
        String js = "(function(){var els=document.querySelectorAll('button,a,input,[role=\"button\"],label,*');"
                + "for(var i=0;i<els.length;i++){var el=els[i];"
                + "if((el.textContent&&el.textContent.trim()===" + jsonStr(text) + ")"
                + "||(el.value&&el.value.trim()===" + jsonStr(text) + "))"
                + "{el.click();return 'ok';}}"
                + "return 'not found';})()";
        evalJs(js, call);
    }

    // ── Screenshot capture ───────────────────────────────────────────────────

    private Bitmap captureWebView() {
        if (agentWebView == null) return null;

        // Ensure the WebView is measured and laid out
        if (agentWebView.getWidth() == 0 || agentWebView.getHeight() == 0) {
            int w = SCREENSHOT_MAX_WIDTH;
            int h = SCREENSHOT_MAX_HEIGHT;
            agentWebView.measure(
                    View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY)
            );
            agentWebView.layout(0, 0, agentWebView.getMeasuredWidth(), agentWebView.getMeasuredHeight());
        }

        int width = agentWebView.getWidth();
        int height = agentWebView.getHeight();

        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);

        // Temporarily switch to software rendering to capture WebView content
        int originalLayerType = agentWebView.getLayerType();
        agentWebView.setLayerType(View.LAYER_TYPE_SOFTWARE, null);
        try {
            agentWebView.draw(canvas);
        } finally {
            agentWebView.setLayerType(originalLayerType, null);
        }

        return bitmap;
    }

    private String bitmapToDataUrl(Bitmap bitmap) {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        bitmap.compress(Bitmap.CompressFormat.PNG, 80, baos);
        byte[] bytes = baos.toByteArray();
        String base64 = Base64.encodeToString(bytes, Base64.NO_WRAP);
        return "data:image/png;base64," + base64;
    }

    // ── JS evaluation helpers ────────────────────────────────────────────────

    private interface JsCallback {
        void onResult(String result);
    }

    private interface PollCallback {
        void onResult(boolean success, String result);
    }

    private void evalJs(String js, PluginCall call) {
        agentWebView.evaluateJavascript(js, value -> {
            // value is a JSON-encoded string (quoted) or null
            String result = unquoteJsString(value);
            if (result != null && (result.equals("ok") || result.equals("found"))) {
                call.resolve();
            } else if (result != null && result.equals("not found")) {
                call.reject("Element not found");
            } else {
                call.resolve(); // best-effort resolve
            }
        });
    }

    private void evalJsRaw(String js, JsCallback callback) {
        agentWebView.evaluateJavascript(js, value -> callback.onResult(unquoteJsString(value)));
    }

    private void pollJs(String js, String expectedValue, long pollMs, long timeoutMs, PollCallback callback) {
        final long startTime = System.currentTimeMillis();

        Runnable[] pollRunnable = new Runnable[1];
        pollRunnable[0] = () -> {
            if (System.currentTimeMillis() - startTime > timeoutMs) {
                callback.onResult(false, "timeout");
                return;
            }
            agentWebView.evaluateJavascript(js, value -> {
                String result = unquoteJsString(value);
                if (expectedValue.equals(result)) {
                    callback.onResult(true, result);
                } else {
                    uiHandler.postDelayed(pollRunnable[0], pollMs);
                }
            });
        };
        uiHandler.post(pollRunnable[0]);
    }

    /** Unquote a JS evaluateJavascript result (it comes back as a JSON-encoded string). */
    private static String unquoteJsString(String value) {
        if (value == null || value.equals("null")) return null;
        // The value comes back wrapped in double quotes (JSON string encoding)
        if (value.startsWith("\"") && value.endsWith("\"")) {
            // Unescape
            try {
                return new org.json.JSONArray(value).getString(0);
            } catch (Exception e) {
                // Manual unescape
                return value.substring(1, value.length() - 1)
                        .replace("\\\"", "\"")
                        .replace("\\\\", "\\")
                        .replace("\\n", "\n")
                        .replace("\\t", "\t");
            }
        }
        return value;
    }

    /** Convert a Java string into a JSON string literal (with surrounding double quotes). */
    private static String jsonStr(String s) {
        if (s == null) return "null";
        return JSONObject.quote(s);
    }
}