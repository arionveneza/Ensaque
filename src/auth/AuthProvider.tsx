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
import { permissaoEfetiva, type PermissaoExplicita } from '@/dominio/permissoes'

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
  /**
   * Permissão efetiva do usuário logado: o que o gestor gravou na matriz
   * manda; célula nunca gravada segue o padrão do perfil. Controla a
   * interface — a proteção real é o RLS.
   */
  permitido: (recurso: string, acao: string) => boolean
  sair: () => Promise<void>
}

const AuthCtx = createContext<Ctx | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [usuario, setUsuario] = useState<UsuarioTsi | null>(null)
  const [explicitas, setExplicitas] = useState<PermissaoExplicita[]>([])
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
      .then(async ({ data, error }) => {
        if (cancelado) return
        if (error) console.error('perfil do usuário:', error.message)
        const u = (data as UsuarioTsi) ?? null

        // só o que o gestor MEXEU na matriz; o resto cai no padrão do perfil.
        // Erro aqui não derruba o login: fica só o padrão.
        let exp: PermissaoExplicita[] = []
        if (u) {
          const p = await supabase
            .from('perfil_permissoes')
            .select('recurso, acao, permitido')
            .eq('perfil', u.perfil)
          if (p.error) console.error('matriz de permissões:', p.error.message)
          exp = (p.data ?? []) as PermissaoExplicita[]
        }
        if (cancelado) return

        setUsuario(u)
        setExplicitas(exp)
        setSemCadastro(!u)
        setCarregando(false)
      })
    return () => {
      cancelado = true
    }
  }, [session])

  const permitido = (recurso: string, acao: string): boolean =>
    usuario ? permissaoEfetiva(usuario.perfil, recurso, acao, explicitas) : false

  const sair = async () => {
    await supabase.auth.signOut()
  }

  return (
    <AuthCtx.Provider
      value={{ session, usuario, carregando, semCadastro, permitido, sair }}
    >
      {children}
    </AuthCtx.Provider>
  )
}

export function useAuth(): Ctx {
  const ctx = useContext(AuthCtx)
  if (!ctx) throw new Error('useAuth precisa estar dentro de <AuthProvider>.')
  return ctx
}
