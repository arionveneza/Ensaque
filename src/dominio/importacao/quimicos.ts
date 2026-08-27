/**
 * Importador do relatório de estoque de químicos do SAP (Quimicos.xlsx).
 *
 * Uma linha por LOTE de insumo, com colunas achadas pelo NOME (a posição
 * varia por export): Nº do item · Descrição do Item · Embalagem (unidade:
 * LT/KG/DOSES/...) · Cód. Armazém · Qtd em Estoque.
 *
 * Só o armazém VEN_GER entra (decisão do Arion, 27/08/2026): é o estoque da
 * UBS; os outros depósitos (filiais, envio direto, terceiros) não abastecem
 * o tratamento. Agrega por item (código + nome + unidade) somando os lotes.
 *
 * O CÓDIGO do item no SAP NÃO bate com o cadastrado no app em vários
 * produtos (ex.: INS00004 é RIZOLIQ LLI no SAP e KELMAX no app) — o
 * casamento com a necessidade é por NOME, em `cruzarEstoqueQuimico`
 * (dominio/mrp.ts). Aqui o código é só informativo.
 */

import type { Linha } from './simpleagro'

export const ARMAZEM_QUIMICOS = 'VEN_GER'

export interface EstoqueQuimicoConvertido {
  codigo_sap: string
  nome: string
  unidade: string
  quantidade: number
  lotes: number
}

export interface ResultadoQuimicos {
  itens: EstoqueQuimicoConvertido[]
  /** Linhas de dados lidas (sem contar cabeçalho). */
  linhasLidas: number
  /** Linhas de outros armazéns, ignoradas de propósito. */
  linhasOutrosArmazens: number
}

const texto = (v: unknown): string => String(v ?? '').trim()
const norm = (v: unknown): string =>
  texto(v)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()

/** Índice de cada coluna, achado pelo nome no cabeçalho. */
function acharColunas(cabecalho: Linha) {
  const idx = (pred: (c: string) => boolean) => cabecalho.findIndex((c) => pred(norm(c)))
  return {
    codigo: idx((c) => c.includes('item') && c.includes('n')),        // "Nº do item"
    nome: idx((c) => c.includes('descricao')),                        // "Descrição do Item"
    unidade: idx((c) => c === 'embalagem'),                           // "Embalagem"
    armazem: idx((c) => c.includes('armaz') && c.includes('cod')),    // "Cód. Armazém"
    quantidade: idx((c) => c.includes('qtd') && c.includes('estoque')), // "Qtd em Estoque"
  }
}

export function ehRelatorioQuimicos(linhas: Linha[]): boolean {
  const cab = linhas[0]
  if (!cab) return false
  const c = acharColunas(cab)
  return c.codigo >= 0 && c.nome >= 0 && c.armazem >= 0 && c.quantidade >= 0
}

export function converterQuimicos(linhas: Linha[]): ResultadoQuimicos {
  const cab = linhas[0]
  if (!cab) throw new Error('Planilha vazia.')
  const col = acharColunas(cab)
  if (col.codigo < 0 || col.nome < 0 || col.armazem < 0 || col.quantidade < 0) {
    throw new Error(
      'Não achei as colunas "Nº do item", "Descrição do Item", "Cód. Armazém" e "Qtd em Estoque" — é o export de químicos do SAP?',
    )
  }

  const itens = new Map<string, EstoqueQuimicoConvertido>()
  let linhasLidas = 0
  let linhasOutrosArmazens = 0

  for (const r of linhas.slice(1)) {
    const codigo = texto(r[col.codigo])
    if (!codigo) continue
    linhasLidas += 1
    if (texto(r[col.armazem]).toUpperCase() !== ARMAZEM_QUIMICOS) {
      linhasOutrosArmazens += 1
      continue
    }
    const nome = texto(r[col.nome])
    const unidade = texto(col.unidade >= 0 ? r[col.unidade] : '').toUpperCase()
    const quantidade = Number(r[col.quantidade]) || 0

    const chave = `${codigo}|${nome}|${unidade}`
    const acc = itens.get(chave) ?? { codigo_sap: codigo, nome, unidade, quantidade: 0, lotes: 0 }
    acc.quantidade += quantidade
    acc.lotes += 1
    itens.set(chave, acc)
  }

  const lista = [...itens.values()]
    .map((i) => ({ ...i, quantidade: Math.round(i.quantidade * 100) / 100 }))
    .sort((a, b) => b.quantidade - a.quantidade)

  return { itens: lista, linhasLidas, linhasOutrosArmazens }
}
