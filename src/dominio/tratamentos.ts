/**
 * Famílias de tratamento (19/09/2026, pedido do Arion: "seria legal criar uma
 * classificação de TSI por família: V&P e suas derivações, onde V&P é a
 * base; Dermacor; Standak; FTZ60; FTZ Elite"). O nome da receita é o código
 * do comercial ("FTZ60 + VIC + Lli"): a família é o produto-base do começo do
 * nome, e as derivações são a base mais produtos. Dentro da família, quem tem
 * MENOS itens na receita vem antes — a base primeiro, depois as derivações
 * ("o FTZ60 + RCoMoNi + Lli tem mais itens que o FTZ60, então deveria vir
 * depois"). Puro: só nomes e contagens.
 */
import { porNome } from './ordenacao'

/** As famílias conhecidas, pelo começo do nome normalizado (sem espaço, acento ou caixa). */
export const FAMILIAS_TSI: { familia: string; prefixos: string[] }[] = [
  { familia: 'V&P', prefixos: ['V&P', 'VEP', 'V+P'] },
  { familia: 'Dermacor', prefixos: ['DERMACOR', 'DER'] },
  { familia: 'Standak', prefixos: ['STANDAK', 'STDK'] },
  { familia: 'FTZ Elite', prefixos: ['FTZELITE'] },
  { familia: 'FTZ60', prefixos: ['FTZ60'] },
]

const chave = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, '')

/**
 * Família de um tratamento pelo nome da receita. Fora das conhecidas, o
 * primeiro segmento antes do "+" é a própria família ("FTZ80 + RCoMoNi" →
 * "FTZ80"; "SEM TSI" → "SEM TSI") — nunca devolve vazio.
 */
export function familiaDoTratamento(nome: string): string {
  const k = chave(nome)
  for (const f of FAMILIAS_TSI) {
    if (f.prefixos.some((p) => k.startsWith(chave(p)))) return f.familia
  }
  const primeiro = nome.split('+')[0].trim()
  return primeiro || nome.trim()
}

export interface TratamentoOrdenavel {
  nome: string
  /** Nº de produtos da receita; sem contagem, ordena pelo nome. */
  itens?: number | null
}

/**
 * Família (pt-BR) → menos itens primeiro → nome. É a ordem "base antes das
 * derivações" que a otimização de sequência e a coluna Tratamento da lista
 * usam.
 */
export function compararTratamentos(a: TratamentoOrdenavel, b: TratamentoOrdenavel): number {
  const f = porNome(familiaDoTratamento(a.nome), familiaDoTratamento(b.nome))
  if (f !== 0) return f
  if (a.itens != null && b.itens != null && a.itens !== b.itens) return a.itens - b.itens
  return porNome(a.nome, b.nome)
}
