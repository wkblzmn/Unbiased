package com.wakib.unbiased.ui.feed

import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

// Postgres/PostgREST timestamps look like "2026-07-26T10:15:00.123456+00:00".
// Taking the first 19 chars gets a plain "yyyy-MM-ddTHH:mm:ss" in UTC without
// needing java.time (which needs desugaring below API 26, and minSdk here is 24).
private val isoFormat = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).apply {
    timeZone = TimeZone.getTimeZone("UTC")
}

fun formatRelativeTime(isoTimestamp: String): String {
    val parsed = runCatching { isoFormat.parse(isoTimestamp.take(19)) }.getOrNull() ?: return ""
    val minutes = (System.currentTimeMillis() - parsed.time) / 60_000
    return when {
        minutes < 1 -> "just now"
        minutes < 60 -> "${minutes}m ago"
        minutes < 60 * 24 -> "${minutes / 60}h ago"
        else -> "${minutes / (60 * 24)}d ago"
    }
}
