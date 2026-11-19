package com.zerdazi.life.server

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import com.zerdazi.life.Config
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.security.SecureRandom
import java.time.LocalDateTime
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

// Blocks shared with the life desktop apps over the home network (see
// desktop/PROTOCOL.md). Every device finds the others by mDNS
// (_lifesync._tcp), and swaps its whole block list with each one: on a
// change, and every minute. Newest edit of a block wins; deletions are
// tombstones. Requests are signed with a key shared by all your devices.
object Sync {
    private const val TAG = "LifeSync"
    const val PORT = 47712
    private const val SERVICE = "_lifesync._tcp"
    private const val TOMBSTONE_DAYS = 30L

    private lateinit var ctx: Context
    private val thread = HandlerThread("sync").apply { start() }
    private val handler = Handler(thread.looper)
    private var nsd: NsdManager? = null

    // Peers by device id: where they are, and how the last swap went.
    class Peer(val device: String, var name: String, var host: String, var port: Int) {
        @Volatile var lastSync: Long = 0
        @Volatile var error: String? = null
    }
    private val peers = ConcurrentHashMap<String, Peer>()

    fun device(): String = Db.getMeta("sync_device") ?: java.util.UUID.randomUUID().toString().also { Db.setMeta("sync_device", it) }
    private fun deviceName() = "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}".replace("Google ", "")

    // Shown in the app; entered on the other devices. 20 letters/digits.
    fun key(): String = Db.getMeta("sync_key") ?: run {
        val abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        val r = SecureRandom()
        (1..20).map { abc[r.nextInt(abc.length)] }.chunked(5).joinToString("-") { it.joinToString("") }
    }.also { Db.setMeta("sync_key", it) }

    fun setKey(k: String) {
        val clean = k.trim().uppercase().replace(Regex("[^A-Z0-9]"), "").chunked(5).joinToString("-")
        if (clean.replace("-", "").length < 16) throw ApiError(400, "That key is too short")
        Db.setMeta("sync_key", clean)
        peers.values.forEach { it.error = null }
        soon()
    }

    fun start(c: Context) {
        ctx = c.applicationContext
        Thread(::serve, "sync-server").apply { isDaemon = true }.start()
        handler.post { advertise(); discover() }
        handler.postDelayed(object : Runnable {
            override fun run() { syncAll(); handler.postDelayed(this, 60_000) }
        }, 5_000)
    }

    // A local change: swap with everyone shortly.
    fun soon() {
        handler.removeCallbacksAndMessages(SOON)
        handler.postAtTime({ syncAll() }, SOON, android.os.SystemClock.uptimeMillis() + 1500)
    }
    private val SOON = Any()

    fun status(): JSONObject = JSONObject()
        .put("device", device()).put("name", deviceName()).put("key", key())
        .put("peers", JSONArray(peers.values.sortedBy { it.name }.map {
            JSONObject().put("name", it.name).put("lastSync", if (it.lastSync > 0) it.lastSync else JSONObject.NULL)
                .put("error", it.error ?: JSONObject.NULL)
        }))

    // --- the block list on the wire ---

