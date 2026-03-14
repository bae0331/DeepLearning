package com.example.visualchatgpt.adapter

import android.graphics.BitmapFactory
import android.util.Base64
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.bumptech.glide.Glide
import com.example.visualchatgpt.R
import com.example.visualchatgpt.model.ChatMessage

class ChatAdapter : ListAdapter<ChatMessage, RecyclerView.ViewHolder>(DiffCallback()) {

    companion object {
        private const val VIEW_TYPE_USER = 0
        private const val VIEW_TYPE_BOT = 1
    }

    override fun getItemViewType(position: Int): Int {
        return if (getItem(position).isUser) VIEW_TYPE_USER else VIEW_TYPE_BOT
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
        return if (viewType == VIEW_TYPE_USER) {
            val view = LayoutInflater.from(parent.context)
                .inflate(R.layout.item_message_user, parent, false)
            UserViewHolder(view)
        } else {
            val view = LayoutInflater.from(parent.context)
                .inflate(R.layout.item_message_bot, parent, false)
            BotViewHolder(view)
        }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        val message = getItem(position)
        when (holder) {
            is UserViewHolder -> holder.bind(message)
            is BotViewHolder -> holder.bind(message)
        }
    }

    inner class UserViewHolder(itemView: View) : RecyclerView.ViewHolder(itemView) {
        private val textMessage: TextView = itemView.findViewById(R.id.textMessage)
        private val textTime: TextView = itemView.findViewById(R.id.textTime)
        private val imageAttachment: ImageView = itemView.findViewById(R.id.imageAttachment)

        fun bind(message: ChatMessage) {
            textMessage.text = message.content
            textTime.text = message.getFormattedTime()

            if (message.imageBase64 != null) {
                imageAttachment.visibility = View.VISIBLE
                val bytes = Base64.decode(message.imageBase64, Base64.DEFAULT)
                val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                imageAttachment.setImageBitmap(bitmap)
            } else {
                imageAttachment.visibility = View.GONE
            }
        }
    }

    inner class BotViewHolder(itemView: View) : RecyclerView.ViewHolder(itemView) {
        private val textMessage: TextView = itemView.findViewById(R.id.textMessage)
        private val textTime: TextView = itemView.findViewById(R.id.textTime)
        private val imageResponse: ImageView = itemView.findViewById(R.id.imageResponse)

        fun bind(message: ChatMessage) {
            textMessage.text = message.content
            textTime.text = message.getFormattedTime()

            when {
                message.imageUrl != null -> {
                    imageResponse.visibility = View.VISIBLE
                    Glide.with(itemView.context)
                        .load(message.imageUrl)
                        .into(imageResponse)
                }
                message.imageBase64 != null -> {
                    imageResponse.visibility = View.VISIBLE
                    val bytes = Base64.decode(message.imageBase64, Base64.DEFAULT)
                    val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                    imageResponse.setImageBitmap(bitmap)
                }
                else -> {
                    imageResponse.visibility = View.GONE
                }
            }
        }
    }

    private class DiffCallback : DiffUtil.ItemCallback<ChatMessage>() {
        override fun areItemsTheSame(oldItem: ChatMessage, newItem: ChatMessage) =
            oldItem.id == newItem.id

        override fun areContentsTheSame(oldItem: ChatMessage, newItem: ChatMessage) =
            oldItem == newItem
    }
}
