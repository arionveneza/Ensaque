import { describe, expect, it } from 'vitest'
import {
  converterPedidos,
  converterSaldos,
  ehRelatorioPedidos,
  ehRelatorioSaldos,
  type Linha,
} from './simpleagro'

// ---------------------------------------------------------------
// Pedidos Analítico Resumido
// ---------------------------------------------------------------

const CAB_PEDIDOS = [
  'Status Pedido', 'Status Financeiro', 'Produto', 'Tratamento',
  'Embalagem', 'Saldo a Faturar',
]

const pedido = (
  status: string, fin: string, produto: string,
  trat: string, emb: string, saldo: number | string,
): Linha => [status, fin, produto, trat, emb, saldo]

describe('deteccao do relatorio de pedidos', () => {
  it('reconhece pelo cabecalho', () => {
    expect(ehRelatorioPedidos([CAB_PEDIDOS])).toBe(true)
    expect(ehRelatorioPedidos([['Outra', 'Coisa']])).toBe(false)
  })
})

describe('conversao de pedidos', () => {
  it('mantem apenas pedidos Integrados', () => {
    const r = converterPedidos([
      CAB_PEDIDOS,
      pedido('Integrado', 'Aprovado', '761 I2X - 761 I2X', 'FTZ60', 'BB5M', 10),
      pedido('Em cotação', 'Aprovado', '761 I2X - 761 I2X', 'FTZ60', 'BB5M', 99),
      pedido('Cancelado', 'Aprovado', '761 I2X - 761 I2X', 'FTZ60', 'BB5M', 99),
    ])
    expect(r.totalAprovado).toBe(10)
    expect(r.resumo.foraStatus).toBe(2)
  })

  it('separa aprovado de aguardando aprovacao financeira', () => {
    const r = converterPedidos([
      CAB_PEDIDOS,
      pedido('Integrado', 'Aprovado', 'X - X', 'FTZ60', 'BB5M', 150),
      pedido('Integrado', 'Não Aprovado', 'X - X', 'FTZ60', 'BB5M', 35),
    ])
    expect(r.totalAprovado).toBe(150)
    expect(r.totalPendente).toBe(35)
    // sao combinacoes distintas: mesma chave, flags diferentes
    expect(r.linhas).toHaveLength(2)
  })

  it('exclui SEM TSI, que nao gera trabalho de tratamento', () => {
    const r = converterPedidos([
      CAB_PEDIDOS,
      pedido('Integrado', 'Aprovado', 'X - X', 'SEM TSI', 'BB5M', 500),
      pedido('Integrado', 'Aprovado', 'X - X', 'sem tsi', 'BB5M', 500),
      pedido('Integrado', 'Aprovado', 'X - X', '', 'BB5M', 500),
    ])
    expect(r.linhas).toHaveLength(0)
    expect(r.resumo.semTsi).toBe(3)
  })

  it('descarta saldo zerado ou negativo', () => {
    const r = converterPedidos([
      CAB_PEDIDOS,
      pedido('Integrado', 'Aprovado', 'X - X', 'FTZ60', 'BB5M', 0),
      pedido('Integrado', 'Aprovado', 'X - X', 'FTZ60', 'BB5M', -5),
    ])
    expect(r.linhas).toHaveLength(0)
    expect(r.resumo.saldoZero).toBe(2)
  })

  it('usa o trecho antes do hifen no Produto duplicado', () => {
    const r = converterPedidos([
      CAB_PEDIDOS,
      pedido('Integrado', 'Aprovado', '761 I2X - 761 I2X', 'FTZ60', 'BB5M', 10),
    ])
    expect(r.linhas[0].cultivar).toBe('761 I2X')
  })

  it('aplica o de-para de embalagem', () => {
    const r = converterPedidos([
      CAB_PEDIDOS,
      pedido('Integrado', 'Aprovado', 'X - X', 'FTZ60', 'BB5M', 10),
      pedido('Integrado', 'Aprovado', 'X - X', 'FTZ60', 'BMB', 20),
    ])
    expect(r.linhas.map((l) => l.embalagem).sort()).toEqual(['BG5M', 'MEIOBAG'])
  })

  it('reporta embalagem sem de-para em vez de somar errado', () => {
    const r = converterPedidos([
      CAB_PEDIDOS,
      pedido('Integrado', 'Aprovado', 'X - X', 'FTZ60', 'BIGBAG', 40),
    ])
    expect(r.linhas).toHaveLength(0)
    expect(r.resumo.embalagemDesconhecida).toEqual({ BIGBAG: 40 })
  })

  it('agrega a mesma combinacao somando os saldos', () => {
    const r = converterPedidos([
      CAB_PEDIDOS,
      pedido('Integrado', 'Aprovado', 'X - X', 'FTZ60', 'BB5M', 10),
      pedido('Integrado', 'Aprovado', 'X - X', 'FTZ60', 'BB5M', 25),
    ])
    expect(r.linhas).toHaveLength(1)
    expect(r.linhas[0].bags).toBe(35)
  })

  it('importa codigo sem receita cadastrada, mas o reporta', () => {
    const r = converterPedidos(
      [CAB_PEDIDOS, pedido('Integrado', 'Aprovado', 'X - X', 'DESCONHECIDO', 'BB5M', 40)],
      ['FTZ60', 'V&P'],
    )
    // a demanda existe: a linha entra
    expect(r.linhas).toHaveLength(1)
    expect(r.totalAprovado).toBe(40)
    // mas fica sinalizada
    expect(r.resumo.semReceita).toEqual({ DESCONHECIDO: 40 })
  })

  it('aceita saldo com virgula decimal', () => {
    const r = converterPedidos([
      CAB_PEDIDOS,
      pedido('Integrado', 'Aprovado', 'X - X', 'FTZ60', 'BB5M', '12,5'),
    ])
    expect(r.totalAprovado).toBe(12.5)
  })
})

