const cron = require('node-cron');
const { getPendingReminders, markReminderSent, incrementRetry } = require('./reminderService');
const { monitorUpcomingFlights } = require('./flightMonitor');
const { sendText } = require('./whatsapp');
const templates = require('../utils/messageTemplates');
const { DateTime } = require('luxon');

/**
 * Procesa los recordatorios pendientes
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
          await markReminderSent(reminder.id, 0);
          continue;
        }

        const originTimezone = flight.metadata?.origin_timezone || 'UTC';
        const departureLocal = DateTime
          .fromISO(flight.departure_datetime)
          .setZone(originTimezone)
          .toFormat('dd/MM/yyyy HH:mm');

        const flightInfo = {
          flight_number: flight.flight_number,
          departure_local: departureLocal,
          checkin_link: flight.checkin_link
        };

        await sendText(phone, templates.checkinAlert(flightInfo));
        await markReminderSent(reminder.id, 200);

        console.log(`[Cron] ✅ Alerta enviada a ${phone} — vuelo ${flight.flight_number}`);
      } catch (err) {
        console.error(`[Cron] ❌ Error reminder ${reminder.id}:`, err.message);
        await incrementRetry(reminder.id, err.message);
      }
    }
  } catch (err) {
    console.error('[Cron] ❌ Error general:', err.message);
  }
}

/**
 * Inicia los crons internos
 */
function startInternalCron() {
  // Recordatorios: cada 2 minutos
  cron.schedule('*/2 * * * *', () => {
    processReminders();
  });
  console.log('⏰ Cron recordatorios iniciado (cada 2 minutos)');

  // Monitor de vuelos: cada 30 minutos (para ahorrar llamadas de API)
  cron.schedule('*/30 * * * *', () => {
    monitorUpcomingFlights();
  });
  console.log('🔍 Cron monitor de vuelos iniciado (cada 30 minutos)');
}

module.exports = { processReminders, startInternalCron };