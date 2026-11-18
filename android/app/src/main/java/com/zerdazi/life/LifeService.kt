package com.zerdazi.life

import android.accessibilityservice.AccessibilityService
import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Toast
import com.zerdazi.life.server.Integrations
import java.time.LocalTime

// Always-on service (enabled under Settings → Accessibility). It:
//  - kicks you out of blocked apps / sites (named blocks, category lists,
//    and everything non-essential once the daily screen time is used up)
//  - measures screen time per app and site, and suggests a break after
//    BREAK_AFTER_MIN on one of them
//  - turns the screen grayscale in the evening
//  - flashes the lights red at bedtime until sleep mode (Lights)
//  - hosts ChargingWatcher (charging while upright → sleep mode)
//  - polls Google Health + Waking Up
class LifeService : AccessibilityService() {
    private val handler = Handler(Looper.getMainLooper())
    private var charging: ChargingWatcher? = null
    private var lastBlockAt = 0L
    private val pending = mutableMapOf<String, Runnable>()
    private val firstEventAt = mutableMapOf<String, Long>()
    private val prefs by lazy { getSharedPreferences("life", Context.MODE_PRIVATE) }

    // Screen time: what's in front of you, and since when.
    private var fgPkg: String? = null
    private var fgSite: String? = null
    private var fgSince = 0L

    // Breaks: continuous seconds per app/site key, when it was last on screen,
    // and the seconds at which to ask next.
    private class Stretch(var seconds: Long = 0, var lastSeen: Long = 0, var askAt: Long = Config.BREAK_AFTER_MIN * 60L)
    private val stretches = mutableMapOf<String, Stretch>()

    // Windows open (and passes end) while you're already inside an app, so
    // re-check periodically; this also banks screen time.
    private val tick = object : Runnable {
        override fun run() {
            flush()
            recheck()
            grayscale()
            Lights.check()
            handler.postDelayed(this, 15_000)
        }
    }

