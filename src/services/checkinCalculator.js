const { DateTime } = require('luxon');
const { supabase } = require('../db/supabase');

/**
 * Obtiene la zona horaria del aeropuerto desde Supabase
 */
async function getAirportTimezone(iataCode) {
  if (!iataCode) return { timezone: 'UTC', city: 'Desconocida', country: 'Desconocido' };

  const { data } = await supabase
    .from('airports')
    .select('timezone, city, country')
    .eq('iata_code', iataCode.toUpperCase())
    .single();

  if (!data) {
    console.warn(`⚠️ Aeropuerto ${iataCode} no encontrado en DB`);
    return { timezone: 'UTC', city: iataCode, country: 'Desconocido' };
  }
  return data;
}

/**
 * Obtiene las reglas de check-in de la aerolínea desde Supabase
 */
async function getAirlineRules(airlineCode) {
  if (!airlineCode) return { checkin_window_hours: 48, name: 'Desconocida', checkin_link_template: null };

  const { data } = await supabase
    .from('airlines')
    .select('checkin_window_hours, name, checkin_link_template')
    .eq('code', airlineCode.toUpperCase())
    .single();

  if (!data) {
    console.warn(`⚠️ Aerolínea ${airlineCode} no encontrada en DB, usando 48h`);
    return { checkin_window_hours: 48, name: airlineCode, checkin_link_template: null };
  }
  return data;
}

/**
 * Busca un aeropuerto por nombre de ciudad (fallback si no tenemos IATA)
 */
async function findAirportByCity(cityName) {
  if (!cityName) return null;

  const { data } = await supabase
    .from('airports')
    .select('iata_code, timezone, city, country')
    .ilike('city', `%${cityName}%`)
    .limit(1)
    .single();

  return data || null;
}

/**
 * Calcula horarios de check-in con zonas horarias correctas
 * Luxon maneja horario de verano/invierno automáticamente
 */
async function calculateCheckin({
  originIATA,
  originCity = null,
  airlineCode,
  departureDate,
  departureTime,
  userTimezone = 'America/Argentina/Buenos_Aires'
}) {
  // 1) Resolver aeropuerto de salida
  let airport;

  if (originIATA) {
    airport = await getAirportTimezone(originIATA);
  } else if (originCity) {
    const found = await findAirportByCity(originCity);
    if (found) {
      airport = found;
      originIATA = found.iata_code;
    } else {
      airport = { timezone: 'UTC', city: originCity, country: 'Desconocido' };
      originIATA = '???';
    }
  } else {
    return { error: true, message: 'No se pudo determinar el aeropuerto de salida' };
  }

  // 2) Obtener reglas de la aerolínea
  const airline = await getAirlineRules(airlineCode);

  // 3) Validar hora de salida
  const safeTime = departureTime || '00:00';

  // 4) Crear datetime de salida EN LA ZONA HORARIA DEL AEROPUERTO
  const departure = DateTime.fromISO(
    `${departureDate}T${safeTime}`,
    { zone: airport.timezone }
  );

  if (!departure.isValid) {
    return { error: true, message: `Fecha/hora inválida: ${departureDate} ${safeTime}` };
  }

  // 5) Calcular apertura del check-in
  const checkinOpen = departure.minus({ hours: airline.checkin_window_hours });

  // 6) Calcular cierre del check-in (1 hora antes del vuelo)
  const checkinClose = departure.minus({ hours: 1 });

  // 7) Convertir a hora del usuario (Argentina)
  const checkinOpenUser = checkinOpen.setZone(userTimezone);
  const checkinCloseUser = checkinClose.setZone(userTimezone);
  const departureUser = departure.setZone(userTimezone);

  // 8) ¿Ya está abierto el check-in?
  const now = DateTime.now().setZone('UTC');
  const checkinOpenUTC = checkinOpen.toUTC();
  const checkinCloseUTC = checkinClose.toUTC();
  const yaEstaAbierto = now >= checkinOpenUTC && now <= checkinCloseUTC;
  const yaExpiro = now > checkinCloseUTC;

  // 9) Diferencia horaria entre aeropuerto y usuario
  const diffMinutes = departure.offset - DateTime.now().setZone(userTimezone).offset;
  const diffHours = diffMinutes / 60;

  return {
    error: false,
    airline: airline.name,
    airlineCode,
    checkinLink: airline.checkin_link_template,

    origin: {
      iata: originIATA,
      city: airport.city,
      country: airport.country,
      timezone: airport.timezone
    },

    departure: {
      local: departure.toFormat('dd/MM/yyyy HH:mm'),
      userTime: departureUser.toFormat('dd/MM/yyyy HH:mm'),
      timezone: airport.timezone
    },

    checkin: {
      opensLocal: checkinOpen.toFormat('dd/MM/yyyy HH:mm'),
      closesLocal: checkinClose.toFormat('dd/MM/yyyy HH:mm'),
      windowHours: airline.checkin_window_hours
    },

    checkinUserTime: {
      opens: checkinOpenUser.toFormat('dd/MM/yyyy HH:mm'),
      closes: checkinCloseUser.toFormat('dd/MM/yyyy HH:mm')
    },

    utc: {
      checkinOpensUTC: checkinOpenUTC.toISO(),
      checkinClosesUTC: checkinCloseUTC.toISO(),
      departureUTC: departure.toUTC().toISO()
    },

    status: {
      yaEstaAbierto,
      yaExpiro,
      timeDifferenceHours: diffHours
    }
  };
}

