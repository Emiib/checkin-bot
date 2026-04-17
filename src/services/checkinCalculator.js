const { DateTime } = require('luxon');
const { supabase } = require('../db/supabase');

// Obtiene la zona horaria del aeropuerto desde Supabase
async function getAirportTimezone(iataCode) {
  const { data } = await supabase
    .from('airports')
    .select('timezone, city, country')
    .eq('iata_code', iataCode.toUpperCase())
    .single();

  if (!data) {
    console.warn(`⚠️ Aeropuerto ${iataCode} no encontrado, usando UTC`);
    return { timezone: 'UTC', city: 'Desconocida', country: 'Desconocido' };
  }
  return data;
}

// Obtiene las reglas de check-in de la aerolínea desde Supabase
async function getAirlineRules(airlineCode) {
  const { data } = await supabase
    .from('airlines')
    .select('checkin_window_hours, name, checkin_link_template')
    .eq('code', airlineCode.toUpperCase())
    .single();

  if (!data) {
    console.warn(`⚠️ Aerolínea ${airlineCode} no encontrada, usando 48h`);
    return { checkin_window_hours: 48, name: airlineCode, checkin_link_template: null };
  }
  return data;
}

// Calcula horarios de check-in con zonas horarias correctas
async function calculateCheckin({
  originIATA,
  airlineCode,
  departureDate,
  departureTime,
  userTimezone = 'America/Argentina/Buenos_Aires'
}) {
  // 1) Buscar zona horaria del aeropuerto de salida
  const airport = await getAirportTimezone(originIATA);

  // 2) Buscar reglas de la aerolínea
  const airline = await getAirlineRules(airlineCode);

  // 3) Crear datetime de salida en hora LOCAL del aeropuerto
  //    Luxon maneja horario de verano/invierno automáticamente
  const departure = DateTime.fromISO(
    `${departureDate}T${departureTime}`,
    { zone: airport.timezone }
  );

  if (!departure.isValid) {
    throw new Error(`Fecha/hora inválida: ${departureDate} ${departureTime}`);
  }

  // 4) Calcular apertura del check-in
  const checkinOpen = departure.minus({ hours: airline.checkin_window_hours });

  // 5) Calcular cierre del check-in (1 hora antes del vuelo)
  const checkinClose = departure.minus({ hours: 1 });

  // 6) Convertir a hora del usuario (Argentina)
  const checkinOpenUser = checkinOpen.setZone(userTimezone);
  const checkinCloseUser = checkinClose.setZone(userTimezone);

  return {
    airline: airline.name,
    airlineCode,
    checkinLink: airline.checkin_link_template,
    origin: { iata: originIATA, city: airport.city, country: airport.country },

    // Hora local del aeropuerto (para mostrar al pasajero)
    departure: {
      local: departure.toFormat('dd/MM/yyyy HH:mm'),
      timezone: airport.timezone
    },

    // Horarios en hora local del aeropuerto
    checkin: {
      opensLocal: checkinOpen.toFormat('dd/MM/yyyy HH:mm'),
      closesLocal: checkinClose.toFormat('dd/MM/yyyy HH:mm'),
      windowHours: airline.checkin_window_hours
    },

    // Horarios en hora Argentina (para notificar al usuario)
    checkinUserTime: {
      opens: checkinOpenUser.toFormat('dd/MM/yyyy HH:mm'),
      closes: checkinCloseUser.toFormat('dd/MM/yyyy HH:mm')
    },

    // UTC para guardar en DB y usar en cron
    utc: {
      checkinOpensUTC: checkinOpen.toUTC().toISO(),
      checkinClosesUTC: checkinClose.toUTC().toISO(),
      departureUTC: departure.toUTC().toISO()
    }
  };
}

// Genera el mensaje de WhatsApp
function formatCheckinMessage(calc) {
  const isSameTimezone = calc.checkin.opensLocal === calc.checkinUserTime.opens;

  let mensaje = `✈️ *Check-in detectado*\n\n`;
  mensaje += `🛫 *Vuelo:* ${calc.airlineCode} desde ${calc.origin.city}, ${calc.origin.country}\n`;
  mensaje += `📅 *Sale:* ${calc.departure.local} (hora local ${calc.origin.iata})\n\n`;

  mensaje += `🟢 *Check-in ABRE:*\n`;
  mensaje += `   📍 Hora ${calc.origin.iata}: ${calc.checkin.opensLocal}\n`;
  if (!isSameTimezone) {
    mensaje += `   🇦🇷 Hora Argentina: ${calc.checkinUserTime.opens}\n`;
  }

  mensaje += `\n🔴 *Check-in CIERRA:*\n`;
  mensaje += `   📍 Hora ${calc.origin.iata}: ${calc.checkin.closesLocal}\n`;
  if (!isSameTimezone) {
    mensaje += `   🇦🇷 Hora Argentina: ${calc.checkinUserTime.closes}\n`;
  }

  mensaje += `\n⏰ Ventana: ${calc.checkin.windowHours}hs antes del vuelo\n`;

  if (calc.checkinLink) {
    mensaje += `\n🔗 *Link check-in:* ${calc.checkinLink}`;
  }

  mensaje += `\n\n🔔 Te aviso cuando abra el check-in en hora Argentina.`;

  return mensaje;
}

module.exports = {
  calculateCheckin,
  formatCheckinMessage
};