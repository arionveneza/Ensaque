import { describe, expect, it } from 'vitest'
import {
  BLOCOS, QUADRAS, armazemValido, ehArmazemTsi, normalizaEndereco, numeroEndereco, problemaEndereco,
  rotuloArmazem, rotuloEndereco,
} from './endereco'

describe('armazens do sistema TSI Entrada / TSI Saida (14/10/2026)', () => {
  it('reconhece os dois e nenhum outro', () => {
    expect(ehArmazemTsi('TSI ENTRADA')).toBe(true)
    expect(ehArmazemTsi(' tsi saida ')).toBe(true)
    expect(ehArmazemTsi('A')).toBe(false)
    expect(ehArmazemTsi(null)).toBe(false)
  })

  it('nao vale como endereco digitado (A-E continua a regra)', () => {
    expect(armazemValido('TSI SAIDA')).toBe(false)
    expect(normalizaEndereco({ armazem: 'TSI SAIDA', bloco: '0', quadra: '0' })).toBeNull()
  })

  it('rotulos', () => {
    expect(rotuloArmazem('TSI SAIDA')).toBe('TSI Saída')
    expect(rotuloArmazem('TSI ENTRADA')).toBe('TSI Entrada')
    expect(rotuloArmazem('B')).toBe('B')
    expect(rotuloEndereco({ armazem: 'TSI SAIDA', bloco: '0', quadra: '0' })).toBe('TSI Saída')
    expect(rotuloEndereco({ armazem: 'A', bloco: '3', quadra: '5' })).toBe('A 3 Q05')
  })
})

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
