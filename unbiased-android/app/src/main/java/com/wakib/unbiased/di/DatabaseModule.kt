package com.wakib.unbiased.di

import android.content.Context
import androidx.room.Room
import com.wakib.unbiased.data.local.AppDatabase
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
        return Room.databaseBuilder(context, AppDatabase::class.java, "unbiased.db").build()
    }

    @Provides
    fun provideStoryClusterDao(db: AppDatabase): StoryClusterDao = db.storyClusterDao()

    @Provides
    fun provideSourceDao(db: AppDatabase): SourceDao = db.sourceDao()
}
