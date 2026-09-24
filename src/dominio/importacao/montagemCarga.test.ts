import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import readXlsxFile from 'read-excel-file/node'
import {
  converterMontagemVsLotes, ehRelatorioMontagemVsLotes, pareceMontagemVsLotes, statusJaFaturado,
  type ItemACarregar,
} from './montagemCarga'
import type { Linha } from './simpleagro'

// cabeçalho do export atual (set/2026), na ordem real das colunas
const CAB = [
  'Carga', 'Filial', 'Status Carga', 'Data Carga', 'Frete', 'Pedido', 'Pedido ERP', 'Cliente',
  'Propriedade', 'Cliente 2', 'Vendedor', 'Transportadora', 'Motorista', 'CPF Motorista',
  'Telefone Motorista', 'Placa Caminhão', 'Produto', 'Categoria', 'Tratamento', 'Embalagem',
  'Qtd Agendada', 'Lote', 'Quantidade Lote', 'Armazém', 'Endereço', 'Peneira', 'Germinação',
  'PME', 'Nota Fiscal', 'Capacidade Caminhão (KG)', 'Total Peso (KG)', 'Ordem Entrega',
  'Roteiro Entrega',
]

type Campos = Partial<Record<(typeof CAB)[number], Linha[number]>>

const BASE: Campos = {
  Carga: 894,
  'Status Carga': 'Agendado',
  'Data Carga': new Date('2026-09-22T11:59:31.999Z'),
  Pedido: 5001,
  Produto: 'O790 IPRO',
  Categoria: 'S1',
  Tratamento: 'FTZ60',
  Embalagem: 'BB5M',
  'Qtd Agendada': 35,
  Lote: '',
  'Quantidade Lote': null,
}

const linha = (c: Campos = {}): Linha => {
  const m = { ...BASE, ...c }
  return CAB.map((k) => m[k] ?? null)
}
const conv = (...linhas: Linha[]) => converterMontagemVsLotes([CAB, ...linhas])
const total = (itens: ItemACarregar[]) => itens.reduce((a, i) => a + i.bags, 0)

describe('montagem carga vs lotes — detecção', () => {
  it('reconhece o cabeçalho do export atual', () => {
    expect(ehRelatorioMontagemVsLotes([CAB])).toBe(true)
  })
  it('aceita acento, caixa e espaço diferentes', () => {
    expect(ehRelatorioMontagemVsLotes([CAB.map((c) => ` ${c.toUpperCase()} `)])).toBe(true)
  })
  it('não confunde com o relatório de pedidos agendados (sem Lote/Quantidade Lote)', () => {
    const agendados = ['IDENTIFICADOR', 'NUMERO', 'TIPO VENDA', 'CARGA', 'STATUS CARGA',
      'DATA AGENDADA', 'PRODUTO', 'TRATAMENTO', 'EMBALAGEM', 'QTD AGENDADA']
    expect(ehRelatorioMontagemVsLotes([agendados])).toBe(false)
  })
  it('recusa planilha sem as colunas de lote', () => {
    expect(ehRelatorioMontagemVsLotes([CAB.filter((c) => c !== 'Quantidade Lote')])).toBe(false)
    expect(() => converterMontagemVsLotes([CAB.filter((c) => c !== 'Lote')])).toThrow(/LOTE/)
  })
  it('acha as colunas pelo nome em qualquer ordem', () => {
    const inv = [...CAB].reverse()
    const l = [...linha({ Lote: 'A', 'Quantidade Lote': 35 })].reverse()
    const { itens } = converterMontagemVsLotes([inv, l])
    expect(itens).toHaveLength(1)
    expect(itens[0].bags).toBe(35)
  })
})

