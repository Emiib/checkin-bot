# 🚀 Guía de Instalación — CheckIn Bot

## Requisitos previos
- Node.js 18 o superior
- Cuenta en OpenAI (para GPT-4o)
- Cuenta en Meta for Developers (gratuita)
- Una cuenta de WhatsApp Business

---

## PASO 1 — Instalar dependencias

```bash
git clone <tu-repo>
cd checkin-bot
npm install
```

---

## PASO 2 — Configurar variables de entorno

```bash
cp .env.example .env
```

Edita el archivo `.env` con tus claves:

### 🔑 OpenAI API Key
1. Ve a https://platform.openai.com/api-keys
2. Crea una nueva API key
3. Pégala en `OPENAI_API_KEY`

### 📱 Meta WhatsApp Business API (gratuita)
1. Ve a https://developers.facebook.com
2. Crea una nueva App → tipo "Business"
3. Añade el producto "WhatsApp"
4. Ve a "WhatsApp > Configuración de la API"
5. Copia el **Token de acceso temporal** → `WHATSAPP_TOKEN`
6. Copia el **Phone Number ID** → `WHATSAPP_PHONE_ID`
7. Inventa un texto secreto para `WHATSAPP_VERIFY_TOKEN` (ej: "mi_bot_secreto_2024")

---

## PASO 3 — Exponer el servidor a Internet

WhatsApp necesita una URL pública. Para pruebas usa **ngrok** (gratuito):

```bash
# Instalar ngrok
npm install -g ngrok

# En una terminal, arranca el bot
npm start

# En otra terminal, expón el puerto
ngrok http 3000
```

Ngrok te dará una URL como: `https://abc123.ngrok.io`

---

## PASO 4 — Configurar el Webhook en Meta

1. Ve a tu app en developers.facebook.com
2. WhatsApp → Configuración → Webhooks
3. En **URL de callback** pon: `https://abc123.ngrok.io/webhook`
4. En **Token de verificación** pon el mismo texto que pusiste en `WHATSAPP_VERIFY_TOKEN`
5. Haz clic en **Verificar y guardar**
6. Suscríbete al evento: `messages`

---

## PASO 5 — Probar el bot

1. Desde el panel de Meta, añade tu número personal como número de prueba
2. Envía "Hola" por WhatsApp al número de prueba
3. Luego envía una foto de un boarding pass o escribe los datos de un vuelo
4. ¡El bot debería responder con la info del check-in!

---

## PASO 6 — Deploy a producción (Railway)

1. Crea cuenta en https://railway.app
2. Conecta tu repositorio de GitHub
3. Añade las variables de entorno en el panel de Railway
4. Railway asignará una URL pública automáticamente
5. Actualiza la URL del webhook en Meta con la URL de Railway

---

## 📋 Comandos del bot

| Mensaje | Respuesta |
|---------|-----------|
| `Hola` / `Ayuda` | Instrucciones de uso |
| Imagen / PDF de ticket | Análisis completo del vuelo |
| Texto del voucher | Análisis completo del vuelo |
| `SÍ` | Confirma el recordatorio |
| `NO` | Cancela el recordatorio |
| `Recordatorios` | Lista de recordatorios activos |

---

## ➕ Añadir nuevas aerolíneas

Edita el archivo `src/data/airlines.json` y añade una nueva entrada:

```json
{
  "id": "nueva_aerolinea",
  "names": ["Nombre", "Código IATA"],
  "tipo": "aereo",
  "horas_antes_checkin": 48,
  "horas_cierre_checkin": 2,
  "url_checkin": "https://...",
  "notas": "Descripción"
}
```

---

## 💰 Costes estimados

| Servicio | Coste |
|----------|-------|
| Meta WhatsApp API | Gratis (primeras 1000 conversaciones/mes) |
| OpenAI GPT-4o | ~$0.01–0.03 por ticket analizado |
| Railway hosting | Gratis (plan Starter) |
| **Total para empezar** | **~$0–5/mes** |
