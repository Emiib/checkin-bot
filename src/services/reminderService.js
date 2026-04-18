const { supabase } = require('../db/supabase');

/**
 * Crea un recordatorio de check-in en la base de datos
 */
async function createReminder(flightId, userId, scheduledAt) {
  // Verificar que no exista ya
  const { data: existing } = await supabase
    .from('checkin_events')
    .select('id')
    .eq('flight_id', flightId)
    .eq('event_type', 'scheduled')
    .single();

  if (existing) {
    console.log(`[Reminder] Ya existe recordatorio para flight ${flightId}`);
    return existing;
  }

  const { data, error } = await supabase
    .from('checkin_events')
    .insert({
      flight_id: flightId,
      user_id: userId,
      event_type: 'scheduled',
      scheduled_at: scheduledAt
    })
    .select()
    .single();

  if (error) {
    console.error('[DB] Error creando reminder:', error.message);
    throw error;
  }
  console.log(`[Reminder] ✅ Recordatorio creado para ${scheduledAt}`);
  return data;
}

/**
 * Obtiene recordatorios activos de un usuario
 */
async function getUserReminders(phoneNumber) {
  const { data: user } = await supabase
    .from('users')
    .select('id')
    .eq('phone_number', phoneNumber)
    .single();

  if (!user) return [];

  const { data, error } = await supabase
    .from('checkin_events')
    .select(`
      id,
      event_type,
      scheduled_at,
      sent_at,
      retry_count,
      flights (
        flight_number,
        origin,
        destination,
        departure_datetime,
        checkin_open_at,
        checkin_link,
        status,
        metadata
      )
    `)
    .eq('user_id', user.id)
    .eq('event_type', 'scheduled')
    .is('sent_at', null)
    .order('scheduled_at', { ascending: true });

  if (error) {
    console.error('[DB] Error obteniendo reminders:', error.message);
    return [];
  }

  return data || [];
}

/**
 * Obtiene recordatorios que ya deberían ejecutarse (para el cron)
 */
async function getPendingReminders() {
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('checkin_events')
    .select(`
      id,
      user_id,
      flight_id,
      scheduled_at,
      retry_count,
      users (
        phone_number,
        name,
        timezone
      ),
      flights (
        flight_number,
        origin,
        destination,
        departure_datetime,
        checkin_open_at,
        checkin_close_at,
        checkin_link,
        status,
        metadata
      )
    `)
    .eq('event_type', 'scheduled')
    .is('sent_at', null)
    .lte('scheduled_at', now)
    .lt('retry_count', 3)
    .order('scheduled_at', { ascending: true })
    .limit(50);

  if (error) {
    console.error('[DB] Error obteniendo pending reminders:', error.message);
    return [];
  }

  return data || [];
}

/**
 * Marca un recordatorio como enviado
 */
async function markReminderSent(reminderId, responseCode = 200) {
  const { error } = await supabase
    .from('checkin_events')
    .update({
      event_type: 'sent',
      sent_at: new Date().toISOString(),
      response_code: responseCode
    })
    .eq('id', reminderId);

  if (error) {
    console.error('[DB] Error marcando reminder como enviado:', error.message);
  }
}

/**
 * Incrementa el contador de reintentos
 */
async function incrementRetry(reminderId, errorBody = '') {
  const { data: current } = await supabase
    .from('checkin_events')
    .select('retry_count')
    .eq('id', reminderId)
    .single();

  await supabase
    .from('checkin_events')
    .update({
      retry_count: (current?.retry_count || 0) + 1,
      response_body: errorBody.substring(0, 1000)
    })
    .eq('id', reminderId);
}

/**
 * Cancela recordatorios de un vuelo
 */
async function cancelFlightReminders(flightId) {
  await supabase
    .from('checkin_events')
    .update({ event_type: 'cancelled' })
    .eq('flight_id', flightId)
    .eq('event_type', 'scheduled');
}

module.exports = {
  createReminder,
  getUserReminders,
  getPendingReminders,
  markReminderSent,
  incrementRetry,
  cancelFlightReminders
};