describe('montagem carga vs lotes — um item por agendamento', () => {
  it('3 lotes do mesmo item repetem a Qtd Agendada: conta 35, não 105 (exemplo do Arion)', () => {
    const { itens, resumo } = conv(
      linha({ Lote: 'SV1', 'Quantidade Lote': 21 }),
      linha({ Lote: 'SV2', 'Quantidade Lote': 10 }),
      linha({ Lote: 'SV3', 'Quantidade Lote': 4 }),
    )
    expect(itens).toHaveLength(1)
    expect(itens[0]).toMatchObject({ bags: 35, bagsLoteados: 35, lotes: 3 })
    expect(resumo.linhasDeLoteRepetidas).toBe(2)
  })

  it('loteamento pela metade (35 agendados, lote de 5) conta 35, não 5', () => {
    const { itens, resumo } = conv(linha({ Lote: 'SV1', 'Quantidade Lote': 5 }))
    expect(total(itens)).toBe(35)
    expect(itens[0].bagsLoteados).toBe(5)
    expect(resumo.loteParcial).toBe(1)
  })

  it('dois lotes parciais do mesmo item continuam contando o agendado uma vez', () => {
    const { itens } = conv(
      linha({ Lote: 'SV1', 'Quantidade Lote': 5 }),
      linha({ Lote: 'SV2', 'Quantidade Lote': 7 }),
    )
    expect(itens).toHaveLength(1)
    expect(total(itens)).toBe(35)
  })

  it('lote em branco usa a Qtd Agendada', () => {
    const { itens } = conv(linha({ Lote: '', 'Quantidade Lote': null }))
    expect(itens).toEqual([expect.objectContaining({ bags: 35, lotes: 0, bagsLoteados: 0 })])
  })

  it('vários itens do mesmo produto na mesma carga com quantidades diferentes (2, 10, 23)', () => {
    const { itens } = conv(
      linha({ 'Qtd Agendada': 2, Lote: 'A', 'Quantidade Lote': 2 }),
      linha({ 'Qtd Agendada': 10, Lote: 'B', 'Quantidade Lote': 10 }),
      linha({ 'Qtd Agendada': 23, Lote: 'C', 'Quantidade Lote': 15 }),
      linha({ 'Qtd Agendada': 23, Lote: 'D', 'Quantidade Lote': 8 }),
    )
    expect(itens.map((i) => i.bags)).toEqual([2, 10, 23])
    expect(total(itens)).toBe(35)
  })

  it('dois itens IGUAIS sem lote são dois itens (1 + 1 = 2)', () => {
    const { itens, resumo } = conv(
      linha({ 'Qtd Agendada': 1 }),
      linha({ 'Qtd Agendada': 1 }),
    )
    expect(total(itens)).toBe(2)
    expect(resumo.itensRepetidos).toBe(1)
  })

  it('dois itens iguais já loteados: o lote que passaria do agendado abre item novo (10+10 → 20)', () => {
    const { itens } = conv(
      linha({ 'Qtd Agendada': 10, Lote: 'A', 'Quantidade Lote': 10 }),
      linha({ 'Qtd Agendada': 10, Lote: 'B', 'Quantidade Lote': 10 }),
    )
    expect(itens).toHaveLength(2)
    expect(total(itens)).toBe(20)
  })

  it('o mesmo lote em dois endereços do mesmo item não duplica', () => {
    const { itens } = conv(
      linha({ Lote: 'SV1', 'Quantidade Lote': 20, 'Endereço': 'A-01' }),
      linha({ Lote: 'SV1', 'Quantidade Lote': 15, 'Endereço': 'B-03' }),
    )
    expect(itens).toHaveLength(1)
    expect(itens[0].bags).toBe(35)
  })

  it('sobre-loteamento de uma linha (lote 27 para 23 agendados) conta o agendado', () => {
    const { itens, resumo } = conv(linha({ 'Qtd Agendada': 23, Lote: 'A', 'Quantidade Lote': 27 }))
    expect(total(itens)).toBe(23)
    expect(resumo.sobreLoteado).toBe(1)
  })

  it('lotes do mesmo item separados por outra carga no meio continuam UM item (carga 755 do export de 01/09)', () => {
    const l755 = { Carga: 755, Pedido: 26130043, Produto: 'O720 I2X', Tratamento: 'SEM TSI', 'Qtd Agendada': 45 }
    const l753 = { Carga: 753, Pedido: 26130040, Produto: 'NEO780 CE', 'Qtd Agendada': 37 }
    const { itens, resumo } = conv(
      linha({ ...l755, Lote: 'SV0271046060613', 'Quantidade Lote': 9 }),
      linha({ ...l753, Lote: 'A', 'Quantidade Lote': 10 }),
      linha({ ...l753, Lote: 'B', 'Quantidade Lote': 27 }),
      linha({ ...l755, Lote: 'SV0271046060604', 'Quantidade Lote': 27 }),
      linha({ ...l755, Lote: 'SV0271046060626', 'Quantidade Lote': 9 }),
    )
    expect(itens.map((i) => [i.carga, i.bags, i.lotes])).toEqual([['755', 45, 3], ['753', 37, 2]])
    expect(total(itens)).toBe(82)
    expect(resumo.linhasDeLoteRepetidas).toBe(3)
  })

  it('linhas em branco ou de anotação (sem carga e sem produto) são ignoradas e contadas', () => {
    const { itens, resumo } = conv(
      linha(),
      CAB.map(() => null),
      linha({ Carga: null, Produto: null, Lote: 'SV1261045760090', 'Quantidade Lote': 11, 'Qtd Agendada': null }),
    )
    expect(itens).toHaveLength(1)
    expect(resumo.linhasIgnoradas).toBe(2)
    expect(resumo.linhasOrfasComLote).toBe(1)
    expect(resumo.itens + resumo.linhasDeLoteRepetidas + resumo.semQuantidade + resumo.linhasIgnoradas)
      .toBe(resumo.totalLinhas)
  })

  it('cabeçalho com Lote/Quantidade Lote repetidos (cópia editada à mão) é recusado', () => {
    const cab = [...CAB, 'Lote', 'Quantidade Lote']
    expect(pareceMontagemVsLotes([cab])).toBe(true)
    expect(() => converterMontagemVsLotes([cab, [...linha(), 'X', 5]])).toThrow(/repetida/)
  })

  it('"parece" montagem com coluna faltando: o conversor diz qual falta', () => {
    const cab = CAB.filter((c) => c !== 'Data Carga' && c !== 'Status Carga')
    expect(ehRelatorioMontagemVsLotes([cab])).toBe(false)
    expect(pareceMontagemVsLotes([cab])).toBe(true)
    expect(() => converterMontagemVsLotes([cab])).toThrow(/STATUS CARGA, DATA CARGA/)
  })

  it('linha sem lote depois de linhas com lote do mesmo item é item novo', () => {
    const { itens } = conv(
      linha({ 'Qtd Agendada': 10, Lote: 'A', 'Quantidade Lote': 4 }),
      linha({ 'Qtd Agendada': 10, Lote: '' }),
    )
    expect(itens).toHaveLength(2)
  })

  it('mudar carga, pedido, produto, tratamento ou embalagem sempre abre item novo', () => {
    const l = { Lote: 'A', 'Quantidade Lote': 10, 'Qtd Agendada': 35 }
    const { itens } = conv(
      linha(l),
      linha({ ...l, Carga: 895 }),
      linha({ ...l, Carga: 895, Pedido: 5002 }),
      linha({ ...l, Carga: 895, Pedido: 5002, Produto: '761 I2X' }),
      linha({ ...l, Carga: 895, Pedido: 5002, Produto: '761 I2X', Tratamento: 'V&P' }),
      linha({ ...l, Carga: 895, Pedido: 5002, Produto: '761 I2X', Tratamento: 'V&P', Embalagem: 'BMB' }),
    )
    expect(itens).toHaveLength(6)
  })

  it('linha sem Qtd Agendada é ignorada e contada', () => {
    const { itens, resumo } = conv(linha({ 'Qtd Agendada': 0 }), linha({ 'Qtd Agendada': null }))
    expect(itens).toHaveLength(0)
    expect(resumo.semQuantidade).toBe(2)
  })
})

