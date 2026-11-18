package com.zerdazi.life

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import com.zerdazi.life.server.LocalApi
import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.sqrt

// Replaces the Tasker charge automation. Plugged in AND upright (on the wall)
// → open a presence session + sleep mode. Unplugged → close the session (the
// local API turns that into the night's "up" time if bed was confirmed).
//
// Power broadcasts can't be received from the manifest since Android 8, so this
// lives inside LifeService, which the system keeps running.
class ChargingWatcher(private val ctx: Context) {
    private val handler = Handler(Looper.getMainLooper())
    private val sensors = ctx.getSystemService(SensorManager::class.java)
    private val prefs = ctx.getSharedPreferences("life", Context.MODE_PRIVATE)
    private var wakeLock: PowerManager.WakeLock? = null
    private var listener: SensorEventListener? = null

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            when (i.action) {
                Intent.ACTION_POWER_CONNECTED -> watchForVertical()
                Intent.ACTION_POWER_DISCONNECTED -> unplugged()
            }
        }
    }

    fun start() {
        ctx.registerReceiver(receiver, IntentFilter().apply {
            addAction(Intent.ACTION_POWER_CONNECTED)
            addAction(Intent.ACTION_POWER_DISCONNECTED)
        })
    }

    fun stop() {
        stopWatching()
        ctx.unregisterReceiver(receiver)
    }

    // Watch the accelerometer for a while after plugging in, so plugging in
    // first and then hanging the phone up still counts. Needs to be upright
    // for a steady stretch, not just mid-swing.
    private fun watchForVertical() {
        stopWatching()
        val accel = sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) ?: return
        wakeLock = ctx.getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "life:charge-orientation")
            .apply { acquire(WATCH_MS + 2000) }

        val gravity = FloatArray(3)
        var primed = false
        var uprightSince = 0L
        listener = object : SensorEventListener {
            override fun onSensorChanged(e: SensorEvent) {
                // Low-pass to isolate gravity from hand movement.
                for (k in 0..2) gravity[k] = if (primed) 0.8f * gravity[k] + 0.2f * e.values[k] else e.values[k]
                primed = true
                val g = sqrt(gravity[0] * gravity[0] + gravity[1] * gravity[1] + gravity[2] * gravity[2])
                if (g < 5f) return
                // Angle between the screen's normal and vertical: 0° = flat, 90° = upright.
                val tilt = Math.toDegrees(acos((abs(gravity[2]) / g).toDouble().coerceAtMost(1.0)))
                val now = SystemClock.elapsedRealtime()
                if (tilt < Config.VERTICAL_MIN_TILT_DEG) {
                    uprightSince = 0L
                } else if (uprightSince == 0L) {
                    uprightSince = now
                } else if (now - uprightSince >= STEADY_MS) {
                    stopWatching()
                    enterSleepMode()
                }
            }
            override fun onAccuracyChanged(s: Sensor, a: Int) {}
        }
        sensors.registerListener(listener, accel, SensorManager.SENSOR_DELAY_UI)
        handler.postDelayed(::stopWatching, WATCH_MS)
    }

    private fun stopWatching() {
        handler.removeCallbacksAndMessages(null)
        listener?.let { sensors.unregisterListener(it) }
        listener = null
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
    }

    private fun enterSleepMode() {
        Log.i(TAG, "charging upright → sleep mode")
        prefs.edit().putBoolean(KEY_ON_WALL, true).apply()
        LocalApi.async("POST", "/api/presence/start")
        SleepActivity.open(ctx)
    }

    private fun unplugged() {
        stopWatching()
        if (prefs.getBoolean(KEY_ON_WALL, false)) {
            Log.i(TAG, "off the wall")
            prefs.edit().putBoolean(KEY_ON_WALL, false).apply()
            LocalApi.async("POST", "/api/presence/end")
        }
    }

    companion object {
        private const val TAG = "LifeCharging"
        private const val KEY_ON_WALL = "onWall"
        private const val WATCH_MS = 20_000L
        private const val STEADY_MS = 1_500L
    }
}
