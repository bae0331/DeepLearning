package com.example.visualchatgpt

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.view.MenuItem
import android.view.View
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.LinearLayoutManager
import com.example.visualchatgpt.adapter.ChatAdapter
import com.example.visualchatgpt.databinding.ActivityMainBinding
import com.example.visualchatgpt.model.ChatMessage
import com.example.visualchatgpt.viewmodel.ChatUiState
import com.example.visualchatgpt.viewmodel.ChatViewModel

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private val viewModel: ChatViewModel by viewModels()
    private lateinit var chatAdapter: ChatAdapter
    private var selectedImageBitmap: Bitmap? = null

    private val pickImageLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == RESULT_OK) {
            result.data?.data?.let { uri ->
                loadImageFromUri(uri)
            }
        }
    }

    private val requestPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) openImagePicker()
        else Toast.makeText(this, "이미지 접근 권한이 필요합니다.", Toast.LENGTH_SHORT).show()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        setupToolbar()
        setupRecyclerView()
        setupInputArea()
        observeViewModel()
        loadSettings()

        // Show welcome message if no messages
        if (viewModel.messages.value.isNullOrEmpty()) {
            viewModel // trigger init - welcome shown via settings load
        }
    }

    private fun setupToolbar() {
        setSupportActionBar(binding.toolbar)
        supportActionBar?.setDisplayShowTitleEnabled(true)
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        return when (item.itemId) {
            R.id.action_settings -> {
                startActivity(Intent(this, SettingsActivity::class.java))
                true
            }
            R.id.action_clear -> {
                showClearConfirmDialog()
                true
            }
            else -> super.onOptionsItemSelected(item)
        }
    }

    private fun setupRecyclerView() {
        chatAdapter = ChatAdapter()
        binding.recyclerView.apply {
            adapter = chatAdapter
            layoutManager = LinearLayoutManager(this@MainActivity).apply {
                stackFromEnd = true
            }
        }
    }

    private fun setupInputArea() {
        binding.btnSend.setOnClickListener {
            val text = binding.editTextMessage.text?.toString()?.trim() ?: ""
            if (text.isEmpty() && selectedImageBitmap == null) return@setOnClickListener

            val displayText = if (text.isEmpty()) "[이미지 전송]" else text
            viewModel.sendMessage(displayText, selectedImageBitmap)

            binding.editTextMessage.setText("")
            clearSelectedImage()
        }

        binding.btnAttachImage.setOnClickListener {
            checkAndRequestPermission()
        }

        binding.btnRemoveImage.setOnClickListener {
            clearSelectedImage()
        }
    }

    private fun observeViewModel() {
        viewModel.messages.observe(this) { messages ->
            chatAdapter.submitList(messages.toList()) {
                if (messages.isNotEmpty()) {
                    binding.recyclerView.smoothScrollToPosition(messages.size - 1)
                }
            }
        }

        viewModel.uiState.observe(this) { state ->
            when (state) {
                is ChatUiState.Loading -> {
                    binding.btnSend.isEnabled = false
                }
                is ChatUiState.Idle -> {
                    binding.btnSend.isEnabled = true
                }
                is ChatUiState.Error -> {
                    binding.btnSend.isEnabled = true
                    val message = when (state.message) {
                        "no_server" -> getString(R.string.error_no_server)
                        else -> getString(R.string.error_api, state.message)
                    }
                    Toast.makeText(this, message, Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun loadSettings() {
        val prefs = getSharedPreferences("settings", MODE_PRIVATE)
        val serverUrl = prefs.getString("server_url", "") ?: ""
        val lang = prefs.getString("language", "English") ?: "English"

        viewModel.setServerUrl(serverUrl)
        viewModel.language = lang

        // Show welcome message
        if (viewModel.messages.value.isNullOrEmpty()) {
            val welcome = ChatMessage(
                content = getString(R.string.welcome_message),
                isUser = false
            )
            // Add directly via adapter for display
            chatAdapter.submitList(listOf(welcome))
        }
    }

    override fun onResume() {
        super.onResume()
        loadSettings()
    }

    private fun checkAndRequestPermission() {
        val permission = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            Manifest.permission.READ_MEDIA_IMAGES
        } else {
            Manifest.permission.READ_EXTERNAL_STORAGE
        }

        when {
            ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED -> {
                openImagePicker()
            }
            else -> requestPermissionLauncher.launch(permission)
        }
    }

    private fun openImagePicker() {
        val intent = Intent(Intent.ACTION_PICK, MediaStore.Images.Media.EXTERNAL_CONTENT_URI)
        pickImageLauncher.launch(intent)
    }

    private fun loadImageFromUri(uri: Uri) {
        try {
            val bitmap = MediaStore.Images.Media.getBitmap(contentResolver, uri)
            selectedImageBitmap = scaleBitmap(bitmap, 512)
            binding.imagePreview.setImageBitmap(selectedImageBitmap)
            binding.previewContainer.visibility = View.VISIBLE
        } catch (e: Exception) {
            Toast.makeText(this, "이미지를 불러올 수 없습니다.", Toast.LENGTH_SHORT).show()
        }
    }

    private fun scaleBitmap(bitmap: Bitmap, maxSize: Int): Bitmap {
        val width = bitmap.width
        val height = bitmap.height
        val ratio = minOf(maxSize.toFloat() / width, maxSize.toFloat() / height)
        if (ratio >= 1f) return bitmap
        return Bitmap.createScaledBitmap(
            bitmap,
            (width * ratio).toInt(),
            (height * ratio).toInt(),
            true
        )
    }

    private fun clearSelectedImage() {
        selectedImageBitmap = null
        binding.imagePreview.setImageBitmap(null)
        binding.previewContainer.visibility = View.GONE
    }

    private fun showClearConfirmDialog() {
        AlertDialog.Builder(this)
            .setTitle(R.string.clear_chat)
            .setMessage(R.string.clear_chat_confirm)
            .setPositiveButton(R.string.confirm) { _, _ -> viewModel.clearChat() }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }
}
