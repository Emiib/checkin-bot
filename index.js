// index.js
// Punto de entrada principal del servidor

require('dotenv').config();
const express = require('express');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Ruta principal del webhook de WhatsApp
const webhookRouter = require('./src/routes/webhook');
app.use('/webhook', webhookRouter);

// Ruta de health check (para saber si el servidor está vivo)
app.get('/', (req, res) => {
  res.json({
    status: '✅ CheckIn Bot activo',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 CheckIn Bot corriendo en puerto ${PORT}`);
  console.log(`📡 Webhook URL: http://localhost:${PORT}/webhook`);
  console.log(`\n⚙️  Recuerda configurar tu .env con:`);
  console.log(`   OPENAI_API_KEY`);
  console.log(`   WHATSAPP_TOKEN`);
  console.log(`   WHATSAPP_PHONE_ID`);
  console.log(`   WHATSAPP_VERIFY_TOKEN\n`);
});
