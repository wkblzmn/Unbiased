package com.wakib.unbiased.data.local.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import com.wakib.unbiased.data.local.entity.SourceEntity
import kotlinx.coroutines.flow.Flow

@Dao
interface SourceDao {
    @Query("SELECT * FROM cluster_sources WHERE clusterId = :clusterId")
    fun observeForCluster(clusterId: String): Flow<List<SourceEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(sources: List<SourceEntity>)

    @Query("DELETE FROM cluster_sources WHERE clusterId = :clusterId")
    suspend fun clearForCluster(clusterId: String)
}
