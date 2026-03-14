package com.example.visualchatgpt.model

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

data class ChatMessage(
    val id: Long = System.currentTimeMillis(),
    val content: String,
    val imageBase64: String? = null,
    val imageUrl: String? = null,
    val isUser: Boolean,
    val timestamp: Long = System.currentTimeMillis()
) {
    fun getFormattedTime(): String {
        val sdf = SimpleDateFormat("HH:mm", Locale.getDefault())
        return sdf.format(Date(timestamp))
    }
}
