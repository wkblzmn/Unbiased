package com.wakib.unbiased.data.local.entity

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "story_clusters")
data class StoryClusterEntity(
    @PrimaryKey val id: String,
    val headline: String,
    val summary: String,
    val category: String?,
    val sourceCount: Int,
    val summarySourceCount: Int,
    val articleCount: Int,
    val firstArticleAt: String,
    val lastArticleAt: String,
    val cachedAt: Long
)
