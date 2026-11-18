package com.zerdazi.life

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.widget.TextView

// Small helpers for the native full-screen pages (the blocked screen).
object Ui {
    fun dp(c: Context, v: Int) = (v * c.resources.displayMetrics.density).toInt()

    fun text(c: Context, sp: Float, color: Int) = TextView(c).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
        setTextColor(color)
    }

    fun title(c: Context, s: String) = text(c, 52f, Palette.FG).apply {
        text = s
        typeface = Typeface.create(Typeface.SERIF, Typeface.NORMAL)
        setPadding(0, dp(c, 4), 0, dp(c, 12))
    }

    fun pill(c: Context, s: String, onClick: () -> Unit) = text(c, 17f, Palette.NIGHT).apply {
        text = s
        gravity = Gravity.CENTER
        setPadding(0, dp(c, 16), 0, dp(c, 16))
        background = GradientDrawable().apply {
            setColor(Palette.FG)
            cornerRadius = dp(c, 28).toFloat()
        }
        setOnClickListener { onClick() }
    }

    fun link(c: Context, s: String, onClick: () -> Unit) = text(c, 16f, Palette.DIM).apply {
        text = s
        gravity = Gravity.CENTER
        setPadding(0, dp(c, 14), 0, dp(c, 14))
        setOnClickListener { onClick() }
    }

    // Edge-to-edge: keep content clear of the system bars and the keyboard.
    fun insetPadding(v: View, left: Int, top: Int, right: Int, bottom: Int) =
        v.setOnApplyWindowInsetsListener { view, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
            view.setPadding(left + bars.left, top + bars.top, right + bars.right, bottom + bars.bottom)
            insets
        }

    fun goHome(a: Activity) {
        a.startActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        a.finishAndRemoveTask()
    }
}
