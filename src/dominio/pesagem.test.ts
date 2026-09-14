import { describe, expect, it } from 'vitest'
import {
  avaliarPesagem,
  conferenciaFinal,
  formatarDifKg,
  formatarPct,
  inteiroPositivo,
  normalizarPlaca,
  placaValida,
  preConferencia,
  resumoPesagens,
  TOL_LEGAL_PADRAO,
  TOL_ORDEM_PADRAO,
  type PesagemBase,
} from './pesagem'

const TOL = { tolLegalPct: TOL_LEGAL_PADRAO, tolOrdemPct: TOL_ORDEM_PADRAO }

const caso = (taraKg: number, ordemKg: number, pbtMaxKg: number, brutoKg: number | null) => ({
  pre: preConferencia({ taraKg, ordemKg, pbtMaxKg }),
  fin: conferenciaFinal({ taraKg, ordemKg, pbtMaxKg, brutoKg, ...TOL }),
})

describe('placa e numeros', () => {
  it('normaliza a placa: caixa alta, sem espaco nem hifen', () => {
    expect(normalizarPlaca(' abc-1d23 ')).toBe('ABC1D23')
    expect(normalizarPlaca('ABC 1234')).toBe('ABC1234')
  })

  it('placa valida tem 7 caracteres alfanumericos', () => {
    expect(placaValida('abc-1d23')).toBe(true)
    expect(placaValida('ABC123')).toBe(false)
    expect(placaValida('')).toBe(false)
  })

  it('inteiro positivo: aceita texto com ponto de milhar, recusa vazio, zero, negativo e decimal', () => {
    expect(inteiroPositivo('21.400')).toBe(21400)
    expect(inteiroPositivo(35000)).toBe(35000)
    expect(inteiroPositivo('')).toBeNull()
    expect(inteiroPositivo('0')).toBeNull()
    expect(inteiroPositivo('-5')).toBeNull()
    expect(inteiroPositivo('12,5')).toBeNull()
    // ponto só é milhar quando o formato bate: decimal com ponto não vira 10× maior
    expect(inteiroPositivo('28000.5')).toBeNull()
    expect(inteiroPositivo('1.234.567')).toBe(1234567)
    expect(inteiroPositivo(null)).toBeNull()
  })
})

