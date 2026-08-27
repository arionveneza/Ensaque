import { describe, expect, it } from 'vitest'
import {
  calcularMrp, chaveCombinacao, conferirCadastro, cruzarEstoqueQuimico,
  estoqueSapPorCombinacao, pesoRefBagKg,
  type EstoqueQuimicoItem, type NecessidadeProduto,
} from './mrp'
import type { BalancoLinha, EmbalagemLinha, ReceitaCompleta } from '@/dados/api-gestao'

const EMBALAGENS: EmbalagemLinha[] = [
  { codigo: 'BG5M', codigo_ext: 'BB5M', descricao: 'Bag', sementes: 5000000, fator_peso: 5, peso_fixo_kg: null },
  { codigo: 'MEIOBAG', codigo_ext: 'BMB', descricao: 'Meio', sementes: 2500000, fator_peso: 2.5, peso_fixo_kg: null },
  { codigo: 'SC10', codigo_ext: null, descricao: 'Saco 10', sementes: null, fator_peso: null, peso_fixo_kg: 10 },
]

const balanco = (parcial: Partial<BalancoLinha>): BalancoLinha => ({
  cultivar: 'CULT',
  tratamento: 'FTZ60',
  embalagem: 'BG5M',
  pedido_aprovado: 0,
  pedido_pendente: 0,
  estoque_pa: 0,
  ordens_abertas: 0,
  saldo: 0,
  receita_cadastrada: true,
  ...parcial,
})

// FTZ60 real: valores conferidos contra o banco em 27/08/2026
const FTZ60: ReceitaCompleta = {
  id: 'r1',
  nome: 'FTZ60',
  ativa: true,
  receita_itens: [
    { produto_id: 'p1', dose: 250, produtos_quimicos: { codigo: 'INS00021', nome: 'DISCO BLACK', unidade: 'ml/100kg', densidade: 1.13 } },
    { produto_id: 'p2', dose: 300, produtos_quimicos: { codigo: 'INS00039', nome: 'FLUIDUS F047 PO SECANTE', unidade: 'g/100kg', densidade: null } },
  ],
}

describe('pesoRefBagKg', () => {
  it('usa o peso de referência do PCP para embalagem por sementes', () => {
    expect(pesoRefBagKg('BG5M', EMBALAGENS)).toBe(850)
    expect(pesoRefBagKg('MEIOBAG', EMBALAGENS)).toBe(425)
  })

  it('usa o peso fixo do cadastro quando existe', () => {
    expect(pesoRefBagKg('SC10', EMBALAGENS)).toBe(10)
  })

  it('embalagem desconhecida não tem referência', () => {
    expect(pesoRefBagKg('OUTRA', EMBALAGENS)).toBeNull()
  })
})

