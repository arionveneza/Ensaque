import { supabase } from '@/lib/supabase'
import type { TipoParada, UnidadeDose } from '@/dominio/tipos'
import type { PedidoConvertido, EstoquePaConvertido, LoteConvertido } from '@/dominio/importacao/simpleagro'

/** Consultas e comandos das telas de Programação, Lotes, Ordens, Qualidade, Indicadores e Cadastros. */

function erro(contexto: string, e: { message: string } | null) {
  if (e) throw new Error(`${contexto}: ${e.message}`)
}

// ================================================================
// Visão de ordens (view v_ordens, com status derivado e pesos)
// ================================================================

export interface OrdemVisao {
  id: string
  numero: string
  cultivar: string
  receita_id: string
  receita_nome: string
  embalagem: string
  bags: number
  lote_id: string
  cliente: string | null
  observacao: string | null
  /** Endereço de onde buscar o lote para esta ordem. */
  armazem: string | null
  bloco: string | null
  quadra: string | null
  prioridade: 'Normal' | 'Urgente'
  maquina_id: string | null
  data_prog: string | null
  seq: number | null
  turno_id: number | null
  status: string
  status_efetivo: string
  peso_kg: number
  peso_t: number
  peso_bag_kg: number
  agrotis_num: string | null
}

export async function listarOrdens(de?: string, ate?: string): Promise<OrdemVisao[]> {
  let q = supabase.from('v_ordens').select('*')
  if (de) q = q.gte('data_prog', de)
  if (ate) q = q.lte('data_prog', ate)
  const { data, error } = await q.order('data_prog').order('maquina_id').order('seq')
  erro('ordens', error)
  return (data ?? []) as OrdemVisao[]
}

/** Ordens sem máquina (pool) — não têm data_prog, então ficam fora do filtro por período. */
export async function listarPool(): Promise<OrdemVisao[]> {
  const { data, error } = await supabase
    .from('v_ordens')
    .select('*')
    .is('maquina_id', null)
    .order('numero')
  erro('pool de ordens', error)
  return (data ?? []) as OrdemVisao[]
}

export interface NovaOrdem {
  numero: string
  cultivar: string
  receita_id: string
  embalagem: string
  bags: number
  lote_id: string
  cliente?: string | null
  observacao?: string | null
  /** Endereço de onde buscar o lote: armazém, bloco e quadra. */
  armazem?: string | null
  bloco?: string | null
  quadra?: string | null
  prioridade?: 'Normal' | 'Urgente'
  maquina_id?: string | null
  data_prog?: string | null
  seq?: number | null
}

export async function criarOrdem(o: NovaOrdem): Promise<void> {
  const { error } = await supabase.from('ordens').insert({ ...o, origem: 'digitacao' })
  if (error) {
    // 23505 = violação de unicidade da chave anti-duplicidade
    if (error.code === '23505') {
      throw new Error(
        `Já existe ordem com ${o.numero} + ${o.cultivar} + esta receita + ${o.embalagem}.`,
      )
    }
    throw new Error(`criar ordem: ${error.message}`)
  }
}

export interface ResultadoLote {
  criadas: number
  jaExistiam: { numero: string; motivo: string }[]
}

/**
 * Cria ordens vindas de planilha. Insere uma a uma de propósito: em lote,
 * uma única duplicata derrubaria o insert inteiro e o operador não saberia
 * qual linha causou o problema.
 */
export async function criarOrdensEmLote(lista: NovaOrdem[]): Promise<ResultadoLote> {
  let criadas = 0
  const jaExistiam: { numero: string; motivo: string }[] = []
  for (const o of lista) {
    const { error } = await supabase.from('ordens').insert({ ...o, origem: 'importacao' })
    if (!error) {
      criadas++
      continue
    }
    jaExistiam.push({
      numero: o.numero,
      motivo:
        error.code === '23505'
          ? 'já existe ordem com este número, cultivar, tratamento e embalagem'
          : error.message,
    })
  }
  return { criadas, jaExistiam }
}

