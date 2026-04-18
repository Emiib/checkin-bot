const express = require('express');
const router = express.Router();

// Servicios
const { processMessage } = require('../services/analyzer');
const { calculateCheckin, formatCheckinMessage } = require('../services/checkinCalculator');
const { upsertUser, saveFlight, saveTicket, findDuplicateFlight } = require('../services/flightService');
const { savePendingConfirmation, getPendingConfirmation, deletePendingConfirmation } = require('../services/confirmationService');
const { createReminder, getUserReminders } = require('../services/reminderService');
const { sendText, sendQuickReply } = require('../services/whatsapp');

// Utils
const { normalizePhone } = require('../utils/normalizePhone');
const templates = require('../utils/messageTemplates');

// ─── Verificación del webhook (requerida por Meta) ──────────────────────────
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('[Webhook] Verificación exitosa ✅');
    res.status(200).send(challenge);
  } else {
    console.warn('[Webhook] Token de verificación incorrecto ❌');
    res.sendStatus(403);
  }
});

// ─── Recepción de mensajes ──────────────────────────────────────────────────
router.post('/', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (!messages || messages.length === 0) return;

    const message = messages[0];
    if (!message.type) return;

    // Tipos soportados
    const tiposValidos = ['text', 'image', 'document', 'audio'];
    if (!tiposValidos.includes(message.type)) return;

    // Normalizar número
    const from = normalizePhone(message.from);
    const msgType = message.type;

    console.log(`[Webhook] 📨 Mensaje de ${from} — tipo: ${msgType}`);

    // Registrar usuario en DB
    const user = await upsertUser(from);

    // ══════════════════════════════════════════════════════════════════════
    // COMANDOS DE TEXTO
    // ══════════════════════════════════════════════════════════════════════
    if (msgType === 'text') {
      const text = message.text.body.trim();
      const textUpper = text.toUpperCase();

      // ── Respuesta a confirmación pendiente (SI/NO) ─────────────────────
      if (['SÍ', 'SI', 'S', 'YES'].includes(textUpper)) {
        const handled = await handleConfirmation(from, user, true);
        if (handled) return;
      }

      if (['NO', 'N'].includes(textUpper)) {
        const handled = await handleConfirmation(from, user, false);
        if (handled) return;
      }

      // ── Respuesta con código IATA (para cuando falta origen) ───────────
      if (/^[A-Z]{3}$/.test(textUpper)) {
        const handled = await handleIATAResponse(from, user, textUpper);
        if (handled) return;
      }

      // ── Comando: LISTA de recordatorios ────────────────────────────────
      if (['LISTA', 'RECORDATORIOS', 'MIS VUELOS'].includes(textUpper)) {
        await handleListReminders(from);
        return;
      }

      // ── Comando: AYUDA / HOLA ──────────────────────────────────────────
      if (['HOLA', 'START', 'INICIO', 'HELP', 'AYUDA', 'MENU', 'MENÚ'].includes(textUpper)) {
        await sendText(from, templates.welcome());
        return;
      }

      // ── Texto corto que no es comando → bienvenida ─────────────────────
      if (text.length < 30) {
        await sendText(from, templates.welcome());
        return;
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // PROCESAMIENTO DE VOUCHER (texto largo, imagen, PDF, audio)
    // ══════════════════════════════════════════════════════════════════════
    if (['text', 'image', 'document', 'audio'].includes(msgType)) {

      // Feedback inmediato según tipo
      if (msgType === 'audio') {
        await sendText(from, templates.analyzingAudio());
      } else {
        await sendText(from, templates.analyzing());
      }

      // 1) Analizar el voucher con IA
      let ticketData;
      try {
        ticketData = await processMessage(message);
      } catch (err) {
        console.error('[Webhook] Error analizando voucher:', err.message);
        await sendText(from, templates.errorGeneral());
        return;
      }

      // 2) Validar datos mínimos
      if (!ticketData.compania && !ticketData.flight_number && !ticketData.fecha_salida) {
        await sendText(from, templates.errorNoData());
        return;
      }

      // 3) ¿Tenemos aeropuerto de origen?
      if (!ticketData.origen && !ticketData.origen_ciudad) {
        await savePendingConfirmation(from, null, {
          type: 'awaiting_iata',
          ticketData
        });
        await sendText(from, templates.missingOrigin(ticketData));
        return;
      }

      // 4) Procesar el vuelo completo
      await processFlightData(from, user, ticketData);
    }

  } catch (error) {
    console.error('[Webhook] ❌ Error general:', error);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// FUNCIONES AUXILIARES
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Procesa los datos del vuelo:
 * calcula check-in, guarda en DB, envía mensaje
 */
async function processFlightData(from, user, ticketData) {
  try {
    // 1) Calcular check-in con zonas horarias
    const checkinCalc = await calculateCheckin({
      originIATA: ticketData.origen,
      originCity: ticketData.origen_ciudad,
      airlineCode: ticketData.compania,
      departureDate: ticketData.fecha_salida,
      departureTime: ticketData.hora_salida,
      userTimezone: user.timezone || 'America/Argentina/Buenos_Aires'
    });

    if (checkinCalc.error) {
      await sendText(from,
        `⚠️ ${checkinCalc.message}\n\nRevisá los datos e intentá de nuevo.`
      );
      return;
    }

    // 2) Verificar duplicado
    const duplicate = await findDuplicateFlight(
      user.id,
      ticketData.flight_number,
      checkinCalc.utc.departureUTC
    );

    if (duplicate) {
      await sendText(from,
        `ℹ️ Ya tengo registrado el vuelo *${ticketData.flight_number}*.\n` +
        `Escribí *LISTA* para ver tus recordatorios.`
      );
      return;
    }

    // 3) Guardar vuelo en DB
    const flight = await saveFlight({
      userId: user.id,
      airlineCode: ticketData.compania,
      flightData: {
        flight_number: ticketData.flight_number,
        origin: ticketData.origen || checkinCalc.origin.iata,
        destination: ticketData.destino,
        pasajero: ticketData.pasajero,
        numero_reserva: ticketData.numero_reserva,
        clase: ticketData.clase,
        confidence: ticketData.confidence
      },
      checkinCalc
    });

    // 4) Guardar ticket
    await saveTicket({
      userId: user.id,
      flightId: flight.id,
      extractedText: ticketData.texto_extraido,
      source: ticketData.tipo_fuente
    });

    // 5) Enviar info del check-in
    const checkinMessage = formatCheckinMessage(checkinCalc);
    await sendText(from, checkinMessage);

    // 6) Si el check-in ya está abierto o expiró no pedir confirmación
    if (checkinCalc.status.yaEstaAbierto || checkinCalc.status.yaExpiro) {
      return;
    }

    // 7) Guardar confirmación pendiente
    await savePendingConfirmation(from, flight.id, {
      type: 'awaiting_reminder_confirmation',
      flightId: flight.id,
      checkinOpensUTC: checkinCalc.utc.checkinOpensUTC,
      checkinOpensUser: checkinCalc.checkinUserTime.opens
    });

    // 8) Pedir confirmación con botones
    await sendQuickReply(
      from,
      `¿Querés que te avise cuando abra el check-in?`,
      [
        { id: 'confirm_yes', title: 'SI ✅' },
        { id: 'confirm_no', title: 'NO ❌' }
      ]
    );

  } catch (err) {
    console.error('[Webhook] Error procesando vuelo:', err.message);
    await sendText(from, templates.errorGeneral());
  }
}

/**
 * Maneja respuestas SI/NO a confirmaciones pendientes
 */
async function handleConfirmation(from, user, accepted) {
  const pending = await getPendingConfirmation(from);
  if (!pending) return false;

  const payload = pending.payload;

  if (payload.type === 'awaiting_reminder_confirmation') {
    await deletePendingConfirmation(from);

    if (accepted) {
      await createReminder(payload.flightId, user.id, payload.checkinOpensUTC);
      await sendText(from, templates.reminderSet(payload.checkinOpensUser));
    } else {
      await sendText(from, templates.reminderCancelled());
    }
    return true;
  }

  return false;
}

/**
 * Maneja respuesta con código IATA cuando faltaba el origen
 */
async function handleIATAResponse(from, user, iataCode) {
  const pending = await getPendingConfirmation(from);
  if (!pending || pending.payload?.type !== 'awaiting_iata') return false;

  const ticketData = pending.payload.ticketData;
  ticketData.origen = iataCode;

  await deletePendingConfirmation(from);
  await sendText(from, `📍 Aeropuerto de salida: *${iataCode}*. Procesando...`);

  await processFlightData(from, user, ticketData);
  return true;
}

/**
 * Muestra los recordatorios activos del usuario
 */
async function handleListReminders(from) {
  const reminders = await getUserReminders(from);

  if (reminders.length === 0) {
    await sendText(from, templates.noReminders());
    return;
  }

  const { DateTime } = require('luxon');

  let msg = `📋 *Tus recordatorios activos (${reminders.length}):*\n\n`;

  reminders.forEach((r, i) => {
    const flight = r.flights;
    if (!flight) return;

    const originTz = flight.metadata?.origin_timezone || 'UTC';

    const departure = DateTime
      .fromISO(flight.departure_datetime)
      .setZone(originTz)
      .toFormat('dd/MM/yyyy HH:mm');

    const checkinOpen = DateTime
      .fromISO(flight.checkin_open_at)
      .setZone('America/Argentina/Buenos_Aires')
      .toFormat('dd/MM/yyyy HH:mm');

    msg += `${i + 1}. ✈️ *${flight.flight_number}*\n`;
    msg += `   🛫 ${flight.origin} → ${flight.destination}\n`;
    msg += `   📅 Sale: ${departure}\n`;
    msg += `   🔔 Check-in abre (ARG): ${checkinOpen}\n`;

    if (flight.metadata?.pasajero) {
      msg += `   👤 ${flight.metadata.pasajero}\n`;
    }
    if (flight.metadata?.numero_reserva) {
      msg += `   🔖 Reserva: ${flight.metadata.numero_reserva}\n`;
    }

    msg += `\n`;
  });

  await sendText(from, msg);
}

module.exports = router;