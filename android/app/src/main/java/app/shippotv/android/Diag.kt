package app.shippotv.android

import android.util.Log
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Les derniers choix et erreurs du lecteur, consultables dans Réglages › Boîtier et lecteur. */
object Diag {
    private val lines = ArrayDeque<String>()
    private val fmt = SimpleDateFormat("HH:mm:ss", Locale.FRANCE)
    @Synchronized fun log(msg: String, warn: Boolean = false) {
        if (warn) Log.w("ShippoTV", msg) else Log.i("ShippoTV", msg)
        lines.addLast(fmt.format(Date()) + "  " + msg.removePrefix("[lecteur] "))
        while (lines.size > 40) lines.removeFirst()
    }
    @Synchronized fun recent(): List<String> = lines.toList()
}
