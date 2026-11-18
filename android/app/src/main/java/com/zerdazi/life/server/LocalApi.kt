package com.zerdazi.life.server

import android.content.Context
import android.net.Uri
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.concurrent.Executors

class Res(val status: Int, val body: String?)

// The server's /api routes (server/src/routes/*), answered on-device. The web
// UI reaches this through the WebView bridge; native code calls it directly.
// No API key: nothing outside the app can reach it.
object LocalApi {
    private const val TAG = "LifeApi"
    private val pool = Executors.newCachedThreadPool()
    private val KINDS = listOf("check", "sleep", "exercise", "avoid")
    private lateinit var ctx: Context

    fun init(context: Context) {
        ctx = context.applicationContext
    }

    fun async(method: String, path: String, body: String? = null, done: (Res) -> Unit = {}) =
        pool.execute { done(handle(method, path, body)) }

    fun handle(method: String, path: String, body: String?): Res = try {
        val uri = Uri.parse("http://local$path")
        val parts = uri.pathSegments.drop(1) // drop "api"
        val q = { k: String -> uri.getQueryParameter(k) }
        val b = if (body.isNullOrBlank()) JSONObject() else JSONObject(body)
        route(method, parts, q, b)
    } catch (e: ApiError) {
        err(e.status, e.message ?: "error")
    } catch (e: Exception) {
        Log.e(TAG, "$method $path", e)
        err(500, "Internal error: ${e.message}")
    }

    private fun ok(o: Any, status: Int = 200) = Res(status, o.toString())
    private fun err(status: Int, msg: String) = Res(status, JSONObject().put("error", msg).toString())

    private fun route(m: String, p: List<String>, q: (String) -> String?, b: JSONObject): Res = when {
        m == "GET" && p == listOf("health") -> ok(JSONObject().put("ok", true))

        m == "GET" && p == listOf("goals") -> ok(JSONArray(goals().map(::rowToJson)))
        m == "POST" && p == listOf("goals") -> addGoal(b)
        m == "PATCH" && p.size == 2 && p[0] == "goals" -> updateGoal(p[1], b)
        m == "DELETE" && p.size == 2 && p[0] == "goals" ->
            if (Db.changes("DELETE FROM goals WHERE id = ?", p[1]) == 0) err(404, "Goal not found") else Res(204, null)

        m == "GET" && p == listOf("day") -> getDay(q("date"))
        m == "PUT" && p == listOf("day") -> putDay(b)
        m == "POST" && p == listOf("report") -> report(b)
        m == "GET" && p == listOf("history") -> history(q("days"))

        m == "POST" && p == listOf("presence", "start") -> Presence.start()
        m == "POST" && p == listOf("presence", "bed") -> Presence.bed(b)
        m == "POST" && p == listOf("presence", "end") -> Presence.end()
        m == "GET" && p == listOf("presence") -> Presence.get(q("date"))

        m == "GET" && p == listOf("integrations", "status") -> ok(
            JSONObject().put("google", GoogleHealth.status()).put("wakingup", WakingUp.status())
        )
        m == "POST" && p == listOf("integrations", "google", "sync") -> syncResult(GoogleHealth.sync())
        m == "POST" && p == listOf("integrations", "wakingup", "sync") -> syncResult(WakingUp.sync())
        // Opens Google's sign-in in the browser; poll integrations/status for the result.
        m == "POST" && p == listOf("integrations", "google", "login") -> ok(GoogleHealth.startLogin(ctx))
        m == "GET" && p == listOf("lights") -> ok(com.zerdazi.life.Lights.status())
        m == "POST" && p == listOf("lights", "test") -> { com.zerdazi.life.Lights.test(); ok(JSONObject().put("ok", true)) }
        m == "POST" && p == listOf("lights", "hue", "pair") -> ok(com.zerdazi.life.Lights.Hue.pair())
        m == "DELETE" && p == listOf("lights", "hue") -> { com.zerdazi.life.Lights.Hue.forget(); Res(204, null) }
        m == "POST" && p == listOf("lights", "govee", "scan") -> ok(com.zerdazi.life.Lights.Govee.scan())
        m == "POST" && p == listOf("lights", "govee") -> { com.zerdazi.life.Lights.Govee.add(b.getString("address")); ok(JSONObject().put("ok", true)) }
        m == "DELETE" && p.size == 3 && p[0] == "lights" && p[1] == "govee" -> { com.zerdazi.life.Lights.Govee.remove(Uri.decode(p[2])); Res(204, null) }
        m == "GET" && p == listOf("blocks") -> ok(Blocks.list(ctx))
        m == "POST" && p == listOf("blocks") -> Blocks.add(b)
        m == "POST" && p == listOf("blocks", "tomorrow") -> Blocks.tomorrow(b)
        m == "DELETE" && p.size == 2 && p[0] == "blocks" -> Blocks.delete(p[1].toLongOrNull() ?: 0)
        m == "GET" && p == listOf("apps") -> ok(Blocks.installedApps(ctx))
        m == "GET" && p == listOf("usage") -> ok(com.zerdazi.life.Usage.summary(q("day") ?: com.zerdazi.life.Usage.lifeDay()))

        p.firstOrNull() == "integrations" && p.getOrNull(1) == "google" ->
            err(400, "Google Health is set up in the app (android/secrets.properties)")

        else -> err(404, "Not found")
    }