describe('calcularMrp', () => {
  it('converte bags em kg de semente e aplica a dose da receita', () => {
    const r = calcularMrp(
      [balanco({ saldo: 10 })], // 10 bags × 850 kg = 8.500 kg de semente
      [FTZ60],
      EMBALAGENS,
    )
    expect(r.combinacoes).toHaveLength(1)
    expect(r.combinacoes[0].kgSemente).toBe(8500)

    // DISCO BLACK: 250 ml/100kg × 8500 kg × 1,13 ÷ 1000 ÷ 100 = 24,0125 kg
    const disco = r.produtos.find((p) => p.nome === 'DISCO BLACK')!
    expect(disco.totalKg).toBeCloseTo(24.0125, 4)
    // e em litros, sem densidade: 250 × 8500 ÷ 1000 ÷ 100 = 21,25 L
    expect(disco.totalL).toBeCloseTo(21.25, 4)

    // FLUIDUS (pó): 300 g/100kg × 8500 ÷ 1000 ÷ 100 = 25,5 kg, sem litros
    const fluidus = r.produtos.find((p) => p.nome === 'FLUIDUS F047 PO SECANTE')!
    expect(fluidus.totalKg).toBeCloseTo(25.5, 4)
    expect(fluidus.totalL).toBeNull()

    expect(r.totais.bags).toBe(10)
    expect(r.totais.kgSemente).toBe(8500)
  })

  it('pedido aguardando aprovação entra como parcela separada', () => {
    const r = calcularMrp(
      [balanco({ saldo: 10, pedido_pendente: 4 })],
      [FTZ60],
      EMBALAGENS,
    )
    const c = r.combinacoes[0]
    expect(c.bags).toBe(10)
    expect(c.bagsAguardando).toBe(4)
    expect(c.kgSementeAguardando).toBe(4 * 850)

    const disco = r.produtos.find((p) => p.nome === 'DISCO BLACK')!
    expect(disco.totalKg).toBeCloseTo((250 * 8500 * 1.13) / 1000 / 100, 4)
    expect(disco.totalKgAguardando).toBeCloseTo((250 * 3400 * 1.13) / 1000 / 100, 4)
    expect(disco.totalLAguardando).toBeCloseTo((250 * 3400) / 1000 / 100, 4)

    expect(r.totais.bagsAguardando).toBe(4)
    expect(r.totais.kgQuimicoAguardando).toBeGreaterThan(0)
  })

  it('sobra de estoque abate o aguardando antes de gerar necessidade', () => {
    // aprovado coberto com 5 de sobra (saldo -5); pendente de 8 só precisa de 3
    const r = calcularMrp(
      [balanco({ saldo: -5, pedido_pendente: 8 })],
      [FTZ60],
      EMBALAGENS,
    )
    const c = r.combinacoes[0]
    expect(c.bags).toBe(0)
    expect(c.bagsAguardando).toBe(3)
  })

  it('carrega as parcelas da equação pro detalhamento da tela', () => {
    // o caso real do 761 I2X (27/08/2026): pedido 45, estoque 45 → falta 0,
    // mas o pedido e o estoque precisam aparecer na linha
    const r = calcularMrp(
      [balanco({ pedido_aprovado: 45, pedido_pendente: 54, estoque_pa: 45, saldo: 0 })],
      [FTZ60],
      EMBALAGENS,
    )
    const c = r.combinacoes[0]
    expect(c.pedidoAprovado).toBe(45)
    expect(c.pedidoPendente).toBe(54)
    expect(c.estoquePa).toBe(45)
    expect(c.ordensAbertas).toBe(0)
    expect(c.bags).toBe(0)
    expect(c.bagsAguardando).toBe(54)
  })

  it('só pendente, sem descoberto firme, ainda entra na conta', () => {
    const r = calcularMrp([balanco({ saldo: 0, pedido_pendente: 6 })], [FTZ60], EMBALAGENS)
    expect(r.combinacoes).toHaveLength(1)
    expect(r.combinacoes[0].bags).toBe(0)
    expect(r.combinacoes[0].bagsAguardando).toBe(6)
    expect(r.totais.kgQuimico).toBe(0)
    expect(r.totais.kgQuimicoAguardando).toBeGreaterThan(0)
  })

  it('soma o mesmo produto usado por combinações diferentes', () => {
    const r = calcularMrp(
      [
        balanco({ cultivar: 'A', saldo: 10 }),
        balanco({ cultivar: 'B', saldo: 10, embalagem: 'MEIOBAG' }),
      ],
      [FTZ60],
      EMBALAGENS,
    )
    const disco = r.produtos.find((p) => p.nome === 'DISCO BLACK')!
    // A: 8500 kg · B: 4250 kg → 12.750 kg de semente no total
    expect(disco.totalKg).toBeCloseTo((250 * 12750 * 1.13) / 1000 / 100, 4)
    expect(disco.combinacoes).toHaveLength(2)
  })

  it('saldo coberto (<= 0) sem pendente não entra', () => {
    const r = calcularMrp([balanco({ saldo: 0 }), balanco({ saldo: -5 })], [FTZ60], EMBALAGENS)
    expect(r.combinacoes).toHaveLength(0)
    expect(r.produtos).toHaveLength(0)
  })

  it('SEM TSI não consome químico e fica fora sem virar aviso', () => {
    const r = calcularMrp([balanco({ tratamento: 'SEM TSI', saldo: 10 })], [FTZ60], EMBALAGENS)
    expect(r.combinacoes).toHaveLength(0)
    expect(r.semReceita).toHaveLength(0)
  })

  it('tratamento sem receita cadastrada vira aviso, não conta', () => {
    const r = calcularMrp(
      [balanco({ tratamento: 'STANDAK TOP', saldo: 8, pedido_pendente: 2, receita_cadastrada: false })],
      [FTZ60],
      EMBALAGENS,
    )
    expect(r.combinacoes).toHaveLength(0)
    expect(r.semReceita).toEqual([
      { cultivar: 'CULT', tratamento: 'STANDAK TOP', embalagem: 'BG5M', bags: 8, bagsAguardando: 2 },
    ])
  })

  it('embalagem sem peso de referência vira aviso próprio', () => {
    const r = calcularMrp([balanco({ embalagem: 'BGNOVA', saldo: 5 })], [FTZ60], EMBALAGENS)
    expect(r.combinacoes).toHaveLength(0)
    expect(r.semPesoRef).toEqual([
      { cultivar: 'CULT', tratamento: 'FTZ60', embalagem: 'BGNOVA', bags: 5, bagsAguardando: 0 },
    ])
  })

  it('estoqueSapPorCombinacao soma o produto tratado por cultivar + tratamento', () => {
    const mapa = estoqueSapPorCombinacao([
      { cultivar: '761 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 40 },
      // outra embalagem da MESMA combinação soma junto
      { cultivar: '761 I2X', tratamento: 'FTZ60', embalagem: 'MEIOBAG', bags: 3 },
      { cultivar: '761 I2X', tratamento: 'FTZ60 + VIC', embalagem: 'BG5M', bags: 9 },
      { cultivar: 'NEO750 IPRO', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 34 },
    ])
    expect(mapa.get(chaveCombinacao('761 I2X', 'FTZ60'))).toBe(43)
    expect(mapa.get(chaveCombinacao('761 I2X', 'FTZ60 + VIC'))).toBe(9)
    expect(mapa.get(chaveCombinacao('NEO750 IPRO', 'FTZ60'))).toBe(34)
    expect(mapa.has(chaveCombinacao('NEO750 IPRO', 'FTZ60 + VIC'))).toBe(false)
  })

  it('conferirCadastro: receita sem pedido e pedido sem receita, nos dois sentidos', () => {
    const receitas: ReceitaCompleta[] = [
      FTZ60,
      { id: 'r2', nome: 'V&P', ativa: true, receita_itens: [] },
      { id: 'r3', nome: 'SEM TSI', ativa: true, receita_itens: [] },
    ]
    const r = conferirCadastro(
      [
        // FTZ60 tem pedido aprovado → não é "sem pedido"
        balanco({ pedido_aprovado: 10, saldo: 10 }),
        // STANDAK TOP vendido em 2 combinações, sem receita → pedido órfão agregado
        balanco({ cultivar: 'A', tratamento: 'STANDAK TOP', pedido_aprovado: 5, receita_cadastrada: false }),
        balanco({ cultivar: 'B', tratamento: 'STANDAK TOP', pedido_pendente: 3, receita_cadastrada: false }),
        // linha só de estoque, sem pedido nenhum: não salva a receita da lista
        balanco({ tratamento: 'V&P', estoque_pa: 7 }),
        // SEM TSI com pedido não vira órfão (semente branca fica fora)
        balanco({ tratamento: 'SEM TSI', pedido_aprovado: 9, receita_cadastrada: false }),
      ],
      receitas,
    )
    // V&P só tem estoque — continua "sem pedido"; SEM TSI fica fora da lista
    expect(r.receitasSemPedido).toEqual(['V&P'])
    expect(r.pedidosSemReceita).toEqual([
      { tratamento: 'STANDAK TOP', bagsAprovado: 5, bagsPendente: 3, combinacoes: 2 },
    ])
  })

  it('produto em ml sem densidade cai como 0 kg, sem derrubar o cálculo', () => {
    const semDensidade: ReceitaCompleta = {
      id: 'r2',
      nome: 'X',
      ativa: true,
      receita_itens: [
        { produto_id: 'p3', dose: 100, produtos_quimicos: { codigo: 'NOVO', nome: 'NOVO', unidade: 'ml/100kg', densidade: null } },
      ],
    }
    const r = calcularMrp([balanco({ tratamento: 'X', saldo: 10 })], [semDensidade], EMBALAGENS)
    const novo = r.produtos.find((p) => p.nome === 'NOVO')!
    expect(novo.totalKg).toBe(0)
    expect(novo.totalL).toBeCloseTo(8.5, 4) // litros seguem calculáveis sem densidade
  })
})

describe('cruzarEstoqueQuimico', () => {
  const produto = (parcial: Partial<NecessidadeProduto>): NecessidadeProduto => ({
    codigo: 'X', nome: 'X', unidade: 'ml/100kg', densidade: 1.2,
    totalKg: 0, totalKgAguardando: 0, totalL: 0, totalLAguardando: 0,
    combinacoes: [],
    ...parcial,
  })
  const item = (nome: string, unidade: string, quantidade: number): EstoqueQuimicoItem => ({
    codigo_sap: 'INS', nome, unidade, quantidade, lotes: 1,
  })

  it('liquido compara em litros e diz o que falta comprar', () => {
    const cz = cruzarEstoqueQuimico(
      produto({ nome: 'DISCO BLACK', totalL: 100, totalLAguardando: 50 }),
      [item('DISCO BLACK', 'LT', 120)],
    )
    expect(cz.unidadeComparacao).toBe('L')
    expect(cz.disponivel).toBe(120)
    expect(cz.faltaFirme).toBe(0)          // 120 cobre os 100 firmes
    expect(cz.faltaTotal).toBe(30)         // 150 total - 120
    expect(cz.incompativel).toBe(false)
  })

  it('po compara em kg', () => {
    const cz = cruzarEstoqueQuimico(
      produto({ nome: 'FLUIDUS F047 PO SECANTE', unidade: 'g/100kg', densidade: null, totalKg: 500 }),
      [item('FLUIDUS F047 PO SECANTE', 'KG', 300)],
    )
    expect(cz.unidadeComparacao).toBe('kg')
    expect(cz.faltaFirme).toBe(200)
  })

  it('casa por nome nos tres niveis reais do export de 27/08/2026', () => {
    const estoque = [
      item('RANCONA T', 'LT', 439),                 // SAP estende o nome do app
      item('FORTENZA', 'LT', 1319.85),              // app estende o nome do SAP
      item('FORTENZA 1000 L', 'LT', 999),           // nao pode casar com FORTENZA 600 FS
      item('KELMAX RN', 'LT', 2766.73),
      item('ACRESCENT RAIZ F PLUS', 'LT', 774.15),
      item('ACRESCENT RAIZ', 'LT', 162.76),         // OUTRO produto — nao pode vazar
      item('DISCO BLACK', 'LT', 17469.91),
      item('DISCO BLACK (inativo)', 'KG', 55),      // exato vence; este fica de fora
    ]
    const caso = (nome: string) => cruzarEstoqueQuimico(produto({ nome, totalL: 1 }), estoque)
    expect(caso('RANCONA').disponivel).toBe(439)
    expect(caso('FORTENZA 600 FS').disponivel).toBe(1319.85)
    expect(caso('KELMAX RN BR').disponivel).toBe(2766.73)
    expect(caso('ACRESCENT RAIZ F').disponivel).toBe(774.15)
    expect(caso('ACRESCENT RAIZ F').nomesSap).toEqual(['ACRESCENT RAIZ F PLUS'])
    expect(caso('DISCO BLACK').disponivel).toBe(17469.91)
  })

  it('item achado com unidade errada marca incompativel em vez de somar', () => {
    const cz = cruzarEstoqueQuimico(
      produto({ nome: 'PROTETOR PREMIUM', totalL: 10 }),
      [item('PROTETOR PREMIUM', 'DOSES', 98)],
    )
    expect(cz.incompativel).toBe(true)
    expect(cz.disponivel).toBe(0)
  })

  it('sem nenhum item casando devolve disponivel null e falta cheia', () => {
    const cz = cruzarEstoqueQuimico(produto({ nome: 'INEXISTENTE', totalL: 10 }), [])
    expect(cz.disponivel).toBeNull()
    expect(cz.faltaFirme).toBe(10)
    expect(cz.incompativel).toBe(false)
  })
})
