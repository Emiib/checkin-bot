const axios = require('axios');

const WHATSAPP_API = `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_ID}/messages`;
const HEADERS = {
  Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
  'Content-Type': 'application/json'
};

/**
 * Envía un mensaje de texto simple
 */
async function sendText(to, body) {
  try {
    await axios.post(WHATSAPP_API, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body }
    }, { headers: HEADERS });
    console.log(`[WhatsApp] ✅ Mensaje enviado a ${to}`);
  } catch (err) {
    console.error(`[WhatsApp] ❌ Error enviando a ${to}:`, err.response?.data || err.message);
    throw err;
  }
}

/**
 * Descarga media (imagen, documento, audio) de WhatsApp
 * Retorna un Buffer con el contenido
 */
async function downloadMedia(mediaId) {
  try {
    // Paso 1: obtener URL del media
    const mediaInfo = await axios.get(
      `https://graph.facebook.com/v21.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
    );
    const mediaUrl = mediaInfo.data.url;

    // Paso 2: descargar el archivo
    const response = await axios.get(mediaUrl, {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
      responseType: 'arraybuffer'
    });

    console.log(`[WhatsApp] ✅ Media ${mediaId} descargado (${response.data.length} bytes)`);
    return Buffer.from(response.data);
  } catch (err) {
    console.error(`[WhatsApp] ❌ Error descargando media ${mediaId}:`, err.message);
    throw err;
  }
}

/**
 * Envía un mensaje con botones de respuesta rápida
 */
async function sendQuickReply(to, bodyText, buttons) {
  try {
    await axios.post(WHATSAPP_API, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: {
          buttons: buttons.map((btn, i) => ({
            type: 'reply',
            reply: {
              id: btn.id || `btn_${i}`,
              title: btn.title.substring(0, 20) // máx 20 chars
            }
          }))
        }
      }
    }, { headers: HEADERS });
    console.log(`[WhatsApp] ✅ Quick reply enviado a ${to}`);
  } catch (err) {
    console.error(`[WhatsApp] ❌ Error enviando quick reply:`, err.response?.data || err.message);
    // Fallback a texto normal si falla
    const fallback = bodyText + '\n\nRespondé: ' + buttons.map(b => `*${b.title}*`).join(' o ');
    await sendText(to, fallback);
  }
}

module.exports = {
  sendText,
  downloadMedia,
  sendQuickReply
};