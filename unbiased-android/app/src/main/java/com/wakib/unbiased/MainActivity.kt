package com.wakib.unbiased

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.wakib.unbiased.ui.bookmarks.BookmarksScreen
import com.wakib.unbiased.ui.bookmarks.BookmarksViewModel
import com.wakib.unbiased.ui.detail.DetailScreen
import com.wakib.unbiased.ui.detail.DetailViewModel
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
                            },
                            onOpenBookmarks = { navController.navigate("bookmarks") }
                        )
                    }
                    composable(
                        route = "detail/{clusterId}",
                        arguments = listOf(navArgument("clusterId") { type = NavType.StringType })
                    ) {
                        val viewModel: DetailViewModel = hiltViewModel()
                        val uiState by viewModel.uiState.collectAsState()
                        DetailScreen(
                            uiState = uiState,
                            onBack = { navController.popBackStack() },
                            onToggleBookmark = viewModel::toggleBookmark
                        )
                    }
                    composable("bookmarks") {
                        val viewModel: BookmarksViewModel = hiltViewModel()
                        val bookmarks by viewModel.bookmarks.collectAsState()
                        BookmarksScreen(
                            bookmarks = bookmarks,
                            onBack = { navController.popBackStack() },
                            onStoryClick = { clusterId ->
                                navController.navigate("detail/$clusterId")
                            }
                        )
                    }
                }
            }
        }
    }
}
