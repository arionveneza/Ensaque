/**
 * Prioridades do dia (16/09/2026): a faixa curta e ordenada que o PCP monta
 * acima da fila de cada máquina na Programação, e que a Execução mostra em
 * destaque (P1, P2, P3…). Puro: listas de ids e posições.
 */

export interface ComPrioridadeDia {
  id: string
  seq: number | null
  numero: string
  /** Posição na faixa (1..n); nula = não priorizada. */
  prioridade_dia: number | null
}

/**
 * Ordem de exibição da fila de uma máquina: as priorizadas primeiro, pela
 * posição na faixa; depois as demais pela sequência (o mesmo critério da
 * Programação — seq, e no empate o número).
 */
export function ordenarComPrioridades<T extends ComPrioridadeDia>(fila: T[]): T[] {
  return [...fila].sort(
    (a, b) =>
      (a.prioridade_dia ?? Infinity) - (b.prioridade_dia ?? Infinity) ||
      (a.seq ?? 9999) - (b.seq ?? 9999) ||
      a.numero.localeCompare(b.numero),
  )
}

/** Só as priorizadas, em ordem. */
export function faixaDe<T extends ComPrioridadeDia>(fila: T[]): T[] {
  return fila
    .filter((o) => o.prioridade_dia != null)
    .sort((a, b) => (a.prioridade_dia ?? 0) - (b.prioridade_dia ?? 0))
}

/**
 * Nova lista de ids da faixa depois de soltar `ordemId` na posição `pos`
 * (índice na faixa COMO ELA APARECE; `null` = no fim). Se a ordem já estava
 * na faixa acima do ponto de destino, o índice recua um — senão soltar logo
 * abaixo da posição atual não sairia do lugar (mesma armadilha do `mover`).
 */
export function listaAposArraste(atual: string[], ordemId: string, pos: number | null): string[] {
  const idxOriginal = atual.indexOf(ordemId)
  const destino = atual.filter((id) => id !== ordemId)
  let p = pos == null ? destino.length : pos
  if (idxOriginal >= 0 && idxOriginal < p) p -= 1
  p = Math.max(0, Math.min(p, destino.length))
  destino.splice(p, 0, ordemId)
  return destino
}

/** Troca a ordem com a vizinha (▲ = -1, ▼ = +1); fora dos limites, não muda. */
export function moverNaFaixa(atual: string[], ordemId: string, delta: -1 | 1): string[] {
  const i = atual.indexOf(ordemId)
  const j = i + delta
  if (i < 0 || j < 0 || j >= atual.length) return atual
  const nova = [...atual]
  ;[nova[i], nova[j]] = [nova[j], nova[i]]
  return nova
}

export const semDaFaixa = (atual: string[], ordemId: string): string[] =>
  atual.filter((id) => id !== ordemId)

/** Botão "prioridade": fora da faixa → entra no fim; dentro → sai. O mesmo clique no cartão e na lista. */
export const alternarNaFaixa = (atual: string[], ordemId: string): string[] =>
  atual.includes(ordemId) ? semDaFaixa(atual, ordemId) : [...atual, ordemId]
