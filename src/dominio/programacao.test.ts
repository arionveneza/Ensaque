import { describe, expect, it } from 'vitest'
import {
  autoProgramar,
  checklistDoDia,
  horasDoDia,
  melhorSlot,
  otimizarSequencia,
  rebalancearDia,
  reprogramarCascata,
  filaDa,
  horasDaFila,
  resumoHorasFila,
  setupEntre,
  toneladasDa,
  toneladasPorTratamento,
  trocasDeReceita,
  type MaquinaCapacidade,
  type OrdemProgramavel,
} from './programacao'

// 12 t/h × 19,5 h = 234 t/dia; setup 20 min mesmo tratamento, 40 na troca
const SETUP = { mesmoMin: 20, trocaMin: 40 }
const MAQUINAS: MaquinaCapacidade[] = [
  { id: 'TSI1', capacidadeTh: 12, horasDia: 19.5, setup: SETUP },
  { id: 'TSI2', capacidadeTh: 12, horasDia: 19.5, setup: SETUP },
]
const DIAS = ['2026-07-28', '2026-07-29', '2026-07-30']

let contador = 0
const ord = (over: Partial<OrdemProgramavel> = {}): OrdemProgramavel => ({
  id: `o${++contador}`,
  cultivar: 'C1',
  receitaId: 'R1',
  prioridade: 'Normal',
  pesoT: 40,
  loteBaixado: true,
  maquinaId: null,
  dataProg: null,
  seq: null,
  ...over,
})

describe('trocas de receita', () => {
  it('conta apenas as mudancas', () => {
    expect(trocasDeReceita([{ receitaId: 'A' }, { receitaId: 'A' }, { receitaId: 'B' }])).toBe(1)
  })

  it('sequencia agrupada nao tem troca', () => {
    expect(trocasDeReceita([{ receitaId: 'A' }, { receitaId: 'A' }])).toBe(0)
  })

  it('alternancia maxima custa uma troca por ordem', () => {
    expect(
      trocasDeReceita([{ receitaId: 'A' }, { receitaId: 'B' }, { receitaId: 'A' }]),
    ).toBe(2)
  })
})

describe('melhor slot', () => {
  it('prefere a maquina que ja tem a mesma receita E cultivar', () => {
    const existentes = [
      ord({ maquinaId: 'TSI1', dataProg: DIAS[0], receitaId: 'R9', cultivar: 'C9' }),
      ord({ maquinaId: 'TSI2', dataProg: DIAS[0], receitaId: 'R1', cultivar: 'C1' }),
    ]
    const nova = ord({ receitaId: 'R1', cultivar: 'C1' })
    const slot = melhorSlot(nova, [...existentes, nova], MAQUINAS, DIAS)
    expect(slot?.maquinaId).toBe('TSI2')
    expect(slot?.afinidade).toBe(0)
  })

  it('mesma receita com cultivar diferente vale menos que os dois iguais', () => {
    const existentes = [ord({ maquinaId: 'TSI1', dataProg: DIAS[0], receitaId: 'R1', cultivar: 'OUTRO' })]
    const nova = ord({ receitaId: 'R1', cultivar: 'C1' })
    const slot = melhorSlot(nova, [...existentes, nova], MAQUINAS, DIAS)
    expect(slot?.afinidade).toBe(1)
  })

  it('sem afinidade escolhe a menos carregada', () => {
    const existentes = [
      ord({ maquinaId: 'TSI1', dataProg: DIAS[0], receitaId: 'RX', pesoT: 100 }),
      ord({ maquinaId: 'TSI2', dataProg: DIAS[0], receitaId: 'RY', pesoT: 20 }),
    ]
    const nova = ord({ receitaId: 'R-NOVA' })
    const slot = melhorSlot(nova, [...existentes, nova], MAQUINAS, DIAS)
    expect(slot?.maquinaId).toBe('TSI2')
    expect(slot?.afinidade).toBe(2)
  })

  it('empurra para o dia seguinte quando o dia lota', () => {
    const cheias = [
      ord({ maquinaId: 'TSI1', dataProg: DIAS[0], pesoT: 230 }),
      ord({ maquinaId: 'TSI2', dataProg: DIAS[0], pesoT: 230 }),
    ]
    const nova = ord({ pesoT: 50 })
    const slot = melhorSlot(nova, [...cheias, nova], MAQUINAS, DIAS)
    expect(slot?.dia).toBe(DIAS[1])
  })

  it('devolve null quando nao cabe em nenhum dia do horizonte', () => {
    const nova = ord({ pesoT: 999 })
    expect(melhorSlot(nova, [nova], MAQUINAS, DIAS)).toBeNull()
  })
})

