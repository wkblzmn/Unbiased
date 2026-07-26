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
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

data class FeedUiState(
    val stories: List<StoryClusterEntity> = emptyList(),
    val isLoading: Boolean = false,
    val error: String? = null,
    val selectedCategory: String? = null
)

@OptIn(ExperimentalCoroutinesApi::class)
@HiltViewModel
class FeedViewModel @Inject constructor(
    private val repository: FeedRepository
) : ViewModel() {

    private val isLoading = MutableStateFlow(false)
    private val error = MutableStateFlow<String?>(null)
    private val selectedCategory = MutableStateFlow<String?>(null)

    private val stories = selectedCategory.flatMapLatest { category ->
        if (category == null) repository.observeFeed() else repository.observeFeedByCategory(category)
    }

    val uiState: StateFlow<FeedUiState> = combine(
        stories, isLoading, error, selectedCategory
    ) { storyList, loading, err, category ->
        FeedUiState(stories = storyList, isLoading = loading, error = err, selectedCategory = category)
    }.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5000),
        initialValue = FeedUiState(isLoading = true)
    )

    init {
        refresh()
    }

    fun selectCategory(category: String?) {
        selectedCategory.value = category
    }

    fun refresh() {
        viewModelScope.launch {
            isLoading.value = true
            error.value = null
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
}
