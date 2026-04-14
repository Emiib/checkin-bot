// src/services/whatsapp.js
// Gestiona el envío de mensajes por la API de Meta WhatsApp Business

const axios = require('axios');

const WHATSAPP_API_URL = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_ID}/messages`;

const headers = () => ({
  Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
  'Content-Type': 'application/json'
});

/**
 * Envía un mensaje de texto simple
 */
async function sendText(to, text) {
  try {
    // DESPUÉS
  const toFormatted = to.startsWith('+') ? to : `+${to}`;
  await axios.post(WHATSAPP_API_URL, {
    messaging_product: 'whatsapp',
    to: toFormatted,
      type: 'text',
      text: { body: text }
    }, { headers: headers() });
  } catch (error) {
    console.error('❌ Error Meta API:');
    console.error(JSON.stringify(error.response?.data, null, 2));
    throw error;
  }
}

/**
 * Envía la confirmación después de analizar un ticket
 */
async function sendCheckinConfirmation(to, info) {
  const {
    compania,
    compania_reconocida,
    pasajero,
    numero_reserva,
    fecha_salida_formateada,
    fecha_checkin_formateada,
    horas_antes,
    ya_esta_abierto,
    url_checkin,
    notas
  } = info;

  let mensaje = `✅ *Ticket analizado correctamente*\n\n`;
  mensaje += `✈️ *Compañía:* ${compania}\n`;
  mensaje += `👤 *Pasajero:* ${pasajero}\n`;
  mensaje += `🔖 *Reserva:* ${numero_reserva}\n`;
  mensaje += `🛫 *Salida:* ${fecha_salida_formateada}\n\n`;

  if (ya_esta_abierto) {
    mensaje += `🟢 *¡El check-in YA está abierto!*\n\n`;
  } else {
    mensaje += `🕐 *Check-in abre:* ${fecha_checkin_formateada}\n`;
    mensaje += `_(${horas_antes}h antes del vuelo)_\n\n`;
  }

  if (url_checkin) {
    mensaje += `🔗 *Link de check-in:*\n${url_checkin}\n\n`;
  } else {
    mensaje += `⚠️ Compañía no reconocida. Busca el check-in en la web oficial.\n\n`;
  }

  if (!compania_reconocida) {
    mensaje += `ℹ️ _${notas}_\n\n`;
  }

  if (!ya_esta_abierto) {
    mensaje += `¿Quieres que te avise cuando se abra el check-in? Responde *SÍ* para programar el recordatorio. 🔔`;
  }

  await sendText(to, mensaje);
}

/**
 * Envía el recordatorio de que el check-in ya está disponible
 */
async function sendCheckinReminder(to, info) {
  const { compania, pasajero, numero_reserva, fecha_salida_formateada, url_checkin } = info;

  let mensaje = `🔔 *¡Recordatorio de Check-in!*\n\n`;
  mensaje += `El check-in para el vuelo de *${pasajero}* con *${compania}* ya está disponible 🎉\n\n`;
  mensaje += `🛫 *Salida:* ${fecha_salida_formateada}\n`;
  mensaje += `🔖 *Reserva:* ${numero_reserva}\n\n`;

  if (url_checkin) {
    mensaje += `👇 Haz el check-in aquí:\n${url_checkin}`;
  } else {
    mensaje += `Accede a la web de ${compania} para hacer el check-in.`;
  }

  await sendText(to, mensaje);
}

/**
 * Envía mensaje de error cuando no se puede leer el ticket
 */
async function sendErrorMessage(to) {
  const mensaje = `❌ No pude leer el ticket correctamente.\n\nPor favor, asegúrate de que:\n• La imagen sea clara y esté bien enfocada\n• El PDF no esté protegido con contraseña\n• O envíame el texto del voucher copiado directamente 📋`;
  await sendText(to, mensaje);
}

/**
 * Envía mensaje de bienvenida / instrucciones
 */
async function sendWelcomeMessage(to) {
  const mensaje = `👋 ¡Hola! Soy tu asistente de check-in ✈️\n\nEnvíame el *voucher o ticket* de tu viaje (imagen, PDF o texto) y yo me encargo de:\n\n✅ Detectar la compañía y el vuelo\n🕐 Calcular cuándo abre el check-in\n🔔 Avisarte en el momento exacto\n🔗 Darte el link directo para hacer el check-in\n\n¡Empieza enviando tu primer ticket!`;
  await sendText(to, mensaje);
}

module.exports = {
  sendText,
  sendCheckinConfirmation,
  sendCheckinReminder,
  sendErrorMessage,
  sendWelcomeMessage
};
