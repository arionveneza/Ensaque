import { describe, expect, it } from 'vitest'
import {
  MATRIZ_STATUS,
  chaveOrdem,
  jaIniciada,
  motivoBloqueio,
  pode,
  podeEstornarLote,
  statusEfetivo,
} from './status'
import type { Ordem, StatusEfetivo } from './tipos'

const ordem = (over: Partial<Ordem> = {}): Ordem => ({
  id: 'o1', numero: '79500-1', cultivar: '761 I2X', receitaId: 'R1',
  embalagem: 'BG5M', bags: 45, loteId: 'L-4412', prioridade: 'Normal',
  maquinaId: 'TSI1', dataProg: '2026-07-28', seq: 1, turnoId: null,
  status: 'Programada', eventos: [], paradas: [], tanques: [],
  ...over,
})

describe('status derivado da baixa do lote', () => {
  it('sem maquina a ordem esta fora da programacao', () => {
    expect(statusEfetivo(ordem({ maquinaId: null }), 'Baixado')).toBe('Nao programada')
  })

  it('lote em estoque deixa a ordem aguardando', () => {
    expect(statusEfetivo(ordem(), 'Em estoque')).toBe('Aguardando lote')
  })

  it('lote baixado libera a ordem', () => {
    expect(statusEfetivo(ordem(), 'Baixado')).toBe('Pronto para produzir')
  })

  it('status ja iniciado nao e sobrescrito pelo lote', () => {
    expect(statusEfetivo(ordem({ status: 'Em producao' }), 'Em estoque')).toBe('Em producao')
    expect(statusEfetivo(ordem({ status: 'Apontada' }), 'Em estoque')).toBe('Apontada')
  })
})

describe('matriz de permissoes', () => {
  it('so Pronto para produzir permite iniciar', () => {
    const podemIniciar = (Object.keys(MATRIZ_STATUS) as StatusEfetivo[])
      .filter((s) => MATRIZ_STATUS[s].iniciar)
    expect(podemIniciar).toEqual(['Pronto para produzir'])
  })

  it('antes de iniciar tudo e editavel e excluivel', () => {
    for (const s of ['Nao programada', 'Programada', 'Aguardando lote', 'Pronto para produzir'] as const) {
      expect(pode(s, 'editar')).toBe(true)
      expect(pode(s, 'excluir')).toBe(true)
      expect(pode(s, 'priorizar')).toBe(true)
    }
  })

  it('depois que a producao toca a ordem, nada de medicao muda', () => {
    for (const s of ['Em producao', 'Parada', 'Finalizada', 'Qualidade apontada', 'Apontada'] as const) {
      expect(pode(s, 'editar')).toBe(false)
      expect(pode(s, 'excluir')).toBe(false)
      expect(pode(s, 'priorizar')).toBe(false)
    }
  })

  it('qualidade so aponta ordem finalizada ou ja apontada pela qualidade', () => {
    const comQualidade = (Object.keys(MATRIZ_STATUS) as StatusEfetivo[])
      .filter((s) => MATRIZ_STATUS[s].qualidade)
    expect(comQualidade.sort()).toEqual(['Finalizada', 'Qualidade apontada'])
  })

  it('ordem Apontada e registro definitivo: nenhuma acao', () => {
    const p = MATRIZ_STATUS.Apontada
    expect(Object.values(p).every((v) => v === false)).toBe(true)
  })

  it('estorno so antes de iniciar', () => {
    const comEstorno = (Object.keys(MATRIZ_STATUS) as StatusEfetivo[])
      .filter((s) => MATRIZ_STATUS[s].estornarLote)
    expect(comEstorno.sort()).toEqual(
      ['Aguardando lote', 'Nao programada', 'Pronto para produzir', 'Programada'].sort(),
    )
  })

  it('jaIniciada separa historico de editavel', () => {
    expect(jaIniciada('Programada')).toBe(false)
    expect(jaIniciada('Pronto para produzir')).toBe(false)
    expect(jaIniciada('Em producao')).toBe(true)
    expect(jaIniciada('Finalizada')).toBe(true)
  })
})

describe('estorno do lote olha todas as ordens dependentes', () => {
  it('libera quando nenhuma ordem do lote comecou', () => {
    const r = podeEstornarLote([{ status: 'Programada' }, { status: 'Aguardando lote' }])
    expect(r.permitido).toBe(true)
  })

  it('bloqueia se QUALQUER ordem do lote ja foi iniciada', () => {
    const r = podeEstornarLote([{ status: 'Programada' }, { status: 'Em producao' }])
    expect(r.permitido).toBe(false)
    expect(r.motivo).toMatch(/1 ordem/)
  })

  it('bloqueia tambem quando a ordem ja terminou', () => {
    expect(podeEstornarLote([{ status: 'Apontada' }]).permitido).toBe(false)
  })

  it('lote sem ordens pode ser estornado', () => {
    expect(podeEstornarLote([]).permitido).toBe(true)
  })
})

describe('mensagem de bloqueio', () => {
  it('explica medicao em andamento', () => {
    expect(motivoBloqueio('Em producao')).toMatch(/andamento/)
  })

  it('explica distorcao de relatorio depois de finalizar', () => {
    expect(motivoBloqueio('Finalizada')).toMatch(/finalizada/)
  })

  it('nao ha bloqueio antes de iniciar', () => {
    expect(motivoBloqueio('Programada')).toBeNull()
  })
})

describe('chave anti-duplicidade', () => {
  it('numero, cultivar, tratamento e embalagem definem a ordem', () => {
    const a = chaveOrdem({ numero: '1', cultivar: 'C', receitaId: 'R1', embalagem: 'BG5M' })
    const b = chaveOrdem({ numero: '1', cultivar: 'C', receitaId: 'R1', embalagem: 'MEIOBAG' })
    expect(a).not.toBe(b)
    expect(a).toBe(chaveOrdem({ numero: '1', cultivar: 'C', receitaId: 'R1', embalagem: 'BG5M' }))
  })
})
