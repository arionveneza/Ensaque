import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

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
          <h2 className="text-xl font-bold tracking-tight text-stone-900 dark:text-stone-100">{titulo}</h2>
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
  semPadding = false,
}: {
  titulo?: ReactNode
  acoes?: ReactNode
  children: ReactNode
  className?: string
  /** Sem o padding padrão de 16px — para uma lista de linhas divididas que
   *  deve tocar as bordas do card ponta a ponta, em vez de flutuar dentro
   *  de uma margem. Cuida do overflow-hidden pra a lista não vazar quadrada
   *  por cima dos cantos arredondados do card. */
  semPadding?: boolean
}) {
  return (
    <section
      className={`rounded-xl border border-stone-200 bg-white shadow-sm dark:border-stone-800 dark:bg-stone-900 ${semPadding ? 'overflow-hidden' : ''} ${className}`}
    >
      {(titulo || acoes) && (
        <header className="flex flex-col gap-2 border-b border-stone-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between dark:border-stone-800">
          {titulo && <h3 className="text-sm font-semibold tracking-tight">{titulo}</h3>}
          {acoes && <div className="flex flex-wrap gap-2">{acoes}</div>}
        </header>
      )}
      <div className={semPadding ? '' : 'p-4'}>{children}</div>
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
      ? 'bg-green-900 text-white hover:bg-green-950 dark:bg-green-700 dark:hover:bg-green-600'
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
      className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-600 disabled:pointer-events-none disabled:opacity-40 sm:py-1.5 ${estilo} ${className}`}
    >
      {children}
    </button>
  )
}

export function Tag({
  children,
  cor = 'neutro',
  className = '',
}: {
  children: ReactNode
  cor?: 'neutro' | 'ok' | 'alerta' | 'perigo' | 'info' | 'roxo'
  className?: string
}) {
  const cores = {
    neutro: 'bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300',
    ok: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
    alerta: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
    perigo: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
    info: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
    roxo: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300',
  }
  return (
    <span
      className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap ${cores[cor]} ${className}`}
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
    <p className="rounded-lg bg-stone-50 px-4 py-8 text-center text-sm text-stone-500 dark:bg-stone-800/50 dark:text-stone-400">
      {children}
    </p>
  )
}

export function Erro({ children }: { children: ReactNode }) {
  return (
    // break-words: mensagem com token longo sem espaço (um JSON de erro do SAP,
    // por ex.) não pode empurrar scroll horizontal da página no celular
    <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm break-words text-red-700 dark:bg-red-950/40 dark:text-red-300">
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
    ok: 'border-green-300 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300',
  }
  return (
    // break-words: token longo sem espaço (um UUID em <code>, por ex.) não
    // quebra por padrão e empurra scroll horizontal da página inteira
    <div className={`rounded-lg border px-4 py-2.5 text-sm break-words ${cores[gravidade]}`}>
      {children}
    </div>
  )
}

/**
 * Coluna simples ("#Peso") ou com classe extra — tipicamente
 * `'hidden lg:table-cell'` para esconder no celular/tablet. Quando usar a
 * forma com objeto, aplique a MESMA className no `<td>` correspondente de
 * cada linha — o Tabela não controla as linhas, que vêm como `children`.
 *
 * `onClick` torna o cabeçalho clicável (ordenar por essa coluna); `ordem`
 * mostra a seta de direção quando esta é a coluna ativa. Quem ordena as
 * linhas de verdade é o dono da tabela (o Tabela só repassa `children`).
 */
export type ColunaTabela =
  | string
  | { texto: string; className?: string; onClick?: () => void; ordem?: 'asc' | 'desc' }

