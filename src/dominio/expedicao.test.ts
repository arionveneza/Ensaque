import { describe, expect, it } from 'vitest'
import {
  converterAgendados,
  converterMontagemCarga,
  ehRelatorioAgendados,
  ehRelatorioMontagemCarga,
  normalizaLinhasXlsx,
  normalizaTratamento,
  resumoPorTipoVenda,
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
    const base = {
      cultivar: 'X', tratamento: 'T', embalagem: 'BG5M', producaoPrevista: 0, semTsi: false,
      caminhoes: [],
    }
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

  it('tratamento com grafia diferente no estoque ainda casa (FTZ60+VIC = FTZ60 + VIC)', () => {
    const r = saldosExpedicao(
      [carreg({ tratamento: 'FTZ60 + VIC', bags: 5 })],
      [],
      [{ cultivar: 'NEO700 I2X', tratamento: 'ftz60+vic', embalagem: 'BG5M', bags: 8 }],
      [],
    )
    expect(r[0].estoque).toBe(8)
  })
})

// ================================================================
// Pedidos agendados (12/09/2026)
// ================================================================

// os 43 nomes reais do relatório, na ordem A→AQ
const CAB_AGEND: LinhaXlsx = [
  'IDENTIFICADOR', 'NUMERO', 'SAFRA', 'FILIAL', 'USO SEMENTE', 'VENDEDOR', 'TIPO VENDA',
  'TIPO FRETE', 'CLIENTE', 'CPF CNPJ', 'PROPRIEDADE', 'IE', 'CIDADE', 'ESTADO', 'DISTANCIA',
  'PRODUTO', 'CATEGORIA', 'PRODUTO TERCEIRO', 'PENEIRA', 'TRATAMENTO', 'EMBALAGEM',
  'QTD PEDIDO', 'QTD PEDIDO SC', 'PESO EMBALAGEM', 'PESO TOTAL', 'UNITARIO R$',
  'TOTAL PROGRAMACAO R$', 'STATUS ENTREGA', 'DATA EMISSAO', 'CARGA', 'STATUS CARGA',
  'NOTA FISCAL', 'DATA ENTREGA INICIO', 'DATA AGENDADA', 'QTD AGENDADA', 'UM AGENDADA',
  'SALDO AGENDADO', 'UM SALDO AGENDADO', 'CIDADE ENTREGA', 'LATITUDE ENTREGA',
  'LONGITUDE ENTREGA', 'ROTEIRO', 'OBSERVACAO',
]

const linhaAg = (over: Partial<Record<string, Celula>> = {}): LinhaXlsx => {
  const base: Record<string, Celula> = {
    IDENTIFICADOR: 'ID-1', NUMERO: '26070035', SAFRA: 'SAFRA 2026', 'TIPO VENDA': 'VENDA PRODUCAO',
    CLIENTE: 'RODRIGO JOSE', CIDADE: 'BURITI ALEGRE', ESTADO: 'GO', PRODUTO: 'NEO700 I2X',
    TRATAMENTO: 'SEM TSI', EMBALAGEM: 'BB5M', 'QTD PEDIDO': 39, 'STATUS ENTREGA': 'Aprovado',
    CARGA: null, 'STATUS CARGA': null, 'DATA AGENDADA': new Date('2026-09-14T11:59:31.999Z'),
    'QTD AGENDADA': 34, 'UM AGENDADA': 'BB5M', OBSERVACAO: null,
    ...over,
  }
  return CAB_AGEND.map((c) => base[String(c)] ?? null)
}

describe('reconhecimento do relatorio de agendados', () => {
  it('aceita o cabecalho real e rejeita a montagem de carga', () => {
    expect(ehRelatorioAgendados([CAB_AGEND])).toBe(true)
    expect(ehRelatorioAgendados([CAB])).toBe(false)
    expect(ehRelatorioMontagemCarga([CAB_AGEND])).toBe(false)
  })
})

describe('normalizaTratamento', () => {
  it('caixa, espaco em volta do + e acento nao importam', () => {
    expect(normalizaTratamento('ftz60+vic')).toBe('FTZ60 + VIC')
    expect(normalizaTratamento('  FTZ60  +  VIC ')).toBe('FTZ60 + VIC')
    expect(normalizaTratamento('DER + LMT')).toBe('DER + LMT')
  })
})

