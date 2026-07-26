package com.wakib.unbiased.data.local.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import com.wakib.unbiased.data.local.entity.StoryClusterEntity
import kotlinx.coroutines.flow.Flow

@Dao
interface StoryClusterDao {
    @Query("SELECT * FROM story_clusters ORDER BY lastArticleAt DESC")
    fun observeAll(): Flow<List<StoryClusterEntity>>

    @Query("SELECT * FROM story_clusters WHERE category = :category ORDER BY lastArticleAt DESC")
    fun observeByCategory(category: String): Flow<List<StoryClusterEntity>>

    @Query("SELECT * FROM story_clusters WHERE id = :id")
    suspend fun getById(id: String): StoryClusterEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(clusters: List<StoryClusterEntity>)
}