export function Tabela({
  cabecalho, children, larguraFixa = false, rodape,
}: {
  cabecalho: ColunaTabela[]
  children: ReactNode
  /** Linha(s) de total — vai num <tfoot>; `children` cai dentro do <tbody>. */
  rodape?: ReactNode
  /**
   * table-layout: fixed — pra várias tabelas SEPARADAS na mesma tela
   * (ex.: uma por lote, empilhadas) manterem as mesmas larguras de coluna.
   * Sem isso, cada `<table>` calcula a largura sozinha pelo próprio
   * conteúdo, e uma linha com texto mais longo desalinha aquela tabela das
   * vizinhas (achado do Arion, 26/08/2026, tela Logística). A largura de
   * cada coluna vem do `className` do cabeçalho (ex.: `w-24`) — a que não
   * tiver largura própria fica com o espaço que sobrar.
   */
  larguraFixa?: boolean
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
        <table className={`w-full text-sm ${larguraFixa ? 'table-fixed' : ''}`}>
          <thead>
            <tr className="border-b border-stone-200 text-left text-xs uppercase tracking-wide text-stone-500 dark:border-stone-800 dark:text-stone-400">
              {cabecalho.map((c, i) => {
                const texto = typeof c === 'string' ? c : c.texto
                const extra = typeof c === 'string' ? '' : (c.className ?? '')
                const onClick = typeof c === 'string' ? undefined : c.onClick
                const ordem = typeof c === 'string' ? undefined : c.ordem
                return (
                  <th
                    key={texto + i}
                    onClick={onClick}
                    className={`px-2 py-2 ${texto.startsWith('#') ? 'text-right' : ''} ${extra} ${
                      onClick
                        ? 'cursor-pointer select-none hover:text-stone-700 dark:hover:text-stone-200'
                        : ''
                    }`}
                  >
                    {texto.replace(/^#/, '')}
                    {ordem === 'asc' && ' ▲'}
                    {ordem === 'desc' && ' ▼'}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>{children}</tbody>
          {rodape && <tfoot>{rodape}</tfoot>}
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

/** Armazéns padronizados A–E (pedido do Arion, 05/09/2026) — lista, não texto livre. */
export const ARMAZENS = ['A', 'B', 'C', 'D', 'E']

/**
 * Seleção de armazém padronizada (Inventário, conferência da Logística,
 * ajuste de estoque). Valor antigo fora do padrão continua visível e
 * selecionável na edição — sumir com ele corromperia o dado calado.
 */
export function SeletorArmazem({
  valor, aoMudar, className = '',
}: {
  valor: string
  aoMudar: (v: string) => void
  className?: string
}) {
  const opcoes = valor && !ARMAZENS.includes(valor) ? [valor, ...ARMAZENS] : ARMAZENS
  return (
    <select
      value={valor}
      onChange={(e) => aoMudar(e.target.value)}
      className={
        className ||
        'w-full rounded-md border border-stone-300 px-2 py-2 text-sm sm:py-1.5 dark:border-stone-700 dark:bg-stone-800'
      }
    >
      <option value="">—</option>
      {opcoes.map((a) => (
        <option key={a} value={a}>{a}</option>
      ))}
    </select>
  )
}

/**
 * Toggle OK / Fora do padrão — usado em checklists (Qualidade, veículo).
 * `ok: null` = ainda sem resposta: nenhum dos dois botões fica destacado.
 */
export function AlternadorOkFora({
  rotulo, ok, onMudar,
}: {
  rotulo: string
  ok: boolean | null
  onMudar: (v: boolean) => void
}) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-stone-500">{rotulo}</p>
      <div className="mt-1 flex gap-2">
        {([true, false] as const).map((v) => (
          <button
            key={String(v)}
            onClick={() => onMudar(v)}
            className={`rounded-md border px-3 py-2.5 text-sm sm:py-1.5 ${
              ok === v
                ? v
                  ? 'border-green-600 bg-green-600 text-white'
                  : 'border-amber-500 bg-amber-500 text-white'
                : 'border-stone-300 dark:border-stone-700'
            }`}
          >
            {v ? 'OK' : 'Fora do padrão'}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * Dropdown de múltipla escolha com busca, teclado (↑↓ move, espaço/Enter
 * marca, Backspace apaga o último chip) e chips com × pra remover — a tela
 * de Ordens já usava para cultivar/tratamento no painel de Demanda; extraído
 * pra cá (21/09/2026) pra reusar nos filtros da Expedição.
 */
export function SeletorMultiplo({
  rotulo, opcoes, selecionados, onMudar, compacto = true,
}: {
  rotulo: string
  opcoes: string[]
  selecionados: string[]
  onMudar: (s: string[]) => void
  /** false = mesma altura/raio do CAMPO_FILTRO (barra de filtros); true (padrão) mantém o tamanho compacto do painel de Demanda. */
  compacto?: boolean
}) {
  const [aberto, setAberto] = useState(false)
  const [busca, setBusca] = useState('')
  const [destacado, setDestacado] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  // ↑/↓ rola a lista (scrollIntoView) e o cursor do mouse, parado, passa a
  // sobrepor um item DIFERENTE — o navegador dispara mouseenter mesmo sem o
  // mouse se mexer, e o destaque "voltava pra cima do nada" no meio da
  // navegação por teclado (achado do Arion, 18/08/2026). Só deixa o hover
  // mudar o destaque depois de um mousemove de verdade.
  const mouseAtivo = useRef(true)

  const filtradas = useMemo(
    () => opcoes.filter((o) => o.toLowerCase().includes(busca.trim().toLowerCase())),
    [opcoes, busca],
  )

  useEffect(() => {
    if (!aberto) return
    const aoClicarFora = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setAberto(false)
    }
    document.addEventListener('mousedown', aoClicarFora)
    return () => document.removeEventListener('mousedown', aoClicarFora)
  }, [aberto])

  // a busca muda o tamanho da lista filtrada — o destaque não pode ficar
  // apontando para um índice que não existe mais
  useEffect(() => {
    setDestacado((d) => Math.min(d, Math.max(0, filtradas.length - 1)))
  }, [filtradas.length])

  // ↑/↓ move o destaque mas a lista tem overflow-y-auto: sem isto, passar do
  // que já está visível parecia travado — o destaque ia embora da tela e
  // nada mostrava que a seta continuava funcionando
  useEffect(() => {
    if (!aberto) return
    itemRefs.current[destacado]?.scrollIntoView({ block: 'nearest' })
  }, [destacado, aberto])

  function alternar(v: string) {
    onMudar(selecionados.includes(v) ? selecionados.filter((s) => s !== v) : [...selecionados, v])
  }

  function aoTeclar(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      mouseAtivo.current = false
      setDestacado((d) => Math.min(d + 1, filtradas.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      mouseAtivo.current = false
      setDestacado((d) => Math.max(d - 1, 0))
    } else if (e.key === ' ' && busca === '') {
      e.preventDefault()
      const alvo = filtradas[destacado]
      if (alvo) alternar(alvo)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const alvo = filtradas[destacado]
      if (alvo) alternar(alvo)
    } else if (e.key === 'Backspace' && busca === '' && selecionados.length > 0) {
      onMudar(selecionados.slice(0, -1))
    } else if (e.key === 'Escape') {
      setAberto(false)
    }
  }

  if (!aberto) {
    return (
      <button
        type="button"
        onClick={() => setAberto(true)}
        className={`rounded-lg border ${compacto ? 'px-3 py-1.5 text-xs' : 'px-3 py-2 text-sm sm:py-1.5'} ${
          selecionados.length > 0
            ? 'border-stone-800 bg-stone-800 text-white dark:border-stone-200 dark:bg-stone-200 dark:text-stone-900'
            : 'border-stone-300 text-stone-600 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800'
        }`}
      >
        {rotulo}{selecionados.length > 0 ? ` (${selecionados.length})` : ''} ▾
      </button>
    )
  }

  return (
    <div ref={ref} className="relative">
      <div className="flex min-w-40 max-w-xs flex-wrap items-center gap-1 rounded-md border border-stone-800 px-2 py-1 text-xs dark:border-stone-200">
        <span className="text-stone-500">{rotulo}</span>
        {selecionados.map((s) => (
          <span
            key={s}
            className="flex items-center gap-1 rounded bg-stone-800 px-1.5 py-0.5 text-white dark:bg-stone-200 dark:text-stone-900"
          >
            {s}
            <button
              type="button"
              onClick={() => alternar(s)}
              title="Remover"
              className="leading-none"
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          autoFocus
          value={busca}
          onChange={(e) => {
            setBusca(e.target.value)
            setDestacado(0)
          }}
          onKeyDown={aoTeclar}
          placeholder={selecionados.length === 0 ? 'buscar…' : ''}
          className="min-w-16 flex-1 bg-transparent outline-none"
        />
      </div>
      <div
        onMouseMove={() => { mouseAtivo.current = true }}
        className="absolute z-20 mt-1 max-h-72 w-64 overflow-y-auto rounded-md border border-stone-300 bg-white p-1 shadow-lg dark:border-stone-700 dark:bg-stone-900"
      >
        {selecionados.length > 0 && (
          <button
            type="button"
            onClick={() => onMudar([])}
            className="mb-1 block w-full px-2 py-1 text-left text-xs text-stone-500 underline"
          >
            limpar seleção
          </button>
        )}
        {filtradas.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-stone-400">nada encontrado</p>
        ) : (
          filtradas.map((o, i) => (
            <button
              key={o}
              ref={(el) => { itemRefs.current[i] = el }}
              type="button"
              onClick={() => alternar(o)}
              onMouseEnter={() => { if (mouseAtivo.current) setDestacado(i) }}
              className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm ${
                i === destacado ? 'bg-stone-100 dark:bg-stone-800' : ''
              }`}
            >
              <input
                type="checkbox"
                checked={selecionados.includes(o)}
                readOnly
                className="pointer-events-none"
              />
              {o}
            </button>
          ))
        )}
      </div>
    </div>
  )
}
