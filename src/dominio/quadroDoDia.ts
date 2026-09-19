/**
 * Quadro do dia da Programação (19/09/2026): o agrupamento de exibição que
 * antes vivia no JSX do cartão da máquina, a numeração de posição e a
 * ordenação da visão em lista. Puro — vale para os cartões e para a lista.
 */
import { ordenarPor, porNome, porNumero, type Ordenacao } from './ordenacao'
import { compararTratamentos } from './tratamentos'

export const STATUS_CONCLUIDOS = ['Finalizada', 'Qualidade apontada', 'Apontada'] as const

export const ehConcluida = (status: string): boolean =>
  (STATUS_CONCLUIDOS as readonly string[]).includes(status)

/** O ciclo de vida, na ordem — é por ela que a coluna Status ordena. */
export const CICLO_STATUS = [
  'Nao programada', 'Programada', 'Aguardando lote', 'Pronto para produzir',
  'Em producao', 'Parada', 'Finalizada', 'Qualidade apontada', 'Apontada',
] as const

const posNoCiclo = (s: string): number => {
  const i = (CICLO_STATUS as readonly string[]).indexOf(s)
  return i < 0 ? CICLO_STATUS.length : i
}

/** O que a lista precisa de uma ordem para ordenar e numerar. */
export interface OrdemDoQuadro {
  id: string
  numero: string
  cultivar: string
  receita_id: string
  receita_nome: string
  bags: number
  peso_t: number
  status_efetivo: string
  data_expedicao: string | null
}

/** Colunas ordenáveis da lista. */
export type CampoQuadro = 'cultivar' | 'tratamento' | 'bags' | 'peso' | 'expedicao' | 'status'

export interface GruposDoDia<T> {
  rodando: T[]
  pronto: T[]
  aguardando: T[]
  programada: T[]
  concluidas: T[]
}

/**
 * Ordem de EXIBIÇÃO do quadro do dia, separada da ordem REAL (a fila por
 * seq, a única que mover/renumerar/cascata conhecem): quem está rodando
 * primeiro, o que pode ser produzido logo depois, o que espera o lote em
 * seguida, o que o PCP ainda não confirmou, e o que já passou pela
 * qualidade no fim, fora do caminho. Dentro de cada grupo, a ordem da fila.
 *
 * `Pronto para produzir` e `Aguardando lote` são grupos SEPARADOS: a
 * diferença é se a ordem pode rodar HOJE ou está bloqueada esperando a
 * logística. Status que não casa com nenhum grupo cai em `programada` —
 * nunca some da célula (a `Programada` sumiu assim uma vez, 11/08/2026).
 */
export function exibicaoDoDia<T extends { status_efetivo: string }>(
  fila: readonly T[],
): { exibicao: T[]; inicioConcluidas: number; grupos: GruposDoDia<T> } {
  const grupos: GruposDoDia<T> = { rodando: [], pronto: [], aguardando: [], programada: [], concluidas: [] }
  for (const x of fila) {
    const s = x.status_efetivo
    if (s === 'Em producao' || s === 'Parada') grupos.rodando.push(x)
    else if (s === 'Pronto para produzir') grupos.pronto.push(x)
    else if (s === 'Aguardando lote') grupos.aguardando.push(x)
    else if (ehConcluida(s)) grupos.concluidas.push(x)
    else grupos.programada.push(x)
  }
  const exibicao = [
    ...grupos.rodando, ...grupos.pronto, ...grupos.aguardando, ...grupos.programada, ...grupos.concluidas,
  ]
  return { exibicao, inicioConcluidas: exibicao.length - grupos.concluidas.length, grupos }
}

/**
 * O grupo dentro do qual as setas ▲▼ trocam a ordem de lugar: só com o
 * vizinho do MESMO status. Rodando e concluída não se movem (lista vazia).
 */
export function grupoMovel<T extends { status_efetivo: string }>(grupos: GruposDoDia<T>, x: T): T[] {
  return x.status_efetivo === 'Pronto para produzir'
    ? grupos.pronto
    : x.status_efetivo === 'Aguardando lote'
      ? grupos.aguardando
      : x.status_efetivo === 'Programada'
        ? grupos.programada
        : []
}

/**
 * Posição de exibição (1..n) de cada ordem — a numeração que o cartão
 * mostra. A lista a calcula da fila PADRÃO, nunca do índice da tabela
 * ordenada: ordenar por cultivar não pode renumerar a fila.
 */
export function posicoesDeExibicao<T extends { id: string; status_efetivo: string }>(
  fila: readonly T[],
): Map<string, number> {
  const m = new Map<string, number>()
  exibicaoDoDia(fila).exibicao.forEach((x, i) => m.set(x.id, i + 1))
  return m
}

/**
 * Linhas da lista: nulo = a exibição padrão dos cartões; senão pelo campo,
 * com empate pelo nº da ordem (pt-BR numérico). SÓ VISÃO — o seq não muda.
 * - As já produzidas (concluídas) NÃO entram na ordenação: ficam sempre no
 *   fim, na ordem da fila ("quando classificar, não mexer nas ordens que já
 *   foram produzidas" — Arion, 19/09/2026).
 * - Expedição: quem não tem data fica sempre no fim das ativas, em asc e em
 *   desc (data é o que se procura; "sem data" não é "a maior").
 * - Status: na ordem do ciclo de vida, não alfabética.
 * - Tratamento: por família, base antes das derivações (menos itens na
 *   receita primeiro — `itensPorReceita`), depois nome.
 */
export function ordenarQuadroDoDia<T extends OrdemDoQuadro>(
  fila: readonly T[],
  ordenacao: Ordenacao<CampoQuadro>,
  itensPorReceita?: ReadonlyMap<string, number>,
): T[] {
  if (!ordenacao) return exibicaoDoDia(fila).exibicao
  const ativas = fila.filter((x) => !ehConcluida(x.status_efetivo))
  const concluidas = fila.filter((x) => ehConcluida(x.status_efetivo))
  const porNumeroDaOrdem = (a: T, b: T) => porNome(a.numero, b.numero)
  const tratamentoDe = (x: T) => ({ nome: x.receita_nome, itens: itensPorReceita?.get(x.receita_id) ?? null })
  const comparadores = {
    cultivar: (a: T, b: T) => porNome(a.cultivar, b.cultivar),
    tratamento: (a: T, b: T) => compararTratamentos(tratamentoDe(a), tratamentoDe(b)),
    bags: (a: T, b: T) => porNumero(a.bags, b.bags),
    peso: (a: T, b: T) => porNumero(a.peso_t, b.peso_t),
    expedicao: (a: T, b: T) => (a.data_expedicao ?? '').localeCompare(b.data_expedicao ?? ''),
    status: (a: T, b: T) => porNumero(posNoCiclo(a.status_efetivo), posNoCiclo(b.status_efetivo)),
  }
  if (ordenacao.campo === 'expedicao') {
    const comData = ativas.filter((x) => x.data_expedicao)
    const semData = [...ativas.filter((x) => !x.data_expedicao)].sort(porNumeroDaOrdem)
    return [...ordenarPor(comData, ordenacao, comparadores, porNumeroDaOrdem), ...semData, ...concluidas]
  }
  return [...ordenarPor(ativas, ordenacao, comparadores, porNumeroDaOrdem), ...concluidas]
}
