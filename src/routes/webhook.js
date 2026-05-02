const express = require('express');
const router = express.Router();
const { supabase } = require('../db/supabase');

// Servicios
const { processMessage } = require('../services/analyzer');
const { calculateCheckin, formatCheckinMessage } = require('../services/checkinCalculator');
const { upsertUser, saveFlight, saveTicket, findDuplicateFlight } = require('../services/flightService');
const { savePendingConfirmation, getPendingConfirmation, deletePendingConfirmation } = require('../services/confirmationService');
const { createReminder, getUserReminders } = require('../services/reminderService');
const { sendText, sendQuickReply } = require('../services/whatsapp');
const { findExistingFlight, detectChanges, saveChanges, updateFlight, formatChangeMessage } = require('../services/changeDetector');
const { cancelFlightReminders } = require('../services/reminderService');

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

    const tiposValidos = ['text', 'image', 'document', 'audio'];
    if (!tiposValidos.includes(message.type)) return;

    const from = normalizePhone(message.from);
    const msgType = message.type;

    console.log(`[Webhook] 📨 Mensaje de ${from} — tipo: ${msgType}`);

    const user = await upsertUser(from);

    // ══════════════════════════════════════════════════════════════════════
    // COMANDOS DE TEXTO
    // ══════════════════════════════════════════════════════════════════════
    if (msgType === 'text') {
      const text = message.text.body.trim();
      const textUpper = text.toUpperCase();

      if (['SÍ', 'SI', 'S', 'YES'].includes(textUpper)) {
        const handled = await handleConfirmation(from, user, true);
        if (handled) return;
      }

      if (['NO', 'N'].includes(textUpper)) {
        const handled = await handleConfirmation(from, user, false);
        if (handled) return;
      }

      if (/^[A-Z]{3}$/.test(textUpper)) {
        const handled = await handleIATAResponse(from, user, textUpper);
        if (handled) return;
      }

      if (['LISTA', 'RECORDATORIOS', 'MIS VUELOS'].includes(textUpper)) {
        await handleListReminders(from);
        return;
      }

      // ── Comando: BORRAR recordatorio ───────────────────────────────────
      if (textUpper.startsWith('BORRAR ')) {
        await handleDeleteReminder(from, textUpper);
        return;
      }

      if (['HOLA', 'START', 'INICIO', 'HELP', 'AYUDA', 'MENU', 'MENÚ'].includes(textUpper)) {
        await sendText(from, templates.welcome());
        return;
      }

      if (text.length < 30) {
        await sendText(from, templates.welcome());
        return;
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // PROCESAMIENTO DE VOUCHER
    // ══════════════════════════════════════════════════════════════════════
    if (['text', 'image', 'document', 'audio'].includes(msgType)) {

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
      if (!ticketData.vuelos || ticketData.vuelos.length === 0) {
        await sendText(from, templates.errorNoData());
        return;
      }

      // 3) Procesar vuelos
      if (ticketData.multiple && ticketData.vuelos.length > 1) {
        await processMultipleFlights(from, user, ticketData);
      } else {
        const vuelo = ticketData.vuelos[0];
        vuelo.numero_reserva = vuelo.numero_reserva || ticketData.numero_reserva;
        vuelo.pasajero = vuelo.pasajero || (ticketData.pasajeros?.[0] || null);

        if (!vuelo.origen && !vuelo.origen_ciudad) {
          await savePendingConfirmation(from, null, {
            type: 'awaiting_iata',
            ticketData: vuelo
          });
          await sendText(from, templates.missingOrigin(vuelo));
          return;
        }

        await processFlightData(from, user, vuelo);
      }
    }

  } catch (error) {
    console.error('[Webhook] ❌ Error general:', error);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// FUNCIONES AUXILIARES
// ══════════════════════════════════════════════════════════════════════════════

async function processFlightData(from, user, ticketData) {
  try {
    const checkinCalc = await calculateCheckin({
      originIATA: ticketData.origen,
      originCity: ticketData.origen_ciudad,
      airlineCode: ticketData.compania,
      departureDate: ticketData.fecha_salida,
      departureTime: ticketData.hora_salida,
      userTimezone: user.timezone || 'America/Argentina/Buenos_Aires'
    });

    if (checkinCalc.error) {
      await sendText(from, `⚠️ ${checkinCalc.message}\n\nRevisá los datos e intentá de nuevo.`);
      return;
    }

    // ── Verificar si es una ACTUALIZACIÓN de un vuelo existente ──────
    const existingFlight = await findExistingFlight(user.id, ticketData);

    if (existingFlight) {
      const changes = detectChanges(existingFlight, ticketData, checkinCalc);

      if (changes.length === 0) {
        // No hay cambios, es duplicado
        await sendText(from,
          `ℹ️ Ya tengo registrado el vuelo *${ticketData.flight_number}* y no hay cambios.\n` +
          `Escribí *LISTA* para ver tus recordatorios.`
        );
        return;
      }

      // Hay cambios → actualizar
      console.log(`[Changes] 🔄 ${changes.length} cambio(s) detectado(s) en ${existingFlight.flight_number}`);

      // Guardar historial de cambios
      await saveChanges(existingFlight.id, user.id, changes);

      // Actualizar el vuelo
      await updateFlight(existingFlight.id, checkinCalc, ticketData);

      // Cancelar recordatorios viejos
      await cancelFlightReminders(existingFlight.id);

      // Crear nuevo recordatorio si el check-in no abrió
      if (!checkinCalc.status.yaEstaAbierto && !checkinCalc.status.yaExpiro) {
        await createReminder(existingFlight.id, user.id, checkinCalc.utc.checkinOpensUTC);
      }

      // Notificar cambios al usuario
      const changeMsg = formatChangeMessage(changes, ticketData.flight_number || existingFlight.flight_number);
      await sendText(from, changeMsg);

      // Enviar info actualizada del check-in
      const checkinMessage = formatCheckinMessage(checkinCalc);
      await sendText(from, checkinMessage);

      await sendText(from, `🔔 Recordatorio actualizado automáticamente ✅`);
      return;
    }

    // ── Vuelo nuevo (no existe en DB) ────────────────────────────────
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

    // Guardar departure original
    await supabase
      .from('flights')
      .update({ original_departure_datetime: checkinCalc.utc.departureUTC })
      .eq('id', flight.id);

    await saveTicket({
      userId: user.id,
      flightId: flight.id,
      extractedText: ticketData.texto_extraido || '',
      source: ticketData.tipo_fuente || 'text'
    });

    const checkinMessage = formatCheckinMessage(checkinCalc);
    await sendText(from, checkinMessage);

    if (!checkinCalc.status.yaEstaAbierto && !checkinCalc.status.yaExpiro) {
      await createReminder(flight.id, user.id, checkinCalc.utc.checkinOpensUTC);
      await sendText(from, `🔔 Recordatorio programado automáticamente ✅`);
    }

  } catch (err) {
    console.error('[Webhook] Error procesando vuelo:', err.message);
    await sendText(from, templates.errorGeneral());
  }
}

async function processMultipleFlights(from, user, ticketData) {
  try {
    const vuelos = ticketData.vuelos;
    const pasajeros = ticketData.pasajeros || [];
    const reserva = ticketData.numero_reserva;

    await sendText(from,
      `📋 *Itinerario detectado*\n\n` +
      `🔖 Reserva: *${reserva || 'N/A'}*\n` +
      `👥 Pasajeros: ${pasajeros.length > 0 ? pasajeros.join(', ') : 'N/A'}\n` +
      `✈️ Vuelos encontrados: *${vuelos.length}*\n\n` +
      `Procesando cada vuelo...`
    );

    let vuelosProcesados = 0;
    let vuelosConError = 0;
    let recordatoriosProgramados = 0;

    for (let i = 0; i < vuelos.length; i++) {
      const vuelo = vuelos[i];
      vuelo.numero_reserva = vuelo.numero_reserva || reserva;
      vuelo.pasajero = vuelo.pasajero || (pasajeros[0] || null);

      try {
        if (!vuelo.origen && !vuelo.origen_ciudad) {
          await sendText(from,
            `⚠️ Vuelo ${i + 1} (${vuelo.flight_number || 'sin número'}): ` +
            `no pude detectar el aeropuerto de salida. Salteado.`
          );
          vuelosConError++;
          continue;
        }

        // Procesar vuelo SIN pedir confirmación individual
        const result = await processFlightDataSilent(from, user, vuelo);

        if (result && result.flight && result.checkinCalc) {
          vuelosProcesados++;

          // Auto-programar recordatorio si el check-in no abrió ni expiró
          if (!result.checkinCalc.status.yaEstaAbierto && !result.checkinCalc.status.yaExpiro) {
            await createReminder(
              result.flight.id,
              user.id,
              result.checkinCalc.utc.checkinOpensUTC
            );
            recordatoriosProgramados++;
          }
        } else if (result && result.duplicate) {
          // No contar como error, solo avisar
        } else {
          vuelosConError++;
        }

        if (i < vuelos.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1500));
        }

      } catch (err) {
        console.error(`[Webhook] Error procesando vuelo ${i + 1}:`, err.message);
        vuelosConError++;
      }
    }

    // Resumen final
    let resumen = `\n📊 *Resumen del itinerario:*\n\n`;
    resumen += `✅ Vuelos procesados: ${vuelosProcesados}\n`;
    resumen += `🔔 Recordatorios programados: ${recordatoriosProgramados}\n`;
    if (vuelosConError > 0) {
      resumen += `⚠️ Vuelos con error: ${vuelosConError}\n`;
    }
    resumen += `\nTe voy a avisar antes de cada check-in. 💪\n`;
    resumen += `Escribí *LISTA* para ver tus recordatorios.`;

    await sendText(from, resumen);

  } catch (err) {
    console.error('[Webhook] Error procesando itinerario:', err.message);
    await sendText(from, templates.errorGeneral());
  }
}

