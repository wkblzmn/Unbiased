package com.wakib.unbiased.di

import com.wakib.unbiased.BuildConfig
import com.wakib.unbiased.data.remote.SupabaseApi
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object NetworkModule {

    @Provides
    @Singleton
    fun provideOkHttpClient(): OkHttpClient {
        val authInterceptor = Interceptor { chain ->
            val request = chain.request().newBuilder()
                .addHeader("apikey", BuildConfig.SUPABASE_ANON_KEY)
                .addHeader("Authorization", "Bearer ${BuildConfig.SUPABASE_ANON_KEY}")
                .build()
            chain.proceed(request)
        }
        return OkHttpClient.Builder()
            .addInterceptor(authInterceptor)
            .build()
    }

    @Provides
    @Singleton
    fun provideSupabaseApi(client: OkHttpClient): SupabaseApi {
        // An empty/misconfigured SUPABASE_URL must not crash the app at
        // startup (Retrofit validates the base URL eagerly, before any
        // network call). Falling back to a syntactically valid placeholder
        // turns that into an ordinary failed-request error, which the
        // existing loading/error/empty UI states already handle.
        val configuredUrl = BuildConfig.SUPABASE_URL
        val baseUrl = if (configuredUrl.startsWith("http://") || configuredUrl.startsWith("https://")) {
            if (configuredUrl.endsWith("/")) configuredUrl else "$configuredUrl/"
        } else {
            "https://unconfigured.local/"
        }
        return Retrofit.Builder()
            .baseUrl(baseUrl)
            .client(client)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(SupabaseApi::class.java)
    }
}