describe('programacao automatica', () => {
  it('atende urgente antes de normal', () => {
    const normal = ord({ prioridade: 'Normal' })
    const urgente = ord({ prioridade: 'Urgente' })
    const r = autoProgramar([normal, urgente], MAQUINAS, DIAS)
    expect(r.atribuicoes[0].ordemId).toBe(urgente.id)
  })

  it('entre iguais, lote baixado passa na frente', () => {
    const semLote = ord({ loteBaixado: false })
    const comLote = ord({ loteBaixado: true })
    const r = autoProgramar([semLote, comLote], MAQUINAS, DIAS)
    expect(r.atribuicoes[0].ordemId).toBe(comLote.id)
  })

  it('nao reprograma ordem que ja tem maquina', () => {
    const fixa = ord({ maquinaId: 'TSI1', dataProg: DIAS[0] })
    const solta = ord()
    const r = autoProgramar([fixa, solta], MAQUINAS, DIAS)
    expect(r.atribuicoes.map((a) => a.ordemId)).toEqual([solta.id])
  })

  it('agrupa a mesma receita na mesma maquina', () => {
    const a = ord({ receitaId: 'R1', cultivar: 'C1', pesoT: 30 })
    const b = ord({ receitaId: 'R1', cultivar: 'C1', pesoT: 30 })
    const r = autoProgramar([a, b], MAQUINAS, DIAS)
    const maq = new Set(r.atribuicoes.map((x) => x.maquinaId))
    expect(maq.size).toBe(1)
  })

  it('numera a sequencia dentro da celula', () => {
    const a = ord({ receitaId: 'R1', cultivar: 'C1', pesoT: 30 })
    const b = ord({ receitaId: 'R1', cultivar: 'C1', pesoT: 30 })
    const r = autoProgramar([a, b], MAQUINAS, DIAS)
    expect(r.atribuicoes.map((x) => x.seq).sort()).toEqual([1, 2])
  })

  it('reporta o que nao coube em vez de descartar em silencio', () => {
    const gigante = ord({ pesoT: 999 })
    const r = autoProgramar([gigante], MAQUINAS, DIAS)
    expect(r.atribuicoes).toHaveLength(0)
    expect(r.naoCouberam.map((o) => o.id)).toEqual([gigante.id])
  })

  it('respeita a capacidade em horas: producao + setup nao estoura o dia', () => {
    // 40 t = 3h20; 5 ordens dão 16h40 + 4 setups de 20 min = 18h ≤ 19h30, a
    // 6ª (20h + 1h40) estoura. O teste confere a regra, não o número.
    const ordens = Array.from({ length: 20 }, () => ord({ pesoT: 40 }))
    const r = autoProgramar(ordens, MAQUINAS, DIAS)
    for (const dia of DIAS) {
      for (const m of MAQUINAS) {
        const fila = r.atribuicoes
          .filter((a) => a.dia === dia && a.maquinaId === m.id)
          .sort((a, b) => a.seq - b.seq)
          .map((a) => ordens.find((o) => o.id === a.ordemId)!)
        expect(horasDaFila(fila, m.capacidadeTh, m.setup)).toBeLessThanOrEqual(m.horasDia)
      }
    }
  })

  it('o setup faz caber menos ordens do que a conta em toneladas prometia', () => {
    // 6 × 39 t = 234 t: em toneladas lotariam o dia certinho; com 5 setups
    // de 20 min (1h40) a 6ª transborda
    const ordens = Array.from({ length: 6 }, () => ord({ pesoT: 39 }))
    const soTSI1 = [MAQUINAS[0]]
    const r = autoProgramar(ordens, soTSI1, DIAS)
    const noPrimeiro = r.atribuicoes.filter((a) => a.dia === DIAS[0])
    expect(noPrimeiro).toHaveLength(5)
    expect(r.atribuicoes.filter((a) => a.dia === DIAS[1])).toHaveLength(1)
  })
})

