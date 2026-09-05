import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { AuthProvider, useAuth } from '@/auth/AuthProvider'
import { USUARIOS_SAP_TESTE } from '@/lib/sapTeste'
import * as g from '@/dados/api-gestao'
import { useRealtime } from '@/dados/useRealtime'
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
const Veiculos = lazy(() => import('@/telas/Veiculos'))
const Indicadores = lazy(() => import('@/telas/Indicadores'))
const Mrp = lazy(() => import('@/telas/Mrp'))
const Mapa = lazy(() => import('@/telas/Mapa'))
const Inventario = lazy(() => import('@/telas/Inventario'))
const Cadastros = lazy(() => import('@/telas/Cadastros'))
const Administracao = lazy(() => import('@/telas/Administracao'))
const Painel = lazy(() => import('@/telas/Painel'))
const PainelChamada = lazy(() => import('@/telas/PainelChamada'))
const SapTeste = lazy(() => import('@/telas/SapTeste'))

type TelaId =
  | 'ordens' | 'programacao' | 'lotes' | 'execucao' | 'qualidade'
  | 'agrotis' | 'etapas' | 'expedicao' | 'mapa' | 'inventario' | 'veiculos'
  | 'indicadores' | 'mrp' | 'cadastros' | 'administracao' | 'sap'

const TELAS: { id: TelaId; nome: string }[] = [
  { id: 'ordens', nome: 'Ordens' },
  { id: 'programacao', nome: 'Programação' },
  { id: 'lotes', nome: 'Logística' },
  { id: 'execucao', nome: 'Execução' },
  { id: 'qualidade', nome: 'Qualidade' },
  { id: 'agrotis', nome: 'AGROTIS' },
  { id: 'etapas', nome: 'Etapas' },
  { id: 'expedicao', nome: 'Expedição' },
  { id: 'mapa', nome: 'Mapa' },
  { id: 'inventario', nome: 'Inventário' },
  { id: 'veiculos', nome: 'Veículos' },
  { id: 'indicadores', nome: 'Indicadores' },
  { id: 'mrp', nome: 'MRP' },
  { id: 'cadastros', nome: 'Cadastros' },
  { id: 'administracao', nome: 'Administração' },
  { id: 'sap', nome: 'SAP (teste)' },
]

