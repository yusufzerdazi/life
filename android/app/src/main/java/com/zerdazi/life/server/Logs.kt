package com.zerdazi.life.server

import org.json.JSONObject
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

// On-device port of server/src/logs.js + util.js. Keep the two in step.

class ApiError(val status: Int, message: String) : Exception(message)

const val DAY_START = "05:00"

object Dates {
    fun today(): String = LocalDate.now().toString()

    fun isValidDate(s: String?): Boolean =
        s != null && Regex("""^\d{4}-\d{2}-\d{2}$""").matches(s) && runCatching { LocalDate.parse(s) }.isSuccess

    fun isValidTime(s: String?): Boolean = s != null && Regex("^([01]\\d|2[0-3]):[0-5]\\d$").matches(s)

    fun shiftDay(date: String, delta: Long): String = LocalDate.parse(date).plusDays(delta).toString()

    fun nowHM(): String = LocalTime.now().format(DateTimeFormatter.ofPattern("HH:mm"))

    // Same shape as JS toISOString(), so stored timestamps compare as strings.
    fun nowIso(): String = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC).format(Instant.now())

    fun minutes(t: String): Int = t.split(":").let { it[0].toInt() * 60 + it[1].toInt() }
}

// Request-body helpers mirroring JS semantics: absent = undefined, JSON null = null.
fun JSONObject.value(k: String): Any? = if (!has(k) || isNull(k)) null else get(k)

fun truthy(v: Any?): Boolean = when (v) {
    null, JSONObject.NULL -> false
    is Boolean -> v
    is Number -> v.toDouble() != 0.0 && !v.toDouble().isNaN()
    is String -> v.isNotEmpty()
    else -> true
}

fun JSONObject.putN(k: String, v: Any?): JSONObject = put(k, v ?: JSONObject.NULL)

fun rowToJson(r: Row): JSONObject = JSONObject().apply { r.forEach { (k, v) -> putN(k, v) } }

object Logs {
    private const val MIN_MINUTES = 450
    private const val BED_BEFORE = "23:00"
    private const val WAKE_BEFORE = "08:30"
    private const val EVENING_START = 12 * 60

    private fun normTime(v: Any?): String? {
        if (v == null) return null
        val s = v.toString().trim().replaceFirst(".", ":")
        if (s.isEmpty()) return null
        if (!Dates.isValidTime(s)) throw ApiError(400, "time must be HH:MM or HH.MM (24-hour)")
        return s
    }

    private fun normMinutes(v: Any?): Long? {
        if (v == null || v == "") return null
        val n = when (v) {
            is Number -> v.toDouble()
            is Boolean -> if (v) 1.0 else 0.0
            else -> v.toString().trim().toDoubleOrNull() ?: Double.NaN
        }
        if (n.isNaN() || n < 0 || n > 24 * 60) throw ApiError(400, "sleep minutes must be 0–1440")
        return Math.round(n)
    }

    // Minutes from `bed` to `wake` (clock times). With the night's date (the
    // day the night belongs to), it's real elapsed time in the phone's zone, so
    // the BST/GMT nights come out an hour shorter/longer as they really are.
    fun sleepMinutes(bed: String?, wake: String?, date: String? = null): Int? {
        if (bed.isNullOrEmpty() || wake.isNullOrEmpty()) return null
        var d = Dates.minutes(wake) - Dates.minutes(bed)
        if (d <= 0) d += 24 * 60
        if (!Dates.isValidDate(date)) return d
        val zone = ZoneId.systemDefault()
        val night = LocalDate.parse(date)
        // Times before noon are after midnight, i.e. on the next calendar day.
        val bedDay = if (Dates.minutes(bed) >= 12 * 60) night else night.plusDays(1)
        val start = bedDay.atTime(LocalTime.parse(bed))
        return Duration.between(start.atZone(zone), start.plusMinutes(d.toLong()).atZone(zone)).toMinutes().toInt()
    }

    private fun criteria(bed: String?, up: String?, sleepStart: String?, wake: String?, asleep: Long?, date: String?): JSONObject {
        val asleepSpan = sleepMinutes(sleepStart, wake, date)
        val inBed = sleepMinutes(bed, up, date)
        val effective = inBed?.toLong() ?: asleep ?: asleepSpan?.toLong()
        val effectiveWake = if (!wake.isNullOrEmpty()) wake else up
        val durationOk = effective != null && effective >= MIN_MINUTES
        val bedOk = !bed.isNullOrEmpty() && Dates.minutes(bed) >= EVENING_START && Dates.minutes(bed) < Dates.minutes(BED_BEFORE)
        val wakeOk = !effectiveWake.isNullOrEmpty() && Dates.minutes(effectiveWake) < Dates.minutes(WAKE_BEFORE)
        return JSONObject().put("durationOk", durationOk).put("bedOk", bedOk).put("wakeOk", wakeOk).put("met", bedOk)
    }

    private fun str(v: Any?): String? = (v as? String)?.takeIf { it.isNotEmpty() }
    private fun long(v: Any?): Long? = (v as? Number)?.toLong()

