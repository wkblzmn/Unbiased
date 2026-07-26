package com.wakib.unbiased.data.repository

import com.wakib.unbiased.data.local.dao.BookmarkDao
import com.wakib.unbiased.data.local.dao.SourceDao
import com.wakib.unbiased.data.local.dao.StoryClusterDao
import com.wakib.unbiased.data.local.entity.StoryClusterEntity
import com.wakib.unbiased.data.remote.SupabaseApi
import com.wakib.unbiased.data.remote.dto.SourceDto
import com.wakib.unbiased.data.remote.dto.StoryClusterDto
import io.mockk.Ordering
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class FeedRepositoryTest {

    private val api = mockk<SupabaseApi>()
    private val storyClusterDao = mockk<StoryClusterDao>(relaxUnitFun = true)
    private val sourceDao = mockk<SourceDao>(relaxUnitFun = true)
    private val bookmarkDao = mockk<BookmarkDao>(relaxUnitFun = true)

    private val repository = FeedRepository(api, storyClusterDao, sourceDao, bookmarkDao)

    @Test
    fun `refreshFeed maps DTO fields onto the entity without mixing up source counts`() = runBlocking {
        coEvery { api.getFeedClusters() } returns listOf(
            StoryClusterDto(
                id = "c1",
                headline = "Flood risk grows",
                summary = "Neutral summary text",
                category = "Environment",
                source_count = 3,
                summary_source_count = 2,
                article_count = 4,
                first_article_at = "2026-07-25T10:00:00+00:00",
                last_article_at = "2026-07-26T10:00:00+00:00"
            )
        )

        repository.refreshFeed()

        val captured = mutableListOf<List<StoryClusterEntity>>()
        coVerify { storyClusterDao.upsertAll(capture(captured)) }
        val entity = captured.single().single()

        assertEquals("c1", entity.id)
        assertEquals("Flood risk grows", entity.headline)
        // source_count (outlets that covered it) must never be swapped with
        // summary_source_count (outlets that fed the summary) or article_count
        // — that exact bug (#11 in the backend's known-issues doc) was what
        // let 29% of the feed surface as fake multi-source stories.
        assertEquals(3, entity.sourceCount)
        assertEquals(2, entity.summarySourceCount)
        assertEquals(4, entity.articleCount)
    }

    @Test
    fun `refreshSources clears the previous cache before upserting fresh sources`() = runBlocking {
        coEvery { api.getSourcesForCluster(clusterIdFilter = "eq.c1") } returns listOf(
            SourceDto(
                cluster_id = "c1",
                article_id = "a1",
                title = "Headline",
                url = "https://example.com/a1",
                published_at = null,
                source_name = "Daily Star",
                bias_label = "Centre",
                has_body = false,
                merge_via = "title_nobody"
            )
        )

        repository.refreshSources("c1")

        coVerify(ordering = Ordering.ORDERED) {
            sourceDao.clearForCluster("c1")
            sourceDao.upsertAll(any())
        }
    }

    @Test
    fun `setBookmarked true inserts a bookmark, false deletes it`() = runBlocking {
        repository.setBookmarked("c1", bookmarked = true)
        coVerify { bookmarkDao.insert(match { it.clusterId == "c1" }) }

        repository.setBookmarked("c1", bookmarked = false)
        coVerify { bookmarkDao.delete("c1") }
    }
}
