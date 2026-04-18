const express = require('express');
const router = express.Router();
const { processReminders } = require('../services/cronService');

/**
 * Endpoint para ejecutar el cron externamente
 * Útil para cron-job.org o Railway cron
 *
 * GET /cron/check-reminders?secret=tu_clave_secreta
 */
router.get('/check-reminders', async (req, res) => {
  // Verificar secreto (seguridad básica)
  const secret = req.query.secret || req.headers['x-cron-secret'];

  if (secret !== process.env.CRON_SECRET) {
    console.warn('[Cron] ❌ Intento no autorizado');
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    await processReminders();
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      message: 'Recordatorios procesados correctamente'
    });
  } catch (err) {
    console.error('[Cron] Error en endpoint:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Endpoint de status del cron
 * GET /cron/status
 */
router.get('/status', (req, res) => {
  res.json({
    status: 'activo',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()) + 's',
    message: 'Cron service corriendo correctamente'
  });
});

module.exports = router;