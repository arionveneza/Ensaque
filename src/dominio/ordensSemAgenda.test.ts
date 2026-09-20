import { describe, expect, it } from 'vitest'
import { entraNaAvaliacao, ordensSemAgenda, type AgendaDoProduto, type OrdemAvaliavel } from './ordensSemAgenda'

const ord = (over: Partial<OrdemAvaliavel> = {}): OrdemAvaliavel => ({
  id: 'o1', numero: '100', cultivar: 'NEO700 I2X', receita_nome: 'FTZ60', embalagem: 'BG5M', bags: 20,
  maquina_id: 'TSI1', data_prog: '2026-09-21', status_efetivo: 'Programada', fora_balanco: false, ...over,
})
const ag = (over: Partial<AgendaDoProduto> = {}): AgendaDoProduto => ({
  cultivar: 'NEO700 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', data: '2026-09-22', bags: 10, ...over,
})
const ATE = '2026-09-25'

describe('ordensSemAgenda (19/09/2026)', () => {
  it('sem agendamento nenhum, toda ordem avaliada sai sem caminhao', () => {
    const r = ordensSemAgenda([ord()], [], ATE)
    expect(r.avaliadas).toBe(1)
    expect(r.semAgenda.map((x) => x.ordem.id)).toEqual(['o1'])
    expect(r.semAgenda[0]).toMatchObject({ proximaAgenda: null, agendadoDepois: 0, bagsNaProximaAgenda: 0 })
    expect(r.foraDosErps).toEqual([])
  })

  it('agendamento do produto com data ate X: a ordem tem caminhao e nao aparece', () => {
    const r = ordensSemAgenda([ord()], [ag({ data: '2026-09-25' })], ATE)
    expect(r.avaliadas).toBe(1)
    expect(r.semAgenda).toEqual([])
  })

  it('so agendamento DEPOIS de X: aparece, com a menor data, os bags DESSA data e a soma de depois', () => {
    const r = ordensSemAgenda(
      [ord()],
      [
        ag({ data: '2026-10-03', bags: 7 }),
        ag({ data: '2026-09-28', bags: 5 }),
        ag({ data: '2026-09-28', bags: 2 }),
        ag({ data: '2026-11-01', bags: 1 }),
      ],
      ATE,
    )
    expect(r.semAgenda).toHaveLength(1)
    // 28/09 leva 7 (5 + 2); a soma de tudo depois de X é 15 — a tela não pode colar 15 no 28/09
    expect(r.semAgenda[0]).toMatchObject({ proximaAgenda: '2026-09-28', bagsNaProximaAgenda: 7, agendadoDepois: 15 })
  })

  it('agendamento SEM data conta como caminhao (prazo desconhecido nao e "nunca")', () => {
    const r = ordensSemAgenda([ord()], [ag({ data: null })], ATE)
    expect(r.semAgenda).toEqual([])
  })

  it('a chave normaliza caixa, espaco e o "+" do tratamento, e o cultivar', () => {
    const r = ordensSemAgenda(
      [ord({ receita_nome: 'FTZ60 + VIC', cultivar: 'neo700  i2x' })],
      [ag({ tratamento: 'ftz60+vic', cultivar: 'NEO700 I2X' })],
      ATE,
    )
    expect(r.semAgenda).toEqual([])
  })

  it('embalagem e estrita: caminhao de MEIOBAG nao atende ordem de BG5M', () => {
    const r = ordensSemAgenda([ord({ embalagem: 'BG5M' })], [ag({ embalagem: 'MEIOBAG' })], ATE)
    expect(r.semAgenda).toHaveLength(1)
  })

  it('embalagem fora dos ERPs (SC10/SC20) sai da avaliacao, contada a parte — nunca "sem caminhao"', () => {
    const sc10 = ord({ id: 's', numero: '150001', embalagem: 'SC10', maquina_id: 'TSI3' })
    const foraDosErps = (e: string) => e === 'SC10' || e === 'SC20'
    const r = ordensSemAgenda([sc10, ord()], [ag({ data: '2026-09-22' })], ATE, { foraDosErps })
    expect(r.avaliadas).toBe(1)
    expect(r.semAgenda).toEqual([])
    expect(r.foraDosErps.map((o) => o.id)).toEqual(['s'])
    // sem a opção, o SC10 vira alarme permanente (é o que a opção existe para evitar)
    expect(ordensSemAgenda([sc10], [ag()], ATE).semAgenda).toHaveLength(1)
    // fora da avaliação por outro motivo (concluída) não entra em foraDosErps
    expect(ordensSemAgenda([{ ...sc10, status_efetivo: 'Apontada' }], [], ATE, { foraDosErps }).foraDosErps).toEqual([])
  })

  it('SEM TSI casa so pelo cultivar, em qualquer embalagem, e nao casa com tratado', () => {
    const branca = ord({ id: 'b', receita_nome: 'SEM TSI', embalagem: 'BG5M' })
    expect(ordensSemAgenda([branca], [ag({ tratamento: 'SEM TSI', embalagem: 'MEIOBAG' })], ATE).semAgenda).toEqual([])
    expect(ordensSemAgenda([branca], [ag({ tratamento: 'FTZ60' })], ATE).semAgenda).toHaveLength(1)
    // e o contrário: caminhão de branca não atende ordem tratada
    expect(ordensSemAgenda([ord()], [ag({ tratamento: 'SEM TSI' })], ATE).semAgenda).toHaveLength(1)
  })

  it('entra na avaliacao: so com maquina e dia ate X, nao concluida, nao excluida, no balanco', () => {
    expect(entraNaAvaliacao(ord(), ATE)).toBe(true)
    expect(entraNaAvaliacao(ord({ maquina_id: null }), ATE)).toBe(false)
    expect(entraNaAvaliacao(ord({ data_prog: null }), ATE)).toBe(false)
    expect(entraNaAvaliacao(ord({ data_prog: '2026-09-26' }), ATE)).toBe(false)
    expect(entraNaAvaliacao(ord({ data_prog: '2026-09-25' }), ATE)).toBe(true)
    // atrasada (dia passado) entra: ainda vai rodar
    expect(entraNaAvaliacao(ord({ data_prog: '2026-09-01' }), ATE)).toBe(true)
    for (const s of ['Finalizada', 'Qualidade apontada', 'Apontada', 'Excluida']) {
      expect(entraNaAvaliacao(ord({ status_efetivo: s }), ATE)).toBe(false)
    }
    // a excluída chega da v_ordens com status_efetivo derivado (Programada…): é o status CRU que a denuncia
    expect(entraNaAvaliacao(ord({ status: 'Excluida', status_efetivo: 'Programada' }), ATE)).toBe(false)
    expect(entraNaAvaliacao(ord({ status: 'Programada', status_efetivo: 'Programada' }), ATE)).toBe(true)
    for (const s of ['Programada', 'Aguardando lote', 'Pronto para produzir', 'Em producao', 'Parada']) {
      expect(entraNaAvaliacao(ord({ status_efetivo: s }), ATE)).toBe(true)
    }
    expect(entraNaAvaliacao(ord({ fora_balanco: true }), ATE)).toBe(false)
  })

  it('ordem repetida (semana + atrasadas) conta uma vez so', () => {
    const o = ord()
    const r = ordensSemAgenda([o, { ...o }], [], ATE)
    expect(r.avaliadas).toBe(1)
    expect(r.semAgenda).toHaveLength(1)
  })

  it('ordena por dia, maquina e numero (pt-BR numerico)', () => {
    const r = ordensSemAgenda(
      [
        ord({ id: 'a', numero: '10', maquina_id: 'TSI2', data_prog: '2026-09-22' }),
        ord({ id: 'b', numero: '9', maquina_id: 'TSI1', data_prog: '2026-09-22' }),
        ord({ id: 'c', numero: '100', maquina_id: 'TSI1', data_prog: '2026-09-21' }),
        ord({ id: 'd', numero: '10', maquina_id: 'TSI1', data_prog: '2026-09-22' }),
      ],
      [],
      ATE,
    )
    expect(r.semAgenda.map((x) => x.ordem.id)).toEqual(['c', 'b', 'd', 'a'])
  })

  it('nao muta as entradas', () => {
    const ordens = [ord({ id: 'z' }), ord({ id: 'a', data_prog: '2026-09-20' })]
    const agendas = [ag({ data: '2026-10-01' })]
    const antes = JSON.stringify([ordens, agendas])
    ordensSemAgenda(ordens, agendas, ATE)
    expect(JSON.stringify([ordens, agendas])).toBe(antes)
    expect(ordens.map((o) => o.id)).toEqual(['z', 'a'])
  })
})
