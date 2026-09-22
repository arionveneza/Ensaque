/**
 * Pesagem — checklist de carregamento com conferência de peso (14/09/2026).
 *
 * Substitui a planilha `Checklist_Carregamento_Pesagem.xlsx` com as MESMAS
 * regras, em duas etapas por veículo:
 *
 * 1. **Pré-conferência**, antes de carregar: tara + peso da ordem cabem no
 *    PBT (peso bruto total legal) do tipo de veículo? Sem tolerância — a
 *    tolerância legal é margem de balança, não de planejamento.
 * 2. **Conferência final**, depois da pesagem: líquido = bruto − tara;
 *    legislação (dentro do PBT, dentro da tolerância legal de 5%, ou
 *    excesso); comparação do líquido com a ordem (tolerância de 0,5%); e o
 *    parecer "Liberado?".
 *
 * Tudo em kg inteiros. A mesma fórmula existe no banco (`calc_pesagem`), e
 * a migração confere os 6 casos de aceite contra ela — mudou uma, mude a outra.
 */

export const TOL_LEGAL_PADRAO = 0.05
export const TOL_ORDEM_PADRAO = 0.005

/** Tolerância das comparações com ponto flutuante (74000 × 1,05; 175 ÷ 35000). */
const EPS = 1e-9

export type PodeCarregar = 'INCOMPLETO' | 'SIM' | 'NAO'
export type StatusLegislacao = 'AGUARDANDO' | 'OK' | 'ATENCAO' | 'EXCESSO'
export type StatusOrdem = 'AGUARDANDO' | 'OK' | 'DIVERGENTE_ACIMA' | 'DIVERGENTE_ABAIXO' | 'SEM_ORDEM'
export type Liberado = 'PENDENTE' | 'SIM' | 'NAO'

export type CorTag = 'neutro' | 'ok' | 'alerta' | 'perigo' | 'info' | 'roxo'

export const ROTULO_PODE_CARREGAR: Record<PodeCarregar, string> = {
  INCOMPLETO: 'Informar tara e peso da ordem',
  SIM: 'Ordem cabe no veículo',
  NAO: 'Excede o PBT',
}
export const COR_PODE_CARREGAR: Record<PodeCarregar, CorTag> = {
  INCOMPLETO: 'neutro',
  SIM: 'ok',
  NAO: 'perigo',
}

export const ROTULO_LEGISLACAO: Record<StatusLegislacao, string> = {
  AGUARDANDO: 'Aguardando pesagem final',
  OK: 'Dentro do limite',
  ATENCAO: 'Dentro da tolerância legal',
  EXCESSO: 'Acima do limite legal',
}
export const COR_LEGISLACAO: Record<StatusLegislacao, CorTag> = {
  AGUARDANDO: 'neutro',
  OK: 'ok',
  ATENCAO: 'alerta',
  EXCESSO: 'perigo',
}

export const ROTULO_ORDEM: Record<StatusOrdem, string> = {
  AGUARDANDO: 'Aguardando pesagem final',
  OK: 'Conforme ordem',
  DIVERGENTE_ACIMA: 'Acima da ordem',
  DIVERGENTE_ABAIXO: 'Abaixo da ordem',
  SEM_ORDEM: 'Sem peso da ordem informado',
}
export const COR_ORDEM: Record<StatusOrdem, CorTag> = {
  AGUARDANDO: 'neutro',
  OK: 'ok',
  DIVERGENTE_ACIMA: 'perigo',
  DIVERGENTE_ABAIXO: 'perigo',
  SEM_ORDEM: 'neutro',
}

export const ROTULO_LIBERADO: Record<Liberado, string> = {
  PENDENTE: 'Pendente',
  SIM: 'Liberado',
  NAO: 'Não liberado',
}
export const COR_LIBERADO: Record<Liberado, CorTag> = {
  PENDENTE: 'alerta',
  SIM: 'ok',
  NAO: 'perigo',
}

