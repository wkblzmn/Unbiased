package com.wakib.unbiased

import retrofit2.http.GET
import retrofit2.http.Query

interface SupabaseApi {
    @GET("rest/v1/feed_clusters")
    suspend fun getFeed(
        @Query("select") select: String = "*",
        @Query("order") order: String = "last_article_at.desc",
        @Query("limit") limit: Int = 20
    ): List<StoryCluster>
}