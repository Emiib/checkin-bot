/**
 * Todos los mensajes del bot centralizados
 * Fácil de editar, traducir o personalizar
 */

const templates = {

  welcome: () =>
    `👋 ¡Hola! Soy tu asistente de check-in ✈️\n\n` +
    `Envíame el *voucher o ticket* de tu viaje (imagen, PDF, texto o audio) y yo me encargo de:\n\n` +
    `✅ Detectar la compañía y el vuelo\n` +
    `🕐 Calcular cuándo abre el check-in\n` +
    `🌍 Ajustar la zona horaria automáticamente\n` +
    `🔔 Avisarte en el momento exacto\n` +
    `🔗 Darte el link directo para hacer el check-in\n\n` +
    `📌 *Comandos disponibles:*\n` +
    `• LISTA — ver tus recordatorios activos\n` +
    `• BORRAR 1 — eliminar un recordatorio\n` +
    `• AYUDA — ver este mensaje\n\n` +
    `¡Empieza enviando tu primer ticket!`,

  analyzing: () =>
    `⏳ Analizando tu voucher... un momento por favor.`,

  analyzingAudio: () =>
    `🎤 Recibí tu audio. Transcribiendo y analizando...`,

  errorGeneral: () =>
    `❌ No pude procesar ese archivo.\n\n` +
    `Asegurate de enviar:\n` +
    `• 📄 Foto o PDF del ticket/voucher\n` +
    `• ✏️ Texto con los datos del vuelo\n` +
    `• 🎤 Audio describiendo tu vuelo\n\n` +
    `Intentalo de nuevo.`,

  errorNoData: () =>
    `⚠️ No pude detectar los datos del vuelo en lo que me enviaste.\n\n` +
    `Necesito al menos:\n` +
    `• Aerolínea\n` +
    `• Número de vuelo\n` +
    `• Fecha y hora de salida\n` +
    `• Aeropuerto de salida\n\n` +
    `Probá enviando una foto más clara o escribí los datos.`,

  missingOrigin: (ticketData) =>
    `✈️ Detecté un vuelo de *${ticketData.compania}* (${ticketData.flight_number || 'sin número'}) ` +
    `el *${ticketData.fecha_salida}*.\n\n` +
    `Pero no pude identificar el *aeropuerto de salida*.\n\n` +
    `📍 Escribime el código IATA del aeropuerto de salida.\n` +
    `Ejemplos: EZE, AEP, COR, MAD, MIA, GRU, SCL\n\n` +
    `O escribí el nombre de la ciudad (ej: "Madrid", "Miami").`,

  confirmationAsked: () =>
    `\n\n¿Querés que te avise cuando abra el check-in?\n` +
    `Respondé *SI* o *NO*`,

  reminderSet: (fechaTexto) =>
    `🔔 ¡Perfecto! Te avisaré el *${fechaTexto}* cuando se abra el check-in.\n\n` +
    `_Recordatorio programado ✅_`,

  reminderAlreadyOpen: (link) =>
    `ℹ️ ¡El check-in ya está disponible!\n` +
    `🔗 Hacelo ahora: ${link || 'consultá la página de la aerolínea'}\n\n` +
    `¡No te olvides! ⏰`,

  reminderCancelled: () =>
    `👍 Entendido, no programaré el recordatorio.\n` +
    `Envíame otro ticket cuando quieras.`,

  noReminders: () =>
    `📭 No tenés recordatorios activos en este momento.`,

  checkinAlert: (flight) =>
    `🚨 *¡CHECK-IN ABIERTO!* 🚨\n\n` +
    `✈️ Vuelo: *${flight.flight_number}*\n` +
    `🛫 Sale: ${flight.departure_local}\n` +
    `🔗 Link: ${flight.checkin_link || 'consultá la web de la aerolínea'}\n\n` +
    `¡Hacé el check-in ahora! ⏰`,

  noPendingConfirmation: () =>
    `🤔 No tengo ningún voucher pendiente de confirmar.\n` +
    `Envíame un ticket para analizarlo.`,

  audioNotSupported: () =>
    `🎤 Recibí tu audio pero no pude procesarlo.\n` +
    `Probá enviando una foto, PDF o texto del ticket.`
};

module.exports = templates;