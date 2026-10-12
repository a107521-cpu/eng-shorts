package com.engshorts.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Eng Shorts: a WebView shell around index.html.
 *
 * - index.html is served from https://appassets.androidplatform.net so the YouTube
 *   embed receives a proper Referer (a file:// page gets "Error 153").
 * - window.EngNative.http(...) lets the page call YouTube directly from the phone,
 *   which has no CORS limits and isn't blocked like cloud servers.
 * - Caption files the YouTube player downloads itself (/api/timedtext) are copied
 *   to the page as a fallback.
 */
public class MainActivity extends Activity {
    static final String HOST = "appassets.androidplatform.net";
    static final String HOME = "https://" + HOST + "/index.html";

    private WebView web;
    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    private final Handler main = new Handler(Looper.getMainLooper());
    private TextToSpeech tts;
    private volatile boolean ttsReady = false;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#111014"));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, true);

        web.addJavascriptInterface(new Bridge(), "EngNative");
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public Bitmap getDefaultVideoPoster() {
                // Hide WebView's grey play-button poster before a video starts.
                return Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
            }
        });
        web.setWebViewClient(new Client());

        tts = new TextToSpeech(this, status -> {
            if (status == TextToSpeech.SUCCESS) {
                tts.setLanguage(Locale.US);
                ttsReady = true;
            }
        });

        web.loadUrl(HOME);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) {
            web.evaluateJavascript("window.__engPause && window.__engPause()", null);
            web.onPause();
        }
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onDestroy() {
        pool.shutdownNow();
        if (tts != null) tts.shutdown();
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web == null) {
            finish();
            return;
        }
        web.evaluateJavascript("(window.__engBack && window.__engBack()) ? 1 : 0", v -> {
            if (!"1".equals(v)) finish();
        });
    }

    /* ---------------- page <-> app ---------------- */

    private void callJs(String fn, Object... args) {
        JSONArray arr = new JSONArray();
        for (Object a : args) arr.put(a);
        final String code = "window." + fn + " && window." + fn + ".apply(null," + arr.toString() + ")";
        main.post(() -> {
            if (web != null) web.evaluateJavascript(code, null);
        });
    }

    static boolean allowedHost(String host) {
        if (host == null) return false;
        host = host.toLowerCase(Locale.ROOT);
        return host.equals("youtube.com") || host.endsWith(".youtube.com")
                || host.endsWith(".googleapis.com")
                || host.equals("google.com") || host.endsWith(".google.com");
    }

    static byte[] readAll(InputStream in) throws IOException {
        if (in == null) return new byte[0];
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        } finally {
            in.close();
        }
    }

    class Bridge {
        /** Make an HTTPS request from the phone. Result goes to window.__engHttpDone({id,status,text,error}). */
        @JavascriptInterface
        public void http(final String id, final String method, final String url, final String headers, final String body) {
            pool.execute(() -> {
                JSONObject out = new JSONObject();
                try {
                    out.put("id", id);
                    URL u = new URL(url);
                    if (!"https".equals(u.getProtocol()) || !allowedHost(u.getHost())) throw new IOException("host not allowed");
                    HttpURLConnection c = (HttpURLConnection) u.openConnection();
                    c.setConnectTimeout(12000);
                    c.setReadTimeout(20000);
                    c.setInstanceFollowRedirects(true);
                    c.setRequestMethod(method == null || method.isEmpty() ? "GET" : method.toUpperCase(Locale.ROOT));
                    if (headers != null && !headers.isEmpty()) {
                        JSONObject h = new JSONObject(headers);
                        Iterator<String> it = h.keys();
                        while (it.hasNext()) {
                            String k = it.next();
                            if (k.equalsIgnoreCase("accept-encoding")) continue;
                            c.setRequestProperty(k, h.getString(k));
                        }
                    }
                    if (body != null && !body.isEmpty()) {
                        byte[] b = body.getBytes(StandardCharsets.UTF_8);
                        c.setDoOutput(true);
                        c.setFixedLengthStreamingMode(b.length);
                        try (OutputStream os = c.getOutputStream()) {
                            os.write(b);
                        }
                    }
                    int code = c.getResponseCode();
                    InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
                    out.put("status", code);
                    out.put("text", new String(readAll(in), StandardCharsets.UTF_8));
                    c.disconnect();
                } catch (Exception e) {
                    try {
                        out.put("status", 0);
                        out.put("error", String.valueOf(e));
                    } catch (Exception ignored) {
                    }
                }
                final String code = "window.__engHttpDone && window.__engHttpDone(" + out.toString() + ")";
                main.post(() -> {
                    if (web != null) web.evaluateJavascript(code, null);
                });
            });
        }

        @JavascriptInterface
        public boolean speak(String text) {
            if (!ttsReady || text == null) return false;
            tts.setSpeechRate(0.9f);
            tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "eng");
            return true;
        }

        @JavascriptInterface
        public String version() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public void openUrl(final String url) {
            if (url == null || !url.startsWith("https://")) return;
            main.post(() -> {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (Exception ignored) {
                }
            });
        }
    }

    /* ---------------- requests ---------------- */

    class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            String host = u.getHost();
            if (HOST.equals(host)) return asset(u.getPath());
            if (host != null && "GET".equalsIgnoreCase(req.getMethod()) && "/api/timedtext".equals(u.getPath())
                    && (host.equals("www.youtube.com") || host.equals("youtube.com") || host.equals("m.youtube.com"))) {
                return captureCaptions(req);
            }
            return null;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            if (!req.isForMainFrame()) return false;
            Uri u = req.getUrl();
            if (HOST.equals(u.getHost())) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, u));
            } catch (Exception ignored) {
            }
            return true;
        }
    }

    private WebResourceResponse asset(String path) {
        if (path == null || path.isEmpty() || path.equals("/")) path = "/index.html";
        String p = path.substring(1);
        if (p.contains("..")) return notFound();
        try {
            InputStream in = getAssets().open("www/" + p);
            String mime = "application/octet-stream";
            if (p.endsWith(".html")) mime = "text/html";
            else if (p.endsWith(".js")) mime = "application/javascript";
            else if (p.endsWith(".css")) mime = "text/css";
            else if (p.endsWith(".svg")) mime = "image/svg+xml";
            else if (p.endsWith(".png")) mime = "image/png";
            else if (p.endsWith(".json") || p.endsWith(".webmanifest")) mime = "application/json";
            Map<String, String> h = new HashMap<>();
            h.put("Cache-Control", "no-cache");
            return new WebResourceResponse(mime, "utf-8", 200, "OK", h, in);
        } catch (IOException e) {
            return notFound();
        }
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<String, String>(), new ByteArrayInputStream(new byte[0]));
    }

    /** Fetch the caption file on the player's behalf, hand a copy to the page, return it to the player unchanged. */
    private WebResourceResponse captureCaptions(WebResourceRequest req) {
        String url = req.getUrl().toString();
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(12000);
            c.setReadTimeout(20000);
            String origin = null;
            for (Map.Entry<String, String> e : req.getRequestHeaders().entrySet()) {
                String k = e.getKey();
                if (k == null || k.equalsIgnoreCase("accept-encoding")) continue;
                if (k.equalsIgnoreCase("origin")) origin = e.getValue();
                c.setRequestProperty(k, e.getValue());
            }
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null && !cookie.isEmpty()) c.setRequestProperty("Cookie", cookie);
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            byte[] data = readAll(in);
            String ct = c.getContentType();
            c.disconnect();

            String mime = "text/plain";
            String charset = "utf-8";
            if (ct != null) {
                String[] parts = ct.split(";");
                mime = parts[0].trim();
                for (String part : parts) {
                    String t = part.trim();
                    if (t.toLowerCase(Locale.ROOT).startsWith("charset=")) charset = t.substring(8).trim();
                }
            }
            if (code == 200 && data.length > 0) callJs("__engTimedText", url, new String(data, StandardCharsets.UTF_8));

            Map<String, String> h = new HashMap<>();
            h.put("Cache-Control", "no-store");
            if (origin != null) {
                h.put("Access-Control-Allow-Origin", origin);
                h.put("Access-Control-Allow-Credentials", "true");
            }
            if (code < 100 || (code >= 300 && code < 400) || code > 599) code = 200;
            return new WebResourceResponse(mime, charset, code, code == 200 ? "OK" : "Error", h, new ByteArrayInputStream(data));
        } catch (Exception e) {
            return null; // let the WebView load it normally
        }
    }
}
