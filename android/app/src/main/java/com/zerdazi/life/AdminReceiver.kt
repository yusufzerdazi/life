package com.zerdazi.life

import android.app.admin.DeviceAdminReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent

// Being an active device admin is what stops Android uninstalling the app:
// it has to be deactivated first, and LifeService guards that screen.
// No policies are used.
class AdminReceiver : DeviceAdminReceiver() {
    override fun onDisableRequested(context: Context, intent: Intent): CharSequence =
        "This removes life's uninstall protection."

    companion object {
        fun component(ctx: Context) = ComponentName(ctx, AdminReceiver::class.java)
    }
}