export async function atualizarOrdem(id: string, campos: Partial<NovaOrdem>): Promise<void> {
  const { error } = await supabase.from('ordens').update(campos).eq('id', id)
  erro('atualizar ordem', error)
}

export async function excluirOrdem(id: string): Promise<void> {
  const { error } = await supabase.from('ordens').delete().eq('id', id)
  erro('excluir ordem', error)
}

export async function definirPrioridade(
  id: string,
  prioridade: 'Normal' | 'Urgente',
  usuarioId: string,
): Promise<void> {
  const { error } = await supabase
    .from('ordens')
    .update({
      prioridade,
      prioridade_por: usuarioId,
      prioridade_em: new Date().toISOString(),
    })
    .eq('id', id)
  erro('definir prioridade', error)
}

/** Move/reordena uma ordem no quadro. */
export async function reprogramar(
  id: string,
  maquinaId: string | null,
  dia: string | null,
  seq: number | null,
): Promise<void> {
  const { error } = await supabase
    .from('ordens')
    .update({ maquina_id: maquinaId, data_prog: dia, seq })
    .eq('id', id)
  erro('reprogramar ordem', error)
}

export async function aplicarAtribuicoes(
  lista: { ordemId: string; maquinaId: string; dia: string; seq: number }[],
): Promise<void> {
  for (const a of lista) {
    await reprogramar(a.ordemId, a.maquinaId, a.dia, a.seq)
  }
}

// ================================================================
// Lotes de semente
// ================================================================

export interface LoteSementeLinha {
  id: string
  cultivar: string
  /** Como veio da origem. 'SEM TSI' = semente crua, ainda a tratar. */
  tratamento: string | null
  pms: number | null
  peso_bag_kg: number
  bags_disp: number | null
  status: 'Em estoque' | 'Baixado'
  devolver: boolean
}

export async function listarLotes(): Promise<LoteSementeLinha[]> {
  const { data, error } = await supabase
    .from('lotes_semente')
    .select('id, cultivar, tratamento, pms, peso_bag_kg, bags_disp, status, devolver')
    .order('id')
  erro('lotes de semente', error)
  return (data ?? []) as LoteSementeLinha[]
}

export async function baixarLote(
  loteId: string,
  bags: number,
  pesoT: number,
  usuarioId: string,
): Promise<void> {
  const up = await supabase
    .from('lotes_semente')
    .update({ status: 'Baixado', baixado_por: usuarioId, baixado_em: new Date().toISOString() })
    .eq('id', loteId)
  erro('baixar lote', up.error)

  const mov = await supabase
    .from('lote_movimentos')
    .insert({ lote_id: loteId, bags, peso_t: pesoT, estorno: false, usuario_id: usuarioId })
  erro('registrar baixa', mov.error)
}

/**
 * Estorno. O trigger do banco recusa se qualquer ordem do lote já foi
 * iniciada — a mensagem que volta é a do próprio banco.
 */
export async function estornarLote(
  loteId: string,
  bags: number,
  usuarioId: string,
): Promise<void> {
  const up = await supabase
    .from('lotes_semente')
    .update({ status: 'Em estoque', baixado_por: null, baixado_em: null, devolver: false })
    .eq('id', loteId)
  erro('estornar lote', up.error)

  const mov = await supabase
    .from('lote_movimentos')
    .insert({ lote_id: loteId, bags: -bags, estorno: true, usuario_id: usuarioId })
  erro('registrar estorno', mov.error)
}

export interface MovimentoLote {
  id: string
  lote_id: string
  bags: number
  peso_t: number | null
  estorno: boolean
  ts: string
}

export async function listarMovimentos(desde: string): Promise<MovimentoLote[]> {
  const { data, error } = await supabase
    .from('lote_movimentos')
    .select('id, lote_id, bags, peso_t, estorno, ts')
    .gte('ts', desde)
    .order('ts', { ascending: false })
  erro('movimentos de lote', error)
  return (data ?? []) as MovimentoLote[]
}

