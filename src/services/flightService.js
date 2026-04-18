const { supabase } = require('../db/supabase');

/**
 * Guarda o actualiza un usuario por número de WhatsApp
 */
async function upsertUser(phoneNumber, name = null) {
  const updateData = {
    phone_number: phoneNumber,
    last_message_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (name) updateData.name = name;

  const { data, error } = await supabase
    .from('users')
    .upsert(updateData, { onConflict: 'phone_number' })
    .select()
    .single();

  if (error) {
    console.error('[DB] Error upsert user:', error.message);
    throw error;
  }
  console.log(`[DB] ✅ Usuario ${phoneNumber} guardado/actualizado`);
  return data;
}

/**
 * Guarda un vuelo con sus horarios de check-in (en UTC)
 */
async function saveFlight({ userId, airlineCode, flightData, checkinCalc }) {
  // Buscar ID de aerolínea
  let airlineId = null;
  if (airlineCode) {
    const { data: airline } = await supabase
      .from('airlines')
      .select('id')
      .eq('code', airlineCode.toUpperCase())
      .single();
    airlineId = airline?.id || null;
  }

  const { data, error } = await supabase
    .from('flights')
    .insert({
      user_id: userId,
      airline_id: airlineId,
      flight_number: flightData.flight_number || 'UNKNOWN',
      origin: flightData.origin,
      destination: flightData.destination,
      departure_datetime: checkinCalc.utc.departureUTC,
      checkin_open_at: checkinCalc.utc.checkinOpensUTC,
      checkin_close_at: checkinCalc.utc.checkinClosesUTC,
      status: checkinCalc.status.yaEstaAbierto ? 'checkin_open' : 'scheduled',
      checkin_link: checkinCalc.checkinLink,
      metadata: {
        airline_name: checkinCalc.airline,
        origin_city: checkinCalc.origin.city,
        origin_country: checkinCalc.origin.country,
        origin_timezone: checkinCalc.origin.timezone,
        pasajero: flightData.pasajero || null,
        numero_reserva: flightData.numero_reserva || null,
        clase: flightData.clase || null,
        confidence: flightData.confidence || null
      }
    })
    .select()
    .single();

  if (error) {
    console.error('[DB] Error guardando vuelo:', error.message);
    throw error;
  }
  console.log(`[DB] ✅ Vuelo ${flightData.flight_number} guardado`);
  return data;
}

/**
 * Guarda el ticket procesado
 */
async function saveTicket({ userId, flightId, extractedText, fileUrl = null, source = 'text' }) {
  const { data, error } = await supabase
    .from('tickets')
    .insert({
      user_id: userId,
      flight_id: flightId,
      file_url: fileUrl,
      extracted_text: extractedText?.substring(0, 10000) || '',
      processing_status: 'done'
    })
    .select()
    .single();

  if (error) {
    console.error('[DB] Error guardando ticket:', error.message);
    throw error;
  }
  console.log(`[DB] ✅ Ticket guardado (fuente: ${source})`);
  return data;
}

/**
 * Busca vuelos duplicados (mismo usuario, mismo vuelo, misma fecha)
 */
async function findDuplicateFlight(userId, flightNumber, departureUTC) {
  const { data } = await supabase
    .from('flights')
    .select('id, flight_number, status')
    .eq('user_id', userId)
    .eq('flight_number', flightNumber)
    .eq('departure_datetime', departureUTC)
    .single();

  return data || null;
}

module.exports = {
  upsertUser,
  saveFlight,
  saveTicket,
  findDuplicateFlight
};