import { describe, expect, it } from 'vitest'
import {
  agendadoPorTipo,
  converterAgendados,
  converterMontagemCarga,
  ehRelatorioAgendados,
  ehRelatorioMontagemCarga,
  bagsProduzidosSemApontar,
  cargasAgendadas,
  chaveProduto,
  classificarCargas,
  faltaPorProduto,
  ordenarFaltaPorProduto,
  recorteDaSelecao,
  resumoDoGrupo,
  normalizaLinhasXlsx,
  normalizaTratamento,
  resumoPorTipoVenda,
  saldosExpedicao,
  situacaoSaldo,
  transferenciaDe,
  type CarregamentoLinha,
  type FaltaPorProduto,
  type ProducaoPrevista,
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

  it('tratado: duas grafias do mesmo tratamento viram UMA linha, e o estoque bate (19/09/2026, achado do Arion)', () => {
    // caso real: agendado com "FTZ60 S" numa carga e "FTZ 60 S" noutra; o
    // saldo do SAP grava "FTZ60 S" — antes do fix viravam DUAS linhas, cada
    // uma vendo metade do estoque, e uma delas "sem saldo" por engano
    const r = saldosExpedicao(
      [
        carreg({ tratamento: 'FTZ60 S', bags: 5 }),
        carreg({ tratamento: 'FTZ 60 S', bags: 5 }),
      ],
      [],
      [{ cultivar: 'NEO700 I2X', tratamento: 'FTZ60 S', embalagem: 'BG5M', bags: 10 }],
      [],
    )
    expect(r).toHaveLength(1)
    expect(r[0].tratamento).toBe('FTZ60 S')
    expect(r[0].agendado).toBe(10)
    expect(r[0].estoque).toBe(10)
    expect(r[0].saldo).toBe(0)
    expect(r[0].caminhoes.every((c) => c.descoberto === 0)).toBe(true)
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
      caminhoes: [], producao: [],
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

describe('filial e transferencia de saldo', () => {
  it('sem filial nao afirma nada', () => {
    expect(transferenciaDe(null)).toEqual({ precisa: false, filial: null, curto: null })
    expect(transferenciaDe('0').precisa).toBe(false)
  })

  it('matriz nao precisa de transferencia', () => {
    const t = transferenciaDe('SEMENTES VENEZA LTDA')
    expect(t.precisa).toBe(false)
    expect(t.curto).toBe('MATRIZ')
  })

  it('outra filial precisa, com o nome curto para a etiqueta', () => {
    expect(transferenciaDe('SEMENTES VENEZA LTDA - CHAPADAO DO SUL')).toEqual({
      precisa: true,
      filial: 'SEMENTES VENEZA LTDA-CHAPADAO DO SUL',
      curto: 'CHAPADAO DO SUL',
    })
  })

  it('converterAgendados le a FILIAL do proprio relatorio quando vier preenchida', () => {
    const r = converterAgendados([CAB_AGEND, linhaAg({ FILIAL: 'SEMENTES VENEZA LTDA-TUPACIGUARA' }), linhaAg({ IDENTIFICADOR: 'ID-2' })])
    expect(r.linhas[0].filial).toBe('SEMENTES VENEZA LTDA-TUPACIGUARA')
    // hoje vem vazia em todas as linhas: nula, e a tela cruza com pedidos_filial
    expect(r.linhas[1].filial).toBeNull()
  })
})

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

  it('letra colada ou separada do numero e o mesmo tratamento (19/09/2026, achado do Arion)', () => {
    // o caso real: o saldo do SAP trazia "FTZ60 S" e o relatorio de
    // agendados "FTZ 60 S" — a Expedicao achava que nao tinha estoque
    expect(normalizaTratamento('FTZ 60 S')).toBe(normalizaTratamento('FTZ60 S'))
    expect(normalizaTratamento('FTZ60 S')).toBe('FTZ60 S')
    // o espaco do OUTRO lado do numero (antes do S) nao pode sumir, senao
    // "FTZ60S" (colado) virava indistinguivel de "FTZ60 S" (com produto a mais)
    expect(normalizaTratamento('FTZ60 S')).not.toBe(normalizaTratamento('FTZ60S'))
    // generaliza para qualquer numero, nao so 60 — mesma familia de bug
    expect(normalizaTratamento('FTZ 80')).toBe('FTZ80')
    // nao mexe onde nao tem numero nenhum
    expect(normalizaTratamento('FTZ ELITE')).toBe('FTZ ELITE')
    // compoe certo com o "+": "FTZ 60 + VIC" e "FTZ60+VIC" sao o mesmo
    expect(normalizaTratamento('FTZ 60 + VIC')).toBe(normalizaTratamento('FTZ60+VIC'))
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

  it('FINALIZADO / Finalizada (coluna STATUS ENTREGA) fica FORA: o caminhao ja saiu', () => {
    const { linhas, resumo } = converterAgendados([
      CAB_AGEND,
      linhaAg({ IDENTIFICADOR: 'a', 'STATUS ENTREGA': 'FINALIZADO', 'QTD AGENDADA': 7 }),
      linhaAg({ IDENTIFICADOR: 'b', 'STATUS ENTREGA': 'Finalizada', 'QTD AGENDADA': 8 }),
      linhaAg({ IDENTIFICADOR: 'c', 'STATUS ENTREGA': 'finalizado', 'QTD AGENDADA': 9 }),
      linhaAg({ IDENTIFICADOR: 'd', 'STATUS ENTREGA': 'Aprovado', 'QTD AGENDADA': 10 }),
    ])
    expect(linhas.map((l) => l.identificador)).toEqual(['d'])
    expect(resumo.finalizados).toBe(3)
    // o finalizado nao infla nenhum outro contador
    expect(resumo.bagsOutras).toBe(10)
    expect(resumo.porStatusEntrega).toEqual({ Aprovado: 1 })
    expect(resumo.aproveitadas).toBe(1)
  })

  it('STATUS CARGA = Finalizado tambem fica fora, mesmo com a entrega Aprovado (15/09/2026)', () => {
    const { linhas, resumo } = converterAgendados([
      CAB_AGEND,
      linhaAg({ IDENTIFICADOR: 'a', 'STATUS ENTREGA': 'Aprovado', CARGA: '715', 'STATUS CARGA': 'Finalizado', 'QTD AGENDADA': 7 }),
      linhaAg({ IDENTIFICADOR: 'b', 'STATUS ENTREGA': 'Aprovado', CARGA: '716', 'STATUS CARGA': 'Em carga', 'QTD AGENDADA': 8 }),
      linhaAg({ IDENTIFICADOR: 'c', 'STATUS ENTREGA': 'Aprovado', CARGA: null, 'STATUS CARGA': null, 'QTD AGENDADA': 9 }),
    ])
    expect(linhas.map((l) => l.identificador)).toEqual(['b', 'c'])
    expect(resumo.finalizados).toBe(1)
    expect(resumo.porStatusCarga).toEqual({ 'Em carga': 1 })
    expect(resumo.aproveitadas).toBe(2)
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

  it('falta por produto e data: cada item lista so as datas em que falta, e a soma e o descoberto da consolidada', () => {
    // estoque 12 · caminhões 10 (dia 10) e 10 (dia 12): o 1º sai cheio, o 2º fica com 8 descobertos
    const r = saldosExpedicao(
      [ag({ id: 'a', data: '2026-09-10' }), ag({ id: 'b', data: '2026-09-12' })],
      [{ cultivar: 'NEO700 I2X', bags: 12 }], [], [],
    )
    const f = faltaPorProduto(r)
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ cultivar: 'NEO700 I2X', semTsi: true, situacao: 'falta', descoberto: 8 })
    // o dia 10 nao aparece: nao falta nele
    expect(f[0].datas).toEqual([{ data: '2026-09-12', caminhoes: 1, agendado: 10, descoberto: 8 }])
    expect(f[0].descoberto).toBe(r[0].caminhoes.reduce((t, c) => t + c.descoberto, 0))
  })

  it('falta por produto e data: produto coberto nao entra; sem data vira a primeira data; ordem do maior descoberto', () => {
    const r = saldosExpedicao(
      [
        ag({ id: 'ok', cultivar: 'COBERTO', bags: 5 }),
        ag({ id: 's', cultivar: 'X1', tratamento: 'FTZ60', data: null, bags: 4 }),
        ag({ id: 'a', cultivar: 'X1', tratamento: 'FTZ60', data: '2026-09-10', bags: 6 }),
        ag({ id: 'b', cultivar: 'X2', tratamento: 'FTZ60', data: '2026-09-10', bags: 5 }),
      ],
      [{ cultivar: 'COBERTO', bags: 10 }], [], [],
    )
    const f = faltaPorProduto(r)
    expect(f.map((p) => [p.cultivar, p.descoberto])).toEqual([['X1', 10], ['X2', 5]])
    expect(f[0].datas.map((d) => [d.data, d.descoberto])).toEqual([[null, 4], ['2026-09-10', 6]])
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
    // e cada lado lista OS PRODUTOS que agendou, com o que coube nos seus caminhões (19/09/2026)
    expect(t.outras.produtos).toEqual([
      { cultivar: 'NEO700 I2X', tratamento: 'SEM TSI', embalagem: 'BG5M', agendado: 10, coberto: 10, descoberto: 0, caminhoes: 1 },
    ])
    expect(t.cooperado.produtos).toEqual([
      { cultivar: 'NEO700 I2X', tratamento: 'SEM TSI', embalagem: 'BG5M', agendado: 10, coberto: 2, descoberto: 8, caminhoes: 1 },
    ])
  })

  it('agendadoPorTipo: reparte o agendado do produto e soma o total', () => {
    const r = saldosExpedicao(
      [
        ag({ id: 'a', cooperado: true, bags: 12 }),
        ag({ id: 'b', cooperado: false, bags: 5 }),
        ag({ id: 'c', cooperado: false, bags: 3 }),
      ],
      [{ cultivar: 'NEO700 I2X', bags: 100 }], [], [],
    )
    const t = agendadoPorTipo(r[0], (c) => c.cooperado)
    expect(t).toEqual({ cooperado: 12, outras: 8 })
    expect(t.cooperado + t.outras).toBe(r[0].agendado)
  })

  it('agendadoPorTipo: produto so de um grupo da zero no outro', () => {
    const r = saldosExpedicao([ag({ cooperado: false, bags: 4 })], [], [], [])
    expect(agendadoPorTipo(r[0], (c) => c.cooperado)).toEqual({ cooperado: 0, outras: 4 })
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

describe('recorte por carga (19/09/2026)', () => {
  type AgC = CarregamentoLinha & { id: string; cooperado: boolean; carga: string | null }
  const agc = (over: Partial<AgC> = {}): AgC => ({
    id: 'x', cooperado: false, carga: null, cultivar: 'NEO700 I2X', tratamento: 'FTZ60',
    embalagem: 'BG5M', bags: 10, data: '2026-09-10', ...over,
  })
  const pa = (bags: number) => [
    { cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags },
  ]
  const daCarga = (...cargas: (string | null)[]) => (c: AgC) => cargas.includes(c.carga)

  it('faltaPorProduto traz o agendado do produto, de TODAS as datas, ao lado do descoberto', () => {
    // caso real de 19/09: 24 bg em 18/09 e 58 em 21/09, estoque 18, 41 de
    // produção em 19/09 → falta 6 em 18/09 e 23 em 21/09; a grade dizia só
    // "6" e "23", e o Arion leu como pedido do dia
    const s = saldosExpedicao(
      [agc({ id: 'a', data: '2026-09-18', bags: 24 }), agc({ id: 'b', data: '2026-09-21', bags: 58 })],
      [], pa(18),
      [{ cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 41, dataProg: '2026-09-19' }],
      '2026-09-19',
    )
    const [f] = faltaPorProduto(s)
    expect(f.agendado).toBe(82)
    expect(f.descoberto).toBe(29)
    expect(f.datas.map((d) => [d.data, d.agendado, d.descoberto])).toEqual([
      ['2026-09-18', 24, 6],
      ['2026-09-21', 58, 23],
    ])
    // no recorte, o agendado é só o da seleção
    expect(faltaPorProduto(s, (c) => c.id === 'b')[0].agendado).toBe(58)
  })

  it('sem predicado, faltaPorProduto continua exatamente como era', () => {
    const s = saldosExpedicao(
      [agc({ id: 'a', carga: '10', data: '2026-09-08' }), agc({ id: 'b', carga: '20', data: '2026-09-12' })],
      [], pa(12), [],
    )
    expect(faltaPorProduto(s, () => true)).toEqual(faltaPorProduto(s))
  })

  it('a carga que vem DEPOIS fica descoberta, mesmo com estoque no total', () => {
    // o caso que o recorte existe para não mentir: estoque 12 cobre a de 08,
    // e a de 12 fica com 8 descobertos — recortar não devolve o estoque
    const s = saldosExpedicao(
      [agc({ id: 'a', carga: '10', data: '2026-09-08' }), agc({ id: 'b', carga: '20', data: '2026-09-12' })],
      [], pa(12), [],
    )
    expect(resumoDoGrupo(s, daCarga('20')).descoberto).toBe(8)
    expect(resumoDoGrupo(s, daCarga('10')).descoberto).toBe(0)
    expect(resumoDoGrupo(s, daCarga('10', '20')).descoberto).toBe(8)
  })

  it('a soma dos recortes de uma particao da o total, por produto e por data', () => {
    const s = saldosExpedicao(
      [
        agc({ id: 'a', carga: '10', data: '2026-09-08' }),
        agc({ id: 'b', carga: '20', data: '2026-09-10' }),
        agc({ id: 'c', carga: null, data: '2026-09-09' }),
      ],
      [], pa(11), [],
    )
    const total = faltaPorProduto(s)[0]
    const partes = [daCarga('10'), daCarga('20'), daCarga(null)].map((p) => faltaPorProduto(s, p))
    const soma = partes.reduce((t, p) => t + (p[0]?.descoberto ?? 0), 0)
    expect(soma).toBe(total.descoberto)
    // e por data: 09 e 10 ficam descobertas, 08 não
    const porData = new Map(total.datas.map((d) => [d.data, d.descoberto]))
    const somaData = new Map<string | null, number>()
    for (const p of partes) {
      for (const d of p[0]?.datas ?? []) somaData.set(d.data, (somaData.get(d.data) ?? 0) + d.descoberto)
    }
    expect([...somaData.entries()].sort()).toEqual([...porData.entries()].sort())
  })

  it('coberto pela producao programada NAO conta como material que existe', () => {
    // é a diferença entre "a fila fecha" e "o bag está no galpão": sem isso,
    // o produto some da lista de prioridade e ninguém manda produzir
    const s = saldosExpedicao(
      [agc({ id: 'a', carga: '10', data: '2026-09-10' })],
      [], [],
      [{ cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 20, dataProg: '2026-09-09' }],
      '2026-09-01',
    )
    expect(s[0].caminhoes[0].coberto).toBe(10)
    expect(s[0].caminhoes[0].cobertoEstoque).toBe(0)
    const r = recorteDaSelecao(s, daCarga('10'), (c) => c.carga)
    expect(r.produtos[0].aProduzir).toBe(10)
    expect(r.produtos[0].descoberto).toBe(0)
    expect(r.produtos[0].programado).toBe(20)
  })

  it('cobertoEstoque distribui o estoque fisico na ordem da fila', () => {
    const s = saldosExpedicao(
      [
        agc({ id: 'a', data: '2026-09-08', bags: 10 }),
        agc({ id: 'b', data: '2026-09-10', bags: 10 }),
        agc({ id: 'c', data: '2026-09-12', bags: 10 }),
      ],
      [], pa(15), [],
    )
    expect(s[0].caminhoes.map((c) => c.cobertoEstoque)).toEqual([10, 5, 0])
    const soma = s[0].caminhoes.reduce((t, c) => t + c.cobertoEstoque, 0)
    expect(soma).toBe(Math.min(15, 30))
  })

  it('mostra para quem o estoque foi antes desta selecao', () => {
    const s = saldosExpedicao(
      [
        agc({ id: 'a', carga: null, data: '2026-09-08', bags: 40 }),
        agc({ id: 'b', carga: '10', data: '2026-09-09', bags: 60 }),
        agc({ id: 'c', carga: '20', data: '2026-09-10', bags: 60 }),
      ],
      [], pa(100), [],
    )
    const r = recorteDaSelecao(s, daCarga('20'), (c) => c.carga)
    expect(r.produtos[0].antes).toEqual({ outrasCargas: 60, semCarga: 40 })
    expect(r.produtos[0].temHoje).toBe(0)
    expect(r.produtos[0].aProduzir).toBe(60)
  })

  it('o recorte nao muta os saldos', () => {
    const s = saldosExpedicao(
      [agc({ id: 'a', carga: '10' }), agc({ id: 'b', carga: '20' })],
      [], pa(5), [],
    )
    const antes = JSON.stringify(s)
    recorteDaSelecao(s, daCarga('10'), (c) => c.carga)
    expect(JSON.stringify(s)).toBe(antes)
  })

  it('SEM TSI sai marcado: semente branca nao passa pela maquina', () => {
    const s = saldosExpedicao(
      [agc({ id: 'a', carga: '10', tratamento: 'SEM TSI' })],
      [{ cultivar: 'NEO700 I2X', bags: 3 }], [], [],
    )
    const r = recorteDaSelecao(s, daCarga('10'), (c) => c.carga)
    expect(r.produtos[0].semTsi).toBe(true)
    expect(r.produtos[0].aProduzir).toBe(7)
  })

  it('empate de data nao depende da ordem de entrada quando ha desempate', () => {
    const d = (c: AgC) => c.carga ?? ''
    const a = agc({ id: 'a', carga: '10', data: '2026-09-10', bags: 30 })
    const b = agc({ id: 'b', carga: '20', data: '2026-09-10', bags: 30 })
    const s1 = saldosExpedicao([a, b], [], pa(40), [], null, d)
    const s2 = saldosExpedicao([b, a], [], pa(40), [], null, d)
    const cob = (s: typeof s1) =>
      Object.fromEntries(s[0].caminhoes.map((c) => [c.caminhao.carga, c.coberto]))
    expect(cob(s1)).toEqual(cob(s2))
    expect(cob(s1)).toEqual({ '10': 30, '20': 10 })
  })

  it('a ordem prevista chega na tela com numero e status', () => {
    const s = saldosExpedicao(
      [agc({ id: 'a', carga: '10', data: '2026-09-18', bags: 2 })],
      [], [],
      [{ cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 19, dataProg: '2026-09-18',
         iniciada: true, numero: '148734', status: 'Qualidade apontada' }],
      '2026-09-19',
    )
    expect(s[0].producao).toEqual([
      { bags: 19, dataProg: '2026-09-18', iniciada: true, numero: '148734', status: 'Qualidade apontada' },
    ])
    const r = recorteDaSelecao(s, daCarga('10'), (c) => c.carga)
    expect(r.produtos[0].ordens[0].numero).toBe('148734')
  })

  it('produzido sem apontar: so Finalizada e Qualidade apontada contam', () => {
    // o caso real da O790 IPRO · FTZ ELITE (19/09/2026): 2 bg agendados, 0 no
    // SAP, ordem de 19 bg já com qualidade apontada — a tela dizia "a produzir"
    const s = saldosExpedicao(
      [agc({ id: 'a', carga: '10', data: '2026-09-18', bags: 2 })],
      [], [],
      [
        { cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 19, dataProg: '2026-09-18', iniciada: true, numero: '148734', status: 'Qualidade apontada' },
        { cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 7, dataProg: '2026-09-20', iniciada: false, numero: '148800', status: 'Programada' },
        { cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 5, dataProg: '2026-09-18', iniciada: true, numero: '148801', status: 'Em producao' },
      ],
      '2026-09-19',
    )
    expect(situacaoSaldo(s[0])).toBe('aguardando-producao')
    expect(bagsProduzidosSemApontar(s[0])).toBe(19)
    // cobre os 2 bg que faltam: a etiqueta certa é "produzido · falta apontar"
    expect(bagsProduzidosSemApontar(s[0]) >= s[0].agendado - s[0].estoque).toBe(true)
  })

  it('cargasAgendadas agrupa datas, clientes e status, e ignora quem nao tem carga', () => {
    const cargas = cargasAgendadas([
      { carga: '20', data: '2026-09-18', bags: 10, cliente: 'FAZENDA A', statusCarga: 'Em carga' },
      { carga: '20', data: '2026-09-17', bags: 5, cliente: 'FAZENDA B', statusCarga: 'Em carga' },
      { carga: '9', data: '2026-09-17', bags: 7, cliente: 'FAZENDA C', statusCarga: 'Agendado' },
      { carga: null, data: '2026-09-17', bags: 99, cliente: 'X', statusCarga: null },
    ])
    expect(cargas.map((c) => c.carga)).toEqual(['9', '20'])
    const c20 = cargas.find((c) => c.carga === '20')!
    expect(c20.datas).toEqual(['2026-09-17', '2026-09-18'])
    expect(c20.clientes).toEqual(['FAZENDA A', 'FAZENDA B'])
    expect(c20.bags).toBe(15)
    expect(c20.linhas).toBe(2)
  })

  it('carga com dois status devolve os dois, sem escolher calado', () => {
    const cargas = cargasAgendadas([
      { carga: '7', data: '2026-09-17', bags: 1, cliente: null, statusCarga: 'Em carga' },
      { carga: '7', data: '2026-09-17', bags: 1, cliente: null, statusCarga: 'Carregado' },
    ])
    expect(cargas[0].status).toEqual(['Em carga', 'Carregado'])
  })
})
describe('ordenarFaltaPorProduto (19/09/2026)', () => {
  const linha = (cultivar: string, tratamento: string, embalagem: string, descoberto: number): FaltaPorProduto => ({
    cultivar, tratamento, embalagem, semTsi: tratamento === 'SEM TSI', situacao: 'falta',
    descoberto, agendado: descoberto, datas: [],
  })
  // tratamentos com iniciais distintas de propósito: o teste é da ordenação,
  // não de como o ICU compara espaço com dígito
  const base = [
    linha('O790 IPRO', 'V&P', 'BG5M', 2),
    linha('NEO680 IPRO', 'FTZ60', 'MEIOBAG', 5),
    linha('NEO680 IPRO', 'FTZ60', 'BG5M', 23),
    linha('0820 IPRO', 'DER + LMT', 'BG5M', 9),
    linha('NEO1000 IPRO', 'SEM TSI', 'BG5M', 1),
    // as duas abaixo forçam a 2ª chave de desempate (revisão de 19/09/2026):
    // mesma cultivar com tratamento E embalagem discordando, e mesmo
    // tratamento com cultivar E embalagem discordando — sem elas, trocar a
    // prioridade entre a 2ª e a 3ª chave passava pela suíte
    linha('NEO680 IPRO', 'V&P', 'BG5M', 7),
    linha('SS NEO700 I2X', 'FTZ60', 'BG5M', 3),
  ]
  const id = (l: FaltaPorProduto[]) => l.map((x) => `${x.cultivar} | ${x.tratamento} | ${x.embalagem}`)

  it('padrao: maior falta primeiro', () => {
    expect(ordenarFaltaPorProduto(base, 'falta').map((x) => x.descoberto)).toEqual([23, 9, 7, 5, 3, 2, 1])
  })

  it('por cultivar: ordem numerica (680 antes de 1000), depois tratamento e embalagem', () => {
    expect(id(ordenarFaltaPorProduto(base, 'cultivar'))).toEqual([
      '0820 IPRO | DER + LMT | BG5M',
      'NEO680 IPRO | FTZ60 | BG5M',
      'NEO680 IPRO | FTZ60 | MEIOBAG',
      'NEO680 IPRO | V&P | BG5M',
      'NEO1000 IPRO | SEM TSI | BG5M',
      'O790 IPRO | V&P | BG5M',
      'SS NEO700 I2X | FTZ60 | BG5M',
    ])
  })

  it('por tratamento: agrupa o tratamento e desempata por cultivar e embalagem', () => {
    expect(id(ordenarFaltaPorProduto(base, 'tratamento'))).toEqual([
      '0820 IPRO | DER + LMT | BG5M',
      'NEO680 IPRO | FTZ60 | BG5M',
      'NEO680 IPRO | FTZ60 | MEIOBAG',
      'SS NEO700 I2X | FTZ60 | BG5M',
      'NEO1000 IPRO | SEM TSI | BG5M',
      'NEO680 IPRO | V&P | BG5M',
      'O790 IPRO | V&P | BG5M',
    ])
  })

  it('empate na falta e resolvido pelo nome, nunca pela ordem de chegada', () => {
    const iguais = [linha('B', 'X', 'BG5M', 4), linha('A', 'X', 'BG5M', 4)]
    expect(ordenarFaltaPorProduto(iguais, 'falta').map((x) => x.cultivar)).toEqual(['A', 'B'])
  })

  it('nao altera a lista recebida e devolve lista nova', () => {
    // lista própria e desordenada: com o `base` compartilhado, a versão que
    // ordenava in place passava neste teste por acidente (os `it` anteriores
    // já tinham deixado o `base` na ordem certa)
    const entrada = [linha('B', 'X', 'BG5M', 1), linha('A', 'X', 'BG5M', 9)]
    const antes = id(entrada)
    const saida = ordenarFaltaPorProduto(entrada, 'cultivar')
    expect(saida).not.toBe(entrada)
    expect(id(entrada)).toEqual(antes)
    expect(id(saida)).toEqual(['A | X | BG5M', 'B | X | BG5M'])
  })
})

describe('cargas: o que da para atender (19/09/2026)', () => {
  type AgC = CarregamentoLinha & { id: string; carga: string | null }
  const agc = (over: Partial<AgC> = {}): AgC => ({
    id: 'x', carga: null, cultivar: 'NEO700 I2X', tratamento: 'FTZ60',
    embalagem: 'BG5M', bags: 10, data: '2026-09-10', ...over,
  })
  const pa = (bags: number) => [{ cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags }]
  const prod = (bags: number, dataProg: string | null, over: Partial<ProducaoPrevista> = {}): ProducaoPrevista => ({
    cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags, dataProg, ...over,
  })
  const cargaDe = (c: AgC) => c.carga

  it('cobertoPlanejado reparte estoque + toda ordem aberta na ordem da fila', () => {
    // estoque 5 + ordem de 15 sem dia = 20 planejados para três caminhões de 10
    const s = saldosExpedicao(
      [agc({ id: 'a', data: '2026-09-08' }), agc({ id: 'b', data: '2026-09-10' }), agc({ id: 'c', data: '2026-09-12' })],
      [], pa(5), [prod(15, null)], '2026-09-01',
    )
    expect(s[0].caminhoes.map((c) => c.cobertoPlanejado)).toEqual([10, 10, 0])
    // ordem sem dia não garante nada: coberto é só o estoque
    expect(s[0].caminhoes.map((c) => c.coberto)).toEqual([5, 0, 0])
    expect(s[0].caminhoes.map((c) => c.cobertoEstoque)).toEqual([5, 0, 0])
  })

  it('invariante: cobertoEstoque <= coberto <= cobertoPlanejado <= bags, com ordem de todo tipo', () => {
    const s = saldosExpedicao(
      [
        agc({ id: 'a', data: null, bags: 7 }),
        agc({ id: 'b', data: '2026-09-10', bags: 12 }),
        agc({ id: 'c', data: '2026-09-15', bags: 20 }),
        agc({ id: 'd', data: '2026-09-15', bags: 5 }),
      ],
      [], pa(6),
      [
        prod(4, '2026-09-20', { iniciada: true }), // iniciada com data futura
        prod(8, '2026-09-09'), // antes dos caminhões
        prod(9, '2026-09-18'), // depois de todos
        prod(3, null), // sem dia
        prod(5, '2026-09-01'), // vencida (hoje é 05/09)
      ],
      '2026-09-05',
    )
    for (const c of s[0].caminhoes) {
      expect(c.cobertoEstoque).toBeLessThanOrEqual(c.coberto)
      expect(c.coberto).toBeLessThanOrEqual(c.cobertoPlanejado)
      expect(c.cobertoPlanejado).toBeLessThanOrEqual(c.bags)
    }
    const somaPlanejado = s[0].caminhoes.reduce((t, c) => t + c.cobertoPlanejado, 0)
    expect(somaPlanejado).toBe(Math.min(s[0].agendado, s[0].estoque + s[0].producaoPrevista))
    // estoque 6 + ordens 29 = 35 planejados; agendado 44
    expect(somaPlanejado).toBe(35)
  })

  it('SEM TSI: cobertoPlanejado e o proprio cobertoEstoque (semente branca nao tem ordem)', () => {
    const s = saldosExpedicao(
      [agc({ id: 'a', tratamento: 'SEM TSI', bags: 10 })],
      // o distrator tem receita SEM TSI de propósito (existe: receita sem
      // produto): é ela que uma regressão do ramo branca somaria
      [{ cultivar: 'NEO700 I2X', bags: 4 }], [], [prod(50, '2026-09-09', { tratamento: 'SEM TSI' })],
    )
    expect(s[0].caminhoes[0].cobertoPlanejado).toBe(4)
    expect(s[0].caminhoes[0].cobertoEstoque).toBe(4)
  })

  it('tres cargas: atende, planejada (fora do prazo) e falta planejar', () => {
    // estoque 10 cobre a carga 1; a ordem de 10 sem dia planeja a carga 2
    // (fora do prazo, porque sem dia não garante); a carga 3 não tem nada
    const linhas = [
      agc({ id: 'a', carga: '1', data: '2026-09-08' }),
      agc({ id: 'b', carga: '2', data: '2026-09-10' }),
      agc({ id: 'c', carga: '3', data: '2026-09-12' }),
    ]
    const s = saldosExpedicao(linhas, [], pa(10), [prod(10, null, { numero: '200' })], '2026-09-01')
    const r = classificarCargas(s, cargasAgendadas(linhas), cargaDe)
    expect(r.map((c) => [c.carga, c.situacao, c.foraDoPrazo, c.ordemForaDoPrazo, c.caminhaoSemData])).toEqual([
      ['1', 'atende', false, false, false], ['2', 'planejada', true, true, false], ['3', 'falta-planejar', false, false, false],
    ])
    expect(r[1]).toMatchObject({ estoque: 0, garantido: 0, planejado: 10, semOrdem: 0, bagsSemDePara: 0 })
    expect(r[1].produtos[0].ordensForaDoPrazo.map((o) => o.numero)).toEqual(['200'])
    expect(r[1].produtos[0].ordensNoPrazo).toEqual([])
    expect(r[2]).toMatchObject({ semOrdem: 10, semLote: 0 })
    expect(r[2].produtos[0]).toMatchObject({ bags: 10, estoque: 0, garantido: 0, planejado: 0, falta: 10, ateQuando: '2026-09-12' })
    // carga atendida: nenhum caminhão descoberto, nenhuma ordem fora do prazo
    expect(r[0].produtos[0]).toMatchObject({ ateQuando: null, caminhaoSemData: false, ordensForaDoPrazo: [] })
  })

  it('foraDoPrazo: so quando a ordem nao esta garantida ate a data do caminhao', () => {
    const caso = (dataProg: string | null, iniciada: boolean, dataCaminhao: string | null) => {
      const linhas = [agc({ id: 'a', carga: '1', data: dataCaminhao })]
      const s = saldosExpedicao(linhas, [], [], [prod(10, dataProg, { iniciada })], '2026-09-05')
      const [c] = classificarCargas(s, cargasAgendadas(linhas), cargaDe, { hoje: '2026-09-05' })
      return [c.situacao, c.foraDoPrazo, c.ordemForaDoPrazo, c.caminhaoSemData, c.produtos[0].ordensForaDoPrazo.length]
    }
    expect(caso('2026-09-09', false, '2026-09-10')).toEqual(['planejada', false, false, false, 0]) // no prazo
    expect(caso('2026-09-11', false, '2026-09-10')).toEqual(['planejada', true, true, false, 1]) // depois do caminhão
    expect(caso(null, false, '2026-09-10')).toEqual(['planejada', true, true, false, 1]) // sem dia
    expect(caso('2026-09-01', false, '2026-09-10')).toEqual(['planejada', true, true, false, 1]) // vencida
    expect(caso('2026-09-30', true, '2026-09-10')).toEqual(['planejada', false, false, false, 0]) // iniciada, data futura
    // caminhão sem data: só iniciada garante — e a carga diz que o problema é a data do caminhão, não a ordem
    expect(caso('2026-09-09', false, null)).toEqual(['planejada', true, false, true, 1])
  })

  it('ordensNoPrazo x ordensForaDoPrazo: a iniciada nao e apontada como fora do prazo', () => {
    // o caso da revisão: ordem 100 rodando (5 bg) + ordem 200 sem dia (10 bg),
    // carga de 15 — a 1ª versão listava as duas como "fora do prazo"
    const linhas = [agc({ id: 'a', carga: '1', data: '2026-09-20', bags: 15 })]
    const s = saldosExpedicao(
      linhas, [], [],
      [prod(5, '2026-09-25', { iniciada: true, numero: '100' }), prod(10, null, { numero: '200' })],
      '2026-09-19',
    )
    const [c] = classificarCargas(s, cargasAgendadas(linhas), cargaDe, { hoje: '2026-09-19' })
    expect(c).toMatchObject({ situacao: 'planejada', foraDoPrazo: true })
    expect(c.produtos[0].ordensNoPrazo.map((o) => o.numero)).toEqual(['100'])
    expect(c.produtos[0].ordensForaDoPrazo.map((o) => o.numero)).toEqual(['200'])
    expect(c.produtos[0].ordens).toHaveLength(2)
  })

  it('a regua e o primeiro caminhao DESCOBERTO: caminhao coberto por estoque nao entra nela', () => {
    // caso da revisão: caminhões de 10 bg em 10/09 e 20/09, estoque 10 (cobre o
    // 1º inteiro), ordem A 5 bg em 15/09 e B 5 bg em 25/09. A chega a tempo do
    // único caminhão descoberto (20/09); só B está fora do prazo — com o 1º
    // caminhão da carga como régua, A saía "fora do prazo" apontando um
    // caminhão sem problema nenhum
    const linhas2 = [agc({ id: 'a', carga: '1', data: '2026-09-10' }), agc({ id: 'b', carga: '1', data: '2026-09-20' })]
    const s2 = saldosExpedicao(linhas2, [], pa(10), [prod(5, '2026-09-15', { numero: 'A' }), prod(5, '2026-09-25', { numero: 'B' })], '2026-09-05')
    const [c2] = classificarCargas(s2, cargasAgendadas(linhas2), cargaDe, { hoje: '2026-09-05' })
    expect(c2).toMatchObject({ situacao: 'planejada', foraDoPrazo: true, ordemForaDoPrazo: true, garantido: 15, planejado: 20 })
    expect(c2.produtos[0].ateQuando).toBe('2026-09-20')
    expect(c2.produtos[0].ordensNoPrazo.map((o) => o.numero)).toEqual(['A'])
    expect(c2.produtos[0].ordensForaDoPrazo.map((o) => o.numero)).toEqual(['B'])

    // sem estoque, caminhões de 5 bg em 10 e 20/09 e uma ordem de 10 bg em 15/09:
    // o 1º caminhão já está descoberto, e a ordem não chega para ele
    const linhas = [agc({ id: 'a', carga: '1', data: '2026-09-10', bags: 5 }), agc({ id: 'b', carga: '1', data: '2026-09-20', bags: 5 })]
    const s = saldosExpedicao(linhas, [], [], [prod(10, '2026-09-15', { numero: '300' })], '2026-09-01')
    const [c] = classificarCargas(s, cargasAgendadas(linhas), cargaDe, { hoje: '2026-09-01' })
    expect(c).toMatchObject({ situacao: 'planejada', foraDoPrazo: true, garantido: 5, planejado: 10 })
    expect(c.produtos[0].ateQuando).toBe('2026-09-10')
    expect(c.produtos[0].ordensForaDoPrazo.map((o) => o.numero)).toEqual(['300'])
  })

  it('carga mista (um produto com data, outro sem): as duas etiquetas saem por produto, nao por carga', () => {
    // caso da revisão: NEO700 em 10/09 coberto por estoque; NEO680 sem DATA
    // AGENDADA e com ordem 400 programada para amanhã. A ordem não tem culpa: o
    // agendamento é que não tem data — só ordem iniciada garante
    const linhas = [
      agc({ id: 'a', carga: '1', data: '2026-09-10' }),
      agc({ id: 'b', carga: '1', data: null, cultivar: 'NEO680 IPRO' }),
    ]
    const s = saldosExpedicao(
      linhas, [], pa(10),
      [prod(10, '2026-09-06', { numero: '400', cultivar: 'NEO680 IPRO' })], '2026-09-05',
    )
    const [c] = classificarCargas(s, cargasAgendadas(linhas), cargaDe, { hoje: '2026-09-05' })
    expect(c).toMatchObject({ situacao: 'planejada', foraDoPrazo: true, ordemForaDoPrazo: false, caminhaoSemData: true })
    const neo680 = c.produtos.find((p) => p.cultivar === 'NEO680 IPRO')!
    expect(neo680).toMatchObject({ caminhaoSemData: true, ateQuando: null })
    expect(neo680.ordensForaDoPrazo.map((o) => o.numero)).toEqual(['400'])
    expect(c.produtos.find((p) => p.cultivar === 'NEO700 I2X')).toMatchObject({ caminhaoSemData: false, ordensForaDoPrazo: [] })
  })

  it('o recorte por carga isenta embalagem sem de-para como o cartao: nada de "40 bg sem ordem"', () => {
    const conhecida = (e: string) => e === 'BG5M' || e === 'MEIOBAG'
    const linhas = [agc({ id: 'a', carga: '1', embalagem: 'BB1M', bags: 40 }), agc({ id: 'b', carga: '1', bags: 10 })]
    const s = saldosExpedicao(linhas, [], pa(10), [])
    const r = recorteDaSelecao(s, (c) => c.carga === '1', cargaDe, conhecida)
    const bb1m = r.produtos.find((p) => p.embalagem === 'BB1M')!
    expect(bb1m).toMatchObject({ semDePara: true, agendado: 40, aProduzir: 0, semOrdem: 0, descoberto: 0 })
    expect(r).toMatchObject({ aProduzir: 0, descoberto: 0, bagsSemDePara: 40 })
    // e bate com o cartão de cargas
    const [c] = classificarCargas(s, cargasAgendadas(linhas), cargaDe, { embalagemConhecida: conhecida })
    expect(c).toMatchObject({ situacao: 'atende', semOrdem: 0, bagsSemDePara: 40 })
    // sem o predicado, continua como sempre foi
    expect(recorteDaSelecao(s, (x) => x.carga === '1', cargaDe).produtos.find((p) => p.embalagem === 'BB1M')).toMatchObject({ semDePara: false, semOrdem: 40 })
  })

  it('a carga anterior leva o planejado primeiro: 15 de ordem para duas cargas de 10', () => {
    const linhas = [agc({ id: 'a', carga: '1', data: '2026-09-08' }), agc({ id: 'b', carga: '2', data: '2026-09-10' })]
    const s = saldosExpedicao(linhas, [], [], [prod(15, '2026-09-07')], '2026-09-01')
    const r = classificarCargas(s, cargasAgendadas(linhas), cargaDe)
    expect(r.map((c) => [c.carga, c.situacao, c.planejado, c.semOrdem])).toEqual([
      ['1', 'planejada', 10, 0], ['2', 'falta-planejar', 5, 5],
    ])
  })

  it('particao: bags e garantido batem com a carga agendada e com resumoDoGrupo, estoque com o recorte', () => {
    const linhas = [
      agc({ id: 'a', carga: '1', data: '2026-09-08', bags: 40 }),
      agc({ id: 'b', carga: null, data: '2026-09-09', bags: 30 }),
      agc({ id: 'c', carga: '2', data: '2026-09-10', bags: 60 }),
      agc({ id: 'd', carga: '2', data: '2026-09-10', bags: 5, tratamento: 'SEM TSI' }),
    ]
    const s = saldosExpedicao(
      linhas, [{ cultivar: 'NEO700 I2X', bags: 2 }], pa(50), [prod(30, '2026-09-09')], '2026-09-01',
      (c) => c.carga ?? '',
    )
    const cargas = cargasAgendadas(linhas)
    const r = classificarCargas(s, cargas, cargaDe)
    expect(r).toHaveLength(2)
    for (const c of r) {
      const ag = cargas.find((x) => x.carga === c.carga)!
      expect(c.produtos.reduce((t, p) => t + p.bags, 0)).toBe(ag.bags)
      expect(c.garantido).toBe(resumoDoGrupo(s, (x) => x.carga === c.carga).coberto)
      expect(c.estoque).toBe(recorteDaSelecao(s, (x) => x.carga === c.carga, cargaDe).temHoje)
    }
    // por produto: cargas + sem carga = a consolidada
    const ftz = s.find((x) => !x.semTsi)!
    const somaCargas = r.reduce((t, c) => t + (c.produtos.find((p) => !p.semTsi)?.planejado ?? 0), 0)
    const semCarga = ftz.caminhoes.filter((c) => !c.caminhao.carga).reduce((t, c) => t + c.cobertoPlanejado, 0)
    expect(somaCargas + semCarga).toBe(Math.min(ftz.agendado, ftz.estoque + ftz.producaoPrevista))
    // a carga 2 tem os dois produtos: o tratado com 10 garantidos e a branca com 2
    const c2 = r.find((c) => c.carga === '2')!
    expect(c2).toMatchObject({ garantido: 12, estoque: 2, situacao: 'falta-planejar', semOrdem: 50, semLote: 3 })
  })

  it('recorte.semOrdem e da selecao: a 2a carga de 10 com 15 de ordem fica com 5 sem ordem', () => {
    const linhas = [agc({ id: 'a', carga: '1', data: '2026-09-08' }), agc({ id: 'b', carga: '2', data: '2026-09-10' })]
    const s = saldosExpedicao(linhas, [], [], [prod(15, '2026-09-07')], '2026-09-01')
    const r = recorteDaSelecao(s, (c) => c.carga === '2', cargaDe)
    expect(r.produtos[0].planejado).toBe(5)
    expect(r.produtos[0].semOrdem).toBe(5) // antes: max(0, 10 − 15) = 0, a ordem contada duas vezes
    expect(r.produtos[0].programado).toBe(15) // o produto inteiro continua informado
    expect(recorteDaSelecao(s, (c) => c.carga === '1', cargaDe).produtos[0].semOrdem).toBe(0)
  })

  it('SEM TSI sem lote sai em semLote, nunca em semOrdem; a embalagem e a da carga, nao a do periodo', () => {
    const linhas = [
      agc({ id: 'a', carga: '1', tratamento: 'SEM TSI', bags: 10 }),
      agc({ id: 'b', carga: '2', tratamento: 'SEM TSI', embalagem: 'MEIOBAG', bags: 1, data: '2026-09-11' }),
    ]
    const s = saldosExpedicao(linhas, [{ cultivar: 'NEO700 I2X', bags: 3 }], [], [])
    expect(s[0].embalagem).toBe('BG5M + MEIOBAG') // a consolidada junta o cultivar inteiro
    const [c1, c2] = classificarCargas(s, cargasAgendadas(linhas), cargaDe)
    expect(c1).toMatchObject({ situacao: 'falta-planejar', semLote: 7, semOrdem: 0, foraDoPrazo: false })
    expect(c1.produtos[0].semTsi).toBe(true)
    expect(c1.produtos[0].embalagem).toBe('BG5M') // só o que ESTA carga pede
    expect(c2.produtos[0].embalagem).toBe('MEIOBAG')
  })

  it('embalagem sem de-para fica fora da conta: nao vira falta nem sem ordem', () => {
    const conhecida = (e: string) => e === 'BG5M' || e === 'MEIOBAG'
    // 40 bg em BB1M (sem de-para) + 10 bg BG5M com estoque 10: a carga atende o
    // que dá para avaliar, e os 40 saem etiquetados, não como "sem ordem"
    const linhas = [
      agc({ id: 'a', carga: '1', embalagem: 'BB1M', bags: 40 }),
      agc({ id: 'b', carga: '1', bags: 10 }),
      agc({ id: 'c', carga: '2', embalagem: 'BB1M', bags: 7, data: '2026-09-11' }),
    ]
    const s = saldosExpedicao(linhas, [], pa(10), [])
    const [c1, c2] = classificarCargas(s, cargasAgendadas(linhas), cargaDe, { embalagemConhecida: conhecida })
    expect(c1).toMatchObject({ situacao: 'atende', bagsSemDePara: 40, semOrdem: 0, semLote: 0 })
    const bb1m = c1.produtos.find((p) => p.embalagem === 'BB1M')!
    expect(bb1m).toMatchObject({ semDePara: true, bags: 40, falta: 0 })
    // carga só de embalagem desconhecida: não dá para avaliar
    expect(c2).toMatchObject({ situacao: 'sem-de-para', bagsSemDePara: 7, semOrdem: 0, foraDoPrazo: false })
    // sem o predicado, tudo é conhecido e o BB1M vira falta como qualquer outro
    expect(classificarCargas(s, cargasAgendadas(linhas), cargaDe)[0]).toMatchObject({ situacao: 'falta-planejar', semOrdem: 40 })
  })

  it('produtos em falta primeiro; saida na ordem das cargas; nao muta os saldos', () => {
    const linhas = [
      agc({ id: 'a', carga: '9', data: '2026-09-10', bags: 10 }),
      agc({ id: 'b', carga: '9', data: '2026-09-10', bags: 4, cultivar: 'NEO680 IPRO' }),
      agc({ id: 'c', carga: '10', data: '2026-09-08', bags: 1 }),
    ]
    const s = saldosExpedicao(linhas, [], pa(11), [])
    const cargas = cargasAgendadas(linhas)
    const antes = JSON.stringify(s)
    const r = classificarCargas(s, cargas, cargaDe)
    expect(JSON.stringify(s)).toBe(antes)
    expect(r.map((c) => c.carga)).toEqual(['10', '9'])
    const c9 = r.find((c) => c.carga === '9')!
    expect(c9.produtos.map((p) => [p.cultivar, p.falta])).toEqual([['NEO680 IPRO', 4], ['NEO700 I2X', 0]])
    expect(c9.situacao).toBe('falta-planejar')
    expect(r.find((c) => c.carga === '10')!.situacao).toBe('atende')
  })

  it('carga que a fila nao conhece conta como sem nada', () => {
    const s = saldosExpedicao([agc({ id: 'a', carga: '1' })], [], pa(10), [])
    const [c] = classificarCargas(s, [{ carga: '99', datas: [], clientes: [], status: [], linhas: 1, bags: 8 }], cargaDe)
    expect(c).toMatchObject({ situacao: 'falta-planejar', planejado: 0, produtos: [], caminhaoSemData: false })
  })

  it('arred2: 0,3 + 0,6 fecha com 0,9 e a carga atende', () => {
    const linhas = [agc({ id: 'a', carga: '1', bags: 0.3 }), agc({ id: 'b', carga: '1', bags: 0.6 })]
    const s = saldosExpedicao(linhas, [], pa(0.9), [])
    const [c] = classificarCargas(s, cargasAgendadas(linhas), cargaDe)
    expect(c.situacao).toBe('atende')
  })

  it('chaveProduto: normaliza cultivar e tratamento, embalagem estrita, SEM TSI so pelo cultivar', () => {
    expect(chaveProduto({ cultivar: 'neo700  i2x', tratamento: 'ftz60+vic', embalagem: 'BG5M' }))
      .toBe(chaveProduto({ cultivar: 'NEO700 I2X', tratamento: 'FTZ60 + VIC', embalagem: 'BG5M' }))
    expect(chaveProduto({ cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M' }))
      .not.toBe(chaveProduto({ cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'MEIOBAG' }))
    expect(chaveProduto({ cultivar: 'NEO700 I2X', tratamento: 'SEM TSI', embalagem: 'BG5M' }))
      .toBe(chaveProduto({ cultivar: 'NEO700 I2X', tratamento: 'sem tsi', embalagem: 'MEIOBAG' }))
    expect(chaveProduto({ cultivar: 'NEO700 I2X', tratamento: 'SEM TSI', embalagem: 'BG5M' }))
      .not.toBe(chaveProduto({ cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M' }))
    // FTZ60 S / FTZ 60 S (achado do Arion, 19/09/2026): mesma chave em
    // qualquer tela que use chaveProduto (Cargas, Ordens sem caminhão)
    expect(chaveProduto({ cultivar: 'NEO700 I2X', tratamento: 'FTZ60 S', embalagem: 'BG5M' }))
      .toBe(chaveProduto({ cultivar: 'NEO700 I2X', tratamento: 'FTZ 60 S', embalagem: 'BG5M' }))
  })
})