describe('otimizar sequencia', () => {
  it('agrupa receitas iguais e reduz as trocas', () => {
    const fila = [
      ord({ id: 'a', receitaId: 'R1', maquinaId: 'TSI1', dataProg: DIAS[0] }),
      ord({ id: 'b', receitaId: 'R2', maquinaId: 'TSI1', dataProg: DIAS[0] }),
      ord({ id: 'c', receitaId: 'R1', maquinaId: 'TSI1', dataProg: DIAS[0] }),
    ]
    const antes = trocasDeReceita(fila)
    const nova = otimizarSequencia(fila)
    const reordenada = nova.map((a) => fila.find((o) => o.id === a.ordemId)!)
    expect(trocasDeReceita(reordenada)).toBeLessThan(antes)
  })

  it('mantem urgentes na frente mesmo que custe uma troca', () => {
    const fila = [
      ord({ id: 'n1', receitaId: 'R1', prioridade: 'Normal', maquinaId: 'TSI1', dataProg: DIAS[0] }),
      ord({ id: 'u1', receitaId: 'R2', prioridade: 'Urgente', maquinaId: 'TSI1', dataProg: DIAS[0] }),
    ]
    const nova = otimizarSequencia(fila)
    expect(nova[0].ordemId).toBe('u1')
  })

  it('junta a mesma receita mesmo com cultivar diferente (setup so olha a receita)', () => {
    // dia 15/09/2026 na TSI 1: 320 min com a chave receita+cultivar; o minimo e 280
    const fila = [
      ord({ id: '143226', receitaId: 'FTZ60', cultivar: 'NEO780', prioridade: 'Urgente', seq: 1 }),
      ord({ id: '144727', receitaId: 'FTZ60+RCoMoNi+Lli', cultivar: 'NEO780', prioridade: 'Urgente', seq: 2 }),
      ord({ id: '144775', receitaId: 'FTZ ELITE+RCoMoNi', cultivar: '761', prioridade: 'Urgente', seq: 3 }),
      ord({ id: '144923', receitaId: 'FTZ60+VIC+Lli', cultivar: 'O720', prioridade: 'Urgente', seq: 4 }),
      ord({ id: '144971', receitaId: 'FTZ ELITE+Lli', cultivar: 'NEO771', prioridade: 'Urgente', seq: 5 }),
      ord({ id: '144996', receitaId: 'FTZ60+RCoMoNi', cultivar: 'NEO801', prioridade: 'Urgente', seq: 6 }),
      ord({ id: '145018', receitaId: 'FTZ60+VIC+RCoMoNi', cultivar: 'NEO801', prioridade: 'Urgente', seq: 7 }),
      ord({ id: '145041', receitaId: 'FTZ60+VIC+Lli', cultivar: 'NEO801', prioridade: 'Urgente', seq: 8 }),
      ord({ id: 'P59', receitaId: 'FTZ60', cultivar: 'NEO680', prioridade: 'Normal', seq: 9 }),
    ].map((o) => ({ ...o, maquinaId: 'TSI1', dataProg: DIAS[0] }))
    expect(resumoHorasFila(fila, 12, SETUP).setupMin).toBe(320)
    const nova = otimizarSequencia(fila).map((a) => fila.find((o) => o.id === a.ordemId)!)
    expect(resumoHorasFila(nova, 12, SETUP).setupMin).toBe(280)
    // urgentes continuam todas antes da normal
    expect(nova[nova.length - 1].id).toBe('P59')
    // e a FTZ60 urgente fechou a fila das urgentes para emendar com a P59
    expect(nova[nova.length - 2].id).toBe('143226')
  })

  it('dentro da familia, a receita com menos itens vai na frente (base antes das derivacoes)', () => {
    // 19/09/2026: "o FTZ60 + RCoMoNi + Lli tem mais itens que o FTZ60, então
    // deveria vir depois, assim como o FTZ60 + VIC"
    const itens = new Map([['r-lli', 8], ['r-ftz60', 5], ['r-vic', 6]])
    const fila = [
      ord({ id: 'a', receitaId: 'r-lli', receitaNome: 'FTZ60 + RCoMoNi + Lli', maquinaId: 'TSI1', dataProg: DIAS[0] }),
      ord({ id: 'b', receitaId: 'r-vic', receitaNome: 'FTZ60 + VIC', maquinaId: 'TSI1', dataProg: DIAS[0] }),
      ord({ id: 'c', receitaId: 'r-ftz60', receitaNome: 'FTZ60', maquinaId: 'TSI1', dataProg: DIAS[0] }),
      ord({ id: 'd', receitaId: 'r-lli', receitaNome: 'FTZ60 + RCoMoNi + Lli', maquinaId: 'TSI1', dataProg: DIAS[0] }),
    ]
    expect(otimizarSequencia(fila, itens).map((a) => a.ordemId)).toEqual(['c', 'b', 'a', 'd'])
  })

  it('familias ficam juntas: a de base com menos itens primeiro (empate: mais ordens), e a base abre a familia', () => {
    const itens = new Map([['r-vp', 5], ['r-vp-raiz', 6], ['r-ftz60', 5], ['r-vic', 6], ['r-der', 4]])
    const fila = [
      ord({ id: 'v1', receitaId: 'r-vp-raiz', receitaNome: 'V&P + RAIZ', maquinaId: 'TSI1', dataProg: DIAS[0] }),
      ord({ id: 'f1', receitaId: 'r-vic', receitaNome: 'FTZ60 + VIC', maquinaId: 'TSI1', dataProg: DIAS[0] }),
      ord({ id: 'd1', receitaId: 'r-der', receitaNome: 'DER + LMT', maquinaId: 'TSI1', dataProg: DIAS[0] }),
      ord({ id: 'f2', receitaId: 'r-ftz60', receitaNome: 'FTZ60', maquinaId: 'TSI1', dataProg: DIAS[0] }),
      ord({ id: 'v2', receitaId: 'r-vp', receitaNome: 'V&P', maquinaId: 'TSI1', dataProg: DIAS[0] }),
      ord({ id: 'f3', receitaId: 'r-vic', receitaNome: 'FTZ60 + VIC', maquinaId: 'TSI1', dataProg: DIAS[0] }),
    ]
    // Dermacor (base 4 itens) → FTZ60 (5, 3 ordens) → V&P (5, 2 ordens); dentro: base primeiro
    expect(otimizarSequencia(fila, itens).map((a) => a.ordemId)).toEqual(['d1', 'f2', 'f1', 'f3', 'v2', 'v1'])
  })

  it('com familias, a fronteira urgente→normal nao reordena: cada lado sai por menos itens, depois mais ordens', () => {
    const itens = new Map([['r-vp', 5], ['r-vp-raiz', 6], ['r-ftz60', 5], ['r-der', 4]])
    const fila = [
      ord({ id: 'u1', receitaId: 'r-vp', receitaNome: 'V&P', prioridade: 'Urgente', maquinaId: 'TSI1', dataProg: DIAS[0] }),
      ord({ id: 'u2', receitaId: 'r-vp-raiz', receitaNome: 'V&P + RAIZ', prioridade: 'Urgente', maquinaId: 'TSI1', dataProg: DIAS[0] }),
      ord({ id: 'u3', receitaId: 'r-ftz60', receitaNome: 'FTZ60', prioridade: 'Urgente', maquinaId: 'TSI1', dataProg: DIAS[0] }),
      ord({ id: 'n1', receitaId: 'r-vp-raiz', receitaNome: 'V&P + RAIZ', maquinaId: 'TSI1', dataProg: DIAS[0] }),
      ord({ id: 'n2', receitaId: 'r-der', receitaNome: 'DER + LMT', maquinaId: 'TSI1', dataProg: DIAS[0] }),
      ord({ id: 'n3', receitaId: 'r-ftz60', receitaNome: 'FTZ60', maquinaId: 'TSI1', dataProg: DIAS[0] }),
    ]
    // urgentes: V&P (base 5, 2 ordens) antes de FTZ60 (5, 1 ordem);
    // normais: DER (4) → FTZ60 (5) → V&P + RAIZ (6, a única da família aqui)
    expect(otimizarSequencia(fila, itens).map((a) => a.ordemId)).toEqual(['u1', 'u2', 'u3', 'n2', 'n3', 'n1'])
  })

  it('FTZ60 (base) fica antes de + ARV e + VIC, e a familia FTZ60 antes da FTZ ELITE, mesmo com uma FTZ60 normal no fim', () => {
    // caso real do quadro de 19/09/2026: tudo urgente, uma FTZ60 normal no
    // fim — a FTZ60 urgente era jogada pra depois das derivações só pra
    // encostar na normal
    const itens = new Map([['r-elite', 6], ['r-ftz60', 5], ['r-arv', 6], ['r-vic', 6]])
    const fila = [
      ord({ id: 'e1', receitaId: 'r-elite', receitaNome: 'FTZ ELITE', prioridade: 'Urgente', maquinaId: 'TSI1', dataProg: DIAS[0] }),
      ord({ id: 'fa', receitaId: 'r-arv', receitaNome: 'FTZ60 + ARV', prioridade: 'Urgente', maquinaId: 'TSI1', dataProg: DIAS[0] }),
      ord({ id: 'fv', receitaId: 'r-vic', receitaNome: 'FTZ60 + VIC', prioridade: 'Urgente', maquinaId: 'TSI1', dataProg: DIAS[0] }),
      ord({ id: 'f0', receitaId: 'r-ftz60', receitaNome: 'FTZ60', prioridade: 'Urgente', maquinaId: 'TSI1', dataProg: DIAS[0] }),
      ord({ id: 'n0', receitaId: 'r-ftz60', receitaNome: 'FTZ60', maquinaId: 'TSI1', dataProg: DIAS[0] }),
    ]
    // FTZ60 (base 5 itens) antes de FTZ ELITE (6); a FTZ60 normal fecha o dia
    expect(otimizarSequencia(fila, itens).map((a) => a.ordemId)).toEqual(['f0', 'fa', 'fv', 'e1', 'n0'])
  })

  it('sem nome nem contagem, cada receita e a propria familia e o resultado e o de antes', () => {
    const fila = [
      ord({ id: 'a', receitaId: 'R1', maquinaId: 'TSI1', dataProg: DIAS[0] }),
      ord({ id: 'b', receitaId: 'R2', maquinaId: 'TSI1', dataProg: DIAS[0] }),
      ord({ id: 'c', receitaId: 'R2', maquinaId: 'TSI1', dataProg: DIAS[0] }),
    ]
    expect(otimizarSequencia(fila).map((a) => a.ordemId)).toEqual(['b', 'c', 'a'])
  })

  it('renumera a sequencia de 1 a n', () => {
    const fila = [
      ord({ maquinaId: 'TSI1', dataProg: DIAS[0] }),
      ord({ maquinaId: 'TSI1', dataProg: DIAS[0] }),
      ord({ maquinaId: 'TSI1', dataProg: DIAS[0] }),
    ]
    expect(otimizarSequencia(fila).map((a) => a.seq)).toEqual([1, 2, 3])
  })
})

