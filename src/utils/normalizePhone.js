/**
 * Normaliza números de teléfono argentinos
 * WhatsApp a veces manda con 9 extra: 5493512395563 → 543512395563
 * También normaliza otros formatos comunes
 */
function normalizePhone(phone) {
  let normalized = phone.replace(/[^0-9]/g, '');

  // Argentina: quitar el 9 entre el 54 y el código de área
  if (normalized.startsWith('549') && normalized.length === 13) {
    normalized = '54' + normalized.slice(3);
  }

  return normalized;
}

/**
 * Formatea número para mostrar bonito
 * 543512395563 → +54 351 239-5563
 */
function formatPhoneDisplay(phone) {
  if (phone.startsWith('54') && phone.length === 12) {
    return `+${phone.slice(0, 2)} ${phone.slice(2, 5)} ${phone.slice(5, 8)}-${phone.slice(8)}`;
  }
  return `+${phone}`;
}

module.exports = { normalizePhone, formatPhoneDisplay };