/** Placa em caixa alta, só letras e dígitos (ABC-1D23 → ABC1D23). */
export const normalizarPlaca = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '')

/** Placa antiga (ABC1234) ou Mercosul (ABC1D23): 7 caracteres alfanuméricos. */
export const placaValida = (s: string): boolean => /^[A-Z0-9]{7}$/.test(normalizarPlaca(s))

/**
 * Inteiro > 0 a partir do que o campo trouxer. Ponto só como separador de
 * milhar ("28.000"); "28000.5" NÃO vira 280005 — decimal, vazio, zero e
 * negativo → null.
 */
export const inteiroPositivo = (v: string | number | null | undefined): number | null => {
  if (v == null) return null
  const s = String(v).trim()
  if (!/^(\d{1,3}(\.\d{3})+|\d+)$/.test(s)) return null
  const n = Number(s.replace(/\./g, ''))
  return n > 0 ? n : null
}

const kg = (n: number): string => n.toLocaleString('pt-BR')

// ================================================================
// Etapa 1 — pré-conferência
// ================================================================

export interface EntradaPre {
  taraKg: number | null
  ordemKg: number | null
  pbtMaxKg: number | null
}

export interface PreConferencia {
  capacidadeLiquidaKg: number | null
  brutoPrevistoKg: number | null
  excessoPrevistoKg: number
  podeCarregar: PodeCarregar
  /** Frase pronta para a etiqueta ("Excede PBT em 1.800 kg, reduzir carga"). */
  mensagem: string
}

export function preConferencia(e: EntradaPre): PreConferencia {
  const { taraKg, ordemKg, pbtMaxKg } = e
  const temTara = taraKg != null && taraKg > 0
  if (!temTara || ordemKg == null || pbtMaxKg == null || ordemKg <= 0) {
    return {
      capacidadeLiquidaKg: pbtMaxKg != null && temTara ? pbtMaxKg - taraKg! : null,
      brutoPrevistoKg: null,
      excessoPrevistoKg: 0,
      podeCarregar: 'INCOMPLETO',
      // peso da ordem é opcional pra salvar (21/09/2026) — sem ele não dá pra
      // saber se cabe no veículo, mas a mensagem não deve pedir a tara de
      // novo quando ela já foi informada
      mensagem: temTara ? 'Informar peso da ordem para conferir se cabe no veículo' : ROTULO_PODE_CARREGAR.INCOMPLETO,
    }
  }
  const brutoPrevistoKg = taraKg + ordemKg
  const excessoPrevistoKg = Math.max(0, brutoPrevistoKg - pbtMaxKg)
  const podeCarregar: PodeCarregar = brutoPrevistoKg <= pbtMaxKg ? 'SIM' : 'NAO'
  return {
    capacidadeLiquidaKg: pbtMaxKg - taraKg,
    brutoPrevistoKg,
    excessoPrevistoKg,
    podeCarregar,
    mensagem:
      podeCarregar === 'SIM'
        ? ROTULO_PODE_CARREGAR.SIM
        : `Excede PBT em ${kg(excessoPrevistoKg)} kg, reduzir carga`,
  }
}

// ================================================================
// Etapa 2 — conferência final
// ================================================================

export interface EntradaFinal extends EntradaPre {
  brutoKg: number | null
  tolLegalPct: number
  tolOrdemPct: number
}

export interface ConferenciaFinal {
  liquidoKg: number | null
  pbtComToleranciaKg: number | null
  excessoRealKg: number
  diferencaKg: number | null
  /** Fração (0,0543 = +5,43 %). */
  diferencaPct: number | null
  statusLegislacao: StatusLegislacao
  statusOrdem: StatusOrdem
  liberado: Liberado
  /** Bruto informado mas inválido (≤ tara): a tela trava o botão. */
  erroBruto: string | null
}

const AGUARDANDO: ConferenciaFinal = {
  liquidoKg: null,
  pbtComToleranciaKg: null,
  excessoRealKg: 0,
  diferencaKg: null,
  diferencaPct: null,
  statusLegislacao: 'AGUARDANDO',
  statusOrdem: 'AGUARDANDO',
  liberado: 'PENDENTE',
  erroBruto: null,
}