describe('rebalancear o dia', () => {
  it('move da maquina cheia para a vazia', () => {
    const ordens = [
      ord({ maquinaId: 'TSI1', dataProg: DIAS[0], pesoT: 60 }),
      ord({ maquinaId: 'TSI1', dataProg: DIAS[0], pesoT: 60 }),
      ord({ maquinaId: 'TSI1', dataProg: DIAS[0], pesoT: 60 }),
    ]
    const r = rebalancearDia(ordens, MAQUINAS, DIAS[0])
    expect(r?.origem).toBe('TSI1')
    expect(r?.destino).toBe('TSI2')
    expect(r!.ordensMovidas.length).toBeGreaterThan(0)
  })

  it('nao inverte o desbalanceamento', () => {
    const ordens = [
      ord({ maquinaId: 'TSI1', dataProg: DIAS[0], pesoT: 100 }),
      ord({ maquinaId: 'TSI2', dataProg: DIAS[0], pesoT: 80 }),
    ]
    const r = rebalancearDia(ordens, MAQUINAS, DIAS[0])
    // diferenca de 20 t: mover a ordem de 100 t deixaria TSI2 muito pior
    expect(r).toBeNull()
  })

  it('nao move ordem ja iniciada, mesmo sendo a maior', () => {
    const ordens = [
      ord({ id: 'rodando', maquinaId: 'TSI1', dataProg: DIAS[0], pesoT: 120, iniciada: true }),
      ord({ id: 'livre', maquinaId: 'TSI1', dataProg: DIAS[0], pesoT: 60 }),
    ]
    const r = rebalancearDia(ordens, MAQUINAS, DIAS[0])
    expect(r?.ordensMovidas.map((a) => a.ordemId)).toEqual(['livre'])
  })

  // TSI 3 (19/09/2026): terceira máquina, aqui com t/h menor de propósito —
  // é o caso em que a trava antiga do Rebalancear errava
  const MAQUINAS3: MaquinaCapacidade[] = [
    ...MAQUINAS,
    { id: 'TSI3', capacidadeTh: 6, horasDia: 19.5, setup: SETUP },
  ]

  it('com tres maquinas, move da mais cheia para a mais vazia', () => {
    const ordens = [
      ord({ maquinaId: 'TSI1', dataProg: DIAS[0], pesoT: 60 }),
      ord({ maquinaId: 'TSI1', dataProg: DIAS[0], pesoT: 60 }),
      ord({ maquinaId: 'TSI1', dataProg: DIAS[0], pesoT: 60 }),
      ord({ maquinaId: 'TSI2', dataProg: DIAS[0], pesoT: 60 }),
    ]
    const r = rebalancearDia(ordens, MAQUINAS3, DIAS[0])
    expect(r?.origem).toBe('TSI1')
    expect(r?.destino).toBe('TSI3')
    expect(r!.ordensMovidas.length).toBeGreaterThan(0)
  })

  it('maquina lenta vazia recebe a ordem que equilibra — a trava antiga recusava', () => {
    // TSI 1 com 3 × 76 t (19,67 h, estourada) e a TSI 3 (6 t/h) vazia: a ordem
    // custa 12,67 h na TSI 3, mais que a "metade da diferença" (9,83 h) da trava
    // antiga — ela devolvia null e a tela dizia "o dia já está equilibrado"
    const ordens = [
      ord({ maquinaId: 'TSI1', dataProg: DIAS[0], pesoT: 76 }),
      ord({ maquinaId: 'TSI1', dataProg: DIAS[0], pesoT: 76 }),
      ord({ maquinaId: 'TSI1', dataProg: DIAS[0], pesoT: 76 }),
    ]
    const r = rebalancearDia(ordens, [MAQUINAS[0], MAQUINAS3[2]], DIAS[0])
    expect(r?.destino).toBe('TSI3')
    expect(r!.ordensMovidas.length).toBe(1)
  })

  it('maquina lenta estourada com UMA ordem recebe alivio — a trava por producao devolvia null', () => {
    // TSI 3 a 6 t/h com 1 × 120 t = 20 h (103% do dia) e a TSI 1 vazia: a
    // única movida possível passa do ponto (10 h no destino contra 0 na
    // origem), mas a diferença cai de 20 h para 10 h — tem de mover
    const lenta: MaquinaCapacidade = { id: 'TSI3', capacidadeTh: 6, horasDia: 19.5, setup: SETUP }
    const ordens = [ord({ maquinaId: 'TSI3', dataProg: DIAS[0], pesoT: 120 })]
    const r = rebalancearDia(ordens, [MAQUINAS[0], lenta], DIAS[0])
    expect(r?.destino).toBe('TSI1')
    expect(r!.ordensMovidas.length).toBe(1)
  })

  it('maquina com t/h zero nao trava o rebalanceamento das outras', () => {
    const zerada: MaquinaCapacidade = { id: 'TSI3', capacidadeTh: 0, horasDia: 19.5, setup: SETUP }
    const ordens = [
      ord({ maquinaId: 'TSI1', dataProg: DIAS[0], pesoT: 60 }),
      ord({ maquinaId: 'TSI1', dataProg: DIAS[0], pesoT: 60 }),
      ord({ maquinaId: 'TSI1', dataProg: DIAS[0], pesoT: 60 }),
    ]
    const r = rebalancearDia(ordens, [...MAQUINAS, zerada], DIAS[0])
    expect(r?.destino).toBe('TSI2')
  })

  it('a diferenca sempre encolhe: a segunda passada nunca desfaz a primeira', () => {
    // TSI 1 com R1, R2, R1 (10 t cada, 12 t/h) e a TSI 3 vazia a 12 t/h. Depois
    // de aplicar o resultado, um novo Rebalancear não pode mover de volta
    const rapida: MaquinaCapacidade = { id: 'TSI3', capacidadeTh: 12, horasDia: 19.5, setup: SETUP }
    const ordens = [
      ord({ id: 'a', maquinaId: 'TSI1', dataProg: DIAS[0], pesoT: 10, receitaId: 'R1', seq: 1 }),
      ord({ id: 'b', maquinaId: 'TSI1', dataProg: DIAS[0], pesoT: 10, receitaId: 'R2', seq: 2 }),
      ord({ id: 'c', maquinaId: 'TSI1', dataProg: DIAS[0], pesoT: 10, receitaId: 'R1', seq: 3 }),
    ]
    const maqs = [MAQUINAS[0], rapida]
    const r = rebalancearDia(ordens, maqs, DIAS[0])
    expect(r).not.toBeNull()
    const depois = ordens.map((o) => {
      const mov = r!.ordensMovidas.find((m) => m.ordemId === o.id)
      return mov ? { ...o, maquinaId: mov.maquinaId, seq: mov.seq } : o
    })
    const h = (mid: string) => horasDaFila(filaDa(depois, mid, DIAS[0]), 12, SETUP)
    const antes = horasDaFila(filaDa(ordens, 'TSI1', DIAS[0]), 12, SETUP)
    expect(Math.abs(h('TSI1') - h('TSI3'))).toBeLessThan(antes)
    const r2 = rebalancearDia(depois, maqs, DIAS[0])
    expect(r2).toBeNull()
  })

  it('maquina lenta cheia nao e esvaziada num clique', () => {
    // TSI 3 a 4 t/h com 3 × 20 t (15,67 h) e a TSI 1 vazia: cada ordem custa
    // 1,67 h na TSI 1 mas alivia 5 h na TSI 3 — a trava antiga deixava as três
    // passarem e invertia o desbalanceamento
    const lenta: MaquinaCapacidade = { id: 'TSI3', capacidadeTh: 4, horasDia: 19.5, setup: SETUP }
    const ordens = [
      ord({ maquinaId: 'TSI3', dataProg: DIAS[0], pesoT: 20 }),
      ord({ maquinaId: 'TSI3', dataProg: DIAS[0], pesoT: 20 }),
      ord({ maquinaId: 'TSI3', dataProg: DIAS[0], pesoT: 20 }),
    ]
    const r = rebalancearDia(ordens, [MAQUINAS[0], lenta], DIAS[0])
    expect(r?.destino).toBe('TSI1')
    expect(r!.ordensMovidas.length).toBe(2)
  })

  it('dia equilibrado nao gera movimento', () => {
    const ordens = [
      ord({ maquinaId: 'TSI1', dataProg: DIAS[0], pesoT: 50 }),
      ord({ maquinaId: 'TSI2', dataProg: DIAS[0], pesoT: 50 }),
    ]
    expect(rebalancearDia(ordens, MAQUINAS, DIAS[0])).toBeNull()
  })
})

