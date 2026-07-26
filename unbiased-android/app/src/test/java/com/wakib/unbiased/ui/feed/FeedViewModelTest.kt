package com.wakib.unbiased.ui.feed

import app.cash.turbine.test
import com.wakib.unbiased.MainDispatcherRule
import com.wakib.unbiased.data.local.entity.StoryClusterEntity
import com.wakib.unbiased.data.repository.FeedRepository
import io.mockk.coEvery
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test

class FeedViewModelTest {

    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    private val repository = mockk<FeedRepository>()

    private fun story(id: String, category: String) = StoryClusterEntity(
        id = id,
        headline = "Headline $id",
        summary = "Summary $id",
        category = category,
        sourceCount = 2,
        summarySourceCount = 2,
        articleCount = 2,
        firstArticleAt = "",
        lastArticleAt = "",
        cachedAt = 0L
    )

    @Test
    fun `successful refresh clears loading and error`() = runTest(mainDispatcherRule.dispatcher) {
        every { repository.observeFeed() } returns MutableStateFlow(listOf(story("c1", "Politics")))
        coEvery { repository.refreshFeed() } returns Unit

        val viewModel = FeedViewModel(repository)

        viewModel.uiState.test {
            skipItems(1) // stateIn's seed value (isLoading = true), before combine runs
            val state = awaitItem()
            assertFalse(state.isLoading)
            assertNull(state.error)
            assertEquals(listOf("c1"), state.stories.map { it.id })
        }
    }

    @Test
    fun `failed refresh surfaces an error without wiping cached stories`() = runTest(mainDispatcherRule.dispatcher) {
        every { repository.observeFeed() } returns MutableStateFlow(listOf(story("c1", "Politics")))
        coEvery { repository.refreshFeed() } throws RuntimeException("network down")

        val viewModel = FeedViewModel(repository)

        viewModel.uiState.test {
            skipItems(1)
            val state = awaitItem()
            assertEquals("network down", state.error)
            // The cache is Room-backed and offline-first: a failed refresh
            // must not clear stories the user already has on screen.
            assertEquals(listOf("c1"), state.stories.map { it.id })
        }
    }

    @Test
    fun `selecting a category switches to the category-filtered flow`() = runTest(mainDispatcherRule.dispatcher) {
        every { repository.observeFeed() } returns
            MutableStateFlow(listOf(story("c1", "Politics"), story("c2", "Sports")))
        every { repository.observeFeedByCategory("Sports") } returns
            MutableStateFlow(listOf(story("c2", "Sports")))
        coEvery { repository.refreshFeed() } returns Unit

        val viewModel = FeedViewModel(repository)

        viewModel.uiState.test {
            skipItems(1)
            awaitItem() // settled state, "All" selected, both stories

            viewModel.selectCategory("Sports")
            val filtered = awaitItem()

            assertEquals(listOf("c2"), filtered.stories.map { it.id })
            assertEquals("Sports", filtered.selectedCategory)
        }
    }
}
