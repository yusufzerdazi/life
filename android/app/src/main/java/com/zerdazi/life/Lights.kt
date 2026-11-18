package com.zerdazi.life

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Handler
import android.os.HandlerThread
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import com.zerdazi.life.server.Db
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.LocalTime
import java.util.UUID

// Bedtime lights: between BEDTIME_LIGHTS_FROM and BEDTIME_LIGHTS_UNTIL, until
// the phone is in sleep mode (charging on the wall), the Hue lights and the
// Govee strip pulse red, slowly. Once you're in sleep mode, or the window ends, Hue goes
// back to how it was and the strip turns off.
//
// Everything runs on one background thread; LifeService calls check() on its
// tick, and ChargingWatcher calls it on entering sleep mode.
object Lights {
    private const val TAG = "LifeLights"
    private val thread = HandlerThread("lights").apply { start() }
    val handler = Handler(thread.looper)
    private val ctx get() = LifeApp.ctx

    @Volatile private var alerting = false
    private var testUntil = 0L
    private var wake: PowerManager.WakeLock? = null

    // One slow breath: dim → bright → dim over PULSE_MS. Both kinds of light
    // follow the same clock (elapsedRealtime), so they breathe together: dim
    // at the start of each pulse, brightest halfway.
    const val PULSE_MS = 4000L

    private val loop = object : Runnable {
        override fun run() {
            if (!wanted()) return stop()
            val half = PULSE_MS / 2
            val at = SystemClock.elapsedRealtime() % PULSE_MS
            val left = half - at % half // until the next brightest/dimmest point
            Hue.fade(at < half, left) // rising in the first half, falling in the second
            Govee.flashAll()
            handler.postDelayed(this, left + 30)
        }
    }

    fun check() = handler.post { if (wanted() && !alerting) start() else if (!wanted() && alerting) stop() }

    // Flash for 20 seconds now, from the app.
    fun test() = handler.post {
        testUntil = SystemClock.elapsedRealtime() + 20_000
        if (!alerting) start()
        handler.postDelayed({ check() }, 20_500)
    }

    fun bedtime(now: LocalTime = LocalTime.now()) =
        !now.isBefore(LocalTime.parse(Config.BEDTIME_LIGHTS_FROM)) && now.isBefore(LocalTime.parse(Config.BEDTIME_LIGHTS_UNTIL))

    private fun wanted(): Boolean {
        if (!Hue.paired() && !Govee.any()) return false
        if (SystemClock.elapsedRealtime() < testUntil) return true
        return bedtime() && !ChargingWatcher.onWall(ctx)
    }

