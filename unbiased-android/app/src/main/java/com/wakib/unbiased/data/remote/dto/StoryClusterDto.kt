package com.wakib.unbiased.data.remote.dto

// Mirrors the feed_clusters view (migration_003.sql). Field names match the
// PostgREST/Supabase JSON response exactly, snake_case included.
data class StoryClusterDto(
    val id: String,
    val headline: String,
    val summary: String?,
    val category: String?,
    val source_count: Int,
    val summary_source_count: Int,
    val article_count: Int,
    val first_article_at: String,
    val last_article_at: String
)
