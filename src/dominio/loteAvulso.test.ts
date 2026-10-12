import { describe, expect, it } from 'vitest'
import { validarLoteAvulso, type LoteAvulsoDigitado } from './loteAvulso'

const base: LoteAvulsoDigitado = {
  id: ' 26b65c0170 ', cultivar: 'neo751  ce', embalagem: 'BB5M', pms: '154', pesoBag: '', bags: '4',
}
const existentes = [
  { id: '26B65C0132', origem_manual: false },
  { id: '26B65C0162', origem_manual: true },
]
const conhecidos = ['NEO751 CE', 'NEO799 I2X']

describe('lote avulso (12/10/2026)', () => {
  it('normaliza nº e cultivar e calcula o peso do bag pelo PMS', () => {
    const r = validarLoteAvulso(base, existentes, conhecidos)
    expect(r.erros).toEqual([])
    expect(r.avisos).toEqual([])
    expect(r.lote).toEqual({
      id: '26B65C0170', cultivar: 'NEO751 CE', tratamento: 'SEM TSI', pms: 154, peso_bag_kg: 770, bags_disp: 4,
    })
  })

  it('número que já existe é recusado, dizendo se é do SAP ou avulso', () => {
    expect(validarLoteAvulso({ ...base, id: '26b65c0132' }, existentes, conhecidos).erros[0]).toMatch(/saldo do SAP/)
    expect(validarLoteAvulso({ ...base, id: '26B65C0162' }, existentes, conhecidos).erros[0]).toMatch(/avulso/)
  })

  it('sem PMS, o PMS sai do peso do bag (ordem meio-bag precisa dele)', () => {
    const r = validarLoteAvulso({ ...base, pms: '', pesoBag: '950' }, existentes, conhecidos)
    expect(r.lote).toMatchObject({ pms: 190, peso_bag_kg: 950 })
  })

  it('saco de 200 mil: peso com 2 casas, contado em sacos', () => {
    const r = validarLoteAvulso({ ...base, embalagem: 'SC200MS', pms: '140,2', bags: '75' }, existentes, conhecidos)
    expect(r.lote).toMatchObject({ pms: 140.2, peso_bag_kg: 28.04, bags_disp: 75 })
  })

  it('cultivar que o sistema não conhece só avisa', () => {
    const r = validarLoteAvulso({ ...base, cultivar: '751 CE' }, existentes, conhecidos)
    expect(r.erros).toEqual([])
    expect(r.avisos[0]).toMatch(/grafia/)
    expect(r.lote?.cultivar).toBe('751 CE')
  })

  it('peso do bag que não bate com o PMS avisa, mas o digitado vale', () => {
    const r = validarLoteAvulso({ ...base, pesoBag: '900' }, existentes, conhecidos)
    expect(r.avisos[0]).toMatch(/não bate/)
    expect(r.lote).toMatchObject({ pms: 154, peso_bag_kg: 900 })
  })

  it('campos obrigatórios e valores inválidos bloqueiam', () => {
    const r = validarLoteAvulso(
      { id: 'com espaco', cultivar: '', embalagem: '', pms: '', pesoBag: '', bags: '0' },
      existentes, conhecidos,
    )
    expect(r.lote).toBeNull()
    expect(r.erros).toHaveLength(5)
    expect(validarLoteAvulso({ ...base, pms: '1500' }, existentes, conhecidos).lote).toBeNull()
  })
})