export function conferenciaFinal(e: EntradaFinal): ConferenciaFinal {
  const { taraKg, ordemKg, pbtMaxKg, brutoKg, tolLegalPct, tolOrdemPct } = e
  const pbtComToleranciaKg = pbtMaxKg != null ? pbtMaxKg * (1 + tolLegalPct) : null
  // peso da ordem é opcional pra salvar (21/09/2026, pedido do Arion) — só
  // tara/PBT/bruto ainda travam em "aguardando pesagem". Sem ordem, a
  // legislação segue sendo apurada normalmente; só a comparação × ordem
  // fica de fora (`SEM_ORDEM`, abaixo), e o Liberado passa a valer só pela
  // legislação — decisão dele: o caminhão não fica refém de um dado que
  // ninguém preencheu.
  if (brutoKg == null || taraKg == null || pbtMaxKg == null) {
    return { ...AGUARDANDO, pbtComToleranciaKg }
  }
  if (brutoKg <= taraKg) {
    return {
      ...AGUARDANDO,
      pbtComToleranciaKg,
      erroBruto: `Peso bruto final (${kg(brutoKg)} kg) precisa ser maior que a tara (${kg(taraKg)} kg)`,
    }
  }
  const liquidoKg = brutoKg - taraKg
  const excessoRealKg = Math.max(0, brutoKg - pbtMaxKg)
  const temOrdem = ordemKg != null && ordemKg > 0
  const diferencaKg = temOrdem ? liquidoKg - ordemKg! : null
  const diferencaPct = temOrdem ? diferencaKg! / ordemKg! : null

  const statusLegislacao: StatusLegislacao =
    brutoKg <= pbtMaxKg ? 'OK' : brutoKg <= pbtComToleranciaKg! + EPS ? 'ATENCAO' : 'EXCESSO'
  const statusOrdem: StatusOrdem = !temOrdem
    ? 'SEM_ORDEM'
    : Math.abs(diferencaKg!) <= ordemKg! * tolOrdemPct + EPS
      ? 'OK'
      : diferencaKg! > 0
        ? 'DIVERGENTE_ACIMA'
        : 'DIVERGENTE_ABAIXO'
  const liberado: Liberado =
    (statusLegislacao === 'OK' || statusLegislacao === 'ATENCAO') &&
    (statusOrdem === 'OK' || statusOrdem === 'SEM_ORDEM')
      ? 'SIM'
      : 'NAO'

  return {
    liquidoKg,
    pbtComToleranciaKg,
    excessoRealKg,
    diferencaKg,
    diferencaPct,
    statusLegislacao,
    statusOrdem,
    liberado,
    erroBruto: null,
  }
}

// ================================================================
// Uma linha do banco, avaliada inteira
// ================================================================

/** O que a tabela `pesagens` guarda e o cálculo precisa. */
export interface PesagemBase {
  peso_tara_kg: number
  /** Opcional desde 21/09/2026 — nem sempre o peso da ordem está à mão na balança. */
  peso_ordem_kg: number | null
  pbt_max_kg_aplicado: number
  peso_bruto_final_kg: number | null
  /** Congeladas quando o bruto entrou; nulas enquanto pendente. */
  tol_legal_pct_aplicada: number | null
  tol_ordem_pct_aplicada: number | null
}

export interface ParametrosPesagem {
  tolLegalPct: number
  tolOrdemPct: number
}

export type PesagemAvaliada = PreConferencia & ConferenciaFinal & { pbtMaxKg: number }

/**
 * Etapa 1 + Etapa 2 de uma linha gravada. Pesagem já feita usa as tolerâncias
 * CONGELADAS nela (mudar o parâmetro depois não muda o histórico); a pendente
 * mostra a prévia com as atuais.
 */
