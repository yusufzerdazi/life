package com.zerdazi.life

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.animation.AlphaAnimation
import android.view.animation.ScaleAnimation
import android.view.animation.AnimationSet
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.Space
import android.widget.TextView

// "Take a break?" — flashed up by LifeService after BREAK_AFTER_MIN on one app
// or site. Take a break goes home; Keep going returns to it, and it asks again
// after another BREAK_AFTER_MIN.
class BreakActivity : Activity() {
    private lateinit var detail: TextView
    private lateinit var logo: ImageView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val c = this
        logo = ImageView(c).apply { setImageResource(R.drawable.logo) }
        detail = Ui.text(c, 17f, Palette.DIM).apply {
            setLineSpacing(0f, 1.25f)
            gravity = Gravity.CENTER
        }
        val pad = Ui.dp(c, 32)
        setContentView(LinearLayout(c).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setBackgroundColor(Palette.NIGHT)
            Ui.insetPadding(this, pad, Ui.dp(c, 64), pad, Ui.dp(c, 24))
            addView(Space(c), LinearLayout.LayoutParams(-1, 0, 1f))
            addView(logo, LinearLayout.LayoutParams(Ui.dp(c, 120), Ui.dp(c, 120)))
            addView(Ui.title(c, "Take a break?").apply {
                gravity = Gravity.CENTER
                setPadding(0, Ui.dp(c, 32), 0, Ui.dp(c, 12))
                textSize = 44f
            })
            addView(detail)
            addView(Space(c), LinearLayout.LayoutParams(-1, 0, 1f))
            addView(Ui.link(c, "Keep going") { finishAndRemoveTask() }, LinearLayout.LayoutParams(-1, -2))
            addView(Ui.pill(c, "Take a break") { Ui.goHome(this@BreakActivity) }, LinearLayout.LayoutParams(-1, -2))
        })
        if (Build.VERSION.SDK_INT >= 33) onBackInvokedDispatcher.registerOnBackInvokedCallback(0) { finishAndRemoveTask() }
        show(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        show(intent)
    }

    private fun show(i: Intent) {
        val minutes = i.getIntExtra(EXTRA_MINUTES, Config.BREAK_AFTER_MIN)
        detail.text = "You’ve been on ${i.getStringExtra(EXTRA_WHAT) ?: "this"} for $minutes minutes."
        // The flash: the logo pops in.
        logo.startAnimation(AnimationSet(true).apply {
            addAnimation(AlphaAnimation(0f, 1f))
            addAnimation(ScaleAnimation(0.6f, 1f, 0.6f, 1f, ScaleAnimation.RELATIVE_TO_SELF, 0.5f, ScaleAnimation.RELATIVE_TO_SELF, 0.5f))
            duration = 450
        })
    }

    @Deprecated("Pre-Android 13 back handling")
    override fun onBackPressed() = finishAndRemoveTask()

    companion object {
        const val EXTRA_WHAT = "what"
        const val EXTRA_MINUTES = "minutes"
    }
}
