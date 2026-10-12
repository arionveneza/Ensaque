/**
 * Lote em SACO tratado em kg (12/10/2026, pedido do Arion: "eu cadastro o
 * lote em sacaria de 200k com peso de 38,8 kg, quero tratar isso e jogar em
 * BAG ou mostrar quantos kgs tratar, pra gerar a receita certa"; decisão
 * dele: tratar TUDO, em kg).
 *
 * `ordens.bags` é inteiro, e 35 sacos de 200 mil sementes são 7 milhões =
 * 1,4 BAG — a ordem de 2 BAGs mandava receita para 1.910 kg com 1.337 kg de
 * semente (DM1210, 12/10). Com lote em saco a ordem guarda os kg de semente a
 * tratar (`ordens.peso_semente_kg` = sacos × peso do saco) e todo cálculo de
 * peso (receita, ficha, tempo, ocupação, baixa do lote) usa esses kg; `bags`
 * vira só a quantidade de embalagens que saem (cheias + a parcial). Puro.
 */

/** Fator do lote = peso do bag ÷ PMS (5 = bag 5 mi, 2,5 = meio bag, 0,2 = saco 200 mil). */
export const fatorDoLote = (l: { pms: number | null; peso_bag_kg: number }): number | null =>
  l.pms && l.pms > 0 && l.peso_bag_kg > 0 ? l.peso_bag_kg / l.pms : null

/**
 * Lote em saco: a unidade do lote tem menos de 1 milhão de sementes (fator
 * < 1, ex.: SC200MS = 0,2). Sem PMS, o peso do bag abaixo de 100 kg diz o
 * mesmo — nenhum bag de semente pesa isso.
 */
export function loteEmSaco(l: { pms: number | null; peso_bag_kg: number }): boolean {
  const f = fatorDoLote(l)
  return f != null ? f < 1 : l.peso_bag_kg > 0 && l.peso_bag_kg < 100
}

export interface ContaSacos {
  /** kg de semente a tratar = sacos × peso do saco. */
  kg: number
  /** Quantos bags DA ORDEM essa semente enche (pode ser fracionado: 1,4). */
  bagsEquivalentes: number
  /** Embalagens que saem: as cheias + a parcial, se houver. */
  embalagens: number
  cheias: number
  /** kg da embalagem parcial (0 quando fecha certinho). */
  parcialKg: number
}

/** Tolerância pra 75 sacos × 28,04 kg = 3 bags de 701 kg não virar "3 cheias + 0,0001 kg". */
const FOLGA = 0.005

export function contaSacos(sacos: number, pesoSacoKg: number, pesoBagOrdemKg: number): ContaSacos | null {
  if (!(sacos > 0) || !(pesoSacoKg > 0) || !(pesoBagOrdemKg > 0)) return null
  const kg = Math.round(sacos * pesoSacoKg * 1000) / 1000
  const bagsEquivalentes = kg / pesoBagOrdemKg
  const cheias = Math.floor(bagsEquivalentes + FOLGA)
  const sobra = bagsEquivalentes - cheias
  const temParcial = sobra > FOLGA
  return {
    kg,
    bagsEquivalentes,
    cheias,
    embalagens: cheias + (temParcial ? 1 : 0),
    parcialKg: temParcial ? Math.round(sobra * pesoBagOrdemKg * 10) / 10 : 0,
  }
}

/** kg de semente da ordem: os kg a tratar quando informados, senão bags × peso do bag da ordem. */
export const pesoSementeDaOrdemKg = (bags: number, pesoBagOrdemKg: number, pesoSementeKg?: number | null) =>
  pesoSementeKg != null && pesoSementeKg > 0 ? pesoSementeKg : bags * pesoBagOrdemKg
