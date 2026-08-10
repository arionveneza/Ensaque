import { describe, expect, it } from 'vitest'
import {
  calculaOee,
  capacidadeDiaT,
  checkFinalAprovado,
  consumoPorTanque,
  diaDeProducao,
  ensaquePorBagKg,
  montaTanques,
  produtosSemDestino,
  ocupacao,
  pesoBagKg,
  pesoItemKg,
  pesoOrdemKg,
  pesoQuimicoTotalKg,
  rendimentoTh,
  tempoPlanejadoS,
  temposOrdem,
  turnoDoInicio,
  volumeItemL,
} from './calculos'
import type {
  Embalagem,
  MotivoParada,
  Ordem,
  ProdutoQuimico,
  Receita,
} from './tipos'

const BG5M: Embalagem = {
  codigo: 'BG5M', codigoExt: 'BB5M', descricao: 'Bag 5 milhoes',
  sementes: 5_000_000, fatorPeso: 5,
}
const MEIOBAG: Embalagem = {
  codigo: 'MEIOBAG', codigoExt: 'BMB', descricao: 'Meio bag',
  sementes: 2_500_000, fatorPeso: 2.5,
}

// densidade em ml/kg e produto já dosado em peso
const FTZ: ProdutoQuimico = {
  id: 'FTZ', codigo: 'FTZ', nome: 'Fortenza Duo',
  unidade: 'ml/kg', densidade: 1.08,
}
const GRF: ProdutoQuimico = {
  id: 'GRF', codigo: 'GRF', nome: 'Grafite', unidade: 'g/kg', densidade: null,
}
const MXA: ProdutoQuimico = {
  id: 'MXA', codigo: 'MXA', nome: 'Maxim Advanced',
  unidade: 'ml/kg', densidade: 1.05,
}
const PRODUTOS = new Map([FTZ, GRF, MXA].map((p) => [p.id, p]))

describe('peso do bag', () => {
  it('PMS 171 em BB5M da 855 kg por bag', () => {
    expect(pesoBagKg(171, BG5M)).toBe(855)
  })

  it('meio bag usa fator 2,5', () => {
    expect(pesoBagKg(171, MEIOBAG)).toBe(427.5)
  })

  it('peso da ordem e bags x peso do bag', () => {
    expect(pesoOrdemKg(45, 855)).toBe(38_475)
  })
})

describe('peso de balanca a partir da dose', () => {
  it('ml/kg multiplica pela densidade', () => {
    // 0,60 ml/kg x 40.000 kg x 1,08 / 1000 = 25,92 kg
    expect(pesoItemKg({ produtoId: 'FTZ', dose: 0.6 }, FTZ, 40_000))
      .toBeCloseTo(25.92, 6)
  })

  it('g/kg nao usa densidade: a dose ja e peso', () => {
    // 0,50 g/kg x 40.000 kg / 1000 = 20 kg
    expect(pesoItemKg({ produtoId: 'GRF', dose: 0.5 }, GRF, 40_000))
      .toBeCloseTo(20, 6)
  })

  it('recusa produto em ml/kg sem densidade, em vez de assumir 1', () => {
    const semDensidade: ProdutoQuimico = { ...FTZ, densidade: null }
    expect(() =>
      pesoItemKg({ produtoId: 'FTZ', dose: 0.6 }, semDensidade, 40_000),
    ).toThrow(/densidade/i)
  })

  it('volume so existe para ml/kg', () => {
    expect(volumeItemL({ produtoId: 'FTZ', dose: 0.6 }, FTZ, 40_000))
      .toBeCloseTo(24, 6)
    expect(volumeItemL({ produtoId: 'GRF', dose: 0.5 }, GRF, 40_000))
      .toBeNull()
  })

  // As bulas de TSI costumam dosar por 100 kg de semente. A mesma dose
  // escrita nas duas bases tem que dar o MESMO peso de balança.
  it('ml/100kg divide por 100: 60 ml/100kg equivale a 0,6 ml/kg', () => {
    const ftz100: ProdutoQuimico = { ...FTZ, unidade: 'ml/100kg' }
    expect(pesoItemKg({ produtoId: 'FTZ', dose: 60 }, ftz100, 40_000))
      .toBeCloseTo(25.92, 6)
    expect(volumeItemL({ produtoId: 'FTZ', dose: 60 }, ftz100, 40_000))
      .toBeCloseTo(24, 6)
  })

  it('g/100kg divide por 100: 50 g/100kg equivale a 0,5 g/kg', () => {
    const grf100: ProdutoQuimico = { ...GRF, unidade: 'g/100kg' }
    expect(pesoItemKg({ produtoId: 'GRF', dose: 50 }, grf100, 40_000))
      .toBeCloseTo(20, 6)
    // dose em gramas segue sem volume
    expect(volumeItemL({ produtoId: 'GRF', dose: 50 }, grf100, 40_000))
      .toBeNull()
  })

  it('ml/100kg sem densidade tambem e recusado', () => {
    const semDensidade: ProdutoQuimico = { ...FTZ, unidade: 'ml/100kg', densidade: null }
    expect(() =>
      pesoItemKg({ produtoId: 'FTZ', dose: 60 }, semDensidade, 40_000),
    ).toThrow(/densidade/i)
  })
})