describe('montagem carga vs lotes — status', () => {
  it('Faturado Fiscal, Faturado Transporte e Finalizado ficam fora (a nota já saiu)', () => {
    const { itens, resumo } = conv(
      linha({ Carga: 1, 'Status Carga': 'Faturado Fiscal', Lote: 'A', 'Quantidade Lote': 20 }),
      linha({ Carga: 1, 'Status Carga': 'Faturado Fiscal', Lote: 'B', 'Quantidade Lote': 15 }),
      linha({ Carga: 2, 'Status Carga': 'FATURADO TRANSPORTE' }),
      linha({ Carga: 3, 'Status Carga': 'Finalizado' }),
      linha({ Carga: 4, 'Status Carga': 'Carregado' }),
    )
    expect(itens.map((i) => i.carga)).toEqual(['4'])
    expect(resumo.jaFaturados).toMatchObject({ itens: 3, bags: 105 })
    expect(resumo.bagsACarregar).toBe(35)
  })

  it('Faturado Qualidade continua a carregar (vem antes do Faturado Fiscal)', () => {
    expect(statusJaFaturado('Faturado Qualidade')).toBe(false)
    const { itens } = conv(linha({ 'Status Carga': 'Faturado Qualidade' }))
    expect(itens).toHaveLength(1)
  })

  it('reconhece o status sem acento/caixa/espaço extra', () => {
    expect(statusJaFaturado('  faturado   fiscal ')).toBe(true)
    expect(statusJaFaturado('Finalizado')).toBe(true)
    expect(statusJaFaturado('Em carga')).toBe(false)
  })

  it('status vazio entra como "Sem status"', () => {
    const { itens, resumo } = conv(linha({ 'Status Carga': '' }))
    expect(itens[0].status).toBe('Sem status')
    expect(resumo.porStatus['Sem status']).toEqual({ itens: 1, bags: 35 })
  })
})

