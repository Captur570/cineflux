package app.shippotv.android

import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.media3.common.util.UnstableApi
import org.json.JSONObject

/** Écran de lecture natif, par-dessus l'interface : choisit le lecteur (Android ou VLC) avant chaque
 *  lecture, bascule sur l'autre s'il échoue, et renvoie à la page les mêmes évènements que l'iPad. */
@UnstableApi
class PlayerHost(private val act: MainActivity) : EngineCb {
    data class Stream(val url: String, val label: String, val ext: String, val id: Any?)
    data class Item(val title: String, val sub: String, val kind: String, val key: String, val live: Boolean,
                    val streams: List<Stream>, val start: Long, val next: Boolean, val nextLabel: String)

    private val h = Handler(Looper.getMainLooper())
    private val prefs = act.getSharedPreferences("lecteur", Context.MODE_PRIVATE)
    private val root = FrameLayout(act).apply { setBackgroundColor(Color.BLACK); isFocusable = true }
    private val video = FrameLayout(act)
    private val overlay = FrameLayout(act)
    private val title = text(30f, true)
    private val sub = text(19f, false, 0xFFD0D0D0.toInt())
    private val bar = ProgressBar(act, null, android.R.attr.progressBarStyleHorizontal).apply { max = 1000 }
    private val time = text(18f, true)
    private val engineLabel = text(16f, false, 0xFFB0B0B0.toInt())
    private val spinner = ProgressBar(act)
    private val msg = text(24f, true).apply { gravity = Gravity.CENTER }
    private val banner = text(17f, false).apply {
        background = GradientDrawable().apply { cornerRadius = dp(14f); setColor(0xCC000000.toInt()) }
        setPadding(dp(18f).toInt(), dp(10f).toInt(), dp(18f).toInt(), dp(10f).toInt())
    }
    private val nextHint = text(18f, true).apply {
        background = GradientDrawable().apply { cornerRadius = dp(12f); setColor(0xDDA51D43.toInt()) }
        setPadding(dp(16f).toInt(), dp(8f).toInt(), dp(16f).toInt(), dp(8f).toInt())
    }

    private var item: Item? = null
    private var idx = 0
    private var engine: VEngine? = null
    private var engineKind = ""
    private var tried = mutableSetOf<String>()
    private var firstFrame = false
    private var retries = 0
    private var startAt = 0L
    private var playingSince = 0L
    private var lastReport = 0L
    private var shown = false
    private var gen = 0

    val visible get() = shown