describe('ensaque', () => {
  it('soma ao peso do bag a margem de 0,5% e a parcela de quimico por bag', () => {
    // 855 kg de bag + 0,5% (4,275) + 100 kg de quimico em 40 bags (2,5)
    expect(ensaquePorBagKg(855, 100, 40)).toBeCloseTo(861.775, 6)
  })

  it('a margem incide so no peso do bag, nao no quimico', () => {
    // sem quimico: 1000 * 1,005
    expect(ensaquePorBagKg(1000, 0, 10)).toBeCloseTo(1005, 6)
  })

  it('ordem sem bags e erro, nao divisao por zero', () => {
    expect(() => ensaquePorBagKg(855, 100, 0)).toThrow()
  })
})

describe('tanques e mistura', () => {
  const receita6em5: Receita = {
    id: 'R6', nome: 'CORTEVA COMPLETO',
    itens: [
      { produtoId: 'FTZ', dose: 0.5 },
      { produtoId: 'MXA', dose: 0.2 },
      { produtoId: 'GRF', dose: 0.3 },
    ],
  }

  // a receita traz produto e dose; o TANQUE vem da escolha do operador
  const ALOC = [
    { produtoId: 'FTZ', tanque: 1 },
    { produtoId: 'MXA', tanque: 3 },
    { produtoId: 'GRF', tanque: 3 }, // mistura no tanque 3
  ]

  it('agrupa produtos do mesmo tanque em uma linha', () => {
    const tanques = montaTanques(receita6em5, ALOC)
    expect(tanques.map((t) => t.tanque)).toEqual([1, 3])
    expect(tanques[1].itens).toHaveLength(2)
  })

  it('a MESMA receita distribuida de outro jeito monta outros tanques', () => {
    const outra = [
      { produtoId: 'FTZ', tanque: 2 },
      { produtoId: 'MXA', tanque: 2 },
      { produtoId: 'GRF', tanque: 0 },
    ]
    const tanques = montaTanques(receita6em5, outra)
    expect(tanques.map((t) => t.tanque)).toEqual([0, 2])
    expect(tanques.find((t) => t.tanque === 2)!.itens).toHaveLength(2)
  })

  it('produto sem destino escolhido nao entra em tanque nenhum', () => {
    const parcial = [{ produtoId: 'FTZ', tanque: 1 }]
    expect(montaTanques(receita6em5, parcial).map((t) => t.tanque)).toEqual([1])
    expect(produtosSemDestino(receita6em5, parcial).sort()).toEqual(['GRF', 'MXA'])
    expect(produtosSemDestino(receita6em5, ALOC)).toEqual([])
  })

  it('planejado do tanque com mistura e a SOMA dos produtos', () => {
    const tanques = montaTanques(receita6em5, ALOC)
    const consumo = consumoPorTanque(tanques, PRODUTOS, 40_000)
    const t3 = consumo.find((c) => c.tanque === 3)!
    // MXA: 0,2 x 40000 x 1,05 / 1000 = 8,4 ; GRF: 0,3 x 40000 / 1000 = 12
    expect(t3.planejadoKg).toBeCloseTo(20.4, 6)
  })

  it('real e peso inicial menos final, e o desvio compara com a soma', () => {
    const tanques = montaTanques(receita6em5, ALOC)
    tanques[1].pesoInicial = 100
    tanques[1].pesoFinal = 79.6 // consumo real de 20,4 = exatamente o planejado
    const t3 = consumoPorTanque(tanques, PRODUTOS, 40_000).find((c) => c.tanque === 3)!
    expect(t3.realKg).toBeCloseTo(20.4, 6)
    expect(t3.desvioPct).toBeCloseTo(0, 6)
  })

  // O caso real: o pó secante acaba no meio da ordem e o operador completa.
  // 100 no início + 100 durante − 50 sobrando = 150 consumidos. O cálculo
  // antigo (inicial − final) daria 50 e a ordem viraria economia recorde.
  it('abastecimento no meio da ordem entra no consumo real', () => {
    const tanques = montaTanques(receita6em5, ALOC)
    tanques[1].pesoInicial = 100
    tanques[1].abastecidoKg = 100
    tanques[1].pesoFinal = 50
    const t3 = consumoPorTanque(tanques, PRODUTOS, 40_000).find((c) => c.tanque === 3)!
    expect(t3.realKg).toBeCloseTo(150, 6)
    expect(t3.abastecidoKg).toBe(100)
  })

  it('sem abastecimento o consumo continua inicial menos final', () => {
    const tanques = montaTanques(receita6em5, ALOC)
    tanques[1].pesoInicial = 100
    tanques[1].pesoFinal = 79.6
    const t3 = consumoPorTanque(tanques, PRODUTOS, 40_000).find((c) => c.tanque === 3)!
    expect(t3.realKg).toBeCloseTo(20.4, 6)
    expect(t3.abastecidoKg).toBe(0)
  })

  // abastecer e terminar com MAIS do que começou é possível: completou perto
  // do fim. O consumo continua positivo — o que não pode é virar negativo.
  it('terminar acima do inicial nao quebra o consumo', () => {
    const tanques = montaTanques(receita6em5, ALOC)
    tanques[1].pesoInicial = 20
    tanques[1].abastecidoKg = 100
    tanques[1].pesoFinal = 90
    const t3 = consumoPorTanque(tanques, PRODUTOS, 40_000).find((c) => c.tanque === 3)!
    expect(t3.realKg).toBeCloseTo(30, 6)
  })

  it('sem pesagem fechada nao inventa real nem desvio', () => {
    const tanques = montaTanques(receita6em5, ALOC)
    tanques[1].pesoInicial = 100
    const t3 = consumoPorTanque(tanques, PRODUTOS, 40_000).find((c) => c.tanque === 3)!
    expect(t3.realKg).toBeNull()
    expect(t3.desvioPct).toBeNull()
  })

  it('peso total de quimico soma todos os itens da receita', () => {
    // FTZ 0,5x40000x1,08/1000=21,6 ; MXA 8,4 ; GRF 12
    expect(pesoQuimicoTotalKg(receita6em5, PRODUTOS, 40_000)).toBeCloseTo(42, 6)
  })

  // Pó secante nunca vai em tanque: destino 0 = transferidor, com pesagem
  // e lote iguais aos tanques.
  it('transferidor (destino 0) monta primeiro e pesa como tanque', () => {
    const receita: Receita = {
      id: 'R2', nome: 'COM PO',
      itens: [
        { produtoId: 'FTZ', dose: 0.5 },
        { produtoId: 'GRF', dose: 0.3 },
      ],
    }
    const tanques = montaTanques(receita, [
      { produtoId: 'FTZ', tanque: 1 },
      { produtoId: 'GRF', tanque: 0 },
    ])
    expect(tanques.map((t) => t.tanque)).toEqual([0, 1])

    const transferidor = consumoPorTanque(tanques, PRODUTOS, 40_000)
      .find((c) => c.tanque === 0)!
    // GRF: 0,3 g/kg x 40.000 / 1000 = 12 kg — planejado normal
    expect(transferidor.planejadoKg).toBeCloseTo(12, 6)

    tanques[0].pesoInicial = 20
    tanques[0].pesoFinal = 8
    const conferido = consumoPorTanque(tanques, PRODUTOS, 40_000)
      .find((c) => c.tanque === 0)!
    expect(conferido.realKg).toBeCloseTo(12, 6)
    expect(conferido.desvioPct).toBeCloseTo(0, 6)
  })
})

