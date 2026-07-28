import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import type { Perfil } from '@/dominio/tipos'

export interface UsuarioTsi {
  id: string
  nome: string
  perfil: Perfil
}

interface Ctx {
  session: Session | null
  usuario: UsuarioTsi | null
  carregando: boolean
  /** Autenticado no Supabase mas sem linha em tsi.usuarios: o RLS bloqueia tudo. */
  semCadastro: boolean
  sair: () => Promise<void>
}

const AuthCtx = createContext<Ctx | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [usuario, setUsuario] = useState<UsuarioTsi | null>(null)
  const [carregando, setCarregando] = useState(true)
  const [semCadastro, setSemCadastro] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      if (!data.session) setCarregando(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_evento, s) => {
      setSession(s)
      if (!s) {
        setUsuario(null)
        setSemCadastro(false)
        setCarregando(false)
      }
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session) return
    let cancelado = false
    setCarregando(true)
    supabase
      .from('usuarios')
      .select('id, nome, perfil')
      .eq('id', session.user.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelado) return
        if (error) console.error('perfil do usuário:', error.message)
        setUsuario((data as UsuarioTsi) ?? null)
        setSemCadastro(!data)
        setCarregando(false)
      })
    return () => {
      cancelado = true
    }
  }, [session])

  const sair = async () => {
    await supabase.auth.signOut()
  }

  return (
    <AuthCtx.Provider value={{ session, usuario, carregando, semCadastro, sair }}>
      {children}
    </AuthCtx.Provider>
  )
}

export function useAuth(): Ctx {
  const ctx = useContext(AuthCtx)
  if (!ctx) throw new Error('useAuth precisa estar dentro de <AuthProvider>.')
  return ctx
}
