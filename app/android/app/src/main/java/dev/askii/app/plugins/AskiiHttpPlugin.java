package dev.askii.app.plugins;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import okhttp3.Call;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * AskiiHttp — native streaming HTTP for LLM chat completions.
 *
 * Bypasses the WebView's CORS restrictions and provides true token-by-token
 * streaming from cloud providers (OpenAI-compatible / Anthropic / Ollama) via
 * OkHttp. Emits `onChunk` { streamId, delta } and `onDone` { streamId } events.
 */
@CapacitorPlugin(name = "AskiiHttp")
public class AskiiHttpPlugin extends Plugin {

    private final OkHttpClient client = new OkHttpClient.Builder()
            .connectTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
            .readTimeout(120, java.util.concurrent.TimeUnit.SECONDS)
            .build();

    private final ConcurrentHashMap<String, Call> activeCalls = new ConcurrentHashMap<>();

    @PluginMethod
    public void streamChat(PluginCall call) {
        String streamId = call.getString("streamId", "");
        String provider = call.getString("provider", "askiicloud");
        String model = call.getString("model", "");
        String apiKey = call.getString("apiKey", "");
        String baseUrl = call.getString("baseUrl", "");
        String ollamaUrl = call.getString("ollamaUrl", "http://localhost:11434");
        String lmStudioUrl = call.getString("lmStudioUrl", "http://localhost:1234");
        String openaiUrl = call.getString("openaiUrl", "");
        JSObject messages = call.getObject("messages");
        String imageBase64 = call.getString("imageBase64", "");

        if (streamId.isEmpty() || model.isEmpty()) {
            call.reject("streamId and model are required");
            return;
        }

        try {
            Request request = buildRequest(provider, model, apiKey, baseUrl, ollamaUrl, lmStudioUrl, openaiUrl, messages, imageBase64);
            Call okCall = client.newCall(request);
            activeCalls.put(streamId, okCall);

            // Resolve immediately — chunks arrive asynchronously via events.
            call.resolve();

            okCall.enqueue(new okhttp3.Callback() {
                @Override
                public void onFailure(Call call, IOException e) {
                    activeCalls.remove(streamId);
                    JSObject chunk = new JSObject();
                    chunk.put("streamId", streamId);
                    chunk.put("delta", "\n[stream error: " + e.getMessage() + "]");
                    notifyListeners("onChunk", chunk);
                    JSObject done = new JSObject();
                    done.put("streamId", streamId);
                    notifyListeners("onDone", done);
                }

                @Override
                public void onResponse(Call call, Response response) throws IOException {
                    try (ResponseBody body = response.body()) {
                        if (!response.isSuccessful() || body == null) {
                            String err = body != null ? body.string() : "";
                            JSObject chunk = new JSObject();
                            chunk.put("streamId", streamId);
                            chunk.put("delta", "\n[HTTP " + response.code() + ": " + err.substring(0, Math.min(err.length(), 300)) + "]");
                            notifyListeners("onChunk", chunk);
                        } else {
                            streamBody(streamId, provider, model, body);
                        }
                    } finally {
                        activeCalls.remove(streamId);
                        JSObject done = new JSObject();
                        done.put("streamId", streamId);
                        notifyListeners("onDone", done);
                    }
                }
            });
        } catch (Exception e) {
            call.reject("Failed to start stream: " + e.getMessage());
        }
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String streamId = call.getString("streamId", "");
        if (!streamId.isEmpty()) {
            Call c = activeCalls.remove(streamId);
            if (c != null) c.cancel();
        }
        call.resolve();
    }