    private val screen = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            when (i.action) {
                Intent.ACTION_SCREEN_OFF -> {
                    flush()
                    fgPkg = null
                    fgSite = null
                }
                Intent.ACTION_USER_PRESENT -> {
                    fgSince = SystemClock.elapsedRealtime()
                    rootInActiveWindow?.packageName?.toString()?.let(::setForeground)
                }
            }
        }
    }

    // Pull Google Health + Waking Up in the background (the server's poller).
    private val poll = object : Runnable {
        override fun run() {
            Thread { Integrations.syncAll() }.start()
            handler.postDelayed(this, Config.POLL_MINUTES * 60_000)
        }
    }

    override fun onServiceConnected() {
        charging = ChargingWatcher(this).also { it.start() }
        registerReceiver(screen, IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_USER_PRESENT)
        })
        // The category lists take a moment to read; check the screen once they're in.
        Thread { Categories.load(); handler.post { recheck() } }.start()
        grayscale()
        handler.postDelayed(tick, 15_000)
        handler.postDelayed(poll, 5_000)
    }

    override fun onAccessibilityEvent(e: AccessibilityEvent) {
        val pkg = e.packageName?.toString() ?: return
        if (e.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) setForeground(pkg)
        if (pkg == packageName) return
        // Content-change events come in bursts while a screen or page loads:
        // check once things settle (each new event pushes the check back).
        if (pkg in GUARDED) return settle(pkg, 250) { checkTamper(pkg) }
        if (e.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) checkApp(pkg)
        if (pkg in URL_BARS) settle(pkg, 300) { checkBrowser(pkg) }
    }

    private fun recheck() {
        val pkg = rootInActiveWindow?.packageName?.toString() ?: return
        if (pkg == packageName || pkg in GUARDED) return
        checkApp(pkg)
        if (pkg in URL_BARS) checkBrowser(pkg)
    }

    // --- screen time ---

    private fun setForeground(pkg: String) {
        if (Usage.ignored(pkg) || pkg == fgPkg) return
        flush()
        fgPkg = pkg
        fgSite = null
    }

    private fun counting(): Boolean =
        getSystemService(PowerManager::class.java).isInteractive &&
            !getSystemService(KeyguardManager::class.java).isKeyguardLocked

    // Bank the time since the last flush against the current app (and site).
    private fun flush() {
        val now = SystemClock.elapsedRealtime()
        val secs = (now - fgSince) / 1000
        if (fgSince == 0L || secs <= 0) {
            if (fgSince == 0L) fgSince = now
            return
        }
        fgSince += secs * 1000
        val pkg = fgPkg ?: return
        if (!counting()) return
        val s = minOf(secs, 60L) // ticks are 15 s apart; anything longer is a missed screen-off
        val site = fgSite
        val before = Usage.countedSeconds()
        Usage.add("app:$pkg", s)
        if (site != null) Usage.add("site:$site", s)
        warn(before, Usage.countedSeconds())
        if (site != null || !Usage.isExempt(pkg)) stretch(if (site != null) "site:$site" else "app:$pkg", s, now)
    }

    // Time on one app or site in a row. Away for BREAK_RESET_MIN or more and
    // it starts again from zero.
    private fun stretch(key: String, secs: Long, now: Long) {
        val st = stretches.getOrPut(key) { Stretch() }
        if (st.lastSeen != 0L && now - st.lastSeen - secs * 1000 > Config.BREAK_RESET_MIN * 60_000) {
            st.seconds = 0
            st.askAt = Config.BREAK_AFTER_MIN * 60L
        }
        st.seconds += secs
        st.lastSeen = now
        if (st.seconds < st.askAt) return
        st.askAt = st.seconds + Config.BREAK_AFTER_MIN * 60L // "keep going" → ask again later
        val what = Usage.labelOf(key)
        val minutes = (st.seconds / 60).toInt()
        Thread { Usage.log("break", what, "$minutes min") }.start()
        handler.post {
            startActivity(
                Intent(this, BreakActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                    .putExtra(BreakActivity.EXTRA_WHAT, what)
                    .putExtra(BreakActivity.EXTRA_MINUTES, minutes)
            )
        }
    }

    // --- grayscale evenings ---
    // Color correction set to monochrome (what Bedtime mode uses). Only
    // undoes what it did itself, so a grayscale you set by hand stays.
    private fun grayscale() {
        val t = LocalTime.now()
        val want = t >= LocalTime.parse(Config.GRAYSCALE_FROM) || t < LocalTime.parse(com.zerdazi.life.server.DAY_START)
        val ours = prefs.getBoolean("grayscale_on", false)
        if (want == ours) return
        try {
            val cr = contentResolver
            if (want) {
                Settings.Secure.putInt(cr, "accessibility_display_daltonizer", 0) // 0 = monochromacy
                Settings.Secure.putInt(cr, "accessibility_display_daltonizer_enabled", 1)
            } else {
                Settings.Secure.putInt(cr, "accessibility_display_daltonizer_enabled", 0)
            }
            prefs.edit().putBoolean("grayscale_on", want).apply()
        } catch (e: SecurityException) {
            // Needs: adb shell pm grant com.zerdazi.life android.permission.WRITE_SECURE_SETTINGS
            Log.w("LifeService", "grayscale needs WRITE_SECURE_SETTINGS")
        }
    }

    private fun warn(before: Long, after: Long) {
        val day = Usage.lifeDay()
        val limit = Config.SCREEN_TIME_LIMIT_MIN * 60L
        for (m in Config.SCREEN_TIME_WARN_AT_MIN + Config.SCREEN_TIME_LIMIT_MIN) {
            val at = m * 60L
            if (before >= at || after < at) continue
            val k = "warned_${day}_$m"
            if (prefs.getBoolean(k, false)) continue
            prefs.edit().putBoolean(k, true).apply()
            if (m == Config.SCREEN_TIME_LIMIT_MIN) {
                Usage.log("limit", null, "screen time used up")
                handler.post { recheck() }
            } else {
                val left = (limit - at) / 60
                Toast.makeText(this, if (left >= 60) "1 hour of screen time left today" else "$left minutes of screen time left today", Toast.LENGTH_LONG).show()
            }
        }
    }

    // Run `check` once events for `key` pause for `ms`, but never later than
    // a second after the first one (some pages never stop updating).
    private fun settle(key: String, ms: Long, check: () -> Unit) {
        val now = SystemClock.elapsedRealtime()
        val first = firstEventAt.getOrPut(key) { now }
        pending.remove(key)?.let(handler::removeCallbacks)
        val r = Runnable { pending.remove(key); firstEventAt.remove(key); check() }
        pending[key] = r
        handler.postDelayed(r, if (now - first >= 1000) 0 else ms)
    }

    private fun checkApp(pkg: String) {
        if (pkg == packageName || pkg in GUARDED || Usage.ignored(pkg)) return
        when (val v = Policy.forApp(pkg)) {
            is Blocked -> if (claimBlock()) showBlocked(v)
            Allow -> {}
        }
    }

    private fun checkBrowser(pkg: String) {
        val root = rootInActiveWindow ?: return
        val bar = root.findAccessibilityNodeInfosByViewId(URL_BARS.getValue(pkg)).firstOrNull() ?: return
        if (bar.isFocused) return // you're typing — judge it once the page loads
        val url = bar.text?.toString() ?: return
        val host = Schedule.hostOf(url)
        val site = host?.let(Schedule::baseDomain)
        if (pkg == fgPkg && site != fgSite) {
            flush()
            fgSite = site
        }
        when (val v = Policy.forUrl(url)) {
            // Navigate the tab away first — otherwise the browser reopens
            // straight onto the blocked page every time. Then cover it.
            is Blocked -> if (claimBlock()) leavePage(bar) { showBlocked(v) }
            Allow -> {}
        }
    }

    // Uninstall protection. The app is a device admin (so it can't be
    // uninstalled without deactivating it first); this keeps you off every
    // screen that would undo that: life's App info (Uninstall / Force stop —
    // force-stopping also turns this service off), the uninstall dialog, the
    // device-admin deactivate screen, and this service's own on/off page.
    // Matched on English UI text. The way out is adb (see android/README.md).
    private fun checkTamper(pkg: String) {
        val root = rootInActiveWindow ?: return
        if (root.packageName?.toString() != pkg) return
        val texts = mutableListOf<String>()
        collectTexts(root, texts, 0)
        val named = texts.any { it == APP_LABEL }
        val tamper = when {
            texts.any { it == "Use $SERVICE_LABEL" } -> true // the service's on/off page
            !named -> false
            pkg != "com.android.settings" -> true // uninstall dialog for life
            else -> texts.any { it == "Uninstall" || it == "Force stop" || it.startsWith("Deactivate") }
        }
        if (!tamper || !claimBlock()) return
        Thread { Usage.log("tamper", pkg, texts.take(3).joinToString(" / ")) }.start()
        performGlobalAction(GLOBAL_ACTION_BACK) // back out, so Settings doesn't reopen on it
        handler.postDelayed({
            startActivity(
                Intent(this, BlockedActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                    .putExtra(BlockedActivity.EXTRA_WHAT, "Settings")
                    .putExtra(BlockedActivity.EXTRA_MESSAGE, "life can’t be uninstalled, stopped or switched off from the phone.")
            )
        }, 300)
    }

    private fun collectTexts(n: AccessibilityNodeInfo, out: MutableList<String>, depth: Int) {
        if (depth > 40 || out.size > 400) return
        n.text?.toString()?.trim()?.takeIf { it.isNotEmpty() }?.let(out::add)
        for (i in 0 until n.childCount) n.getChild(i)?.let { collectTexts(it, out, depth + 1) }
    }

    // Debounce: one block per burst of events.
    private fun claimBlock(): Boolean {
        val now = SystemClock.elapsedRealtime()
        if (now - lastBlockAt < 1500) return false
        lastBlockAt = now
        return true
    }

    // Tap the address bar, replace it with about:blank and press enter. If the
    // browser doesn't cooperate, fall back to Back.
    private fun leavePage(bar: AccessibilityNodeInfo, then: () -> Unit) {
        bar.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        handler.postDelayed({
            val input = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
            val left = input != null && input.isEditable &&
                input.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply {
                    putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, "about:blank")
                }) &&
                input.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
            if (!left) performGlobalAction(GLOBAL_ACTION_BACK)
            lastBlockAt = SystemClock.elapsedRealtime() // the navigation fires events too
            handler.postDelayed(then, 400)
        }, 300)
    }

    private fun showBlocked(v: Blocked) {
        Thread { Usage.log("blocked", v.what, v.name) }.start()
        // Cover the app; BlockedActivity's exits lead to the home screen.
        // Don't also press HOME — it races and lands on top of it.
        val i = Intent(this, BlockedActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(BlockedActivity.EXTRA_WHAT, v.what)
            .putExtra(BlockedActivity.EXTRA_BLOCK, v.name)
            .putExtra(BlockedActivity.EXTRA_UNTIL, v.until.toString())
        if (v.kind == "screentime") i.putExtra(
            BlockedActivity.EXTRA_MESSAGE,
            "That’s your ${Config.SCREEN_TIME_LIMIT_MIN / 60} hours of screen time for today. Calls, messages, maps and the camera still work. It resets at ${v.until.toLocalTime()}.",
        )
        if (v.kind == "category") i.putExtra(
            BlockedActivity.EXTRA_MESSAGE,
            "It’s on the ${v.category} list, and that’s " +
                (if (v.until == Schedule.FOREVER) "always blocked." else "blocked until ${v.until.toLocalTime()}."),
        )
        startActivity(i)
    }

    override fun onInterrupt() {}

    override fun onDestroy() {
        flush()
        handler.removeCallbacksAndMessages(null)
        runCatching { unregisterReceiver(screen) }
        charging?.stop()
        super.onDestroy()
    }

    companion object {
        // Must match android:label in the manifest (app + this service).
        const val APP_LABEL = "life"
        const val SERVICE_LABEL = "life — blocking & sleep mode"

        val GUARDED = setOf("com.android.settings", "com.google.android.packageinstaller", "com.android.packageinstaller")

        // Browser package → view id of its address bar.
        val URL_BARS = mapOf(
            "com.android.chrome" to "com.android.chrome:id/url_bar",
            "com.chrome.beta" to "com.chrome.beta:id/url_bar",
            "com.brave.browser" to "com.brave.browser:id/url_bar",
            "com.microsoft.emmx" to "com.microsoft.emmx:id/url_bar",
            "com.sec.android.app.sbrowser" to "com.sec.android.app.sbrowser:id/location_bar_edit_text",
            "org.mozilla.firefox" to "org.mozilla.firefox:id/mozac_browser_toolbar_url_view",
            "com.duckduckgo.mobile.android" to "com.duckduckgo.mobile.android:id/omnibarTextInput",
        )
    }
}