    private fun syncResult(r: JSONObject) = ok(r, if (r.optBoolean("ok")) 200 else 400)

    // --- goals ---
    private fun goals() = Db.all("SELECT id, name, sort_order, kind, is_private FROM goals ORDER BY sort_order, id")
    private fun goal(id: Any?) = Db.one("SELECT id, name, sort_order, kind, is_private FROM goals WHERE id = ?", id)

    private fun readPrivate(b: JSONObject, fallback: Any?): Any? {
        val k = if (b.has("is_private")) "is_private" else if (b.has("private")) "private" else return fallback
        return if (truthy(b.value(k))) 1L else 0L
    }

    private fun addGoal(b: JSONObject): Res {
        val name = (b.value("name")?.toString() ?: "").trim()
        if (name.isEmpty()) return err(400, "name is required")
        val kind = b.value("kind")?.toString()?.takeIf { it.isNotEmpty() } ?: "check"
        if (kind !in KINDS) return err(400, "kind must be one of ${KINDS.joinToString(", ")}")
        val max = Db.one("SELECT COALESCE(MAX(sort_order), -1) AS m FROM goals")!!["m"] as Long
        val id = Db.insert(
            "INSERT INTO goals (name, sort_order, kind, is_private) VALUES (?, ?, ?, ?)",
            name, max + 1, kind, readPrivate(b, 0L),
        )
        return ok(rowToJson(goal(id)!!), 201)
    }

    private fun updateGoal(id: String, b: JSONObject): Res {
        val g = goal(id) ?: return err(404, "Goal not found")
        val name = if (b.has("name")) b.value("name").toString().trim() else g["name"] as String
        if (name.isEmpty()) return err(400, "name cannot be empty")
        val kind = if (b.has("kind")) b.value("kind")?.toString() else g["kind"] as String
        if (kind !in KINDS) return err(400, "kind must be one of ${KINDS.joinToString(", ")}")
        val sort = if (b.has("sort_order")) b.value("sort_order").toString().toDouble().toLong() else g["sort_order"]
        Db.exec(
            "UPDATE goals SET name = ?, sort_order = ?, kind = ?, is_private = ? WHERE id = ?",
            name, sort, kind, readPrivate(b, g["is_private"]), g["id"],
        )
        return ok(rowToJson(goal(g["id"])!!))
    }

