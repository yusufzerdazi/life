package com.zerdazi.life

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.webkit.WebView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import com.zerdazi.life.server.Integrations
import com.zerdazi.life.server.WakingUp

class MainActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var setupBar: View
    private lateinit var setupText: TextView
    private lateinit var setupAction: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = LifeWeb.create(this)
        setupBar = buildSetupBar()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Palette.NIGHT)
            addView(setupBar)
            addView(web, LinearLayout.LayoutParams(-1, 0, 1f))
            // targetSdk 35+ is always edge-to-edge: keep content clear of the bars.
            setOnApplyWindowInsetsListener { v, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                insets
            }
        }
        setContentView(root)
        LifeWeb.handleBack(this, web)
        web.loadUrl(LifeWeb.url("/"))
        askBluetooth(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        askBluetooth(intent)
    }

    // "Find strip" in Lights, without Bluetooth permission yet.
    private fun askBluetooth(i: Intent?) {
        // adb shell am start -n com.zerdazi.life/.MainActivity --es goveeName ihoment_H6159_2ABB
        i?.getStringExtra(EXTRA_GOVEE_NAME)?.let { name ->
            i.removeExtra(EXTRA_GOVEE_NAME)
            Thread { Lights.Govee.prefer(name) }.start()
        }
        // adb shell am start -n com.zerdazi.life/.MainActivity --es goveeForget Govee_H6076_5508
        i?.getStringExtra(EXTRA_GOVEE_FORGET)?.let { name ->
            i.removeExtra(EXTRA_GOVEE_FORGET)
            Lights.Govee.removeByName(name)
        }
        if (i?.getBooleanExtra(EXTRA_ASK_BLUETOOTH, false) != true) return
        i.removeExtra(EXTRA_ASK_BLUETOOTH)
        requestPermissions(Lights.Govee.PERMISSIONS, REQUEST_BLUETOOTH)
    }

    override fun onResume() {
        super.onResume()
        val admin = getSystemService(DevicePolicyManager::class.java).isAdminActive(AdminReceiver.component(this))
        when {
            !serviceEnabled() -> setup("Blocking and sleep mode are off.") {
                startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            }
            !admin -> setup("Uninstall protection is off.") {
                startActivity(
                    Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN)
                        .putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, AdminReceiver.component(this))
                        .putExtra(DevicePolicyManager.EXTRA_ADD_EXPLANATION, "Stops life being uninstalled from the phone.")
                )
            }
            else -> {
                setupBar.visibility = View.GONE
                checkHealthConnect()
            }
        }
        syncIfStale()
    }

    // Meditation sync reads Waking Up's sessions from Health Connect; ask once
    // for access if it's missing.
    private fun checkHealthConnect() = Thread {
        val missing = runCatching { WakingUp.missingPermissions() }.getOrDefault(emptySet())
        if (missing.isEmpty()) return@Thread
        runOnUiThread {
            setup(if (HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND in missing && missing.size == 1) "Let meditation sync in the background." else "Meditation sync needs Health Connect.") {
                if (Build.VERSION.SDK_INT >= 34) {
                    // Health permissions are ordinary runtime permissions here.
                    // Reading first; background access only once that's allowed
                    // (the bar comes back for it).
                    val reading = missing - HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND
                    requestPermissions((reading.ifEmpty { missing }).toTypedArray(), REQUEST_HEALTH)
                } else {
                    // Older Android: Health Connect is a separate app with its own screen.
                    val contract = PermissionController.createRequestPermissionResultContract()
                    @Suppress("DEPRECATION")
                    startActivityForResult(contract.createIntent(this, WakingUp.PERMISSIONS), REQUEST_HEALTH)
                }
            }
        }
    }.start()

    @Deprecated("Fine for a plain Activity")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQUEST_HEALTH) lastSync = 0L // onResume follows: sync straight away
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_HEALTH) lastSync = 0L // onResume follows: sync straight away
        if (requestCode == REQUEST_BLUETOOTH && Lights.Govee.hasPermission()) Thread { Lights.Govee.scan() }.start()
    }

    // Opening the app pulls Google Health + meditation (at most every few
    // minutes), then tells the page to reload its data.
    private fun syncIfStale() {
        val now = SystemClock.elapsedRealtime()
        if (lastSync != 0L && now - lastSync < 5 * 60_000) return
        lastSync = now
        Thread {
            Integrations.syncAll()
            web.post { web.evaluateJavascript("window.dispatchEvent(new Event('life:synced'))", null) }
        }.start()
    }

    @Deprecated("Pre-Android 13 back handling")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    private fun setup(message: String, action: () -> Unit) {
        setupText.text = message
        setupAction.setOnClickListener { action() }
        setupBar.visibility = View.VISIBLE
    }

    // Shown until LifeService (accessibility) and uninstall protection (device
    // admin) are both on.
    private fun buildSetupBar(): View = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setBackgroundColor(Palette.RAISE)
        val pad = dp(16)
        setPadding(dp(24), pad, pad, pad)
        addView(TextView(context).apply {
            setupText = this
            setTextColor(Palette.DIM)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        }, LinearLayout.LayoutParams(0, -2, 1f))
        addView(TextView(context).apply {
            setupAction = this
            text = "Turn on"
            setTextColor(Palette.EMBER)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setPadding(dp(12), dp(8), dp(8), dp(8))
        })
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun serviceEnabled(): Boolean {
        val me = ComponentName(this, LifeService::class.java)
        val enabled = Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: ""
        // Entries may be short ("pkg/.Cls") or full ("pkg/pkg.Cls").
        return enabled.split(':').any { ComponentName.unflattenFromString(it) == me }
    }

    companion object {
        private var lastSync = 0L
        private const val REQUEST_HEALTH = 1
        private const val REQUEST_BLUETOOTH = 2
        const val EXTRA_ASK_BLUETOOTH = "askBluetooth"
        const val EXTRA_GOVEE_NAME = "goveeName"
        const val EXTRA_GOVEE_FORGET = "goveeForget"
    }
}
