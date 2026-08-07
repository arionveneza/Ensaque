import { describe, expect, it } from 'vitest'
import {
  converterMontagemCarga,
  ehRelatorioMontagemCarga,
  normalizaLinhasXlsx,
  saldosExpedicao,
  situacaoSaldo,
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

describe('normalizacao do retorno do leitor de xlsx', () => {
  it('aba nomeada vem embrulhada em {sheet, data} — desembrulha', () => {
    // foi exatamente o erro real: "(e[0] ?? []).map is not a function"
    const bruto = [{ sheet: 'relatorio', data: [CAB, linha()] }]
    const rows = normalizaLinhasXlsx(bruto)
    expect(Array.isArray(rows[0])).toBe(true)
    expect(ehRelatorioMontagemCarga(rows)).toBe(true)
  })

  it('com varias abas, escolhe a que o reconhecedor aceita', () => {
    // uma capa antes da aba de dados rejeitaria um arquivo valido
    const bruto = [
      { sheet: 'resumo', data: [['qualquer coisa']] },
      { sheet: 'relatorio', data: [CAB, linha()] },
    ]
    const rows = normalizaLinhasXlsx(bruto, ehRelatorioMontagemCarga)
    expect(ehRelatorioMontagemCarga(rows)).toBe(true)
  })

  it('linhas diretas passam intactas', () => {
    const rows = normalizaLinhasXlsx([CAB, linha()])
    expect(rows).toHaveLength(2)
    expect(ehRelatorioMontagemCarga(rows)).toBe(true)
  })

  it('vazio nao explode', () => {
    expect(normalizaLinhasXlsx([])).toEqual([])
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

  it('SEM TSI do mesmo cultivar em duas embalagens vira UMA linha', () => {
    // o pool de lotes e um so: duas linhas contariam os 12 bags duas vezes
    // e cada uma diria "atende" com o cultivar 8 bags em falta
    const r = saldosExpedicao(
      [
        carreg({ embalagem: 'BG5M', bags: 10 }),
        carreg({ embalagem: 'MEIOBAG', bags: 10 }),
      ],
      [{ cultivar: 'NEO700 I2X', bags: 12 }],
      [], [],
    )
    expect(r).toHaveLength(1)
    expect(r[0].agendado).toBe(20)
    expect(r[0].estoque).toBe(12)
    expect(r[0].saldo).toBe(-8)
    expect(r[0].embalagem).toBe('BG5M + MEIOBAG')
  })

  it('tratado: TODA a producao aberta conta no saldo (producao se adianta)', () => {
    const r = saldosExpedicao(
      [carreg({ tratamento: 'FTZ60', bags: 20 })],
      [{ cultivar: 'NEO700 I2X', bags: 99 }], // lotes NAO entram no tratado
      [{ cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 10 }],
      [
        { cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 15, dataProg: '2026-08-09' },
        { cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 50, dataProg: '2026-08-15' },
      ],
      '2026-08-07',
    )
    expect(r[0].estoque).toBe(10)
    expect(r[0].producaoPrevista).toBe(65)
    expect(r[0].saldo).toBe(55)
    // caminhao de 10/08: estoque 10 + 15 no prazo cobrem os 20 — sem buraco
    expect(r[0].deficitPrazo).toBe(0)
  })

  it('producao so depois do caminhao: saldo fecha mas exige adiantar', () => {
    const r = saldosExpedicao(
      [carreg({ tratamento: 'FTZ60', bags: 20 })],
      [], [],
      [{ cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 20, dataProg: '2026-08-15' }],
      '2026-08-07',
    )
    expect(r[0].saldo).toBe(0)
    expect(r[0].deficitPrazo).toBe(20)
  })

  it('ordem ja iniciada e garantida mesmo com a data programada no futuro', () => {
    // ordem ADIANTADA e concluida: data 15/08 no banco, material no galpao.
    // Sem a flag, o caso feliz da regra viraria alarme falso de urgencia.
    const r = saldosExpedicao(
      [carreg({ tratamento: 'FTZ60', bags: 20 })],
      [], [],
      [{ cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 20, dataProg: '2026-08-15', iniciada: true }],
      '2026-08-07',
    )
    expect(r[0].saldo).toBe(0)
    expect(r[0].deficitPrazo).toBe(0)
  })

  it('ordem sem dia marcado conta no saldo, mas nao garante caminhao', () => {
    const r = saldosExpedicao(
      [carreg({ tratamento: 'FTZ60', bags: 10 })],
      [], [],
      [{ cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 10, dataProg: null }],
      '2026-08-07',
    )
    expect(r[0].producaoPrevista).toBe(10)
    expect(r[0].saldo).toBe(0)
    expect(r[0].deficitPrazo).toBe(10)
  })

  it('cada caminhao confere o proprio prazo — o ultimo nao esconde o primeiro', () => {
    // caminhoes 08 e 12/08, producao toda em 11/08: o de 08/08 sai vazio.
    // Um prazo unico (ultimo caminhao) mostraria verde.
    const r = saldosExpedicao(
      [
        carreg({ tratamento: 'FTZ60', bags: 10, data: '2026-08-08' }),
        carreg({ tratamento: 'FTZ60', bags: 10, data: '2026-08-12' }),
      ],
      [], [],
      [{ cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 20, dataProg: '2026-08-11' }],
      '2026-08-07',
    )
    expect(r[0].saldo).toBe(0)
    expect(r[0].deficitPrazo).toBe(10)
  })

  it('promessa vencida nao garante: dataProg no passado sem iniciar', () => {
    const r = saldosExpedicao(
      [carreg({ tratamento: 'FTZ60', bags: 10, data: '2026-08-08' })],
      [], [],
      [{ cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 10, dataProg: '2026-08-05' }],
      '2026-08-07',
    )
    expect(r[0].deficitPrazo).toBe(10)
    // a mesma ordem, ja rodando, garante
    const r2 = saldosExpedicao(
      [carreg({ tratamento: 'FTZ60', bags: 10, data: '2026-08-08' })],
      [], [],
      [{ cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 10, dataProg: '2026-08-05', iniciada: true }],
      '2026-08-07',
    )
    expect(r2[0].deficitPrazo).toBe(0)
  })

  it('caminhao sem data: so estoque e ordem iniciada garantem', () => {
    const r = saldosExpedicao(
      [carreg({ tratamento: 'FTZ60', bags: 10, data: null })],
      [], [],
      [{ cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 10, dataProg: '2026-08-20' }],
      '2026-08-07',
    )
    expect(r[0].deficitPrazo).toBe(10)
  })

  // "atende" é reservado a estoque FÍSICO: bag programado não é bag no galpão
  it('coberta so por producao futura fica aguardando, nao atende', () => {
    const r = saldosExpedicao(
      [carreg({ tratamento: 'FTZ60', bags: 10 })],
      [], [],
      [{ cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 10, dataProg: '2026-08-09' }],
      '2026-08-07',
    )
    expect(r[0].saldo).toBe(0)
    expect(r[0].deficitPrazo).toBe(0)
    expect(situacaoSaldo(r[0])).toBe('aguardando-producao')
  })

  it('estoque parcial + producao no prazo tambem e aguardando', () => {
    const r = saldosExpedicao(
      [carreg({ tratamento: 'FTZ60', bags: 10 })],
      [],
      [{ cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 6 }],
      [{ cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 4, dataProg: '2026-08-09' }],
      '2026-08-07',
    )
    expect(situacaoSaldo(r[0])).toBe('aguardando-producao')
  })

  it('so o estoque fisico cobrindo tudo vira atende', () => {
    const r = saldosExpedicao(
      [carreg({ tratamento: 'FTZ60', bags: 10 })],
      [],
      [{ cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 10 }],
      [],
    )
    expect(situacaoSaldo(r[0])).toBe('atende')
  })

  it('a hierarquia: falta > adiantar > aguardando', () => {
    const base = { cultivar: 'X', tratamento: 'T', embalagem: 'BG5M', producaoPrevista: 0, semTsi: false }
    expect(situacaoSaldo({ ...base, agendado: 10, estoque: 0, deficitPrazo: 10, saldo: -5 })).toBe('falta')
    expect(situacaoSaldo({ ...base, agendado: 10, estoque: 0, deficitPrazo: 10, saldo: 0 })).toBe('adiantar')
    expect(situacaoSaldo({ ...base, agendado: 10, estoque: 12, deficitPrazo: 0, saldo: 2 })).toBe('atende')
  })

  it('SEM TSI sem lote suficiente continua sendo falta, nao aguardando', () => {
    const r = saldosExpedicao(
      [carreg({ bags: 10 })],
      [{ cultivar: 'NEO700 I2X', bags: 4 }],
      [], [],
    )
    expect(situacaoSaldo(r[0])).toBe('falta')
  })

  it('fracao de bag nao inventa falta por erro de ponto flutuante', () => {
    // 0.30 + 0.60 tem que empatar com 0.90 — sem arredondar, saldo = -1e-16
    const r = saldosExpedicao(
      [carreg({ bags: 0.9 })],
      [{ cultivar: 'NEO700 I2X', bags: 0.3 }, { cultivar: 'NEO700 I2X', bags: 0.6 }],
      [], [],
    )
    expect(r[0].saldo).toBe(0)
    expect(r[0].saldo < 0).toBe(false)
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