    private fun export(): JSONArray {
        val out = JSONArray()
        val cutoff = System.currentTimeMillis() - TOMBSTONE_DAYS * 86_400_000
        Db.exec("DELETE FROM blocks WHERE deleted = 1 AND updated_at < ?", cutoff)
        for (r in Db.all("SELECT * FROM blocks")) {
            out.put(JSONObject()
                .put("uid", r["uid"]).put("name", r["name"])
                .put("apps", JSONArray(r["apps"] as String? ?: "[]"))
                .put("labels", JSONObject(r["labels"] as String? ?: "{}"))
                .put("sites", JSONArray(r["sites"] as String? ?: "[]"))
                .put("days", JSONArray((r["days"] as String).mapNotNull { it.digitToIntOrNull() }))
                .put("start", r["start_time"]).put("end", r["end_time"])
                .put("until", r["until_at"] ?: JSONObject.NULL)
                .put("category", JSONObject.NULL).put("builtIn", false)
                .put("origin", r["origin"] ?: device())
                .put("updatedAt", r["updated_at"] ?: 0L)
                .put("deleted", (r["deleted"] as Long? ?: 0L) == 1L))
        }
        // Built-in and category blocks: defined in Config, so "updated" when
        // the app was last installed.
        val builtAt = runCatching { ctx.packageManager.getPackageInfo(ctx.packageName, 0).lastUpdateTime }.getOrDefault(0L)
        fun builtIn(uid: String, b: com.zerdazi.life.Block, w: com.zerdazi.life.Window, category: String?) = out.put(JSONObject()
            .put("uid", uid).put("name", b.name)
            .put("apps", JSONArray(b.apps.toList())).put("labels", JSONObject())
            .put("sites", JSONArray(b.sites.toList()))
            .put("days", JSONArray(w.days.map { it.value }.sorted()))
            .put("start", w.start.toString()).put("end", w.end.toString())
            .put("until", JSONObject.NULL)
            .put("category", category ?: JSONObject.NULL).put("builtIn", true)
            .put("origin", device()).put("updatedAt", builtAt).put("deleted", false))
        Config.BLOCKS.forEach { b -> b.windows.forEachIndexed { i, w -> builtIn("builtin:${b.name}:$i", b, w, null) } }
        Config.CATEGORY_BLOCKS.forEach { (cat, b) -> b.windows.forEachIndexed { i, w -> builtIn("category:$cat:$i", b, w, cat) } }
        return out
    }

