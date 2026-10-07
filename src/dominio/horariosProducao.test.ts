import { describe, expect, it } from 'vitest'
import {
  horaNoDia, horariosPorDiaEMaquina, type OrdemHorario, type ParadaDaOrdem, type ParadaDeMaquina,
} from './horariosProducao'

// horários LOCAIS (sem fuso), como o navegador do galpão lê
const ordem = (id: string, maquina: string, ini: string, fim: string | null, bruto = 3600): OrdemHorario => ({
  ordem_id: id, numero: `N${id}`, maquina_id: maquina, turno_id: 1, ini, fim,
  bruto_s: bruto, paradas_s: 0, liquido_s: bruto,
})
const parada = (ordem_id: string, inicio: string, fim: string, segundos: number, motivo = 'Setup'): ParadaDaOrdem => ({
  ordem_id, inicio, fim, segundos, motivo, tipo: 'Planejada',
})
const paradaMaq = (maquina: string, dia: string, inicio: string, segundos: number): ParadaDeMaquina => ({
  maquina_id: maquina, dia, inicio, fim: null, segundos, motivo: 'Aguardando semente', tipo: 'Nao planejada',
})

describe('horariosPorDiaEMaquina (07/10/2026)', () => {
  it('agrupa por dia de produção e máquina, ordens na ordem de início com as suas paradas embaixo', () => {
    const g = horariosPorDiaEMaquina(
      [
        ordem('2', 'TSI1', '2026-10-07T11:05:00', '2026-10-07T13:00:00'),
        ordem('1', 'TSI1', '2026-10-07T07:42:00', '2026-10-07T10:15:00', 9180),
        ordem('3', 'TSI2', '2026-10-07T08:00:00', null),
      ],
      [
        parada('1', '2026-10-07T09:00:00', '2026-10-07T09:05:00', 300, 'Refeição'),
        parada('1', '2026-10-07T08:10:00', '2026-10-07T08:25:00', 900),
      ],
      [paradaMaq('TSI1', '2026-10-07', '2026-10-07T10:20:00', 2400)],
    )
    expect(g.map((x) => `${x.dia}|${x.maquina_id}`)).toEqual(['2026-10-07|TSI1', '2026-10-07|TSI2'])
    const tsi1 = g[0]
    expect(tsi1.linhas.map((l) => (l.linha === 'ordem' ? l.numero : 'maq'))).toEqual(['N1', 'maq', 'N2'])
    const o1 = tsi1.linhas[0]
    expect(o1.linha === 'ordem' && o1.paradas.map((p) => p.motivo)).toEqual(['Setup', 'Refeição'])
    expect(tsi1.ordens).toBe(2)
    expect(tsi1.brutoS).toBe(9180 + 3600)
    expect(tsi1.paradasOrdemS).toBe(1200)
    expect(tsi1.paradasMaquinaS).toBe(2400)
  })

  it('a ordem que começa de madrugada fica no dia de produção anterior (turno 2)', () => {
    const g = horariosPorDiaEMaquina([ordem('9', 'TSI1', '2026-10-08T01:30:00', '2026-10-08T02:40:00')], [], [])
    expect(g[0].dia).toBe('2026-10-07')
  })

  it('dias em ordem crescente e TSI 3 depois da TSI 1', () => {
    const g = horariosPorDiaEMaquina(
      [
        ordem('a', 'TSI3', '2026-10-06T08:00:00', null),
        ordem('b', 'TSI1', '2026-10-07T08:00:00', null),
        ordem('c', 'TSI1', '2026-10-06T09:00:00', null),
      ],
      [],
      [],
    )
    expect(g.map((x) => `${x.dia}|${x.maquina_id}`)).toEqual([
      '2026-10-06|TSI1', '2026-10-06|TSI3', '2026-10-07|TSI1',
    ])
  })

  it('máquina só com parada (sem ordem no dia) também aparece', () => {
    const g = horariosPorDiaEMaquina([], [], [paradaMaq('TSI2', '2026-10-07', '2026-10-07T08:00:00', 3600)])
    expect(g).toHaveLength(1)
    expect(g[0].ordens).toBe(0)
    expect(g[0].paradasMaquinaS).toBe(3600)
  })
})

describe('horaNoDia', () => {
  it('hora curta no mesmo dia; com a data quando o relógio virou', () => {
    expect(horaNoDia('2026-10-07T08:10:00', '2026-10-07')).toBe('08:10')
    expect(horaNoDia('2026-10-08T01:30:00', '2026-10-07')).toBe('01:30 (08/10)')
  })
})
