package app.shippotv.android

import android.content.Context
import android.net.Uri
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackGroup
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import org.videolan.libvlc.LibVLC
import org.videolan.libvlc.Media
import org.videolan.libvlc.MediaPlayer
import org.videolan.libvlc.util.VLCVideoLayout
import java.util.Locale

/** Une piste (langue, sous-titres) proposée dans les options du lecteur. */
data class Tr(val label: String, val lang: String, val selected: Boolean, val ref: Any)

interface EngineCb {
    fun onReady()
    fun onFirstFrame()
    fun onBuffering(on: Boolean)
    fun onError(msg: String)
    fun onEnded()
}

/** Les deux lecteurs vus de la même façon par l'écran de lecture. */
interface VEngine {
    val name: String
    fun start(url: String, startMs: Long)
    fun play()
    fun pause()
    val playing: Boolean
    fun seekTo(ms: Long)
    val pos: Long
    val dur: Long
    val hasVideo: Boolean
    fun audio(): List<Tr>
    fun text(): List<Tr>
    fun selectAudio(t: Tr)
    fun selectText(t: Tr?)
    fun release()
}

fun langName(code: String?): String {
    if (code.isNullOrBlank() || code == "und") return ""
    val l = Locale.forLanguageTag(code)
    val n = l.getDisplayLanguage(Locale.FRENCH)
    return if (n.isBlank() || n.equals(code, true)) code.uppercase() else n.replaceFirstChar { it.uppercase() }
}

private fun isFrench(s: String?) = s != null && (s.startsWith("fr", true) || s.contains("fran", true) || s.contains("french", true))

/* ------------------------------------------------------------------ lecteur Android (Media3 / ExoPlayer) */

@UnstableApi
class Media3Engine(ctx: Context, private val box: FrameLayout, private val cb: EngineCb) : VEngine {
    override val name = "Android"
    private val view = PlayerView(ctx)
    private val player: ExoPlayer
    private var subsDecided = false

    init {
        val http = DefaultHttpDataSource.Factory().setUserAgent(Net.UA).setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(15000).setReadTimeoutMs(30000)
        val rf = DefaultRenderersFactory(ctx).setEnableDecoderFallback(true)
        player = ExoPlayer.Builder(ctx, rf)
            .setMediaSourceFactory(DefaultMediaSourceFactory(DefaultDataSource.Factory(ctx, http)))
            .setLoadControl(DefaultLoadControl.Builder().setBufferDurationsMs(15000, 60000, 2500, 5000).build())
            .build()
        // son : passe directement à l'ampli/TV quand ils savent le décoder (Dolby, DTS)
        player.setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), true)
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
            .setPreferredAudioLanguages("fr", "fre", "fra")
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
            .build()
        view.useController = false
        view.setShowBuffering(PlayerView.SHOW_BUFFERING_NEVER)
        view.resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
        view.setKeepContentOnPlayerReset(false)
        view.player = player
        box.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                when (state) {
                    Player.STATE_READY -> { cb.onBuffering(false); cb.onReady() }
                    Player.STATE_BUFFERING -> cb.onBuffering(true)
                    Player.STATE_ENDED -> cb.onEnded()
                }
            }
            override fun onPlayerError(error: PlaybackException) { cb.onError("${error.errorCodeName} ${error.message ?: ""}".trim()) }
            override fun onRenderedFirstFrame() { cb.onFirstFrame() }
            override fun onTracksChanged(tracks: Tracks) { if (!subsDecided && !tracks.isEmpty) { subsDecided = true; autoSubs() } }
        })
    }

    /** Sous-titres français affichés d'office quand la piste audio n'est pas en français. */
    private fun autoSubs() {
        val a = audio().firstOrNull { it.selected } ?: return
        if (isFrench(a.lang)) return
        text().firstOrNull { isFrench(it.lang) }?.let { selectText(it) }
    }

    override fun start(url: String, startMs: Long) {
        val b = MediaItem.Builder().setUri(url)
        if (url.contains(".m3u8", true)) b.setMimeType(MimeTypes.APPLICATION_M3U8)
        player.setMediaItem(b.build(), startMs)
        player.prepare()
        player.playWhenReady = true
    }
    override fun play() { player.play() }
    override fun pause() { player.pause() }
    override val playing get() = player.isPlaying
    override fun seekTo(ms: Long) { player.seekTo(ms.coerceAtLeast(0)) }
    override val pos get() = player.currentPosition
    override val dur get() = player.duration.let { if (it == C.TIME_UNSET) -1L else it }
    override val hasVideo get() = player.currentTracks.containsType(C.TRACK_TYPE_VIDEO)

    private fun label(f: Format, type: Int): String {
        val parts = mutableListOf<String>()
        langName(f.language).takeIf { it.isNotEmpty() }?.let { parts += it }
        f.label?.takeIf { it.isNotBlank() }?.let { parts += it }
        if (type == C.TRACK_TYPE_AUDIO) {
            when (f.sampleMimeType) {
                MimeTypes.AUDIO_E_AC3, MimeTypes.AUDIO_E_AC3_JOC -> parts += "Dolby Digital Plus"
                MimeTypes.AUDIO_AC3 -> parts += "Dolby Digital"
                MimeTypes.AUDIO_DTS, MimeTypes.AUDIO_DTS_HD -> parts += "DTS"
                MimeTypes.AUDIO_TRUEHD -> parts += "TrueHD"
            }
            if (f.channelCount > 2) parts += if (f.channelCount == 6) "5.1" else if (f.channelCount == 8) "7.1" else "${f.channelCount} canaux"
        }
        if (f.selectionFlags and C.SELECTION_FLAG_FORCED != 0) parts += "forcés"
        return parts.joinToString(" · ").ifEmpty { "Piste" }
    }

    private fun tracks(type: Int): List<Tr> = player.currentTracks.groups.filter { it.type == type }.flatMap { g ->
        (0 until g.length).filter { g.isTrackSupported(it) }.map { i ->
            val f = g.getTrackFormat(i)
            Tr(label(f, type), f.language ?: "", g.isTrackSelected(i), Pair(g.mediaTrackGroup, i))
        }
    }
    override fun audio() = tracks(C.TRACK_TYPE_AUDIO)
    override fun text() = tracks(C.TRACK_TYPE_TEXT)

    @Suppress("UNCHECKED_CAST")
    override fun selectAudio(t: Tr) {
        val (g, i) = t.ref as Pair<TrackGroup, Int>
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
            .setOverrideForType(TrackSelectionOverride(g, i)).build()
    }

    @Suppress("UNCHECKED_CAST")
    override fun selectText(t: Tr?) {
        val b = player.trackSelectionParameters.buildUpon()
        if (t == null) b.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
        else {
            val (g, i) = t.ref as Pair<TrackGroup, Int>
            b.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false).setOverrideForType(TrackSelectionOverride(g, i))
        }
        player.trackSelectionParameters = b.build()
    }

    override fun release() {
        try { player.release() } catch (_: Exception) { }
        box.removeView(view)
    }
}

