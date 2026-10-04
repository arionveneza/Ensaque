import { describe, expect, it } from 'vitest'
import {
  BLOCOS, QUADRAS, armazemValido, normalizaEndereco, numeroEndereco, problemaEndereco,
} from './endereco'

describe('endereço do galpão (03/10/2026)', () => {
  it('faixas: armazém A–E, bloco 1–44, quadra 1–20', () => {
    expect(BLOCOS).toHaveLength(44)
    expect(BLOCOS[0]).toBe('1')
    expect(BLOCOS[43]).toBe('44')
    expect(QUADRAS).toHaveLength(20)
    expect(QUADRAS[19]).toBe('20')
    expect(armazemValido('a')).toBe(true)
    expect(armazemValido('F')).toBe(false)
    expect(armazemValido('TSI')).toBe(false)
  })

  it('número sem zero à esquerda; formato antigo com letra colada vira só o número', () => {
    expect(numeroEndereco('6', 44)).toBe('6')
    expect(numeroEndereco('06', 44)).toBe('6')
    expect(numeroEndereco('06E', 44)).toBe('6')
    expect(numeroEndereco('1A', 44)).toBe('1')
    expect(numeroEndereco(' 44 ', 44)).toBe('44')
  })

  it('fora da faixa ou texto livre é recusado', () => {
    expect(numeroEndereco('0', 44)).toBeNull()
    expect(numeroEndereco('45', 44)).toBeNull()
    expect(numeroEndereco('21', 20)).toBeNull()
    expect(numeroEndereco('CORREDOR', 20)).toBeNull()
    expect(numeroEndereco('', 20)).toBeNull()
    expect(numeroEndereco(null, 20)).toBeNull()
  })

  it('normaliza o endereço completo ou devolve null', () => {
    expect(normalizaEndereco({ armazem: 'e', bloco: '06E', quadra: '04' })).toEqual({ armazem: 'E', bloco: '6', quadra: '4' })
    expect(normalizaEndereco({ armazem: 'A', bloco: '1', quadra: null })).toBeNull()
    expect(normalizaEndereco({ armazem: 'X', bloco: '1', quadra: '1' })).toBeNull()
  })

  it('diz o que falta, na ordem do formulário', () => {
    expect(problemaEndereco({ armazem: '', bloco: '1', quadra: '1' })).toMatch(/armazém/)
    expect(problemaEndereco({ armazem: 'A', bloco: '50', quadra: '1' })).toMatch(/bloco/)
    expect(problemaEndereco({ armazem: 'A', bloco: '5', quadra: '' })).toMatch(/quadra/)
    expect(problemaEndereco({ armazem: 'A', bloco: '5', quadra: '20' })).toBeNull()
  })
})
