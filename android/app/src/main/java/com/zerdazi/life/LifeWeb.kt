package com.zerdazi.life

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.webkit.JavascriptInterface
import android.webkit.MimeTypeMap
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.window.OnBackInvokedDispatcher
import com.zerdazi.life.server.LocalApi
import org.json.JSONObject

// The UI is the existing React app (web/), bundled into the APK at assets/web
// and served from a fake https origin. Its /api calls go through the
// LifeNative bridge (see web/src/api.js) to LocalApi — everything is on-device.
object LifeWeb {
    const val ORIGIN = "https://life.local"

    fun url(path: String) = ORIGIN + path

    @SuppressLint("SetJavaScriptEnabled")
    fun create(activity: Activity): WebView = WebView(activity).apply {
        setBackgroundColor(Palette.NIGHT)
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        addJavascriptInterface(Bridge(this), "LifeNative")
        webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, req: WebResourceRequest): WebResourceResponse? =
                if (req.url.host == "life.local") serveAsset(activity, req.url) else null

            // Anything off-app opens in the real browser, so no other page ever
            // gets the LifeNative bridge.
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                if (req.url.host == "life.local") return false
                runCatching { activity.startActivity(Intent(Intent.ACTION_VIEW, req.url)) }
                return true
            }
        }
    }

    // Static files from assets/web; any extension-less path is a client-side
    // route, so it gets index.html (SPA fallback, like the Express server).
    private fun serveAsset(activity: Activity, url: Uri): WebResourceResponse {
        val path = url.path.orEmpty().trimStart('/')
        val isFile = path.substringAfterLast('/').contains('.')
        val file = if (isFile) path else "index.html"
        val ext = file.substringAfterLast('.')
        val mime = when (ext) {
            "js", "mjs" -> "text/javascript"
            "webmanifest" -> "application/manifest+json"
            else -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
        }
        return try {
            WebResourceResponse(mime, "utf-8", activity.assets.open("web/$file"))
        } catch (_: Exception) {
            WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, "not found".byteInputStream())
        }
    }

    private class Bridge(private val web: WebView) {
        // Async: answers via window.__lifeResolve(id, status, body).
        @JavascriptInterface
        fun request(id: Int, method: String, path: String, body: String?) {
            LocalApi.async(method, path, body) { res ->
                val js = "window.__lifeResolve($id, ${res.status}, ${JSONObject.quote(res.body ?: "")})"
                web.post { web.evaluateJavascript(js, null) }
            }
        }
    }

    // Back navigates the web history first, then falls through to the activity.
    fun handleBack(activity: Activity, web: WebView) {
        if (Build.VERSION.SDK_INT >= 33) {
            activity.onBackInvokedDispatcher.registerOnBackInvokedCallback(
                OnBackInvokedDispatcher.PRIORITY_DEFAULT
            ) { if (web.canGoBack()) web.goBack() else activity.finish() }
        }
    }
}
