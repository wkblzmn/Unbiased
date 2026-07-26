package com.wakib.unbiased.data.local.entity

import androidx.room.Entity

@Entity(tableName = "cluster_sources", primaryKeys = ["clusterId", "articleId"])
data class SourceEntity(
    val clusterId: String,
    val articleId: String,
    val title: String,
    val url: String,
    val publishedAt: String?,
    val sourceName: String,
    val biasLabel: String?,
    val hasBody: Boolean,
    val mergeVia: String?
)
