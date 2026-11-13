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
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.content.Context as Ctx
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
    private val seek = SeekView(act)
    private val time = text(19f, true)
    private val remain = text(17f, false, 0xFFC8C8C8.toInt())
    private val buttons = LinearLayout(act).apply { orientation = LinearLayout.HORIZONTAL }
    private val panel = LinearLayout(act).apply {
        orientation = LinearLayout.VERTICAL
        background = GradientDrawable().apply { setColor(0xF0141016.toInt()) }
    }
    private val panelTitle = text(26f, true)
    private val panelList = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL }
    private val panelScroll = android.widget.ScrollView(act).apply { isVerticalScrollBarEnabled = false; isFocusable = false }
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
            setPadding(dp(48f).toInt(), dp(90f).toInt(), dp(48f).toInt(), dp(30f).toInt())
            background = GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, intArrayOf(0xE6000000.toInt(), 0x00000000))
            addView(seek, LinearLayout.LayoutParams(-1, dp(46f).toInt()))
            val row = LinearLayout(act).apply { orientation = LinearLayout.HORIZONTAL; setPadding(0, dp(2f).toInt(), 0, dp(16f).toInt()) }
            row.addView(time, LinearLayout.LayoutParams(0, -2, 1f))
            row.addView(remain)
            addView(row)
            addView(android.widget.HorizontalScrollView(act).apply { isHorizontalScrollBarEnabled = false; isFocusable = false; addView(buttons) })
        }
        overlay.addView(bottom, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM))
        panel.setPadding(dp(28f).toInt(), dp(40f).toInt(), dp(28f).toInt(), dp(28f).toInt())
        panel.addView(panelTitle, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(18f).toInt() })
        panelScroll.addView(panelList)
        panel.addView(panelScroll, LinearLayout.LayoutParams(-1, 0, 1f))
        root.addView(spinner, FrameLayout.LayoutParams(dp(64f).toInt(), dp(64f).toInt(), Gravity.CENTER))
        root.addView(msg, FrameLayout.LayoutParams(-1, -2, Gravity.CENTER).apply { leftMargin = dp(80f).toInt(); rightMargin = dp(80f).toInt() })
        root.addView(banner, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.END).apply { topMargin = dp(36f).toInt(); rightMargin = dp(40f).toInt() })
        root.addView(nextHint, FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM or Gravity.END).apply { bottomMargin = dp(110f).toInt(); rightMargin = dp(48f).toInt() })
        banner.visibility = View.GONE; nextHint.visibility = View.GONE; msg.visibility = View.GONE
        root.addView(panel, FrameLayout.LayoutParams(dp(460f).toInt(), -1, Gravity.END))
        panel.visibility = View.GONE
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
        mode = Mode.HIDDEN; preview = null; panel.visibility = View.GONE
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
        mode = Mode.HIDDEN; preview = null; panel.visibility = View.GONE
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
        if (mode == Mode.HIDDEN) { overlay.alpha = 1f; overlay.visibility = View.VISIBLE; h.removeCallbacks(introHide); h.postDelayed(introHide, 4000) }
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
        showControls(1, "version")
    }

    /* ------------------------------------------------------------------ affichage */

    private val introHide = Runnable { if (mode == Mode.HIDDEN) overlay.animate().alpha(0f).setDuration(300).start() }
    private val hideBanner = Runnable { banner.visibility = View.GONE }
    private fun showBanner(t: String) {
        banner.text = t
        banner.visibility = View.VISIBLE
        h.removeCallbacks(hideBanner)
        h.postDelayed(hideBanner, 6000)
    }

    private fun clock(ms: Long): String {
        val t = (ms.coerceAtLeast(0) / 1000).toInt()
        return if (t >= 3600) "%d:%02d:%02d".format(t / 3600, t / 60 % 60, t % 60) else "%d:%02d".format(t / 60, t % 60)
    }

    private val tick: Runnable = object : Runnable {
        override fun run() {
            if (!shown) return
            val it = item; val e = engine
            if (it != null && e != null) {
                val p = e.pos; val d = e.dur
                refreshTime(p, d)
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
                if (it.next && d > 0 && d - p in 1..45000 && mode == Mode.HIDDEN) {
                    nextHint.text = "Épisode suivant : ${it.nextLabel.ifEmpty { "à la fin" }}  ⏭"
                    nextHint.visibility = View.VISIBLE
                } else nextHint.visibility = View.GONE
            }
            h.postDelayed(this, 500)
        }
    }

    private fun refreshTime(p: Long, d: Long) {
        val it = item ?: return
        if (it.live) { time.text = "● DIRECT"; remain.text = ""; seek.set(1f, null, false); return }
        val shownPos = preview ?: p
        time.text = clock(shownPos)
        remain.text = if (d > 0) "-" + clock(d - shownPos) + "   ·   " + clock(d) else ""
        val tgt = preview?.let { pv -> Pair(if (d > 0) pv.toFloat() / d else 0f, clock(pv)) }
        seek.set(if (d > 0) p.toFloat() / d else 0f, tgt, focusRow == 0 && mode == Mode.CONTROLS)
    }

    /* ------------------------------------------------------------------ barre de commandes, avance rapide, panneaux */

    private enum class Mode { HIDDEN, CONTROLS, PANEL }
    private var mode = Mode.HIDDEN
    private var focusRow = 1                    // 0 : barre de progression, 1 : boutons
    private var btn = 0
    private data class Btn(val id: String, val label: String, val act: () -> Unit)
    private var btns = listOf<Btn>()
    private val btnViews = mutableListOf<TextView>()
    private var preview: Long? = null           // position visée pendant l'avance rapide
    private var scrubTimes = 0
    private var lastScrub = 0L
    private var panelRows = listOf<Pair<String, () -> Unit>>()
    private var panelSel = 0
    private val panelViews = mutableListOf<TextView>()

    private fun pill(focused: Boolean, v: TextView) {
        v.background = GradientDrawable().apply { cornerRadius = dp(26f); setColor(if (focused) Color.WHITE else 0x33FFFFFF) }
        v.setTextColor(if (focused) Color.BLACK else Color.WHITE)
        v.setShadowLayer(if (focused) 0f else 6f, 0f, 2f, 0xAA000000.toInt())
    }

    private fun buildButtons() {
        val it = item ?: return
        val e = engine
        val list = mutableListOf<Btn>()
        if (!it.live) list += Btn("pause", if (e?.playing == false) "▶  Lecture" else "❚❚  Pause") { togglePause(); buildButtons() }
        if (!it.live) list += Btn("back10", "↺ 10 s") { seekBy(-10000) }
        if (!it.live) list += Btn("fwd30", "30 s ↻") { seekBy(30000) }
        val a = e?.audio().orEmpty(); val t = e?.text().orEmpty()
        list += Btn("audio", "Langue · " + (a.firstOrNull { x -> x.selected }?.label?.ifBlank { null } ?: if (a.isEmpty()) "—" else "auto")) { panelAudio() }
        list += Btn("subs", "Sous-titres · " + (t.firstOrNull { x -> x.selected }?.label?.ifBlank { null } ?: "aucun")) { panelSubs() }
        if (it.streams.size > 1) list += Btn("version", (if (it.live) "Source · " else "Version · ") + it.streams[idx].label.ifEmpty { "${idx + 1}" }) { panelVersions() }
        if (it.next) list += Btn("next", "Épisode suivant ⏭") { e?.let { x -> act.emitPlayer(JSONObject().put("type", "next").put("pos", x.pos / 1000.0).put("dur", x.dur / 1000.0).put("idx", idx)) } }
        list += Btn("player", "Lecteur · " + (e?.name ?: "…")) { panelPlayer() }
        val keepId = btns.getOrNull(btn)?.id
        btns = list
        btn = btns.indexOfFirst { b -> b.id == keepId }.takeIf { x -> x >= 0 } ?: btn.coerceIn(0, btns.size - 1)
        buttons.removeAllViews(); btnViews.clear()
        btns.forEachIndexed { i, b ->
            val v = text(17f, true).apply { this.text = b.label; setPadding(dp(22f).toInt(), dp(11f).toInt(), dp(22f).toInt(), dp(11f).toInt()) }
            buttons.addView(v, LinearLayout.LayoutParams(-2, -2).apply { rightMargin = dp(12f).toInt() })
            btnViews += v
        }
        paintButtons()
    }

    private fun paintButtons() {
        btnViews.forEachIndexed { i, v -> pill(mode == Mode.CONTROLS && focusRow == 1 && i == btn, v) }
        btnViews.getOrNull(btn)?.let { v -> (buttons.parent as? android.widget.HorizontalScrollView)?.let { sv -> sv.post { sv.smoothScrollTo((v.left - dp(120f).toInt()).coerceAtLeast(0), 0) } } }
        val e = engine ?: return
        refreshTime(e.pos, e.dur)
    }

    private val autoHide = Runnable { if (mode == Mode.CONTROLS && preview == null && engine?.playing != false) hideControls() }
    private fun kick() { h.removeCallbacks(autoHide); h.postDelayed(autoHide, 6000) }

    private fun showControls(row: Int, focusId: String? = null) {
        val it = item ?: return
        mode = Mode.CONTROLS
        focusRow = if (it.live) 1 else row
        buildButtons()
        if (focusId != null) btns.indexOfFirst { b -> b.id == focusId }.takeIf { x -> x >= 0 }?.let { x -> btn = x }
        overlay.animate().cancel(); overlay.alpha = 1f; overlay.visibility = View.VISIBLE
        nextHint.visibility = View.GONE
        paintButtons()
        kick()
    }

    private fun hideControls() {
        mode = Mode.HIDDEN
        preview = null
        overlay.animate().alpha(0f).setDuration(250).withEndAction { if (mode == Mode.HIDDEN) overlay.visibility = View.INVISIBLE }.start()
    }

    /** Avance / retour rapide : chaque appui déplace le repère, de plus en plus vite si on insiste ;
     *  la lecture saute à l'endroit choisi quand on relâche (ou tout de suite avec OK). */
    private fun scrub(dir: Int, repeat: Int) {
        val e = engine ?: return
        val now = System.currentTimeMillis()
        scrubTimes = if (now - lastScrub < 700) scrubTimes + 1 else 0
        lastScrub = now
        val n = maxOf(repeat, scrubTimes)
        val step = when { n < 3 -> 10_000L; n < 8 -> 30_000L; n < 16 -> 60_000L; else -> 180_000L }
        val d = e.dur
        val base = preview ?: e.pos
        preview = (base + dir * step).coerceIn(0, if (d > 0) d - 1000 else Long.MAX_VALUE)
        if (mode != Mode.CONTROLS) showControls(0) else { focusRow = 0; paintButtons() }
        h.removeCallbacks(commitScrub); h.postDelayed(commitScrub, 900)
        kick()
    }
    private val commitScrub = Runnable { preview?.let { p -> engine?.seekTo(p) }; preview = null; paintButtons(); kick() }

    private fun seekBy(ms: Long) { engine?.let { x -> x.seekTo((x.pos + ms).coerceAtLeast(0)) }; kick() }

    private fun openPanel(titleText: String, rows: List<Pair<String, () -> Unit>>, selected: Int) {
        if (rows.isEmpty()) return
        mode = Mode.PANEL
        h.removeCallbacks(autoHide)
        panelTitle.text = titleText
        panelRows = rows
        panelSel = selected.coerceIn(0, rows.size - 1)
        panelList.removeAllViews(); panelViews.clear()
        rows.forEach { (label, _) ->
            val v = text(19f, false).apply { this.text = label; setPadding(dp(22f).toInt(), dp(14f).toInt(), dp(22f).toInt(), dp(14f).toInt()) }
            panelList.addView(v, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(6f).toInt() })
            panelViews += v
        }
        panel.visibility = View.VISIBLE
        paintPanel()
        paintButtons()
    }

    private fun paintPanel() {
        panelViews.forEachIndexed { i, v ->
            v.background = GradientDrawable().apply { cornerRadius = dp(14f); setColor(if (i == panelSel) Color.WHITE else 0x00000000) }
            v.setTextColor(if (i == panelSel) Color.BLACK else Color.WHITE)
        }
        panelViews.getOrNull(panelSel)?.let { v -> panelScroll.post { panelScroll.smoothScrollTo(0, (v.top - dp(80f).toInt()).coerceAtLeast(0)) } }
    }

    private fun closePanel() {
        panel.visibility = View.GONE
        showControls(1)
    }

    private fun check(on: Boolean, label: String) = (if (on) "✓   " else "      ") + label

    private fun panelAudio() {
        val e = engine ?: return
        val a = e.audio()
        if (a.isEmpty()) { showBanner("Une seule langue dans cette version"); return }
        openPanel("Langue", a.map { tr -> check(tr.selected, tr.label.ifBlank { "Piste" }) to { e.selectAudio(tr); closeSoon() } }, a.indexOfFirst { x -> x.selected })
    }

    private fun panelSubs() {
        val e = engine ?: return
        val t = e.text()
        val rows = mutableListOf<Pair<String, () -> Unit>>(check(t.none { x -> x.selected }, "Aucun") to { e.selectText(null); closeSoon() })
        t.forEach { tr -> rows += check(tr.selected, tr.label.ifBlank { "Sous-titres" }) to { e.selectText(tr); closeSoon() } }
        if (t.isEmpty()) rows += "      (pas de sous-titres dans cette version)" to { }
        openPanel("Sous-titres", rows, t.indexOfFirst { x -> x.selected } + 1)
    }

    private fun panelVersions() {
        val it = item ?: return
        openPanel(if (it.live) "Source" else "Version", it.streams.mapIndexed { i, s ->
            check(i == idx, s.label.ifEmpty { "Version ${i + 1}" }) to {
                panel.visibility = View.GONE; hideControls()
                tried.clear(); startStream(i, if (it.live) 0L else (engine?.pos ?: 0L), null)
            }
        }, idx)
    }

    private fun panelPlayer() {
        val it = item ?: return
        val e = engine ?: return
        val def = prefs.getString("defaut", "auto") ?: "auto"
        val rows = mutableListOf<Pair<String, () -> Unit>>()
        rows += ("Lire avec " + (if (engineKind == "vlc") "le lecteur Android" else "VLC")) to {
            prefs.edit().putString(memoryKey(it, it.streams[idx]), other()).apply()
            panel.visibility = View.GONE; hideControls()
            tried.clear(); startStream(idx, if (it.live) 0L else e.pos, other())
        }
        rows += "Ouvrir avec une autre application…" to { openWith() }
        for ((v, l) in listOf("auto" to "automatique (recommandé)", "media3" to "toujours le lecteur Android", "vlc" to "toujours VLC"))
            rows += check(def == v, "Par défaut : $l") to { prefs.edit().putString("defaut", v).apply(); showBanner("Lecteur par défaut : $l"); closeSoon() }
        openPanel("Lecteur · ${e.name}", rows, 0)
    }

    private fun closeSoon() { h.postDelayed({ if (mode == Mode.PANEL) closePanel() else buildButtons() }, 250) }

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
        val rep = ev.repeatCount
        val ok = code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER || code == KeyEvent.KEYCODE_NUMPAD_ENTER
        val zap = { d: Int -> if (rep == 0) act.emitPlayer(JSONObject().put("type", "zap").put("d", d)) }

        // touches valables partout
        when (code) {
            KeyEvent.KEYCODE_MEDIA_STOP -> { stop(true); return true }
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_SPACE -> { if (rep == 0 && !it.live) { togglePause(); if (mode == Mode.CONTROLS) buildButtons() }; return true }
            KeyEvent.KEYCODE_MEDIA_PLAY -> { e?.play(); return true }
            KeyEvent.KEYCODE_MEDIA_PAUSE -> { e?.pause(); return true }
            KeyEvent.KEYCODE_MEDIA_REWIND -> { if (!it.live) scrub(-1, rep); return true }
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> { if (!it.live) scrub(1, rep); return true }
            KeyEvent.KEYCODE_CHANNEL_UP, KeyEvent.KEYCODE_PAGE_UP -> { if (it.live) zap(-1); return true }
            KeyEvent.KEYCODE_CHANNEL_DOWN, KeyEvent.KEYCODE_PAGE_DOWN -> { if (it.live) zap(1); return true }
            KeyEvent.KEYCODE_MEDIA_NEXT -> { if (it.next && e != null) act.emitPlayer(JSONObject().put("type", "next").put("pos", e.pos / 1000.0).put("dur", e.dur / 1000.0).put("idx", idx)); return true }
            KeyEvent.KEYCODE_CAPTIONS -> { if (rep == 0) { showControls(1, "subs"); panelSubs() }; return true }
        }
        // écran d'erreur : OK réessaie
        if (msg.visibility == View.VISIBLE && ok && rep == 0) {
            tried.clear(); retries = 0; msg.visibility = View.GONE
            startStream(idx, ((e?.pos ?: startAt) - 2000).coerceAtLeast(0), null); return true
        }

        when (mode) {
            Mode.PANEL -> when (code) {
                KeyEvent.KEYCODE_DPAD_UP -> { if (panelSel > 0) { panelSel--; paintPanel() } }
                KeyEvent.KEYCODE_DPAD_DOWN -> { if (panelSel < panelRows.size - 1) { panelSel++; paintPanel() } }
                KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_DPAD_LEFT -> if (rep == 0) closePanel()
                else -> if ((ok || code == KeyEvent.KEYCODE_DPAD_RIGHT) && rep == 0) panelRows.getOrNull(panelSel)?.second?.invoke()
            }
            Mode.CONTROLS -> {
                kick()
                when (code) {
                    KeyEvent.KEYCODE_BACK -> if (rep == 0) { if (preview != null) { preview = null; h.removeCallbacks(commitScrub); paintButtons() } else hideControls() }
                    KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_INFO -> if (rep == 0) hideControls()
                    KeyEvent.KEYCODE_DPAD_UP -> if (it.live) zap(-1) else if (focusRow == 1) { focusRow = 0; paintButtons() } else if (rep == 0) hideControls()
                    KeyEvent.KEYCODE_DPAD_DOWN -> if (it.live) zap(1) else if (focusRow == 0) { commitNow(); focusRow = 1; paintButtons() }
                    KeyEvent.KEYCODE_DPAD_LEFT -> if (focusRow == 0) scrub(-1, rep) else if (btn > 0) { btn--; paintButtons() }
                    KeyEvent.KEYCODE_DPAD_RIGHT -> if (focusRow == 0) scrub(1, rep) else if (btn < btns.size - 1) { btn++; paintButtons() }
                    else -> if (ok && rep == 0) {
                        if (focusRow == 0) { if (preview != null) commitNow() else { togglePause(); buildButtons() } }
                        else btns.getOrNull(btn)?.act?.invoke()
                    }
                }
            }
            Mode.HIDDEN -> when (code) {
                KeyEvent.KEYCODE_BACK -> if (rep == 0) stop(true)
                KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_INFO -> if (rep == 0) showControls(1, "audio")
                KeyEvent.KEYCODE_DPAD_LEFT -> if (it.live) zap(-1) else scrub(-1, rep)
                KeyEvent.KEYCODE_DPAD_RIGHT -> if (it.live) zap(1) else scrub(1, rep)
                KeyEvent.KEYCODE_DPAD_UP -> if (it.live) zap(-1) else if (rep == 0) showControls(0)
                KeyEvent.KEYCODE_DPAD_DOWN -> if (it.live) zap(1) else if (rep == 0) showControls(1, "audio")
                else -> if (ok && rep == 0) {
                    if (it.live) showControls(1, "audio")
                    else { togglePause(); showControls(1, "pause") }
                }
            }
        }
        return true
    }

    private fun commitNow() { h.removeCallbacks(commitScrub); if (preview != null) commitScrub.run() }

    private fun togglePause() {
        val e = engine ?: return
        if (e.playing) e.pause() else e.play()
        h.postDelayed({ if (mode == Mode.CONTROLS) buildButtons() }, 150)
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

/** Barre de progression de la lecture : position, repère d'avance rapide et heure visée. */
class SeekView(ctx: Ctx) : View(ctx) {
    private var played = 0f
    private var target: Pair<Float, String>? = null
    private var focused = false
    private val d = ctx.resources.displayMetrics.density
    private val track = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0x55FFFFFF }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFD6375F.toInt() }
    private val knob = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
    private val ghost = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xAAFFFFFF.toInt() }
    private val label = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; textSize = 17 * d; typeface = Typeface.DEFAULT_BOLD; textAlign = Paint.Align.CENTER }
    private val tag = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xE6000000.toInt() }

    fun set(p: Float, t: Pair<Float, String>?, f: Boolean) {
        if (p == played && t == target && f == focused) return
        played = p.coerceIn(0f, 1f); target = t; focused = f; invalidate()
    }

    override fun onDraw(c: Canvas) {
        val w = width.toFloat(); val y = height - 10 * d
        val th = if (focused) 8 * d else 5 * d
        c.drawRoundRect(RectF(0f, y - th / 2, w, y + th / 2), th, th, track)
        c.drawRoundRect(RectF(0f, y - th / 2, w * played, y + th / 2), th, th, fill)
        val t = target
        if (t != null) {
            val x = (w * t.first).coerceIn(0f, w)
            c.drawRect(x - 2 * d, y - 14 * d, x + 2 * d, y + 6 * d, ghost)
            val tw = label.measureText(t.second) / 2 + 12 * d
            val cx = x.coerceIn(tw, w - tw)
            c.drawRoundRect(RectF(cx - tw, 0f, cx + tw, 26 * d), 8 * d, 8 * d, tag)
            c.drawText(t.second, cx, 19 * d, label)
        } else if (focused) c.drawCircle(w * played, y, 11 * d, knob)
    }
}
