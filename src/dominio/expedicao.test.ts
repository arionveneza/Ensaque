import { describe, expect, it } from 'vitest'
import {
  converterMontagemCarga,
  ehRelatorioMontagemCarga,
  saldosExpedicao,
  type CarregamentoLinha,
} from './expedicao'
import type { Linha as LinhaXlsx } from './importacao/simpleagro'

// cabeçalho real do relatório (as posições variam por export; os nomes não)
const CAB: LinhaXlsx = [
  'Carga', 'Filial', 'Status Carga', 'Data Carga', 'Nota Fiscal', 'Frete',
  'Pedido', 'Pedido ERP', 'Cliente', 'Propriedade', 'Cliente 2', 'Vendedor',
  'Transportadora', 'Motorista', 'CPF Motorista', 'Placa Caminhão',
  'Produto', 'Categoria', 'Peneira', 'Tratamento', 'Embalagem', 'Qtd Agendada',
]

type Celula = string | number | boolean | Date | null | undefined

const linha = (over: Partial<Record<string, Celula>> = {}): LinhaXlsx => {
  const base: Record<string, Celula> = {
    Carga: 715, 'Status Carga': 'Agendado', 'Data Carga': new Date('2026-08-10T12:00:00Z'),
    Pedido: 26130030, Cliente: 'TRISOLO', Transportadora: 'CENTRAL', Motorista: 'PAULO',
    'Placa Caminhão': 'OBF2I37', Produto: 'NEO700 I2X', Tratamento: 'SEM TSI',
    Embalagem: 'BB5M', 'Qtd Agendada': 50,
    ...over,
  }
  return CAB.map((c) => base[String(c)] ?? null)
}

describe('reconhecimento do relatorio', () => {
  it('aceita o cabecalho real', () => {
    expect(ehRelatorioMontagemCarga([CAB])).toBe(true)
  })
  it('rejeita outro relatorio qualquer', () => {
    expect(ehRelatorioMontagemCarga([['CULTIVAR', 'LOTE', 'SALDO']])).toBe(false)
  })
})

describe('conversao da montagem de carga', () => {
  it('converte a linha completa', () => {
    const { linhas, resumo } = converterMontagemCarga([CAB, linha()])
    expect(linhas).toHaveLength(1)
    expect(resumo.aproveitadas).toBe(1)
    const c = linhas[0]
    expect(c.carga).toBe(715)
    expect(c.status).toBe('Agendado')
    expect(c.data).toBe('2026-08-10')
    expect(c.cliente).toBe('TRISOLO')
    expect(c.cultivar).toBe('NEO700 I2X')
    expect(c.tratamento).toBe('SEM TSI')
    expect(c.bags).toBe(50)
  })

  it('traduz a embalagem BB5M para o codigo do app', () => {
    const { linhas } = converterMontagemCarga([CAB, linha()])
    expect(linhas[0].embalagem).toBe('BG5M')
  })

  it('embalagem desconhecida entra com o codigo cru e vai para o resumo', () => {
    const { linhas, resumo } = converterMontagemCarga([CAB, linha({ Embalagem: 'BIGBAG' })])
    expect(linhas[0].embalagem).toBe('BIGBAG')
    expect(resumo.embalagemDesconhecida.BIGBAG).toBe(50)
  })

  it('linha sem quantidade nao vira carregamento', () => {
    const { linhas, resumo } = converterMontagemCarga([CAB, linha({ 'Qtd Agendada': 0 })])
    expect(linhas).toHaveLength(0)
    expect(resumo.semQuantidade).toBe(1)
  })

  it('linha sem data entra marcada, nao some', () => {
    const { linhas, resumo } = converterMontagemCarga([CAB, linha({ 'Data Carga': null })])
    expect(linhas).toHaveLength(1)
    expect(linhas[0].data).toBeNull()
    expect(resumo.semData).toBe(1)
  })

  it('data em texto dd/mm/aaaa tambem funciona', () => {
    const { linhas } = converterMontagemCarga([CAB, linha({ 'Data Carga': '07/08/2026' })])
    expect(linhas[0].data).toBe('2026-08-07')
  })

  it('conta os status para o filtro da tela', () => {
    const { resumo } = converterMontagemCarga([
      CAB, linha(), linha({ 'Status Carga': 'Finalizado' }), linha({ 'Status Carga': 'Finalizado' }),
    ])
    expect(resumo.porStatus).toEqual({ Agendado: 1, Finalizado: 2 })
  })
})

