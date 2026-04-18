const Groq = require('groq-sdk');
const { downloadMedia } = require('./whatsapp');
const fs = require('fs');
const path = require('path');
const os = require('os');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/**
 * Descarga un audio de WhatsApp y lo transcribe con Groq Whisper
 * @param {string} mediaId - ID del media de WhatsApp
 * @returns {string} - Texto transcrito
 */
async function transcribeAudio(mediaId) {
  const tempPath = path.join(os.tmpdir(), `audio_${Date.now()}.ogg`);

  try {
    // 1) Descargar el audio
    const audioBuffer = await downloadMedia(mediaId);

    // 2) Guardar temporalmente (Whisper necesita archivo físico)
    fs.writeFileSync(tempPath, audioBuffer);

    // 3) Transcribir con Groq Whisper (modelo: whisper-large-v3)
    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model: 'whisper-large-v3',
      language: 'es',
      response_format: 'text'
    });

    const text = typeof transcription === 'string' ? transcription : transcription.text;
    console.log(`[Audio] ✅ Transcripción Groq: "${text.substring(0, 100)}..."`);
    return text;

  } catch (err) {
    console.error('[Audio] ❌ Error transcribiendo con Groq:', err.message);
    throw new Error('No pude transcribir el audio');
  } finally {
    try { fs.unlinkSync(tempPath); } catch (e) { /* ignorar */ }
  }
}

module.exports = { transcribeAudio };