describe('horas do dia por turnos', () => {
  const H = [10, 9.5]
  it('os dois turnos somam 19,5 h', () => expect(horasDoDia({ t1: true, t2: true }, H)).toBe(19.5))
  it('só o 1º turno tem 10 h', () => expect(horasDoDia({ t1: true, t2: false }, H)).toBe(10))
  // o que distingue este modelo do anterior, que só contava quantos turnos
  it('só o 2º turno tem 9,5 h', () => expect(horasDoDia({ t1: false, t2: true }, H)).toBe(9.5))
  it('sem turno não produz', () => expect(horasDoDia({ t1: false, t2: false }, H)).toBe(0))
})

describe('reprogramar em cascata', () => {
  // 5 dias corridos; capacidade padrão de 234 t/dia em cada máquina
  const D = ['2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09', '2026-08-10']
  const hoje = D[0]

  it('empurra o que sobrou de hoje para a frente da fila de amanha', () => {
    const ordens = [
      ord({ id: 'feita', maquinaId: 'TSI1', dataProg: hoje, seq: 1, pesoT: 30, iniciada: true }),
      ord({ id: 'sobrou', maquinaId: 'TSI1', dataProg: hoje, seq: 2, pesoT: 30 }),
      ord({ id: 'amanha', maquinaId: 'TSI1', dataProg: D[1], seq: 1, pesoT: 30 }),
    ]
    const r = reprogramarCascata(ordens, MAQUINAS, D, hoje)
    const sobrou = r.movimentos.find((m) => m.ordem.id === 'sobrou')!
    const amanha = r.movimentos.find((m) => m.ordem.id === 'amanha')
    expect(sobrou.paraDia).toBe(D[1])
    expect(sobrou.seq).toBe(1)
    // a de amanhã cede a vez, mas continua no mesmo dia (cabe)
    expect(amanha?.paraDia ?? D[1]).toBe(D[1])
    expect(amanha!.seq).toBe(2)
  })

  it('a ordem ja iniciada nao se move nem perde a posicao', () => {
    const ordens = [
      ord({ id: 'feita', maquinaId: 'TSI1', dataProg: hoje, seq: 1, iniciada: true }),
      ord({ id: 'sobrou', maquinaId: 'TSI1', dataProg: hoje, seq: 2 }),
    ]
    const r = reprogramarCascata(ordens, MAQUINAS, D, hoje)
    expect(r.movimentos.some((m) => m.ordem.id === 'feita')).toBe(false)
  })

  it('o que nao cabe no dia transborda para o seguinte', () => {
    // 234 t por dia: cabem 2 ordens de 100 t (a terceira daria 300)
    const ordens = Array.from({ length: 5 }, (_, i) =>
      ord({ id: `g${i}`, maquinaId: 'TSI1', dataProg: hoje, seq: i + 1, pesoT: 100 }),
    )
    const r = reprogramarCascata(ordens, MAQUINAS, D, hoje)
    const dia = (id: string) => r.movimentos.find((m) => m.ordem.id === id)!.paraDia
    const seq = (id: string) => r.movimentos.find((m) => m.ordem.id === id)!.seq
    expect([dia('g0'), dia('g1')]).toEqual([D[1], D[1]])
    expect([dia('g2'), dia('g3')]).toEqual([D[2], D[2]])
    expect(dia('g4')).toBe(D[3])
    // cada dia recomeça a numeração em 1
    expect([seq('g0'), seq('g1'), seq('g2'), seq('g4')]).toEqual([1, 2, 1, 1])
  })

  it('nao fura a fila: ordem pequena nao passa na frente da que nao coube', () => {
    const ordens = [
      ord({ id: 'grande', maquinaId: 'TSI1', dataProg: hoje, seq: 1, pesoT: 200 }),
      ord({ id: 'media', maquinaId: 'TSI1', dataProg: hoje, seq: 2, pesoT: 100 }),
      ord({ id: 'pequena', maquinaId: 'TSI1', dataProg: hoje, seq: 3, pesoT: 10 }),
    ]
    const r = reprogramarCascata(ordens, MAQUINAS, D, hoje)
    const dia = (id: string) => r.movimentos.find((m) => m.ordem.id === id)!.paraDia
    // a pequena caberia junto com a grande (200 + 10 <= 234), mas espera a média
    expect(dia('grande')).toBe(D[1])
    expect(dia('media')).toBe(D[2])
    expect(dia('pequena')).toBe(D[2])
  })

  it('nunca puxa uma ordem para antes do dia dela', () => {
    const ordens = [
      ord({ id: 'longe', maquinaId: 'TSI1', dataProg: D[4], seq: 1, pesoT: 10 }),
      ord({ id: 'hoje', maquinaId: 'TSI1', dataProg: hoje, seq: 1, pesoT: 10 }),
    ]
    const r = reprogramarCascata(ordens, MAQUINAS, D, hoje)
    expect(r.movimentos.some((m) => m.ordem.id === 'longe')).toBe(false)
  })

  it('dia sem turno nao recebe nada e devolve o que tinha', () => {
    const semDomingo = (_m: string, dia: string) => (dia === D[1] ? 0 : 19.5)
    const ordens = [
      ord({ id: 'a', maquinaId: 'TSI1', dataProg: hoje, seq: 1, pesoT: 10 }),
      ord({ id: 'b', maquinaId: 'TSI1', dataProg: D[1], seq: 1, pesoT: 10 }),
    ]
    const r = reprogramarCascata(ordens, MAQUINAS, D, hoje, semDomingo)
    for (const mv of r.movimentos) expect(mv.paraDia).not.toBe(D[1])
    expect(r.movimentos.find((m) => m.ordem.id === 'a')!.paraDia).toBe(D[2])
    expect(r.movimentos.find((m) => m.ordem.id === 'b')!.paraDia).toBe(D[2])
  })

  it('um turno so reduz a capacidade e transborda mais cedo', () => {
    // só 1º turno: 10 h (120 t)
    const umTurno = (_m: string, dia: string) => (dia === D[1] ? 10 : 19.5)
    const ordens = [
      ord({ id: 'a', maquinaId: 'TSI1', dataProg: hoje, seq: 1, pesoT: 100 }),
      ord({ id: 'b', maquinaId: 'TSI1', dataProg: hoje, seq: 2, pesoT: 100 }),
    ]
    const r = reprogramarCascata(ordens, MAQUINAS, D, hoje, umTurno)
    expect(r.movimentos.find((m) => m.ordem.id === 'a')!.paraDia).toBe(D[1])
    expect(r.movimentos.find((m) => m.ordem.id === 'b')!.paraDia).toBe(D[2])
  })

  it('cada maquina cascateia sozinha', () => {
    const ordens = [
      ord({ id: 't1', maquinaId: 'TSI1', dataProg: hoje, seq: 1, pesoT: 10 }),
      ord({ id: 't2', maquinaId: 'TSI2', dataProg: hoje, seq: 1, pesoT: 10 }),
    ]
    const r = reprogramarCascata(ordens, MAQUINAS, D, hoje)
    expect(r.movimentos.find((m) => m.ordem.id === 't1')!.paraDia).toBe(D[1])
    expect(r.movimentos.find((m) => m.ordem.id === 't2')!.paraDia).toBe(D[1])
    expect(r.movimentos.every((m) => m.seq === 1)).toBe(true)
  })

  it('atraso de dias anteriores entra na frente', () => {
    const ordens = [
      ord({ id: 'atrasada', maquinaId: 'TSI1', dataProg: '2026-08-01', seq: 5, pesoT: 10 }),
      ord({ id: 'de hoje', maquinaId: 'TSI1', dataProg: hoje, seq: 1, pesoT: 10 }),
    ]
    const r = reprogramarCascata(ordens, MAQUINAS, D, hoje)
    expect(r.movimentos.find((m) => m.ordem.id === 'atrasada')!.seq).toBe(1)
    expect(r.movimentos.find((m) => m.ordem.id === 'de hoje')!.seq).toBe(2)
  })

  it('urgente lidera a fila do proprio dia', () => {
    const ordens = [
      ord({ id: 'normal', maquinaId: 'TSI1', dataProg: hoje, seq: 1, pesoT: 10 }),
      ord({ id: 'urg', maquinaId: 'TSI1', dataProg: hoje, seq: 2, pesoT: 10, prioridade: 'Urgente' }),
    ]
    const r = reprogramarCascata(ordens, MAQUINAS, D, hoje)
    expect(r.movimentos.find((m) => m.ordem.id === 'urg')!.seq).toBe(1)
  })

  it('ordem maior que o dia inteiro vai assim mesmo, sinalizada', () => {
    const ordens = [
      ord({ id: 'gigante', maquinaId: 'TSI1', dataProg: hoje, seq: 1, pesoT: 300 }),
      ord({ id: 'atras', maquinaId: 'TSI1', dataProg: hoje, seq: 2, pesoT: 10 }),
    ]
    const r = reprogramarCascata(ordens, MAQUINAS, D, hoje)
    expect(r.excedem.map((o) => o.id)).toEqual(['gigante'])
    // e a fila não trava por causa dela
    expect(r.movimentos.find((m) => m.ordem.id === 'atras')).toBeDefined()
    expect(r.naoCouberam).toHaveLength(0)
  })

  it('sem dia seguinte no horizonte, nada se move', () => {
    const ordens = [ord({ maquinaId: 'TSI1', dataProg: hoje, seq: 1 })]
    const r = reprogramarCascata(ordens, MAQUINAS, [hoje], hoje)
    expect(r.movimentos).toHaveLength(0)
  })

  it('o que nao cabe no horizonte fica onde esta', () => {
    const ordens = Array.from({ length: 10 }, (_, i) =>
      ord({ id: `x${i}`, maquinaId: 'TSI1', dataProg: hoje, seq: i + 1, pesoT: 200 }),
    )
    const r = reprogramarCascata(ordens, MAQUINAS, D, hoje)
    // 4 dias de destino, uma de 200 t por dia
    expect(r.movimentos).toHaveLength(4)
    expect(r.naoCouberam).toHaveLength(6)
  })

  it('o que cabia em toneladas transborda por causa do setup', () => {
    // 4 × 55 t = 220 t ≤ 234 t, mas alternando tratamento: 18h20 de produção
    // + 3 trocas × 40 min = 20h20 > 19h30 — a 4ª vai para o dia seguinte
    const ordens = ['R1', 'R2', 'R1', 'R2'].map((r, i) =>
      ord({ id: `s${i}`, maquinaId: 'TSI1', dataProg: hoje, seq: i + 1, pesoT: 55, receitaId: r }),
    )
    const r = reprogramarCascata(ordens, MAQUINAS, D, hoje)
    const dia = (id: string) => r.movimentos.find((m) => m.ordem.id === id)!.paraDia
    expect([dia('s0'), dia('s1'), dia('s2')]).toEqual([D[1], D[1], D[1]])
    expect(dia('s3')).toBe(D[2])
  })

  it('agrupadas por tratamento, as mesmas ordens cabem no dia', () => {
    // mesmas 4 × 55 t, mas R1 R1 R2 R2: 18h20 + 20 + 40 + 20 = 19h40 > 19h30 ainda
    // estoura; com 54 t (18h) + 1h20 = 19h20 cabe — o agrupamento economiza 40 min
    const ordens = ['R1', 'R1', 'R2', 'R2'].map((r, i) =>
      ord({ id: `a${i}`, maquinaId: 'TSI1', dataProg: hoje, seq: i + 1, pesoT: 54, receitaId: r }),
    )
    const r = reprogramarCascata(ordens, MAQUINAS, D, hoje)
    expect(r.movimentos.every((m) => m.paraDia === D[1])).toBe(true)
    expect(r.movimentos).toHaveLength(4)
  })

  it('a ordem ja iniciada cobra setup de quem entra depois dela', () => {
    // fixa de R1 já ocupa 8h20 no D[1]; a que chega é R2: 8h20 + 40 min
    const ordens = [
      ord({ id: 'fixa', maquinaId: 'TSI1', dataProg: D[1], seq: 1, pesoT: 100, iniciada: true }),
      // 130 t = 10h50; 8h20 + 10h50 = 19h10 caberia sem setup; com 40 min, 19h50 > 19h30
      ord({ id: 'chega', maquinaId: 'TSI1', dataProg: hoje, seq: 1, pesoT: 130, receitaId: 'R2' }),
    ]
    const r = reprogramarCascata(ordens, MAQUINAS, D, hoje)
    expect(r.movimentos.find((m) => m.ordem.id === 'chega')!.paraDia).toBe(D[2])
  })
})