describe('conversao dos pedidos agendados', () => {
  it('converte a linha completa', () => {
    const { linhas, resumo } = converterAgendados([CAB_AGEND, linhaAg()])
    expect(linhas).toHaveLength(1)
    expect(resumo.aproveitadas).toBe(1)
    const a = linhas[0]
    expect(a.identificador).toBe('ID-1')
    expect(a.pedido).toBe('26070035')
    expect(a.tipoVenda).toBe('VENDA PRODUCAO')
    expect(a.cooperado).toBe(false)
    expect(a.cliente).toBe('RODRIGO JOSE')
    expect(a.cidade).toBe('BURITI ALEGRE')
    expect(a.estado).toBe('GO')
    expect(a.cultivar).toBe('NEO700 I2X')
    expect(a.tratamento).toBe('SEM TSI')
    expect(a.embalagem).toBe('BG5M')
    expect(a.statusEntrega).toBe('Aprovado')
    expect(a.carga).toBeNull()
    expect(a.data).toBe('2026-09-14')
  })

  it('QTD AGENDADA e a que vale, nao QTD PEDIDO (agendamento parcial)', () => {
    const { linhas } = converterAgendados([CAB_AGEND, linhaAg({ 'QTD PEDIDO': 80, 'QTD AGENDADA': 50 })])
    expect(linhas[0].bags).toBe(50)
    expect(linhas[0].qtdPedido).toBe(80)
  })

  it('sem quantidade agendada nao vira agendamento', () => {
    const { linhas, resumo } = converterAgendados([CAB_AGEND, linhaAg({ 'QTD AGENDADA': 0 })])
    expect(linhas).toHaveLength(0)
    expect(resumo.semQuantidade).toBe(1)
  })

  it('Aguardando Estoque ENTRA na demanda e e contado no resumo', () => {
    const { linhas, resumo } = converterAgendados([
      CAB_AGEND, linhaAg(), linhaAg({ IDENTIFICADOR: 'ID-2', 'STATUS ENTREGA': 'Aguardando Estoque' }),
    ])
    expect(linhas).toHaveLength(2)
    expect(resumo.porStatusEntrega).toEqual({ Aprovado: 1, 'Aguardando Estoque': 1 })
  })

  it('cooperado so em VENDA COOPERADO — caixa e acento nao importam; os outros tipos nao', () => {
    const tipos = ['VENDA PRODUCAO', 'VENDA DISTRIBUIDOR', 'VENDA BONIFICAÇÃO', 'venda cooperado', 'VENDA COOPERADO']
    const { linhas, resumo } = converterAgendados([
      CAB_AGEND,
      ...tipos.map((t, i) => linhaAg({ IDENTIFICADOR: `ID-${i}`, 'TIPO VENDA': t, 'QTD AGENDADA': 10 })),
    ])
    expect(linhas.map((l) => l.cooperado)).toEqual([false, false, false, true, true])
    expect(resumo.bagsCooperado).toBe(20)
    expect(resumo.bagsOutras).toBe(30)
    expect(resumo.porTipoVenda['VENDA BONIFICAÇÃO']).toBe(1)
  })

  it('Date com hora vira o dia pelos componentes UTC do xlsx (nunca getDate local)', () => {
    const { linhas } = converterAgendados([
      CAB_AGEND,
      linhaAg({ IDENTIFICADOR: 'a', 'DATA AGENDADA': new Date('2026-09-14T11:59:31.999Z') }),
      linhaAg({ IDENTIFICADOR: 'b', 'DATA AGENDADA': new Date('2026-09-14T01:30:00Z') }),
      linhaAg({ IDENTIFICADOR: 'c', 'DATA AGENDADA': '07/08/2026' }),
    ])
    expect(linhas.map((l) => l.data)).toEqual(['2026-09-14', '2026-09-14', '2026-08-07'])
  })

  it('sem data entra marcada, nao some', () => {
    const { linhas, resumo } = converterAgendados([CAB_AGEND, linhaAg({ 'DATA AGENDADA': null })])
    expect(linhas).toHaveLength(1)
    expect(linhas[0].data).toBeNull()
    expect(resumo.semData).toBe(1)
  })

  it('tratamento vazio vira SEM TSI; composto e normalizado', () => {
    const { linhas } = converterAgendados([
      CAB_AGEND,
      linhaAg({ IDENTIFICADOR: 'a', TRATAMENTO: null }),
      linhaAg({ IDENTIFICADOR: 'b', TRATAMENTO: 'ftz60+vic' }),
    ])
    expect(linhas[0].tratamento).toBe('SEM TSI')
    expect(linhas[1].tratamento).toBe('FTZ60 + VIC')
  })

  it('embalagem: BB5M→BG5M, BMB→MEIOBAG, desconhecida entra crua e vai pro resumo', () => {
    const { linhas, resumo } = converterAgendados([
      CAB_AGEND,
      linhaAg({ IDENTIFICADOR: 'a', EMBALAGEM: 'BB5M' }),
      linhaAg({ IDENTIFICADOR: 'b', EMBALAGEM: 'BMB' }),
      linhaAg({ IDENTIFICADOR: 'c', EMBALAGEM: 'BIGBAG', 'QTD AGENDADA': 7 }),
    ])
    expect(linhas.map((l) => l.embalagem)).toEqual(['BG5M', 'MEIOBAG', 'BIGBAG'])
    expect(resumo.embalagemDesconhecida.BIGBAG).toBe(7)
  })

  it('CARGA vazia e null; numerica vira texto', () => {
    const { linhas } = converterAgendados([
      CAB_AGEND,
      linhaAg({ IDENTIFICADOR: 'a', CARGA: null }),
      linhaAg({ IDENTIFICADOR: 'b', CARGA: 781, 'STATUS CARGA': 'Aguardando Aprovação' }),
    ])
    expect(linhas[0].carga).toBeNull()
    expect(linhas[1].carga).toBe('781')
    expect(linhas[1].statusCarga).toBe('Aguardando Aprovação')
  })

  it('mesmo NUMERO em duas linhas sao dois agendamentos; identificador repetido so avisa', () => {
    const { linhas, resumo } = converterAgendados([
      CAB_AGEND,
      linhaAg({ IDENTIFICADOR: 'a', NUMERO: '1' }),
      linhaAg({ IDENTIFICADOR: 'b', NUMERO: '1' }),
      linhaAg({ IDENTIFICADOR: 'b', NUMERO: '2' }),
    ])
    expect(linhas).toHaveLength(3)
    expect(resumo.identificadorRepetido).toBe(1)
  })

  it('sem as colunas obrigatorias, erro claro', () => {
    expect(() => converterAgendados([['CULTIVAR', 'LOTE']])).toThrow(/pedidos agendados/)
  })
})

