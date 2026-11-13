package app.shippotv.android

import okhttp3.Request
import java.util.concurrent.TimeUnit

/** Pistes d'un fichier MKV, lues dans son début (la liste des pistes y est rangée) sans le télécharger. */
data class MkvTrack(val type: Int, val codec: String, val lang: String, val default: Boolean, val forced: Boolean,
                    val name: String, val bits: Int, val transfer: Int, val dv: Boolean, val channels: Int, val hevcProfile: Int)

data class MkvInfo(val tracks: List<MkvTrack>) {
    val video get() = tracks.firstOrNull { it.type == 1 }
    val audio get() = tracks.filter { it.type == 2 }
    val subs get() = tracks.filter { it.type == 17 }
}

object Probe {
    private const val TRACKS = 0x1654AE6BL; private const val SEGMENT = 0x18538067L; private const val CLUSTER = 0x1F43B675L
    private const val ENTRY = 0xAEL

    /** null : pas un MKV, lecture partielle refusée, délai dépassé ou pistes introuvables. */
    fun mkv(url: String, maxBytes: Int = 1 shl 20): MkvInfo? {
        return try {
            val c = Net.client.newBuilder().callTimeout(4, TimeUnit.SECONDS).build()
            val r = c.newCall(Request.Builder().url(url).header("Range", "bytes=0-${maxBytes - 1}")
                .header("User-Agent", Net.UA).build()).execute()
            r.use {
                if (r.code != 206 && r.code != 200) return null
                val ins = r.body?.byteStream() ?: return null
                val buf = ByteArray(maxBytes)
                var n = 0
                while (n < maxBytes) {
                    val k = ins.read(buf, n, maxBytes - n)
                    if (k <= 0) break
                    n += k
                }
                parse(buf, n)
            }
        } catch (_: Exception) { null }
    }

    private class Rd(val b: ByteArray, var p: Int, val end: Int) {
        fun id(): Long {
            if (p >= end) return -1
            val first = b[p].toInt() and 0xFF
            var len = 1; var mask = 0x80
            while (len <= 4 && first and mask == 0) { len++; mask = mask shr 1 }
            if (len > 4 || p + len > end) return -1
            var v = 0L
            for (i in 0 until len) v = (v shl 8) or (b[p + i].toLong() and 0xFF)
            p += len
            return v
        }
        /** taille ; -2 = inconnue (tous les bits à 1) */
        fun size(): Long {
            if (p >= end) return -1
            val first = b[p].toInt() and 0xFF
            var len = 1; var mask = 0x80
            while (len <= 8 && first and mask == 0) { len++; mask = mask shr 1 }
            if (len > 8 || p + len > end) return -1
            var v = (first and (mask - 1)).toLong()
            var allOnes = v == (mask - 1).toLong()
            for (i in 1 until len) {
                val x = b[p + i].toLong() and 0xFF
                if (x != 0xFFL) allOnes = false
                v = (v shl 8) or x
            }
            p += len
            return if (allOnes) -2 else v
        }
    }

    private fun uint(b: ByteArray, p: Int, n: Int): Long { var v = 0L; for (i in 0 until n) v = (v shl 8) or (b[p + i].toLong() and 0xFF); return v }
    private fun str(b: ByteArray, p: Int, n: Int) = String(b, p, n, Charsets.UTF_8).trimEnd('\u0000')

    fun parse(b: ByteArray, n: Int): MkvInfo? {
        val r = Rd(b, 0, n)
        if (r.id() != 0x1A45DFA3L) return null
        val hs = r.size(); if (hs < 0) return null
        r.p += hs.toInt()
        if (r.id() != SEGMENT) return null
        r.size()
        // enfants du segment, jusqu'aux pistes (avant les premiers « clusters » d'images)
        while (r.p < n) {
            val id = r.id(); val sz = r.size()
            if (id < 0 || sz == -1L) return null
            if (id == TRACKS) {
                val end = if (sz == -2L) n else minOf(n, r.p + sz.toInt())
                return tracks(b, r.p, end)
            }
            if (id == CLUSTER || sz == -2L) return null
            r.p += sz.toInt()
        }
        return null
    }

