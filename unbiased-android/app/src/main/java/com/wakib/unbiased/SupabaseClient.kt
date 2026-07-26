package com.wakib.unbiased

import okhttp3.Interceptor
import okhttp3.OkHttpClient
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory

object SupabaseClient {
    private val headerInterceptor = Interceptor { chain ->
        val request = chain.request().newBuilder()
            .addHeader("apikey", BuildConfig.SUPABASE_ANON_KEY)
            .addHeader("Authorization", "Bearer ${BuildConfig.SUPABASE_ANON_KEY}")
            .build()
        chain.proceed(request)
    }

    private val client = OkHttpClient.Builder()
        .addInterceptor(headerInterceptor)
        .build()

    val api: SupabaseApi = Retrofit.Builder()
        .baseUrl(BuildConfig.SUPABASE_URL)
        .client(client)
        .addConverterFactory(GsonConverterFactory.create())
        .build()
        .create(SupabaseApi::class.java)
}