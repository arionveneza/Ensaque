import { describe, expect, it } from 'vitest'
import {
  converterPedidos,
  converterSaldos,
  ehRelatorioPedidos,
  ehRelatorioSaldos,
  normalizaCultivar,
  num,
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
  it('mantem apenas pedido firme: Aprovado ou Integrado', () => {
    const r = converterPedidos([
      CAB_PEDIDOS,
      pedido('Integrado', 'Aprovado', '761 I2X - 761 I2X', 'FTZ60', 'BB5M', 10),
      pedido('Aprovado', 'Aprovado', '761 I2X - 761 I2X', 'FTZ60', 'BB5M', 7),
      pedido('Em cotação', 'Aprovado', '761 I2X - 761 I2X', 'FTZ60', 'BB5M', 99),
      pedido('Cancelado', 'Aprovado', '761 I2X - 761 I2X', 'FTZ60', 'BB5M', 99),
      pedido('Aguardando Aprovação', 'Aprovado', '761 I2X - 761 I2X', 'FTZ60', 'BB5M', 99),
      pedido('Reprovado', 'Aprovado', '761 I2X - 761 I2X', 'FTZ60', 'BB5M', 99),
    ])
    expect(r.totalAprovado).toBe(17)
    expect(r.resumo.foraStatus).toBe(4)
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

  it('reconhece a embalagem independente de caixa', () => {
    const r = converterPedidos([
      CAB_PEDIDOS,
      pedido('Integrado', 'Aprovado', 'X - X', 'FTZ60', 'bmb', 20),
      pedido('Integrado', 'Aprovado', 'X - X', 'FTZ60', ' BMB ', 5),
    ])
    expect(r.linhas).toHaveLength(1)
    expect(r.linhas[0].embalagem).toBe('MEIOBAG')
    expect(r.linhas[0].bags).toBe(25)
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

  // Uma renomeação de status na origem descartaria o arquivo inteiro em
  // silêncio, e o painel mostraria zero demanda como se não houvesse pedido.
  it('reconhece o status independente de caixa e acento', () => {
    const r = converterPedidos([
      CAB_PEDIDOS,
      pedido('INTEGRADO', 'APROVADO', 'X - X', 'FTZ60', 'BB5M', 10),
      pedido('integrado', 'aprovado', 'X - X', 'FTZ60', 'BB5M', 5),
    ])
    expect(r.totalAprovado).toBe(15)
    expect(r.resumo.foraStatus).toBe(0)
  })

  it('nao aprovado nao vira aprovado por descuido de acento', () => {
    const r = converterPedidos([
      CAB_PEDIDOS,
      pedido('Integrado', 'NAO APROVADO', 'X - X', 'FTZ60', 'BB5M', 40),
    ])
    expect(r.totalAprovado).toBe(0)
    expect(r.totalPendente).toBe(40)
  })

  it('detalha o descarte por status, so o que era trabalho de TSI', () => {
    const r = converterPedidos([
      CAB_PEDIDOS,
      pedido('Aguardando Aprovação', 'Aprovado', 'X - X', 'FTZ60', 'BB5M', 119),
      pedido('Cancelado', 'Aprovado', 'X - X', 'FTZ60', 'BB5M', 30),
      // ruído: descartado, mas não era trabalho de TSI nenhum
      pedido('Cancelado', 'Aprovado', 'X - X', 'SEM TSI', 'BB5M', 900),
      pedido('Cancelado', 'Aprovado', 'X - X', 'FTZ60', 'BB5M', 0),
    ])
    expect(r.resumo.foraStatus).toBe(4)
    expect(r.resumo.porStatusFora).toEqual({
      'Aguardando Aprovação': { linhas: 1, bags: 119 },
      Cancelado: { linhas: 1, bags: 30 },
    })
  })

  it('registra os valores de status financeiro que apareceram', () => {
    const r = converterPedidos([
      CAB_PEDIDOS,
      pedido('Integrado', 'Aprovado', 'X - X', 'FTZ60', 'BB5M', 10),
      pedido('Integrado', 'Não Aprovado', 'X - X', 'FTZ60', 'BB5M', 35),
    ])
    expect(r.resumo.porStatusFinanceiro).toEqual({
      Aprovado: 10,
      'Não Aprovado': 35,
    })
  })

  it('aceita saldo com virgula decimal', () => {
    const r = converterPedidos([
      CAB_PEDIDOS,
      pedido('Integrado', 'Aprovado', 'X - X', 'FTZ60', 'BB5M', '12,5'),
    ])
    expect(r.totalAprovado).toBe(12.5)
  })

  it('corrige cultivar truncado tambem no relatorio de Pedidos, nao so em Saldos', () => {
    const r = converterPedidos([
      CAB_PEDIDOS,
      pedido('Integrado', 'Aprovado', 'O700 I2X - O700 I2X', 'FTZ60', 'BB5M', 10),
    ])
    expect(r.linhas[0].cultivar).toBe('NEO700 I2X')
  })

  it('marca VENDA COOPERADO pela coluna Tipo Venda e separa em linha propria', () => {
    const CAB_COM_TIPO = [...CAB_PEDIDOS, 'Tipo Venda']
    const r = converterPedidos([
      CAB_COM_TIPO,
      [...pedido('Integrado', 'Aprovado', 'X - X', 'FTZ60', 'BB5M', 80), 'VENDA DISTRIBUIDOR'],
      [...pedido('Integrado', 'Aprovado', 'X - X', 'FTZ60', 'BB5M', 20), 'VENDA COOPERADO'],
    ])
    // mesma combinacao, flags diferentes: duas linhas — como aprovado ja faz
    expect(r.linhas).toHaveLength(2)
    const coop = r.linhas.find((l) => l.cooperado)
    const normal = r.linhas.find((l) => !l.cooperado)
    expect(coop?.bags).toBe(20)
    expect(normal?.bags).toBe(80)
    expect(r.resumo.bagsCooperado).toBe(20)
    // o total da combinacao continua 100 — so a marcacao divide
    expect(r.totalAprovado).toBe(100)
  })

  it('sem a coluna Tipo Venda (export antigo), nada vira cooperado', () => {
    const r = converterPedidos([
      CAB_PEDIDOS,
      pedido('Integrado', 'Aprovado', 'X - X', 'FTZ60', 'BB5M', 10),
    ])
    expect(r.linhas[0].cooperado).toBe(false)
    expect(r.resumo.bagsCooperado).toBe(0)
  })
})

describe('num: os tres formatos que as origens mandam', () => {
  it('celula numerica de verdade passa direto, com decimal intacto', () => {
    expect(num(176.4)).toBe(176.4)
    expect(num(161)).toBe(161)
  })

  it('texto brasileiro: ponto de milhar, virgula decimal', () => {
    expect(num('1.234,56')).toBe(1234.56)
    expect(num('1.234')).toBe(1234)
    expect(num('12,5')).toBe(12.5)
  })

  // O PMS do SAP vinha "161.0" e o parser brasileiro removia o ponto como
  // milhar: 161 virava 1610, e TODOS os pesos das ordens desses lotes
  // saíam 10x maiores (ordem 134299, 24/08/2026)
  it('texto com ponto decimal (SAP): 1-2 digitos depois do ponto e sem virgula', () => {
    expect(num('161.0')).toBe(161)
    expect(num('176.45')).toBe(176.45)
    expect(num('-3.5')).toBe(-3.5)
  })

  it('vazio e lixo dao zero', () => {
    expect(num('')).toBe(0)
    expect(num(null)).toBe(0)
    expect(num('abc')).toBe(0)
  })
})

describe('normalizaCultivar', () => {
  it('colapsa espaco e caixa alta', () => {
    expect(normalizaCultivar('  761   i2x ')).toBe('761 I2X')
  })

  it('corrige apelidos conhecidos (achado no relatorio de Pedidos, 20/08/2026)', () => {
    expect(normalizaCultivar('O700 I2X')).toBe('NEO700 I2X')
    expect(normalizaCultivar('o700 i2x')).toBe('NEO700 I2X')
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

  // Caso real: pedidos dizem NEO900, saldos dizem O900 na coluna CULTIVAR —
  // mas o nome do produto tem o nome completo. Sem corrigir, o balanço nunca
  // casa demanda com estoque para esses cultivares. Usa um cultivar
  // SINTÉTICO (não o O700 I2X real, que agora entra pelo de-para estático
  // de `normalizaCultivar` antes mesmo de chegar aqui) pra continuar
  // testando o mecanismo DINÂMICO, que é o que pega os casos ainda
  // desconhecidos.
  it('recupera cultivar truncado pelo nome do produto (mecanismo dinamico, caso ainda nao mapeado)', () => {
    const r = converterSaldos([
      CAB_SALDOS,
      saldo('SS NEO900 XYZ BB5M', 'O900 XYZ', 'SV001', 'SEM TSI', 171, 7),
    ])
    expect(r.lotes[0].cultivar).toBe('NEO900 XYZ')
    expect(r.resumo.cultivarCorrigidos).toEqual({ 'O900 XYZ → NEO900 XYZ': 1 })
  })

  it('cultivar ja conhecido (O700 I2X) chega corrigido pelo de-para estatico, antes do mecanismo dinamico', () => {
    const r = converterSaldos([
      CAB_SALDOS,
      saldo('SS NEO700 I2X BB5M', 'O700 I2X', 'SV001', 'SEM TSI', 171, 7),
    ])
    expect(r.lotes[0].cultivar).toBe('NEO700 I2X')
    // já veio certo do de-para estático — o dinâmico não tem mais nada a corrigir aqui
    expect(r.resumo.cultivarCorrigidos).toEqual({})
  })

  it('corrige tambem no estoque de produto acabado', () => {
    const r = converterSaldos([
      CAB_SALDOS,
      saldo('SS NEO801 CE BB5M', 'O801 CE', 'SV002', 'FTZ60', 171, 5),
    ])
    expect(r.estoquePa[0].cultivar).toBe('NEO801 CE')
  })

  it('nao inventa correcao quando o nome nao termina com o cultivar', () => {
    const r = converterSaldos([
      CAB_SALDOS,
      saldo('SS OUTRACOISA BB5M', 'NEO771 I2X', 'SV003', 'SEM TSI', 171, 4),
    ])
    // sem relação entre nome e coluna: fica a coluna, sem mexer
    expect(r.lotes[0].cultivar).toBe('NEO771 I2X')
    expect(r.resumo.cultivarCorrigidos).toEqual({})
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
