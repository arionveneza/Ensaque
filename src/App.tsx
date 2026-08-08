import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { AuthProvider, useAuth } from '@/auth/AuthProvider'
import Login from '@/telas/Login'
import Execucao from '@/telas/Execucao'

/**
 * A Execução entra no bundle principal por ser a tela que abre no chão de
 * fábrica. As demais carregam sob demanda — Indicadores puxa o Recharts, que
 * sozinho dobrava o tamanho do pacote inicial.
 */
const Programacao = lazy(() => import('@/telas/Programacao'))
const Lotes = lazy(() => import('@/telas/Lotes'))
const Ordens = lazy(() => import('@/telas/Ordens'))
const Qualidade = lazy(() => import('@/telas/Qualidade'))
const Agrotis = lazy(() => import('@/telas/Agrotis'))
const Etapas = lazy(() => import('@/telas/Etapas'))
const Expedicao = lazy(() => import('@/telas/Expedicao'))
const Indicadores = lazy(() => import('@/telas/Indicadores'))
const Cadastros = lazy(() => import('@/telas/Cadastros'))
const Administracao = lazy(() => import('@/telas/Administracao'))
const Painel = lazy(() => import('@/telas/Painel'))

type TelaId =
  | 'ordens' | 'programacao' | 'lotes' | 'execucao' | 'qualidade'
  | 'agrotis' | 'etapas' | 'expedicao' | 'indicadores' | 'cadastros' | 'administracao'

const TELAS: { id: TelaId; nome: string }[] = [
  { id: 'ordens', nome: 'Ordens' },
  { id: 'programacao', nome: 'Programação' },
  { id: 'lotes', nome: 'Logística' },
  { id: 'execucao', nome: 'Execução' },
  { id: 'qualidade', nome: 'Qualidade' },
  { id: 'agrotis', nome: 'AGROTIS' },
  { id: 'etapas', nome: 'Etapas' },
  { id: 'expedicao', nome: 'Expedição' },
  { id: 'indicadores', nome: 'Indicadores' },
  { id: 'cadastros', nome: 'Cadastros' },
  { id: 'administracao', nome: 'Administração' },
]

