import { describe, expect, it } from 'vitest'
import { etapasDaOrdem, etapasPendentes, ordemConcluida } from './etapas'
import type { OrdemComEtapas } from './etapas'

const ordem = (
  status: string,
  over: Partial<OrdemComEtapas> = {},
): OrdemComEtapas => ({
  status_efetivo: status,
  checks_processo: 0,
  tem_qualidade_final: false,
  conferida: false,
  ...over,
})

const situacao = (o: OrdemComEtapas, id: string) =>
  etapasDaOrdem(o).find((e) => e.id === id)!.situacao

describe('regua de etapas', () => {
  it('ordem programada: so producao pendente, o resto ainda nao se aplica', () => {
    const o = ordem('Programada')
    expect(situacao(o, 'producao')).toBe('pendente')
    expect(situacao(o, 'q_processo')).toBe('nao-aplicavel')
    expect(situacao(o, 'q_final')).toBe('nao-aplicavel')
    expect(situacao(o, 'conferencia')).toBe('nao-aplicavel')
    expect(situacao(o, 'agrotis')).toBe('nao-aplicavel')
  })

  it('em producao: q. processo abre como pendente', () => {
    const o = ordem('Em producao')
    expect(situacao(o, 'producao')).toBe('pendente')
    expect(situacao(o, 'q_processo')).toBe('pendente')
    expect(situacao(o, 'q_final')).toBe('nao-aplicavel')
  })

  it('parada tambem conta como execucao para o checklist em processo', () => {
    expect(situacao(ordem('Parada'), 'q_processo')).toBe('pendente')
  })

  it('checks em processo registrados: feita, com a contagem', () => {
    const o = ordem('Em producao', { checks_processo: 3 })
    const e = etapasDaOrdem(o).find((x) => x.id === 'q_processo')!
    expect(e.situacao).toBe('feita')
    expect(e.detalhe).toBe('3×')
  })

  it('finalizou sem check em processo: janela perdida, nao vira pendencia', () => {
    const o = ordem('Finalizada')
    const e = etapasDaOrdem(o).find((x) => x.id === 'q_processo')!
    expect(e.situacao).toBe('nao-aplicavel')
    expect(e.detalhe).toBe('não realizada')
  })

  it('finalizada: q. final e conferencia pendentes, agrotis espera a q. final', () => {
    const o = ordem('Finalizada')
    expect(situacao(o, 'producao')).toBe('feita')
    expect(situacao(o, 'q_final')).toBe('pendente')
    expect(situacao(o, 'conferencia')).toBe('pendente')
    const agrotis = etapasDaOrdem(o).find((x) => x.id === 'agrotis')!
    expect(agrotis.situacao).toBe('nao-aplicavel')
    expect(agrotis.detalhe).toBe('aguarda q. final')
  })

  it('qualidade apontada: agrotis destrava; conferencia segue paralela', () => {
    const o = ordem('Qualidade apontada')
    expect(situacao(o, 'q_final')).toBe('feita')
    expect(situacao(o, 'agrotis')).toBe('pendente')
    expect(situacao(o, 'conferencia')).toBe('pendente')
  })

  it('o status carrega a qualidade final implicita', () => {
    // mesmo sem a flag, Qualidade apontada so existe depois da q. final
    expect(situacao(ordem('Qualidade apontada'), 'q_final')).toBe('feita')
    expect(situacao(ordem('Apontada'), 'q_final')).toBe('feita')
  })

  it('conferida marca a etapa da logistica', () => {
    const o = ordem('Finalizada', { conferida: true })
    expect(situacao(o, 'conferencia')).toBe('feita')
  })

  it('apontada no AGROTIS: tudo feito, ordem concluida', () => {
    const o = ordem('Apontada', {
      checks_processo: 2, tem_qualidade_final: true, conferida: true,
    })
    expect(etapasDaOrdem(o).every((e) => e.situacao !== 'pendente')).toBe(true)
    expect(ordemConcluida(o)).toBe(true)
    expect(etapasPendentes(o)).toBe(0)
  })

  it('conta as pendencias para ordenar a visao geral', () => {
    // finalizada crua: q. final + conferencia (agrotis ainda nao abriu)
    expect(etapasPendentes(ordem('Finalizada'))).toBe(2)
    // qualidade apontada sem conferencia: conferencia + agrotis
    expect(etapasPendentes(ordem('Qualidade apontada'))).toBe(2)
  })
})
