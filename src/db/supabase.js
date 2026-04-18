require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ SUPABASE_URL y SUPABASE_ANON_KEY son requeridos en .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Test de conexión al iniciar
async function testConnection() {
  try {
    const { data, error } = await supabase.from('airlines').select('code').limit(1);
    if (error) throw error;
    console.log('✅ Supabase conectado correctamente');
    return true;
  } catch (err) {
    console.error('❌ Error conectando a Supabase:', err.message);
    return false;
  }
}

testConnection();

module.exports = { supabase };