describe('alocacao por caminhao e visao por tipo de venda', () => {
  type Ag = CarregamentoLinha & { id: string; cooperado: boolean }
  const ag = (over: Partial<Ag> = {}): Ag => ({
    id: 'x', cooperado: false, cultivar: 'NEO700 I2X', tratamento: 'SEM TSI', embalagem: 'BG5M',
    bags: 10, data: '2026-09-10', ...over,
  })

  it('um caminhao dentro do estoque: todo coberto', () => {
    const r = saldosExpedicao([ag({ bags: 5 })], [{ cultivar: 'NEO700 I2X', bags: 10 }], [], [])
    expect(r[0].caminhoes).toHaveLength(1)
    expect(r[0].caminhoes[0]).toMatchObject({ bags: 5, coberto: 5, descoberto: 0 })
  })

  it('dois caminhoes e estoque 12: o segundo fica descoberto; soma descoberto = -saldo', () => {
    const r = saldosExpedicao(
      [ag({ id: 'a', data: '2026-09-10' }), ag({ id: 'b', data: '2026-09-12' })],
      [{ cultivar: 'NEO700 I2X', bags: 12 }], [], [],
    )
    expect(r[0].caminhoes.map((c) => [c.caminhao.id, c.coberto, c.descoberto])).toEqual([['a', 10, 0], ['b', 2, 8]])
    expect(r[0].caminhoes.reduce((t, c) => t + c.descoberto, 0)).toBe(-r[0].saldo)
    expect(r[0].deficitPrazo).toBe(0) // SEM TSI nao tem linha do tempo de producao
  })

  it('caminhao sem data entra primeiro e so estoque + ordem iniciada o cobrem', () => {
    const r = saldosExpedicao(
      [
        ag({ id: 'com-data', tratamento: 'FTZ60', data: '2026-09-10' }),
        ag({ id: 'sem-data', tratamento: 'FTZ60', data: null }),
      ],
      [],
      [{ cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 5 }],
      [
        { cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 10, dataProg: '2026-09-20', iniciada: true },
        { cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 10, dataProg: '2026-09-09' },
      ],
      '2026-09-07',
    )
    expect(r[0].caminhoes.map((c) => c.caminhao.id)).toEqual(['sem-data', 'com-data'])
    // sem data: 5 estoque + 10 iniciada = 15 → cobre os 10
    expect(r[0].caminhoes[0]).toMatchObject({ coberto: 10, descoberto: 0 })
    // com data 10/09: + a ordem de 09/09 → 25 − 10 ja consumidos cobre os 10
    expect(r[0].caminhoes[1]).toMatchObject({ coberto: 10, descoberto: 0 })
    expect(r[0].deficitPrazo).toBe(0)
  })

  it('tratado: producao toda depois dos caminhoes → soma descoberto = deficitPrazo', () => {
    const r = saldosExpedicao(
      [ag({ tratamento: 'FTZ60', bags: 20, data: '2026-09-08' })],
      [], [],
      [{ cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 20, dataProg: '2026-09-15' }],
      '2026-09-07',
    )
    expect(r[0].saldo).toBe(0)
    expect(r[0].deficitPrazo).toBe(20)
    expect(r[0].caminhoes[0].descoberto).toBe(20)
  })

  it('ordem entre dois caminhoes: soma descoberto > deficitPrazo (adiantar 10 resolveria tudo)', () => {
    const r = saldosExpedicao(
      [
        ag({ id: 't1', tratamento: 'FTZ60', data: '2026-09-08' }),
        ag({ id: 't2', tratamento: 'FTZ60', data: '2026-09-10' }),
        ag({ id: 't3', tratamento: 'FTZ60', data: '2026-09-12' }),
      ],
      [], [],
      [
        { cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 10, dataProg: '2026-09-09' },
        { cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 10, dataProg: '2026-09-11' },
      ],
      '2026-09-07',
    )
    expect(r[0].deficitPrazo).toBe(10)
    expect(r[0].caminhoes.map((c) => c.descoberto)).toEqual([10, 10, 10])
  })

  it('SEM TSI em duas embalagens: linha unica, cada caminhao alocado, deficitPrazo 0', () => {
    const r = saldosExpedicao(
      [ag({ id: 'bag', embalagem: 'BG5M' }), ag({ id: 'meio', embalagem: 'MEIOBAG', data: '2026-09-12' })],
      [{ cultivar: 'NEO700 I2X', bags: 12 }], [], [],
    )
    expect(r).toHaveLength(1)
    expect(r[0].caminhoes.map((c) => [c.caminhao.id, c.descoberto])).toEqual([['bag', 0], ['meio', 8]])
    expect(r[0].deficitPrazo).toBe(0)
  })

  it('por tipo de venda: a fila consolidada manda, os lados so somam', () => {
    const r = saldosExpedicao(
      [
        ag({ id: 'outras', cooperado: false, data: '2026-09-10' }),
        ag({ id: 'coop', cooperado: true, data: '2026-09-12' }),
      ],
      [{ cultivar: 'NEO700 I2X', bags: 12 }], [], [],
    )
    const t = resumoPorTipoVenda(r, (c) => c.cooperado)
    expect(t.outras).toMatchObject({ agendado: 10, coberto: 10, descoberto: 0, caminhoes: 1 })
    expect(t.outras.produtosEmFalta).toEqual([])
    expect(t.cooperado).toMatchObject({ agendado: 10, coberto: 2, descoberto: 8, caminhoes: 1 })
    expect(t.cooperado.produtosEmFalta).toEqual([
      { cultivar: 'NEO700 I2X', tratamento: 'SEM TSI', embalagem: 'BG5M', descoberto: 8 },
    ])
    // soma dos lados = consolidado
    expect(t.cooperado.agendado + t.outras.agendado).toBe(r[0].agendado)
    expect(t.cooperado.descoberto + t.outras.descoberto).toBe(-r[0].saldo)
  })

  it('cooperado que vem ANTES na fila leva o estoque — a data manda, nao o tipo', () => {
    const r = saldosExpedicao(
      [
        ag({ id: 'coop', cooperado: true, data: '2026-09-08' }),
        ag({ id: 'outras', cooperado: false, data: '2026-09-12' }),
      ],
      [{ cultivar: 'NEO700 I2X', bags: 12 }], [], [],
    )
    const t = resumoPorTipoVenda(r, (c) => c.cooperado)
    expect(t.cooperado.descoberto).toBe(0)
    expect(t.outras.descoberto).toBe(8)
  })
})
