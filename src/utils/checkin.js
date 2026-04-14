// src/utils/checkin.js
// Calcula cuándo se habilita el check-in según la compañía detectada

const airlinesData = require('../data/airlines.json');

/**
 * Busca la compañía en la base de datos por nombre o código IATA
 * @param {string} companyName - Nombre o código de la compañía
 * @returns {object} - Datos de la compañía o valores por defecto
 */
function findCompany(companyName) {
  if (!companyName) return null;

  const normalized = companyName.toLowerCase().trim();

  const found = airlinesData.airlines.find(airline =>
    airline.names.some(name => name.toLowerCase().includes(normalized) || normalized.includes(name.toLowerCase()))
  );

  return found || null;
}

/**
 * Calcula la fecha/hora exacta en que se habilita el check-in
 * @param {string} departureDateTime - Fecha y hora de salida en formato ISO o legible
 * @param {number} hoursBeforeCheckin - Horas antes del vuelo que abre el check-in
 * @returns {Date} - Fecha/hora de apertura del check-in
 */
function calculateCheckinTime(departureDateTime, hoursBeforeCheckin) {
  const departure = new Date(departureDateTime);
  const checkinOpen = new Date(departure.getTime() - hoursBeforeCheckin * 60 * 60 * 1000);
  return checkinOpen;
}

/**
 * Formatea una fecha de forma legible en español
 * @param {Date} date
 * @returns {string}
 */
function formatDate(date) {
  return date.toLocaleString('es-ES', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Madrid'
  });
}

/**
 * Función principal: dado un ticket analizado, devuelve toda la info del check-in
 * @param {object} ticketData - Datos extraídos del voucher por la IA
 * @returns {object} - Info completa del check-in
 */
function getCheckinInfo(ticketData) {
  const { compania, fecha_salida, hora_salida, numero_reserva, pasajero } = ticketData;

  // Construimos la fecha completa de salida
  const departureDateTimeString = `${fecha_salida}T${hora_salida || '00:00'}:00`;
  const departureDate = new Date(departureDateTimeString);

  if (isNaN(departureDate.getTime())) {
    return {
      error: true,
      mensaje: 'No se pudo interpretar la fecha de salida del ticket.'
    };
  }

  // Buscamos la compañía
  const company = findCompany(compania);
  const horasAntes = company ? company.horas_antes_checkin : airlinesData.default.horas_antes_checkin;
  const urlCheckin = company ? company.url_checkin : null;
  const notasExtra = company ? company.notas : airlinesData.default.notas;

  // Calculamos hora de apertura del check-in
  const checkinOpenDate = calculateCheckinTime(departureDateTimeString, horasAntes);
  const ahora = new Date();
  const yaEstaAbierto = checkinOpenDate <= ahora;

  return {
    error: false,
    compania: company ? company.names[0] : (compania || 'Compañía desconocida'),
    compania_reconocida: !!company,
    pasajero: pasajero || 'No especificado',
    numero_reserva: numero_reserva || 'No detectado',
    fecha_salida_formateada: formatDate(departureDate),
    fecha_checkin_formateada: formatDate(checkinOpenDate),
    checkin_open_date: checkinOpenDate,
    departure_date: departureDate,
    horas_antes: horasAntes,
    ya_esta_abierto: yaEstaAbierto,
    url_checkin: urlCheckin,
    notas: notasExtra
  };
}

module.exports = { getCheckinInfo, findCompany, formatDate };
