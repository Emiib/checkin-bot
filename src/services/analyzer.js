const Anthropic = require('@anthropic-ai/sdk');
const { downloadMedia } = require('./whatsapp');
const { transcribeAudio } = require('./audioTranscriber');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `Eres un experto analizador de tickets y vouchers de vuelos aéreos.
Tu trabajo es extraer información estructurada de cualquier texto, imagen o descripción de un ticket de vuelo.

DEBES devolver SIEMPRE un JSON válido con esta estructura exacta:
{
  "compania": "código IATA de la aerolínea (ej: AR, LA, AA, IB, UA)",
  "compania_nombre": "nombre completo de la aerolínea",
  "flight_number": "número de vuelo completo (ej: AR1133)",
  "origen": "código IATA del aeropuerto de salida (ej: EZE, MAD, MIA)",
  "origen_ciudad": "nombre de la ciudad de origen",
  "destino": "código IATA del aeropuerto de destino",
  "destino_ciudad": "nombre de la ciudad de destino",
  "fecha_salida": "YYYY-MM-DD",
  "hora_salida": "HH:MM (formato 24h, hora local del origen)",
  "fecha_llegada": "YYYY-MM-DD o null si no está",
  "hora_llegada": "HH:MM o null si no está",
  "numero_reserva": "PNR o código de reserva si aparece",
  "pasajero": "nombre del pasajero si aparece",
  "clase": "clase de servicio si aparece (Economy, Business, etc.)",
  "asiento": "número de asiento si aparece",
  "confidence": "HIGH, MEDIUM o LOW según qué tan seguro estás de los datos"
}

REGLAS:
- Si no encontrás un dato, poné null (no inventar).
- Los códigos IATA de aerolínea son de 2 letras (AR, LA, AA, etc.).
- Los códigos IATA de aeropuerto son de 3 letras (EZE, MAD, MIA, etc.).
- La hora SIEMPRE en formato 24h.
- La fecha SIEMPRE en formato YYYY-MM-DD.
- Si el texto está en otro idioma, traducí los campos al español.
- Si hay múltiples vuelos (conexiones), extraé solo el PRIMERO.
- NUNCA devuelvas texto fuera del JSON.`;

async function processMessage(message) {
  let extractedText = '';
  let analysisResult;

  switch (message.type) {
    case 'text':
      extractedText = message.text.body;
      analysisResult = await analyzeWithText(extractedText);
      break;

    case 'image':
      analysisResult = await analyzeWithVision(
        message.image.id,
        message.image.mime_type || 'image/jpeg',
        message.image.caption || ''
      );
      extractedText = message.image.caption || '[imagen sin caption]';
      break;

    case 'document':
      const docBuffer = await downloadMedia(message.document.id);
      const mimeType = message.document.mime_type || 'application/pdf';
      if (mimeType === 'application/pdf') {
        analysisResult = await analyzeDocumentWithVision(
          docBuffer,
          mimeType,
          message.document.filename || 'documento.pdf'
        );
      } else {
        extractedText = docBuffer.toString('utf-8');
        analysisResult = await analyzeWithText(extractedText);
      }
      extractedText = message.document.filename || '[documento]';
      break;

    case 'audio':
      extractedText = await transcribeAudio(message.audio.id);
      analysisResult = await analyzeWithText(extractedText);
      break;

    default:
      throw new Error(`Tipo de mensaje no soportado: ${message.type}`);
  }

  analysisResult.texto_extraido = extractedText;
  analysisResult.tipo_fuente = message.type;

  return analysisResult;
}

async function analyzeWithText(text) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Analiza este texto de un ticket/voucher de vuelo y extraé la información:\n\n${text}`
      }]
    });

    const content = response.content[0].text;
    console.log('[Analyzer] ✅ Análisis de texto completado');
    return parseAnalysisResponse(content);

  } catch (err) {
    console.error('[Analyzer] ❌ Error con Claude (texto):', err.message);
    throw new Error('No pude analizar el texto del voucher');
  }
}

async function analyzeWithVision(mediaId, mimeType, caption) {
  try {
    const imageBuffer = await downloadMedia(mediaId);
    const base64Image = imageBuffer.toString('base64');

    const supportedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const safeType = supportedTypes.includes(mimeType) ? mimeType : 'image/jpeg';

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: safeType,
              data: base64Image
            }
          },
          {
            type: 'text',
            text: `Analiza esta imagen de un ticket/voucher de vuelo y extraé la información.${caption ? ` Descripción adicional: ${caption}` : ''}`
          }
        ]
      }]
    });

    const content = response.content[0].text;
    console.log('[Analyzer] ✅ Análisis de imagen completado');
    return parseAnalysisResponse(content);

  } catch (err) {
    console.error('[Analyzer] ❌ Error con Claude Vision:', err.message);
    throw new Error('No pude analizar la imagen');
  }
}

async function analyzeDocumentWithVision(buffer, mimeType, filename) {
  try {
    const base64Doc = buffer.toString('base64');

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: base64Doc
            }
          },
          {
            type: 'text',
            text: `Analiza este documento PDF (${filename}) que es un ticket/voucher de vuelo y extraé la información.`
          }
        ]
      }]
    });

    const content = response.content[0].text;
    console.log('[Analyzer] ✅ Análisis de PDF completado');
    return parseAnalysisResponse(content);

  } catch (err) {
    console.error('[Analyzer] ❌ Error analizando PDF:', err.message);

    // Fallback: extraer texto del buffer
    console.log('[Analyzer] Intentando fallback texto...');
    const text = buffer.toString('utf-8')
      .replace(/[^\x20-\x7E\xC0-\xFF\n]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (text.length > 50) {
      return await analyzeWithText(text);
    }

    throw new Error('No pude analizar el documento PDF');
  }
}

function parseAnalysisResponse(content) {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No se encontró JSON en la respuesta');
    }

    const parsed = JSON.parse(jsonMatch[0]);

    if (!parsed.compania && !parsed.flight_number && !parsed.fecha_salida) {
      throw new Error('JSON sin datos útiles del vuelo');
    }

    console.log(`[Analyzer] ✅ Datos extraídos:`, {
      compania: parsed.compania,
      vuelo: parsed.flight_number,
      origen: parsed.origen,
      fecha: parsed.fecha_salida,
      hora: parsed.hora_salida,
      confidence: parsed.confidence
    });

    return parsed;

  } catch (err) {
    console.error('[Analyzer] ❌ Error parseando respuesta:', err.message);
    console.error('[Analyzer] Respuesta raw:', content.substring(0, 500));
    throw new Error('No pude interpretar los datos del voucher');
  }
}

module.exports = { processMessage };