// ================================================================
// Demanda: pedidos e estoque de produto acabado
// ================================================================

export interface BalancoLinha {
  cultivar: string
  tratamento: string
  embalagem: string
  pedido_aprovado: number
  pedido_pendente: number
  estoque_pa: number
  ordens_abertas: number
  saldo: number
  receita_cadastrada: boolean
}

export async function listarBalanco(): Promise<BalancoLinha[]> {
  const { data, error } = await supabase
    .from('v_balanco_demanda')
    .select('*')
    .order('cultivar')
  erro('balanço de demanda', error)
  return (data ?? []) as BalancoLinha[]
}

/** Carga é substituição total: cada upload cria uma carga nova que passa a valer. */
export async function importarPedidos(
  linhas: PedidoConvertido[],
  usuarioId: string,
): Promise<number> {
  const carga = await supabase
    .from('cargas_demanda')
    .insert({ tipo: 'pedidos', origem: 'upload', criada_por: usuarioId })
    .select('id')
    .single()
  erro('criar carga de pedidos', carga.error)

  const cargaId = (carga.data as { id: string }).id
  const registros = linhas.map((l) => ({
    carga_id: cargaId,
    cultivar: l.cultivar,
    tratamento: l.tratamento,
    embalagem: l.embalagem,
    bags: l.bags,
    aprovado: l.aprovado,
  }))
  for (let i = 0; i < registros.length; i += 500) {
    const { error } = await supabase.from('pedidos_venda').insert(registros.slice(i, i + 500))
    erro('inserir pedidos', error)
  }
  return registros.length
}

export async function importarEstoquePa(
  linhas: EstoquePaConvertido[],
  usuarioId: string,
): Promise<number> {
  const carga = await supabase
    .from('cargas_demanda')
    .insert({ tipo: 'estoque', origem: 'upload', criada_por: usuarioId })
    .select('id')
    .single()
  erro('criar carga de estoque', carga.error)

  const cargaId = (carga.data as { id: string }).id
  const registros = linhas.map((l) => ({
    carga_id: cargaId,
    cultivar: l.cultivar,
    tratamento: l.tratamento,
    embalagem: l.embalagem,
    bags: l.bags,
  }))
  for (let i = 0; i < registros.length; i += 500) {
    const { error } = await supabase.from('estoque_pa').insert(registros.slice(i, i + 500))
    erro('inserir estoque', error)
  }
  return registros.length
}

/** Lotes vindos do relatório de Saldos. Mantém o status de quem já existe. */
export async function importarLotes(linhas: LoteConvertido[]): Promise<number> {
  const registros = linhas.map((l) => ({
    id: l.id,
    cultivar: l.cultivar,
    tratamento: l.tratamento || null,
    pms: l.pms || null,
    peso_bag_kg: l.pesoBagKg,
    bags_disp: l.bags,
    atualizado_em: new Date().toISOString(),
  }))
  for (let i = 0; i < registros.length; i += 500) {
    const { error } = await supabase
      .from('lotes_semente')
      .upsert(registros.slice(i, i + 500), { onConflict: 'id' })
    erro('importar lotes', error)
  }
  return registros.length
}

// ================================================================
// Qualidade em 2 etapas, conferência de estoque e encerramento
// ================================================================

/** Um item do checklist — informativo, nunca bloqueia. */
export interface ChecklistQualidade {
  id: string
  ordem_id: string
  etapa: 'processo' | 'final'
  /** De onde saiu a amostra em processo: bowl da máquina ou bag ensacado. */
  origem: 'BOWL' | 'BAG' | null
  recobrimento: number
  umidade_ok: boolean
  po_ok: boolean
  observacao: string | null
  ts: string
}

export interface DadosChecklist {
  /** Obrigatória na etapa em processo; a final não usa. */
  origem?: 'BOWL' | 'BAG'
  recobrimento: number
  umidadeOk: boolean
  poOk: boolean
  observacao: string | null
}

