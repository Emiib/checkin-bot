const axios = require('axios');
const { supabase } = require('../db/supabase');
const { DateTime } = require('luxon');
const { sendText } = require('./whatsapp');
const { cancelFlightReminders, createReminder } = require('./reminderService');
const { calculateCheckin, formatCheckinMessage } = require('./checkinCalculator');

// Configuración de AeroDataBox
const AERODATABOX_BASE = 'https://aerodatabox.p.rapidapi.com';
const HEADERS = {
  'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
  'X-RapidAPI-Host': process.env.RAPIDAPI_HOST
};

/**
 * Consulta el estado de un vuelo en AeroDataBox
 * @param {string} airlineIata - Código IATA aerolínea (ej: AR)
 * @param {string} flightNumber - Número de vuelo sin código (ej: 1884)
 * @param {string} date - Fecha YYYY-MM-DD
 */
async function getFlightStatus(airlineIata, flightNumber, date) {
  try {
    // Extraer solo el número (AR1884 → 1884)
    const numberOnly = flightNumber.replace(/[A-Z]/gi, '');

    const url = `${AERODATABOX_BASE}/flights/number/${airlineIata}/${numberOnly}/${date}`;

    const response = await axios.get(url, { headers: HEADERS });

    if (!response.data || response.data.length === 0) {
      console.log(`[Monitor] ℹ️ No se encontró info para ${airlineIata}${numberOnly} el ${date}`);
      return null;
    }

    // AeroDataBox puede devolver múltiples vuelos (ej: ida y vuelta mismo número)
    // Tomamos el primero que coincida con la fecha
    const flight = response.data[0];

    const status = {
      flightNumber: flight.flightNumber,
      airlineIata: flight.airline?.iata,
      status: flight.status?.text || 'scheduled',

      departure: {
        iata: flight.departure?.airport?.iata,
        scheduledTime: flight.departure?.scheduledTime,
        estimatedTime: flight.departure?.estimatedTime,
        actualTime: flight.departure?.actualTime,
        terminal: flight.departure?.terminal,
        gate: flight.departure?.gate
      },

      arrival: {
        iata: flight.arrival?.airport?.iata,
        scheduledTime: flight.arrival?.scheduledTime,
        estimatedTime: flight.arrival?.estimatedTime,
        actualTime: flight.arrival?.actualTime,
        terminal: flight.arrival?.terminal,
        gate: flight.arrival?.gate
      }
    };

    console.log(`[Monitor] ✅ Estado de ${airlineIata}${numberOnly}: ${status.status}`);
    return status;

  } catch (err) {
    if (err.response?.status === 404) {
      console.log(`[Monitor] ℹ️ Vuelo no encontrado en AeroDataBox`);
      return null;
    }
    if (err.response?.status === 429) {
      console.warn(`[Monitor] ⚠️ Límite de API alcanzado (429)`);
      return null;
    }
    console.error(`[Monitor] ❌ Error consultando AeroDataBox:`, err.message);
    return null;
  }
}

/**
 * Monitorea todos los vuelos próximos y detecta cambios
 * Se ejecuta periódicamente (cada 15-30 minutos)
 */
async function monitorUpcomingFlights() {
  try {
    const now = DateTime.now().toUTC();
    const in48h = now.plus({ hours: 48 });

    // Buscar vuelos que salen en las próximas 48 horas
    // (optimizamos para no gastar llamadas de API innecesarias)
    const { data: flights, error } = await supabase
      .from('flights')
      .select(`
        id,
        flight_number,
        origin,
        destination,
        departure_datetime,
        checkin_open_at,
        status,
        metadata,
        user_id,
        users (
          phone_number,
          timezone
        )
      `)
      .gte('departure_datetime', now.toISO())
      .lte('departure_datetime', in48h.toISO())
      .not('status', 'in', '("cancelled","departed","landed")')
      .order('departure_datetime', { ascending: true });

    if (error) {
      console.error('[Monitor] Error obteniendo vuelos:', error.message);
      return;
    }

    if (!flights || flights.length === 0) {
      console.log('[Monitor] ℹ️ No hay vuelos próximos para monitorear');
      return;
    }

    console.log(`[Monitor] 🔍 Monitoreando ${flights.length} vuelo(s) próximo(s)...`);

    for (const flight of flights) {
      try {
        await checkFlightForChanges(flight);

        // Pausa entre consultas para no saturar la API (evitar rate limit)
        await new Promise(resolve => setTimeout(resolve, 3000));

      } catch (err) {
        console.error(`[Monitor] Error monitoreando ${flight.flight_number}:`, err.message);
      }
    }

  } catch (err) {
    console.error('[Monitor] ❌ Error general:', err.message);
  }
}

