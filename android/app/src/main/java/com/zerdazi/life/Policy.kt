package com.zerdazi.life

import java.time.LocalDateTime

sealed interface Verdict

object Allow : Verdict

// `kind` is why it's blocked: "block" (a named block), "category" (on a
// category list) or "screentime".
data class Blocked(
    val name: String,
    val until: LocalDateTime,
    val kind: String,
    val what: String,
    val category: String? = null,
) : Verdict

// The one place that decides what happens when an app or site comes up.
object Policy {
    fun forApp(pkg: String, now: LocalDateTime = LocalDateTime.now()): Verdict {
        val what = Usage.label(pkg)
        Schedule.forApp(pkg, now)?.let { return Blocked(it.block.name, it.until, "block", what) }
        Categories.app(pkg)?.let { c -> categoryBlock(c, now)?.let { (b, until) -> return Blocked(b.name, until, "category", what, c) } }
        if (!Usage.isExempt(pkg) && Usage.overLimit()) {
            return Blocked("Screen time", Usage.nextReset(now), "screentime", what)
        }
        return Allow
    }

    fun forUrl(url: String, now: LocalDateTime = LocalDateTime.now()): Verdict {
        val host = Schedule.hostOf(url) ?: return Allow
        Schedule.forUrl(url, now)?.let { return Blocked(it.block.name, it.until, "block", host) }
        Categories.site(host)?.let { c -> categoryBlock(c, now)?.let { (b, until) -> return Blocked(b.name, until, "category", host, c) } }
        return Allow
    }

    private fun categoryBlock(category: String, now: LocalDateTime): Pair<Block, LocalDateTime>? {
        val block = Config.CATEGORY_BLOCKS[category] ?: return null
        return Schedule.activeUntil(block, now)?.let { block to it }
    }
}
