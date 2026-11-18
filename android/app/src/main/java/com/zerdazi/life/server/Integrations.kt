package com.zerdazi.life.server

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.feature.ExperimentalMindfulnessSessionApi
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.MindfulnessSessionRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import com.zerdazi.life.BuildConfig
import kotlinx.coroutines.runBlocking
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.net.InetAddress
import java.net.ServerSocket
import java.net.URLDecoder
import java.security.SecureRandom
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

// Ports of server/src/integrations/*. Tokens come from secrets.properties via BuildConfig.

private class HttpResult(val code: Int, val json: JSONObject?)

private fun http(url: String, method: String = "GET", headers: Map<String, String> = emptyMap(), body: String? = null): HttpResult {
    val c = URL(url).openConnection() as HttpURLConnection
    c.requestMethod = method
    c.connectTimeout = 15000
    c.readTimeout = 20000
    headers.forEach { (k, v) -> c.setRequestProperty(k, v) }
    if (body != null) {
        c.doOutput = true
        c.outputStream.use { it.write(body.toByteArray()) }
    }
    val code = c.responseCode
    val text = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
    c.disconnect()
    return HttpResult(code, runCatching { JSONObject(text) }.getOrNull())
}

private fun form(vararg kv: Pair<String, String>) =
    kv.joinToString("&") { (k, v) -> "$k=" + URLEncoder.encode(v, "UTF-8") }

object Integrations {
    // Called by LifeService's poller.
    fun syncAll() {
        runCatching { GoogleHealth.sync() }
        runCatching { WakingUp.sync() }
    }
}

object GoogleHealth {
    private const val API_BASE = "https://health.googleapis.com/v4/users/me/dataTypes"
    private const val TOKEN_URI = "https://oauth2.googleapis.com/token"
    private const val ACCESS_KEY = "google_access_token"
    private const val EXPIRES_KEY = "google_expires_at"
    private const val SYNC_KEY = "google_last_sync"
    private const val REFRESH_KEY = "google_refresh_token"
    private const val ERROR_KEY = "google_auth_error"
    private const val AUTH_URI = "https://accounts.google.com/o/oauth2/auth"
    // Must be a redirect URI registered on the OAuth client (it's the one in
    // auth/client_secret_*.json). The app listens there during sign-in.
    private const val REDIRECT_PORT = 5173
    private const val REDIRECT_URI = "http://localhost:$REDIRECT_PORT/"
    private val SCOPES = listOf(
        "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
        "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
    )

    private val configured get() = BuildConfig.GOOGLE_CLIENT_ID.isNotEmpty()
    // Signed in from the app (Db) wins over the build-time token.
    private val refreshToken get() = Db.getMeta(REFRESH_KEY) ?: BuildConfig.GOOGLE_REFRESH_TOKEN.ifEmpty { null }
    private val connected get() = refreshToken != null && Db.getMeta(ERROR_KEY) == null

    fun status(): JSONObject = JSONObject().put("configured", configured).put("connected", connected)
        .put("signingIn", signingIn).putN("error", Db.getMeta(ERROR_KEY)).putN("lastSync", Db.getMeta(SYNC_KEY))

    // --- sign-in ---
    @Volatile private var signingIn = false

    // Opens Google's consent page in the browser and waits (up to 5 minutes)
    // for it to redirect back to localhost with a code.
    fun startLogin(ctx: Context): JSONObject {
        if (!configured) return JSONObject().put("ok", false).put("reason", "GOOGLE_CLIENT_ID not set")
        if (signingIn) return JSONObject().put("ok", true).put("started", false)
        val state = ByteArray(16).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
        val server = try {
            ServerSocket(REDIRECT_PORT, 1, InetAddress.getByName("127.0.0.1")).apply { soTimeout = 5 * 60_000 }
        } catch (e: Exception) {
            return JSONObject().put("ok", false).put("reason", "Couldn't listen on port $REDIRECT_PORT: ${e.message}")
        }
        signingIn = true
        Thread {
            try {
                server.use { waitForCode(it, state) }
            } catch (e: Exception) {
                Log.w("LifeGoogle", "sign-in failed", e)
            } finally {
                signingIn = false
            }
        }.start()
        val url = AUTH_URI + "?" + form(
            "client_id" to BuildConfig.GOOGLE_CLIENT_ID,
            "redirect_uri" to REDIRECT_URI,
            "response_type" to "code",
            "access_type" to "offline",
            "prompt" to "consent",
            "scope" to SCOPES.joinToString(" "),
            "state" to state,
        )
        ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        return JSONObject().put("ok", true).put("started", true)
    }

