package com.wakib.unbiased.data.remote.dto

// Mirrors the feed_cluster_sources view (migration_003.sql). has_body is the
// link-only marker: false means this outlet's headline/url/bias_label are
// real but its text never fed the summary and must be shown as such.
data class SourceDto(
    val cluster_id: String,
    val article_id: String,
    val title: String,
    val url: String,
    val published_at: String?,
    val source_name: String,
    val bias_label: String?,
    val has_body: Boolean,
    val merge_via: String?
)
