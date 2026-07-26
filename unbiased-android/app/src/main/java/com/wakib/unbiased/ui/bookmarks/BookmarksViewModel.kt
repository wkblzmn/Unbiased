package com.wakib.unbiased.ui.bookmarks

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.wakib.unbiased.data.local.entity.StoryClusterEntity
import com.wakib.unbiased.data.repository.FeedRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import javax.inject.Inject

@HiltViewModel
class BookmarksViewModel @Inject constructor(
    repository: FeedRepository
) : ViewModel() {

    val bookmarks: StateFlow<List<StoryClusterEntity>> = repository.observeBookmarked()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())
}
