import { useState } from 'react'
import { AuthProvider, useAuth } from '@/auth/AuthProvider'
import Login from '@/telas/Login'
import Execucao from '@/telas/Execucao'
import Programacao from '@/telas/Programacao'
import Lotes from '@/telas/Lotes'
import Ordens from '@/telas/Ordens'
import Qualidade from '@/telas/Qualidade'
import Indicadores from '@/telas/Indicadores'
import Cadastros from '@/telas/Cadastros'
import type { Perfil } from '@/dominio/tipos'

type TelaId =
  | 'ordens' | 'programacao' | 'lotes' | 'execucao'
  | 'qualidade' | 'indicadores' | 'cadastros'

const TELAS: { id: TelaId; nome: string }[] = [
  { id: 'ordens', nome: 'Ordens' },
  { id: 'programacao', nome: 'Programação' },
  { id: 'lotes', nome: 'Lotes a baixar' },
  { id: 'execucao', nome: 'Execução' },
  { id: 'qualidade', nome: 'Qualidade' },
  { id: 'indicadores', nome: 'Indicadores' },
  { id: 'cadastros', nome: 'Cadastros' },
]

/**
 * Telas visíveis por perfil — espelha a matriz da especificação. O RLS no
 * banco é a defesa real; isto aqui é só a navegação.
 */
const ACESSO: Record<Perfil, TelaId[]> = {
  PCP: ['ordens', 'programacao', 'lotes', 'execucao', 'qualidade', 'indicadores', 'cadastros'],
  Logistica: ['programacao', 'lotes', 'indicadores'],
  Producao: ['programacao', 'execucao', 'indicadores'],
  Qualidade: ['execucao', 'qualidade', 'indicadores'],
  Gestor: ['ordens', 'programacao', 'lotes', 'execucao', 'qualidade', 'indicadores', 'cadastros'],
}

function Shell() {
  const { session, usuario, carregando, semCadastro, sair } = useAuth()
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

  const permitidas = ACESSO[usuario.perfil] ?? []
  const atual = permitidas.includes(tela) ? tela : permitidas[0]

  return (
    <div className="min-h-svh bg-stone-50 text-stone-800 dark:bg-stone-950 dark:text-stone-200">
      <header className="border-b border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
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
        {atual === 'ordens' && <Ordens />}
        {atual === 'programacao' && <Programacao />}
        {atual === 'lotes' && <Lotes />}
        {atual === 'execucao' && <Execucao />}
        {atual === 'qualidade' && <Qualidade />}
        {atual === 'indicadores' && <Indicadores />}
        {atual === 'cadastros' && <Cadastros />}
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