async function processFlightDataSilent(from, user, ticketData) {
  try {
    const checkinCalc = await calculateCheckin({
      originIATA: ticketData.origen,
      originCity: ticketData.origen_ciudad,
      airlineCode: ticketData.compania,
      departureDate: ticketData.fecha_salida,
      departureTime: ticketData.hora_salida,
      userTimezone: user.timezone || 'America/Argentina/Buenos_Aires'
    });

    if (checkinCalc.error) {
      await sendText(from, `⚠️ ${checkinCalc.message}`);
      return null;
    }

    // Verificar si es actualización
    const existingFlight = await findExistingFlight(user.id, ticketData);

    if (existingFlight) {
      const changes = detectChanges(existingFlight, ticketData, checkinCalc);

      if (changes.length === 0) {
        return { duplicate: true };
      }

      // Actualizar vuelo existente
      await saveChanges(existingFlight.id, user.id, changes);
      await updateFlight(existingFlight.id, checkinCalc, ticketData);
      await cancelFlightReminders(existingFlight.id);

      const changeMsg = formatChangeMessage(changes, ticketData.flight_number || existingFlight.flight_number);
      await sendText(from, changeMsg);

      const checkinMessage = formatCheckinMessage(checkinCalc);
      await sendText(from, checkinMessage);

      return { flight: existingFlight, checkinCalc, updated: true };
    }

    // Vuelo nuevo
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

    await supabase
      .from('flights')
      .update({ original_departure_datetime: checkinCalc.utc.departureUTC })
      .eq('id', flight.id);

    await saveTicket({
      userId: user.id,
      flightId: flight.id,
      extractedText: ticketData.texto_extraido || '',
      source: ticketData.tipo_fuente || 'text'
    });

    const checkinMessage = formatCheckinMessage(checkinCalc);
    await sendText(from, checkinMessage);

    return { flight, checkinCalc };

  } catch (err) {
    console.error('[Webhook] Error en processFlightDataSilent:', err.message);
    await sendText(from, `⚠️ Error procesando vuelo ${ticketData.flight_number || ''}`);
    return null;
  }
}