describe('tempos', () => {
  const MOTIVOS = new Map<string, MotivoParada>([
    ['P1', { id: 'P1', descricao: 'Setup', tipo: 'Planejada' }],
    ['N1', { id: 'N1', descricao: 'Quebra', tipo: 'Nao planejada' }],
  ])

  const base = (): Ordem => ({
    id: 'o1', numero: '1', cultivar: 'C', receitaId: 'R', embalagem: 'BG5M',
    bags: 10, loteId: 'L', prioridade: 'Normal', maquinaId: 'TSI1',
    dataProg: '2026-07-28', seq: 1, turnoId: null, status: 'Finalizada',
    loteLiberadoEm: null, eventos: [], paradas: [], tanques: [],
  })

  it('sem apontamento de inicio nao ha tempos', () => {
    expect(temposOrdem(base(), MOTIVOS, 0)).toBeNull()
  })

  it('parada com fim antes do inicio conta zero, nao negativo', () => {
    // caso real: inicio veio do relogio do servidor e fim do navegador,
    // 2h atrasado -> duracao negativa fazia o liquido superar o bruto
    const o = base()
    o.eventos = [
      { tipo: 'inicio', ts: 0 },
      { tipo: 'fim', ts: 1_575 * 1000 },
    ]
    o.paradas = [{ motivoId: 'N1', inicio: 47 * 1000, fim: -7_009 * 1000 }]
    const t = temposOrdem(o, MOTIVOS, 0)!
    expect(t.paradasS).toBe(0)
    expect(t.liquidoS).toBe(1_575)
    expect(t.liquidoS).toBeLessThanOrEqual(t.brutoS)
  })

  it('liquido desconta todas as paradas', () => {
    const o = base()
    o.eventos = [
      { tipo: 'inicio', ts: 0 },
      { tipo: 'fim', ts: 10_000 * 1000 },
    ]
    o.paradas = [
      { motivoId: 'P1', inicio: 1_000 * 1000, fim: 2_000 * 1000 }, // 1000 s planejada
      { motivoId: 'N1', inicio: 3_000 * 1000, fim: 3_500 * 1000 }, //  500 s nao planejada
    ]
    const t = temposOrdem(o, MOTIVOS, 0)!
    expect(t.brutoS).toBe(10_000)
    expect(t.paradasPlanejadasS).toBe(1_000)
    expect(t.paradasNaoPlanejadasS).toBe(500)
    expect(t.liquidoS).toBe(8_500)
  })

  it('setup nao penaliza a disponibilidade operacional como falha', () => {
    const o = base()
    o.eventos = [
      { tipo: 'inicio', ts: 0 },
      { tipo: 'fim', ts: 10_000 * 1000 },
    ]
    o.paradas = [{ motivoId: 'P1', inicio: 0, fim: 1_000 * 1000 }]
    const t = temposOrdem(o, MOTIVOS, 0)!
    // bruta penaliza a parada planejada; operacional a desconta da base
    expect(t.dispBruta).toBeCloseTo(9_000 / 10_000, 6)
    expect(t.dispOperacional).toBeCloseTo(1, 6)
  })

  it('ordem em andamento usa o agora informado, sem depender do relogio', () => {
    const o = base()
    o.status = 'Em producao'
    o.eventos = [{ tipo: 'inicio', ts: 0 }]
    const t = temposOrdem(o, MOTIVOS, 5_000 * 1000)!
    expect(t.brutoS).toBe(5_000)
  })

  it('parada aberta conta ate o agora', () => {
    const o = base()
    o.status = 'Parada'
    o.eventos = [{ tipo: 'inicio', ts: 0 }]
    o.paradas = [{ motivoId: 'N1', inicio: 1_000 * 1000, fim: null }]
    const t = temposOrdem(o, MOTIVOS, 3_000 * 1000)!
    expect(t.paradasNaoPlanejadasS).toBe(2_000)
    expect(t.liquidoS).toBe(1_000)
  })

  it('tempo planejado vem da capacidade da maquina', () => {
    // 12 t a 12 t/h = 1 h
    expect(tempoPlanejadoS(12, 12)).toBe(3_600)
  })

  it('rendimento e toneladas por hora liquida', () => {
    expect(rendimentoTh(12, 3_600)).toBeCloseTo(12, 6)
    expect(rendimentoTh(12, 0)).toBeNull()
  })
})

