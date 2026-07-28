import { capacidadeDiaT, pesoBagKg } from '@/dominio/calculos'

/**
 * Esqueleto do app. As telas entram na ordem sugerida no README:
 * Execução primeiro, porque é o que roda no chão de fábrica.
 *
 * Nada aqui importa o cliente do Supabase ainda: assim `npm run dev` funciona
 * antes de o .env.local existir.
 */

const TELAS = [
  { id: 'ordens', nome: 'Ordens' },
  { id: 'programacao', nome: 'Programação & Ocupação' },
  { id: 'lotes', nome: 'Lotes a baixar' },
  { id: 'execucao', nome: 'Execução' },
  { id: 'qualidade', nome: 'Qualidade' },
  { id: 'indicadores', nome: 'Indicadores' },
  { id: 'cadastros', nome: 'Cadastros' },
]

const BG5M = {
  codigo: 'BG5M', codigoExt: 'BB5M', descricao: 'Bag 5 milhões de sementes',
  sementes: 5_000_000, fatorPeso: 5,
}

export default function App() {
  const capacidadeDia = capacidadeDiaT(12, [10, 9.5])
  const exemploBag = pesoBagKg(171, BG5M)

  return (
    <div className="min-h-svh bg-stone-50 text-stone-800 dark:bg-stone-950 dark:text-stone-200">
      <header className="border-b border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
        <div className="mx-auto flex max-w-6xl items-baseline gap-3 px-6 py-4">
          <h1 className="text-xl font-semibold tracking-tight">TSI</h1>
          <p className="text-sm text-stone-500 dark:text-stone-400">
            Tratamento Industrial de Sementes · Sementes Veneza
          </p>
        </div>
        <nav className="mx-auto max-w-6xl px-6 pb-3">
          <ul className="flex flex-wrap gap-2">
            {TELAS.map((t) => (
              <li key={t.id}>
                <span className="inline-block cursor-not-allowed rounded-md border border-stone-200 px-3 py-1.5 text-sm text-stone-400 dark:border-stone-700 dark:text-stone-500">
                  {t.nome}
                </span>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        <section className="rounded-lg border border-stone-200 bg-white p-6 dark:border-stone-800 dark:bg-stone-900">
          <h2 className="text-base font-semibold">Projeto configurado</h2>
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
            React, TypeScript, Vite, Tailwind e Vitest prontos. A camada de domínio já
            está implementada e coberta por testes; as telas entram a seguir, começando
            pela Execução.
          </p>

          <dl className="mt-5 grid gap-4 sm:grid-cols-2">
            <div className="rounded-md bg-stone-50 p-4 dark:bg-stone-800/50">
              <dt className="text-xs uppercase tracking-wide text-stone-500 dark:text-stone-400">
                Capacidade por máquina/dia
              </dt>
              <dd className="num-tabular mt-1 text-2xl font-semibold">
                {capacidadeDia.toLocaleString('pt-BR')} t
              </dd>
              <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                12 t/h × 19,5 h (07:30 às 03:00)
              </p>
            </div>
            <div className="rounded-md bg-stone-50 p-4 dark:bg-stone-800/50">
              <dt className="text-xs uppercase tracking-wide text-stone-500 dark:text-stone-400">
                Peso do bag · PMS 171 em BG5M
              </dt>
              <dd className="num-tabular mt-1 text-2xl font-semibold">
                {exemploBag.toLocaleString('pt-BR')} kg
              </dd>
              <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                PMS × fator 5 da embalagem
              </p>
            </div>
          </dl>
        </section>
      </main>
    </div>
  )
}