    private fun start() {
        Log.i(TAG, "flashing")
        alerting = true
        wake = ctx.getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "life:bedtime-lights")
            .apply { acquire(70 * 60_000L) }
        Hue.save()
        handler.removeCallbacks(loop)
        loop.run()
    }

    private fun stop() {
        if (!alerting) return
        Log.i(TAG, "back to normal")
        alerting = false
        handler.removeCallbacks(loop)
        Hue.restore()
        Govee.offAll()
        wake?.let { if (it.isHeld) it.release() }
        wake = null
    }

    fun status(): JSONObject = JSONObject()
        .put("from", Config.BEDTIME_LIGHTS_FROM).put("until", Config.BEDTIME_LIGHTS_UNTIL)
        .put("alerting", alerting)
        .put("hue", Hue.status())
        .put("govee", Govee.status())

    // --- Philips Hue: the bridge's local (v1) API over the home network ---
    object Hue {
        private const val RED_XY = "[0.675,0.322]"
        @Volatile private var error: String? = null
        private var saved: JSONObject? = null

        private fun ip() = Db.getMeta("hue_ip")
        private fun user() = Db.getMeta("hue_user")
        fun paired() = ip() != null && user() != null

        fun status(): JSONObject = JSONObject().put("paired", paired()).put("ip", ip() ?: JSONObject.NULL)
            .put("error", error ?: JSONObject.NULL)

        // Find the bridge and ask it for a key. Pressing the bridge's round
        // button first is what lets this through (for 30 seconds).
        fun pair(): JSONObject {
            val ip = ip() ?: discover() ?: return JSONObject().put("error", "Couldn’t find a Hue bridge on this network")
            Db.setMeta("hue_ip", ip)
            val reply = runCatching {
                JSONArray(http("POST", "http://$ip/api", """{"devicetype":"life#phone"}""")).getJSONObject(0)
            }.getOrElse { return JSONObject().put("error", "Couldn’t reach the Hue bridge at $ip") }
            reply.optJSONObject("success")?.optString("username")?.let {
                Db.setMeta("hue_user", it)
                error = null
                return JSONObject().put("ok", true)
            }
            if (reply.optJSONObject("error")?.optInt("type") == 101)
                return JSONObject().put("error", "Press the button on the Hue bridge, then tap Pair again")
            return JSONObject().put("error", reply.optJSONObject("error")?.optString("description") ?: "Pairing failed")
        }

        fun forget() {
            Db.deleteMeta("hue_ip")
            Db.deleteMeta("hue_user")
        }

        private fun discover(): String? = runCatching {
            JSONArray(http("GET", "https://discovery.meethue.com/", null)).optJSONObject(0)?.optString("internalipaddress")
        }.getOrNull()?.takeIf { it.isNotEmpty() }

        private fun api(method: String, path: String, body: String? = null): String? {
            val ip = ip() ?: return null
            val user = user() ?: return null
            return runCatching { http(method, "http://$ip/api/$user$path", body) }
                .onSuccess { error = null }
                .onFailure { error = "Hue bridge unreachable"; Log.w(TAG, "hue $path", it) }
                .getOrNull()
        }

        // Remember each light's state, to put back afterwards.
        fun save() {
            saved = api("GET", "/lights")?.let { runCatching { JSONObject(it) }.getOrNull() }
        }

        // Fade red up or down, arriving in `ms` (transitiontime is in 100 ms;
        // the bridge takes ~100 ms to act, so start the fade that much shorter).
        fun fade(up: Boolean, ms: Long) {
            val t = ((ms - 100) / 100).coerceAtLeast(0)
            api("PUT", "/groups/0/action", """{"on":true,"bri":${if (up) 254 else 20},"xy":$RED_XY,"transitiontime":$t}""")
        }

        fun restore() {
            api("PUT", "/groups/0/action", """{"alert":"none"}""") ?: return
            val lights = saved ?: return
            saved = null
            for (id in lights.keys()) {
                val s = lights.optJSONObject(id)?.optJSONObject("state") ?: continue
                // Colour can only be set while a light is on: set it, then turn
                // it off again if it was off.
                val put = JSONObject().put("on", true).put("transitiontime", 4)
                if (s.has("bri")) put.put("bri", s.getInt("bri"))
                when (s.optString("colormode")) {
                    "xy" -> put.put("xy", s.getJSONArray("xy"))
                    "ct" -> put.put("ct", s.getInt("ct"))
                    "hs" -> put.put("hue", s.getInt("hue")).put("sat", s.getInt("sat"))
                }
                api("PUT", "/lights/$id/state", put.toString())
                if (!s.optBoolean("on")) api("PUT", "/lights/$id/state", """{"on":false}""")
            }
        }
    }

    // --- Govee lights over Bluetooth LE (any number of them) ---
    // Reverse-engineered protocol (github.com/BeauJBurroughs/Govee-H6127-Reverse-Engineering,
    // egold555/Govee-H6113-Reverse-Engineering): 20-byte packets written to one
    // characteristic, the last byte an XOR of the rest. 0x33 0x01 = power,
    // 0x33 0x04 = brightness, 0x33 0x05 = colour; 0xAA 0x01 keeps the link alive.
    // Replies come back as notifications on the characteristic next to it.
    @SuppressLint("MissingPermission") // checked in hasPermission()
    object Govee {
        private val WRITE = UUID.fromString("00010203-0405-0607-0809-0a0b0c0d2b11")
        private val NOTIFY = UUID.fromString("00010203-0405-0607-0809-0a0b0c0d2b10")
        private val CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
        private val NAME = Regex("^(ihoment_|Govee_|GBK_|Minger_)", RegexOption.IGNORE_CASE)
        val PERMISSIONS = arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)

        @Volatile private var scanning = false
        private val found = linkedMapOf<String, String>()
        private val lights = mutableMapOf<String, Light>() // by address, on the lights thread

        // Chosen lights: meta "govee" = {"address": "name", …}. Names still
        // waiting to be heard on a scan: meta "govee_wanted" = ["name", …].
        private fun chosen(): JSONObject {
            Db.getMeta("govee")?.let { return runCatching { JSONObject(it) }.getOrDefault(JSONObject()) }
            // Before there could be several.
            val o = JSONObject()
            Db.getMeta("govee_address")?.let { o.put(it, Db.getMeta("govee_name") ?: it) }
            return o
        }
        private fun save(o: JSONObject) {
            Db.setMeta("govee", o.toString())
            Db.deleteMeta("govee_address")
            Db.deleteMeta("govee_name")
        }
        private fun wantedNames(): MutableSet<String> =
            Db.getMeta("govee_wanted")?.let { w -> JSONArray(w).let { a -> (0 until a.length()).map { a.getString(it) } } }?.toMutableSet() ?: mutableSetOf()

        fun any() = chosen().length() > 0

        fun hasPermission() = PERMISSIONS.all { ctx.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

        fun status(): JSONObject {
            val c = chosen()
            return JSONObject()
                .put("lights", JSONArray(c.keys().asSequence().map { a ->
                    val l = lights[a]
                    JSONObject().put("address", a).put("name", c.getString(a))
                        .put("connected", l?.ready == true).put("error", l?.error ?: JSONObject.NULL)
                }.toList()))
                .put("scanning", scanning)
                .put("permission", hasPermission())
                .put("found", JSONArray(synchronized(found) {
                    found.filterKeys { !c.has(it) }.map { JSONObject().put("address", it.key).put("name", it.value) }
                }))
        }

        fun add(address: String) = handler.post {
            val name = synchronized(found) { found[address] } ?: address
            save(chosen().put(address, name))
            Log.i(TAG, "using $name")
            if (alerting) lights.getOrPut(address) { Light(address, name) }.flash()
        }

        fun remove(address: String) = handler.post {
            save(chosen().apply { remove(address) })
            lights.remove(address)?.off()
        }

        fun removeByName(name: String) = handler.post {
            val c = chosen()
            c.keys().asSequence().toList().filter { c.getString(it).equals(name, true) }.forEach { remove(it) }
            Db.setMeta("govee_wanted", JSONArray(wantedNames().filterNot { it.equals(name, true) }).toString())
        }

        // Add the light with this Bluetooth name (e.g. ihoment_H6159_2ABB)
        // when a scan hears it. From adb, see MainActivity.
        fun prefer(name: String) = handler.post {
            Db.setMeta("govee_wanted", JSONArray(wantedNames() + name).toString())
            Log.i(TAG, "looking for $name")
            scan()
        }

        // Look for Govee lights for 10 seconds. With none chosen yet, the
        // first one heard is added.
        fun scan(): JSONObject {
            if (!hasPermission()) {
                ctx.startActivity(Intent(ctx, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra(MainActivity.EXTRA_ASK_BLUETOOTH, true))
                return JSONObject().put("asking", true)
            }
            val scanner = ctx.getSystemService(BluetoothManager::class.java).adapter?.takeIf { it.isEnabled }?.bluetoothLeScanner
                ?: return JSONObject().put("error", "Bluetooth is off")
            if (scanning) return JSONObject().put("ok", true)
            synchronized(found) { found.clear() }
            val cb = object : ScanCallback() {
                override fun onScanResult(type: Int, r: ScanResult) {
                    val name = r.scanRecord?.deviceName ?: r.device.name ?: return
                    if (!NAME.containsMatchIn(name)) return
                    val addr = r.device.address
                    val isNew = synchronized(found) { found.put(addr, name) == null }
                    if (!isNew) return
                    handler.post {
                        val wanted = wantedNames()
                        val match = wanted.firstOrNull { it.equals(name, true) }
                        if (match != null) {
                            Db.setMeta("govee_wanted", JSONArray(wanted - match).toString())
                            add(addr)
                        } else if (!any() && wanted.isEmpty()) add(addr)
                    }
                }
            }
            scanning = true
            scanner.startScan(cb)
            handler.postDelayed({
                runCatching { scanner.stopScan(cb) }
                scanning = false
            }, 10_000)
            return JSONObject().put("ok", true)
        }

        fun flashAll() {
            val c = chosen()
            for (a in c.keys()) lights.getOrPut(a) { Light(a, c.getString(a)) }.flash()
        }

        // Off at the end: it's bedtime either way.
        fun offAll() = lights.values.forEach { it.off() }

        private fun packet(vararg b: Int) = ByteArray(20).also { p ->
            b.forEachIndexed { i, v -> p[i] = v.toByte() }
            p[19] = p.take(19).fold(0) { x, v -> x xor v.toInt() }.toByte()
        }

        private fun hex(b: ByteArray) = b.joinToString(" ") { "%02x".format(it) }

        // One Govee light and its Bluetooth link. All on the lights thread.
        private class Light(val address: String, val name: String) {
            private val model = Regex("H\\d{3}[0-9A-Z]").find(name)?.value ?: ""
            private var gatt: BluetoothGatt? = null
            private var char: BluetoothGattCharacteristic? = null
            private var flashing = false
            private var beats = 0
            private var attempts = 0
            private var debug = 0
            private val queue = ArrayDeque<ByteArray>()
            private var writing = false
            var error: String? = null
            val ready get() = char != null

            // The colour command differs by model (sub-commands from
            // homebridge-govee's ble-protocol.js): 0x02 on the first strips
            // (H6127, H6113…), 0x15 0x01 "extended" on the floor lamps and
            // RGBIC strips (H6072, H6076, H6053, H6199…), 0x0D on most others.
            fun red(): ByteArray = when {
                // RGB, then "white off" and a white colour, as the Govee app sends it.
                model in setOf("H6127", "H6113", "H6107", "H6116", "H6125", "H6138", "H6139", "H6159", "H6160", "H6163", "H6181", "H6182") ->
                    packet(0x33, 0x05, 0x02, 0xFF, 0x00, 0x00, 0x00, 0xFF, 0xAE, 0x54)
                model.startsWith("H60") || model in setOf("H6199", "H6195", "H6143", "H6144") ->
                    packet(0x33, 0x05, 0x15, 0x01, 0xFF, 0x00, 0x00, 0, 0, 0, 0, 0, 0xFF, 0x7F)
                else -> packet(0x33, 0x05, 0x0D, 0xFF, 0x00, 0x00)
            }

            private val callback = object : BluetoothGattCallback() {
                override fun onConnectionStateChange(g: BluetoothGatt, status: Int, state: Int) {
                    handler.post {
                        if (g != gatt) return@post
                        if (state == BluetoothProfile.STATE_CONNECTED) {
                            attempts = 0
                            g.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
                            g.discoverServices()
                            return@post
                        }
                        // Links to these lights often fail while being set up
                        // (HCI 0x3E): try again straight away, a few times.
                        Log.i(TAG, "$name: link dropped ($status), attempt $attempts")
                        close()
                        if (flashing && attempts < 6) handler.postDelayed({ if (flashing && gatt == null) connect() }, 600)
                        else error = "Couldn’t connect"
                    }
                }

                override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
                    handler.post {
                        if (g != gatt) return@post
                        char = g.services.firstNotNullOfOrNull { it.getCharacteristic(WRITE) }
                        if (char == null) { error = "Not a Govee light this app can drive"; close(); return@post }
                        error = null
                        debug = 12
                        // Listen for replies (logged, to see what the light makes of our packets).
                        g.services.firstNotNullOfOrNull { it.getCharacteristic(NOTIFY) }?.let { n ->
                            g.setCharacteristicNotification(n, true)
                            n.getDescriptor(CCCD)?.let { d -> g.writeDescriptor(d, android.bluetooth.BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) }
                            writing = true // wait for the descriptor write before the first packet
                        }
                        if (flashing) {
                            send(packet(0xAA, 0x01)) // asks for the power state
                            send(packet(0x33, 0x01, 0x01)) // on
                            send(red())
                            handler.removeCallbacks(blink)
                            handler.postDelayed(blink, 300)
                        } else {
                            send(packet(0x33, 0x01, 0x00)) // off
                            handler.postDelayed({ if (!flashing) close() }, 1500)
                        }
                    }
                }

                override fun onDescriptorWrite(g: BluetoothGatt, d: android.bluetooth.BluetoothGattDescriptor, status: Int) {
                    handler.post { writing = false; next() }
                }

                override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray) {
                    if (debug > 0) Log.i(TAG, "$name: reply ${hex(value)}")
                }

                override fun onCharacteristicWrite(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
                    if (status != BluetoothGatt.GATT_SUCCESS) Log.i(TAG, "$name: write failed ($status)")
                    handler.post { writing = false; next() }
                }
            }

            // Brightness follows a sine wave, one breath per PULSE_MS, in
            // small steps; keep-alive (and red again) every couple of seconds.
            private val blink = object : Runnable {
                override fun run() {
                    if (!flashing || char == null) return
                    val phase = (SystemClock.elapsedRealtime() % PULSE_MS).toDouble() / PULSE_MS
                    // 0–100 on newer models, 0–255 on older ones: 4–100 works on both.
                    val level = 4 + (96 * (1 - kotlin.math.cos(2 * Math.PI * phase)) / 2).toInt()
                    send(packet(0x33, 0x04, level))
                    if (++beats % 10 == 0) { send(packet(0xAA, 0x01)); send(red()) }
                    handler.postDelayed(this, 200)
                }
            }

            private fun send(p: ByteArray) {
                if (queue.size < 8) queue.addLast(p)
                next()
            }

            private fun next() {
                val g = gatt ?: return
                val c = char ?: return
                if (writing) return
                val p = queue.removeFirstOrNull() ?: return
                val r = g.writeCharacteristic(c, p, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT)
                if (debug > 0) { debug--; Log.i(TAG, "$name: send ${hex(p)} → $r") }
                writing = r == BluetoothGatt.GATT_SUCCESS
                if (!writing) handler.postDelayed(::next, 200)
            }

            private fun connect(): Boolean {
                if (!hasPermission()) { error = "Bluetooth permission needed"; return false }
                val adapter = ctx.getSystemService(BluetoothManager::class.java).adapter?.takeIf { it.isEnabled }
                    ?: run { error = "Bluetooth is off"; return false }
                if (gatt == null) {
                    // Alternate a direct connect with a background ("auto") one,
                    // which these lights often take better.
                    val auto = attempts++ % 2 == 1
                    val device = adapter.getRemoteLeDevice(address, BluetoothDevice.ADDRESS_TYPE_PUBLIC)
                    gatt = device.connectGatt(ctx, auto, callback, BluetoothDevice.TRANSPORT_LE)
                }
                return true
            }

            fun flash() {
                if (!flashing) attempts = 0
                flashing = true
                if (gatt == null) { if (attempts >= 6) attempts = 0; connect() }
            }

            fun off() {
                flashing = false
                handler.removeCallbacks(blink)
                queue.clear()
                if (char != null) {
                    send(packet(0x33, 0x01, 0x00))
                    handler.postDelayed({ if (!flashing) close() }, 1500)
                } else {
                    close()
                    // Not connected (e.g. dropped mid-alert): connect just to turn it off.
                    if (connect()) handler.postDelayed({ if (!flashing) close() }, 15_000)
                }
            }

            private fun close() {
                handler.removeCallbacks(blink)
                runCatching { gatt?.close() }
                gatt = null
                char = null
                writing = false
                queue.clear()
            }
        }
    }

    private fun http(method: String, url: String, body: String?): String {
        val c = URL(url).openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = 4000
        c.readTimeout = 6000
        if (body != null) {
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            c.outputStream.use { it.write(body.toByteArray()) }
        }
        try {
            if (c.responseCode !in 200..299) throw java.io.IOException("HTTP ${c.responseCode}")
            return c.inputStream.bufferedReader().readText()
        } finally {
            c.disconnect()
        }
    }
}
