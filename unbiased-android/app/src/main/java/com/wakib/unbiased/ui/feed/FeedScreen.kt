package com.wakib.unbiased.ui.feed

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.SuggestionChipDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.wakib.unbiased.data.local.entity.StoryClusterEntity
import com.wakib.unbiased.ui.theme.UnbiasedTheme

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FeedScreen(
    uiState: FeedUiState,
    onSelectCategory: (String?) -> Unit,
    onRefresh: () -> Unit,
    onStoryClick: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = { Text("Unbiased") },
                actions = {
                    IconButton(onClick = onRefresh) {
                        Icon(Icons.Filled.Refresh, contentDescription = "Refresh")
                    }
                }
            )
        }
    ) { padding ->
        Column(modifier = Modifier.padding(padding)) {
            CategoryFilterRow(
                selectedCategory = uiState.selectedCategory,
                onSelectCategory = onSelectCategory
            )
            FeedContent(uiState = uiState, onStoryClick = onStoryClick)
        }
    }
}

@Composable
private fun CategoryFilterRow(
    selectedCategory: String?,
    onSelectCategory: (String?) -> Unit
) {
    LazyRow(
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        item {
            FilterChip(
                selected = selectedCategory == null,
                onClick = { onSelectCategory(null) },
                label = { Text("All") }
            )
        }
        items(FEED_CATEGORIES) { category ->
            FilterChip(
                selected = selectedCategory == category,
                onClick = { onSelectCategory(category) },
                label = { Text(category) }
            )
        }
    }
}

@Composable
private fun FeedContent(
    uiState: FeedUiState,
    onStoryClick: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    when {
        uiState.isLoading && uiState.stories.isEmpty() -> {
            Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
        }
        uiState.error != null && uiState.stories.isEmpty() -> {
            Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(text = "Couldn't load stories: ${uiState.error}")
            }
        }
        uiState.stories.isEmpty() -> {
            Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(
                    text = if (uiState.selectedCategory == null) {
                        "No stories yet."
                    } else {
                        "No stories in ${uiState.selectedCategory} right now."
                    }
                )
            }
        }
        else -> {
            LazyColumn(modifier = modifier.fillMaxSize()) {
                items(uiState.stories, key = { it.id }) { story ->
                    StoryCard(story = story, onClick = { onStoryClick(story.id) })
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StoryCard(story: StoryClusterEntity, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Card(
        onClick = onClick,
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 6.dp)
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            Text(
                text = story.category ?: "Uncategorized",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.primary
            )
            Text(
                text = story.headline,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold
            )
            Text(
                text = story.summary,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis
            )
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                SuggestionChip(
                    onClick = onClick,
                    label = { Text("${story.sourceCount} sources") },
                    colors = SuggestionChipDefaults.suggestionChipColors()
                )
                Text(
                    text = formatRelativeTime(story.lastArticleAt),
                    style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.align(Alignment.CenterVertically)
                )
            }
        }
    }
}

@Preview(showBackground = true)
@Composable
fun StoryCardPreview() {
    UnbiasedTheme {
        StoryCard(
            story = StoryClusterEntity(
                id = "preview",
                category = "Environment",
                headline = "Flood risk grows in Sylhet and Sunamganj regions",
                summary = "The National Disaster Response Coordination Centre and the " +
                        "Flood Forecasting and Warning Centre have warned that flood " +
                        "conditions in Sylhet and Sunamganj may deteriorate over the " +
                        "next 48 hours.",
                sourceCount = 3,
                summarySourceCount = 2,
                articleCount = 4,
                firstArticleAt = "",
                lastArticleAt = "",
                cachedAt = 0L
            ),
            onClick = {}
        )
    }
}
