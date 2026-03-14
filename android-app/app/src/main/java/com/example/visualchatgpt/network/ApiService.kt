package com.example.visualchatgpt.network

import com.google.gson.Gson
import com.google.gson.annotations.SerializedName
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.logging.HttpLoggingInterceptor
import java.util.concurrent.TimeUnit

data class ChatRequest(
    @SerializedName("text") val text: String,
    @SerializedName("image") val image: String? = null,
    @SerializedName("state") val state: List<Any> = emptyList(),
    @SerializedName("lang") val lang: String = "English"
)

data class ChatResponse(
    @SerializedName("response") val response: String?,
    @SerializedName("image") val image: String?,
    @SerializedName("state") val state: List<Any>?,
    @SerializedName("error") val error: String?
)

class ApiService(private val baseUrl: String) {

    private val gson = Gson()
    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .addInterceptor(HttpLoggingInterceptor().apply {
            level = HttpLoggingInterceptor.Level.BODY
        })
        .build()

    fun sendMessage(
        text: String,
        imageBase64: String? = null,
        state: List<Any> = emptyList(),
        lang: String = "English"
    ): ChatResponse {
        val request = ChatRequest(
            text = text,
            image = imageBase64,
            state = state,
            lang = lang
        )

        val json = gson.toJson(request)
        val body = json.toRequestBody("application/json".toMediaType())

        val httpRequest = Request.Builder()
            .url("$baseUrl/api/chat")
            .post(body)
            .build()

        val response = client.newCall(httpRequest).execute()
        val responseBody = response.body?.string() ?: throw Exception("Empty response")

        if (!response.isSuccessful) {
            throw Exception("HTTP ${response.code}: $responseBody")
        }

        return gson.fromJson(responseBody, ChatResponse::class.java)
    }

    fun checkHealth(): Boolean {
        return try {
            val request = Request.Builder()
                .url("$baseUrl/")
                .get()
                .build()
            val response = client.newCall(request).execute()
            response.isSuccessful
        } catch (e: Exception) {
            false
        }
    }
}