// ---------------------------------------------------------------
// Saldos
// ---------------------------------------------------------------

const CAB_SALDOS = ['NOME PRODUTO', 'CULTIVAR', 'LOTE', 'LOTE TRATAMENTO', 'LOTE PME', 'SALDO']

const saldo = (
  nome: string, cult: string, lote: string,
  trat: string, pms: number | string, bags: number | string,
): Linha => [nome, cult, lote, trat, pms, bags]

describe('deteccao do relatorio de saldos', () => {
  it('reconhece pelo cabecalho', () => {
    expect(ehRelatorioSaldos([CAB_SALDOS])).toBe(true)
    expect(ehRelatorioSaldos([['A', 'B']])).toBe(false)
  })
})

describe('conversao de saldos', () => {
  it('SEM TSI vira lote de semente com peso PMS x fator', () => {
    const r = converterSaldos([
      CAB_SALDOS,
      saldo('SS NEO771 I2X BB5M', 'NEO771 I2X', 'SV001', 'SEM TSI', 171, 7),
    ])
    expect(r.lotes).toHaveLength(1)
    expect(r.lotes[0].pesoBagKg).toBe(855) // 171 x 5
    expect(r.lotes[0].bags).toBe(7)
    expect(r.estoquePa).toHaveLength(0)
  })

  it('meio bag usa fator 2,5', () => {
    const r = converterSaldos([
      CAB_SALDOS,
      saldo('SS NEO771 I2X BMB', 'NEO771 I2X', 'SV001', 'SEM TSI', 171, 4),
    ])
    expect(r.lotes[0].pesoBagKg).toBe(428) // 427,5 arredondado
  })

  it('guarda o tratamento que veio da origem', () => {
    const r = converterSaldos([
      CAB_SALDOS,
      saldo('SS X BB5M', 'X', 'SV001', 'SEM TSI', 171, 7),
    ])
    expect(r.lotes[0].tratamento).toBe('SEM TSI')
  })

  it('agrega o mesmo lote espalhado em varios enderecos', () => {
    const r = converterSaldos([
      CAB_SALDOS,
      saldo('SS X BB5M', 'X', 'SV001', 'SEM TSI', 171, 7),
      saldo('SS X BB5M', 'X', 'SV001', 'SEM TSI', 171, 14),
      saldo('SS X BB5M', 'X', 'SV002', 'SEM TSI', 171, 3),
    ])
    expect(r.lotes).toHaveLength(2)
    expect(r.lotes.find((l) => l.id === 'SV001')!.bags).toBe(21)
    expect(r.totalBagsLotes).toBe(24)
  })

  it('tratamento real vira estoque de produto acabado', () => {
    const r = converterSaldos([
      CAB_SALDOS,
      saldo('SS X BB5M', 'X', 'SV001', 'FTZ60', 171, 20),
    ])
    expect(r.lotes).toHaveLength(0)
    expect(r.estoquePa).toEqual([
      { cultivar: 'X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 20 },
    ])
  })

  it('pre-lote e granel sao ignorados: materia-prima em kg', () => {
    const r = converterSaldos([
      CAB_SALDOS,
      saldo('PRE-LOTE SOJA', 'X', 'SV001', 'SEM TSI', 171, 5000),
      saldo('SS X GRANEL', 'X', 'SV002', 'SEM TSI', 171, 3000),
    ])
    expect(r.lotes).toHaveLength(0)
    expect(r.resumo.granel).toBe(2)
  })

  it('saldo negativo e ignorado e reportado', () => {
    const r = converterSaldos([
      CAB_SALDOS,
      saldo('SS X BB5M', 'X', 'SV009', 'SEM TSI', 171, -7),
    ])
    expect(r.lotes).toHaveLength(0)
    expect(r.resumo.negativos).toEqual([{ lote: 'SV009', bags: -7 }])
  })

  it('lote sem PMS entra com peso zero mas e reportado', () => {
    const r = converterSaldos([
      CAB_SALDOS,
      saldo('SS X BB5M', 'X', 'SV001', 'SEM TSI', 0, 5),
    ])
    expect(r.lotes[0].pesoBagKg).toBe(0)
    expect(r.resumo.semPms).toBe(1)
  })

  it('o mesmo arquivo alimenta os dois destinos', () => {
    const r = converterSaldos([
      CAB_SALDOS,
      saldo('SS X BB5M', 'X', 'SV001', 'SEM TSI', 171, 10),
      saldo('SS X BB5M', 'X', 'SV002', 'FTZ60', 171, 20),
      saldo('PRE-LOTE X', 'X', 'SV003', 'SEM TSI', 171, 999),
    ])
    expect(r.totalBagsLotes).toBe(10)
    expect(r.totalBagsEstoque).toBe(20)
    expect(r.resumo.granel).toBe(1)
  })
})
