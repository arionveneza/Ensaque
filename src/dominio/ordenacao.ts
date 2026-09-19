/**
 * Ordenação de listas para EXIBIÇÃO (19/09/2026). Puro e genérico: quem
 * chama diz como comparar cada campo; aqui ficam a comparação de texto em
 * pt-BR, o ciclo do clique no cabeçalho e a regra de empate estável. Nasceu
 * para a lista do quadro do dia da Programação; `ordenarFaltaPorProduto`
 * (expedicao.ts) já seguia o mesmo desenho.
 */

export type Direcao = 'asc' | 'desc'

/** Estado de ordenação de uma tabela — nulo = ordem padrão de quem a exibe. */
export type Ordenacao<C extends string> = { campo: C; dir: Direcao } | null

export type Comparador<T> = (a: T, b: T) => number

/** Texto em pt-BR e numérico: "NEO680" antes de "NEO1000", "P9" antes de "P10". */
export const porNome = (a: string, b: string): number =>
  a.localeCompare(b, 'pt-BR', { numeric: true })

export const porNumero = (a: number, b: number): number => a - b

/** O primeiro comparador que desempata decide. */
export function emCascata<T>(...cs: Comparador<T>[]): Comparador<T> {
  return (a, b) => {
    for (const c of cs) {
      const r = c(a, b)
      if (r !== 0) return r
    }
    return 0
  }
}

/** Inverte o sinal quando 'desc' (empate continua 0, nunca -0). */
export function comDirecao<T>(c: Comparador<T>, dir: Direcao): Comparador<T> {
  if (dir !== 'desc') return c
  return (a, b) => {
    const r = c(a, b)
    return r === 0 ? 0 : -r
  }
}

/**
 * Ciclo do clique no cabeçalho: outro campo → asc; asc → desc; desc → nulo
 * (volta à ordem padrão). Três estados, como na lista de Ordens.
 */
export function alternarOrdenacao<C extends string>(atual: Ordenacao<C>, campo: C): Ordenacao<C> {
  if (!atual || atual.campo !== campo) return { campo, dir: 'asc' }
  return atual.dir === 'asc' ? { campo, dir: 'desc' } : null
}

/**
 * Lista NOVA ordenada pelo campo, na direção pedida; no empate, `desempate`
 * SEMPRE ascendente — a mesma entrada dá a mesma saída em asc e em desc, e
 * clicar duas vezes não embaralha quem empatou. Nulo devolve uma cópia na
 * ordem recebida. Não altera a lista de entrada.
 */
export function ordenarPor<T, C extends string>(
  lista: readonly T[],
  ordenacao: Ordenacao<C>,
  comparadores: Record<C, Comparador<T>>,
  desempate: Comparador<T> = () => 0,
): T[] {
  if (!ordenacao) return [...lista]
  const principal = comDirecao(comparadores[ordenacao.campo], ordenacao.dir)
  return [...lista].sort(emCascata(principal, desempate))
}
