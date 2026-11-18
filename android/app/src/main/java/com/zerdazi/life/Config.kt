package com.zerdazi.life

import java.time.DayOfWeek
import java.time.LocalTime

// Personal settings, compiled in. Edit + rebuild to change.
//
// All times are wall-clock times on the phone (Europe/London): 23:00 is 23:00
// in both BST and GMT, and the day resets at 05:00 either way.
object Config {
    // Tokens (Google Health, Waking Up) live in android/secrets.properties.

    // How often LifeService pulls Google Health + Waking Up.
    const val POLL_MINUTES = 30L

    // Charging while the phone is upright (on the wall) opens sleep mode.
    // Tilt from flat, in degrees, above which the phone counts as "vertical".
    const val VERTICAL_MIN_TILT_DEG = 60.0

    // --- Screen time ---
    const val SCREEN_TIME_LIMIT_MIN = 5 * 60
    val SCREEN_TIME_WARN_AT_MIN = listOf(4 * 60, 4 * 60 + 30, 4 * 60 + 55)

    // Never counted towards screen time, and still usable once it's up.
    // (The home screen and life itself are always exempt too.)
    val SCREEN_TIME_EXEMPT = setOf(
        "com.google.android.dialer",
        "com.google.android.contacts",
        "com.google.android.apps.messaging",
        "com.whatsapp",
        "com.google.android.apps.maps",
        "com.google.android.GoogleCamera",
        "com.google.android.deskclock",
        "com.google.android.apps.authenticator2",
        "com.android.settings",
        "net.dinglisch.android.taskerm",
    )

    // --- Evenings ---
    // The screen goes grayscale from GRAYSCALE_FROM until the day resets
    // (05:00). Needs WRITE_SECURE_SETTINGS, granted once over adb.
    const val GRAYSCALE_FROM = "22:00"

    // Between these times, until the phone is in sleep mode (charging on the
    // wall), the Hue lights and Govee strip flash red. See Lights.kt.
    const val BEDTIME_LIGHTS_FROM = "22:00"
    const val BEDTIME_LIGHTS_UNTIL = "23:00"

    // --- Breaks ---
    // After this long on one app or site, ask whether to take a break. Being
    // away from it for BREAK_RESET_MIN starts the count again; "keep going"
    // asks again after another BREAK_AFTER_MIN.
    const val BREAK_AFTER_MIN = 15
    const val BREAK_RESET_MIN = 3

    private val EVERY_DAY = DayOfWeek.entries.toSet()
    // 23:00 → 17:30 the next day: only open 17:30–23:00.
    private val EVENINGS_ONLY = Window(EVERY_DAY, "23:00", "17:30")

    // Built-in blocks: like the ones added in the app, but they can't be
    // removed at all without a rebuild.
    val BLOCKS = listOf(
        Block(
            name = "Websites",
            sites = setOf("bbc.co.uk", "youtube.com", "pornhub.com", "reddit.com"),
            windows = listOf(Window.ALWAYS),
        ),
        Block(
            name = "YouTube",
            apps = setOf("com.google.android.youtube"),
            windows = listOf(Window.ALWAYS),
        ),
        Block(
            name = "BBC News & Reddit",
            apps = setOf(
                "bbc.mobile.news.uk", // BBC News (UK)
                "bbc.mobile.news.ww", // BBC News (international)
                "com.reddit.frontpage",
            ),
            windows = listOf(EVENINGS_ONLY),
        ),
        Block(
            name = "Chess",
            apps = setOf("com.chess", "org.lichess.mobileV2"),
            sites = setOf("chess.com", "lichess.org", "chess24.com"),
            windows = listOf(Window.ALWAYS),
        ),
    )

    // Category blocks: every site on the bundled list for the category
    // (assets/lists, rebuilt by android/lists/update.py), and for news, every
    // app that declares itself a news app. Shown as built-in blocks.
    val CATEGORY_BLOCKS = mapOf(
        "adult" to Block(name = "Adult sites", windows = listOf(Window.ALWAYS)),
        "news" to Block(name = "News", windows = listOf(EVENINGS_ONLY)),
    )

    // Sites (domains; subdomains match too) and apps that category blocks
    // never touch, whatever the lists say.
    val CATEGORY_EXEMPT_SITES = setOf<String>()
    val CATEGORY_EXEMPT_APPS = setOf("org.schabi.newpipe")
}

data class Block(
    val name: String,
    val apps: Set<String> = emptySet(),
    // Domains; subdomains match too (m.youtube.com matches youtube.com).
    val sites: Set<String> = emptySet(),
    val windows: List<Window>,
    // A one-off block (from the bedtime review): on until this moment,
    // `windows` ignored.
    val until: java.time.LocalDateTime? = null,
)

// `days` are the days the window STARTS on. A window whose end is before its
// start runs past midnight into the next day.
class Window(val days: Set<DayOfWeek>, start: String, end: String) {
    val start: LocalTime = LocalTime.parse(start)
    val end: LocalTime = LocalTime.parse(end)

    // Every day, start == end: never lets up.
    val isAlways get() = days.size == 7 && start == end

    companion object {
        val ALWAYS = Window(DayOfWeek.entries.toSet(), "00:00", "00:00")
    }
}
