import { describe, expect, it } from 'vitest'
import {
  autoProgramar,
  checklistDoDia,
  melhorSlot,
  otimizarSequencia,
  rebalancearDia,
  toneladasDa,
  trocasDeReceita,
  type MaquinaCapacidade,
  type OrdemProgramavel,
} from './programacao'

const MAQUINAS: MaquinaCapacidade[] = [
  { id: 'TSI1', capacidadeDiaT: 234 },
  { id: 'TSI2', capacidadeDiaT: 234 },
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

  it('respeita a capacidade: nao estoura o dia', () => {
    const ordens = Array.from({ length: 20 }, () => ord({ pesoT: 40 }))
    const r = autoProgramar(ordens, MAQUINAS, DIAS)
    for (const dia of DIAS) {
      for (const m of MAQUINAS) {
        const noSlot = r.atribuicoes.filter((a) => a.dia === dia && a.maquinaId === m.id)
        const ton = noSlot.reduce(
          (acc, a) => acc + ordens.find((o) => o.id === a.ordemId)!.pesoT,
          0,
        )
        expect(ton).toBeLessThanOrEqual(m.capacidadeDiaT)
      }
    }
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

  it('dia equilibrado nao gera movimento', () => {
    const ordens = [
      ord({ maquinaId: 'TSI1', dataProg: DIAS[0], pesoT: 50 }),
      ord({ maquinaId: 'TSI2', dataProg: DIAS[0], pesoT: 50 }),
    ]
    expect(rebalancearDia(ordens, MAQUINAS, DIAS[0])).toBeNull()
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
