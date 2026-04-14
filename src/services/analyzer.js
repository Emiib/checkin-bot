// src/services/analyzer.js
// Usa Claude Haiku para leer el voucher y extraer los datos del viaje

const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Prompt base para extraer datos del voucher
const EXTRACTION_PROMPT = `Eres un asistente especializado en extraer información de vouchers y tickets de viaje.

Analiza el contenido y extrae SOLO los datos en formato JSON puro, sin texto adicional ni backticks.

Campos a extraer:
- compania: nombre de la aerolínea, tren o compañía de transporte
- numero_vuelo: código de vuelo o tren (ej: AR1904, IB3456)
- numero_reserva: código PNR o localizador de reserva
- pasajero: nombre completo del pasajero principal
- fecha_salida: fecha del PRIMER vuelo/trayecto en formato YYYY-MM-DD
- hora_salida: hora del PRIMER vuelo/trayecto en formato HH:MM (24h)
- origen: ciudad o aeropuerto de origen
- destino: ciudad o aeropuerto de destino final
- tipo: "aereo", "tren" o "ferry"

Si hay múltiples vuelos (ida y vuelta), extraé solo el PRIMERO cronológicamente.
Si algún campo no aparece, usá null.

Responde ÚNICAMENTE con el JSON, sin explicaciones ni texto adicional.`;

/**
 * Descarga un archivo de WhatsApp usando su media_id
 */
async function downloadWhatsAppMedia(mediaId) {
  const metaResponse = await axios.get(
    `https://graph.facebook.com/v19.0/${mediaId}`,
    { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
  );

  const fileUrl = metaResponse.data.url;

  const fileResponse = await axios.get(fileUrl, {
    responseType: 'arraybuffer',
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
  });

  return Buffer.from(fileResponse.data);
}

/**
 * Analiza un voucher de texto plano con Claude
 */
async function analyzeTextVoucher(text) {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    messages: [
      {
        role: 'user',
        content: `${EXTRACTION_PROMPT}\n\nTEXTO DEL VOUCHER:\n${text}`
      }
    ]
  });

  const raw = response.content[0].text.trim();
  return JSON.parse(raw.replace(/```json|```/g, '').trim());
}

/**
 * Analiza un voucher en imagen (JPG, PNG) con Claude Vision
 */
async function analyzeImageVoucher(imageBuffer, mimeType) {
  // Claude acepta estos tipos de imagen
  const validImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const imageMediaType = validImageTypes.includes(mimeType) ? mimeType : 'image/jpeg';

  const base64Image = imageBuffer.toString('base64');

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: imageMediaType,
              data: base64Image
            }
          },
          {
            type: 'text',
            text: EXTRACTION_PROMPT
          }
        ]
      }
    ]
  });

  const raw = response.content[0].text.trim();
  return JSON.parse(raw.replace(/```json|```/g, '').trim());
}

/**
 * Analiza un PDF enviado por WhatsApp con Claude
 * Claude puede leer PDFs directamente como documentos
 */
async function analyzePDFVoucher(pdfBuffer) {
  const base64PDF = pdfBuffer.toString('base64');

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: base64PDF
            }
          },
          {
            type: 'text',
            text: EXTRACTION_PROMPT
          }
        ]
      }
    ]
  });

  const raw = response.content[0].text.trim();
  return JSON.parse(raw.replace(/```json|```/g, '').trim());
}

/**
 * Función principal: procesa el mensaje entrante de WhatsApp
 */
async function processMessage(message) {
  const msgType = message.type;

  // Caso 1: Texto
  if (msgType === 'text') {
    return await analyzeTextVoucher(message.text.body);
  }

  // Caso 2: Imagen (JPG, PNG)
  if (msgType === 'image') {
    const mediaId = message.image.id;
    const mimeType = message.image.mime_type || 'image/jpeg';
    const buffer = await downloadWhatsAppMedia(mediaId);
    return await analyzeImageVoucher(buffer, mimeType);
  }

  // Caso 3: Documento PDF
  if (msgType === 'document') {
    const mediaId = message.document.id;
    const mimeType = message.document.mime_type || 'application/pdf';
    const buffer = await downloadWhatsAppMedia(mediaId);

    // Si es PDF, usamos el lector nativo de Claude
    if (mimeType === 'application/pdf') {
      return await analyzePDFVoucher(buffer);
    }

    // Si es imagen enviada como documento
    return await analyzeImageVoucher(buffer, mimeType);
  }

  throw new Error(`Tipo de mensaje no soportado: ${msgType}`);
}

module.exports = { processMessage, analyzeTextVoucher, analyzeImageVoucher, analyzePDFVoucher };
