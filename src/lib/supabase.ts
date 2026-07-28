import { createClient } from '@supabase/supabase-js'

/**
 * Cliente do Supabase.
 *
 * A chave anônima vai no bundle do front-end — é pública por natureza. O que
 * protege os dados é o RLS no banco (supabase/schema.sql, seções 8 e 8b),
 * não o segredo da chave. Nunca use aqui a service_role key.
 */
const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  throw new Error(
    'VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY são obrigatórias. ' +
      'Copie .env.example para .env.local e preencha com os dados do projeto.',
  )
}

export const supabase = createClient(url, anonKey)
