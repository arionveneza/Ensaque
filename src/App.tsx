import { Suspense, lazy, useState } from 'react'
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
const Indicadores = lazy(() => import('@/telas/Indicadores'))
const Cadastros = lazy(() => import('@/telas/Cadastros'))
const Administracao = lazy(() => import('@/telas/Administracao'))

type TelaId =
  | 'ordens' | 'programacao' | 'lotes' | 'execucao' | 'qualidade'
  | 'agrotis' | 'etapas' | 'indicadores' | 'cadastros' | 'administracao'

const TELAS: { id: TelaId; nome: string }[] = [
  { id: 'ordens', nome: 'Ordens' },
  { id: 'programacao', nome: 'Programação' },
  { id: 'lotes', nome: 'Lotes a baixar' },
  { id: 'execucao', nome: 'Execução' },
  { id: 'qualidade', nome: 'Qualidade' },
  { id: 'agrotis', nome: 'AGROTIS' },
  { id: 'etapas', nome: 'Etapas' },
  { id: 'indicadores', nome: 'Indicadores' },
  { id: 'cadastros', nome: 'Cadastros' },
  { id: 'administracao', nome: 'Administração' },
]

function Shell() {
  const { session, usuario, carregando, semCadastro, permitido, sair } = useAuth()
  const [tela, setTela] = useState<TelaId>('execucao')

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
          <button onClick={sair} className="mt-4 text-sm underline">Sair</button>
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

  if (permitidas.length === 0) {
    return (
      <div className="flex min-h-svh items-center justify-center p-6">
        <div className="max-w-md rounded-lg border border-amber-300 bg-amber-50 p-6 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <p className="font-semibold">Nenhuma tela liberada para o seu perfil</p>
          <p className="mt-2">
            O gestor desmarcou todas as telas do perfil <b>{usuario.perfil}</b> na matriz de
            permissões. Peça a ele para revisar em Administração.
          </p>
          <button onClick={sair} className="mt-4 text-sm underline">Sair</button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-svh bg-stone-50 text-stone-800 dark:bg-stone-950 dark:text-stone-200">
      <header className="border-b border-stone-200 bg-white print:hidden dark:border-stone-800 dark:bg-stone-900">
        <div className="mx-auto flex max-w-6xl flex-wrap items-baseline gap-3 px-6 py-4">
          <h1 className="text-xl font-semibold tracking-tight">TSI</h1>
          <p className="text-sm text-stone-500 dark:text-stone-400">Sementes Veneza</p>
          <div className="ml-auto flex items-baseline gap-3 text-sm">
            <span className="text-stone-600 dark:text-stone-300">
              {usuario.nome} · <span className="text-stone-400">{usuario.perfil}</span>
            </span>
            <button onClick={sair} className="text-stone-500 underline underline-offset-2">
              Sair
            </button>
          </div>
        </div>
        <nav className="mx-auto max-w-6xl px-6 pb-3">
          <ul className="flex flex-wrap gap-2">
            {TELAS.filter((t) => permitidas.includes(t.id)).map((t) => (
              <li key={t.id}>
                <button
                  onClick={() => setTela(t.id)}
                  className={`rounded-md border px-3 py-1.5 text-sm ${
                    atual === t.id
                      ? 'border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900'
                      : 'border-stone-200 hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800'
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