/**
 * Verifica un vuelo individual contra AeroDataBox y detecta cambios
 */
async function checkFlightForChanges(flight) {
  // Extraer código de aerolínea y número
  const match = flight.flight_number?.match(/^([A-Z]{2})(\d+)/i);
  if (!match) {
    console.log(`[Monitor] ⚠️ No pude parsear ${flight.flight_number}`);
    return;
  }

  const airlineIata = match[1].toUpperCase();
  const flightNumber = match[2];
  const departureDate = DateTime
    .fromISO(flight.departure_datetime)
    .toFormat('yyyy-MM-dd');

  // Consultar AeroDataBox
  const aeroStatus = await getFlightStatus(airlineIata, flightNumber, departureDate);

  if (!aeroStatus) return;

  // Comparar y detectar cambios
  const changes = [];

  // 1) Cambio de horario de salida
  if (aeroStatus.departure?.estimatedTime || aeroStatus.departure?.scheduledTime) {
    const aeroDepTime = aeroStatus.departure.estimatedTime || aeroStatus.departure.scheduledTime;
    const currentDepTime = DateTime.fromISO(flight.departure_datetime).toUTC().toISO();

    const aeroDateTime = DateTime.fromISO(aeroDepTime).toUTC();
    const currentDateTime = DateTime.fromISO(currentDepTime).toUTC();

    const diffMinutes = Math.abs(aeroDateTime.diff(currentDateTime, 'minutes').minutes);

    if (diffMinutes > 5) {
      changes.push({
        type: diffMinutes > 0 ? 'delayed' : 'advanced',
        field: 'departure_datetime',
        oldValue: currentDateTime.toFormat('dd/MM/yyyy HH:mm'),
        newValue: aeroDateTime.toFormat('dd/MM/yyyy HH:mm'),
        diffMinutes: Math.round(diffMinutes)
      });
    }
  }

  // 2) Cambio de terminal
  if (aeroStatus.departure?.terminal) {
    const currentTerminal = flight.metadata?.terminal;
    if (currentTerminal && currentTerminal !== aeroStatus.departure.terminal) {
      changes.push({
        type: 'terminal_changed',
        field: 'terminal',
        oldValue: currentTerminal,
        newValue: aeroStatus.departure.terminal
      });
    } else if (!currentTerminal) {
      // Guardar terminal si no existía
      changes.push({
        type: 'terminal_added',
        field: 'terminal',
        oldValue: null,
        newValue: aeroStatus.departure.terminal
      });
    }
  }

  // 3) Cambio de gate
  if (aeroStatus.departure?.gate) {
    const currentGate = flight.metadata?.gate;
    if (currentGate && currentGate !== aeroStatus.departure.gate) {
      changes.push({
        type: 'gate_changed',
        field: 'gate',
        oldValue: currentGate,
        newValue: aeroStatus.departure.gate
      });
    } else if (!currentGate) {
      changes.push({
        type: 'gate_added',
        field: 'gate',
        oldValue: null,
        newValue: aeroStatus.departure.gate
      });
    }
  }

  // 4) Estado del vuelo (cancelado, landed, etc.)
  if (aeroStatus.status) {
    const currentStatus = flight.status;
    if (currentStatus !== aeroStatus.status.toLowerCase()) {
      changes.push({
        type: 'status_changed',
        field: 'status',
        oldValue: currentStatus,
        newValue: aeroStatus.status.toLowerCase()
      });
    }
  }

  // Si hay cambios, procesar
  if (changes.length > 0) {
    console.log(`[Monitor] 🔄 ${changes.length} cambio(s) en ${flight.flight_number}`);
    await processFlightChanges(flight, changes, aeroStatus);
  } else {
    // Actualizar timestamp de última verificación
    await supabase
      .from('flights')
      .update({ last_checked_at: new Date().toISOString() })
      .eq('id', flight.id);
  }
}

/**
 * Procesa los cambios detectados: actualiza DB, reprograma reminder, notifica
 */
