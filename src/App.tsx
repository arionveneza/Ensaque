import { AuthProvider, useAuth } from '@/auth/AuthProvider'
import Login from '@/telas/Login'
import Execucao from '@/telas/Execucao'

const TELAS = [
  { id: 'ordens', nome: 'Ordens', pronta: false },
  { id: 'programacao', nome: 'Programação & Ocupação', pronta: false },
  { id: 'lotes', nome: 'Lotes a baixar', pronta: false },
  { id: 'execucao', nome: 'Execução', pronta: true },
  { id: 'qualidade', nome: 'Qualidade', pronta: false },
  { id: 'indicadores', nome: 'Indicadores', pronta: false },
  { id: 'cadastros', nome: 'Cadastros', pronta: false },
]

function Shell() {
  const { session, usuario, carregando, semCadastro, sair } = useAuth()

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
          <button onClick={sair} className="mt-4 text-sm underline">
            Sair
          </button>
        </div>
      </div>
    )
  }

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
            {TELAS.map((t) => (
              <li key={t.id}>
                <span
                  className={`inline-block rounded-md border px-3 py-1.5 text-sm ${
                    t.pronta
                      ? 'border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900'
                      : 'cursor-not-allowed border-stone-200 text-stone-400 dark:border-stone-700 dark:text-stone-500'
                  }`}
                  title={t.pronta ? undefined : 'ainda não implementada'}
                >
                  {t.nome}
                </span>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      <main>
        <Execucao />
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
