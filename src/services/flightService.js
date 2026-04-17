const { supabase } = require('../db/supabase');

// Guarda o actualiza un usuario por número de WhatsApp
async function upsertUser(phoneNumber) {
  const { data } = await supabase
    .from('users')
    .upsert(
      { phone_number: phoneNumber, last_message_at: new Date().toISOString() },
      { onConflict: 'phone_number' }
    )
    .select()
    .single();
  return data;
}

// Guarda un vuelo con sus horarios de check-in (en UTC)
async function saveFlight({ userId, airlineCode, flightData, checkinCalc }) {
  // Buscar ID de aerolínea
  const { data: airline } = await supabase
    .from('airlines')
    .select('id')
    .eq('code', airlineCode.toUpperCase())
    .single();

  const { data: flight } = await supabase
    .from('flights')
    .insert({
      user_id: userId,
      airline_id: airline?.id || null,
      flight_number: flightData.flight_number,
      origin: flightData.origin,
      destination: flightData.destination,
      departure_datetime: checkinCalc.utc.departureUTC,
      checkin_open_at: checkinCalc.utc.checkinOpensUTC,
      checkin_close_at: checkinCalc.utc.checkinClosesUTC,
      status: 'scheduled',
      checkin_link: checkinCalc.checkinLink,
      metadata: flightData.metadata || {}
    })
    .select()
    .single();

  return flight;
}

// Guarda el ticket procesado
async function saveTicket({ userId, flightId, extractedText, fileUrl = null }) {
  const { data } = await supabase
    .from('tickets')
    .insert({
      user_id: userId,
      flight_id: flightId,
      extracted_text: extractedText,
      file_url: fileUrl,
      processing_status: 'done'
    })
    .select()
    .single();
  return data;
}

module.exports = { upsertUser, saveFlight, saveTicket };