    private fun tracks(b: ByteArray, start: Int, end: Int): MkvInfo? {
        val r = Rd(b, start, end)
        val out = mutableListOf<MkvTrack>()
        while (r.p < end) {
            val id = r.id(); val sz = r.size()
            if (id < 0 || sz < 0) break
            val e = minOf(end, r.p + sz.toInt())
            if (id == ENTRY) entry(b, r.p, e)?.let { out += it }
            r.p = e
        }
        return if (out.isEmpty()) null else MkvInfo(out)
    }

    private fun entry(b: ByteArray, start: Int, end: Int): MkvTrack? {
        var type = 0; var codec = ""; var lang = "eng"; var bcp = ""; var def = true; var forced = false; var name = ""
        var bits = 8; var transfer = 0; var dv = false; var ch = 0; var hevcProfile = 0
        val r = Rd(b, start, end)
        while (r.p < end) {
            val id = r.id(); val sz = r.size()
            if (id < 0 || sz < 0 || r.p + sz > end) break
            val p = r.p; val s = sz.toInt()
            when (id) {
                0x83L -> type = uint(b, p, s).toInt()
                0x86L -> codec = str(b, p, s)
                0x22B59CL -> lang = str(b, p, s)
                0x22B59DL -> bcp = str(b, p, s)
                0x88L -> def = uint(b, p, s) != 0L
                0x55AAL -> forced = uint(b, p, s) != 0L
                0x536EL -> name = str(b, p, s)
                0x41E4L -> dv = true                                   // BlockAdditionMapping : Dolby Vision
                0x63A2L -> if (s > 1 && codec.contains("HEVC")) hevcProfile = (b[p + 1].toInt() and 0x1F)
                0xE0L -> {                                              // Video
                    val v = Rd(b, p, p + s)
                    while (v.p < p + s) {
                        val vid = v.id(); val vs = v.size(); if (vid < 0 || vs < 0) break
                        if (vid == 0x55B0L) {                           // Colour
                            val cr = Rd(b, v.p, v.p + vs.toInt())
                            while (cr.p < v.p + vs) {
                                val cid = cr.id(); val cs = cr.size(); if (cid < 0 || cs < 0) break
                                if (cid == 0x55B2L) bits = uint(b, cr.p, cs.toInt()).toInt()
                                if (cid == 0x55BAL) transfer = uint(b, cr.p, cs.toInt()).toInt()
                                cr.p += cs.toInt()
                            }
                        }
                        v.p += vs.toInt()
                    }
                }
                0xE1L -> {                                              // Audio
                    val a = Rd(b, p, p + s)
                    while (a.p < p + s) {
                        val aid = a.id(); val asz = a.size(); if (aid < 0 || asz < 0) break
                        if (aid == 0x9FL) ch = uint(b, a.p, asz.toInt()).toInt()
                        a.p += asz.toInt()
                    }
                }
            }
            r.p = p + s
        }
        if (codec.isEmpty()) return null
        if (codec.contains("HEVC") && hevcProfile == 2) bits = maxOf(bits, 10)
        return MkvTrack(type, codec, (bcp.ifEmpty { lang }).lowercase(), def, forced, name, bits, transfer, dv, ch, hevcProfile)
    }
}

/** Choix du lecteur avant la lecture. */
data class Decision(val engine: String, val reason: String)

object Choice {
    fun french(l: String) = l.startsWith("fr")
    fun audioCodec(c: String) = when {
        c.startsWith("A_EAC3") -> "eac3"; c.startsWith("A_AC3") -> "ac3"; c.startsWith("A_DTS") -> "dts"
        c.startsWith("A_TRUEHD") -> "truehd"; c.startsWith("A_AAC") -> "aac"; c.startsWith("A_OPUS") -> "opus"
        c.startsWith("A_FLAC") -> "flac"; c.startsWith("A_MPEG") -> "mp3"; c.startsWith("A_VORBIS") -> "vorbis"
        c.startsWith("A_PCM") -> "pcm"; else -> c
    }
    private fun audioName(c: String) = when (c) { "eac3" -> "Dolby Digital Plus"; "ac3" -> "Dolby Digital"; "dts" -> "DTS"
        "truehd" -> "Dolby TrueHD"; "aac" -> "AAC"; "opus" -> "Opus"; "flac" -> "FLAC"; "mp3" -> "MP3"; else -> c }

