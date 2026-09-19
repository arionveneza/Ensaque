/**
 * Quadro do dia da Programação (19/09/2026): o agrupamento de exibição que
 * antes vivia no JSX do cartão da máquina, a numeração de posição e a
 * ordenação da visão em lista. Puro — vale para os cartões e para a lista.
 */
import { ordenarPor, porNome, porNumero, type Ordenacao } from './ordenacao'

export const STATUS_CONCLUIDOS = ['Finalizada', 'Qualidade apontada', 'Apontada'] as const

export const ehConcluida = (status: string): boolean =>
  (STATUS_CONCLUIDOS as readonly string[]).includes(status)

/** O que a lista precisa de uma ordem para ordenar e numerar. */
export interface OrdemDoQuadro {
  id: string
  numero: string
  cultivar: string
  receita_nome: string
  bags: number
  peso_t: number
  status_efetivo: string
}

/** Colunas ordenáveis da lista. */
export type CampoQuadro = 'cultivar' | 'tratamento' | 'bags' | 'peso'

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
 * com empate pelo nº da ordem (pt-BR numérico). SÓ VISÃO — o seq não muda,
 * e por isso a lista não tem ▲▼.
 */
export function ordenarQuadroDoDia<T extends OrdemDoQuadro>(
  fila: readonly T[],
  ordenacao: Ordenacao<CampoQuadro>,
): T[] {
  if (!ordenacao) return exibicaoDoDia(fila).exibicao
  return ordenarPor(
    fila,
    ordenacao,
    {
      cultivar: (a, b) => porNome(a.cultivar, b.cultivar),
      tratamento: (a, b) => porNome(a.receita_nome, b.receita_nome),
      bags: (a, b) => porNumero(a.bags, b.bags),
      peso: (a, b) => porNumero(a.peso_t, b.peso_t),
    },
    (a, b) => porNome(a.numero, b.numero),
  )
}