function Shell() {
  const { session, usuario, carregando, semCadastro, permitido, sair } = useAuth()
  const [tela, setTela] = useState<TelaId>('execucao')
  // modo TV: tela cheia, fora do shell. Quem enxerga Execução pode abrir.
  const [painel, setPainel] = useState(false)
  // idem, para o painel de chamada de motorista no pátio.
  const [painelChamada, setPainelChamada] = useState(false)
  // menu lateral em telas estreitas (tablet/celular) — a lateral fixa só
  // aparece em lg:, abaixo disso vira gaveta por cima do conteúdo
  const [navAberta, setNavAberta] = useState(false)
  // sem isto a aba ativa pode nascer fora da vista na gaveta rolável, sem
  // nenhuma pista de que dá pra rolar até ela
  const abaAtivaRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    abaAtivaRef.current?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [tela])

  // contador na lateral: quantas ordens esperam a Logística baixar o lote e
  // quantas ainda pedem atenção da Qualidade — sem entrar em nenhuma tela,
  // dá pra saber se tem algo pendente
  const [contadores, setContadores] = useState({ lotes: 0, qualidade: 0 })
  const recarregarContadores = useCallback(async () => {
    const [lotes, qualidade] = await Promise.all([
      permitido('lotes', 'ver') ? g.contarLogisticaPendente() : Promise.resolve(0),
      permitido('qualidade', 'ver') ? g.contarQualidadePendente() : Promise.resolve(0),
    ])
    setContadores({ lotes, qualidade })
  }, [permitido])
  useEffect(() => {
    if (session) void recarregarContadores()
  }, [session, recarregarContadores])
  useRealtime(['ordens'], recarregarContadores, { ativo: !!session })

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
  // gravada segue o padrão do perfil. Duas exceções hard-coded: Administração
  // é do Gestor (é a tela que conserta a matriz, não pode depender dela) e
  // "SAP (teste)" é POR USUÁRIO, não por perfil — laboratório de integração
  // restrito à mesma lista que a Edge Function sap-teste valida no servidor.
  const emailLogado = (session.user.email ?? '').toLowerCase()
  const permitidas = TELAS.filter((t) =>
    t.id === 'administracao'
      ? usuario.perfil === 'Gestor'
      : t.id === 'sap'
        ? USUARIOS_SAP_TESTE.includes(emailLogado)
        : permitido(t.id, 'ver'),
  ).map((t) => t.id)
  const atual = permitidas.includes(tela) ? tela : permitidas[0]
  const podePainel = permitido('execucao', 'ver')
  const podePainelChamada = permitido('veiculos', 'ver')

  // modo TV ocupa a tela inteira, sem o shell — quem vê Execução pode abrir
  if (painel && podePainel) {
    return (
      <Suspense fallback={<div className="fixed inset-0 bg-stone-950" />}>
        <Painel onSair={() => setPainel(false)} />
      </Suspense>
    )
  }

  if (painelChamada && podePainelChamada) {
    return (
      <Suspense fallback={<div className="fixed inset-0 bg-stone-950" />}>
        <PainelChamada onSair={() => setPainelChamada(false)} />
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

  const itensNav = TELAS.filter((t) => permitidas.includes(t.id))

  // conteúdo da navegação — o mesmo bloco entra na lateral fixa (lg:) e na
  // gaveta mobile; `fechar` só existe na gaveta, pra fechá-la ao escolher
  const conteudoNav = (fechar?: () => void) => (
    <>
      <div className="flex items-center gap-2.5 px-2 pb-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-green-900 text-sm font-bold tracking-tight text-lime-200 dark:bg-green-700">
          TSI
        </span>
        <div className="leading-tight">
          <p className="text-sm font-semibold">Sementes Veneza</p>
          <p className="text-xs text-stone-500 dark:text-stone-400">Tratamento Industrial</p>
        </div>
      </div>

      <ul className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-1">
        {itensNav.map((t) => (
          <li key={t.id}>
            <button
              ref={atual === t.id ? abaAtivaRef : undefined}
              onClick={() => {
                setTela(t.id)
                fechar?.()
              }}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left text-sm whitespace-nowrap transition-colors sm:py-2 ${
                atual === t.id
                  ? 'bg-green-50 font-semibold text-green-900 dark:bg-green-950/50 dark:text-green-300'
                  : 'text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800'
              }`}
            >
              <IconeTela id={t.id} />
              <span className="min-w-0 flex-1 truncate">{t.nome}</span>
              {t.id === 'lotes' && contadores.lotes > 0 && (
                <span
                  title="Ordens aguardando a Logística baixar o lote"
                  className="rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold text-white"
                >
                  {contadores.lotes}
                </span>
              )}
              {t.id === 'qualidade' && contadores.qualidade > 0 && (
                <span
                  title="Ordens que ainda pedem atenção da Qualidade"
                  className="rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold text-white"
                >
                  {contadores.qualidade}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>

      {(podePainel || podePainelChamada) && (
        <div className="mt-2 flex flex-col gap-0.5 border-t border-stone-200 px-1 pt-2 dark:border-stone-800">
          {podePainel && (
            <button
              onClick={() => {
                setPainel(true)
                fechar?.()
              }}
              title="Painel de produção em tela cheia, para a TV do chão de fábrica"
              className="rounded-lg px-2.5 py-2.5 text-left text-sm text-stone-600 transition-colors hover:bg-stone-100 sm:py-2 dark:text-stone-300 dark:hover:bg-stone-800"
            >
              Painel TV
            </button>
          )}
          {podePainelChamada && (
            <button
              onClick={() => {
                setPainelChamada(true)
                fechar?.()
              }}
              title="Painel de chamada de motorista em tela cheia, para a TV do pátio"
              className="rounded-lg px-2.5 py-2.5 text-left text-sm text-stone-600 transition-colors hover:bg-stone-100 sm:py-2 dark:text-stone-300 dark:hover:bg-stone-800"
            >
              Painel de Chamada
            </button>
          )}
        </div>
      )}

      <div className="mt-2 border-t border-stone-200 px-2.5 py-3 text-xs dark:border-stone-800">
        <p className="font-medium text-stone-700 dark:text-stone-200">{usuario.nome}</p>
        <p className="text-green-800 dark:text-green-400">{usuario.perfil}</p>
        <button
          onClick={sair}
          className="mt-2 text-stone-500 underline-offset-2 hover:text-stone-700 hover:underline dark:text-stone-400 dark:hover:text-stone-200"
        >
          Sair
        </button>
      </div>
    </>
  )

  const telaAtual = TELAS.find((t) => t.id === atual)

  return (
    <div className="min-h-svh bg-canvas text-stone-800 lg:flex dark:bg-stone-950 dark:text-stone-200">
      {/* lateral fixa: em telas grandes a navegação fica sempre à mão, sem
          disputar largura com as 13 abas que já não cabiam num topo só */}
      <aside className="hidden border-r border-stone-200 bg-white px-2 py-4 print:hidden lg:sticky lg:top-0 lg:flex lg:h-svh lg:w-56 lg:shrink-0 lg:flex-col dark:border-stone-800 dark:bg-stone-900">
        {conteudoNav()}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* topo compacto só em telas estreitas — tablet do chão de fábrica
            inclusive, então o alvo de toque do menu é generoso */}
        <header className="sticky top-0 z-40 flex items-center gap-3 border-b border-stone-200 bg-white/95 px-3 py-2.5 backdrop-blur print:hidden lg:hidden dark:border-stone-800 dark:bg-stone-900/95">
          <button
            onClick={() => setNavAberta(true)}
            aria-label="Abrir menu"
            className="rounded-lg border border-stone-300 p-2.5 text-stone-600 dark:border-stone-700 dark:text-stone-300"
          >
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7">
              <path d="M2 4h12M2 8h12M2 12h12" />
            </svg>
          </button>
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-green-900 text-xs font-bold text-lime-200 dark:bg-green-700">
            TSI
          </span>
          <span className="min-w-0 truncate text-sm font-semibold">{telaAtual?.nome}</span>
          <span className="ml-auto shrink-0 text-xs font-medium text-green-800 dark:text-green-400">
            {usuario.perfil}
          </span>
        </header>

        <main className="flex-1">
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
            {atual === 'mapa' && <Mapa />}
            {atual === 'inventario' && <Inventario />}
            {atual === 'veiculos' && <Veiculos />}
            {atual === 'indicadores' && <Indicadores />}
            {atual === 'mrp' && <Mrp />}
            {atual === 'cadastros' && <Cadastros />}
            {atual === 'administracao' && <Administracao />}
            {atual === 'sap' && <SapTeste />}
          </Suspense>
        </main>
      </div>

      {/* gaveta mobile — mesmo conteúdo da lateral, por cima do conteúdo */}
      {navAberta && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="fixed inset-0 bg-black/40" onClick={() => setNavAberta(false)} />
          <aside className="relative flex h-full w-72 max-w-[85svw] flex-col bg-white px-2 py-4 shadow-xl dark:bg-stone-900">
            {conteudoNav(() => setNavAberta(false))}
          </aside>
        </div>
      )}
    </div>
  )
}

/** Um ícone por tela — a mesma família de traço fino usada na marca. */
function IconeTela({ id }: { id: TelaId }) {
  const props = {
    width: 15,
    height: 15,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    className: 'shrink-0',
  } as const
  switch (id) {
    case 'ordens':
      return <svg {...props}><path d="M2 4h12M2 8h12M2 12h8" /></svg>
    case 'programacao':
      return (
        <svg {...props}>
          <rect x="2" y="3" width="12" height="11" rx="1.5" />
          <path d="M2 7h12M6 3v-1.5M10 3v-1.5" />
        </svg>
      )
    case 'lotes':
      return (
        <svg {...props}>
          <rect x="2" y="5" width="8" height="7" rx="1" />
          <path d="M10 8h3l1 2v2h-4z" />
        </svg>
      )
    case 'execucao':
      return <svg {...props}><path d="M4 3l9 5-9 5z" /></svg>
    case 'qualidade':
      return <svg {...props}><path d="M3 8.5l3.5 3.5L13 5" /></svg>
    case 'agrotis':
      return (
        <svg {...props}>
          <ellipse cx="8" cy="4" rx="5" ry="2" />
          <path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />
        </svg>
      )
    case 'etapas':
      return (
        <svg {...props}>
          <circle cx="8" cy="8" r="6" />
          <path d="M8 4.5V8l2.5 2" />
        </svg>
      )
    case 'expedicao':
      return (
        <svg {...props}>
          <rect x="2" y="6" width="12" height="8" rx="1" />
          <path d="M8 2v6M8 2l-2.5 2.5M8 2l2.5 2.5" />
        </svg>
      )
    case 'veiculos':
      return (
        <svg {...props}>
          <rect x="2" y="6" width="9" height="6" rx="1" />
          <path d="M11 8h2.5l.5 1.5V12h-3zM4 12.5a1 1 0 100 .01M12 12.5a1 1 0 100 .01" />
        </svg>
      )
    case 'mapa':
      return (
        <svg {...props}>
          <path d="M2 4l4-1.5 4 1.5 4-1.5v9.5l-4 1.5-4-1.5-4 1.5z" />
          <path d="M6 2.5v9.5M10 4v9.5" />
        </svg>
      )
    case 'inventario':
      return (
        <svg {...props}>
          <rect x="3" y="3" width="10" height="11.5" rx="1.5" />
          <path d="M6 3V1.5h4V3M5.5 8l1.7 1.7 3.3-3.4M5.5 11.5h5" />
        </svg>
      )
    case 'indicadores':
      return <svg {...props}><path d="M2 13V9M6.5 13V5M11 13V7M15 13V3" /></svg>
    case 'mrp':
      return (
        <svg {...props}>
          <path d="M8 2l5.2 3v6L8 14l-5.2-3V5z" />
          <path d="M2.8 5L8 8l5.2-3M8 8v6" />
        </svg>
      )
    case 'cadastros':
      return (
        <svg {...props}>
          <circle cx="8" cy="8" r="2.4" />
          <path d="M8 2v2M8 12v2M2 8h2M12 8h2M3.8 3.8l1.4 1.4M10.8 10.8l1.4 1.4M12.2 3.8l-1.4 1.4M5.2 10.8l-1.4 1.4" />
        </svg>
      )
    case 'administracao':
      return <svg {...props}><path d="M8 2l5 2v4c0 3.5-2.2 5.8-5 6.5C5.2 13.8 3 11.5 3 8V4z" /></svg>
    case 'sap':
      return (
        <svg {...props}>
          <path d="M6 2h4M6.5 2v3.5L3.5 12a1.5 1.5 0 001.3 2.2h6.4a1.5 1.5 0 001.3-2.2L9.5 5.5V2" />
        </svg>
      )
  }
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  )
}
