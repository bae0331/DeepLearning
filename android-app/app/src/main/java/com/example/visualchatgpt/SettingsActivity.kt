package com.example.visualchatgpt

import android.os.Bundle
import android.widget.ArrayAdapter
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.example.visualchatgpt.databinding.ActivitySettingsBinding

class SettingsActivity : AppCompatActivity() {

    private lateinit var binding: ActivitySettingsBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivitySettingsBinding.inflate(layoutInflater)
        setContentView(binding.root)

        setSupportActionBar(binding.toolbar)
        binding.toolbar.setNavigationOnClickListener { onBackPressedDispatcher.onBackPressed() }

        setupLanguageSpinner()
        loadSettings()

        binding.btnSave.setOnClickListener {
            saveSettings()
        }
    }

    private fun setupLanguageSpinner() {
        val languages = arrayOf("English", "Chinese")
        val adapter = ArrayAdapter(this, android.R.layout.simple_dropdown_item_1line, languages)
        binding.spinnerLanguage.setAdapter(adapter)
        binding.spinnerLanguage.setText("English", false)
    }

    private fun loadSettings() {
        val prefs = getSharedPreferences("settings", MODE_PRIVATE)
        binding.editServerUrl.setText(prefs.getString("server_url", ""))
        binding.editApiKey.setText(prefs.getString("api_key", ""))
        val lang = prefs.getString("language", "English") ?: "English"
        binding.spinnerLanguage.setText(lang, false)
    }

    private fun saveSettings() {
        val serverUrl = binding.editServerUrl.text?.toString()?.trim() ?: ""
        val apiKey = binding.editApiKey.text?.toString()?.trim() ?: ""
        val language = binding.spinnerLanguage.text?.toString() ?: "English"

        getSharedPreferences("settings", MODE_PRIVATE).edit().apply {
            putString("server_url", serverUrl)
            putString("api_key", apiKey)
            putString("language", language)
            apply()
        }

        Toast.makeText(this, R.string.settings_saved, Toast.LENGTH_SHORT).show()
        finish()
    }
}