export function avaliarPesagem(p: PesagemBase, atuais: ParametrosPesagem): PesagemAvaliada {
  const pre = preConferencia({
    taraKg: p.peso_tara_kg,
    ordemKg: p.peso_ordem_kg,
    pbtMaxKg: p.pbt_max_kg_aplicado,
  })
  const fin = conferenciaFinal({
    taraKg: p.peso_tara_kg,
    ordemKg: p.peso_ordem_kg,
    pbtMaxKg: p.pbt_max_kg_aplicado,
    brutoKg: p.peso_bruto_final_kg,
    tolLegalPct: p.tol_legal_pct_aplicada ?? atuais.tolLegalPct,
    tolOrdemPct: p.tol_ordem_pct_aplicada ?? atuais.tolOrdemPct,
  })
  return { ...pre, ...fin, pbtMaxKg: p.pbt_max_kg_aplicado }
}

export interface ResumoPesagens {
  registrados: number
  preSim: number
  preNao: number
  pesados: number
  legislacaoOk: number
  legislacaoAtencao: number
  legislacaoExcesso: number
  ordemOk: number
  ordemDivergente: number
  /** Pesado sem peso da ordem informado — não é divergência, é dado ausente. */
  ordemSemInfo: number
  liberadoSim: number
  liberadoNao: number
  liberadoPendente: number
  /** Σ peso líquido das pesagens concluídas. */
  liquidoKg: number
  /** Σ peso das ordens já pesadas. */
  ordemPesadaKg: number
}

/** Contadores do painel (§4.5 da especificação) para o período filtrado. */
export function resumoPesagens(
  linhas: { base: PesagemBase; avaliada: PesagemAvaliada }[],
): ResumoPesagens {
  const r: ResumoPesagens = {
    registrados: linhas.length,
    preSim: 0,
    preNao: 0,
    pesados: 0,
    legislacaoOk: 0,
    legislacaoAtencao: 0,
    legislacaoExcesso: 0,
    ordemOk: 0,
    ordemDivergente: 0,
    ordemSemInfo: 0,
    liberadoSim: 0,
    liberadoNao: 0,
    liberadoPendente: 0,
    liquidoKg: 0,
    ordemPesadaKg: 0,
  }
  for (const { base, avaliada: a } of linhas) {
    if (a.podeCarregar === 'SIM') r.preSim++
    if (a.podeCarregar === 'NAO') r.preNao++
    if (a.liberado === 'PENDENTE') r.liberadoPendente++
    if (a.liberado === 'SIM') r.liberadoSim++
    if (a.liberado === 'NAO') r.liberadoNao++
    if (a.liquidoKg != null) {
      r.pesados++
      r.liquidoKg += a.liquidoKg
      r.ordemPesadaKg += base.peso_ordem_kg ?? 0
      if (a.statusLegislacao === 'OK') r.legislacaoOk++
      if (a.statusLegislacao === 'ATENCAO') r.legislacaoAtencao++
      if (a.statusLegislacao === 'EXCESSO') r.legislacaoExcesso++
      if (a.statusOrdem === 'OK') r.ordemOk++
      else if (a.statusOrdem === 'SEM_ORDEM') r.ordemSemInfo++
      else r.ordemDivergente++
    }
  }
  return r
}

/** Fração → "+5,43%" / "−0,29%" / "—" (2 casas, sinal explícito, menos tipográfico). */
export const formatarPct = (x: number | null | undefined): string => {
  if (x == null || !Number.isFinite(x)) return '—'
  const v = x * 100
  const abs = Math.abs(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  // zero arredondado não ganha sinal
  if (Number(Math.abs(v).toFixed(2)) === 0) return `${abs}%`
  return `${v > 0 ? '+' : '−'}${abs}%`
}

/** Inteiro em kg com sinal ("+2.500", "−100", "0"). */
export const formatarDifKg = (x: number | null | undefined): string => {
  if (x == null) return '—'
  if (x === 0) return '0'
  return `${x > 0 ? '+' : '−'}${kg(Math.abs(x))}`
}
