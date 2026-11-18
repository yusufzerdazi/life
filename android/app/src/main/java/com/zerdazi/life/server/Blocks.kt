package com.zerdazi.life.server

import android.content.Context
import android.content.Intent
import com.zerdazi.life.Block
import com.zerdazi.life.Categories
import com.zerdazi.life.Config
import com.zerdazi.life.Schedule
import com.zerdazi.life.Window
import org.json.JSONArray
import org.json.JSONObject
import java.time.DayOfWeek
import java.time.LocalDateTime

// Timed app/site blocks: the hardcoded ones in Config.BLOCKS, the ones added
// in the app (the `blocks` table), and one-off "tomorrow" blocks from the
// bedtime review (rows with until_at). A block can't be removed while it's on.
// Category blocks (Config.CATEGORY_BLOCKS) are listed here too, but Policy
// applies them.
object Blocks {
    // Built-ins get negative ids so they can't collide with table rows.
    class Entry(val id: Long, val block: Block, val builtIn: Boolean)

    @Volatile private var cache: List<Entry>? = null

    // Read on every accessibility event, so cached; any write invalidates it.
    fun all(): List<Entry> = cache ?: load().also { cache = it }

    private fun load(): List<Entry> {
        val builtIn = Config.BLOCKS.mapIndexed { i, b -> Entry(-(i + 1L), b, true) }
        val now = LocalDateTime.now()
        // Finished one-off blocks are done with.
        Db.exec("DELETE FROM blocks WHERE until_at IS NOT NULL AND until_at <= ?", now.toString())
        val stored = Db.all("SELECT * FROM blocks ORDER BY id").map { r ->
            val days = (r["days"] as String).mapNotNull { it.digitToIntOrNull() }.map { DayOfWeek.of(it) }.toSet()
            Entry(
                r["id"] as Long,
                Block(
                    name = r["name"] as String,
                    apps = strings(r["apps"]).toSet(),
                    sites = strings(r["sites"]).toSet(),
                    windows = listOf(Window(days, r["start_time"] as String, r["end_time"] as String)),
                    until = (r["until_at"] as String?)?.let(LocalDateTime::parse),
                ),
                false,
            )
        }
        return builtIn + stored
    }

    private fun strings(json: Any?): List<String> {
        val a = JSONArray(json as String? ?: "[]")
        return (0 until a.length()).map { a.getString(it) }
    }

    fun list(ctx: Context): JSONObject {
        val now = LocalDateTime.now()
        val out = JSONArray()
        for (e in all()) for (w in e.block.windows) {
            if (e.block.until?.let { !now.isBefore(it) } == true) continue // finished one-off
            out.put(
                JSONObject()
                    .put("id", e.id)
                    .put("name", e.block.name)
                    .put("apps", JSONArray(e.block.apps.map { JSONObject().put("pkg", it).put("label", appLabel(ctx, it)) }))
                    .put("sites", JSONArray(e.block.sites.toList()))
                    .put("days", JSONArray(w.days.map { it.value }.sorted()))
                    .put("start", w.start.toString())
                    .put("end", w.end.toString())
                    .put("builtIn", e.builtIn)
                    .put("always", w.isAlways && e.block.until == null)
                    .put("oneOff", e.block.until != null)
                    .putN("activeUntil", Schedule.activeUntil(e.block, now)?.toString())
            )
        }
        var i = 0
        for ((category, block) in Config.CATEGORY_BLOCKS) for (w in block.windows) {
            out.put(
                JSONObject()
                    .put("id", -1000L - i++)
                    .put("name", block.name)
                    .put("apps", JSONArray())
                    .put("sites", JSONArray())
                    .put("note", Categories.describe(category))
                    .put("days", JSONArray(w.days.map { it.value }.sorted()))
                    .put("start", w.start.toString())
                    .put("end", w.end.toString())
                    .put("builtIn", true)
                    .put("always", w.isAlways)
                    .putN("activeUntil", Schedule.activeUntil(block, now)?.toString())
            )
        }
        return JSONObject().put("blocks", out)
    }

