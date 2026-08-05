import type { ReactNode } from 'react'

/** Peças visuais compartilhadas pelas telas. Nada de regra de negócio aqui. */

export const n = (v: number | null | undefined, casas = 1): string =>
  v == null || Number.isNaN(v)
    ? '—'
    : v.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas })

export const inteiro = (v: number | null | undefined): string =>
  v == null || Number.isNaN(v) ? '—' : v.toLocaleString('pt-BR')

export const diaCurto = (iso: string | null): string =>
  !iso ? '—' : `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

/**
 * Endereço do lote em uma linha: "ARMAZEM C · BL01 · QD04".
 * Aceita endereço parcial — a logística às vezes só sabe o armazém.
 */
export const enderecoLote = (
  o: { armazem?: string | null; bloco?: string | null; quadra?: string | null },
  vazio = '—',
): string => [o.armazem, o.bloco, o.quadra].filter(Boolean).join(' · ') || vazio

const DOW = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']
export const diaSemana = (iso: string): string =>
  DOW[new Date(`${iso}T12:00:00`).getDay()]

export const somaDias = (iso: string, k: number): string => {
  const d = new Date(`${iso}T12:00:00`)
  d.setDate(d.getDate() + k)
  return d.toISOString().slice(0, 10)
}

export function Pagina({
  titulo,
  descricao,
  acoes,
  children,
}: {
  titulo: string
  descricao?: string
  acoes?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">{titulo}</h2>
          {descricao && (
            <p className="text-sm text-stone-500 dark:text-stone-400">{descricao}</p>
          )}
        </div>
        {acoes && <div className="flex flex-wrap gap-2">{acoes}</div>}
      </div>
      {children}
    </div>
  )
}

export function Cartao({
  titulo,
  acoes,
  children,
  className = '',
}: {
  titulo?: string
  acoes?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section
      className={`rounded-lg border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900 ${className}`}
    >
      {(titulo || acoes) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 px-4 py-3 dark:border-stone-800">
          {titulo && <h3 className="text-sm font-semibold">{titulo}</h3>}
          {acoes && <div className="flex flex-wrap gap-2">{acoes}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  )
}

export function Botao({
  children,
  onClick,
  variante = 'normal',
  disabled,
  titulo,
  tipo = 'button',
}: {
  children: ReactNode
  onClick?: () => void
  variante?: 'normal' | 'primario' | 'perigo'
  disabled?: boolean
  titulo?: string
  tipo?: 'button' | 'submit'
}) {
  const estilo =
    variante === 'primario'
      ? 'bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900'
      : variante === 'perigo'
        ? 'border border-red-300 text-red-700 dark:border-red-800 dark:text-red-400'
        : 'border border-stone-300 dark:border-stone-700'
  return (
    <button
      type={tipo}
      title={titulo}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-40 ${estilo}`}
    >
      {children}
    </button>
  )
}

export function Tag({
  children,
  cor = 'neutro',
}: {
  children: ReactNode
  cor?: 'neutro' | 'ok' | 'alerta' | 'perigo' | 'info' | 'roxo'
}) {
  const cores = {
    neutro: 'bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300',
    ok: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
    alerta: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
    perigo: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
    info: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
    roxo: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300',
  }
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${cores[cor]}`}>
      {children}
    </span>
  )
}

export const corDoStatus = (
  status: string,
): 'neutro' | 'ok' | 'alerta' | 'perigo' | 'info' | 'roxo' =>
  status === 'Em producao'
    ? 'ok'
    : status === 'Parada'
      ? 'perigo'
      : status === 'Aguardando lote'
        ? 'alerta'
        : status === 'Pronto para produzir'
          ? 'info'
          : status === 'Finalizada' || status === 'Qualidade apontada'
            ? 'roxo'
            : 'neutro'

export function Vazio({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md bg-stone-50 px-4 py-8 text-center text-sm text-stone-500 dark:bg-stone-800/50 dark:text-stone-400">
      {children}
    </p>
  )
}

export function Erro({ children }: { children: ReactNode }) {
  return (
    <div className="mb-4 rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
      {children}
    </div>
  )
}

export function Aviso({
  children,
  gravidade = 'alerta',
}: {
  children: ReactNode
  gravidade?: 'alerta' | 'bloqueio' | 'ok'
}) {
  const cores = {
    alerta:
      'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
    bloqueio:
      'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300',
    ok: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
  }
  return (
    <div className={`rounded-md border px-4 py-2.5 text-sm ${cores[gravidade]}`}>{children}</div>
  )
}

export function Tabela({ cabecalho, children }: { cabecalho: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-stone-200 text-left text-xs uppercase tracking-wide text-stone-500 dark:border-stone-800 dark:text-stone-400">
            {cabecalho.map((c, i) => (
              <th
                key={c + i}
                className={`px-2 py-2 ${c.startsWith('#') ? 'text-right' : ''}`}
              >
                {c.replace(/^#/, '')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

/** Exporta uma matriz para .csv separado por ponto e vírgula, que o Excel pt-BR abre direto. */
export function exportarCsv(nome: string, linhas: (string | number)[][]): void {
  const conteudo = linhas
    .map((l) =>
      l
        .map((c) => {
          const s = typeof c === 'number' ? String(c).replace('.', ',') : String(c ?? '')
          return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
        })
        .join(';'),
    )
    .join('\r\n')
  // BOM para o Excel reconhecer UTF-8 e não quebrar os acentos
  const blob = new Blob([`﻿${conteudo}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = nome.endsWith('.csv') ? nome : `${nome}.csv`
  a.click()
  URL.revokeObjectURL(url)
}