    init {
        root.addView(video, FrameLayout.LayoutParams(-1, -1))
        root.addView(overlay, FrameLayout.LayoutParams(-1, -1))
        val top = LinearLayout(act).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(48f).toInt(), dp(32f).toInt(), dp(48f).toInt(), dp(60f).toInt())
            background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(0xCC000000.toInt(), 0x00000000))
            addView(title); addView(sub)
        }
        overlay.addView(top, FrameLayout.LayoutParams(-1, -2, Gravity.TOP))
        val bottom = LinearLayout(act).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(48f).toInt(), dp(60f).toInt(), dp(48f).toInt(), dp(32f).toInt())
            background = GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, intArrayOf(0xCC000000.toInt(), 0x00000000))
            addView(bar, LinearLayout.LayoutParams(-1, dp(8f).toInt()))
            val row = LinearLayout(act).apply { orientation = LinearLayout.HORIZONTAL; setPadding(0, dp(10f).toInt(), 0, 0) }
            row.addView(time, LinearLayout.LayoutParams(0, -2, 1f))
            row.addView(engineLabel)
            addView(row)
        }
        overlay.addView(bottom, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM))
        root.addView(spinner, FrameLayout.LayoutParams(dp(64f).toInt(), dp(64f).toInt(), Gravity.CENTER))
        root.addView(msg, FrameLayout.LayoutParams(-1, -2, Gravity.CENTER).apply { leftMargin = dp(80f).toInt(); rightMargin = dp(80f).toInt() })
        root.addView(banner, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.END).apply { topMargin = dp(36f).toInt(); rightMargin = dp(40f).toInt() })
        root.addView(nextHint, FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM or Gravity.END).apply { bottomMargin = dp(110f).toInt(); rightMargin = dp(48f).toInt() })
        banner.visibility = View.GONE; nextHint.visibility = View.GONE; msg.visibility = View.GONE
        bar.progressDrawable?.setTint(0xFFD6375F.toInt())
    }

    private fun dp(v: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, act.resources.displayMetrics)
    private fun text(sp: Float, bold: Boolean, color: Int = Color.WHITE) = TextView(act).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sp); setTextColor(color); if (bold) typeface = Typeface.DEFAULT_BOLD
        setShadowLayer(6f, 0f, 2f, 0xAA000000.toInt())
    }

    /* ------------------------------------------------------------------ commandes de la page */

    fun play(m: JSONObject) {
        val arr = m.optJSONArray("streams")
        val streams = (0 until (arr?.length() ?: 0)).map { i ->
            val s = arr!!.getJSONObject(i)
            Stream(s.getString("url"), s.optString("label"), s.optString("ext"), s.opt("id"))
        }
        if (streams.isEmpty()) return
        item = Item(m.optString("title"), m.optString("sub"), m.optString("kind", "movie"), m.optString("key"),
            m.optBoolean("live"), streams, (m.optDouble("start", 0.0) * 1000).toLong(), m.optBoolean("next"), m.optString("nextLabel"))
        if (!shown) {
            act.root.addView(root, FrameLayout.LayoutParams(-1, -1))
            shown = true
            act.webView.visibility = View.INVISIBLE
        }
        root.requestFocus()
        idx = 0
        tried.clear()
        retries = 0
        startStream(0, item!!.start, null)
        h.removeCallbacks(tick); h.post(tick)
    }

    fun stop(emit: Boolean) {
        if (!shown) return
        val it = item
        val e = engine
        if (emit && it != null && e != null) {
            act.emitPlayer(JSONObject().put("type", "closed").put("pos", e.pos / 1000.0).put("dur", e.dur.coerceAtLeast(0) / 1000.0).put("idx", idx))
        } else if (emit) act.emitPlayer(JSONObject().put("type", "closed"))
        release()
        h.removeCallbacksAndMessages(null)
        act.root.removeView(root)
        act.webView.visibility = View.VISIBLE
        act.webView.requestFocus()
        shown = false
        item = null
    }

    private fun release() {
        gen++
        engine?.release()
        engine = null
    }

    /* ------------------------------------------------------------------ choix du lecteur et démarrage */

    private fun memoryKey(it: Item, s: Stream) = "moteur:" + (if (it.key.isNotEmpty()) "${it.kind}:${it.key}" else s.url.hashCode().toString())

    private fun startStream(i: Int, startMs: Long, forced: String?) {
        val it = item ?: return
        val s = it.streams[i]
        idx = i
        startAt = startMs
        release()
        val myGen = gen
        firstFrame = false
        playingSince = 0L
        spinner.visibility = View.VISIBLE
        msg.visibility = View.GONE
        title.text = it.title
        sub.text = listOf(it.sub, if (it.streams.size > 1) s.label else "").filter { x -> x.isNotBlank() }.joinToString(" · ")
        showOverlay()
        Net.pool.execute {
            val pref = prefs.getString("defaut", "auto") ?: "auto"
            val remembered = prefs.getString(memoryKey(it, s), null)
            val d: Decision = when {
                forced != null -> Decision(forced, "choisi")
                pref != "auto" -> Decision(pref, "réglage du lecteur par défaut")
                remembered != null -> Decision(remembered, "retenu pour ce titre")
                !it.live && (s.ext.equals("mkv", true) || s.url.substringBefore('?').endsWith(".mkv", true)) ->
                    Choice.decide(Probe.mkv(s.url), s.label, s.ext, false)
                else -> Choice.decide(null, s.label, s.ext, it.live)
            }
            Log.i("ShippoTV", "[lecteur] ${it.title} (${s.label}) → ${d.engine} : ${d.reason}")
            h.post {
                if (myGen != gen || item !== it) return@post
                launch(d, s, startMs)
            }
        }
    }

    private fun launch(d: Decision, s: Stream, startMs: Long) {
        engineKind = d.engine
        tried += d.engine
        engine = if (d.engine == "vlc") VlcEngine(act, video, this) else Media3Engine(act, video, this)
        engineLabel.text = "Lecteur ${engine!!.name}"
        showBanner("Lecteur ${engine!!.name} · ${d.reason}")
        try { engine!!.start(s.url, startMs) } catch (e: Exception) { onError(e.message ?: "erreur") }
    }

    private fun other() = if (engineKind == "vlc") "media3" else "vlc"
    private fun otherName() = if (engineKind == "vlc") "lecteur Android" else "VLC"

    /* ------------------------------------------------------------------ évènements des lecteurs */

    override fun onReady() { if (playingSince == 0L) playingSince = System.currentTimeMillis() }
    override fun onBuffering(on: Boolean) { spinner.visibility = if (on && firstFrame) View.VISIBLE else if (!firstFrame) View.VISIBLE else View.GONE }
    override fun onFirstFrame() {
        firstFrame = true
        retries = 0
        spinner.visibility = View.GONE
        Log.i("ShippoTV", "[lecteur] première image (${engine?.name})")
        act.emitPlayer(JSONObject().put("type", "started").put("engine", engine?.name))
    }

    override fun onEnded() {
        val it = item ?: return
        val e = engine ?: return
        if (it.live) { onError("flux interrompu"); return }
        val d = e.dur
        if (d > 60000 && e.pos < d * 0.9) { onError("coupure"); return }      // « fin » bien avant la fin : coupure réseau
        act.emitPlayer(JSONObject().put("type", "ended").put("dur", d / 1000.0).put("idx", idx))
    }

    override fun onError(msg: String) {
        val it = item ?: return
        val s = it.streams[idx]
        Log.w("ShippoTV", "[lecteur] erreur ${engine?.name} : $msg")
        if (!firstFrame) {
            if (other() !in tried) {
                // l'autre lecteur prend le relais, et on s'en souvient pour ce titre
                prefs.edit().putString(memoryKey(it, s), other()).apply()
                showBanner("Le ${if (engineKind == "vlc") "lecteur VLC" else "lecteur Android"} n'y arrive pas : ${otherName()} prend le relais")
                val keep = engine?.pos?.takeIf { p -> p > 0 } ?: startAt
                startStream(idx, keep, other())
                return
            }
            if (idx + 1 < it.streams.size) {
                tried.clear()
                showBanner("Cette version ne répond pas : version suivante")
                startStream(idx + 1, startAt, null)
                return
            }
            fail("Lecture impossible : aucune version ne répond pour le moment.")
            return
        }
        // coupure en pleine lecture : on reprend au même endroit (3 essais)
        if (retries < 3) {
            retries++
            val at = if (it.live) 0L else ((engine?.pos ?: 0L) - 2000).coerceAtLeast(0)
            showBanner("Coupure : reprise…")
            val g = gen
            h.postDelayed({ if (g == gen) { firstFrame = false; tried.clear(); startStream(idx, at, engineKind) } }, 1500)
        } else fail("La lecture s'est interrompue. Retour pour quitter, OK pour réessayer.")
    }

    private fun fail(text: String) {
        spinner.visibility = View.GONE
        msg.text = text
        msg.visibility = View.VISIBLE
        showOverlay(sticky = true)
    }

    /* ------------------------------------------------------------------ affichage */

    private val hideOverlay = Runnable { overlay.animate().alpha(0f).setDuration(300).start() }
    private fun showOverlay(sticky: Boolean = false) {
        overlay.animate().cancel(); overlay.alpha = 1f
        h.removeCallbacks(hideOverlay)
        if (!sticky) h.postDelayed(hideOverlay, 4500)
    }
    private val hideBanner = Runnable { banner.visibility = View.GONE }
    private fun showBanner(t: String) {
        banner.text = t
        banner.visibility = View.VISIBLE
        h.removeCallbacks(hideBanner)
        h.postDelayed(hideBanner, 6000)
    }

    private fun clock(ms: Long): String {
        val t = (ms / 1000).toInt()
        return if (t >= 3600) "%d:%02d:%02d".format(t / 3600, t / 60 % 60, t % 60) else "%d:%02d".format(t / 60, t % 60)
    }

    private val tick: Runnable = object : Runnable {
        override fun run() {
            if (!shown) return
            val it = item; val e = engine
            if (it != null && e != null) {
                val p = e.pos; val d = e.dur
                if (it.live) { time.text = "● DIRECT"; bar.progress = 1000 }
                else {
                    time.text = if (d > 0) "${clock(p)} / ${clock(d)}" else clock(p)
                    bar.progress = if (d > 0) (p * 1000 / d).toInt() else 0
                }
                // le son avance mais aucune image après 7 s (vidéo que le lecteur Android ne décode pas) : VLC
                if (!firstFrame && engineKind == "media3" && e.playing && playingSince > 0 &&
                    System.currentTimeMillis() - playingSince > 7000 && e.hasVideo) {
                    Log.w("ShippoTV", "[lecteur] du son mais pas d'image")
                    onError("pas d'image")
                }
                val now = System.currentTimeMillis()
                if (!it.live && e.playing && d > 0 && now - lastReport > 10000 && p > 5000) {
                    lastReport = now
                    act.emitPlayer(JSONObject().put("type", "progress").put("pos", p / 1000.0).put("dur", d / 1000.0).put("idx", idx))
                }
                if (it.next && d > 0 && d - p in 1..45000) {
                    nextHint.text = "Épisode suivant : ${it.nextLabel.ifEmpty { "à la fin" }}  ⏭"
                    nextHint.visibility = View.VISIBLE
                } else nextHint.visibility = View.GONE
            }
            h.postDelayed(this, 1000)
        }
    }

    /* ------------------------------------------------------------------ télécommande */

    fun onKey(ev: KeyEvent): Boolean {
        val it = item ?: return false
        val e = engine
        val code = ev.keyCode
        val handled = setOf(KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER,
            KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN,
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE, KeyEvent.KEYCODE_SPACE,
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD, KeyEvent.KEYCODE_MEDIA_REWIND, KeyEvent.KEYCODE_MEDIA_NEXT, KeyEvent.KEYCODE_MEDIA_STOP,
            KeyEvent.KEYCODE_CHANNEL_UP, KeyEvent.KEYCODE_CHANNEL_DOWN, KeyEvent.KEYCODE_PAGE_UP, KeyEvent.KEYCODE_PAGE_DOWN,
            KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_INFO, KeyEvent.KEYCODE_CAPTIONS)
        if (code !in handled) return false
        if (ev.action != KeyEvent.ACTION_DOWN) return true
        showOverlay()
        val zap = { d: Int -> act.emitPlayer(JSONObject().put("type", "zap").put("d", d)) }
        val seek = { s: Long -> e?.let { x -> x.seekTo(x.pos + s * (if (ev.repeatCount > 3) 3 else 1)) } }
        when (code) {
            KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_MEDIA_STOP -> if (ev.repeatCount == 0) stop(true)
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> {
                if (ev.repeatCount == 2) options()                         // appui long : options
                else if (ev.repeatCount == 0) {
                    if (msg.visibility == View.VISIBLE) { tried.clear(); retries = 0; startStream(idx, ((e?.pos ?: startAt) - 2000).coerceAtLeast(0), null) }
                    else if (!it.live) togglePause()
                }
            }
            KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_INFO, KeyEvent.KEYCODE_CAPTIONS -> if (ev.repeatCount == 0) options()
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_SPACE -> if (ev.repeatCount == 0) togglePause()
            KeyEvent.KEYCODE_MEDIA_PLAY -> e?.play()
            KeyEvent.KEYCODE_MEDIA_PAUSE -> e?.pause()
            KeyEvent.KEYCODE_DPAD_LEFT -> if (it.live) { if (ev.repeatCount == 0) zap(-1) } else seek(-10000)
            KeyEvent.KEYCODE_DPAD_RIGHT -> if (it.live) { if (ev.repeatCount == 0) zap(1) } else seek(30000)
            KeyEvent.KEYCODE_MEDIA_REWIND -> seek(-10000)
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> seek(30000)
            KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_CHANNEL_UP, KeyEvent.KEYCODE_PAGE_UP ->
                if (it.live) { if (ev.repeatCount == 0) zap(-1) }
            KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_CHANNEL_DOWN, KeyEvent.KEYCODE_PAGE_DOWN ->
                if (it.live) { if (ev.repeatCount == 0) zap(1) } else if (code == KeyEvent.KEYCODE_DPAD_DOWN && ev.repeatCount == 0) options()
            KeyEvent.KEYCODE_MEDIA_NEXT -> if (it.next && e != null)
                act.emitPlayer(JSONObject().put("type", "next").put("pos", e.pos / 1000.0).put("dur", e.dur / 1000.0).put("idx", idx))
        }
        return true
    }

    private fun togglePause() {
        val e = engine ?: return
        if (e.playing) { e.pause(); showOverlay(sticky = true); time.text = "⏸  " + time.text } else e.play()
    }

    /* ------------------------------------------------------------------ options : langue, sous-titres, version, lecteur */

    private fun dialog() = AlertDialog.Builder(act, android.R.style.Theme_DeviceDefault_Dialog_Alert)

    private fun options() {
        val it = item ?: return
        val e = engine ?: return
        val a = e.audio(); val t = e.text()
        val labels = mutableListOf<String>(); val actions = mutableListOf<() -> Unit>()
        if (a.size > 1) { labels += "Langue : ${a.firstOrNull { x -> x.selected }?.label ?: "—"}"; actions += { pick("Langue", a, false) } }
        if (t.isNotEmpty()) { labels += "Sous-titres : ${t.firstOrNull { x -> x.selected }?.label ?: "aucun"}"; actions += { pick("Sous-titres", t, true) } }
        if (it.streams.size > 1) { labels += "Version : ${it.streams[idx].label}"; actions += { versions() } }
        labels += "Lire avec " + (if (engineKind == "vlc") "le lecteur Android" else "VLC")
        actions += {
            prefs.edit().putString(memoryKey(it, it.streams[idx]), other()).apply()
            val at = if (it.live) 0L else e.pos
            tried.clear()
            startStream(idx, at, other())
        }
        labels += "Ouvrir avec une autre application…"; actions += { openWith() }
        val def = prefs.getString("defaut", "auto")
        labels += "Lecteur par défaut : " + when (def) { "vlc" -> "VLC"; "media3" -> "Android"; else -> "automatique" }
        actions += { defaultPlayer() }
        dialog().setTitle(it.title).setItems(labels.toTypedArray()) { _, w -> actions[w]() }.show()
    }

    private fun pick(name: String, list: List<Tr>, allowNone: Boolean) {
        val e = engine ?: return
        val labels = (if (allowNone) listOf("Aucun") else emptyList()) + list.map { (if (it.selected) "✓  " else "") + it.label }
        dialog().setTitle(name).setItems(labels.toTypedArray()) { _, w ->
            if (allowNone && w == 0) e.selectText(null)
            else { val tr = list[if (allowNone) w - 1 else w]; if (allowNone) e.selectText(tr) else e.selectAudio(tr) }
        }.show()
    }

    private fun versions() {
        val it = item ?: return
        dialog().setTitle("Version").setItems(it.streams.mapIndexed { i, s -> (if (i == idx) "✓  " else "") + s.label.ifEmpty { "Version ${i + 1}" } }.toTypedArray()) { _, w ->
            tried.clear()
            startStream(w, if (it.live) 0L else (engine?.pos ?: 0L), null)
        }.show()
    }

    private fun defaultPlayer() {
        val opts = arrayOf("automatique (recommandé)", "toujours le lecteur Android", "toujours VLC")
        val vals = arrayOf("auto", "media3", "vlc")
        dialog().setTitle("Lecteur par défaut").setItems(opts) { _, w -> prefs.edit().putString("defaut", vals[w]).apply() }.show()
    }

    private fun openWith() {
        val it = item ?: return
        val s = it.streams[idx]
        val pos = engine?.pos ?: 0L
        val i = Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse(s.url), "video/*")
            .putExtra("title", if (it.sub.isNotBlank() && it.kind != "movie") "${it.title} · ${it.sub}" else it.title)
            .putExtra("position", pos.toInt())                                  // reprise (VLC, MX Player, Just Player)
            .putExtra("from_start", false)
        stop(true)
        try { act.startActivity(Intent.createChooser(i, "Ouvrir avec…")) }
        catch (_: Exception) { act.js("toast('Aucune autre application vidéo installée','warn')") }
    }
}
