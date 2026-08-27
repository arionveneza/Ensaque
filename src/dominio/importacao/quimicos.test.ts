import { describe, expect, it } from 'vitest'
import { converterQuimicos, ehRelatorioQuimicos } from './quimicos'
import type { Linha } from './simpleagro'

// espelho do export real (Quimicos.xlsx, 27/08/2026): uma linha por lote
const CAB: Linha = [
  'Nº do item', 'Nº do Lote', 'Descrição do Item', 'Embalagem', 'Data de Entrada',
  'Data de Criação (sistema)', 'Validade', 'Dias p/ Vencer', 'Cód. Armazém',
  'Armazém', 'Qtd em Estoque', 'Situação',
]
const linha = (
  codigo: string, lote: string | number, nome: string, unidade: string,
  armazem: string, qtd: number,
): Linha => [
  codigo, lote, nome, unidade, new Date('2026-08-10'), new Date('2026-08-10'),
  new Date('2028-03-09'), 560, armazem, 'SEMENTES VENEZA - ESTOQUE', qtd, 'COM SALDO',
]

describe('ehRelatorioQuimicos', () => {
  it('reconhece o cabeçalho do export do SAP', () => {
    expect(ehRelatorioQuimicos([CAB])).toBe(true)
  })

  it('não confunde com outros relatórios', () => {
    expect(ehRelatorioQuimicos([['Cultivar', 'Lote', 'Saldo']])).toBe(false)
    expect(ehRelatorioQuimicos([])).toBe(false)
  })
})

describe('converterQuimicos', () => {
  it('agrega por item, somando os lotes do VEN_GER', () => {
    const r = converterQuimicos([
      CAB,
      linha('INS00003', 52608000, 'MAXIM QUATTRO', 'LT', 'VEN_GER', 644.01),
      linha('INS00003', 62608100, 'MAXIM QUATTRO', 'LT', 'VEN_GER', 160),
      linha('INS00039', 'L1', 'FLUIDUS F047 PO SECANTE', 'KG', 'VEN_GER', 21307.26),
    ])
    expect(r.itens).toEqual([
      { codigo_sap: 'INS00039', nome: 'FLUIDUS F047 PO SECANTE', unidade: 'KG', quantidade: 21307.26, lotes: 1 },
      { codigo_sap: 'INS00003', nome: 'MAXIM QUATTRO', unidade: 'LT', quantidade: 804.01, lotes: 2 },
    ])
    expect(r.linhasLidas).toBe(3)
    expect(r.linhasOutrosArmazens).toBe(0)
  })

  it('ignora e conta os outros armazéns — só VEN_GER entra (decisão do Arion, 27/08/2026)', () => {
    const r = converterQuimicos([
      CAB,
      linha('INS00003', 1, 'MAXIM QUATTRO', 'LT', 'VEN_GER', 100),
      linha('INS00003', 2, 'MAXIM QUATTRO', 'LT', 'VRV_GER', 999),
      linha('INS00003', 3, 'MAXIM QUATTRO', 'LT', 'ALM01', 50),
    ])
    expect(r.itens).toEqual([
      { codigo_sap: 'INS00003', nome: 'MAXIM QUATTRO', unidade: 'LT', quantidade: 100, lotes: 1 },
    ])
    expect(r.linhasOutrosArmazens).toBe(2)
  })

  it('item zerado do VEN_GER entra com quantidade 0 (é informação real)', () => {
    const r = converterQuimicos([CAB, linha('INS00053', 1, 'ILEVO', 'LT', 'VEN_GER', 0)])
    expect(r.itens[0]).toEqual({ codigo_sap: 'INS00053', nome: 'ILEVO', unidade: 'LT', quantidade: 0, lotes: 1 })
  })

  it('recusa planilha sem as colunas do export', () => {
    expect(() => converterQuimicos([['Cultivar', 'Lote']])).toThrow(/Não achei as colunas/)
  })
})
