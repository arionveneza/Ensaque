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
    expect(permitidoPadrao('PCP', 'qualidade', 'agrotis')).toBe(true)
    expect(permitidoPadrao('Qualidade', 'qualidade', 'agrotis')).toBe(false)
  })

  it('Gestor tem todas as acoes de todos os recursos', () => {
    for (const [recurso, acoes] of Object.entries(ACOES_POR_RECURSO))
      for (const acao of acoes)
        expect(permitidoPadrao('Gestor', recurso, acao)).toBe(true)
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
