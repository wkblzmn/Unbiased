package com.wakib.unbiased.di

import android.content.Context
import androidx.room.Room
import com.wakib.unbiased.data.local.AppDatabase
import com.wakib.unbiased.data.local.dao.BookmarkDao
import com.wakib.unbiased.data.local.dao.SourceDao
import com.wakib.unbiased.data.local.dao.StoryClusterDao
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object DatabaseModule {

    @Provides
    @Singleton
    fun provideAppDatabase(@ApplicationContext context: Context): AppDatabase {
        // Pre-1.0, no installed base to migrate. Everything here is a
        // reconstructible cache (refetched from the API) except bookmarks,
        // which are low-stakes enough not to warrant real migrations yet.
        return Room.databaseBuilder(context, AppDatabase::class.java, "unbiased.db")
            .fallbackToDestructiveMigration(true)
            .build()
    }

    @Provides
    fun provideStoryClusterDao(db: AppDatabase): StoryClusterDao = db.storyClusterDao()

    @Provides
    fun provideSourceDao(db: AppDatabase): SourceDao = db.sourceDao()

    @Provides
    fun provideBookmarkDao(db: AppDatabase): BookmarkDao = db.bookmarkDao()
}
