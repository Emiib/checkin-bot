// src/services/scheduler.js
// Gestiona los recordatorios programados de check-in

const cron = require('node-cron');
const { sendCheckinReminder } = require('./whatsapp');

// Almacén en memoria de recordatorios activos
// Clave: id único del recordatorio
// En producción puedes reemplazarlo por Firebase o Supabase
const activeReminders = new Map();

/**
 * Genera un ID único para cada recordatorio
 */
function generateId() {
  return `reminder_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Convierte una fecha al formato cron: minuto hora día mes *
 */
function dateToCron(date) {
  const min = date.getMinutes();
  const hour = date.getHours();
  const day = date.getDate();
  const month = date.getMonth() + 1;
  return `${min} ${hour} ${day} ${month} *`;
}

/**
 * Programa un recordatorio de check-in
 * @param {string} phoneNumber - Número de WhatsApp del agente
 * @param {object} checkinInfo - Info completa del check-in (de getCheckinInfo)
 * @returns {string} - ID del recordatorio creado
 */
function scheduleCheckinReminder(phoneNumber, checkinInfo) {
  const { checkin_open_date, compania, numero_reserva } = checkinInfo;

  const ahora = new Date();

  // Si ya pasó el momento del check-in, no programamos
  if (checkin_open_date <= ahora) {
    console.log(`[Scheduler] Check-in de ${compania} ya está disponible, no se programa recordatorio.`);
    return null;
  }

  const id = generateId();
  const cronExpression = dateToCron(checkin_open_date);

  console.log(`[Scheduler] Programando recordatorio: ${id}`);
  console.log(`[Scheduler] Compañía: ${compania} | Reserva: ${numero_reserva}`);
  console.log(`[Scheduler] Se enviará el: ${checkin_open_date.toLocaleString('es-ES')}`);
  console.log(`[Scheduler] Cron: ${cronExpression}`);

  const task = cron.schedule(cronExpression, async () => {
    try {
      console.log(`[Scheduler] Enviando recordatorio ${id} a ${phoneNumber}`);
      await sendCheckinReminder(phoneNumber, checkinInfo);
      console.log(`[Scheduler] Recordatorio ${id} enviado correctamente ✅`);

      // Cancelar la tarea tras ejecutarse (no es recurrente)
      task.stop();
      activeReminders.delete(id);

    } catch (error) {
      console.error(`[Scheduler] Error enviando recordatorio ${id}:`, error.message);
    }
  }, {
    timezone: 'Europe/Madrid'
  });

  // Guardamos el recordatorio activo
  activeReminders.set(id, {
    id,
    phoneNumber,
    checkinInfo,
    checkin_open_date,
    task,
    createdAt: new Date()
  });

  return id;
}

/**
 * Cancela un recordatorio activo
 * @param {string} id - ID del recordatorio
 */
function cancelReminder(id) {
  const reminder = activeReminders.get(id);
  if (reminder) {
    reminder.task.stop();
    activeReminders.delete(id);
    console.log(`[Scheduler] Recordatorio ${id} cancelado.`);
    return true;
  }
  return false;
}

/**
 * Lista todos los recordatorios activos (para debug)
 */
function listReminders() {
  const list = [];
  activeReminders.forEach((reminder) => {
    list.push({
      id: reminder.id,
      compania: reminder.checkinInfo.compania,
      numero_reserva: reminder.checkinInfo.numero_reserva,
      checkin_abre: reminder.checkin_open_date.toLocaleString('es-ES'),
      phoneNumber: reminder.phoneNumber
    });
  });
  return list;
}

module.exports = { scheduleCheckinReminder, cancelReminder, listReminders };