    private fun waitForCode(server: ServerSocket, state: String) {
        // The browser may also ask for /favicon.ico; keep going until the redirect.
        while (true) {
            server.accept().use { sock ->
                val line = sock.getInputStream().bufferedReader().readLine() ?: return@use
                val target = line.split(" ").getOrNull(1) ?: return@use
                val q = target.substringAfter('?', "").split("&").mapNotNull {
                    val (k, v) = it.split("=", limit = 2).takeIf { p -> p.size == 2 } ?: return@mapNotNull null
                    k to URLDecoder.decode(v, "UTF-8")
                }.toMap()
                if (q["code"] == null && q["error"] == null) {
                    sock.getOutputStream().write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
                    return@use
                }
                val result = when {
                    q["state"] != state -> "Sign-in didn't match. Try again from life."
                    q["error"] != null -> "Google said: ${q["error"]}"
                    else -> exchange(q["code"]!!)
                }
                val ok = result == null
                val html = "<!doctype html><meta name=viewport content='width=device-width'>" +
                    "<body style='background:#12110f;color:#ede9e1;font:18px system-ui;padding:48px 28px'>" +
                    "<h1 style='font-weight:400'>${if (ok) "Connected." else "Not connected."}</h1>" +
                    "<p style='color:#a8a398'>${result ?: "Google Health is linked. You can close this tab and go back to life."}</p>"
                val body = html.toByteArray()
                sock.getOutputStream().write(
                    ("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n").toByteArray() + body
                )
                if (ok) Thread { runCatching { sync() } }.start()
                return
            }
        }
    }

    // Swaps the code for tokens. Returns an error message, or null when done.
    private fun exchange(code: String): String? {
        val r = http(
            TOKEN_URI, "POST", mapOf("content-type" to "application/x-www-form-urlencoded"),
            form(
                "code" to code,
                "client_id" to BuildConfig.GOOGLE_CLIENT_ID,
                "client_secret" to BuildConfig.GOOGLE_CLIENT_SECRET,
                "redirect_uri" to REDIRECT_URI,
                "grant_type" to "authorization_code",
            ),
        )
        val j = r.json
        if (r.code >= 400 || j == null) return j?.optString("error_description")?.ifEmpty { null } ?: "Token exchange failed (${r.code})"
        val refresh = j.optString("refresh_token").ifEmpty { null } ?: return "Google didn't return a refresh token. Remove life's access at myaccount.google.com/permissions and try again."
        Db.setMeta(REFRESH_KEY, refresh)
        Db.setMeta(ACCESS_KEY, j.getString("access_token"))
        Db.setMeta(EXPIRES_KEY, System.currentTimeMillis() / 1000 + j.optLong("expires_in", 3600))
        Db.deleteMeta(ERROR_KEY)
        return null
    }

    private fun accessToken(): String {
        val access = Db.getMeta(ACCESS_KEY)
        val expiresAt = Db.getMeta(EXPIRES_KEY)?.toLongOrNull() ?: 0
        if (access != null && expiresAt > System.currentTimeMillis() / 1000 + 60) return access
        val r = http(
            TOKEN_URI, "POST", mapOf("content-type" to "application/x-www-form-urlencoded"),
            form(
                "client_id" to BuildConfig.GOOGLE_CLIENT_ID,
                "client_secret" to BuildConfig.GOOGLE_CLIENT_SECRET,
                "refresh_token" to (refreshToken ?: throw Exception("Not signed in to Google")),
                "grant_type" to "refresh_token",
            ),
        )
        // Revoked or expired (Testing-mode OAuth apps expire tokens after 7
        // days): stop trying until signed in again.
        if (r.json?.optString("error") == "invalid_grant") {
            Db.setMeta(ERROR_KEY, "Google sign-in expired")
            Db.deleteMeta(ACCESS_KEY)
        }
        val token = r.json?.optString("access_token")?.takeIf { it.isNotEmpty() && r.code < 400 }
            ?: throw Exception(r.json?.optString("error_description")?.takeIf { it.isNotEmpty() }
                ?: r.json?.optString("error")?.takeIf { it.isNotEmpty() } ?: "Token refresh failed (${r.code})")
        Db.setMeta(ACCESS_KEY, token)
        Db.setMeta(EXPIRES_KEY, System.currentTimeMillis() / 1000 + r.json.optLong("expires_in", 3600))
        return token
    }

    private fun offsetSeconds(s: String?) = s?.takeWhile { it.isDigit() || it == '-' }?.toLongOrNull() ?: 0
    private fun local(rfc3339: String, offset: String?) =
        OffsetDateTime.parse(rfc3339).toInstant().plusSeconds(offsetSeconds(offset)).atOffset(ZoneOffset.UTC)
    private fun localHM(t: String, off: String?) = local(t, off).format(DateTimeFormatter.ofPattern("HH:mm"))
    private fun localDate(t: String, off: String?) = local(t, off).toLocalDate().toString()