describe('saldo dinamico da expedicao', () => {
  const carreg = (over: Partial<CarregamentoLinha> = {}): CarregamentoLinha => ({
    cultivar: 'NEO700 I2X', tratamento: 'SEM TSI', embalagem: 'BG5M',
    bags: 1, data: '2026-08-10', ...over,
  })

  it('o exemplo do PCP: estoque 10, 1 agendado ate o dia 10 -> sobra 9', () => {
    const r = saldosExpedicao(
      [carreg({ bags: 1 })],
      [{ cultivar: 'NEO700 I2X', bags: 10 }],
      [], [],
    )
    expect(r[0].saldo).toBe(9)
  })

  it('o exemplo do PCP: estoque 10, 20 agendados ate o dia 20 -> faltam 10', () => {
    const r = saldosExpedicao(
      [carreg({ bags: 20, data: '2026-08-20' })],
      [{ cultivar: 'NEO700 I2X', bags: 10 }],
      [], [],
    )
    expect(r[0].saldo).toBe(-10)
  })

  it('SEM TSI soma os lotes do cultivar, nao o estoque tratado', () => {
    const r = saldosExpedicao(
      [carreg({ bags: 5 })],
      [{ cultivar: 'NEO700 I2X', bags: 3 }, { cultivar: 'NEO700 I2X', bags: 4 }],
      [{ cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 100 }],
      [],
    )
    expect(r[0].estoque).toBe(7)
    expect(r[0].saldo).toBe(2)
  })

  it('tratado cruza com estoque PA e producao ate a data', () => {
    const r = saldosExpedicao(
      [carreg({ tratamento: 'FTZ60', bags: 20 })],
      [{ cultivar: 'NEO700 I2X', bags: 99 }], // lotes NAO entram no tratado
      [{ cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 10 }],
      [
        { cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 15, dataProg: '2026-08-09' },
        // esta fica pronta DEPOIS do carregamento: nao conta
        { cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 50, dataProg: '2026-08-15' },
      ],
      '2026-08-10',
    )
    expect(r[0].estoque).toBe(10)
    expect(r[0].producaoPrevista).toBe(15)
    expect(r[0].saldo).toBe(5)
  })

  it('ordem sem dia programado nao cobre carregamento com prazo', () => {
    const r = saldosExpedicao(
      [carreg({ tratamento: 'FTZ60', bags: 10 })],
      [], [],
      [{ cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 10, dataProg: null }],
      '2026-08-10',
    )
    expect(r[0].producaoPrevista).toBe(0)
    expect(r[0].saldo).toBe(-10)
  })

  it('sem filtro de data, toda producao aberta conta', () => {
    const r = saldosExpedicao(
      [carreg({ tratamento: 'FTZ60', bags: 10 })],
      [], [],
      [{ cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 10, dataProg: null }],
      null,
    )
    expect(r[0].saldo).toBe(0)
  })

  it('as faltas vem primeiro na lista', () => {
    const r = saldosExpedicao(
      [
        carreg({ cultivar: 'SOBRA I2X', bags: 1 }),
        carreg({ cultivar: 'FALTA I2X', bags: 50 }),
      ],
      [{ cultivar: 'SOBRA I2X', bags: 10 }, { cultivar: 'FALTA I2X', bags: 5 }],
      [], [],
    )
    expect(r[0].cultivar).toBe('FALTA I2X')
    expect(r[0].saldo).toBe(-45)
  })

  it('cultivar com grafia diferente ainda casa (normalizacao)', () => {
    const r = saldosExpedicao(
      [carreg({ bags: 1 })],
      [{ cultivar: '  neo700   i2x ', bags: 10 }],
      [], [],
    )
    expect(r[0].estoque).toBe(10)
  })
})