describe('montagem carga vs lotes — campos', () => {
  it('data da carga pelo dia UTC; texto dd/mm/aaaa; vazia = null', () => {
    const { itens, resumo } = conv(
      linha({ Carga: 1, 'Data Carga': new Date('2026-09-22T23:59:59.000Z') }),
      linha({ Carga: 2, 'Data Carga': '25/09/2026' }),
      linha({ Carga: 3, 'Data Carga': null }),
    )
    expect(itens.map((i) => i.dataCarga)).toEqual(['2026-09-22', '2026-09-25', null])
    expect(resumo.semData).toBe(1)
  })

  it('embalagem pelo de-para; sem de-para entra crua e é reportada', () => {
    const { itens, resumo } = conv(
      linha({ Carga: 1, Embalagem: 'BMB' }),
      linha({ Carga: 2, Embalagem: 'BIGBAG' }),
    )
    expect(itens.map((i) => [i.embalagem, i.embalagemConhecida])).toEqual([
      ['MEIOBAG', true], ['BIGBAG', false],
    ])
    expect(resumo.embalagemDesconhecida).toEqual({ BIGBAG: 35 })
  })

  it('produto duplicado "X - X" fica com o trecho antes do " - "', () => {
    const { itens } = conv(linha({ Produto: '761 I2X - 761 I2X' }))
    expect(itens[0].cultivar).toBe('761 I2X')
  })

  it('SEM TSI entra (a tela decide) e é contado à parte', () => {
    const { itens, resumo } = conv(linha({ Tratamento: 'SEM TSI' }))
    expect(itens).toHaveLength(1)
    expect(resumo.semTsi).toEqual({ itens: 1, bags: 35 })
  })

  it('não carrega dado pessoal (cliente, motorista, CPF, placa)', () => {
    const { itens } = conv(linha({ Cliente: 'FULANO', Motorista: 'CICRANO', 'CPF Motorista': '123' }))
    expect(JSON.stringify(itens)).not.toMatch(/FULANO|CICRANO/)
  })
})

// Conferência contra o arquivo real (fica fora do git — docs/dados-exemplo)
const REAL = 'docs/dados-exemplo/montagem-carga-vs-lotes-2026-09-24.xlsx'
describe.skipIf(!existsSync(REAL))('montagem carga vs lotes — arquivo real de 24/09/2026', () => {
  it('um item por agendamento, sem somar a Qtd Agendada de cada lote', async () => {
    const bruto = (await readXlsxFile(REAL)) as unknown
    const arr = bruto as { data?: Linha[] }[]
    const rows = !Array.isArray(arr[0]) && Array.isArray(arr[0]?.data) ? (arr[0].data as Linha[]) : (bruto as Linha[])
    expect(ehRelatorioMontagemVsLotes(rows)).toBe(true)
    const { itens, resumo } = converterMontagemVsLotes(rows)
    // toda linha vira item OU lote repetido de um item, OU foi descartada (sem quantidade / em branco)
    expect(resumo.itens + resumo.linhasDeLoteRepetidas + resumo.semQuantidade + resumo.linhasIgnoradas)
      .toBe(resumo.totalLinhas)
    // nenhum item conta mais que a própria Qtd Agendada
    expect(itens.every((i) => i.bags > 0)).toBe(true)
    expect(resumo.itensACarregar).toBe(itens.length)
    expect(itens.some((i) => statusJaFaturado(i.status))).toBe(false)
    // números conferidos à mão (docs/dados-exemplo/README.md): a soma ingênua da coluna dava 1.023
    expect(resumo.totalLinhas).toBe(83)
    expect(resumo.itens).toBe(73)
    expect(resumo.bagsACarregar).toBe(707)
    expect(resumo.semTsi.bags).toBe(342)
    // carga 894 (linhas 2-4 da planilha, exemplo do Arion): 35, não 105
    expect(total(itens.filter((i) => i.carga === '894'))).toBe(35)
  })
})
