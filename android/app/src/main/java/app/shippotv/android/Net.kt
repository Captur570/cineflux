package app.shippotv.android

import android.content.Context
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Réseau du moteur (sans restriction CORS) et stockage clé → valeur (fichiers), comme sur l'iPad. */
object Net {
    const val UA = "VLC/3.0.21 LibVLC/3.0.21"
    val pool = Executors.newFixedThreadPool(8)
    val client: OkHttpClient = OkHttpClient.Builder()
        .followRedirects(true).followSslRedirects(true)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    /** {url, method, headers, body, timeout} → {status, text} */
    fun http(m: JSONObject): JSONObject {
        val timeout = m.optDouble("timeout", 60.0).coerceIn(2.0, 300.0)
        val c = client.newBuilder().callTimeout((timeout * 1000).toLong(), TimeUnit.MILLISECONDS).build()
        val method = m.optString("method", "GET").uppercase()
        val b = Request.Builder().url(m.getString("url"))
        var ctype: String? = null
        m.optJSONObject("headers")?.let { h ->
            for (k in h.keys()) {
                val v = h.optString(k)
                if (k.equals("Content-Type", true)) ctype = v
                b.header(k, v)
            }
        }
        if (m.optJSONObject("headers")?.has("User-Agent") != true) b.header("User-Agent", "ShippoTV")
        val body = if (m.isNull("body")) null else m.optString("body")
        if (method == "GET" || method == "HEAD") b.method(method, null)
        else b.method(method, (body ?: "").toRequestBody((ctype ?: "application/json").toMediaTypeOrNull()))
        c.newCall(b.build()).execute().use { r ->
            return JSONObject().put("status", r.code).put("text", r.body?.string() ?: "")
        }
    }
}

object Kv {
    private lateinit var dir: File
    fun init(ctx: Context) { dir = File(ctx.filesDir, "kv").apply { mkdirs() } }
    private fun f(k: String) = File(dir, k.replace(Regex("[^A-Za-z0-9._-]"), "_") + ".json")
    @Synchronized fun get(k: String): String? = f(k).takeIf { it.exists() }?.readText()
    @Synchronized fun set(k: String, v: String): Boolean {
        val t = File(dir, "tmp-" + System.nanoTime())
        t.writeText(v)
        return t.renameTo(f(k))
    }
    @Synchronized fun del(k: String): Boolean = f(k).delete()
}
