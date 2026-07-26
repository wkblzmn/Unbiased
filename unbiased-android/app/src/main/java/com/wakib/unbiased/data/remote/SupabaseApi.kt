package com.wakib.unbiased.data.remote

import com.wakib.unbiased.data.remote.dto.SourceDto
import com.wakib.unbiased.data.remote.dto.StoryClusterDto
import retrofit2.http.GET
import retrofit2.http.Query

interface SupabaseApi {
    // categoryFilter/beforeFilter must be PostgREST filter syntax, e.g.
    // "eq.Politics" / "lt.2026-07-26T09:44:06+00:00". Null omits the filter
    // (Retrofit drops @Query params whose value is null).
    @GET("rest/v1/feed_clusters")
    suspend fun getFeedClusters(
        @Query("select") select: String = "*",
        @Query("order") order: String = "last_article_at.desc",
        @Query("limit") limit: Int = FEED_PAGE_SIZE,
        @Query("category") categoryFilter: String? = null,
        @Query("last_article_at") beforeFilter: String? = null
    ): List<StoryClusterDto>

    // clusterIdFilter must be PostgREST filter syntax, e.g. "eq.<uuid>".
    @GET("rest/v1/feed_cluster_sources")
    suspend fun getSourcesForCluster(
        @Query("cluster_id") clusterIdFilter: String,
        @Query("select") select: String = "*"
    ): List<SourceDto>

    companion object {
        const val FEED_PAGE_SIZE = 20
    }
}
