package com.wakib.unbiased.data.local

import androidx.room.Database
import androidx.room.RoomDatabase
import com.wakib.unbiased.data.local.dao.SourceDao
import com.wakib.unbiased.data.local.dao.StoryClusterDao
import com.wakib.unbiased.data.local.entity.SourceEntity
import com.wakib.unbiased.data.local.entity.StoryClusterEntity

@Database(
    entities = [StoryClusterEntity::class, SourceEntity::class],
    version = 1,
    exportSchema = false
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun storyClusterDao(): StoryClusterDao
    abstract fun sourceDao(): SourceDao
}