describe('casos de aceite da especificacao (tolerancias 5% e 0,5%)', () => {
  it('1 · Bitrem 21.400 / 35.000 / 56.300 → SIM; liquido 34.900, OK, −100 (−0,29%) OK, liberado SIM', () => {
    const { pre, fin } = caso(21400, 35000, 57000, 56300)
    expect(pre.brutoPrevistoKg).toBe(56400)
    expect(pre.podeCarregar).toBe('SIM')
    expect(fin.liquidoKg).toBe(34900)
    expect(fin.statusLegislacao).toBe('OK')
    expect(fin.diferencaKg).toBe(-100)
    expect(formatarPct(fin.diferencaPct)).toBe('−0,29%')
    expect(fin.statusOrdem).toBe('OK')
    expect(fin.liberado).toBe('SIM')
  })

  it('2 · Truck 9.800 / 15.000 sem bruto → previsto 24.800, excesso 1.800, NAO; PENDENTE', () => {
    const { pre, fin } = caso(9800, 15000, 23000, null)
    expect(pre.brutoPrevistoKg).toBe(24800)
    expect(pre.excessoPrevistoKg).toBe(1800)
    expect(pre.podeCarregar).toBe('NAO')
    expect(pre.mensagem).toBe('Excede PBT em 1.800 kg, reduzir carga')
    expect(fin.statusLegislacao).toBe('AGUARDANDO')
    expect(fin.statusOrdem).toBe('AGUARDANDO')
    expect(fin.liberado).toBe('PENDENTE')
  })

  it('3 · Rodotrem 28.000 / 46.000 / 76.500 → previsto 74.000 SIM (igual cabe); ATENCAO; +2.500 (+5,43%) ACIMA; NAO', () => {
    const { pre, fin } = caso(28000, 46000, 74000, 76500)
    expect(pre.brutoPrevistoKg).toBe(74000)
    expect(pre.podeCarregar).toBe('SIM')
    expect(fin.pbtComToleranciaKg).toBeCloseTo(77700, 6)
    expect(fin.statusLegislacao).toBe('ATENCAO')
    expect(fin.liquidoKg).toBe(48500)
    expect(fin.diferencaKg).toBe(2500)
    expect(formatarPct(fin.diferencaPct)).toBe('+5,43%')
    expect(fin.statusOrdem).toBe('DIVERGENTE_ACIMA')
    expect(fin.liberado).toBe('NAO')
  })

  it('4 · LS Simples 15.000 / 26.000 / 44.000 → 44.000 > 43.575 EXCESSO; NAO', () => {
    const { fin } = caso(15000, 26000, 41500, 44000)
    expect(fin.pbtComToleranciaKg).toBeCloseTo(43575, 6)
    expect(fin.statusLegislacao).toBe('EXCESSO')
    expect(fin.excessoRealKg).toBe(2500)
    expect(fin.liberado).toBe('NAO')
  })

  it('5 · Bitruck 11.000 / 17.500 / 28.450 → liquido 17.450, −50 (−0,29%) OK; OK; SIM', () => {
    const { fin } = caso(11000, 17500, 29000, 28450)
    expect(fin.liquidoKg).toBe(17450)
    expect(fin.diferencaKg).toBe(-50)
    expect(formatarPct(fin.diferencaPct)).toBe('−0,29%')
    expect(fin.statusOrdem).toBe('OK')
    expect(fin.statusLegislacao).toBe('OK')
    expect(fin.liberado).toBe('SIM')
  })

  it('6 · Truck 9.800 / 13.000 / 22.900 → SIM (22.800); liquido 13.100, +100 (+0,77%) ACIMA; NAO', () => {
    const { pre, fin } = caso(9800, 13000, 23000, 22900)
    expect(pre.brutoPrevistoKg).toBe(22800)
    expect(pre.podeCarregar).toBe('SIM')
    expect(fin.liquidoKg).toBe(13100)
    expect(fin.diferencaKg).toBe(100)
    expect(formatarPct(fin.diferencaPct)).toBe('+0,77%')
    expect(fin.statusOrdem).toBe('DIVERGENTE_ACIMA')
    expect(fin.statusLegislacao).toBe('OK')
    expect(fin.liberado).toBe('NAO')
  })
})

describe('fronteiras', () => {
  it('bruto igual ao PBT e OK; igual ao PBT com tolerancia e ATENCAO; 1 kg acima e EXCESSO', () => {
    expect(caso(20000, 30000, 57000, 57000).fin.statusLegislacao).toBe('OK')
    // 74000 × 1,05 = 77700 — sem o EPS o ponto flutuante poderia dar EXCESSO
    expect(caso(28000, 40000, 74000, 77700).fin.statusLegislacao).toBe('ATENCAO')
    expect(caso(28000, 40000, 74000, 77701).fin.statusLegislacao).toBe('EXCESSO')
  })

  it('diferenca exatamente na tolerancia da ordem e OK (175 de 35.000)', () => {
    expect(caso(20000, 35000, 57000, 55175).fin.statusOrdem).toBe('OK')
    expect(caso(20000, 35000, 57000, 55176).fin.statusOrdem).toBe('DIVERGENTE_ACIMA')
    expect(caso(20000, 35000, 57000, 54825).fin.statusOrdem).toBe('OK')
    expect(caso(20000, 35000, 57000, 54824).fin.statusOrdem).toBe('DIVERGENTE_ABAIXO')
  })

  it('ATENCAO libera quando a ordem confere', () => {
    // bruto 57500 (≤ 59850), liquido 37500 = ordem
    expect(caso(20000, 37500, 57000, 57500).fin.liberado).toBe('SIM')
  })

  it('sem tara ou sem ordem e INCOMPLETO, sem dividir por zero', () => {
    expect(preConferencia({ taraKg: null, ordemKg: 100, pbtMaxKg: 23000 }).podeCarregar).toBe('INCOMPLETO')
    expect(preConferencia({ taraKg: 9800, ordemKg: 0, pbtMaxKg: 23000 }).podeCarregar).toBe('INCOMPLETO')
    const fin = conferenciaFinal({ taraKg: 9800, ordemKg: 0, pbtMaxKg: 23000, brutoKg: 20000, ...TOL })
    expect(fin.liberado).toBe('PENDENTE')
    expect(fin.diferencaPct).toBeNull()
  })

  it('bruto menor ou igual a tara e invalido, nao "pendente de verdade"', () => {
    const fin = caso(9800, 13000, 23000, 9800).fin
    expect(fin.erroBruto).toMatch(/maior que a tara/)
    expect(fin.liberado).toBe('PENDENTE')
  })
})