    // Newest edit wins (a deletion wins a tie). Built-ins come from this
    // phone's code, so ones from elsewhere are ignored; finished one-offs too.
    @Synchronized private fun merge(incoming: JSONArray) {
        var changed = false
        val now = LocalDateTime.now().toString()
        for (i in 0 until incoming.length()) {
            val b = incoming.optJSONObject(i) ?: continue
            if (b.optBoolean("builtIn")) continue
            val uid = b.optString("uid").takeIf { it.isNotEmpty() } ?: continue
            val until = b.optString("until").takeIf { it.isNotEmpty() && it != "null" }
            if (until != null && until <= now) continue
            val at = b.optLong("updatedAt")
            val deleted = b.optBoolean("deleted")
            val mine = Db.one("SELECT updated_at, deleted FROM blocks WHERE uid = ?", uid)
            if (mine != null) {
                val myAt = mine["updated_at"] as Long? ?: 0L
                val myDeleted = (mine["deleted"] as Long? ?: 0L) == 1L
                if (at < myAt || (at == myAt && (myDeleted || !deleted))) continue
            }
            val days = b.optJSONArray("days")?.let { a -> (0 until a.length()).map { a.getInt(it) } }.orEmpty().joinToString("")
            val args = arrayOf<Any?>(
                b.optString("name", "Block"), (b.optJSONArray("apps") ?: JSONArray()).toString(),
                (b.optJSONObject("labels") ?: JSONObject()).toString(), (b.optJSONArray("sites") ?: JSONArray()).toString(),
                days, b.optString("start", "00:00"), b.optString("end", "00:00"), until,
                b.optString("origin"), at, if (deleted) 1 else 0,
            )
            if (mine == null) Db.exec(
                "INSERT INTO blocks (name, apps, labels, sites, days, start_time, end_time, until_at, origin, updated_at, deleted, uid) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                *args, uid)
            else Db.exec(
                "UPDATE blocks SET name=?, apps=?, labels=?, sites=?, days=?, start_time=?, end_time=?, until_at=?, origin=?, updated_at=?, deleted=? WHERE uid=?",
                *args, uid)
            changed = true
        }
        if (changed) { Log.i(TAG, "merged changes"); Blocks.changed(local = false) }
    }

    private fun body() = JSONObject().put("device", device()).put("name", deviceName()).put("blocks", export()).toString()

    // --- signing: HMAC-SHA256(key, time \n method \n path \n body) ---

    private fun sign(time: String, method: String, path: String, body: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key().toByteArray(), "HmacSHA256"))
        return mac.doFinal("$time\n$method\n$path\n$body".toByteArray()).joinToString("") { "%02x".format(it) }
    }

    private fun verified(time: String?, sig: String?, method: String, path: String, body: String): Boolean {
        val t = time?.toLongOrNull() ?: return false
        if (kotlin.math.abs(System.currentTimeMillis() - t) > 5 * 60_000) return false
        val want = sign(time, method, path, body)
        return sig != null && java.security.MessageDigest.isEqual(want.toByteArray(), sig.toByteArray())
    }

    // --- client ---

    private fun syncAll() {
        for (p in peers.values.toList()) runCatching { exchange(p) }.onFailure {
            p.error = it.message ?: "Couldn’t reach it"
            Log.w(TAG, "sync with ${p.name}: ${it.message}")
        }
    }

    private fun exchange(p: Peer) {
        val path = "/sync/v1/exchange"
        val body = body()
        val time = System.currentTimeMillis().toString()
        val host = if (':' in p.host) "[${p.host.substringBefore('%')}]" else p.host
        val c = URL("http://$host:${p.port}$path").openConnection() as HttpURLConnection
        c.requestMethod = "POST"
        c.connectTimeout = 4000
        c.readTimeout = 8000
        c.doOutput = true
        c.setRequestProperty("Content-Type", "application/json")
        c.setRequestProperty("X-Life-Time", time)
        c.setRequestProperty("X-Life-Sig", sign(time, "POST", path, body))
        c.outputStream.use { it.write(body.toByteArray()) }
        try {
            when (c.responseCode) {
                200 -> {}
                401 -> throw java.io.IOException("Different sync key")
                else -> throw java.io.IOException("HTTP ${c.responseCode}")
            }
            val reply = JSONObject(c.inputStream.bufferedReader().readText())
            merge(reply.optJSONArray("blocks") ?: JSONArray())
            p.name = reply.optString("name", p.name)
            p.lastSync = System.currentTimeMillis()
            p.error = null
        } finally {
            c.disconnect()
        }
    }

    // --- server: one tiny HTTP endpoint, POST /sync/v1/exchange ---

    private fun serve() {
        val server = runCatching { ServerSocket(PORT) }.getOrElse { Log.e(TAG, "can't listen on $PORT", it); return }
        while (true) {
            val s = runCatching { server.accept() }.getOrNull() ?: continue
            Thread { runCatching { handle(s) }.onFailure { Log.w(TAG, "request", it) }; runCatching { s.close() } }.start()
        }
    }

    private fun handle(s: Socket) {
        s.soTimeout = 10_000
        val input = BufferedInputStream(s.getInputStream())
        val request = readLine(input) ?: return
        val (method, path) = request.split(" ").let { (it.getOrNull(0) ?: "") to (it.getOrNull(1) ?: "") }
        val headers = mutableMapOf<String, String>()
        while (true) {
            val line = readLine(input) ?: return
            if (line.isEmpty()) break
            val i = line.indexOf(':')
            if (i > 0) headers[line.substring(0, i).trim().lowercase()] = line.substring(i + 1).trim()
        }
        val length = headers["content-length"]?.toIntOrNull() ?: 0
        if (length > 5_000_000) return reply(s, 413, "{}")
        val buf = ByteArray(length)
        var read = 0
        while (read < length) { val n = input.read(buf, read, length - read); if (n < 0) break; read += n }
        val body = String(buf, 0, read)

        if (method != "POST" || path != "/sync/v1/exchange") return reply(s, 404, """{"error":"not found"}""")
        if (!verified(headers["x-life-time"], headers["x-life-sig"], method, path, body)) return reply(s, 401, """{"error":"bad signature"}""")
        val req = JSONObject(body)
        merge(req.optJSONArray("blocks") ?: JSONArray())
        // Whoever called us is a peer too (in case mDNS hasn't found them).
        val dev = req.optString("device")
        if (dev.isNotEmpty() && dev != device()) {
            val p = peers.getOrPut(dev) { Peer(dev, req.optString("name", "?"), s.inetAddress.hostAddress ?: "", PORT) }
            p.name = req.optString("name", p.name)
            p.lastSync = System.currentTimeMillis()
            p.error = null
        }
        reply(s, 200, body())
    }

    private fun readLine(input: InputStream): String? {
        val out = ByteArrayOutputStream()
        while (true) {
            val b = input.read()
            if (b < 0) return if (out.size() > 0) out.toString() else null
            if (b == '\n'.code) return out.toString().trimEnd('\r')
            out.write(b)
            if (out.size() > 8192) return null
        }
    }

    private fun reply(s: Socket, status: Int, body: String) {
        val bytes = body.toByteArray()
        val head = "HTTP/1.1 $status OK\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n"
        s.getOutputStream().apply { write(head.toByteArray()); write(bytes); flush() }
    }

    // --- mDNS ---

    private fun advertise() {
        val m = ctx.getSystemService(NsdManager::class.java).also { nsd = it }
        val info = NsdServiceInfo().apply {
            serviceName = "life-${device().take(8)}"
            serviceType = SERVICE
            port = PORT
            setAttribute("device", device())
            setAttribute("name", deviceName())
        }
        m.registerService(info, NsdManager.PROTOCOL_DNS_SD, object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(i: NsdServiceInfo) { Log.i(TAG, "advertising as ${i.serviceName}") }
            override fun onRegistrationFailed(i: NsdServiceInfo, e: Int) { Log.w(TAG, "advertise failed $e") }
            override fun onServiceUnregistered(i: NsdServiceInfo) {}
            override fun onUnregistrationFailed(i: NsdServiceInfo, e: Int) {}
        })
    }

    private val resolving = ArrayDeque<NsdServiceInfo>()
    private var busy = false

    private fun discover() {
        val m = nsd ?: return
        m.discoverServices(SERVICE, NsdManager.PROTOCOL_DNS_SD, object : NsdManager.DiscoveryListener {
            override fun onServiceFound(i: NsdServiceInfo) {
                if (i.serviceName == "life-${device().take(8)}") return
                handler.post { resolving.addLast(i); resolveNext() }
            }
            override fun onServiceLost(i: NsdServiceInfo) {}
            override fun onDiscoveryStarted(t: String) {}
            override fun onDiscoveryStopped(t: String) {}
            override fun onStartDiscoveryFailed(t: String, e: Int) { Log.w(TAG, "discovery failed $e") }
            override fun onStopDiscoveryFailed(t: String, e: Int) {}
        })
    }

    // NsdManager resolves one service at a time.
    @Suppress("DEPRECATION")
    private fun resolveNext() {
        if (busy) return
        val i = resolving.removeFirstOrNull() ?: return
        busy = true
        nsd?.resolveService(i, object : NsdManager.ResolveListener {
            override fun onServiceResolved(r: NsdServiceInfo) {
                handler.post {
                    busy = false
                    val dev = r.attributes["device"]?.let { String(it) }
                    val host: InetAddress? = r.host
                    if (dev != null && dev != device() && host != null) {
                        val name = r.attributes["name"]?.let { String(it) } ?: r.serviceName
                        val p = peers.getOrPut(dev) { Peer(dev, name, host.hostAddress ?: "", r.port) }
                        p.host = host.hostAddress ?: p.host
                        p.port = r.port
                        p.name = name
                        Log.i(TAG, "found $name at ${p.host}:${p.port}")
                        soon()
                    }
                    resolveNext()
                }
            }
            override fun onResolveFailed(r: NsdServiceInfo, e: Int) { handler.post { busy = false; resolveNext() } }
        })
    }
}
