package com.zerdazi.life

import android.content.Intent
import android.content.pm.ApplicationInfo
import android.util.Log
import java.util.concurrent.ConcurrentHashMap

// Which category (adult, news) a site or app is in, from fixed lists — no
// guessing. Sites: the domain lists in assets/lists (see android/lists/update.py
// for the sources). Apps: news apps by the category they declare to Android.
object Categories {
    @Volatile private var lists: Map<String, Set<String>>? = null
    private val appCategory = ConcurrentHashMap<String, String>()

    // ~100k domains: read once, in the background (LifeService starts it).
    fun load() {
        if (lists != null) return
        synchronized(this) {
            if (lists != null) return
            lists = Config.CATEGORY_BLOCKS.keys.associateWith { name ->
                runCatching {
                    LifeApp.ctx.assets.open("lists/$name.txt").bufferedReader().useLines { lines ->
                        lines.filter { it.isNotBlank() && !it.startsWith("#") }.map { it.trim() }.toHashSet()
                    }
                }.onFailure { Log.w("LifeCategories", "no list for $name", it) }.getOrDefault(emptySet())
            }
            Log.i("LifeCategories", lists!!.entries.joinToString { "${it.key}: ${it.value.size}" })
        }
    }

    // Category of a host (it, or any parent domain, is listed). Null while the
    // lists are still loading.
    fun site(host: String): String? {
        val l = lists ?: return null
        val h = host.lowercase().removePrefix("www.")
        if (Schedule.matches(h, Config.CATEGORY_EXEMPT_SITES)) return null
        val parts = h.split('.')
        for (i in 0 until parts.size - 1) {
            val d = parts.subList(i, parts.size).joinToString(".")
            for ((name, set) in l) if (d in set) return name
        }
        return null
    }

    fun app(pkg: String): String? {
        if (pkg in Config.CATEGORY_EXEMPT_APPS) return null
        return appCategory.getOrPut(pkg) {
            val info = runCatching { LifeApp.ctx.packageManager.getApplicationInfo(pkg, 0) }.getOrNull()
            if (info?.category == ApplicationInfo.CATEGORY_NEWS) "news" else ""
        }.ifEmpty { null }
    }

    // For the blocks list.
    fun describe(name: String): String {
        val sites = "$name sites (${size(name)} on the list)"
        if (name != "news") return sites
        val pm = LifeApp.ctx.packageManager
        val apps = pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
            .map { it.activityInfo.packageName }.distinct()
            .filter { app(it) == "news" }
            .map { Usage.label(it) }.sorted()
        return if (apps.isEmpty()) "$sites and news apps (none installed)" else "$sites and news apps: ${apps.joinToString(", ")}"
    }

    private fun size(name: String) = "%,d".format(lists?.get(name)?.size ?: 0)
}