    // --- day ---
    private fun getDay(dateQ: String?): Res {
        val date = dateQ ?: Dates.today()
        if (!Dates.isValidDate(date)) return err(400, "date must be YYYY-MM-DD")
        val rows = Db.all(
            """SELECT g.id, g.name, g.kind, g.is_private,
                 COALESCE(l.done, 0) AS done, (l.date IS NOT NULL) AS logged,
                 l.bed_time, l.up_time, l.sleep_time, l.wake_time, l.asleep_minutes,
                 COALESCE(l.ran, 0) AS ran, COALESCE(l.worked_out, 0) AS worked_out
               FROM goals g LEFT JOIN logs l ON l.goal_id = g.id AND l.date = ?
               ORDER BY g.sort_order, g.id""",
            date,
        )
        return ok(JSONObject().put("date", date).put("goals", JSONArray(rows.map { Logs.formatDayGoal(it + ("date" to date)) })))
    }

    private val LOG_FIELDS = listOf("done", "bedTime", "upTime", "sleepTime", "wakeTime", "asleepMinutes", "sleepHours", "ran", "workedOut")
    private fun logFields(b: JSONObject) = JSONObject().apply { for (k in LOG_FIELDS) if (b.has(k)) put(k, b.get(k)) }

    private fun putDay(b: JSONObject): Res {
        val date = b.value("date")?.toString()?.takeIf { it.isNotEmpty() } ?: Dates.today()
        if (!Dates.isValidDate(date)) return err(400, "date must be YYYY-MM-DD")
        val goalId = b.value("goalId")?.toString()?.toDoubleOrNull()?.toLong() ?: 0
        if (goalId == 0L) return err(400, "goalId is required")
        val g = Db.one("SELECT id, name, kind, is_private FROM goals WHERE id = ?", goalId) ?: return err(404, "Goal not found")
        return ok(Logs.setLog(g, date, logFields(b)))
    }

    // --- report (server/src/routes/report.js) ---
    fun report(b: JSONObject): Res {
        val g = Logs.findGoal(b.value("goal"))
            ?: return err(404, "Unknown goal $b. Pass a valid goal id or name.")
        val explicitDate = b.value("date")?.toString()?.takeIf { it.isNotEmpty() }
        var date = explicitDate ?: Dates.today()
        if (!Dates.isValidDate(date)) return err(400, "date must be YYYY-MM-DD")

        val f = logFields(b)
        when (g["kind"]) {
            "check" -> if (!f.has("done")) f.put("done", true)
            "exercise" -> if (!f.has("ran") && !f.has("workedOut")) {
                f.put("workedOut", if (!f.has("done")) true else truthy(f.value("done")))
            }
        }
        if (g["kind"] == "sleep") {
            // bed/up accept "yyyy-MM-dd HH:mm" — the date drives attribution.
            var eventDate: String? = null
            for (k in listOf("bedTime", "upTime")) {
                val v = f.value(k) as? String ?: continue
                val m = Regex("""^(\d{4}-\d{2}-\d{2})[ T]+(.+)$""").find(v.trim()) ?: continue
                if (Dates.isValidDate(m.groupValues[1])) {
                    if (eventDate == null) eventDate = m.groupValues[1]
                    f.put(k, m.groupValues[2].trim())
                }
            }
            if (explicitDate == null) {
                date = eventDate ?: date
                val bed = f.value("bedTime")?.toString()?.takeIf { it.isNotEmpty() }
                val up = f.value("upTime")?.toString()?.takeIf { it.isNotEmpty() }
                if (bed != null) {
                    val h = bed.replaceFirst(".", ":").substringBefore(":").toIntOrNull()
                    if (h != null && h < 12) date = Dates.shiftDay(date, -1)
                } else if (up != null) {
                    date = Dates.shiftDay(date, -1)
                }
            }
        } else if (explicitDate == null) {
            date = Logs.attributeEarlyHours(date, Dates.nowHM())
        }
        val entry = Logs.setLog(g, date, f, protectTimes = true)
        val out = JSONObject()
            .put("goal", JSONObject().put("id", g["id"]).put("name", g["name"]).put("kind", g["kind"]))
            .put("date", date)
        entry.keys().forEach { out.put(it, entry.get(it)) }
        return ok(out)
    }

