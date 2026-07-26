package com.wakib.unbiased.data.local.entity

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "bookmarks")
data class BookmarkEntity(
    @PrimaryKey val clusterId: String,
    val bookmarkedAt: Long
)