export async function listarChecksQualidade(): Promise<ChecklistQualidade[]> {
  const { data, error } = await supabase
    .from('qualidade_checks')
    .select('id, ordem_id, etapa, origem, recobrimento, umidade_ok, po_ok, observacao, ts')
    .order('ts', { ascending: false })
  erro('checklists de qualidade', error)
  return (data ?? []) as ChecklistQualidade[]
}

/** Em processo: vários por ordem, cada verificação vira um registro com hora. */
export async function registrarCheckProcesso(
  ordemId: string,
  d: DadosChecklist,
  inspetorId: string,
): Promise<void> {
  if (!d.origem) throw new Error('Informe a origem da amostra: BOWL ou BAG.')
  const { error } = await supabase.from('qualidade_checks').insert({
    ordem_id: ordemId,
    etapa: 'processo',
    origem: d.origem,
    recobrimento: d.recobrimento,
    umidade_ok: d.umidadeOk,
    po_ok: d.poOk,
    observacao: d.observacao,
    inspetor_id: inspetorId,
  })
  erro('registrar verificação em processo', error)
}

/**
 * Final: um por ordem; grava o check e muda o status para 'Qualidade
 * apontada'. Vai por RPC porque o perfil Qualidade não tem UPDATE em
 * `ordens` — feito no cliente, o flip falharia em silêncio.
 */
export async function apontarQualidadeFinal(
  ordemId: string,
  d: DadosChecklist,
): Promise<void> {
  const { error } = await supabase.rpc('apontar_qualidade_final', {
    p_ordem: ordemId,
    p_recobrimento: d.recobrimento,
    p_umidade_ok: d.umidadeOk,
    p_po_ok: d.poOk,
    p_obs: d.observacao,
  })
  erro('apontar qualidade final', error)
}

/** Conferência física da logística — uma por ordem, recontagem sobrescreve. */
export interface ConferenciaLinha {
  ordem_id: string
  bags_contados: number
  observacao: string | null
  ts: string
}

export async function listarConferencias(): Promise<ConferenciaLinha[]> {
  const { data, error } = await supabase
    .from('ordem_conferencias')
    .select('ordem_id, bags_contados, observacao, ts')
  erro('conferências de estoque', error)
  return (data ?? []) as ConferenciaLinha[]
}

export async function registrarConferencia(
  ordemId: string,
  bagsContados: number,
  observacao: string | null,
  usuarioId: string,
): Promise<void> {
  if (!Number.isFinite(bagsContados) || bagsContados < 0)
    throw new Error('Informe a quantidade de bags contados (0 ou mais).')
  const { error } = await supabase.from('ordem_conferencias').upsert(
    {
      ordem_id: ordemId,
      bags_contados: Math.round(bagsContados),
      observacao,
      conferido_por: usuarioId,
      ts: new Date().toISOString(),
    },
    { onConflict: 'ordem_id' },
  )
  erro('registrar conferência', error)
}

/** Visão geral: cada ordem com o resumo das etapas (v_ordem_etapas). */
export interface OrdemEtapasLinha extends OrdemVisao {
  checks_processo: number
  tem_qualidade_final: boolean
  conferida: boolean
  bags_contados: number | null
}

export async function listarOrdensEtapas(): Promise<OrdemEtapasLinha[]> {
  const { data, error } = await supabase
    .from('v_ordem_etapas')
    .select('*')
    .order('data_prog')
    .order('maquina_id')
    .order('seq')
  erro('etapas das ordens', error)
  return (data ?? []) as OrdemEtapasLinha[]
}

