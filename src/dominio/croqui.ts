/**
 * Veículos do croqui de carregamento (29/08/2026) — réplica do formulário
 * de papel "Registro de Expedição de Sementes — Croqui da Carga".
 *
 * Capacidades confirmadas pelo Arion: LS 40 · Bitrem 48 · Rodotrem 60.
 * Truck e Bitruck saíram da proporção por carga útil legal (~1,25 bag/t):
 * Truck ≈ 16, Bitruck ≈ 22 — ajustar aqui se a operação usar outro número.
 * As FILAS são os espaços em branco do desenho, onde o conferente anota à
 * mão o que foi em cada posição (mesma folha que já usam impressa).
 */

export interface VeiculoCarga {
  id: string
  nome: string
  /** Teto de bags — o aviso de capacidade da montagem usa isto (não bloqueia). */
  capacidadeBags: number
  /** Filas de anotação por carroceria (1 item = 1 carreta/caçamba). */
  carretas: number[]
}

export const VEICULOS_CARGA: VeiculoCarga[] = [
  { id: 'UTILITARIO', nome: 'Utilitário', capacidadeBags: 2, carretas: [1] },
  { id: 'TRUCK', nome: 'Truck', capacidadeBags: 16, carretas: [4] },
  { id: 'BITRUCK', nome: 'Bitruck', capacidadeBags: 22, carretas: [6] },
  { id: 'CARRETA_LS', nome: 'Carreta LS', capacidadeBags: 40, carretas: [10] },
  { id: 'BITREM', nome: 'Bitrem', capacidadeBags: 48, carretas: [6, 6] },
  // 9 fileiras por carreta (Arion, 30/08/2026)
  { id: 'RODOTREM', nome: 'Rodotrem 9 eixos', capacidadeBags: 60, carretas: [9, 9] },
]

export const veiculoDe = (id: string | null | undefined): VeiculoCarga | null =>
  VEICULOS_CARGA.find((v) => v.id === id) ?? null
