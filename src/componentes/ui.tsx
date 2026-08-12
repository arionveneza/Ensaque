import type { ReactNode } from 'react'

/** Peças visuais compartilhadas pelas telas. Nada de regra de negócio aqui. */

export const n = (v: number | null | undefined, casas = 1): string =>
  v == null || Number.isNaN(v)
    ? '—'
    : v.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas })

export const inteiro = (v: number | null | undefined): string =>
  v == null || Number.isNaN(v) ? '—' : v.toLocaleString('pt-BR')

/** Destino do produto na receita: T1–T5, ou 0 = transferidor (pó secante). */
export const rotuloTanque = (tanque: number): string =>
  tanque === 0 ? 'Transferidor' : `T${tanque}`

export const diaCurto = (iso: string | null): string =>
  !iso ? '—' : `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

/**
 * "05/08 14:32" — timestamp do banco em horário local. O dia vai junto de
 * propósito: o turno 2 cruza a meia-noite, e só a hora seria ambígua.
 */
export const dataHoraCurta = (iso: string | null): string => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p2 = (v: number) => String(v).padStart(2, '0')
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

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
    <div className="mx-auto max-w-[1600px] px-4 py-4 sm:px-6 sm:py-6">
      {/* empilha no celular: 3-4 botões de ação ao lado do título comiam a
          tela toda antes de qualquer conteúdo aparecer */}
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
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
        <header className="flex flex-col gap-2 border-b border-stone-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between dark:border-stone-800">
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
  className = '',
}: {
  children: ReactNode
  onClick?: () => void
  variante?: 'normal' | 'primario' | 'perigo'
  disabled?: boolean
  titulo?: string
  tipo?: 'button' | 'submit'
  className?: string
}) {
  const estilo =
    variante === 'primario'
      ? 'bg-emerald-700 text-white hover:bg-emerald-800 dark:bg-emerald-600 dark:hover:bg-emerald-500'
      : variante === 'perigo'
        ? 'border border-red-300 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/40'
        : 'border border-stone-300 hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800'
  return (
    <button
      type={tipo}
      title={titulo}
      disabled={disabled}
      onClick={onClick}
      // py-2 no celular (~40px de alvo de toque, 119 usos herdam de uma vez);
      // sm: devolve py-1.5 — desktop e tablet ficam como já estavam
      className={`rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 disabled:pointer-events-none disabled:opacity-40 sm:py-1.5 ${estilo} ${className}`}
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
    <span
      className={`inline-block rounded px-2 py-0.5 text-xs font-medium whitespace-nowrap ${cores[cor]}`}
    >
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
    // break-words: mensagem com token longo sem espaço (um JSON de erro do SAP,
    // por ex.) não pode empurrar scroll horizontal da página no celular
    <div className="mb-4 rounded-md bg-red-50 px-4 py-3 text-sm break-words text-red-700 dark:bg-red-950/40 dark:text-red-300">
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
    // break-words: token longo sem espaço (um UUID em <code>, por ex.) não
    // quebra por padrão e empurra scroll horizontal da página inteira
    <div className={`rounded-md border px-4 py-2.5 text-sm break-words ${cores[gravidade]}`}>
      {children}
    </div>
  )
}

/**
 * Coluna simples ("#Peso") ou com classe extra — tipicamente
 * `'hidden lg:table-cell'` para esconder no celular/tablet. Quando usar a
 * forma com objeto, aplique a MESMA className no `<td>` correspondente de
 * cada linha — o Tabela não controla as linhas, que vêm como `children`.
 */
export type ColunaTabela = string | { texto: string; className?: string }

export function Tabela({
  cabecalho, children,
}: {
  cabecalho: ColunaTabela[]
  children: ReactNode
}) {
  return (
    /**
     * As máscaras moram no wrapper EXTERNO, e o overflow num div interno:
     * filho absoluto de um scroller pertence ao conteúdo rolável, então as
     * máscaras rolavam junto — a dica só funcionava na posição zero e, ao
     * rolar, virava uma mancha branca de 16px por cima dos números.
     */
    <div className="relative">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-stone-200 text-left text-xs uppercase tracking-wide text-stone-500 dark:border-stone-800 dark:text-stone-400">
              {cabecalho.map((c, i) => {
                const texto = typeof c === 'string' ? c : c.texto
                const extra = typeof c === 'string' ? '' : (c.className ?? '')
                return (
                  <th
                    key={texto + i}
                    className={`px-2 py-2 ${texto.startsWith('#') ? 'text-right' : ''} ${extra}`}
                  >
                    {texto.replace(/^#/, '')}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
      {/* dica visual de que há mais coluna fora da tela — só no celular,
          onde o overflow-x-auto sozinho não avisa nada */}
      <div className="pointer-events-none absolute inset-y-0 left-0 w-4 bg-gradient-to-r from-white to-transparent sm:hidden dark:from-stone-900" />
      <div className="pointer-events-none absolute inset-y-0 right-0 w-4 bg-gradient-to-l from-white to-transparent sm:hidden dark:from-stone-900" />
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
