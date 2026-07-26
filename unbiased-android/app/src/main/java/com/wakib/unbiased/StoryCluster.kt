package com.wakib.unbiased

data class StoryCluster(
    val id: String,
    val headline: String,
    val summary: String,
    val category: String?,
    val source_count: Int,
    val summary_source_count: Int,
    val article_count: Int,
    val first_article_at: String,
    val last_article_at: String
)