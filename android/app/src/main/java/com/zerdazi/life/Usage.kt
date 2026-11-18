package com.zerdazi.life

import android.content.Intent
import android.os.SystemClock
import android.view.inputmethod.InputMethodManager
import com.zerdazi.life.server.DAY_START
import com.zerdazi.life.server.Db
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.format.DateTimeFormatter

// Screen time per app and site, plus an activity log (blocks hit, break
// prompts, settings attempts, limit reached).
//
// Days are "life days": they start at DAY_START (05:00) local time, so the
// limit resets at 05:00 in both BST and GMT.
object Usage {
    private val RESET: LocalTime = LocalTime.parse(DAY_START)

    fun lifeDay(now: LocalDateTime = LocalDateTime.now()): String =
        (if (now.toLocalTime() < RESET) now.toLocalDate().minusDays(1) else now.toLocalDate()).toString()

    fun nextReset(now: LocalDateTime = LocalDateTime.now()): LocalDateTime =
        LocalDate.parse(lifeDay(now)).plusDays(1).atTime(RESET)

    fun add(key: String, seconds: Long, day: String = lifeDay()) {
        if (seconds <= 0) return
        Db.exec(
            "INSERT INTO usage (day, key, seconds) VALUES (?, ?, ?) ON CONFLICT(day, key) DO UPDATE SET seconds = seconds + excluded.seconds",
            day, key, seconds,
        )
        countedAt = 0
    }

    fun rows(day: String): List<Pair<String, Long>> =
        Db.all("SELECT key, seconds FROM usage WHERE day = ? ORDER BY seconds DESC", day)
            .map { it["key"] as String to it["seconds"] as Long }

    // --- what counts ---

    private val homeApps: Set<String> by lazy {
        LifeApp.ctx.packageManager.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME), 0)
            .map { it.activityInfo.packageName }.toSet()
    }

    private val keyboards: Set<String> by lazy {
        LifeApp.ctx.getSystemService(InputMethodManager::class.java).enabledInputMethodList.map { it.packageName }.toSet()
    }

    // Windows that aren't really "the app you're in" (keyboard, notification shade).
    fun ignored(pkg: String) = pkg == "com.android.systemui" || pkg in keyboards

    fun isHome(pkg: String) = pkg in homeApps

    fun isExempt(pkg: String): Boolean =
        pkg == LifeApp.ctx.packageName || pkg in homeApps || pkg in Config.SCREEN_TIME_EXEMPT || ignored(pkg)

    @Volatile private var countedAt = 0L
    @Volatile private var countedDay = ""
    @Volatile private var countedValue = 0L

    // Seconds of screen time that count towards the limit today (cached briefly:
    // it's read on every app switch).
    fun countedSeconds(day: String = lifeDay()): Long {
        val now = SystemClock.elapsedRealtime()
        if (day == countedDay && countedAt != 0L && now - countedAt < 10_000) return countedValue
        val v = rows(day).filter { (k, _) -> k.startsWith("app:") && !isExempt(k.removePrefix("app:")) }.sumOf { it.second }
        countedDay = day; countedValue = v; countedAt = now
        return v
    }

    fun overLimit() = countedSeconds() >= Config.SCREEN_TIME_LIMIT_MIN * 60L

    // --- activity log ---

    fun log(kind: String, target: String?, detail: String? = null) {
        val now = LocalDateTime.now()
        Db.exec(
            "INSERT INTO events (at, day, kind, target, detail) VALUES (?, ?, ?, ?, ?)",
            now.format(DateTimeFormatter.ofPattern("HH:mm")), lifeDay(now), kind, target, detail,
        )
    }

    fun label(pkg: String): String = try {
        val pm = LifeApp.ctx.packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
    } catch (_: Exception) {
        pkg
    }

    fun labelOf(key: String) = if (key.startsWith("app:")) label(key.removePrefix("app:")) else key.removePrefix("site:")

    // For GET /api/usage.
    fun summary(day: String = lifeDay()): JSONObject {
        val rows = rows(day)
        fun item(k: String, s: Long) = JSONObject()
            .put("key", k).put("label", labelOf(k)).put("minutes", Math.round(s / 60.0))
            .put("blockedTomorrow", com.zerdazi.life.server.Blocks.blockedTomorrow(k))
        val apps = rows.filter { (k, s) -> k.startsWith("app:") && !isExempt(k.removePrefix("app:")) && s >= 60 }
        val sites = rows.filter { (k, s) -> k.startsWith("site:") && s >= 60 }
        return JSONObject()
            .put("day", day)
            .put("minutes", Math.round(countedSeconds(day) / 60.0))
            .put("limitMinutes", Config.SCREEN_TIME_LIMIT_MIN)
            .put("apps", JSONArray(apps.take(8).map { (k, s) -> item(k, s) }))
            .put("sites", JSONArray(sites.take(8).map { (k, s) -> item(k, s) }))
            .put("blocked", count(day, "blocked"))
            .put("breaks", count(day, "break"))
    }

    private fun count(day: String, kind: String) =
        Db.one("SELECT COUNT(*) AS n FROM events WHERE day = ? AND kind = ?", day, kind)!!["n"] as Long
}
