package com.zerdazi.life

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.widget.LinearLayout
import android.widget.Space
import android.widget.TextView
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter

// Full-screen "not now" shown when LifeService catches a blocked app or site.
// Every way out goes to the home screen, never back into the blocked app.
class BlockedActivity : Activity() {
    private lateinit var what: TextView
    private lateinit var detail: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val c = this
        what = Ui.text(c, 15f, Palette.MUTE)
        detail = Ui.text(c, 17f, Palette.DIM).apply { setLineSpacing(0f, 1.25f) }

        val pad = Ui.dp(c, 32)
        setContentView(LinearLayout(c).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Palette.NIGHT)
            Ui.insetPadding(this, pad, Ui.dp(c, 64), pad, Ui.dp(c, 24))
            addView(what)
            addView(Ui.title(c, "Not now."))
            addView(detail)
            addView(Space(c), LinearLayout.LayoutParams(-1, 0, 1f))
            addView(Ui.pill(c, "Close") { Ui.goHome(this@BlockedActivity) }, LinearLayout.LayoutParams(-1, -2))
        })
        if (Build.VERSION.SDK_INT >= 33) onBackInvokedDispatcher.registerOnBackInvokedCallback(0) { Ui.goHome(this) }
        show(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        show(intent)
    }

    private fun show(i: Intent) {
        val until = i.getStringExtra(EXTRA_UNTIL)?.let { LocalDateTime.parse(it) }
        what.text = i.getStringExtra(EXTRA_WHAT) ?: ""
        val untilText = if (until != null && until != Schedule.FOREVER) " until " + until.format(DateTimeFormatter.ofPattern("HH:mm")) else ""
        detail.text = i.getStringExtra(EXTRA_MESSAGE) ?: "${i.getStringExtra(EXTRA_BLOCK) ?: "This"} is blocked$untilText."
    }

    @Deprecated("Pre-Android 13 back handling")
    override fun onBackPressed() = Ui.goHome(this)

    companion object {
        const val EXTRA_WHAT = "what"
        const val EXTRA_BLOCK = "block"
        const val EXTRA_UNTIL = "until"
        const val EXTRA_MESSAGE = "message"
    }
}
