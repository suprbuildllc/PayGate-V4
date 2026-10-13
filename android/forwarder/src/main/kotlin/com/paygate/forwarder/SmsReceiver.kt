package com.paygate.forwarder

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.util.Log

class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Telephony.Sms.Intents.SMS_RECEIVED_ACTION) {
            val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent)
            if (messages.isNullOrEmpty()) return

            val sender = messages[0].displayOriginatingAddress ?: ""
            val fullBody = messages.joinToString("") { it.displayMessageBody ?: "" }
            val simSlot = intent.getIntExtra("simId", intent.getIntExtra("slot", 1))

            Log.i("PayGateSmsReceiver", "SMS received from $sender (SIM slot $simSlot)")

            val serviceIntent = Intent(context, ForwarderService::class.java).apply {
                putExtra("sender", sender)
                putExtra("raw_sms", fullBody)
                putExtra("sim_slot", simSlot)
            }
            context.startForegroundService(serviceIntent)
        }
    }
}
