const Anthropic = require('@anthropic-ai/sdk');
const { downloadMedia } = require('./whatsapp');
const { transcribeAudio } = require('./audioTranscriber');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function GetSystemPrompt() {
  const today = new Date().toISOString().split('T')[0];
  return `Eres un experto analizador de tickets y vouchers de vuelos aéreos.
Tu trabajo es extraer información estructurada de cualquier texto, imagen o descripción de un ticket de vuelo.

IMPORTANTE: La fecha de hoy es ${today}. Si el año no está especificado en el ticket, usá el año actual o el próximo año si la fecha ya pasó en el año actual.

DEBES devolver SIEMPRE un JSON válido.

Si hay UN SOLO vuelo, devolvé este formato:
{
  "multiple": false,
  "vuelos": [{
    "compania": "código IATA de la aerolínea (ej: AR, LA, AA, IB, UA)",
    "compania_nombre": "nombre completo de la aerolínea",
    "flight_number": "número de vuelo completo (ej: AR1884)",
    "origen": "código IATA del aeropuerto de salida (ej: EZE, AEP, MAD)",
    "origen_ciudad": "nombre de la ciudad de origen",
    "destino": "código IATA del aeropuerto de destino",
    "destino_ciudad": "nombre de la ciudad de destino",
    "fecha_salida": "YYYY-MM-DD",
    "hora_salida": "HH:MM (formato 24h, hora local del origen)",
    "fecha_llegada": "YYYY-MM-DD o null",
    "hora_llegada": "HH:MM o null",
    "numero_reserva": "PNR o código de reserva",
    "pasajero": "nombre del pasajero principal",
    "clase": "clase de servicio (Economy, Business, etc.)",
    "asiento": "número de asiento o null",
    "confidence": "HIGH, MEDIUM o LOW"
  }]
}

Si hay MÚLTIPLES vuelos (conexiones, ida/vuelta, itinerario completo), devolvé TODOS:
{
  "multiple": true,
  "numero_reserva": "PNR general del itinerario",
  "pasajeros": ["nombre pasajero 1", "nombre pasajero 2"],
  "vuelos": [
    {
      "compania": "AR",
      "compania_nombre": "Aerolíneas Argentinas",
      "flight_number": "AR1884",
      "origen": "AEP",
      "origen_ciudad": "Buenos Aires",
      "destino": "USH",
      "destino_ciudad": "Ushuaia",
      "fecha_salida": "2026-04-17",
      "hora_salida": "15:00",
      "fecha_llegada": "2026-04-17",
      "hora_llegada": "18:40",
      "clase": "Economy",
      "confidence": "HIGH"
    }
  ]
}

REGLAS:
- Si no encontrás un dato, poné null (no inventar).
- Los códigos IATA de aerolínea son de 2 letras (AR, LA, AA, etc.).
- Los códigos IATA de aeropuerto son de 3 letras (EZE, AEP, MAD, MIA, etc.).
- La hora SIEMPRE en formato 24h.
- La fecha SIEMPRE en formato YYYY-MM-DD.
- Si el año no aparece, usá ${new Date().getFullYear()} o el siguiente si la fecha ya pasó.
- Si el texto está en otro idioma, traducí los campos al español.
- Extraé TODOS los vuelos que aparezcan en el itinerario.
- Si hay varios pasajeros, listalos en "pasajeros".
- NUNCA devuelvas texto fuera del JSON.`;
}

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
      system: GetSystemPrompt(),
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
      system: GetSystemPrompt(),
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
      system: GetSystemPrompt(),
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

    // Si viene en formato nuevo (con array de vuelos)
    if (parsed.vuelos && Array.isArray(parsed.vuelos)) {
      // Validar que al menos un vuelo tenga datos
      const vuelosValidos = parsed.vuelos.filter(v =>
        v.compania || v.flight_number || v.fecha_salida
      );

      if (vuelosValidos.length === 0) {
        throw new Error('No se encontraron vuelos válidos');
      }

      console.log(`[Analyzer] ✅ ${vuelosValidos.length} vuelo(s) extraído(s)`);
      vuelosValidos.forEach((v, i) => {
        console.log(`[Analyzer]    Vuelo ${i + 1}: ${v.flight_number} | ${v.origen} → ${v.destino} | ${v.fecha_salida} ${v.hora_salida}`);
      });

      return {
        multiple: parsed.multiple || vuelosValidos.length > 1,
        numero_reserva: parsed.numero_reserva || vuelosValidos[0].numero_reserva,
        pasajeros: parsed.pasajeros || (vuelosValidos[0].pasajero ? [vuelosValidos[0].pasajero] : []),
        vuelos: vuelosValidos
      };
    }

    // Si viene en formato viejo (un solo vuelo plano)
    if (!parsed.compania && !parsed.flight_number && !parsed.fecha_salida) {
      throw new Error('JSON sin datos útiles del vuelo');
    }

    console.log(`[Analyzer] ✅ 1 vuelo extraído: ${parsed.flight_number}`);

    return {
      multiple: false,
      numero_reserva: parsed.numero_reserva,
      pasajeros: parsed.pasajero ? [parsed.pasajero] : [],
      vuelos: [parsed]
    };

  } catch (err) {
    console.error('[Analyzer] ❌ Error parseando respuesta:', err.message);
    console.error('[Analyzer] Respuesta raw:', content.substring(0, 500));
    throw new Error('No pude interpretar los datos del voucher');
  }
}

module.exports = { processMessage };