async function processFlightChanges(flight, changes, aeroStatus) {
  const phone = flight.users?.phone_number;
  if (!phone) return;

  // 1) Guardar cambios en historial
  const changeRecords = changes.map(c => ({
    flight_id: flight.id,
    user_id: flight.user_id,
    change_type: c.type,
    field_changed: c.field,
    old_value: c.oldValue || 'N/A',
    new_value: c.newValue || 'N/A',
    notified: true
  }));

  await supabase.from('flight_changes').insert(changeRecords);

  // 2) Si cambió el horario, actualizar vuelo y reprogramar
  const timeChange = changes.find(c => c.field === 'departure_datetime');

  if (timeChange && (aeroStatus.departure?.estimatedTime || aeroStatus.departure?.scheduledTime)) {
    const newDeparture = DateTime
      .fromISO(aeroStatus.departure.estimatedTime || aeroStatus.departure.scheduledTime)
      .toUTC()
      .toISO();

    // Recalcular check-in
    const originTz = flight.metadata?.origin_timezone || 'UTC';
    const airlineCode = flight.flight_number?.substring(0, 2);

    const newDate = DateTime.fromISO(newDeparture).setZone(originTz);

    const checkinCalc = await calculateCheckin({
      originIATA: flight.origin,
      airlineCode: airlineCode,
      departureDate: newDate.toFormat('yyyy-MM-dd'),
      departureTime: newDate.toFormat('HH:mm'),
      userTimezone: flight.users?.timezone || 'America/Argentina/Buenos_Aires'
    });

    if (!checkinCalc.error) {
      // Actualizar vuelo
      await supabase
        .from('flights')
        .update({
          departure_datetime: checkinCalc.utc.departureUTC,
          checkin_open_at: checkinCalc.utc.checkinOpensUTC,
          checkin_close_at: checkinCalc.utc.checkinClosesUTC,
          change_count: (flight.change_count || 0) + 1,
          last_change_at: new Date().toISOString(),
          last_checked_at: new Date().toISOString()
        })
        .eq('id', flight.id);

      // Reprogramar reminder
      await cancelFlightReminders(flight.id);
      if (!checkinCalc.status.yaEstaAbierto && !checkinCalc.status.yaExpiro) {
        await createReminder(flight.id, flight.user_id, checkinCalc.utc.checkinOpensUTC);
      }
    }
  }

  // 3) Actualizar metadata con terminal/gate/estado
  const metadataUpdate = { ...(flight.metadata || {}) };
  if (aeroStatus.departure?.terminal) {
    metadataUpdate.terminal = aeroStatus.departure.terminal;
  }
  if (aeroStatus.departure?.gate) {
    metadataUpdate.gate = aeroStatus.departure.gate;
  }
  if (aeroStatus.status) {
    metadataUpdate.flightStatus = aeroStatus.status;
  }

  await supabase
    .from('flights')
    .update({
      metadata: metadataUpdate,
      status: aeroStatus.status.toLowerCase(),
      last_checked_at: new Date().toISOString()
    })
    .eq('id', flight.id);

  // 4) Notificar al usuario
  let msg = `⚠️ *Cambios detectados en tu vuelo ${flight.flight_number}*\n\n`;

  changes.forEach(change => {
    switch (change.type) {
      case 'delayed':
        msg += `🕐 *Nuevo horario de salida:*\n`;
        msg += `   Antes: ${change.oldValue}\n`;
        msg += `   Ahora: *${change.newValue}*\n`;
        msg += `   _(${Math.abs(change.diffMinutes)} minutos de atraso)_\n\n`;
        break;
      case 'advanced':
        msg += `⏰ *Vuelo adelantado:*\n`;
        msg += `   Antes: ${change.oldValue}\n`;
        msg += `   Ahora: *${change.newValue}*\n\n`;
        break;
      case 'terminal_changed':
      case 'terminal_added':
        msg += `🏢 *Terminal:*\n`;
        msg += `   Ahora: *Terminal ${change.newValue}*\n\n`;
        break;
      case 'gate_changed':
      case 'gate_added':
        msg += `🚪 *Puerta de embarque:*\n`;
        msg += `   Ahora: *Gate ${change.newValue}*\n\n`;
        break;
      case 'status_changed':
        msg += `📊 *Estado del vuelo:*\n`;
        msg += `   Ahora: *${change.newValue}*\n\n`;
        break;
    }
  });

  if (timeChange) {
    msg += `🔔 Tu recordatorio de check-in fue actualizado automáticamente ✅`;
  }

  try {
    await sendText(phone, msg);
    console.log(`[Monitor] ✅ Notificación enviada a ${phone}`);
  } catch (err) {
    console.error(`[Monitor] ❌ Error notificando a ${phone}:`, err.message);
  }
}

module.exports = {
  getFlightStatus,
  monitorUpcomingFlights,
  checkFlightForChanges
};