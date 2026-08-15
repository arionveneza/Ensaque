import { describe, expect, it } from 'vitest'
import {
  ACOES_POR_RECURSO, MATRIZ_PADRAO, permissaoEfetiva, permitidoPadrao,
} from './permissoes'
import type { Perfil } from './tipos'

describe('matriz padrao', () => {
  it('espelha a especificacao para a Qualidade', () => {
    expect(permitidoPadrao('Qualidade', 'execucao', 'ver')).toBe(true)
    expect(permitidoPadrao('Qualidade', 'qualidade', 'ver')).toBe(true)
    expect(permitidoPadrao('Qualidade', 'qualidade', 'qualidade')).toBe(true)
    expect(permitidoPadrao('Qualidade', 'indicadores', 'ver')).toBe(true)
    // o que a Qualidade NAO faz
    expect(permitidoPadrao('Qualidade', 'qualidade', 'agrotis')).toBe(false)
    expect(permitidoPadrao('Qualidade', 'ordens', 'ver')).toBe(false)
    expect(permitidoPadrao('Qualidade', 'cadastros', 'ver')).toBe(false)
    expect(permitidoPadrao('Qualidade', 'execucao', 'apontar')).toBe(false)
  })

  it('so a Logistica baixa lote; so a Producao aponta', () => {
    expect(permitidoPadrao('Logistica', 'lotes', 'baixar_lote')).toBe(true)
    expect(permitidoPadrao('PCP', 'lotes', 'baixar_lote')).toBe(false)
    expect(permitidoPadrao('Producao', 'execucao', 'apontar')).toBe(true)
    expect(permitidoPadrao('Qualidade', 'execucao', 'apontar')).toBe(false)
  })

  it('AGROTIS e do PCP, nao da Qualidade', () => {
    expect(permitidoPadrao('PCP', 'agrotis', 'lancar')).toBe(true)
    expect(permitidoPadrao('PCP', 'agrotis', 'ver')).toBe(true)
    expect(permitidoPadrao('Qualidade', 'agrotis', 'lancar')).toBe(false)
    expect(permitidoPadrao('Qualidade', 'agrotis', 'ver')).toBe(false)
  })

  it('conferencia de estoque e da Logistica', () => {
    expect(permitidoPadrao('Logistica', 'lotes', 'conferir')).toBe(true)
    expect(permitidoPadrao('PCP', 'lotes', 'conferir')).toBe(false)
    expect(permitidoPadrao('Qualidade', 'lotes', 'conferir')).toBe(false)
  })

  it('a visao geral de etapas todo perfil ve', () => {
    for (const p of ['PCP', 'Logistica', 'Producao', 'Qualidade', 'Direcao', 'Gestor'] as const)
      expect(permitidoPadrao(p, 'etapas', 'ver')).toBe(true)
  })

  // Direcao acompanha a operacao inteira sem poder mexer em nada
  it('Direcao ve todas as telas de operacao', () => {
    for (const r of ['ordens', 'programacao', 'lotes', 'execucao', 'qualidade',
      'agrotis', 'etapas', 'indicadores', 'cadastros'])
      expect(permitidoPadrao('Direcao', r, 'ver')).toBe(true)
  })

  it('Direcao NAO tem nenhuma acao de escrita', () => {
    const escrita = Object.entries(ACOES_POR_RECURSO).flatMap(([recurso, acoes]) =>
      acoes.filter((a) => a !== 'ver').map((a) => [recurso, a] as const),
    )
    // se um dia alguem acrescentar acao ao padrao da Direcao, este teste pega
    for (const [recurso, acao] of escrita)
      expect(
        permitidoPadrao('Direcao', recurso, acao),
        `Direcao nao pode ${acao} em ${recurso}`,
      ).toBe(false)
  })

  it('Gestor tem todas as acoes de todos os recursos', () => {
    for (const [recurso, acoes] of Object.entries(ACOES_POR_RECURSO))
      for (const acao of acoes)
        expect(permitidoPadrao('Gestor', recurso, acao)).toBe(true)
  })

  it('Balanca so enxerga veiculos, nada mais', () => {
    for (const [recurso, acoes] of Object.entries(ACOES_POR_RECURSO)) {
      if (recurso === 'veiculos') continue
      for (const acao of acoes)
        expect(
          permitidoPadrao('Balanca', recurso, acao),
          `Balanca nao pode ${acao} em ${recurso}`,
        ).toBe(false)
    }
    for (const acao of ['ver', 'chamar', 'checklist'])
      expect(permitidoPadrao('Balanca', 'veiculos', acao)).toBe(true)
  })

  it('nenhum perfil concede acao que o recurso nao tem', () => {
    // protege contra typo no padrao ('bajxar_lote' viraria permissao morta)
    for (const [perfil, recursos] of Object.entries(MATRIZ_PADRAO))
      for (const [recurso, acoes] of Object.entries(recursos))
        for (const acao of acoes)
          expect(
            ACOES_POR_RECURSO[recurso],
            `${perfil}.${recurso}.${acao}`,
          ).toContain(acao)
  })
})

describe('permissao efetiva: explicito manda, ausente cai no padrao', () => {
  const perfil: Perfil = 'Qualidade'

  it('sem linha explicita vale o padrao', () => {
    expect(permissaoEfetiva(perfil, 'qualidade', 'qualidade', [])).toBe(true)
    expect(permissaoEfetiva(perfil, 'ordens', 'ver', [])).toBe(false)
  })

  it('linha explicita desliga o que o padrao ligava', () => {
    const exp = [{ recurso: 'qualidade', acao: 'qualidade', permitido: false }]
    expect(permissaoEfetiva(perfil, 'qualidade', 'qualidade', exp)).toBe(false)
    // e nao contamina o resto do perfil
    expect(permissaoEfetiva(perfil, 'execucao', 'ver', exp)).toBe(true)
  })

  it('linha explicita liga o que o padrao negava', () => {
    const exp = [{ recurso: 'ordens', acao: 'ver', permitido: true }]
    expect(permissaoEfetiva(perfil, 'ordens', 'ver', exp)).toBe(true)
  })

  it('marcar UMA celula nao vira tudo-ou-nada', () => {
    // a armadilha classica: primeira gravacao do perfil nao pode apagar o padrao
    const exp = [{ recurso: 'execucao', acao: 'ver', permitido: true }]
    expect(permissaoEfetiva(perfil, 'qualidade', 'ver', exp)).toBe(true)
    expect(permissaoEfetiva(perfil, 'indicadores', 'ver', exp)).toBe(true)
  })
})