/** Encerramento: o PCP lança no AGROTIS e registra o número aqui. */
export async function apontarAgrotis(
  ordemId: string,
  numero: string,
  usuarioId: string,
): Promise<void> {
  if (!numero.trim()) throw new Error('O nº do lançamento no AGROTIS é obrigatório.')
  const { error } = await supabase
    .from('ordens')
    .update({
      agrotis_num: numero.trim(),
      agrotis_por: usuarioId,
      agrotis_em: new Date().toISOString(),
      status: 'Apontada',
    })
    .eq('id', ordemId)
  erro('apontar no AGROTIS', error)
}

// ================================================================
// Indicadores
// ================================================================

export interface TempoOrdem {
  ordem_id: string
  numero: string
  maquina_id: string
  data_prog: string | null
  turno_id: number | null
  peso_t: number
  bruto_s: number
  paradas_s: number
  paradas_plan_s: number
  paradas_nplan_s: number
  liquido_s: number
  planejado_s: number
}

export async function listarTempos(de: string, ate: string): Promise<TempoOrdem[]> {
  const { data, error } = await supabase
    .from('v_ordem_tempos')
    .select('*')
    .gte('data_prog', de)
    .lte('data_prog', ate)
    .order('data_prog')
  erro('tempos por ordem', error)
  return (data ?? []) as TempoOrdem[]
}

export interface ParadaDetalhe {
  motivo: string
  tipo: TipoParada
  ocorrencias: number
  segundos: number
}

/** Pareto de paradas no período, separando planejada de não planejada. */
export async function paretoParadas(de: string, ate: string): Promise<ParadaDetalhe[]> {
  const { data, error } = await supabase
    .from('ordem_paradas')
    .select('inicio, fim, motivos_parada ( descricao, tipo ), ordens!inner ( data_prog )')
    .gte('ordens.data_prog', de)
    .lte('ordens.data_prog', ate)
  erro('paradas do período', error)

  const acc = new Map<string, ParadaDetalhe>()
  for (const p of (data ?? []) as unknown as {
    inicio: string
    fim: string | null
    motivos_parada: { descricao: string; tipo: TipoParada }
  }[]) {
    const m = p.motivos_parada
    if (!m) continue
    const dur =
      ((p.fim ? new Date(p.fim).getTime() : Date.now()) - new Date(p.inicio).getTime()) / 1000
    const atual = acc.get(m.descricao)
    if (atual) {
      atual.ocorrencias++
      atual.segundos += dur
    } else {
      acc.set(m.descricao, {
        motivo: m.descricao,
        tipo: m.tipo,
        ocorrencias: 1,
        segundos: dur,
      })
    }
  }
  return [...acc.values()].sort((a, b) => b.segundos - a.segundos)
}

// ================================================================
// Cadastros
// ================================================================

export interface ReceitaCompleta {
  id: string
  nome: string
  ativa: boolean
  receita_itens: {
    produto_id: string
    dose: number
    tanque: number
    produtos_quimicos: {
      codigo: string
      nome: string
      unidade: UnidadeDose
      densidade: number | null
    }
  }[]
}

export async function listarReceitas(): Promise<ReceitaCompleta[]> {
  const { data, error } = await supabase
    .from('receitas')
    .select(
      'id, nome, ativa, receita_itens ( produto_id, dose, tanque, produtos_quimicos ( codigo, nome, unidade, densidade ) )',
    )
    .order('nome')
  erro('receitas', error)
  return (data ?? []) as unknown as ReceitaCompleta[]
}

export interface EmbalagemLinha {
  codigo: string
  codigo_ext: string | null
  descricao: string
  sementes: number
  fator_peso: number
}

export async function listarEmbalagens(): Promise<EmbalagemLinha[]> {
  const { data, error } = await supabase.from('embalagens').select('*').order('codigo')
  erro('embalagens', error)
  return (data ?? []) as EmbalagemLinha[]
}

export interface TurnoLinha {
  id: number
  nome: string
  inicio: string
  fim: string
  horas: number
}

export async function listarTurnos(): Promise<TurnoLinha[]> {
  const { data, error } = await supabase.from('turnos').select('*').order('id')
  erro('turnos', error)
  return (data ?? []) as TurnoLinha[]
}
