const { supabase } = require('../db/supabase');
const { DateTime } = require('luxon');

/**
 * Busca si ya existe un vuelo para este usuario con el mismo PNR
 * o el mismo número de vuelo en fecha cercana
 */
async function findExistingFlight(userId, ticketData) {
  // Buscar por PNR (más confiable)
  if (ticketData.numero_reserva) {
    const { data } = await supabase
      .from('flights')
      .select('*')
      .eq('user_id', userId)
      .contains('metadata', { numero_reserva: ticketData.numero_reserva })
      .not('status', 'eq', 'cancelled')
      .order('created_at', { ascending: false });

    if (data && data.length > 0) {
      // Si hay múltiples vuelos con el mismo PNR, buscar por número de vuelo
      if (ticketData.flight_number) {
        const match = data.find(f => f.flight_number === ticketData.flight_number);
        if (match) return match;
      }
      return data[0];
    }
  }

  // Buscar por número de vuelo + fecha cercana (±2 días)
  if (ticketData.flight_number && ticketData.fecha_salida) {
    const targetDate = DateTime.fromISO(ticketData.fecha_salida);
    const dateFrom = targetDate.minus({ days: 2 }).toISO();
    const dateTo = targetDate.plus({ days: 2 }).toISO();

    const { data } = await supabase
      .from('flights')
      .select('*')
      .eq('user_id', userId)
      .eq('flight_number', ticketData.flight_number)
      .gte('departure_datetime', dateFrom)
      .lte('departure_datetime', dateTo)
      .not('status', 'eq', 'cancelled')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    return data || null;
  }

  return null;
}

/**
 * Compara un vuelo existente con los datos nuevos y detecta cambios
 */
function detectChanges(existingFlight, newTicketData, newCheckinCalc) {
  const changes = [];

  // 1. Cambio de horario de salida
  const oldDeparture = DateTime.fromISO(existingFlight.departure_datetime).toUTC();
  const newDeparture = DateTime.fromISO(newCheckinCalc.utc.departureUTC).toUTC();

  if (oldDeparture.toISO() !== newDeparture.toISO()) {
    const diffMinutes = newDeparture.diff(oldDeparture, 'minutes').minutes;
    changes.push({
      type: diffMinutes > 0 ? 'delayed' : 'advanced',
      field: 'departure_datetime',
      oldValue: oldDeparture.toFormat('dd/MM/yyyy HH:mm'),
      newValue: newDeparture.toFormat('dd/MM/yyyy HH:mm'),
      diffMinutes: Math.round(diffMinutes)
    });
  }

  // 2. Cambio de número de vuelo
  if (newTicketData.flight_number &&
      existingFlight.flight_number !== newTicketData.flight_number) {
    changes.push({
      type: 'flight_number_changed',
      field: 'flight_number',
      oldValue: existingFlight.flight_number,
      newValue: newTicketData.flight_number
    });
  }

  // 3. Cambio de aeropuerto de origen
  const newOrigin = newTicketData.origen || newCheckinCalc.origin?.iata;
  if (newOrigin && existingFlight.origin !== newOrigin) {
    changes.push({
      type: 'origin_changed',
      field: 'origin',
      oldValue: existingFlight.origin,
      newValue: newOrigin
    });
  }

  // 4. Cambio de aeropuerto de destino
  if (newTicketData.destino && existingFlight.destination !== newTicketData.destino) {
    changes.push({
      type: 'destination_changed',
      field: 'destination',
      oldValue: existingFlight.destination,
      newValue: newTicketData.destino
    });
  }

  // 5. Cancelación (si el nuevo ticket dice cancelado)
  if (newTicketData.status?.toLowerCase() === 'cancelled' ||
      newTicketData.status?.toLowerCase() === 'cancelado') {
    changes.push({
      type: 'cancelled',
      field: 'status',
      oldValue: existingFlight.status,
      newValue: 'cancelled'
    });
  }

  return changes;
}