    // --- history ---
    private fun history(daysQ: String?): Res {
        val days = (daysQ?.toDoubleOrNull()?.toInt()?.takeIf { it != 0 } ?: 30).coerceIn(1, 365)
        val from = LocalDate.now().minusDays((days - 1).toLong()).toString()
        return ok(
            JSONObject().put("days", days).put("from", from)
                .put("goals", JSONArray(Db.all("SELECT id, name, kind FROM goals ORDER BY sort_order, id").map(::rowToJson)))
                .put("logs", JSONArray(Db.all("SELECT goal_id, date FROM logs WHERE done = 1 AND date >= ? ORDER BY date", from).map(::rowToJson)))
        )
    }

    // --- presence (server/src/routes/presence.js): phone-on-the-wall sessions ---
    object Presence {
        private fun latestOpen() = Db.one("SELECT * FROM presence WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1")

        fun start(): Res {
            val now = Dates.nowIso()
            Db.exec("UPDATE presence SET ended_at = ? WHERE ended_at IS NULL", now)
            val id = Db.insert("INSERT INTO presence (started_at) VALUES (?)", now)
            return Res(200, JSONObject().put("id", id).put("startedAt", now).toString())
        }

        fun bed(b: JSONObject): Res {
            val open = latestOpen() ?: return Res(200, JSONObject().put("ok", true).put("marked", false).toString())
            val d = b.value("date")?.toString()
            val date = if (Dates.isValidDate(d)) d!! else Dates.today()
            Db.exec("UPDATE presence SET bed_at = ?, bed_date = ? WHERE id = ?", Dates.nowIso(), date, open["id"])
            return Res(200, JSONObject().put("ok", true).put("marked", true).put("id", open["id"]).put("bedDate", date).toString())
        }

        fun end(): Res {
            val open = latestOpen() ?: return Res(200, JSONObject().put("ok", true).put("closed", false).toString())
            Db.exec("UPDATE presence SET ended_at = ? WHERE id = ?", Dates.nowIso(), open["id"])
            var upTime: String? = null
            val bedDate = open["bed_date"] as String?
            if (bedDate != null) {
                Db.one("SELECT id, name, kind FROM goals WHERE kind = 'sleep' ORDER BY sort_order, id LIMIT 1")?.let { g ->
                    upTime = Dates.nowHM()
                    Logs.setLog(g, bedDate, JSONObject().put("upTime", upTime), protectTimes = true)
                }
            }
            return Res(200, JSONObject().put("ok", true).put("closed", true).put("id", open["id"])
                .putN("upTime", upTime).putN("bedDate", bedDate).toString())
        }

        fun get(dateQ: String?): Res {
            val date = dateQ ?: Dates.today()
            if (!Dates.isValidDate(date)) return Res(400, JSONObject().put("error", "date must be YYYY-MM-DD").toString())
            val dayStart = LocalDate.parse(date).atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli()
            val dayEnd = dayStart + 24 * 60 * 60 * 1000
            val iso = { ms: Long -> Instant.ofEpochMilli(ms).toString().let { if (it.length == 20) it.replace("Z", ".000Z") else it } }
            val rows = Db.all(
                "SELECT * FROM presence WHERE started_at < ? AND (ended_at IS NULL OR ended_at > ?) ORDER BY started_at",
                iso(dayEnd), iso(dayStart),
            )
            val now = System.currentTimeMillis()
            var total = 0L
            val sessions = JSONArray()
            for (r in rows) {
                val s = Instant.parse(r["started_at"] as String).toEpochMilli()
                val e = (r["ended_at"] as String?)?.let { Instant.parse(it).toEpochMilli() } ?: now
                val overlap = maxOf(0, minOf(e, dayEnd) - maxOf(s, dayStart))
                total += overlap
                sessions.put(
                    JSONObject().put("id", r["id"]).put("startedAt", r["started_at"]).putN("endedAt", r["ended_at"])
                        .put("open", r["ended_at"] == null).putN("bedDate", r["bed_date"])
                        .put("minutes", Math.round(overlap / 60000.0))
                )
            }
            return Res(200, JSONObject().put("date", date).put("totalMinutes", Math.round(total / 60000.0))
                .put("count", sessions.length()).put("sessions", sessions).toString())
        }
    }
}