describe('setup entre ordens e horas da fila', () => {
  it('primeira ordem do dia nao paga setup', () => {
    expect(setupEntre(null, { receitaId: 'R1' }, SETUP)).toBe(0)
  })

  it('mesmo tratamento paga o setup curto, mesmo com cultivar igual', () => {
    expect(setupEntre({ receitaId: 'R1' }, { receitaId: 'R1' }, SETUP)).toBe(20)
  })

  it('tratamento diferente paga o setup de limpeza', () => {
    expect(setupEntre({ receitaId: 'R1' }, { receitaId: 'R2' }, SETUP)).toBe(40)
  })

  it('fila de 3 ordens do mesmo tratamento: peso/capacidade + 2 setups curtos', () => {
    const fila = [ord({ pesoT: 60 }), ord({ pesoT: 60 }), ord({ pesoT: 60 })]
    const r = resumoHorasFila(fila, 12, SETUP)
    expect(r.producaoH).toBe(15)
    expect(r.setupMin).toBe(40)
    expect(r.trocas).toBe(0)
    expect(r.horas).toBeCloseTo(15 + 40 / 60, 6)
  })

  it('troca de tratamento no meio custa 40 em vez de 20', () => {
    const fila = [
      ord({ pesoT: 60, receitaId: 'R1' }),
      ord({ pesoT: 60, receitaId: 'R2' }),
      ord({ pesoT: 60, receitaId: 'R2' }),
    ]
    const r = resumoHorasFila(fila, 12, SETUP)
    expect(r.setupMin).toBe(60)
    expect(r.trocas).toBe(1)
  })

  it('fila vazia ocupa zero', () => {
    expect(horasDaFila([], 12, SETUP)).toBe(0)
  })

  it('maquina sem capacidade nominal nao cabe nada', () => {
    expect(horasDaFila([ord()], 0, SETUP)).toBe(Infinity)
    expect(horasDaFila([], 0, SETUP)).toBe(0)
  })

  it('filaDa desempata seq nulo ou repetido pelo numero da ordem, como a tela', () => {
    const ordens = [
      ord({ id: 'z', numero: '200', maquinaId: 'TSI1', dataProg: DIAS[0], seq: null }),
      ord({ id: 'a', numero: '300', maquinaId: 'TSI1', dataProg: DIAS[0], seq: null }),
      ord({ id: 'm', numero: '100', maquinaId: 'TSI1', dataProg: DIAS[0], seq: null }),
    ]
    expect(filaDa(ordens, 'TSI1', DIAS[0]).map((o) => o.numero)).toEqual(['100', '200', '300'])
  })

  it('filaDa devolve a celula na ordem da sequencia', () => {
    const ordens = [
      ord({ id: 'b', maquinaId: 'TSI1', dataProg: DIAS[0], seq: 2 }),
      ord({ id: 'a', maquinaId: 'TSI1', dataProg: DIAS[0], seq: 1 }),
      ord({ id: 'outra', maquinaId: 'TSI2', dataProg: DIAS[0], seq: 1 }),
      ord({ id: 'sem seq', maquinaId: 'TSI1', dataProg: DIAS[0], seq: null }),
    ]
    expect(filaDa(ordens, 'TSI1', DIAS[0]).map((o) => o.id)).toEqual(['a', 'b', 'sem seq'])
  })

  it('otimizar sequencia reduz as horas da fila', () => {
    const fila = [
      ord({ id: 'a', receitaId: 'R1', maquinaId: 'TSI1', dataProg: DIAS[0], seq: 1 }),
      ord({ id: 'b', receitaId: 'R2', maquinaId: 'TSI1', dataProg: DIAS[0], seq: 2 }),
      ord({ id: 'c', receitaId: 'R1', maquinaId: 'TSI1', dataProg: DIAS[0], seq: 3 }),
      ord({ id: 'd', receitaId: 'R2', maquinaId: 'TSI1', dataProg: DIAS[0], seq: 4 }),
    ]
    const antes = horasDaFila(fila, 12, SETUP)
    const nova = otimizarSequencia(fila).map((a) => fila.find((o) => o.id === a.ordemId)!)
    const depois = horasDaFila(nova, 12, SETUP)
    // 3 trocas (120 min) → 1 troca (80 min): 40 min a menos
    expect(antes - depois).toBeCloseTo(40 / 60, 6)
  })

  it('melhor slot cobra o setup de entrar depois da ultima ordem', () => {
    // TSI1 tem 18h de R1 (216 t); a nova, de R2, custa 1 h + 40 min: não cabe hoje
    const existentes = [ord({ maquinaId: 'TSI1', dataProg: DIAS[0], pesoT: 216, receitaId: 'R1', seq: 1 })]
    const nova = ord({ pesoT: 12, receitaId: 'R2' })
    const slot = melhorSlot(nova, [...existentes, nova], [MAQUINAS[0]], DIAS)
    expect(slot?.dia).toBe(DIAS[1])
    // com o mesmo tratamento paga só 20 min: 18h + 1h + 20 min = 19h20 — cabe
    const mesma = ord({ pesoT: 12, receitaId: 'R1' })
    expect(melhorSlot(mesma, [...existentes, mesma], [MAQUINAS[0]], DIAS)?.dia).toBe(DIAS[0])
  })
})

