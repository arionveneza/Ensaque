/**
 * Endereço de um lote no galpão (03/10/2026, regra do Arion): ARMAZÉM de A a
 * E (as letras que existem hoje), BLOCO numérico de 1 a 44 e QUADRA numérica
 * de 1 a 20. A quadra 1 é a da parede — a de número maior fica na frente, no
 * acesso (mesma leitura da grade do Mapa, "número MAIOR = frente").
 *
 * O formato gravado é o número puro, sem zero à esquerda ("6", não "06" nem
 * "06E"): a grade ordena bloco com `localeCompare(numeric)` e quadra por
 * número, e o banco tem um CHECK com a mesma regra em `lote_enderecos` e
 * `inventario_itens` (migração inventario-implantacao-mapa.sql) — mudou aqui,
 * mude lá.
 */

export const ARMAZENS_GALPAO = ['A', 'B', 'C', 'D', 'E'] as const
export const BLOCO_MAX = 44
export const QUADRA_MAX = 20

export const BLOCOS = Array.from({ length: BLOCO_MAX }, (_, i) => String(i + 1))
export const QUADRAS = Array.from({ length: QUADRA_MAX }, (_, i) => String(i + 1))

export interface Endereco {
  armazem: string
  bloco: string
  quadra: string
}

/**
 * Número de bloco/quadra no formato gravado, ou null se não couber na faixa.
 * Aceita o que o galpão costuma escrever: "6", "06", "06E" e "1A" (o formato
 * antigo punha a letra do armazém colada no bloco) viram "6"/"1".
 */
export function numeroEndereco(valor: string | null | undefined, max: number): string | null {
  const m = String(valor ?? '').trim().toUpperCase().match(/^0*(\d{1,3})\s*[A-Z]?$/)
  if (!m) return null
  const n = Number(m[1])
  return Number.isInteger(n) && n >= 1 && n <= max ? String(n) : null
}

export const armazemValido = (a: string | null | undefined): boolean =>
  (ARMAZENS_GALPAO as readonly string[]).includes(String(a ?? '').trim().toUpperCase())

/** Endereço normalizado e completo, ou null se faltar/estiver fora da regra. */
export function normalizaEndereco(e: {
  armazem: string | null | undefined
  bloco: string | null | undefined
  quadra: string | null | undefined
}): Endereco | null {
  const armazem = String(e.armazem ?? '').trim().toUpperCase()
  const bloco = numeroEndereco(e.bloco, BLOCO_MAX)
  const quadra = numeroEndereco(e.quadra, QUADRA_MAX)
  if (!armazemValido(armazem) || !bloco || !quadra) return null
  return { armazem, bloco, quadra }
}

/** O que falta para o endereço valer — texto curto para a tela. */
export function problemaEndereco(e: {
  armazem: string | null | undefined
  bloco: string | null | undefined
  quadra: string | null | undefined
}): string | null {
  if (!armazemValido(e.armazem)) return 'escolha o armazém (A a E)'
  if (!numeroEndereco(e.bloco, BLOCO_MAX)) return `escolha o bloco (1 a ${BLOCO_MAX})`
  if (!numeroEndereco(e.quadra, QUADRA_MAX)) return `escolha a quadra (1 a ${QUADRA_MAX})`
  return null
}