    fun add(b: JSONObject): Res {
        val name = b.value("name")?.toString()?.trim().orEmpty().ifEmpty { "Block" }
        val apps = b.optJSONArray("apps")?.let { a -> (0 until a.length()).map { a.getString(it) } }.orEmpty()
        val sites = b.optJSONArray("sites")?.let { a -> (0 until a.length()).mapNotNull { Schedule.hostOf(a.getString(it)) } }.orEmpty()
        val days = b.optJSONArray("days")?.let { a -> (0 until a.length()).map { a.getInt(it) } }.orEmpty().filter { it in 1..7 }.distinct().sorted()
        val start = b.value("start")?.toString()
        val end = b.value("end")?.toString()
        if (apps.isEmpty() && sites.isEmpty()) throw ApiError(400, "Pick at least one app or website")
        if (days.isEmpty()) throw ApiError(400, "Pick at least one day")
        if (!Dates.isValidTime(start) || !Dates.isValidTime(end)) throw ApiError(400, "Times must be HH:MM")
        val id = Db.insert(
            "INSERT INTO blocks (name, apps, sites, days, start_time, end_time) VALUES (?, ?, ?, ?, ?, ?)",
            name, JSONArray(apps).toString(), JSONArray(sites.distinct()).toString(), days.joinToString(""), start, end,
        )
        cache = null
        return Res(201, JSONObject().put("id", id).toString())
    }

    // Blocks one app (app:<package>) or site (site:<domain>) from now until
    // the end of tomorrow (05:00 the day after). From the bedtime review.
    fun tomorrow(b: JSONObject): Res {
        val key = b.value("key")?.toString().orEmpty()
        val target = key.substringAfter(':')
        val isApp = key.startsWith("app:")
        if (target.isEmpty() || (!isApp && !key.startsWith("site:"))) throw ApiError(400, "key must be app:<package> or site:<domain>")
        if (blockedTomorrow(key)) return Res(200, JSONObject().put("ok", true).toString())
        val until = com.zerdazi.life.Usage.nextReset().plusDays(1)
        val name = b.value("label")?.toString()?.takeIf { it.isNotBlank() } ?: target
        Db.insert(
            "INSERT INTO blocks (name, apps, sites, days, start_time, end_time, until_at) VALUES (?, ?, ?, '', '00:00', '00:00', ?)",
            name,
            JSONArray(if (isApp) listOf(target) else emptyList()).toString(),
            JSONArray(if (isApp) emptyList() else listOf(target)).toString(),
            until.withNano(0).toString(),
        )
        cache = null
        return Res(201, JSONObject().put("ok", true).put("until", until.toString()).toString())
    }

    // Whether a one-off block already covers `key` through tomorrow.
    fun blockedTomorrow(key: String): Boolean {
        val target = key.substringAfter(':')
        val end = com.zerdazi.life.Usage.nextReset().plusDays(1)
        return all().any { e ->
            val u = e.block.until ?: return@any false
            !u.isBefore(end) && (if (key.startsWith("app:")) target in e.block.apps else Schedule.matches(target, e.block.sites))
        }
    }

    fun delete(id: Long): Res {
        val e = all().find { it.id == id } ?: throw ApiError(404, "Block not found")
        if (e.builtIn) throw ApiError(403, "Built-in blocks can only be changed in the app's code")
        Schedule.activeUntil(e.block, LocalDateTime.now())?.let {
            throw ApiError(409, "“${e.block.name}” is on until ${it.toLocalTime()} — you can remove it after that")
        }
        Db.exec("DELETE FROM blocks WHERE id = ?", id)
        cache = null
        return Res(204, null)
    }

    // Launchable apps, for the picker.
    fun installedApps(ctx: Context): JSONObject {
        val pm = ctx.packageManager
        val apps = pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
            .map { it.activityInfo.packageName to it.loadLabel(pm).toString() }
            .filter { it.first != ctx.packageName }
            .distinctBy { it.first }
            .sortedBy { it.second.lowercase() }
        return JSONObject().put("apps", JSONArray(apps.map { (pkg, label) -> JSONObject().put("pkg", pkg).put("label", label) }))
    }

    fun appLabel(ctx: Context, pkg: String): String = try {
        val pm = ctx.packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
    } catch (_: Exception) {
        pkg
    }
}