describe('linha do banco', () => {
  const base = (over: Partial<PesagemBase> = {}): PesagemBase => ({
    peso_tara_kg: 28000,
    peso_ordem_kg: 46000,
    pbt_max_kg_aplicado: 74000,
    peso_bruto_final_kg: 76500,
    tol_legal_pct_aplicada: null,
    tol_ordem_pct_aplicada: null,
    ...over,
  })

  it('usa a tolerancia congelada na linha, nao a atual', () => {
    // congelada em 3%: 76500 > 76220 → EXCESSO, mesmo com o parametro atual em 5%
    const a = avaliarPesagem(base({ tol_legal_pct_aplicada: 0.03 }), TOL)
    expect(a.statusLegislacao).toBe('EXCESSO')
    // pendente/sem congelar: cai na atual
    expect(avaliarPesagem(base(), TOL).statusLegislacao).toBe('ATENCAO')
  })

  it('resumo conta cada eixo do painel', () => {
    const linhas = [
      base(), // ATENCAO, ACIMA, NAO
      base({ peso_bruto_final_kg: 74000 }), // OK, liquido 46000 = ordem, SIM
      base({ peso_bruto_final_kg: null }), // pendente
      base({ peso_tara_kg: 30000, peso_bruto_final_kg: null }), // 76.000 > 74.000: pre NAO, pendente
    ].map((b) => ({ base: b, avaliada: avaliarPesagem(b, TOL) }))
    const r = resumoPesagens(linhas)
    expect(r.registrados).toBe(4)
    expect(r.preSim).toBe(3)
    expect(r.preNao).toBe(1)
    expect(r.pesados).toBe(2)
    expect(r.legislacaoAtencao).toBe(1)
    expect(r.legislacaoOk).toBe(1)
    expect(r.ordemOk).toBe(1)
    expect(r.ordemDivergente).toBe(1)
    expect(r.liberadoSim).toBe(1)
    expect(r.liberadoNao).toBe(1)
    expect(r.liberadoPendente).toBe(2)
    expect(r.liquidoKg).toBe(48500 + 46000)
    expect(r.ordemPesadaKg).toBe(46000 * 2)
  })
})

describe('formatacao', () => {
  it('percentual com 2 casas e sinal; zero sem sinal; nulo e traco', () => {
    expect(formatarPct(0.0543)).toBe('+5,43%')
    expect(formatarPct(-0.00286)).toBe('−0,29%')
    expect(formatarPct(0)).toBe('0,00%')
    expect(formatarPct(null)).toBe('—')
  })

  it('diferenca em kg com sinal', () => {
    expect(formatarDifKg(2500)).toBe('+2.500')
    expect(formatarDifKg(-100)).toBe('−100')
    expect(formatarDifKg(0)).toBe('0')
    expect(formatarDifKg(null)).toBe('—')
  })
})
