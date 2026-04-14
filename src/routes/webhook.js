// src/routes/webhook.js
// Recibe y procesa los mensajes entrantes de WhatsApp

const express = require('express');
const router = express.Router();

const { processMessage } = require('../services/analyzer');
const { getCheckinInfo } = require('../utils/checkin');
const { scheduleCheckinReminder, listReminders } = require('../services/scheduler');
const {
  sendCheckinConfirmation,
  sendErrorMessage,
  sendWelcomeMessage,
  sendText
} = require('../services/whatsapp');

// Mapa temporal para esperar confirmación del agente (SÍ/NO)
// Clave: número de teléfono | Valor: checkinInfo pendiente de confirmar
const pendingConfirmations = new Map();

// ─── Verificación del webhook (requerida por Meta) ───────────────────────────
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

// ─── Recepción de mensajes ────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  // Responder 200 inmediatamente (Meta requiere respuesta rápida)
  res.sendStatus(200);

  try {
    const body = req.body;

    // Verificar que es un mensaje de WhatsApp
    if (!body.object || body.object !== 'whatsapp_business_account') return;

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (!messages || messages.length === 0) return;

    const message = messages[0];
	let from = message.from;
	if (from.startsWith('549') && from.length === 13) {
	  from = '54' + from.slice(3); // 5493512395563 → 543512395563
} // Número del agente
    const msgType = message.type;
    console.log(`[Webhook] Mensaje de ${from} — tipo: ${msgType}`);

    // ── Comandos de texto especiales ──────────────────────────────────────────
    if (msgType === 'text') {
      const text = message.text.body.trim().toUpperCase();

      // Confirmación del agente: "SÍ" o "SI" para programar el recordatorio
      if ((text === 'SÍ' || text === 'SI' || text === 'S' || text === 'YES') && pendingConfirmations.has(from)) {
        const checkinInfo = pendingConfirmations.get(from);
        pendingConfirmations.delete(from);

        const reminderId = scheduleCheckinReminder(from, checkinInfo);

        if (reminderId) {
          await sendText(from,
            `🔔 ¡Perfecto! Te avisaré el *${checkinInfo.fecha_checkin_formateada}* cuando se abra el check-in.\n\n_Recordatorio programado ✅_`
          );
        } else {
          await sendText(from, `ℹ️ El check-in ya está disponible. ¡No olvides hacerlo!`);
        }
        return;
      }

      // Cancelar: "NO" para no programar
      if ((text === 'NO' || text === 'N') && pendingConfirmations.has(from)) {
        pendingConfirmations.delete(from);
        await sendText(from, `👍 Entendido, no programaré el recordatorio. Envíame otro ticket cuando quieras.`);
        return;
      }

      // Comando de lista de recordatorios activos
      if (text === 'RECORDATORIOS' || text === 'LISTA') {
        const list = listReminders();
        if (list.length === 0) {
          await sendText(from, `📭 No tienes recordatorios activos en este momento.`);
        } else {
          let msg = `📋 *Recordatorios activos (${list.length}):*\n\n`;
          list.forEach((r, i) => {
            msg += `${i + 1}. ${r.compania} — ${r.numero_reserva}\n`;
            msg += `   🕐 Check-in abre: ${r.checkin_abre}\n\n`;
          });
          await sendText(from, msg);
        }
        return;
      }

      // Saludo / bienvenida
      if (text === 'HOLA' || text === 'START' || text === 'INICIO' || text === 'HELP' || text === 'AYUDA') {
        await sendWelcomeMessage(from);
        return;
      }
    }

    // ── Procesamiento de voucher (texto, imagen o PDF) ─────────────────────
    if (['text', 'image', 'document'].includes(msgType)) {

      // Si es texto corto (< 20 chars), probablemente no es un voucher
      if (msgType === 'text' && message.text.body.length < 20) {
        await sendWelcomeMessage(from);
        return;
      }

      await sendText(from, `⏳ Analizando tu voucher... un momento por favor.`);

      // Analizar el voucher con IA
      let ticketData;
      try {
        ticketData = await processMessage(message);
      } catch (err) {
        console.error('[Webhook] Error analizando voucher:', err.message);
        await sendErrorMessage(from);
        return;
      }

      // Si no se detectó compañía ni fecha, error
      if (!ticketData.compania && !ticketData.fecha_salida) {
        await sendErrorMessage(from);
        return;
      }

      // Calcular info del check-in
      const checkinInfo = getCheckinInfo(ticketData);

      if (checkinInfo.error) {
        await sendText(from, `⚠️ ${checkinInfo.mensaje}\n\nPor favor revisa el formato del ticket e inténtalo de nuevo.`);
        return;
      }

      // Enviar confirmación al agente
      await sendCheckinConfirmation(from, checkinInfo);

      // Si el check-in ya está abierto, no necesitamos confirmación
      if (!checkinInfo.ya_esta_abierto) {
        // Guardamos la info en espera de que el agente responda SÍ/NO
        pendingConfirmations.set(from, checkinInfo);
      }
    }

  } catch (error) {
    console.error('[Webhook] Error general:', error);
  }
});

module.exports = router;
