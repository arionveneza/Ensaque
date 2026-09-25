import { describe, expect, it } from 'vitest'
import { imprimirFichaQuimicos } from './exportar'
import { AJUSTE_FICHA_ZERO, LAYOUTS_FICHA, type FichaQuimicos } from '@/dominio/fichaQuimicos'

/** Janela falsa: guarda o HTML que a ficha escreveria pra imprimir. */
function janelaFalsa() {
  let html = ''
  const janela = {
    document: { open: () => {}, write: (h: string) => { html += h }, close: () => {}, images: [] },
    focus: () => {},
    print: () => {},
  } as unknown as Window
  return { janela, html: () => html }
}

const FICHA: FichaQuimicos = {
  receita: 'FTZ60 + VIC',
  biologicos: 'SIM',
  secoes: {
    inseticida: [{ produto: 'Fortenza', principio: 'Ciantraniliprole', concentracao: '600 g/L', dosagem: '100 mL/100 kg' }],
    fungicida: [],
    nematicida: [
      { produto: 'Nem A', principio: 'Abamectina', concentracao: '500 g/L', dosagem: '50 mL/100 kg' },
      { produto: 'Nem B', principio: 'Fluopiram', concentracao: '600 g/L', dosagem: '30 mL/100 kg' },
    ],
    inoculante: [],
  },
  outros: [{ produto: 'Grafite', informacoes: '', dosagem: '100 g/100 kg' }],
  naoCouberam: [],
  semPrincipio: [],
}

describe('impressão da ficha de químicos nos dois papéis', () => {
  it('papel novo: folha deitada, sem receita, 2ª linha de nematicida impressa', () => {
    const { janela, html } = janelaFalsa()
    imprimirFichaQuimicos(FICHA, { modelo: 'paisagem', ajuste: AJUSTE_FICHA_ZERO }, janela)
    const h = html()
    expect(h).toContain('@page { size: 320mm 212mm; margin: 0; }')
    expect(h).toContain('>Nem B<')
    expect(h).toContain('>SIM<')
    // o papel novo não tem campo de receita: o nome não sai em célula nenhuma
    expect(h).not.toContain('>FTZ60 + VIC<')
    // 2ª linha de nematicida no top certo: 93 + 6,9
    const L = LAYOUTS_FICHA.paisagem
    expect(h).toContain(`left:${L.colunas[0].left}mm;top:${Math.round((L.top.nematicida + L.altura.nematicida) * 100) / 100}mm`)
  })

  it('papel antigo: folha em pé, com receita, só 1 linha de nematicida', () => {
    const { janela, html } = janelaFalsa()
    imprimirFichaQuimicos(FICHA, { modelo: 'retrato' }, janela)
    const h = html()
    expect(h).toContain('@page { size: 212mm 320mm; margin: 0; }')
    expect(h).toContain('>FTZ60 + VIC<')
    expect(h).toContain('>Nem A<')
    expect(h).not.toContain('>Nem B<')
  })

  it('teste de alinhamento no papel novo desenha as guias e a nota dentro da folha', () => {
    const { janela, html } = janelaFalsa()
    imprimirFichaQuimicos(FICHA, { modelo: 'paisagem', teste: true }, janela)
    const h = html()
    expect(h).toContain('OUTROS 3 · DOSAGEM')
    expect(h).toContain('NEMATICIDA 2 · PRODUTO')
    expect(h).not.toContain('>RECEITA<')
    expect(h).toContain('TESTE DE ALINHAMENTO')
  })

  it('texto longo em linha baixa (OUTROS, 5,5 mm) quebra com fonte que cabe em 2 linhas', () => {
    const longa: FichaQuimicos = {
      ...FICHA,
      outros: [{ produto: 'Produto com nome comprido demais', informacoes: '', dosagem: '1 g/100 kg' }],
    }
    const { janela, html } = janelaFalsa()
    imprimirFichaQuimicos(longa, { modelo: 'paisagem' }, janela)
    const m = html().match(/class="c quebra"[^>]*font-size:([\d.]+)pt[^>]*>Produto com nome comprido demais</)
    expect(m).not.toBeNull()
    // 2 linhas × 1,15 de entrelinha cabem nos 5,5 mm
    expect((Number(m![1]) / 2.835) * 1.15 * 2).toBeLessThanOrEqual(5.5)
  })
})
