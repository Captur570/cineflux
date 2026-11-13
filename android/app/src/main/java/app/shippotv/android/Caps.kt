package app.shippotv.android

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.os.Build

/** Ce que la box sait faire elle-même : décodeurs vidéo et son, et formats acceptés par la prise HDMI
 *  (TV ou ampli). Lu une fois au démarrage. */
object Caps {
    var avc = true; var hevc = false; var hevc10 = false; var av1 = false; var vp9 = false
    var mpeg2 = false; var dv = false; var vc1 = false
    var ac3 = false; var eac3 = false; var dts = false; var truehd = false
    var passAc3 = false; var passEac3 = false; var passDts = false; var passTruehd = false
    private var done = false

    fun init(ctx: Context) {
        if (done) return
        done = true
        try {
            for (ci in MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos) {
                if (ci.isEncoder) continue
                for (t in ci.supportedTypes) {
                    when (t.lowercase()) {
                        "video/avc" -> avc = true
                        "video/hevc" -> {
                            hevc = true
                            try {
                                if (ci.getCapabilitiesForType(t).profileLevels.any {
                                        it.profile == MediaCodecInfo.CodecProfileLevel.HEVCProfileMain10 ||
                                        it.profile == MediaCodecInfo.CodecProfileLevel.HEVCProfileMain10HDR10 }) hevc10 = true
                            } catch (_: Exception) { }
                        }
                        "video/av01" -> av1 = true
                        "video/x-vnd.on2.vp9" -> vp9 = true
                        "video/mpeg2" -> mpeg2 = true
                        "video/dolby-vision" -> dv = true
                        "video/wvc1", "video/vc1" -> vc1 = true
                        "audio/ac3" -> ac3 = true
                        "audio/eac3" -> eac3 = true
                        "audio/vnd.dts", "audio/vnd.dts.hd" -> dts = true
                        "audio/true-hd" -> truehd = true
                    }
                }
            }
        } catch (_: Exception) { }
        try {
            val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            for (d in am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
                if (d.type != AudioDeviceInfo.TYPE_HDMI && d.type != AudioDeviceInfo.TYPE_HDMI_ARC &&
                    !(Build.VERSION.SDK_INT >= 31 && d.type == AudioDeviceInfo.TYPE_HDMI_EARC)) continue
                for (e in d.encodings) when (e) {
                    AudioFormat.ENCODING_AC3 -> passAc3 = true
                    AudioFormat.ENCODING_E_AC3 -> passEac3 = true
                    AudioFormat.ENCODING_DTS, AudioFormat.ENCODING_DTS_HD -> passDts = true
                    AudioFormat.ENCODING_DOLBY_TRUEHD -> passTruehd = true
                }
            }
        } catch (_: Exception) { }
    }

    fun audioOk(codec: String): Boolean = when (codec) {
        "ac3" -> ac3 || passAc3
        "eac3" -> eac3 || passEac3 || ac3 || passAc3     // E-AC3 garde un cœur AC3 sur la plupart des flux
        "dts" -> dts || passDts
        "truehd" -> truehd || passTruehd
        else -> true
    }

    fun summary(): String {
        val v = listOfNotNull("H.264", if (hevc) "HEVC" + (if (hevc10) " 10 bits" else "") else null,
            if (av1) "AV1" else null, if (vp9) "VP9" else null, if (dv) "Dolby Vision" else null, if (mpeg2) "MPEG-2" else null)
        val a = listOfNotNull(if (ac3) "AC3" else null, if (eac3) "E-AC3" else null, if (dts) "DTS" else null, if (truehd) "TrueHD" else null)
        val p = listOfNotNull(if (passAc3) "AC3" else null, if (passEac3) "E-AC3" else null, if (passDts) "DTS" else null, if (passTruehd) "TrueHD" else null)
        return "image : ${v.joinToString(", ")} · son décodé : ${a.joinToString(", ").ifEmpty { "—" }} · son vers l'ampli/TV : ${p.joinToString(", ").ifEmpty { "—" }}"
    }
}