    private val allowed: Set<String>? = BuildConfig.GOOGLE_DATA_SOURCES.split(",").map { it.trim() }
        .filter { it.isNotEmpty() }.toSet().ifEmpty { null }

    private fun fromAllowed(p: JSONObject) = allowed == null ||
        p.optJSONObject("dataSource")?.optJSONObject("application")?.optString("packageName") in allowed!!

    private fun listDataPoints(token: String, type: String, filter: String? = null): List<JSONObject> {
        var url = "$API_BASE/$type/dataPoints?pageSize=100"
        if (filter != null) url += "&filter=" + URLEncoder.encode(filter, "UTF-8").replace("+", "%20")
        val r = http(url, headers = mapOf("authorization" to "Bearer $token", "accept" to "application/json"))
        if (r.code >= 400) throw Exception(r.json?.optJSONObject("error")?.optString("message") ?: "$type API error ${r.code}")
        val arr = r.json?.optJSONArray("dataPoints") ?: JSONArray()
        return (0 until arr.length()).map { arr.getJSONObject(it) }
    }

    fun sync(): JSONObject {
        if (!configured) return JSONObject().put("ok", false).put("skipped", true).put("reason", "Google client not configured")
        if (!connected) return JSONObject().put("ok", false).put("needsAuth", true)
            .put("reason", Db.getMeta(ERROR_KEY) ?: "Not signed in to Google")
        val token = try { accessToken() } catch (e: Exception) {
            return JSONObject().put("ok", false).put("reason", e.message)
        }
        val result = JSONObject().put("ok", true)
        val today = LocalDate.now()

        // Exercise → Exercise (ran/workedOut) and Yoga, each on its own (early-hours-adjusted) date.
        try {
            val exGoal = Logs.findGoal("Exercise")
            val yogaGoal = Logs.findGoal("Yoga")
            val points = listDataPoints(
                token, "exercise",
                "exercise.interval.civil_start_time >= \"${today.minusDays(1)}\" AND exercise.interval.civil_start_time < \"${today.plusDays(1)}\"",
            )
            val byDate = linkedMapOf<String, BooleanArray>() // ran, workedOut, yoga
            for (p in points) {
                if (!fromAllowed(p)) continue
                val ex = p.optJSONObject("exercise") ?: continue
                val iv = ex.optJSONObject("interval") ?: continue
                val start = iv.optString("startTime")
                if (start.isEmpty()) continue
                val off = iv.optString("startUtcOffset")
                val date = Logs.attributeEarlyHours(localDate(start, off), localHM(start, off))
                val type = ex.optString("exerciseType").uppercase()
                val agg = byDate.getOrPut(date) { BooleanArray(3) }
                when {
                    "RUN" in type -> agg[0] = true
                    "YOGA" in type -> agg[2] = true
                    else -> agg[1] = true
                }
            }
            val all = BooleanArray(3)
            for ((date, agg) in byDate) {
                if (exGoal != null && (agg[0] || agg[1])) {
                    Logs.setLog(exGoal, date, JSONObject().apply {
                        if (agg[0]) put("ran", true)
                        if (agg[1]) put("workedOut", true)
                    })
                }
                if (yogaGoal != null && agg[2]) Logs.setLog(yogaGoal, date, JSONObject().put("done", true))
                for (i in 0..2) all[i] = all[i] || agg[i]
            }
            result.put("exercise", JSONObject().put("ran", all[0]).put("workedOut", all[1]).put("yoga", all[2]).put("sessions", points.size))
        } catch (e: Exception) {
            result.put("exerciseError", e.message)
        }

        // Sleep → Sleep goal, each session on the day you went to bed.
        try {
            val sleepGoal = Logs.findGoal("Sleep")
            val sessions = listDataPoints(token, "sleep")
                .filter(::fromAllowed)
                .mapNotNull { it.optJSONObject("sleep") }
                .filter { it.optJSONObject("interval")?.optString("endTime")?.isNotEmpty() == true }
                .sortedBy { OffsetDateTime.parse(it.getJSONObject("interval").getString("startTime")).toInstant() }
            var last: JSONObject? = null
            if (sleepGoal != null) for (s in sessions) {
                val iv = s.getJSONObject("interval")
                val sleepTime = localHM(iv.getString("startTime"), iv.optString("startUtcOffset"))
                val wakeTime = localHM(iv.getString("endTime"), iv.optString("endUtcOffset"))
                val raw = localDate(iv.getString("startTime"), iv.optString("startUtcOffset"))
                val date = if (sleepTime.substringBefore(":").toInt() < 12) Dates.shiftDay(raw, -1) else raw
                val asleep = s.optJSONObject("summary")?.opt("minutesAsleep")?.toString()?.toDoubleOrNull()
                Logs.setLog(sleepGoal, date, JSONObject().put("sleepTime", sleepTime).put("wakeTime", wakeTime))
                if (asleep != null) Logs.setLog(sleepGoal, date, JSONObject().put("asleepMinutes", asleep))
                last = JSONObject().put("date", date).put("sleepTime", sleepTime).put("wakeTime", wakeTime).putN("asleepMinutes", asleep)
            }
            result.putN("sleep", last).put("sleepSessions", sessions.size)
        } catch (e: Exception) {
            result.put("sleepError", e.message)
        }

        if (result.has("exerciseError") && result.has("sleepError")) {
            return JSONObject().put("ok", false).put("reason", result.get("sleepError")).put("exerciseError", result.get("exerciseError"))
        }
        Db.setMeta(SYNC_KEY, Dates.nowIso())
        return result
    }
}

