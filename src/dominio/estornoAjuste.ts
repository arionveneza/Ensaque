import { ARMAZENS_GALPAO, BLOCO_MAX, QUADRA_MAX, numeroEndereco, rotuloEndereco } from './endereco'

/**
 * Estorno de baixas do mapa (20/10/2026, pedido do Arion: "foram realizadas
 * diversas baixas de estoque direto no mapa do dia 19/10, precisamos de uma
 * forma de realizar o estorno destas baixas").
 *
 * O rastro em `mapa_ajustes` é a única fonte do desfazer: uma linha pode ser
 * estornada UMA vez (ganha `estornado_em`) e o estorno é outra linha, com
 * `estorno_de` apontando pra original. A exclusão apagou os endereços sem
 * guardar onde estavam, então o endereço de volta é sugerido: o do próprio
 * ajuste quando ele tem um completo, senão o último contado no inventário
 * antes da baixa (decisão dele: "endereço de origem, quando se sabe").
 */

export interface AjusteEstornavel {
  id: string
  lote: string
  tratamento: string
  delta: number
  motivo: string
  armazem: string | null
  bloco: string | null
  quadra: string | null
  criado_em: string
  estornado_em: string | null
  estorno_de: string | null
}

/** Último lançamento de inventário da combinação antes da baixa. */
export interface EnderecoContado {
  armazem: string
  bloco: string
  quadra: string
  bags: number | null
  /** Quando foi contado (ISO). */
  em: string
}

export interface SugestaoEndereco {
  armazem: string
  bloco: string
  quadra: string
  origem: 'ajuste' | 'inventario'
  /** Só com origem 'inventario': quando foi contado (ISO). */
  em?: string
}

export type TipoAjuste = 'todos' | 'exclusoes' | 'ajustes' | 'estornos'

export const MOTIVO_ESTORNO_PADRAO = 'Baixa lançada por engano'

export const ehExclusao = (a: Pick<AjusteEstornavel, 'motivo'>): boolean =>
  a.motivo.startsWith('Excluído do mapa')

export const ehEstorno = (a: Pick<AjusteEstornavel, 'estorno_de'>): boolean => !!a.estorno_de

/** Estornável = ainda não estornada e não é ela mesma um estorno. */
export const podeEstornar = (a: Pick<AjusteEstornavel, 'estornado_em' | 'estorno_de'>): boolean =>
  !a.estornado_em && !a.estorno_de

export function filtrarAjustes<T extends AjusteEstornavel>(ajustes: T[], tipo: TipoAjuste): T[] {
  switch (tipo) {
    case 'exclusoes':
      return ajustes.filter((a) => ehExclusao(a) && !ehEstorno(a))
    case 'ajustes':
      return ajustes.filter((a) => !ehExclusao(a) && !ehEstorno(a))
    case 'estornos':
      return ajustes.filter(ehEstorno)
    default:
      return ajustes
  }
}

const enderecoGalpao = (
  armazem: string | null | undefined,
  bloco: string | null | undefined,
  quadra: string | null | undefined,
): { armazem: string; bloco: string; quadra: string } | null => {
  const a = String(armazem ?? '').trim().toUpperCase()
  if (!(ARMAZENS_GALPAO as readonly string[]).includes(a)) return null
  const b = numeroEndereco(bloco, BLOCO_MAX)
  const q = numeroEndereco(quadra, QUADRA_MAX)
  return b && q ? { armazem: a, bloco: b, quadra: q } : null
}

/**
 * Pra onde o saldo volta: o endereço do próprio ajuste (A–E completo) vence;
 * senão o último contado no inventário; senão nenhum ("Sem localização").
 * Endereço incompleto (só a letra, como no rastro de "Armazém X esvaziado")
 * não conta — o banco também o ignoraria.
 */
export function enderecoSugerido(
  a: Pick<AjusteEstornavel, 'armazem' | 'bloco' | 'quadra'>,
  contado: EnderecoContado | null | undefined,
): SugestaoEndereco | null {
  const doAjuste = enderecoGalpao(a.armazem, a.bloco, a.quadra)
  if (doAjuste) return { ...doAjuste, origem: 'ajuste' }
  if (contado) {
    const doInventario = enderecoGalpao(contado.armazem, contado.bloco, contado.quadra)
    if (doInventario) return { ...doInventario, origem: 'inventario', em: contado.em }
  }
  return null
}

/** "B 22 Q03" — sem a origem (a tela põe "(inventário dd/mm)" do lado). */
export const rotuloSugestao = (s: SugestaoEndereco | null): string =>
  s ? rotuloEndereco(s) : 'sem endereço — vai pra Sem localização'

/**
 * Intervalo [de, ate) de um dia local ('AAAA-MM-DD') em ISO — a tela filtra
 * `criado_em` por ele. Local = o fuso do navegador (América/São Paulo no
 * galpão); `new Date(y, m, d)` nunca passa por UTC.
 */
export function intervaloDoDiaLocal(dia: string): { de: string; ate: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dia)
  if (!m) return null
  const de = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (Number.isNaN(de.getTime())) return null
  const ate = new Date(de.getFullYear(), de.getMonth(), de.getDate() + 1)
  return { de: de.toISOString(), ate: ate.toISOString() }
}

/** Soma dos bags que voltam ao mapa num lote de estornos (−Σ delta). */
export const bagsDeVolta = (ajustes: Pick<AjusteEstornavel, 'delta'>[]): number =>
  Math.round(ajustes.reduce((s, a) => s - a.delta, 0) * 100) / 100
