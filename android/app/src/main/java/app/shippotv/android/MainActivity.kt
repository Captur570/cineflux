package app.shippotv.android

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.media3.common.util.UnstableApi
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject

/** L'appli : l'interface ShippoTV (la même que sur la télé Samsung) dans une WebView, avec le moteur,
 *  et le lecteur natif par-dessus. */
@UnstableApi
class MainActivity : Activity() {
    lateinit var root: FrameLayout
    lateinit var webView: WebView
    lateinit var player: PlayerHost
    private var testConfig: String? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        Kv.init(this)
        Caps.init(this)
        Log.i("ShippoTV", "[box] ${Caps.summary()}")
        testConfig = intent?.getStringExtra("test")

        root = FrameLayout(this).apply { setBackgroundColor(Color.rgb(11, 6, 9)) }
        webView = WebView(this)
        root.addView(webView, FrameLayout.LayoutParams(-1, -1))
        setContentView(root)
        player = PlayerHost(this)

        val loader = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build()
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW     // logos et images des fournisseurs en http
            loadWithOverviewMode = true
            useWideViewPort = true
            textZoom = 100
            cacheMode = WebSettings.LOAD_DEFAULT
        }
        webView.setBackgroundColor(Color.rgb(11, 6, 9))
        webView.isFocusable = true
        webView.isFocusableInTouchMode = true
        webView.addJavascriptInterface(Bridge(), "ShippoAndroid")
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if (u.host == "appassets.androidplatform.net") return false
                try { startActivity(Intent(Intent.ACTION_VIEW, u)) } catch (_: Exception) { }
                return true
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                if (m.messageLevel() == ConsoleMessage.MessageLevel.ERROR || m.messageLevel() == ConsoleMessage.MessageLevel.WARNING)
                    Log.w("ShippoTV", "[page] ${m.message()} (${m.sourceId()}:${m.lineNumber()})")
                return true
            }
        }
        WebView.setWebContentsDebuggingEnabled(testConfig != null)
        webView.loadUrl("https://appassets.androidplatform.net/assets/web/index.html")
        webView.requestFocus()
        if (testConfig == null) Updater.later(this)
    }

    fun js(code: String) = runOnUiThread { webView.evaluateJavascript(code, null) }
    fun emitPlayer(ev: JSONObject) = js("window.IOS_PLAYER && IOS_PLAYER(${ev})")

    /* ------------------------------------------------------------------ télécommande */

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (player.visible && player.onKey(event)) return true
        if (player.visible) return super.dispatchKeyEvent(event)
        // touches que la page ne reçoit pas d'elle-même : transmises sous les noms de la télé Samsung
        val name = when (event.keyCode) {
            KeyEvent.KEYCODE_BACK -> "Back"
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> "MediaPlayPause"
            KeyEvent.KEYCODE_MEDIA_PLAY -> "MediaPlay"
            KeyEvent.KEYCODE_MEDIA_PAUSE -> "MediaPause"
            KeyEvent.KEYCODE_MEDIA_STOP -> "MediaStop"
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> "MediaFastForward"
            KeyEvent.KEYCODE_MEDIA_REWIND -> "MediaRewind"
            KeyEvent.KEYCODE_CHANNEL_UP -> "ChannelUp"
            KeyEvent.KEYCODE_CHANNEL_DOWN -> "ChannelDown"
            KeyEvent.KEYCODE_INFO -> "Info"
            else -> null
        } ?: return super.dispatchKeyEvent(event)
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) js("window.ANDROID_KEY && ANDROID_KEY('$name')")
        return true
    }

    override fun onPause() {
        super.onPause()
        js("window.ENGINE && ENGINE.flush && ENGINE.flush()")
    }

    override fun onStop() {
        super.onStop()
        if (player.visible) player.stop(true)        // l'appli passe en arrière-plan : lecture arrêtée (connexion libérée)
    }

    /* ------------------------------------------------------------------ pont avec la page (même protocole que l'iPad) */

    inner class Bridge {
        @JavascriptInterface
        fun testConfig(): String? = this@MainActivity.testConfig

        @JavascriptInterface
        fun post(id: String, json: String) {
            val m = try { JSONObject(json) } catch (e: Exception) { reply(id, "message illisible", null); return }
            when (m.optString("cmd")) {
                "http" -> Net.pool.execute {
                    try { reply(id, null, Net.http(m).toString()) }
                    catch (e: Exception) { reply(id, if (e is java.io.InterruptedIOException) "délai dépassé" else "réseau", null) }
                }
                "kv" -> Net.pool.execute {
                    val k = m.optString("key")
                    when (m.optString("op")) {
                        "get" -> reply(id, null, Kv.get(k)?.let { JSONObject.quote(it) } ?: "null")
                        "set" -> reply(id, null, Kv.set(k, m.optString("value")).toString())
                        else -> reply(id, null, Kv.del(k).toString())
                    }
                }
                "play" -> runOnUiThread { player.play(m); reply(id, null, "true") }
                "stop" -> runOnUiThread { player.stop(false); reply(id, null, "true") }
                "openURL" -> runOnUiThread {
                    try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(m.optString("url")))); reply(id, null, "true") }
                    catch (e: Exception) { reply(id, "aucune application pour ouvrir ce lien", null) }
                }
                "caps" -> reply(id, null, JSONObject.quote(Caps.summary()))
                "exit" -> runOnUiThread { finishAndRemoveTask(); reply(id, null, "true") }
                "haptic" -> reply(id, null, "true")
                else -> reply(id, "commande inconnue", null)
            }
        }

        /** Réponse à la page : result est déjà du JSON (objet, chaîne entre guillemets, true…). */
        private fun reply(id: String, err: String?, result: String?) {
            js("window.__nr(${JSONObject.quote(id)}, ${err?.let { JSONObject.quote(it) } ?: "null"}, ${result ?: "null"})")
        }
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
    }

    @Suppress("unused")
    private fun hideSystemUi() { window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_FULLSCREEN }
}
