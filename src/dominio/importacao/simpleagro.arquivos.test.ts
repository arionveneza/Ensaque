/**
 * Validação contra os arquivos REAIS exportados da SimpleAgro.
 *
 * As planilhas contêm dados de cliente e ficam fora do git (.gitignore), então
 * este arquivo se ignora sozinho quando elas não estão presentes — em CI ou
 * em outra máquina o suite continua verde sem elas.
 *
 * Os números conferidos vêm de docs/dados-exemplo/README.md, carga de 28/07/2026.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import readXlsxFile from 'read-excel-file/node'
import { converterPedidos, converterSaldos, type Linha } from './simpleagro'

const dir = resolve(process.cwd(), 'docs/dados-exemplo')
const ARQ_PEDIDOS = resolve(dir, 'pedidos-simpleagro-2026-07-28.xlsx')
const ARQ_SALDOS = resolve(dir, 'saldos-simpleagro-2026-07-28.xlsx')

const temArquivos = existsSync(ARQ_PEDIDOS) && existsSync(ARQ_SALDOS)
const quando = temArquivos ? describe : describe.skip

/**
 * A versão node de read-excel-file devolve `[{ sheet, data }]` quando o
 * arquivo tem abas nomeadas, e as linhas direto no caso simples. Normaliza.
 */
const ler = async (caminho: string): Promise<Linha[]> => {
  const bruto = (await readXlsxFile(caminho)) as unknown
  const arr = bruto as { sheet?: string; data?: Linha[] }[]
  if (arr.length > 0 && !Array.isArray(arr[0]) && Array.isArray(arr[0]?.data)) {
    return arr[0].data as Linha[]
  }
  return bruto as Linha[]
}

quando('conversao contra os arquivos reais de 28/07/2026', () => {
  it('pedidos: 1.196 linhas resultam em 1.018 bags aprovados', async () => {
    const rows = await ler(ARQ_PEDIDOS)
    expect(rows.length - 1).toBe(1196)

    const r = converterPedidos(rows)
    expect(r.totalAprovado).toBe(1018)
    expect(r.totalPendente).toBe(4674)
    expect(r.linhas.length).toBe(247)
  })

  it('pedidos: 26 codigos distintos, 22 deles sem receita cadastrada', async () => {
    const rows = await ler(ARQ_PEDIDOS)
    // os nomes de receita do seed sao codigos comerciais REAIS: 4 deles
    // aparecem no arquivo, sobrando 22 codigos sem receita — o numero de
    // referencia. Isso confirma a "lingua unica" entre comercial e producao.
    const r = converterPedidos(rows, [
      'FTZ60', 'V&P', 'CORTEVA ESPECIAL', 'DER + LMT',
      'FTZ60 + EKM', 'CORTEVA COMPLETO', 'FTZ ELITE',
    ])
    expect(new Set(r.linhas.map((l) => l.tratamento)).size).toBe(26)
    expect(Object.keys(r.resumo.semReceita).length).toBe(22)
  })

  it('pedidos: aprovacao financeira nao filtra, so define quem conta', async () => {
    const rows = await ler(ARQ_PEDIDOS)
    const r = converterPedidos(rows)
    // os dois status financeiros do arquivo, ambos importados
    expect(r.resumo.porStatusFinanceiro).toEqual({
      Aprovado: 1018,
      'Não Aprovado': 4674,
    })
  })

  it('pedidos: 213 bags de TSI real ficam fora por Status Pedido', async () => {
    const rows = await ler(ARQ_PEDIDOS)
    const r = converterPedidos(rows)
    // 329 linhas descartadas no total, mas só 28 eram trabalho de verdade —
    // o resto é cancelado de SEM TSI ou saldo zerado
    expect(r.resumo.foraStatus).toBe(329)
    expect(r.resumo.porStatusFora).toEqual({
      'Aguardando Aprovação': { linhas: 16, bags: 119 },
      'Em cotação': { linhas: 5, bags: 26 },
      Cancelado: { linhas: 4, bags: 30 },
      Reprovado: { linhas: 3, bags: 38 },
    })
  })

  it('saldos: 844 linhas resultam em 753 lotes e 16.865 bags', async () => {
    const rows = await ler(ARQ_SALDOS)
    expect(rows.length - 1).toBe(844)

    const r = converterSaldos(rows)
    expect(r.lotes.length).toBe(753)
    expect(r.totalBagsLotes).toBe(16865)
  })

  it('saldos: nenhum estoque de produto acabado tratado', async () => {
    const rows = await ler(ARQ_SALDOS)
    const r = converterSaldos(rows)
    expect(r.estoquePa.length).toBe(0)
  })

  it('saldos: 22 linhas de pre-lote e 4 saldos negativos', async () => {
    const rows = await ler(ARQ_SALDOS)
    const r = converterSaldos(rows)
    expect(r.resumo.granel).toBe(22)
    expect(r.resumo.negativos.length).toBe(4)
    expect(r.resumo.negativos.reduce((a, n) => a + n.bags, 0)).toBe(-27)
  })
})
