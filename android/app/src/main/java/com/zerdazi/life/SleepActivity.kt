package com.zerdazi.life

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Bundle
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.WebView

// Sleep mode: the /bed prompt ("Charging for the night?"), which then hands off
// to the /dashboard wall kiosk. Shows over the lock screen, keeps the screen on,
// and closes itself when the phone comes off charge.
class SleepActivity : Activity() {
    private lateinit var web: WebView

    private val unplugged = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) = finishAndRemoveTask()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        web = LifeWeb.create(this)
        setContentView(web)
        LifeWeb.handleBack(this, web)
        registerReceiver(unplugged, IntentFilter(Intent.ACTION_POWER_DISCONNECTED))
        web.loadUrl(LifeWeb.url("/bed"))
    }

    // Plugged in again while already showing: start over at the prompt.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        web.loadUrl(LifeWeb.url("/bed"))
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) window.insetsController?.apply {
            hide(WindowInsets.Type.systemBars())
            systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    @Deprecated("Pre-Android 13 back handling")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        unregisterReceiver(unplugged)
        web.destroy()
        super.onDestroy()
    }

    companion object {
        fun open(ctx: Context) = ctx.startActivity(
            Intent(ctx, SleepActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
    }
}
