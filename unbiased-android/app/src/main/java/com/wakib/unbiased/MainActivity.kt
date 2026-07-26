package com.wakib.unbiased

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.wakib.unbiased.ui.feed.FeedScreen
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
                val navController = rememberNavController()
                NavHost(navController = navController, startDestination = "feed") {
                    composable("feed") {
                        val viewModel: FeedViewModel = hiltViewModel()
                        val uiState by viewModel.uiState.collectAsState()
                        FeedScreen(
                            uiState = uiState,
                            onSelectCategory = viewModel::selectCategory,
                            onRefresh = viewModel::refresh,
                            onStoryClick = { clusterId ->
                                navController.navigate("detail/$clusterId")
                            }
                        )
                    }
                    composable("detail/{clusterId}") {
                        // Story Detail screen lands next — full summary, every
                        // source with outlet name + bias label + link, and the
                        // link-only marker for outlets whose text never fed
                        // the summary (feed_cluster_sources.has_body).
                    }
                }
            }
        }
    }
}
