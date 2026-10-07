import { describe, expect, it } from 'vitest'
import {
  carregamentoDaSemana, inicioDoDiaProducao, noPlanoDoDia, planejadoExecutado, producaoDaSemana, semanaDe,
  type MudancaDeDia, type OrdemPlano,
} from './gerencial'

// horários LOCAIS (sem fuso), como o navegador lê
const ordem = (id: string, data_prog: string | null, o: Partial<OrdemPlano> = {}): OrdemPlano => ({
  id, data_prog, bags: 20, bags_produzidos: null, peso_t: 20, fim: null, ...o,
})

describe('semana de segunda a domingo', () => {
  it('quarta 07/10/2026 → segunda 05 a domingo 11', () => {
    expect(semanaDe('2026-10-07')).toEqual([
      '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11',
    ])
  })
  it('domingo pertence à semana que começou na segunda anterior', () => {
    expect(semanaDe('2026-10-11')[0]).toBe('2026-10-05')
    expect(semanaDe('2026-10-12')[0]).toBe('2026-10-12')
  })
  it('o plano congela às 07:30', () => {
    const t = inicioDoDiaProducao('2026-10-07')
    expect([t.getHours(), t.getMinutes(), t.getDate()]).toEqual([7, 30, 7])
  })
})

describe('carregamento digitado: acumulado da semana', () => {
  it('soma veículos e bags carregados de segunda até cada dia; dia sem lançamento soma zero', () => {
    const dias = semanaDe('2026-10-07')
    const r = carregamentoDaSemana(dias, [
      { dia: '2026-10-05', veiculos_carregados: 8, bags_carregados: 300, veiculos_descarregados: 2, veiculos_patio: 3 },
      { dia: '2026-10-07', veiculos_carregados: 6, bags_carregados: 250, veiculos_descarregados: 1, veiculos_patio: 1 },
    ])
    expect(r).toHaveLength(7)
    expect(r.map((x) => x.acumVeiculos)).toEqual([8, 8, 14, 14, 14, 14, 14])
    expect(r.map((x) => x.acumBags)).toEqual([300, 300, 550, 550, 550, 550, 550])
    expect(r[1].veiculos_carregados).toBeNull()
  })
})

const muda = (ordem_id: string, de_dia: string | null, para_dia: string | null, ts: string): MudancaDeDia => ({
  ordem_id, de_dia, para_dia, ts,
})

describe('planejado × executado: a cascata não apaga o plano do dia (07/10/2026)', () => {
  it('a ordem empurrada continua no plano do dia de onde saiu e entra no do dia pra onde foi', () => {
    // estava no 06; às 22:00 do 06 a cascata mandou pro 07
    const o = ordem('a', '2026-10-07')
    const m = [muda('a', '2026-10-06', '2026-10-07', '2026-10-06T22:00:00')]
    expect(noPlanoDoDia(o, m, '2026-10-06')).toBe(true)
    expect(noPlanoDoDia(o, m, '2026-10-07')).toBe(true)
    const [d6, d7] = planejadoExecutado(['2026-10-06', '2026-10-07'], [o], m)
    expect(d6).toMatchObject({ planejadoT: 20, empurradoT: 20, executadoT: 0 })
    expect(d7).toMatchObject({ planejadoT: 20, empurradoT: 0 })
  })

  it('empurrada ANTES do dia começar não conta nele; adiantada (pra dia anterior) também não', () => {
    const antes = ordem('b', '2026-10-08')
    const mAntes = [muda('b', '2026-10-07', '2026-10-08', '2026-10-06T23:00:00')]
    expect(noPlanoDoDia(antes, mAntes, '2026-10-07')).toBe(false)
    const adiantada = ordem('c', '2026-10-06')
    const mAdiant = [muda('c', '2026-10-08', '2026-10-06', '2026-10-06T10:00:00')]
    expect(noPlanoDoDia(adiantada, mAdiant, '2026-10-08')).toBe(false)
  })

  it('devolvida ao pool durante o dia conta como planejada e não feita', () => {
    const o = ordem('d', null)
    const m = [muda('d', '2026-10-07', null, '2026-10-07T15:00:00')]
    expect(noPlanoDoDia(o, m, '2026-10-07')).toBe(true)
  })

  it('a que já tinha terminado antes do dia começar não entra; a criada e feita no dia entra', () => {
    expect(noPlanoDoDia(ordem('e', '2026-10-07', { fim: '2026-10-06T23:00:00' }), [], '2026-10-07')).toBe(false)
    expect(noPlanoDoDia(ordem('f', '2026-10-07', { fim: '2026-10-07T16:00:00' }), [], '2026-10-07')).toBe(true)
  })

  it('executado é o que terminou no dia de produção; do plano separa o adiantado', () => {
    const ordens = [
      ordem('p', '2026-10-07', { fim: '2026-10-07T15:00:00', bags_produzidos: 18 }), // do plano, feita
      ordem('q', '2026-10-07'), // do plano, não feita
      ordem('r', '2026-10-08', { fim: '2026-10-07T20:00:00' }), // adiantada
      ordem('s', '2026-10-07', { fim: '2026-10-08T01:30:00' }), // terminou de madrugada: ainda é o dia 07
    ]
    const [d] = planejadoExecutado(['2026-10-07'], ordens, [])
    expect(d.planejadoOrdens).toBe(3)
    expect(d.planejadoT).toBe(60)
    expect(d.executadoOrdens).toBe(3)
    expect(d.executadoT).toBeCloseTo(18 + 20 + 20)
    expect(d.executadoBags).toBe(18 + 20 + 20)
    expect(d.doPlanoOrdens).toBe(2)
    expect(d.doPlanoT).toBeCloseTo(18 + 20)
  })

  it('semana: a ordem empurrada de dia em dia conta UMA vez no planejado da semana', () => {
    const dias = semanaDe('2026-10-07')
    const o = ordem('g', '2026-10-08', { fim: '2026-10-08T12:00:00' })
    const m = [
      muda('g', '2026-10-06', '2026-10-07', '2026-10-06T22:00:00'),
      muda('g', '2026-10-07', '2026-10-08', '2026-10-07T22:00:00'),
    ]
    const porDia = planejadoExecutado(dias, [o], m)
    expect(porDia.filter((d) => d.planejadoOrdens > 0).map((d) => d.dia)).toEqual([
      '2026-10-06', '2026-10-07', '2026-10-08',
    ])
    const sem = producaoDaSemana(dias, [o], m)
    expect(sem).toMatchObject({ planejadoOrdens: 1, planejadoT: 20, executadoOrdens: 1, doPlanoOrdens: 1 })
  })

  it('semana: a adiantada dentro da semana conta no plano da semana (não no de dia nenhum)', () => {
    const dias = semanaDe('2026-10-07')
    // programada pra quinta 08, feita na quarta 07
    const o = ordem('h', '2026-10-08', { fim: '2026-10-07T17:00:00' })
    expect(planejadoExecutado(dias, [o], []).every((d) => d.planejadoOrdens === 0)).toBe(true)
    expect(producaoDaSemana(dias, [o], [])).toMatchObject({ planejadoOrdens: 1, executadoOrdens: 1, doPlanoOrdens: 1 })
    // a que já tinha terminado antes da segunda não entra
    const velha = ordem('i', '2026-10-05', { fim: '2026-10-04T20:00:00' })
    expect(producaoDaSemana(dias, [velha], []).planejadoOrdens).toBe(0)
  })
})
