const { supabase } = require('../db/supabase');

/**
 * Guarda una confirmación pendiente en Supabase
 * Reemplaza el Map en memoria
 */
async function savePendingConfirmation(phoneNumber, flightId, payload) {
  // Borrar pendientes anteriores de este usuario (solo 1 activo a la vez)
  await supabase
    .from('pending_confirmations')
    .delete()
    .eq('phone_number', phoneNumber);

  const { data, error } = await supabase
    .from('pending_confirmations')
    .insert({
      phone_number: phoneNumber,
      flight_id: flightId,
      payload
    })
    .select()
    .single();

  if (error) {
    console.error('[DB] Error guardando pending confirmation:', error.message);
    throw error;
  }
  console.log(`[DB] ✅ Confirmación pendiente guardada para ${phoneNumber}`);
  return data;
}

/**
 * Busca si hay una confirmación pendiente para un número
 */
async function getPendingConfirmation(phoneNumber) {
  const { data } = await supabase
    .from('pending_confirmations')
    .select('*')
    .eq('phone_number', phoneNumber)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  return data || null;
}

/**
 * Elimina la confirmación pendiente después de que el usuario respondió
 */
async function deletePendingConfirmation(phoneNumber) {
  await supabase
    .from('pending_confirmations')
    .delete()
    .eq('phone_number', phoneNumber);

  console.log(`[DB] ✅ Confirmación pendiente eliminada para ${phoneNumber}`);
}

module.exports = {
  savePendingConfirmation,
  getPendingConfirmation,
  deletePendingConfirmation
};