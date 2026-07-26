package com.wakib.unbiased

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.wakib.unbiased.ui.theme.UnbiasedTheme
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            var stories by remember { mutableStateOf<List<StoryCluster>>(emptyList()) }

            LaunchedEffect(Unit) {
                stories = SupabaseClient.api.getFeed()
            }

            LazyColumn {
                items(stories) { story ->
                    StoryCard(
                        headline = story.headline,
                        summary = story.summary,
                        category = story.category ?: "Uncategorized"
                    )
                }
            }
        }
    }
}

@Composable
fun StoryCard(
    headline: String,
    summary: String,
    category: String,
    modifier: Modifier = Modifier
) {
    Column(modifier = modifier.padding(16.dp)) {
        Text(text = category)
        Text(text = headline)
        Text(text = summary)
    }
}

@Preview(showBackground = true)
@Composable
fun StoryCardPreview() {
    UnbiasedTheme {
        StoryCard(
            category = "Environment",
            headline = "Flood risk grows in Sylhet and Sunamganj regions",
            summary = "The National Disaster Response Coordination Centre and the " +
                    "Flood Forecasting and Warning Centre have warned that flood " +
                    "conditions in Sylhet and Sunamganj may deteriorate over the " +
                    "next 48 hours."
        )
    }
}