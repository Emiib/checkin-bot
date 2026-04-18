require('dotenv').config();
const express = require('express');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rutas
const webhookRouter = require('./src/routes/webhook');
const cronRouter = require('./src/cron/checkinCron');

app.use('/webhook', webhookRouter);
app.use('/cron', cronRouter);

// Health check
app.get('/', (req, res) => {
  res.json({
    status: '✅ CheckIn Bot activo',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()) + 's'
  });
});

// Iniciar cron interno
const { startInternalCron } = require('./src/services/cronService');
startInternalCron();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 CheckIn Bot v2.0 corriendo en puerto ${PORT}`);
  console.log(`📡 Webhook: /webhook`);
  console.log(`⏰ Cron: /cron/check-reminders`);
  console.log(`💚 Health: /\n`);
});