package app.shippotv.android

import android.app.Activity
import android.app.AlertDialog
import android.app.ProgressDialog
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.core.content.FileProvider
import okhttp3.Request
import org.json.JSONObject
import java.io.File

/** Mises à jour : la dernière version publiée par GitHub (release « android-beta ») est proposée au démarrage,
 *  téléchargée et installée sans clé USB ni Downloader. */
object Updater {
    private const val RELEASE = "https://github.com/Captur570/cineflux/releases/download/android-beta/"
    private val h = Handler(Looper.getMainLooper())

    fun later(act: Activity) { h.postDelayed({ check(act) }, 8000) }

    private fun check(act: Activity) {
        Net.pool.execute {
            try {
                val txt = Net.client.newCall(Request.Builder().url(RELEASE + "android-version.json").header("User-Agent", "ShippoTV").build())
                    .execute().use { if (it.isSuccessful) it.body?.string() else null } ?: return@execute
                val j = JSONObject(txt)
                val code = j.optInt("code")
                if (code <= BuildConfig.VERSION_CODE) return@execute
                h.post { ask(act, j.optString("name"), j.optString("apk", "ShippoTV-Android.apk"), j.optString("notes")) }
            } catch (_: Exception) { }
        }
    }

    private fun ask(act: Activity, name: String, apk: String, notes: String) {
        if (act.isFinishing) return
        AlertDialog.Builder(act, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle("Nouvelle version de ShippoTV")
            .setMessage("Version $name disponible (vous avez ${BuildConfig.VERSION_NAME}).${if (notes.isNotBlank()) "\n\n$notes" else ""}\n\nVos réglages sont conservés.")
            .setPositiveButton("Installer") { _, _ -> download(act, RELEASE + apk) }
            .setNegativeButton("Plus tard", null)
            .show()
    }

    @Suppress("DEPRECATION")
    private fun download(act: Activity, url: String) {
        val pd = ProgressDialog(act).apply { setMessage("Téléchargement de la mise à jour…"); setProgressStyle(ProgressDialog.STYLE_HORIZONTAL); max = 100; setCancelable(false); show() }
        Net.pool.execute {
            val dir = File(act.cacheDir, "maj").apply { mkdirs() }
            val f = File(dir, "ShippoTV.apk")
            try {
                Net.client.newCall(Request.Builder().url(url).build()).execute().use { r ->
                    if (!r.isSuccessful) throw Exception("HTTP ${r.code}")
                    val total = r.body!!.contentLength()
                    r.body!!.byteStream().use { ins -> f.outputStream().use { out ->
                        val buf = ByteArray(64 * 1024); var n = 0L
                        while (true) {
                            val k = ins.read(buf); if (k < 0) break
                            out.write(buf, 0, k); n += k
                            if (total > 0) h.post { pd.progress = (n * 100 / total).toInt() }
                        }
                    } }
                }
                h.post { pd.dismiss(); install(act, f) }
            } catch (e: Exception) {
                h.post { pd.dismiss(); AlertDialog.Builder(act).setMessage("Téléchargement impossible (${e.message}). Réessayez au prochain démarrage.").setPositiveButton("OK", null).show() }
            }
        }
    }

    private fun install(act: Activity, f: File) {
        if (Build.VERSION.SDK_INT >= 26 && !act.packageManager.canRequestPackageInstalls()) {
            AlertDialog.Builder(act, android.R.style.Theme_DeviceDefault_Dialog_Alert)
                .setTitle("Une autorisation, une seule fois")
                .setMessage("Android demande d'autoriser ShippoTV à installer ses mises à jour. Activez ShippoTV sur l'écran suivant, puis revenez : l'installation reprendra.")
                .setPositiveButton("Continuer") { _, _ ->
                    act.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + act.packageName)))
                    h.postDelayed({ waitPermission(act, f, 0) }, 2000)
                }.setNegativeButton("Plus tard", null).show()
            return
        }
        val uri = FileProvider.getUriForFile(act, "app.shippotv.android.files", f)
        act.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    private fun waitPermission(act: Activity, f: File, n: Int) {
        if (Build.VERSION.SDK_INT >= 26 && act.packageManager.canRequestPackageInstalls()) { install(act, f); return }
        if (n < 90) h.postDelayed({ waitPermission(act, f, n + 1) }, 2000)
    }
}