/**
 * Genera el mensaje de WhatsApp con la info del check-in
 */
function formatCheckinMessage(calc) {
  if (calc.error) return `⚠️ ${calc.message}`;

  const isSameTimezone = calc.checkin.opensLocal === calc.checkinUserTime.opens;

  const diffText = calc.status.timeDifferenceHours === 0
    ? ''
    : calc.status.timeDifferenceHours > 0
      ? ` _(+${calc.status.timeDifferenceHours}h vs Argentina)_`
      : ` _(${calc.status.timeDifferenceHours}h vs Argentina)_`;

  let msg = `✈️ *Vuelo detectado*\n\n`;
  msg += `🏢 *Aerolínea:* ${calc.airline}\n`;
  msg += `🛫 *Origen:* ${calc.origin.city}, ${calc.origin.country} (${calc.origin.iata})\n`;
  msg += `📅 *Sale:* ${calc.departure.local} _(hora local ${calc.origin.iata})_${diffText}\n`;

  if (!isSameTimezone) {
    msg += `🇦🇷 *En Argentina:* ${calc.departure.userTime}\n`;
  }

  msg += `\n─────────────────\n`;

  if (calc.status.yaExpiro) {
    msg += `\n⚠️ *El check-in ya cerró para este vuelo.*`;
    return msg;
  }

  if (calc.status.yaEstaAbierto) {
    msg += `\n🟢 *¡El check-in está ABIERTO ahora!*\n`;
    if (calc.checkinLink) {
      msg += `🔗 ${calc.checkinLink}\n`;
    }
    msg += `\n🔴 *Cierra:* ${calc.checkin.closesLocal} _(hora ${calc.origin.iata})_\n`;
    if (!isSameTimezone) {
      msg += `🇦🇷 *En Argentina:* ${calc.checkinUserTime.closes}\n`;
    }
    return msg;
  }

  // Check-in aún no abre
  msg += `\n🟢 *Check-in ABRE:*\n`;
  msg += `   📍 Hora ${calc.origin.iata}: *${calc.checkin.opensLocal}*\n`;
  if (!isSameTimezone) {
    msg += `   🇦🇷 Hora Argentina: *${calc.checkinUserTime.opens}*\n`;
  }

  msg += `\n🔴 *Check-in CIERRA:*\n`;
  msg += `   📍 Hora ${calc.origin.iata}: *${calc.checkin.closesLocal}*\n`;
  if (!isSameTimezone) {
    msg += `   🇦🇷 Hora Argentina: *${calc.checkinUserTime.closes}*\n`;
  }

  msg += `\n⏰ *Ventana:* ${calc.checkin.windowHours}hs antes del vuelo\n`;

  if (calc.checkinLink) {
    msg += `🔗 *Link:* ${calc.checkinLink}\n`;
  }

  return msg;
}

module.exports = {
  calculateCheckin,
  formatCheckinMessage,
  getAirportTimezone,
  getAirlineRules,
  findAirportByCity
};