describe('turno derivado do horario real do inicio', () => {
  it('inicio as 07:30 e turno 1', () => {
    expect(turnoDoInicio(new Date(2026, 6, 28, 7, 30))).toBe(1)
  })

  it('inicio as 17:30 ainda e turno 1', () => {
    expect(turnoDoInicio(new Date(2026, 6, 28, 17, 30))).toBe(1)
  })

  it('inicio as 17:31 e turno 2', () => {
    expect(turnoDoInicio(new Date(2026, 6, 28, 17, 31))).toBe(2)
  })

  it('madrugada, antes das 07:30, e turno 2', () => {
    expect(turnoDoInicio(new Date(2026, 6, 28, 1, 0))).toBe(2)
  })
})

describe('dia de producao das 07:30 as 03:00', () => {
  it('a tarde pertence ao proprio dia', () => {
    expect(diaDeProducao(new Date(2026, 6, 28, 14, 0))).toBe('2026-07-28')
  })

  it('a madrugada pertence ao dia que comecou', () => {
    expect(diaDeProducao(new Date(2026, 6, 29, 2, 0))).toBe('2026-07-28')
  })

  it('as 07:29 ainda e o dia anterior', () => {
    expect(diaDeProducao(new Date(2026, 6, 29, 7, 29))).toBe('2026-07-28')
  })
})

