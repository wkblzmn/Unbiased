package com.wakib.unbiased.ui.detail

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.wakib.unbiased.data.local.entity.SourceEntity
import com.wakib.unbiased.data.local.entity.StoryClusterEntity
import com.wakib.unbiased.data.repository.FeedRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

data class StoryDetailUiState(
    val story: StoryClusterEntity? = null,
    val sources: List<SourceEntity> = emptyList(),
    val isLoading: Boolean = false,
    val error: String? = null,
    val isBookmarked: Boolean = false
)

@HiltViewModel
class DetailViewModel @Inject constructor(
    private val repository: FeedRepository,
    savedStateHandle: SavedStateHandle
) : ViewModel() {

    private val clusterId: String = checkNotNull(savedStateHandle["clusterId"])

    private val isLoading = MutableStateFlow(true)
    private val error = MutableStateFlow<String?>(null)
    private val story = MutableStateFlow<StoryClusterEntity?>(null)

    val uiState: StateFlow<StoryDetailUiState> = combine(
        story,
        repository.observeSources(clusterId),
        isLoading,
        error,
        repository.observeIsBookmarked(clusterId)
    ) { storyValue, sources, loading, err, bookmarked ->
        StoryDetailUiState(
            story = storyValue,
            sources = sources,
            isLoading = loading,
            error = err,
            isBookmarked = bookmarked
        )
    }.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5000),
        initialValue = StoryDetailUiState(isLoading = true)
    )

    init {
        viewModelScope.launch {
            story.value = repository.getCachedStory(clusterId)
        }
        refreshSources()
    }

    fun toggleBookmark() {
        viewModelScope.launch {
            repository.setBookmarked(clusterId, !uiState.value.isBookmarked)
        }
    }

    fun refreshSources() {
        viewModelScope.launch {
            isLoading.value = true
            error.value = null
            try {
                repository.refreshSources(clusterId)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error.value = e.message ?: "Couldn't load sources"
            } finally {
                isLoading.value = false
            }
        }
    }
}
