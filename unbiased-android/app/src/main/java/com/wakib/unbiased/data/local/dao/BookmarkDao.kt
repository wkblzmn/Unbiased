package com.wakib.unbiased.data.local.dao

import androidx.room.Dao
import androidx.room.Delete
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import com.wakib.unbiased.data.local.entity.BookmarkEntity
import kotlinx.coroutines.flow.Flow

@Dao
interface BookmarkDao {
    @Query("SELECT EXISTS(SELECT 1 FROM bookmarks WHERE clusterId = :clusterId)")
    fun observeIsBookmarked(clusterId: String): Flow<Boolean>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(bookmark: BookmarkEntity)

    @Query("DELETE FROM bookmarks WHERE clusterId = :clusterId")
    suspend fun delete(clusterId: String)
}