/* ------------------------------------------------------------------ VLC */

class VlcEngine(ctx: Context, private val box: FrameLayout, private val cb: EngineCb) : VEngine {
    override val name = "VLC"
    companion object {
        private var lib: LibVLC? = null
        fun lib(ctx: Context): LibVLC = lib ?: LibVLC(ctx.applicationContext, arrayListOf(
            "--http-reconnect", "--audio-time-stretch", "--avcodec-skiploopfilter=1", "--no-stats")).also { lib = it }
    }
    private val libvlc = lib(ctx)
    private val layout = VLCVideoLayout(ctx)
    private val mp = MediaPlayer(libvlc)
    private var started = false
    private var vout = false
    private var subsDecided = false

    init {
        box.addView(layout, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        mp.attachViews(layout, null, true, false)
        mp.setEventListener { e ->
            when (e.type) {
                MediaPlayer.Event.Playing -> { cb.onBuffering(false); if (!started) { started = true; cb.onReady() } }
                MediaPlayer.Event.Buffering -> cb.onBuffering(e.buffering < 100f)
                MediaPlayer.Event.Vout -> if (e.voutCount > 0 && !vout) { vout = true; cb.onFirstFrame() }
                MediaPlayer.Event.EndReached -> cb.onEnded()
                MediaPlayer.Event.EncounteredError -> cb.onError("VLC n'a pas pu lire ce flux")
                MediaPlayer.Event.ESAdded -> if (!subsDecided && (mp.audioTracksCount > 0)) { subsDecided = true; autoSubs() }
            }
        }
    }

    private fun autoSubs() {
        val a = audio().firstOrNull { it.selected } ?: return
        if (isFrench(a.label)) return
        text().firstOrNull { isFrench(it.label) }?.let { selectText(it) }
    }

    override fun start(url: String, startMs: Long) {
        val m = Media(libvlc, Uri.parse(url))
        m.setHWDecoderEnabled(true, false)
        m.addOption(":network-caching=3000")
        m.addOption(":http-user-agent=${Net.UA}")
        m.addOption(":audio-language=fre,fra,fr")
        if (startMs > 0) m.addOption(":start-time=${startMs / 1000.0}")
        mp.media = m
        m.release()
        mp.play()
    }
    override fun play() { mp.play() }
    override fun pause() { mp.pause() }
    override val playing get() = mp.isPlaying
    override fun seekTo(ms: Long) { mp.setTime(ms.coerceAtLeast(0)) }
    override val pos get() = mp.time
    override val dur get() = mp.length.let { if (it <= 0) -1L else it }
    override val hasVideo get() = vout || (mp.videoTracksCount > 0)

    override fun audio(): List<Tr> = (mp.audioTracks ?: emptyArray()).filter { it.id >= 0 }
        .map { Tr(it.name ?: "Piste", it.name ?: "", it.id == mp.audioTrack, it.id) }
    override fun text(): List<Tr> = (mp.spuTracks ?: emptyArray()).filter { it.id >= 0 }
        .map { Tr(it.name ?: "Sous-titres", it.name ?: "", it.id == mp.spuTrack, it.id) }
    override fun selectAudio(t: Tr) { mp.setAudioTrack(t.ref as Int) }
    override fun selectText(t: Tr?) { mp.setSpuTrack((t?.ref as? Int) ?: -1) }

    override fun release() {
        try { mp.stop(); mp.detachViews(); mp.release() } catch (_: Exception) { }
        box.removeView(layout)
    }
}
