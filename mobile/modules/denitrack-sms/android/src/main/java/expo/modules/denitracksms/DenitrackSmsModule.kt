package expo.modules.denitracksms

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Telephony
import android.telephony.SmsManager
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Reads M-Pesa confirmations from the SMS inbox and sends reminder SMS from the phone's SIM.
 * Permissions (READ_SMS, SEND_SMS) are requested from JavaScript before these are called.
 */
class DenitrackSmsModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("ERR_NO_CONTEXT", "Android is not ready yet", null)

  override fun definition() = ModuleDefinition {
    Name("DenitrackSms")

    // Inbox messages from the given senders (e.g. "MPESA") received after sinceMs, oldest first.
    AsyncFunction("readInbox") { senders: List<String>, sinceMs: Double, limit: Int ->
      val wanted = senders.map { it.uppercase() }.toSet()
      val found = mutableListOf<Map<String, Any>>()
      context.contentResolver.query(
        Telephony.Sms.Inbox.CONTENT_URI,
        arrayOf(Telephony.Sms._ID, Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE),
        "${Telephony.Sms.DATE} > ?",
        arrayOf(sinceMs.toLong().toString()),
        "${Telephony.Sms.DATE} ASC"
      )?.use { c ->
        val idCol = c.getColumnIndexOrThrow(Telephony.Sms._ID)
        val addressCol = c.getColumnIndexOrThrow(Telephony.Sms.ADDRESS)
        val bodyCol = c.getColumnIndexOrThrow(Telephony.Sms.BODY)
        val dateCol = c.getColumnIndexOrThrow(Telephony.Sms.DATE)
        while (found.size < limit && c.moveToNext()) {
          val address = c.getString(addressCol) ?: continue
          if (address.trim().uppercase() !in wanted) continue
          found.add(
            mapOf(
              "id" to c.getLong(idCol).toString(),
              "address" to address,
              "body" to (c.getString(bodyCol) ?: ""),
              "date" to c.getLong(dateCol).toDouble()
            )
          )
        }
      }
      found
    }

    // Sends one SMS (split into parts if long). Resolves "sent", or "unconfirmed" if the
    // radio never reports back within a minute (treated as sent, so it is never sent twice).
    AsyncFunction("sendSms") { phone: String, message: String, promise: Promise ->
      val ctx = context
      val manager: SmsManager = smsManager(ctx)
        ?: throw CodedException("ERR_SMS_UNAVAILABLE", "This phone cannot send SMS", null)
      val parts = manager.divideMessage(message)
      val action = "ke.denitrack.SMS_SENT." + UUID.randomUUID().toString()
      val remaining = AtomicInteger(parts.size)
      val settled = AtomicBoolean(false)
      val handler = Handler(Looper.getMainLooper())
      lateinit var receiver: BroadcastReceiver
      lateinit var timeout: Runnable

      fun settle(outcome: String?, error: String?) {
        if (!settled.compareAndSet(false, true)) return
        runCatching { handler.removeCallbacks(timeout) }
        runCatching { ctx.unregisterReceiver(receiver) }
        if (error != null) promise.reject("ERR_SMS_SEND", error, null) else promise.resolve(outcome)
      }

      receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context?, intent: Intent?) {
          if (resultCode != Activity.RESULT_OK) {
            settle(null, describe(resultCode))
          } else if (remaining.decrementAndGet() == 0) {
            settle("sent", null)
          }
        }
      }
      ContextCompat.registerReceiver(ctx, receiver, IntentFilter(action), ContextCompat.RECEIVER_NOT_EXPORTED)
      val sentIntents = ArrayList<PendingIntent>()
      for (i in parts.indices) {
        val intent = Intent(action).setPackage(ctx.packageName)
        sentIntents.add(
          PendingIntent.getBroadcast(ctx, i, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_ONE_SHOT)
        )
      }
      timeout = Runnable { settle("unconfirmed", null) }
      handler.postDelayed(timeout, 60_000)
      try {
        if (parts.size <= 1) {
          manager.sendTextMessage(phone, null, message, sentIntents[0], null)
        } else {
          manager.sendMultipartTextMessage(phone, null, parts, sentIntents, null)
        }
      } catch (e: Exception) {
        settle(null, e.message ?: "The SMS could not be sent")
      }
    }
  }

  private fun smsManager(ctx: Context): SmsManager? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      ctx.getSystemService(SmsManager::class.java)
    } else {
      @Suppress("DEPRECATION")
      SmsManager.getDefault()
    }

  private fun describe(code: Int): String = when (code) {
    SmsManager.RESULT_ERROR_NO_SERVICE -> "No mobile network. The SMS was not sent."
    SmsManager.RESULT_ERROR_RADIO_OFF -> "Airplane mode is on. The SMS was not sent."
    SmsManager.RESULT_ERROR_NULL_PDU, SmsManager.RESULT_ERROR_GENERIC_FAILURE ->
      "The SMS could not be sent. Check the phone has airtime or an SMS bundle."
    else -> "The SMS could not be sent (error $code)."
  }
}