/**
 * Procesa un vuelo sin pedir confirmación (para itinerarios múltiples)
 * Retorna el vuelo guardado y el cálculo de check-in
 */
async function processFlightData(from, user, ticketData) {
  try {
    const checkinCalc = await calculateCheckin({
      originIATA: ticketData.origen,
      originCity: ticketData.origen_ciudad,
      airlineCode: ticketData.compania,
      departureDate: ticketData.fecha_salida,
      departureTime: ticketData.hora_salida,
      userTimezone: user.timezone || 'America/Argentina/Buenos_Aires'
    });

    if (checkinCalc.error) {
      await sendText(from, `⚠️ ${checkinCalc.message}\n\nRevisá los datos e intentá de nuevo.`);
      return;
    }

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

    await saveTicket({
      userId: user.id,
      flightId: flight.id,
      extractedText: ticketData.texto_extraido || '',
      source: ticketData.tipo_fuente || 'text'
    });

    const checkinMessage = formatCheckinMessage(checkinCalc);
    await sendText(from, checkinMessage);

    // Auto-programar recordatorio siempre
    if (!checkinCalc.status.yaEstaAbierto && !checkinCalc.status.yaExpiro) {
      await createReminder(flight.id, user.id, checkinCalc.utc.checkinOpensUTC);
      await sendText(from, `🔔 Recordatorio programado automáticamente ✅`);
    }

  } catch (err) {
    console.error('[Webhook] Error procesando vuelo:', err.message);
    await sendText(from, templates.errorGeneral());
  }
}

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

    msg += `*${i + 1}.* ✈️ *${flight.flight_number}*\n`;
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

  msg += `─────────────────\n`;
  msg += `Para eliminar un recordatorio escribí:\n`;
  msg += `*BORRAR 1* o *BORRAR 2* (el número del vuelo)`;

  await sendText(from, msg);
}

async function handleDeleteReminder(from, textUpper) {
  const parts = textUpper.split(' ');
  const index = parseInt(parts[1]) - 1;

  if (isNaN(index) || index < 0) {
    await sendText(from, `⚠️ Formato incorrecto. Escribí *BORRAR 1* para eliminar el primer recordatorio.`);
    return;
  }

  const reminders = await getUserReminders(from);

  if (reminders.length === 0) {
    await sendText(from, templates.noReminders());
    return;
  }

  if (index >= reminders.length) {
    await sendText(from, `⚠️ Solo tenés ${reminders.length} recordatorio(s). Escribí *BORRAR 1* a *BORRAR ${reminders.length}*.`);
    return;
  }

  const reminder = reminders[index];
  const flightNumber = reminder.flights?.flight_number || 'desconocido';
  const flightId = reminder.flight_id;

  const { error } = await supabase
    .from('checkin_events')
    .update({ event_type: 'cancelled' })
    .eq('flight_id', flightId)
    .eq('event_type', 'scheduled');

  if (error) {
    console.error('[Reminder] Error cancelando:', error.message);
    await sendText(from, `❌ Error eliminando el recordatorio. Intentá de nuevo.`);
    return;
  }

  await sendText(from,
    `🗑️ Recordatorio del vuelo *${flightNumber}* eliminado.\n\n` +
    `Escribí *LISTA* para ver los que quedan.`
  );
}

module.exports = router;