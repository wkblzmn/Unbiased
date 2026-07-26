package com.wakib.unbiased.ui.feed

// Matches the whitelist Gemini classifies against server-side (see
// unbiased-backend summarizer prompt). Keep in sync if the backend taxonomy
// changes — there is no server endpoint that exposes this list.
val FEED_CATEGORIES = listOf(
    "Politics",
    "Economics",
    "International",
    "Sports",
    "Technology",
    "Crime",
    "Environment",
    "Health",
    "Education",
    "Other"
)