    fun decide(info: MkvInfo?, label: String, ext: String, live: Boolean): Decision {
        if (info != null) {
            val reasons = mutableListOf<String>()
            val v = info.video
            var vlc: String? = null
            if (v != null) {
                val c = v.codec
                val ok = when {
                    c.startsWith("V_MPEG4/ISO/AVC") -> Caps.avc
                    c.startsWith("V_MPEGH/ISO/HEVC") -> Caps.hevc && (v.bits < 10 || Caps.hevc10)
                    c.startsWith("V_AV1") -> Caps.av1
                    c.startsWith("V_VP9") -> Caps.vp9
                    c.startsWith("V_MPEG2") -> Caps.mpeg2
                    c.startsWith("V_MPEG4/ISO") -> true
                    else -> false
                }
                val vname = when {
                    c.contains("HEVC") -> "HEVC" + if (v.bits >= 10) " 10 bits" else ""
                    c.contains("AVC") -> "H.264"; c.startsWith("V_AV1") -> "AV1"; c.startsWith("V_VP9") -> "VP9"
                    c.startsWith("V_MPEG2") -> "MPEG-2"; else -> c.substringAfter("V_")
                } + when { v.dv -> " Dolby Vision"; v.transfer == 16 -> " HDR10"; v.transfer == 18 -> " HLG"; else -> "" }
                reasons += "image $vname"
                if (!ok) vlc = "image $vname non décodée par la box"
            }
            // piste audio qui sera jouée : française si possible
            val audio = info.audio.firstOrNull { french(it.lang) } ?: info.audio.firstOrNull { it.default } ?: info.audio.firstOrNull()
            if (audio != null) {
                val ac = audioCodec(audio.codec)
                val pass = when (ac) { "ac3" -> Caps.passAc3; "eac3" -> Caps.passEac3; "dts" -> Caps.passDts; "truehd" -> Caps.passTruehd; else -> false }
                reasons += "son ${audioName(ac)}" + (if (pass) " (envoyé à l'ampli/TV)" else "")
                if (vlc == null && !Caps.audioOk(ac)) vlc = "son ${audioName(ac)} non pris en charge par la box"
            }
            // sous-titres français utiles (piste audio non française) : VLC seulement s'ils sont en VobSub
            if (vlc == null && audio != null && !french(audio.lang)) {
                val fr = info.subs.filter { french(it.lang) }
                if (fr.isNotEmpty() && fr.all { it.codec.startsWith("S_VOBSUB") }) vlc = "sous-titres français en image DVD (VobSub)"
                if (fr.isNotEmpty()) reasons += "sous-titres FR"
            }
            return if (vlc != null) Decision("vlc", vlc) else Decision("media3", reasons.joinToString(", "))
        }
        // pas de liste des pistes : nom de la source et extension
        val l = "$label $ext".uppercase()
        if (Regex("\\bDTS\\b").containsMatchIn(l) && !Caps.audioOk("dts")) return Decision("vlc", "son DTS annoncé, non pris en charge par la box")
        if (Regex("TRUEHD").containsMatchIn(l) && !Caps.audioOk("truehd")) return Decision("vlc", "son TrueHD annoncé")
        if (Regex("\\bAV1\\b").containsMatchIn(l) && !Caps.av1) return Decision("vlc", "image AV1 annoncée")
        if (Regex("4K|UHD|2160|HEVC|H\\.?265|X265").containsMatchIn(l) && !Caps.hevc) return Decision("vlc", "4K/HEVC non décodé par la box")
        if (Regex("\\b(WMV|ASF|RMVB?|DIVX)\\b").containsMatchIn(l)) return Decision("vlc", "format ancien")
        return Decision("media3", if (live) "direct" else "d'après le nom de la source")
    }
}
