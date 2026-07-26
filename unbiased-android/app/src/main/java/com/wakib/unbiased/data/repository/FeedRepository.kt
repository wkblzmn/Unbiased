package com.wakib.unbiased.data.repository

import com.wakib.unbiased.data.local.dao.BookmarkDao
import com.wakib.unbiased.data.local.dao.SourceDao
import com.wakib.unbiased.data.local.dao.StoryClusterDao
import com.wakib.unbiased.data.local.entity.BookmarkEntity
import com.wakib.unbiased.data.local.entity.SourceEntity
import com.wakib.unbiased.data.local.entity.StoryClusterEntity
import com.wakib.unbiased.data.remote.SupabaseApi
import com.wakib.unbiased.data.remote.dto.SourceDto
import com.wakib.unbiased.data.remote.dto.StoryClusterDto
import kotlinx.coroutines.flow.Flow
import javax.inject.Inject
import javax.inject.Singleton

// Offline-first: the UI observes Room directly. refreshFeed()/refreshSources()
// fetch from the live endpoint and upsert into Room, which pushes the update
// back out through the observing Flow.
@Singleton
class FeedRepository @Inject constructor(
    private val api: SupabaseApi,
    private val storyClusterDao: StoryClusterDao,
    private val sourceDao: SourceDao,
    private val bookmarkDao: BookmarkDao
) {
    fun observeFeed(): Flow<List<StoryClusterEntity>> = storyClusterDao.observeAll()

    fun observeFeedByCategory(category: String): Flow<List<StoryClusterEntity>> =
        storyClusterDao.observeByCategory(category)

    fun observeSources(clusterId: String): Flow<List<SourceEntity>> =
        sourceDao.observeForCluster(clusterId)

    suspend fun getCachedStory(clusterId: String): StoryClusterEntity? =
        storyClusterDao.getById(clusterId)

    fun observeBookmarked(): Flow<List<StoryClusterEntity>> = storyClusterDao.observeBookmarked()

    fun observeIsBookmarked(clusterId: String): Flow<Boolean> =
        bookmarkDao.observeIsBookmarked(clusterId)

    suspend fun setBookmarked(clusterId: String, bookmarked: Boolean) {
        if (bookmarked) {
            bookmarkDao.insert(BookmarkEntity(clusterId, System.currentTimeMillis()))
        } else {
            bookmarkDao.delete(clusterId)
        }
    }

    suspend fun refreshFeed() {
        val clusters = api.getFeedClusters()
        storyClusterDao.upsertAll(clusters.map { it.toEntity() })
    }

    suspend fun refreshSources(clusterId: String) {
        val sources = api.getSourcesForCluster(clusterIdFilter = "eq.$clusterId")
        sourceDao.clearForCluster(clusterId)
        sourceDao.upsertAll(sources.map { it.toEntity() })
    }
}

private fun StoryClusterDto.toEntity() = StoryClusterEntity(
    id = id,
    headline = headline,
    summary = summary.orEmpty(),
    category = category,
    sourceCount = source_count,
    summarySourceCount = summary_source_count,
    articleCount = article_count,
    firstArticleAt = first_article_at,
    lastArticleAt = last_article_at,
    cachedAt = System.currentTimeMillis()
)

private fun SourceDto.toEntity() = SourceEntity(
    clusterId = cluster_id,
    articleId = article_id,
    title = title,
    url = url,
    publishedAt = published_at,
    sourceName = source_name,
    biasLabel = bias_label,
    hasBody = has_body,
    mergeVia = merge_via
)
