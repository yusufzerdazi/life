package com.zerdazi.life

import com.zerdazi.life.server.Blocks
import java.time.LocalDateTime

data class ActiveBlock(val block: Block, val until: LocalDateTime)

object Schedule {
    // "until" for blocks that never end.
    val FOREVER: LocalDateTime = LocalDateTime.of(9999, 1, 1, 0, 0)

    fun forApp(pkg: String, now: LocalDateTime = LocalDateTime.now()): ActiveBlock? =
        active(now) { pkg in it.apps }

    fun forUrl(url: String, now: LocalDateTime = LocalDateTime.now()): ActiveBlock? {
        val host = hostOf(url) ?: return null
        return active(now) { b -> matches(host, b.sites) }
    }

    // `host` is one of `domains`, or a subdomain of one.
    fun matches(host: String, domains: Set<String>) = domains.any { host == it || host.endsWith(".$it") }

    private fun active(now: LocalDateTime, matches: (Block) -> Boolean): ActiveBlock? =
        Blocks.all().map { it.block }.filter(matches)
            .mapNotNull { b -> activeUntil(b, now)?.let { ActiveBlock(b, it) } }
            .maxByOrNull { it.until }

    // End of the latest window of `block` that contains `now`, or null.
    fun activeUntil(block: Block, now: LocalDateTime): LocalDateTime? {
        block.until?.let { return if (now.isBefore(it)) it else null }
        if (block.windows.any { it.isAlways }) return FOREVER
        val today = now.toLocalDate()
        return block.windows.flatMap { w ->
            // A window that started yesterday may still be running past midnight.
            listOf(today.minusDays(1), today).filter { it.dayOfWeek in w.days }.map { day ->
                val start = day.atTime(w.start)
                val end = if (w.end > w.start) day.atTime(w.end) else day.plusDays(1).atTime(w.end)
                start to end
            }
        }.filter { (start, end) -> !now.isBefore(start) && now.isBefore(end) }
            .maxOfOrNull { it.second }
    }

    // "https://m.Reddit.com/r/x" / "reddit.com/r/x" → "m.reddit.com"
    fun hostOf(url: String): String? {
        val s = url.trim().lowercase().substringAfter("://").substringBefore('/')
            .substringBefore('?').substringBefore('#').substringBefore(':').removePrefix("www.")
        return s.takeIf { it.contains('.') && !it.contains(' ') }
    }

    // "news.bbc.co.uk" → "bbc.co.uk", "amp.theguardian.com" → "theguardian.com"
    fun baseDomain(host: String): String {
        val labels = host.lowercase().removePrefix("www.").split('.').filter { it.isNotEmpty() }
        if (labels.size <= 2) return labels.joinToString(".")
        val secondLevel = labels[labels.size - 2]
        val keep = if (labels.last().length == 2 && secondLevel in setOf("co", "com", "org", "net", "ac", "gov", "ltd", "plc", "me")) 3 else 2
        return labels.takeLast(keep).joinToString(".")
    }
}
