package com.wakib.unbiased

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import com.wakib.unbiased.data.local.entity.StoryClusterEntity
import com.wakib.unbiased.ui.feed.FeedUiState
import com.wakib.unbiased.ui.feed.FeedViewModel
import com.wakib.unbiased.ui.theme.UnbiasedTheme
import dagger.hilt.android.AndroidEntryPoint

@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            UnbiasedTheme {
                Scaffold { padding ->
                    val viewModel: FeedViewModel = hiltViewModel()
                    val uiState by viewModel.uiState.collectAsState()
                    FeedScreen(uiState = uiState, modifier = Modifier.padding(padding))
                }
            }
        }
    }
}

@Composable
fun FeedScreen(uiState: FeedUiState, modifier: Modifier = Modifier) {
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
                Text(text = "No stories yet.")
            }
        }
        else -> {
            LazyColumn(modifier = modifier.fillMaxSize()) {
                items(uiState.stories, key = { it.id }) { story ->
                    StoryCard(story)
                }
            }
        }
    }
}

@Composable
fun StoryCard(story: StoryClusterEntity, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier.padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        Text(text = story.category ?: "Uncategorized")
        Text(text = story.headline)
        Text(text = story.summary)
        Text(text = "${story.sourceCount} sources")
    }
}

@Preview(showBackground = true)
@Composable
fun StoryCardPreview() {
    UnbiasedTheme {
        StoryCard(
            StoryClusterEntity(
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
            )
        )
    }
}