    fun formatDayGoal(r: Row): JSONObject {
        val o = JSONObject()
            .put("id", r["id"]).put("name", r["name"]).put("kind", r["kind"]).put("done", truthy(r["done"]))
        when (r["kind"]) {
            "sleep" -> {
                val bed = str(r["bed_time"]); val up = str(r["up_time"])
                val sleep = str(r["sleep_time"]); val wake = str(r["wake_time"])
                val asleep = long(r["asleep_minutes"])
                o.putN("bedTime", bed).putN("upTime", up).putN("sleepTime", sleep).putN("wakeTime", wake)
                    .putN("inBedMinutes", sleepMinutes(bed, up, r["date"] as String?)).putN("asleepMinutes", asleep)
                    .put("criteria", criteria(bed, up, sleep, wake, asleep, r["date"] as String?))
                    .put("target", JSONObject().put("minMinutes", MIN_MINUTES).put("bedBefore", BED_BEFORE).put("wakeBefore", WAKE_BEFORE))
            }
            "exercise" -> o.put("ran", truthy(r["ran"])).put("workedOut", truthy(r["worked_out"]))
            "avoid" -> o.put("private", truthy(r["is_private"]))
                .put("status", if (truthy(r["logged"])) (if (truthy(r["done"])) "clean" else "slipped") else "pending")
        }
        return o
    }

    // Merge-upsert; keys absent from `fields` are left unchanged. With
    // protectTimes, an already-tracked bed/up time is kept (first charge wins).
    fun setLog(goal: Row, date: String, fields: JSONObject, protectTimes: Boolean = false): JSONObject {
        val goalId = goal["id"]
        val existing = Db.one("SELECT * FROM logs WHERE goal_id = ? AND date = ?", goalId, date)
        val keepBed = protectTimes && str(existing?.get("bed_time")) != null
        val keepUp = protectTimes && str(existing?.get("up_time")) != null

        var done: Long
        var bed = existing?.get("bed_time") as String?
        var up = existing?.get("up_time") as String?
        var sleep = existing?.get("sleep_time") as String?
        var wake = existing?.get("wake_time") as String?
        var asleep = long(existing?.get("asleep_minutes"))
        var ran = long(existing?.get("ran")) ?: 0
        var workedOut = long(existing?.get("worked_out")) ?: 0
        fun b(v: Boolean) = if (v) 1L else 0L

        when (goal["kind"]) {
            "sleep" -> {
                ran = 0; workedOut = 0
                if (fields.has("bedTime") && !keepBed) bed = normTime(fields.value("bedTime"))
                if (fields.has("upTime") && !keepUp) up = normTime(fields.value("upTime"))
                if (fields.has("sleepTime")) sleep = normTime(fields.value("sleepTime"))
                if (fields.has("wakeTime")) wake = normTime(fields.value("wakeTime"))
                if (fields.has("asleepMinutes")) asleep = normMinutes(fields.value("asleepMinutes"))
                else if (fields.has("sleepHours")) {
                    val h = fields.value("sleepHours")
                    asleep = normMinutes(if (h == null || h == "") null else (h.toString().toDoubleOrNull() ?: Double.NaN) * 60)
                }
                done = b(criteria(bed, up, sleep, wake, asleep, date).getBoolean("met"))
            }
            "exercise" -> {
                bed = null; up = null; sleep = null; wake = null; asleep = null
                if (fields.has("ran")) ran = b(truthy(fields.value("ran")))
                if (fields.has("workedOut")) workedOut = b(truthy(fields.value("workedOut")))
                done = b(ran != 0L || workedOut != 0L)
            }
            else -> {
                bed = null; up = null; sleep = null; wake = null; asleep = null; ran = 0; workedOut = 0
                done = if (fields.has("done")) b(truthy(fields.value("done"))) else long(existing?.get("done")) ?: 0
            }
        }

        if (existing != null) {
            Db.exec(
                """UPDATE logs SET done = ?, time = NULL, bed_time = ?, up_time = ?, sleep_time = ?, wake_time = ?,
                   asleep_minutes = ?, ran = ?, worked_out = ?, updated_at = datetime('now') WHERE goal_id = ? AND date = ?""",
                done, bed, up, sleep, wake, asleep, ran, workedOut, goalId, date,
            )
        } else {
            Db.exec(
                """INSERT INTO logs (goal_id, date, done, time, bed_time, up_time, sleep_time, wake_time, asleep_minutes, ran, worked_out, updated_at)
                   VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, datetime('now'))""",
                goalId, date, done, bed, up, sleep, wake, asleep, ran, workedOut,
            )
        }
        return formatDayGoal(
            mapOf(
                "id" to goalId, "name" to goal["name"], "kind" to goal["kind"], "is_private" to goal["is_private"], "logged" to 1L,
                "date" to date, "done" to done, "time" to null, "bed_time" to bed, "up_time" to up, "sleep_time" to sleep,
                "wake_time" to wake, "asleep_minutes" to asleep, "ran" to ran, "worked_out" to workedOut,
            )
        )
    }

    // When "today" began — today's recorded up/wake time on the sleep goal.
    fun sleepDayStart(date: String): String? {
        val g = Db.one("SELECT id FROM goals WHERE kind = 'sleep' ORDER BY sort_order, id LIMIT 1") ?: return null
        val r = Db.one("SELECT up_time, wake_time FROM logs WHERE goal_id = ? AND date = ?", g["id"], date) ?: return null
        return str(r["up_time"]) ?: str(r["wake_time"])
    }

    // Events before the day's start (get-up time, else DAY_START) belong to the previous day.
    fun attributeEarlyHours(date: String, time: String): String {
        val start = sleepDayStart(date) ?: DAY_START
        return if (Dates.minutes(time) < Dates.minutes(start)) Dates.shiftDay(date, -1) else date
    }

    fun findGoal(ref: Any?): Row? {
        if (ref == null || ref == "") return null
        val s = ref.toString().trim()
        if (ref is Number || Regex("^\\d+$").matches(s)) {
            return Db.one("SELECT id, name, kind, is_private FROM goals WHERE id = ?", s.toDouble().toLong())
        }
        return Db.one("SELECT id, name, kind, is_private FROM goals WHERE name = ? COLLATE NOCASE", s)
    }
}