function Shell() {
  const { session, usuario, carregando, semCadastro, permitido, sair } = useAuth()
  const [tela, setTela] = useState<TelaId>('execucao')
  // modo TV: tela cheia, fora do shell. Quem enxerga Execução pode abrir.
  const [painel, setPainel] = useState(false)
  // no celular a nav rola; sem isto a aba ativa pode nascer fora da vista,
  // sem nenhuma pista de que dá pra rolar até ela
  const navRef = useRef<HTMLElement>(null)
  const abaAtivaRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    abaAtivaRef.current?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [tela])

  if (carregando) {
    return (
      <div className="flex min-h-svh items-center justify-center text-sm text-stone-500">
        Carregando…
      </div>
    )
  }

  if (!session) return <Login />

  if (semCadastro || !usuario) {
    return (
      <div className="flex min-h-svh items-center justify-center p-6">
        <div className="max-w-md rounded-lg border border-amber-300 bg-amber-50 p-6 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <p className="font-semibold">Usuário sem perfil cadastrado</p>
          <p className="mt-2">
            Você autenticou, mas não existe registro em <code>tsi.usuarios</code> para este
            login. O RLS bloqueia todo o acesso enquanto o perfil não for criado — peça ao
            gestor para cadastrá-lo.
          </p>
          <button onClick={sair} className="-mx-3 mt-4 rounded px-3 py-2.5 text-sm underline">
            Sair
          </button>
        </div>
      </div>
    )
  }

  // A navegação obedece à matriz de permissões (Administração). Célula nunca
  // gravada segue o padrão do perfil. Administração é hard-coded do Gestor:
  // é a tela que conserta a matriz, não pode depender dela.
  const permitidas = TELAS.filter((t) =>
    t.id === 'administracao' ? usuario.perfil === 'Gestor' : permitido(t.id, 'ver'),
  ).map((t) => t.id)
  const atual = permitidas.includes(tela) ? tela : permitidas[0]
  const podePainel = permitido('execucao', 'ver')

  // modo TV ocupa a tela inteira, sem o shell — quem vê Execução pode abrir
  if (painel && podePainel) {
    return (
      <Suspense fallback={<div className="fixed inset-0 bg-stone-950" />}>
        <Painel onSair={() => setPainel(false)} />
      </Suspense>
    )
  }

  if (permitidas.length === 0) {
    return (
      <div className="flex min-h-svh items-center justify-center p-6">
        <div className="max-w-md rounded-lg border border-amber-300 bg-amber-50 p-6 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <p className="font-semibold">Nenhuma tela liberada para o seu perfil</p>
          <p className="mt-2">
            O gestor desmarcou todas as telas do perfil <b>{usuario.perfil}</b> na matriz de
            permissões. Peça a ele para revisar em Administração.
          </p>
          <button onClick={sair} className="-mx-3 mt-4 rounded px-3 py-2.5 text-sm underline">
            Sair
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-svh bg-stone-50 text-stone-800 dark:bg-stone-950 dark:text-stone-200">
      {/* fixo no topo: no tablet do chão de fábrica a navegação fica sempre à mão */}
      <header className="sticky top-0 z-40 border-b border-stone-200 bg-white/95 backdrop-blur print:hidden dark:border-stone-800 dark:bg-stone-900/95">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 pt-3 sm:px-6">
          {/* marca: bloco esmeralda no lugar de logo — trocar quando houver arte */}
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-700 text-sm font-bold tracking-tight text-white dark:bg-emerald-600">
              TSI
            </span>
            <div className="leading-tight">
              <h1 className="text-sm font-semibold">Tratamento Industrial de Sementes</h1>
              <p className="text-xs text-stone-500 dark:text-stone-400">Sementes Veneza</p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-3 text-sm">
            {/* no celular some o nome, mas o perfil logado tem que continuar
                visível — sem ele não dá pra saber quem/o que está entrando */}
            <span className="text-xs font-medium text-emerald-700 sm:hidden dark:text-emerald-400">
              {usuario.perfil}
            </span>
            <span className="hidden text-stone-600 sm:inline dark:text-stone-300">
              {usuario.nome} ·{' '}
              <span className="text-emerald-700 dark:text-emerald-400">{usuario.perfil}</span>
            </span>
            {podePainel && (
              <button
                onClick={() => setPainel(true)}
                title="Painel de produção em tela cheia, para a TV do chão de fábrica"
                className="rounded-md border border-stone-300 px-3 py-2.5 text-stone-600 transition-colors hover:bg-stone-100 sm:py-1.5 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800"
              >
                Painel TV
              </button>
            )}
            <button
              onClick={sair}
              className="rounded-md border border-stone-300 px-3 py-2.5 text-stone-600 transition-colors hover:bg-stone-100 sm:py-1.5 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800"
            >
              Sair
            </button>
          </div>
        </div>
        <nav className="scroll-oculto mx-auto max-w-6xl overflow-x-auto px-4 sm:px-6" ref={navRef}>
          <ul className="flex gap-1 py-2">
            {TELAS.filter((t) => permitidas.includes(t.id)).map((t) => (
              <li key={t.id}>
                <button
                  ref={atual === t.id ? abaAtivaRef : undefined}
                  onClick={() => setTela(t.id)}
                  className={`rounded-md px-3 py-2.5 text-sm whitespace-nowrap transition-colors sm:py-2 ${
                    atual === t.id
                      ? 'bg-emerald-700 font-semibold text-white dark:bg-emerald-600'
                      : 'text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800'
                  }`}
                >
                  {t.nome}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      <main>
        <Suspense
          fallback={<p className="p-8 text-sm text-stone-500">Carregando tela…</p>}
        >
          {atual === 'ordens' && <Ordens />}
          {atual === 'programacao' && <Programacao />}
          {atual === 'lotes' && <Lotes />}
          {atual === 'execucao' && <Execucao />}
          {atual === 'qualidade' && <Qualidade />}
          {atual === 'agrotis' && <Agrotis />}
          {atual === 'etapas' && <Etapas />}
          {atual === 'expedicao' && <Expedicao />}
          {atual === 'indicadores' && <Indicadores />}
          {atual === 'cadastros' && <Cadastros />}
          {atual === 'administracao' && <Administracao />}
        </Suspense>
      </main>
    </div>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  )
}
