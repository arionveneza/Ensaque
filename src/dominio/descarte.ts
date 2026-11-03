/**
 * Descarte no mapa (03/11/2026, pedido do Arion: "preciso marcar alguns lotes
 * como descarte, no mapa, como podemos fazer?").
 *
 * A marca é a destinação 'DESCARTE' — a mesma que o inventário põe no lote
 * contado como descarte —, então tudo que já reage a destinação (vermelho no
 * detalhe, aviso forte no loteamento de carga, filtro "Destinação", estoque
 * vivo) vale sem mudar nada. A marcada à mão no mapa tem ainda `descarte_em`
 * (quem/quando/por quê) e o upload do SAP e o inventário não a tiram.
 */

export interface LoteDescartavel {
  lote: string
  tratamento: string
  cultivar: string
  bags: number
  destinacao: string | null
  descarte_em?: string | null
}

/** A destinação diz descarte (do mapa, do inventário ou o "Descarte" do SAP). */
export const ehDescarte = (destinacao: string | null | undefined): boolean =>
  String(destinacao ?? '').trim().toUpperCase() === 'DESCARTE'

/** Motivos de um toque — o campo continua livre. */
export const MOTIVOS_DESCARTE = [
  'Reprovado na qualidade',
  'Avariado (bag rasgado, molhado)',
  'Fora da validade / safra antiga',
]

export const MOTIVO_TIRAR_DESCARTE = 'Marcado como descarte por engano'

const norm = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()

const chave = (l: { lote: string; tratamento: string }) => `${l.lote}\u0000${l.tratamento}`

/**
 * Lotes que podem ser marcados: com saldo, ainda não descarte, que casam com a
 * busca (lote, cultivar ou tratamento, sem acento/caixa) e que não estão
 * escolhidos. Até `limite` (a lista do modal não vira parede).
 */
export function candidatosDescarte<T extends LoteDescartavel>(
  lotes: T[],
  busca: string,
  escolhidos: { lote: string; tratamento: string }[],
  limite = 20,
): T[] {
  const ja = new Set(escolhidos.map(chave))
  const q = norm(busca.trim())
  const out: T[] = []
  for (const l of lotes) {
    if (l.bags <= 0 || ehDescarte(l.destinacao) || ja.has(chave(l))) continue
    if (q && ![l.lote, l.cultivar, l.tratamento].some((v) => norm(v ?? '').includes(q))) continue
    out.push(l)
    if (out.length >= limite) break
  }
  return out
}

/** Quantos lotes/bags estão marcados como descarte (com saldo). */
export function resumoDescarte(lotes: LoteDescartavel[]): { lotes: number; bags: number; manuais: number } {
  let n = 0
  let bags = 0
  let manuais = 0
  for (const l of lotes) {
    if (l.bags <= 0 || !ehDescarte(l.destinacao)) continue
    n++
    bags += l.bags
    if (l.descarte_em) manuais++
  }
  return { lotes: n, bags: Math.round(bags * 100) / 100, manuais }
}
