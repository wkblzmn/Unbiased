package com.wakib.unbiased.ui.feed

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.wakib.unbiased.data.local.entity.StoryClusterEntity
import com.wakib.unbiased.data.repository.FeedRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

data class FeedUiState(
    val stories: List<StoryClusterEntity> = emptyList(),
    val isLoading: Boolean = false,
    val isLoadingMore: Boolean = false,
    val endReached: Boolean = false,
    val error: String? = null,
    val selectedCategory: String? = null
)

@OptIn(ExperimentalCoroutinesApi::class)
@HiltViewModel
class FeedViewModel @Inject constructor(
    private val repository: FeedRepository
) : ViewModel() {

    private val isLoading = MutableStateFlow(false)
    private val isLoadingMore = MutableStateFlow(false)
    private val endReached = MutableStateFlow(false)
    private val error = MutableStateFlow<String?>(null)
    private val selectedCategory = MutableStateFlow<String?>(null)

    // category and its matching story list must reach combine() as a single
    // atomic emission — combining selectedCategory both here and directly
    // below let a state slip through where the new category label paired
    // with the still-old (pre-switch) story list, because flatMapLatest's
    // switch to the new inner flow doesn't land in the same tick as
    // selectedCategory's own emission to the parallel combine argument.
    private data class CategoryStories(val category: String?, val stories: List<StoryClusterEntity>)

    private val categoryStories = selectedCategory.flatMapLatest { category ->
        val storyFlow = if (category == null) repository.observeFeed() else repository.observeFeedByCategory(category)
        storyFlow.map { CategoryStories(category, it) }
    }

    val uiState: StateFlow<FeedUiState> = combine(
        categoryStories, isLoading, isLoadingMore, error, endReached
    ) { cs, loading, loadingMore, err, ended ->
        FeedUiState(
            stories = cs.stories,
            isLoading = loading,
            isLoadingMore = loadingMore,
            endReached = ended,
            error = err,
            selectedCategory = cs.category
        )
    }.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5000),
        initialValue = FeedUiState(isLoading = true)
    )

    init {
        refresh()
    }

    fun selectCategory(category: String?) {
        endReached.value = false
        selectedCategory.value = category
    }

    fun refresh() {
        viewModelScope.launch {
            isLoading.value = true
            error.value = null
            endReached.value = false
            try {
                repository.refreshFeed()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error.value = e.message ?: "Couldn't load the feed"
            } finally {
                isLoading.value = false
            }
        }
    }

    fun loadMore() {
        val current = uiState.value
        if (current.isLoadingMore || current.endReached || current.stories.isEmpty()) return
        // Room orders these DESC, so the last item in the currently
        // displayed list is the oldest one — the correct pagination cursor.
        val cursor = current.stories.last().lastArticleAt

        viewModelScope.launch {
            isLoadingMore.value = true
            try {
                val hasMore = repository.loadMore(current.selectedCategory, cursor)
                endReached.value = !hasMore
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error.value = e.message ?: "Couldn't load more stories"
            } finally {
                isLoadingMore.value = false
            }
        }
    }
}