// Meditation from Waking Up, via Health Connect: Waking Up writes each
// finished session there as a mindfulness record, and this reads them back.
// (Waking Up has no public API; its private one sits behind a bot firewall.)
// Any app's mindfulness sessions count. Kept as "wakingup" in the API.
@OptIn(ExperimentalMindfulnessSessionApi::class)
object WakingUp {
    private const val GOAL = "Meditation"
    private const val SYNC_KEY = "wakingup_last_sync"
    private const val LOOKBACK_DAYS = 7L

    // Read mindfulness, and keep reading when the app isn't on screen (the
    // background poll in LifeService).
    val PERMISSIONS = setOf(
        HealthPermission.getReadPermission(MindfulnessSessionRecord::class),
        HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND,
    )

    private fun client(): HealthConnectClient? {
        val ctx = com.zerdazi.life.LifeApp.ctx
        if (HealthConnectClient.getSdkStatus(ctx) != HealthConnectClient.SDK_AVAILABLE) return null
        val c = HealthConnectClient.getOrCreate(ctx)
        val f = c.features
        return c.takeIf { f.getFeatureStatus(HealthConnectFeatures.FEATURE_MINDFULNESS_SESSION) == HealthConnectFeatures.FEATURE_STATUS_AVAILABLE }
    }

    val available get() = client() != null

    // Blocking (IPC): call off the main thread.
    fun missingPermissions(): Set<String> {
        val c = client() ?: return emptySet()
        val granted = runBlocking { c.permissionController.getGrantedPermissions() }
        return PERMISSIONS - granted
    }

    fun status(): JSONObject {
        val ok = available
        return JSONObject().put("configured", ok).put("connected", ok && missingPermissions().isEmpty())
            .put("source", "Health Connect").put("goal", GOAL).putN("lastSync", Db.getMeta(SYNC_KEY))
    }

    // Marks Meditation done on every day (early hours count as the day
    // before) with a session of a minute or more in the last week.
    fun sync(): JSONObject {
        val c = client() ?: return JSONObject().put("ok", false).put("skipped", true)
            .put("reason", "Health Connect mindfulness isn't available on this phone")
        val goal = Logs.findGoal(GOAL) ?: return JSONObject().put("ok", false).put("reason", "Goal \"$GOAL\" not found")
        val records = try {
            runBlocking {
                c.readRecords(
                    ReadRecordsRequest(
                        MindfulnessSessionRecord::class,
                        TimeRangeFilter.after(Instant.now().minus(Duration.ofDays(LOOKBACK_DAYS))),
                    )
                ).records
            }
        } catch (e: SecurityException) {
            return JSONObject().put("ok", false).put("needsPermission", true).put("reason", "Allow life to read mindfulness in Health Connect")
        } catch (e: Exception) {
            return JSONObject().put("ok", false).put("reason", "Health Connect: ${e.message}")
        }
        val days = sortedSetOf<String>()
        for (r in records) {
            if (Duration.between(r.startTime, r.endTime).toMinutes() < 1) continue
            val offset = r.startZoneOffset ?: ZoneId.systemDefault().rules.getOffset(r.startTime)
            val local = r.startTime.atOffset(offset)
            val date = Logs.attributeEarlyHours(local.toLocalDate().toString(), local.format(DateTimeFormatter.ofPattern("HH:mm")))
            if (days.add(date)) Logs.setLog(goal, date, JSONObject().put("done", true))
        }
        Db.setMeta(SYNC_KEY, Dates.nowIso())
        return JSONObject().put("ok", true).put("sessions", records.size).put("days", JSONArray(days.toList())).put("goal", GOAL)
    }
}