    private Request buildRequest(String provider, String model, String apiKey, String baseUrl,
                                  String ollamaUrl, String lmStudioUrl, String openaiUrl,
                                  JSObject messages, String imageBase64) throws Exception {
        // Convert JSObject messages to JSONArray
        JSONArray msgs;
        if (messages instanceof JSONArray) {
            msgs = (JSONArray) messages;
        } else {
            // Capacitor may wrap the array in a JSObject; try to get the underlying array
            String raw = messages.toString();
            msgs = new JSONArray(raw);
        }

        boolean hasImage = imageBase64 != null && !imageBase64.isEmpty();
        boolean isAnthropic = "anthropic".equals(provider) ||
                ("opencodego".equals(provider) && model.matches("(?i)^(qwen|minimax).*"));

        if ("ollama".equals(provider)) {
            String url = ollamaUrl.replaceAll("/$", "") + "/api/chat";
            JSONObject body = new JSONObject();
            body.put("model", model);
            body.put("stream", true);
            if (hasImage) {
                msgs = attachOllamaImage(msgs, imageBase64);
            }
            body.put("messages", msgs);
            return new Request.Builder()
                    .url(url)
                    .post(RequestBody.create(body.toString(), MediaType.parse("application/json")))
                    .build();
        }

        if (isAnthropic) {
            String base;
            if ("opencodego".equals(provider)) {
                base = "https://opencode.ai/zen/go";
            } else {
                base = baseUrl.isEmpty() ? "https://api.anthropic.com/v1" : baseUrl.replaceAll("/$", "");
            }
            String url = base + "/messages";
            JSONObject body = new JSONObject();
            body.put("model", model);
            body.put("max_tokens", 4096);
            body.put("stream", true);

            // Extract system message and build chat messages
            JSONArray chatMsgs = new JSONArray();
            String system = null;
            for (int i = 0; i < msgs.length(); i++) {
                JSONObject m = msgs.getJSONObject(i);
                String role = m.getString("role");
                if ("system".equals(role)) {
                    system = m.getString("content");
                } else {
                    chatMsgs.put(m);
                }
            }
            if (system != null) body.put("system", system);
            if (hasImage) {
                chatMsgs = attachAnthropicImage(chatMsgs, imageBase64);
            }
            body.put("messages", chatMsgs);

            return new Request.Builder()
                    .url(url)
                    .post(RequestBody.create(body.toString(), MediaType.parse("application/json")))
                    .addHeader("x-api-key", apiKey)
                    .addHeader("anthropic-version", "2023-06-01")
                    .build();
        }

        // OpenAI-compatible (askiicloud / openai / opencodego / lmstudio)
        String base;
        if ("lmstudio".equals(provider)) {
            base = lmStudioUrl.replaceAll("^ws://", "http://").replaceAll("/$", "");
            if (!base.endsWith("/v1")) base += "/v1";
        } else if ("openai".equals(provider)) {
            base = (openaiUrl.isEmpty() ? "https://api.openai.com/v1" : openaiUrl).replaceAll("/$", "");
        } else if ("opencodego".equals(provider)) {
            base = (baseUrl.isEmpty() ? "https://opencode.ai/zen/go/v1" : baseUrl).replaceAll("/$", "");
        } else {
            // askiicloud
            base = (baseUrl.isEmpty() ? "https://api.askii.dev/v1" : baseUrl).replaceAll("/$", "");
        }
        String url = base + "/chat/completions";
        JSONObject body = new JSONObject();
        body.put("model", model);
        body.put("stream", true);
        if (hasImage) {
            msgs = attachOpenAIImage(msgs, imageBase64);
        }
        body.put("messages", msgs);

        return new Request.Builder()
                .url(url)
                .post(RequestBody.create(body.toString(), MediaType.parse("application/json")))
                .addHeader("Authorization", "Bearer " + apiKey)
                .build();
    }

    // ── Image attachment helpers ──────────────────────────────────────────────

    /** Add `images` to the last user message for Ollama. */
    private JSONArray attachOllamaImage(JSONArray msgs, String imageBase64) throws Exception {
        JSONArray out = new JSONArray();
        for (int i = 0; i < msgs.length(); i++) {
            JSONObject m = msgs.getJSONObject(i);
            if (i == msgs.length() - 1 && "user".equals(m.getString("role"))) {
                JSONArray images = new JSONArray();
                images.put(imageBase64);
                m.put("images", images);
            }
            out.put(m);
        }
        return out;
    }