describe('ocupacao', () => {
  it('capacidade do dia e 234 t por maquina', () => {
    expect(capacidadeDiaT(12, [10, 9.5])).toBe(234)
  })

  it('alerta ambar acima de 85 por cento', () => {
    expect(ocupacao(200, 234).alerta).toBe('ambar')
  })

  it('alerta vermelho acima de 100 por cento', () => {
    expect(ocupacao(240, 234).alerta).toBe('vermelho')
  })

  it('dentro do limite fica ok', () => {
    expect(ocupacao(100, 234).alerta).toBe('ok')
  })
})

describe('oee', () => {
  it('multiplica as tres dimensoes (parada planejada nao pesa na disponibilidade)', () => {
    // base = 1000 - 100 (planej) = 900; disp = liquido 810 / 900 = 0,9
    // perf 0,8 (648/810) x qual 0,5 -> oee 0,36
    const o = calculaOee({ brutoS: 1000, liquidoS: 810, paradasPlanejadasS: 100, planejadoS: 648, qualidade: 0.5 })!
    expect(o.disponibilidade).toBeCloseTo(0.9, 6)
    expect(o.performance).toBeCloseTo(0.8, 6)
    expect(o.qualidade).toBe(0.5)
    expect(o.oee).toBeCloseTo(0.36, 6)
  })

  it('parada planejada nao penaliza: so parada e igual a base, disponibilidade 100%', () => {
    // bruto 1000, planejada 200, sem nao-planejada -> liquido 800, base 800 -> disp 1
    const o = calculaOee({ brutoS: 1000, liquidoS: 800, paradasPlanejadasS: 200, planejadoS: 800, qualidade: 1 })!
    expect(o.disponibilidade).toBe(1)
  })

  it('performance trava em 100% quando produz mais rapido que a capacidade', () => {
    const o = calculaOee({ brutoS: 1000, liquidoS: 500, paradasPlanejadasS: 0, planejadoS: 800, qualidade: 1 })!
    expect(o.performance).toBe(1)
  })

  it('sem qualidade a conta nao fecha (oee null), mas disp e perf saem', () => {
    const o = calculaOee({ brutoS: 1000, liquidoS: 900, paradasPlanejadasS: 0, planejadoS: 720, qualidade: null })!
    expect(o.qualidade).toBeNull()
    expect(o.oee).toBeNull()
    expect(o.disponibilidade).toBeCloseTo(0.9, 6)
  })

  it('bruto zero nao calcula', () => {
    expect(calculaOee({ brutoS: 0, liquidoS: 0, paradasPlanejadasS: 0, planejadoS: 0, qualidade: 1 })).toBeNull()
  })

  it('checklist final: aprova com umidade, po OK e recobrimento no minimo', () => {
    expect(checkFinalAprovado({ recobrimento: 3, umidade_ok: true, po_ok: true })).toBe(true)
    expect(checkFinalAprovado({ recobrimento: 2, umidade_ok: true, po_ok: true })).toBe(false)
    expect(checkFinalAprovado({ recobrimento: 5, umidade_ok: false, po_ok: true })).toBe(false)
    expect(checkFinalAprovado({ recobrimento: 5, umidade_ok: true, po_ok: false })).toBe(false)
  })
})
