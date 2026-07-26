package com.wakib.unbiased.data.remote

import com.wakib.unbiased.data.remote.dto.SourceDto
import com.wakib.unbiased.data.remote.dto.StoryClusterDto
import retrofit2.http.GET
import retrofit2.http.Query

interface SupabaseApi {
    @GET("rest/v1/feed_clusters")
    suspend fun getFeedClusters(
        @Query("select") select: String = "*",
        @Query("order") order: String = "last_article_at.desc",
        @Query("limit") limit: Int = 20
    ): List<StoryClusterDto>

    // clusterIdFilter must be PostgREST filter syntax, e.g. "eq.<uuid>".
    @GET("rest/v1/feed_cluster_sources")
    suspend fun getSourcesForCluster(
        @Query("cluster_id") clusterIdFilter: String,
        @Query("select") select: String = "*"
    ): List<SourceDto>
}
