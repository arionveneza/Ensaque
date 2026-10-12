import { describe, expect, it } from 'vitest'
import { contaSacos, fatorDoLote, loteEmSaco, pesoSementeDaOrdemKg } from './loteEmSaco'
import { ensaquePorBagKg } from './calculos'

describe('lote em saco tratado em kg (12/10/2026)', () => {
  it('reconhece o saco de 200 mil pelo fator (peso ÷ PMS) ou, sem PMS, pelo peso', () => {
    expect(fatorDoLote({ pms: 191, peso_bag_kg: 38.2 })).toBeCloseTo(0.2)
    expect(loteEmSaco({ pms: 191, peso_bag_kg: 38.2 })).toBe(true)
    expect(loteEmSaco({ pms: 158, peso_bag_kg: 790 })).toBe(false)
    expect(loteEmSaco({ pms: 200, peso_bag_kg: 500 })).toBe(false) // meio bag
    expect(loteEmSaco({ pms: null, peso_bag_kg: 38.8 })).toBe(true)
    expect(loteEmSaco({ pms: null, peso_bag_kg: 0 })).toBe(false)
  })

  it('DM1210: 35 sacos de 38,2 kg = 1.337 kg = 1,4 BAG de 955 kg → 1 cheio + 1 parcial', () => {
    const c = contaSacos(35, 38.2, 191 * 5)!
    expect(c.kg).toBe(1337)
    expect(c.bagsEquivalentes).toBeCloseTo(1.4)
    expect(c).toMatchObject({ cheias: 1, embalagens: 2, parcialKg: 382 })
  })

  it('75 sacos de 28,04 kg fecham 3 BAGs de 701 kg sem parcial fantasma', () => {
    expect(contaSacos(75, 28.04, 140.2 * 5)).toMatchObject({ kg: 2103, cheias: 3, embalagens: 3, parcialKg: 0 })
  })

  it('menos de um BAG: só a parcial', () => {
    expect(contaSacos(15, 38.8, 970)).toMatchObject({ kg: 582, cheias: 0, embalagens: 1, parcialKg: 582 })
  })

  it('entrada inválida não conta', () => {
    expect(contaSacos(0, 38.8, 970)).toBeNull()
    expect(contaSacos(10, 0, 970)).toBeNull()
  })

  it('peso da ordem: os kg a tratar mandam; sem eles, bags × peso do bag', () => {
    expect(pesoSementeDaOrdemKg(2, 955, 1337)).toBe(1337)
    expect(pesoSementeDaOrdemKg(2, 955, null)).toBe(1910)
  })

  it('ensaque de um bag CHEIO usa o químico por kg, não químico ÷ embalagens', () => {
    // 1.337 kg com 13,37 kg de químico (1%): o bag cheio de 955 kg leva 9,55 kg
    expect(ensaquePorBagKg(955, 13.37, 2, 1337)).toBeCloseTo(955 * 1.005 + 9.55)
    // ordem normal: igual a antes
    expect(ensaquePorBagKg(955, 19.1, 2)).toBeCloseTo(955 * 1.005 + 9.55)
  })
})
