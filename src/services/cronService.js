const cron = require('node-cron');
const { getPendingReminders, markReminderSent, incrementRetry } = require('./reminderService');
const { sendText } = require('./whatsapp');
const templates = require('../utils/messageTemplates');
const { DateTime } = require('luxon');

/**
 * Procesa los recordatorios pendientes
 * Se ejecuta cada 2 minutos
 */
async function processReminders() {
  try {
    const reminders = await getPendingReminders();

    if (reminders.length === 0) return;

    console.log(`[Cron] ⏰ Procesando ${reminders.length} recordatorios...`);

    for (const reminder of reminders) {
      try {
        const phone = reminder.users?.phone_number;
        const flight = reminder.flights;

        if (!phone || !flight) {
          console.warn(`[Cron] ⚠️ Reminder ${reminder.id} sin datos válidos`);
          await markReminderSent(reminder.id, 0);
          continue;
        }

        // Formatear hora de salida en zona horaria del aeropuerto
        const originTimezone = flight.metadata?.origin_timezone || 'UTC';
        const departureLocal = DateTime
          .fromISO(flight.departure_datetime)
          .setZone(originTimezone)
          .toFormat('dd/MM/yyyy HH:mm');

        // Armar info del vuelo para el mensaje
        const flightInfo = {
          flight_number: flight.flight_number,
          departure_local: departureLocal,
          checkin_link: flight.checkin_link
        };

        // Enviar alerta al usuario
        await sendText(phone, templates.checkinAlert(flightInfo));
        await markReminderSent(reminder.id, 200);

        console.log(`[Cron] ✅ Alerta enviada a ${phone} — vuelo ${flight.flight_number}`);

      } catch (err) {
        console.error(`[Cron] ❌ Error procesando reminder ${reminder.id}:`, err.message);
        await incrementRetry(reminder.id, err.message);
      }
    }

  } catch (err) {
    console.error('[Cron] ❌ Error general:', err.message);
  }
}

/**
 * Inicia el cron interno (cada 2 minutos)
 */
function startInternalCron() {
  cron.schedule('*/2 * * * *', () => {
    processReminders();
  });
  console.log('⏰ Cron interno iniciado (cada 2 minutos)');
}

module.exports = { processReminders, startInternalCron };