describe('toneladas por tratamento', () => {
  it('agrega por tratamento, do maior peso para o menor', () => {
    const r = toneladasPorTratamento([
      { tratamento: 'FTZ60', pesoT: 10, bags: 12 },
      { tratamento: 'V&P', pesoT: 30, bags: 35 },
      { tratamento: 'FTZ60', pesoT: 15, bags: 18 },
    ])
    expect(r).toEqual([
      { tratamento: 'V&P', ordens: 1, bags: 35, pesoT: 30 },
      { tratamento: 'FTZ60', ordens: 2, bags: 30, pesoT: 25 },
    ])
  })

  it('tratamento vazio ganha rotulo proprio', () => {
    expect(toneladasPorTratamento([{ tratamento: '  ', pesoT: 1, bags: 1 }])[0].tratamento).toBe(
      '(sem tratamento)',
    )
  })

  it('vazio devolve vazio', () => {
    expect(toneladasPorTratamento([])).toEqual([])
  })
})

describe('checklist do dia', () => {
  it('lote nao baixado em ordem urgente e bloqueio', () => {
    const ordens = [
      ord({ maquinaId: 'TSI1', dataProg: DIAS[0], loteBaixado: false, prioridade: 'Urgente' }),
    ]
    const itens = checklistDoDia(ordens, MAQUINAS, DIAS[0])
    expect(itens.some((i) => i.gravidade === 'bloqueio' && /lote/.test(i.mensagem))).toBe(true)
  })

  it('ordem ja iniciada nao conta como lote nao baixado, mas ocupa a maquina', () => {
    const ordens = [
      ord({ maquinaId: 'TSI1', dataProg: DIAS[0], loteBaixado: false, iniciada: true, pesoT: 300 }),
    ]
    const itens = checklistDoDia(ordens, MAQUINAS, DIAS[0])
    expect(itens.some((i) => /lote/.test(i.mensagem))).toBe(false)
    expect(itens.some((i) => i.gravidade === 'bloqueio' && /TSI1/.test(i.mensagem))).toBe(true)
  })

  it('maquina sem capacidade nominal e bloqueio, nao Infinity%', () => {
    const semCap: MaquinaCapacidade[] = [{ id: 'TSI1', capacidadeTh: 0, horasDia: 19.5, setup: SETUP }]
    const ordens = [ord({ maquinaId: 'TSI1', dataProg: DIAS[0] })]
    const itens = checklistDoDia(ordens, semCap, DIAS[0])
    expect(itens[0].gravidade).toBe('bloqueio')
    expect(itens[0].mensagem).not.toMatch(/Infinity/)
  })

  it('lote nao baixado em ordem normal e apenas alerta', () => {
    const ordens = [ord({ maquinaId: 'TSI1', dataProg: DIAS[0], loteBaixado: false })]
    const itens = checklistDoDia(ordens, MAQUINAS, DIAS[0])
    const lote = itens.find((i) => /lote/.test(i.mensagem))
    expect(lote?.gravidade).toBe('alerta')
  })

  it('acima de 100 por cento e bloqueio', () => {
    const ordens = [ord({ maquinaId: 'TSI1', dataProg: DIAS[0], pesoT: 300 })]
    const itens = checklistDoDia(ordens, MAQUINAS, DIAS[0])
    expect(itens.some((i) => i.gravidade === 'bloqueio' && /TSI1/.test(i.mensagem))).toBe(true)
  })

  it('estoura so por causa do setup e diz quanto e setup', () => {
    // 4 × 57 t = 228 t ≤ 234 t (19 h de produção); 3 trocas × 40 min = 2 h → 21 h
    const ordens = ['R1', 'R2', 'R1', 'R2'].map((r, i) =>
      ord({ maquinaId: 'TSI1', dataProg: DIAS[0], seq: i + 1, pesoT: 57, receitaId: r }),
    )
    const itens = checklistDoDia(ordens, MAQUINAS, DIAS[0])
    const item = itens.find((i) => /TSI1/.test(i.mensagem))
    expect(item?.gravidade).toBe('bloqueio')
    expect(item?.mensagem).toMatch(/120 min de setup/)
  })

  it('entre 85 e 100 por cento e alerta', () => {
    const ordens = [ord({ maquinaId: 'TSI1', dataProg: DIAS[0], pesoT: 220 })]
    const itens = checklistDoDia(ordens, MAQUINAS, DIAS[0])
    expect(itens.some((i) => i.gravidade === 'alerta' && /TSI1/.test(i.mensagem))).toBe(true)
  })

  it('dia tranquilo nao gera item', () => {
    const ordens = [ord({ maquinaId: 'TSI1', dataProg: DIAS[0], pesoT: 40 })]
    expect(checklistDoDia(ordens, MAQUINAS, DIAS[0])).toHaveLength(0)
  })

  it('conta o que sobrou no pool', () => {
    const ordens = [ord(), ord()]
    const itens = checklistDoDia(ordens, MAQUINAS, DIAS[0])
    expect(itens.some((i) => /pool/.test(i.mensagem))).toBe(true)
  })
})

describe('toneladas por celula', () => {
  it('soma apenas a maquina e o dia pedidos', () => {
    const ordens = [
      ord({ maquinaId: 'TSI1', dataProg: DIAS[0], pesoT: 10 }),
      ord({ maquinaId: 'TSI1', dataProg: DIAS[1], pesoT: 99 }),
      ord({ maquinaId: 'TSI2', dataProg: DIAS[0], pesoT: 99 }),
    ]
    expect(toneladasDa(ordens, 'TSI1', DIAS[0])).toBe(10)
  })
})
