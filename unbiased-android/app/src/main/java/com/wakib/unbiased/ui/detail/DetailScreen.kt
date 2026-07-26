package com.wakib.unbiased.ui.detail

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.wakib.unbiased.data.local.entity.SourceEntity

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DetailScreen(
    uiState: StoryDetailUiState,
    onBack: () -> Unit,
    modifier: Modifier = Modifier
) {
    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = { Text(uiState.story?.category ?: "Story") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                }
            )
        }
    ) { padding ->
        val story = uiState.story
        when {
            story == null && uiState.isLoading -> {
                Box(Modifier.padding(padding).fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            }
            story == null -> {
                Box(Modifier.padding(padding).fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text("Story not found.")
                }
            }
            else -> {
                LazyColumn(modifier = Modifier.padding(padding).fillMaxSize()) {
                    item {
                        Column(Modifier.padding(16.dp)) {
                            Text(
                                text = story.headline,
                                style = MaterialTheme.typography.headlineSmall,
                                fontWeight = FontWeight.Bold
                            )
                            Text(
                                text = story.summary,
                                style = MaterialTheme.typography.bodyLarge,
                                modifier = Modifier.padding(top = 12.dp)
                            )
                        }
                        HorizontalDivider()
                        Text(
                            text = "Sources (${story.sourceCount})",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold,
                            modifier = Modifier.padding(16.dp)
                        )
                    }
                    if (uiState.error != null && uiState.sources.isEmpty()) {
                        item {
                            Text(
                                text = "Couldn't load sources: ${uiState.error}",
                                modifier = Modifier.padding(horizontal = 16.dp)
                            )
                        }
                    }
                    items(uiState.sources, key = { it.articleId }) { source ->
                        SourceRow(source)
                    }
                }
            }
        }
    }
}

@Composable
private fun SourceRow(source: SourceEntity, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    Card(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 6.dp)
            .clickable {
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(source.url)))
            }
    ) {
        Column(Modifier.padding(12.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(Modifier.weight(1f)) {
                    Text(text = source.sourceName, fontWeight = FontWeight.Bold)
                    Text(text = source.title, style = MaterialTheme.typography.bodyMedium)
                }
                Icon(Icons.AutoMirrored.Filled.OpenInNew, contentDescription = "Open source", modifier = Modifier.padding(start = 8.dp))
            }
            Row(
                modifier = Modifier.padding(top = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                source.biasLabel?.let { bias ->
                    SuggestionChip(onClick = {}, label = { Text(bias) })
                }
                if (!source.hasBody) {
                    LinkOnlyBadge()
                }
            }
        }
    }
}

// The link-only marker. This outlet's headline, URL and bias label are real,
// but its article text never fed the summary (feed_cluster_sources.has_body
// = false) — either the article page 403'd, or only an RSS teaser existed.
// Rendering this the same as a corroborating source would be exactly the
// dishonesty this product exists to oppose.
@Composable
private fun LinkOnlyBadge(modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .background(
                color = MaterialTheme.colorScheme.surfaceVariant,
                shape = RoundedCornerShape(4.dp)
            )
            .padding(horizontal = 8.dp, vertical = 4.dp)
    ) {
        Text(
            text = "Link only — full text not retrievable",
            style = MaterialTheme.typography.labelSmall,
            fontStyle = FontStyle.Italic,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}
