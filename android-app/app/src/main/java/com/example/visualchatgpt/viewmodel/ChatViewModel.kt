package com.example.visualchatgpt.viewmodel

import android.graphics.Bitmap
import android.util.Base64
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.visualchatgpt.model.ChatMessage
import com.example.visualchatgpt.network.ApiService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream

sealed class ChatUiState {
    object Idle : ChatUiState()
    object Loading : ChatUiState()
    data class Error(val message: String) : ChatUiState()
}

class ChatViewModel : ViewModel() {

    private val _messages = MutableLiveData<List<ChatMessage>>(emptyList())
    val messages: LiveData<List<ChatMessage>> = _messages

    private val _uiState = MutableLiveData<ChatUiState>(ChatUiState.Idle)
    val uiState: LiveData<ChatUiState> = _uiState

    private var apiService: ApiService? = null
    private var currentState: List<Any> = emptyList()
    var language: String = "English"

    fun setServerUrl(url: String) {
        apiService = if (url.isNotBlank()) ApiService(url.trimEnd('/')) else null
    }

    fun sendMessage(text: String, imageBitmap: Bitmap? = null) {
        val service = apiService ?: run {
            _uiState.value = ChatUiState.Error("no_server")
            return
        }

        val imageBase64 = imageBitmap?.toBase64()

        // Add user message
        val userMessage = ChatMessage(
            content = text,
            imageBase64 = imageBase64,
            isUser = true
        )
        addMessage(userMessage)

        // Add thinking placeholder
        val thinkingMessage = ChatMessage(
            content = "...",
            isUser = false
        )
        addMessage(thinkingMessage)

        _uiState.value = ChatUiState.Loading

        viewModelScope.launch {
            try {
                val response = withContext(Dispatchers.IO) {
                    service.sendMessage(
                        text = text,
                        imageBase64 = imageBase64,
                        state = currentState,
                        lang = language
                    )
                }

                // Remove thinking placeholder
                removeLastMessage()

                if (response.error != null) {
                    _uiState.value = ChatUiState.Error(response.error)
                    return@launch
                }

                currentState = response.state ?: emptyList()

                val botMessage = ChatMessage(
                    content = response.response ?: "",
                    imageBase64 = response.image,
                    isUser = false
                )
                addMessage(botMessage)
                _uiState.value = ChatUiState.Idle

            } catch (e: Exception) {
                removeLastMessage()
                _uiState.value = ChatUiState.Error(e.message ?: "Unknown error")
            }
        }
    }

    fun clearChat() {
        _messages.value = emptyList()
        currentState = emptyList()
    }

    private fun addMessage(message: ChatMessage) {
        val current = _messages.value?.toMutableList() ?: mutableListOf()
        current.add(message)
        _messages.value = current
    }

    private fun removeLastMessage() {
        val current = _messages.value?.toMutableList() ?: return
        if (current.isNotEmpty()) {
            current.removeLast()
            _messages.value = current
        }
    }

    private fun Bitmap.toBase64(): String {
        val byteArrayOutputStream = ByteArrayOutputStream()
        compress(Bitmap.CompressFormat.JPEG, 80, byteArrayOutputStream)
        val byteArray = byteArrayOutputStream.toByteArray()
        return Base64.encodeToString(byteArray, Base64.DEFAULT)
    }
}