/**
 * Guarda los cambios detectados en el historial
 */
async function saveChanges(flightId, userId, changes) {
  const records = changes.map(change => ({
    flight_id: flightId,
    user_id: userId,
    change_type: change.type,
    field_changed: change.field,
    old_value: change.oldValue,
    new_value: change.newValue,
    notified: false
  }));

  const { error } = await supabase
    .from('flight_changes')
    .insert(records);

  if (error) {
    console.error('[Changes] Error guardando cambios:', error.message);
  }
}

/**
 * Actualiza el vuelo con los datos nuevos
 */
async function updateFlight(flightId, newCheckinCalc, newTicketData) {
  const updateData = {
    departure_datetime: newCheckinCalc.utc.departureUTC,
    checkin_open_at: newCheckinCalc.utc.checkinOpensUTC,
    checkin_close_at: newCheckinCalc.utc.checkinClosesUTC,
    updated_at: new Date().toISOString(),
    change_count: undefined, // se incrementa abajo
    last_change_at: new Date().toISOString()
  };

  if (newTicketData.flight_number) {
    updateData.flight_number = newTicketData.flight_number;
  }
  if (newTicketData.origen) {
    updateData.origin = newTicketData.origen;
  }
  if (newTicketData.destino) {
    updateData.destination = newTicketData.destino;
  }

  // Incrementar contador de cambios
  const { data: current } = await supabase
    .from('flights')
    .select('change_count')
    .eq('id', flightId)
    .single();

  updateData.change_count = (current?.change_count || 0) + 1;

  const { error } = await supabase
    .from('flights')
    .update(updateData)
    .eq('id', flightId);

  if (error) {
    console.error('[Changes] Error actualizando vuelo:', error.message);
    throw error;
  }

  console.log(`[Changes] ✅ Vuelo ${flightId} actualizado`);
}

/**
 * Genera el mensaje de WhatsApp para notificar cambios
 */
function formatChangeMessage(changes, flightNumber) {
  let msg = `⚠️ *Cambios detectados en tu vuelo ${flightNumber}*\n\n`;

  changes.forEach(change => {
    switch (change.type) {
      case 'delayed':
        msg += `🕐 *Horario atrasado:*\n`;
        msg += `   Antes: ${change.oldValue}\n`;
        msg += `   Ahora: *${change.newValue}*\n`;
        msg += `   _(${Math.abs(change.diffMinutes)} minutos de atraso)_\n\n`;
        break;

      case 'advanced':
        msg += `⏰ *Horario adelantado:*\n`;
        msg += `   Antes: ${change.oldValue}\n`;
        msg += `   Ahora: *${change.newValue}*\n`;
        msg += `   _(${Math.abs(change.diffMinutes)} minutos antes)_\n\n`;
        break;

      case 'flight_number_changed':
        msg += `✈️ *Número de vuelo cambió:*\n`;
        msg += `   Antes: ${change.oldValue}\n`;
        msg += `   Ahora: *${change.newValue}*\n\n`;
        break;

      case 'origin_changed':
        msg += `🛫 *Aeropuerto de salida cambió:*\n`;
        msg += `   Antes: ${change.oldValue}\n`;
        msg += `   Ahora: *${change.newValue}*\n\n`;
        break;

      case 'destination_changed':
        msg += `🛬 *Aeropuerto de destino cambió:*\n`;
        msg += `   Antes: ${change.oldValue}\n`;
        msg += `   Ahora: *${change.newValue}*\n\n`;
        break;

      case 'cancelled':
        msg += `🚫 *VUELO CANCELADO*\n\n`;
        break;
    }
  });

  msg += `🔔 Tu recordatorio de check-in fue actualizado automáticamente.`;

  return msg;
}

module.exports = {
  findExistingFlight,
  detectChanges,
  saveChanges,
  updateFlight,
  formatChangeMessage
};