    /** Convert the last user message to Anthropic content blocks with image + text. */
    private JSONArray attachAnthropicImage(JSONArray msgs, String imageBase64) throws Exception {
        JSONArray out = new JSONArray();
        for (int i = 0; i < msgs.length(); i++) {
            JSONObject m = msgs.getJSONObject(i);
            if (i == msgs.length() - 1 && "user".equals(m.getString("role"))) {
                JSONArray content = new JSONArray();
                JSONObject imageBlock = new JSONObject();
                imageBlock.put("type", "image");
                JSONObject source = new JSONObject();
                source.put("type", "base64");
                source.put("media_type", "image/png");
                source.put("data", imageBase64);
                imageBlock.put("source", source);
                content.put(imageBlock);
                JSONObject textBlock = new JSONObject();
                textBlock.put("type", "text");
                textBlock.put("text", m.getString("content"));
                content.put(textBlock);
                m.put("content", content);
            }
            out.put(m);
        }
        return out;
    }

    /** Convert the last user message to OpenAI multimodal content with image_url + text. */
    private JSONArray attachOpenAIImage(JSONArray msgs, String imageBase64) throws Exception {
        JSONArray out = new JSONArray();
        for (int i = 0; i < msgs.length(); i++) {
            JSONObject m = msgs.getJSONObject(i);
            if (i == msgs.length() - 1 && "user".equals(m.getString("role"))) {
                JSONArray content = new JSONArray();
                JSONObject imageBlock = new JSONObject();
                imageBlock.put("type", "image_url");
                JSONObject imageUrl = new JSONObject();
                imageUrl.put("url", "data:image/png;base64," + imageBase64);
                imageBlock.put("image_url", imageUrl);
                content.put(imageBlock);
                JSONObject textBlock = new JSONObject();
                textBlock.put("type", "text");
                textBlock.put("text", m.getString("content"));
                content.put(textBlock);
                m.put("content", content);
            }
            out.put(m);
        }
        return out;
    }

    private void streamBody(String streamId, String provider, String model, ResponseBody body) throws IOException {
        BufferedReader reader = new BufferedReader(new InputStreamReader(body.byteStream()));
        boolean isOllama = "ollama".equals(provider);

        String line;
        while ((line = reader.readLine()) != null) {
            if (line.isEmpty()) continue;

            if (isOllama) {
                // NDJSON: { "message": { "content": "..." } }
                try {
                    JSONObject obj = new JSONObject(line);
                    JSONObject msg = obj.optJSONObject("message");
                    if (msg != null) {
                        String delta = msg.optString("content", "");
                        if (!delta.isEmpty()) emitChunk(streamId, delta);
                    }
                } catch (Exception ignored) {
                }
            } else {
                // SSE: data: { ... }
                if (!line.startsWith("data:")) continue;
                String payload = line.substring(5).trim();
                if (payload.isEmpty() || "[DONE]".equals(payload)) continue;

                try {
                    JSONObject obj = new JSONObject(payload);
                    // OpenAI-compatible: choices[0].delta.content
                    JSONArray choices = obj.optJSONArray("choices");
                    if (choices != null && choices.length() > 0) {
                        JSONObject delta = choices.getJSONObject(0).optJSONObject("delta");
                        if (delta != null) {
                            String text = delta.optString("content", "");
                            if (!text.isEmpty()) emitChunk(streamId, text);
                        }
                    } else {
                        // Anthropic: content_block_delta.delta.text
                        String type = obj.optString("type", "");
                        if ("content_block_delta".equals(type)) {
                            JSONObject delta = obj.optJSONObject("delta");
                            if (delta != null && "text_delta".equals(delta.optString("type", ""))) {
                                String text = delta.optString("text", "");
                                if (!text.isEmpty()) emitChunk(streamId, text);
                            }
                        }
                    }
                } catch (Exception ignored) {
                }
            }
        }
    }

    private void emitChunk(String streamId, String delta) {
        JSObject chunk = new JSObject();
        chunk.put("streamId", streamId);
        chunk.put("delta", delta);
        notifyListeners("onChunk", chunk);
    }
}