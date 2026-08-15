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
  /** Informado pela produção ao confirmar a finalização. */
  bags_produzidos: number | null
  /** Primeiro dia em que a ordem foi programada — não muda depois. */
  data_prog_original?: string | null
  /** Quantas vezes mudou de dia. */
  reprogramacoes?: number | null
  reprogramada_em?: string | null
  /**
   * Liberação DESTA ordem pela logística — por ordem, não pelo lote
   * inteiro (10/08/2026). Null = aguardando; uma ordem nova do mesmo
   * lote de outra já liberada nasce null, nunca herda a liberação dela.
   */
  lote_liberado_em: string | null
  lote_liberado_por: string | null
  /**
   * PCP confirmou a ordem programada (11/08/2026). Null = programada mas
   * ainda em rascunho — invisível para a Logística baixar o lote.
   */
  confirmada_em: string | null
  confirmada_por: string | null
}

export async function listarOrdens(de?: string, ate?: string): Promise<OrdemVisao[]> {
  let q = supabase.from('v_ordens').select('*')
  if (de) q = q.gte('data_prog', de)
  if (ate) q = q.lte('data_prog', ate)
  const { data, error } = await q.order('data_prog').order('maquina_id').order('seq')
  erro('ordens', error)
  return (data ?? []) as OrdemVisao[]
}

export interface OrdemResumoReceita {
  id: string
  numero: string
  status_efetivo: string
  peso_kg: number
}

/**
 * Todas as ordens da mesma receita, com só o essencial pra somar tonelagem —
 * usada pela tela de preparo (ModalOrdem) quando a receita tem mais de 5
 * produtos e precisa de calda: a quantidade de cada produto passa a
 * considerar a soma de várias ordens, não só a que está aberta.
 */
export async function listarOrdensDaReceita(receitaId: string): Promise<OrdemResumoReceita[]> {
  const { data, error } = await supabase
    .from('v_ordens')
    .select('id, numero, status_efetivo, peso_kg')
    .eq('receita_id', receitaId)
  erro('ordens da receita', error)
  return (data ?? []) as OrdemResumoReceita[]
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

/**
 * Edição de ordem que a produção ainda não tocou (a Programação também usa,
 * para máquina/dia/seq). A matriz de status decide QUANDO pode e o trigger
 * de imutabilidade no banco garante mesmo se alguém contornar a tela.
 */
export async function atualizarOrdem(id: string, campos: Partial<NovaOrdem>): Promise<void> {
  const { error } = await supabase.from('ordens').update(campos).eq('id', id)
  if (error?.code === '23505') {
    throw new Error(
      `Já existe ordem com ${campos.numero ?? ''} + ${campos.cultivar ?? ''} + esta receita + ${campos.embalagem ?? ''}.`,
    )
  }
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

/**
 * PCP confirma a ordem programada — só a partir daqui ela aparece para a
 * Logística baixar o lote (decisão de 11/08/2026). Dar máquina/dia não
 * bastava: a ordem ficava visível para baixa sem revisão nenhuma do PCP.
 * Requer supabase/confirmar-ordem-programada.sql aplicado.
 */
export async function confirmarOrdem(id: string, usuarioId: string): Promise<void> {
  const { error } = await supabase
    .from('ordens')
    .update({ confirmada_em: new Date().toISOString(), confirmada_por: usuarioId })
    .eq('id', id)
  erro('confirmar ordem', error)
}

// ================================================================
// Calendário — turnos de cada dia
// ================================================================

/** Uma exceção do calendário. Dia sem linha aqui roda os dois turnos. */
export interface DiaProducao {
  data: string
  turno1: boolean
  turno2: boolean
  observacao: string | null
}

/**
 * Só as exceções, no período pedido.
 *
 * Duas tolerâncias de propósito: devolve lista vazia se a tabela ainda não
 * existir (o front vai ao ar antes do SQL, e a Programação não pode depender
 * disso para abrir) e entende o formato antigo, em que a coluna guardava a
 * QUANTIDADE de turnos em vez de quais — assim a tela funciona na janela
 * entre publicar o front e rodar a migração.
 */
export async function listarDiasProducao(de: string, ate: string): Promise<DiaProducao[]> {
  const { data, error } = await supabase
    .from('dias_producao')
    .select('*')
    .gte('data', de)
    .lte('data', ate)
  if (error) {
    if (error.code === '42P01' || error.message.includes('dias_producao')) return []
    erro('calendário de turnos', error)
  }
  return (data ?? []).map((d: Record<string, unknown>) => ({
    data: d.data as string,
    turno1: 'turno1' in d ? Boolean(d.turno1) : Number(d.turnos ?? 2) >= 1,
    turno2: 'turno2' in d ? Boolean(d.turno2) : Number(d.turnos ?? 2) >= 2,
    observacao: (d.observacao as string) ?? null,
  }))
}

/**
 * Define quais turnos um dia roda. Rodar os dois é o padrão, então marcar
 * um dia assim APAGA a exceção em vez de gravá-la — o calendário guarda só
 * o que foge da regra e não vira um registro por dia do ano.
 */
export async function definirTurnosDoDia(
  data: string,
  turno1: boolean,
  turno2: boolean,
  usuarioId: string,
  observacao?: string | null,
): Promise<void> {
  if (turno1 && turno2 && !observacao) {
    const { error } = await supabase.from('dias_producao').delete().eq('data', data)
    erro('limpar turnos do dia', error)
    return
  }
  const { error } = await supabase.from('dias_producao').upsert(
    {
      data,
      turno1,
      turno2,
      observacao: observacao ?? null,
      alterado_em: new Date().toISOString(),
      alterado_por: usuarioId,
    },
    { onConflict: 'data' },
  )
  erro('definir turnos do dia', error)
}

/** Histórico de mudanças de dia/máquina de uma ordem. */
export interface ReprogramacaoLinha {
  id: string
  ordem_id: string
  de_dia: string | null
  para_dia: string | null
  de_maquina: string | null
  para_maquina: string | null
  ts: string
}

export async function listarReprogramacoes(ordemId?: string): Promise<ReprogramacaoLinha[]> {
  let q = supabase
    .from('ordem_reprogramacoes')
    .select('id, ordem_id, de_dia, para_dia, de_maquina, para_maquina, ts')
    .order('ts', { ascending: false })
  if (ordemId) q = q.eq('ordem_id', ordemId)
  const { data, error } = await q.limit(500)
  if (error) {
    if (error.code === '42P01' || error.message.includes('ordem_reprogramacoes')) return []
    erro('histórico de reprogramação', error)
  }
  return (data ?? []) as ReprogramacaoLinha[]
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
  /** Quem baixou e quando — o banco grava desde a primeira baixa, mas a
   *  tela nunca mostrava; "quem baixou este lote?" só tinha resposta via SQL. */
  baixado_por: string | null
  baixado_em: string | null
}

export async function listarLotes(): Promise<LoteSementeLinha[]> {
  const { data, error } = await supabase
    .from('lotes_semente')
    .select('id, cultivar, tratamento, pms, peso_bag_kg, bags_disp, status, devolver, baixado_por, baixado_em')
    .order('id')
  erro('lotes de semente', error)
  return (data ?? []) as LoteSementeLinha[]
}

/** Cadastro manual de lote — o caminho normal é o upload de Saldos. */
export async function criarLote(l: {
  id: string
  cultivar: string
  tratamento: string | null
  pms: number | null
  peso_bag_kg: number
  bags_disp: number
}): Promise<void> {
  const { error } = await supabase
    .from('lotes_semente')
    .insert({ ...l, status: 'Em estoque' })
  if (error) {
    if (error.code === '23505') throw new Error(`O lote ${l.id} já está cadastrado.`)
    throw new Error(`criar lote: ${error.message}`)
  }
}

/**
 * A baixa muda o status E registra o movimento — duas escritas que precisam
 * valer juntas. Antes eram duas chamadas: quando o RLS recusava a segunda,
 * sobrava lote Baixado sem movimento (baixa fantasma que liberava produção
 * sem separação física). A RPC roda as duas numa transação só; quem decide
 * quem pode é a matriz da Administração, via `tem_acao()` no banco.
 *
 * Libera POR ORDEM (10/08/2026), não o lote inteiro: uma viagem ao depósito
 * continua liberando várias ordens de uma vez (isso é físico), mas só as
 * que estão abertas E ainda sem liberação NESTE momento — a RPC calcula
 * bags/peso sozinha a partir delas, então não recebe mais esses valores
 * como parâmetro (evita divergir do que o front somou no clique).
 * Requer supabase/liberacao-lote-por-ordem.sql aplicado.
 */
export async function baixarLote(loteId: string): Promise<void> {
  const { error } = await supabase.rpc('baixar_lote', { p_lote: loteId })
  erro('baixar lote', error)
}

/**
 * Estorno é POR ORDEM (10/08/2026): desfaz a liberação de uma ordem
 * específica, sem afetar outras ordens do mesmo lote que também estejam
 * liberadas. O trigger do banco recusa se esta ordem já foi iniciada.
 * Também recalcula `lotes_semente.status`: só volta a 'Em estoque' se,
 * depois deste estorno, nenhuma outra ordem do lote continuar liberada.
 */
export async function estornarLiberacao(ordemId: string): Promise<void> {
  const { error } = await supabase.rpc('estornar_liberacao', { p_ordem: ordemId })
  erro('estornar liberação', error)
}

/**
 * Devolve ao estoque um lote 'Baixado' que ficou sem NENHUMA ordem
 * dependente (órfão) — caso raro em que não há ordem para o estorno por
 * ordem agir. Ex.: a última ordem que dependia dele foi excluída depois
 * de liberada.
 */
export async function devolverLoteOrfao(loteId: string): Promise<void> {
  const { error } = await supabase.rpc('devolver_lote_orfao', { p_lote: loteId })
  erro('devolver lote órfão', error)
}

export interface MovimentoLote {
  id: string
  lote_id: string
  bags: number
  peso_t: number | null
  estorno: boolean
  ts: string
  usuario_id: string | null
}

export async function listarMovimentos(desde: string): Promise<MovimentoLote[]> {
  const { data, error } = await supabase
    .from('lote_movimentos')
    .select('id, lote_id, bags, peso_t, estorno, ts, usuario_id')
    .gte('ts', desde)
    .order('ts', { ascending: false })
  erro('movimentos de lote', error)
  return (data ?? []) as MovimentoLote[]
}

// ================================================================
// Expedição: carregamentos agendados (montagem de carga)
// ================================================================

export interface CarregamentoBanco {
  id: string
  carga: number
  status: string
  data: string | null
  pedido: string | null
  cliente: string | null
  cultivar: string
  tratamento: string
  embalagem: string
  bags: number
  transportadora: string | null
  motorista: string | null
  placa: string | null
  importado_em: string
}

/**
 * Devolve vazio se a tabela ainda não existir: o front vai ao ar antes do
 * SQL, e a tela precisa abrir para mostrar o aviso de "rode o script".
 */
export async function listarCarregamentos(): Promise<CarregamentoBanco[]> {
  const { data, error } = await supabase
    .from('carregamentos')
    .select('*')
    .order('data', { ascending: true, nullsFirst: false })
  if (error) {
    if (error.code === '42P01' || error.message.includes('carregamentos')) return []
    erro('carregamentos', error)
  }
  return (data ?? []) as CarregamentoBanco[]
}

/**
 * Substituição total, como pedidos e saldos: o arquivo é a foto do dia, e
 * misturar duas fotos duplicaria os agendamentos que aparecem nas duas.
 */
export async function substituirCarregamentos(
  linhas: Omit<CarregamentoBanco, 'id' | 'importado_em'>[],
  usuarioId: string,
): Promise<void> {
  const del = await supabase.from('carregamentos').delete().gte('carga', 0)
  erro('limpar carregamentos anteriores', del.error)
  if (linhas.length === 0) return
  const { error } = await supabase
    .from('carregamentos')
    .insert(linhas.map((l) => ({ ...l, importado_por: usuarioId })))
  erro('gravar carregamentos', error)
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

/** Estoque de produto acabado (tratado) da carga vigente, linha a linha. */
export interface EstoquePaLinha {
  cultivar: string
  tratamento: string
  embalagem: string
  bags: number
}

export async function listarEstoquePa(): Promise<EstoquePaLinha[]> {
  const { data, error } = await supabase
    .from('estoque_pa')
    .select('cultivar, tratamento, embalagem, bags')
  erro('estoque de produto acabado', error)
  return (data ?? []) as EstoquePaLinha[]
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
  inspetor_id: string | null
  ts: string
  /** Caminhos no bucket `qualidade` — até 3, só na etapa final. */
  fotos: string[]
}

export interface DadosChecklist {
  /** Obrigatória na etapa em processo; a final não usa. */
  origem?: 'BOWL' | 'BAG'
  recobrimento: number
  umidadeOk: boolean
  poOk: boolean
  observacao: string | null
  /**
   * Caminhos já enviados ao Storage (não dataURL): o upload acontece na
   * SELEÇÃO da foto (`SeletorFotos`), não aqui. Guardar a dataURL inteira
   * no rascunho (localStorage) estourava a cota em silêncio — o
   * `localStorage.setItem` falhava, o catch engolia o erro, e a foto
   * desaparecia sem aviso no próximo reload (o que o Android faz sempre
   * que a câmera abre). O caminho é texto curto: cabe folgado.
   */
  fotos?: string[]
}

export async function listarChecksQualidade(): Promise<ChecklistQualidade[]> {
  const { data, error } = await supabase
    .from('qualidade_checks')
    .select('id, ordem_id, etapa, origem, recobrimento, umidade_ok, po_ok, observacao, inspetor_id, ts, fotos')
    .order('ts', { ascending: false })
  if (error) {
    // a coluna `fotos` nasceu depois: sem ela a tela inteira deixaria de abrir
    if (error.message.includes('fotos')) {
      const r = await supabase
        .from('qualidade_checks')
        .select('id, ordem_id, etapa, origem, recobrimento, umidade_ok, po_ok, observacao, inspetor_id, ts')
        .order('ts', { ascending: false })
      erro('checklists de qualidade', r.error)
      return ((r.data ?? []) as ChecklistQualidade[]).map((c) => ({ ...c, fotos: [] }))
    }
    erro('checklists de qualidade', error)
  }
  return ((data ?? []) as ChecklistQualidade[]).map((c) => ({ ...c, fotos: c.fotos ?? [] }))
}

const BUCKET_FOTOS = 'qualidade'

/**
 * Sobe as fotos (dataURLs já reduzidas na seleção) e devolve os caminhos.
 * Chamada uma foto por vez, no instante da seleção (`SeletorFotos`) — não
 * no envio do checklist.
 */
export async function enviarFotosQualidade(ordemId: string, fotos: string[]): Promise<string[]> {
  const caminhos: string[] = []
  for (const [i, dataUrl] of fotos.entries()) {
    const blob = await (await fetch(dataUrl)).blob()
    // sem o índice, duas fotos do mesmo segundo se sobrescreveriam
    const caminho = `${ordemId}/${Date.now()}-${i}.jpg`
    const { error } = await supabase.storage
      .from(BUCKET_FOTOS)
      .upload(caminho, blob, { contentType: 'image/jpeg', upsert: false })
    if (error) throw new Error(`enviar foto ${i + 1}: ${error.message}`)
    caminhos.push(caminho)
  }
  return caminhos
}

/** O bucket é privado: a imagem só abre por link assinado, que expira. */
export async function urlFotoQualidade(caminho: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(BUCKET_FOTOS)
    .createSignedUrl(caminho, 3600)
  if (error) return null
  return data?.signedUrl ?? null
}

/** Remove uma foto já enviada (ex.: o inspetor tirou de novo). Best-effort: falhar aqui só deixa um arquivo órfão no bucket privado, sem consequência. */
export async function removerFotoQualidade(caminho: string): Promise<void> {
  await supabase.storage.from(BUCKET_FOTOS).remove([caminho])
}

/**
 * Foto da câmera → dataURL JPEG de no máximo 1600 px.
 *
 * Roda na SELEÇÃO, não no envio: (1) a foto original tem vários MB e
 * travaria o upload na rede do galpão; (2) o dataURL é texto e cabe no
 * rascunho persistente — é o que faz o teste sobreviver quando o Android
 * mata a aba para abrir a câmera; (3) soltar o File original cedo alivia a
 * memória do tablet, que é justamente quem mata a aba.
 */
export async function fotoParaDataUrl(
  arquivo: File,
  maxLado = 1600,
  qualidade = 0.8,
): Promise<string> {
  const bitmap = await createImageBitmap(arquivo)
  const escala = Math.min(1, maxLado / Math.max(bitmap.width, bitmap.height))
  const w = Math.round(bitmap.width * escala)
  const h = Math.round(bitmap.height * escala)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Este navegador não consegue processar a imagem.')
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  return canvas.toDataURL('image/jpeg', qualidade)
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
  // as fotos já subiram na seleção (SeletorFotos) — `d.fotos` aqui são
  // caminhos, não dataURLs; nada para enviar de novo
  const { error } = await supabase.rpc('apontar_qualidade_final', {
    p_ordem: ordemId,
    p_recobrimento: d.recobrimento,
    p_umidade_ok: d.umidadeOk,
    p_po_ok: d.poOk,
    p_obs: d.observacao,
    p_fotos: d.fotos ?? [],
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

/** Tanques das ordens, para o PCP digitar os pesos finais na tela AGROTIS. */
export interface TanqueLinha {
  id: string
  ordem_id: string
  tanque: number
  peso_inicial: number | null
  peso_final: number | null
}

export async function listarTanquesDeOrdens(ordemIds: string[]): Promise<TanqueLinha[]> {
  if (ordemIds.length === 0) return []
  const { data, error } = await supabase
    .from('ordem_tanques')
    .select('id, ordem_id, tanque, peso_inicial, peso_final')
    .in('ordem_id', ordemIds)
    .order('tanque')
  erro('tanques das ordens', error)
  return (data ?? []) as TanqueLinha[]
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
  /** Horário real do apontamento de início; `fim` fica null enquanto roda. */
  ini: string
  fim: string | null
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

/** Nomes para os relatórios (quem inspecionou, quem conferiu). */
export async function listarNomesUsuarios(): Promise<Record<string, string>> {
  const { data, error } = await supabase.from('usuarios').select('id, nome')
  erro('nomes de usuários', error)
  return Object.fromEntries(
    ((data ?? []) as { id: string; nome: string }[]).map((u) => [u.id, u.nome]),
  )
}

/** Uma parada individual, para o relatório por dia/ordem/turno. */
export interface ParadaLinha {
  inicio: string
  fim: string | null
  segundos: number
  motivo: string
  tipo: TipoParada
  ordem_numero: string
  maquina_id: string
  data_prog: string | null
  turno_id: number | null
}

export async function listarParadasPeriodo(de: string, ate: string): Promise<ParadaLinha[]> {
  const { data, error } = await supabase
    .from('ordem_paradas')
    .select('inicio, fim, motivos_parada ( descricao, tipo ), ordens!inner ( numero, maquina_id, data_prog, turno_id )')
    .gte('ordens.data_prog', de)
    .lte('ordens.data_prog', ate)
    .order('inicio')
  erro('paradas do período', error)

  return ((data ?? []) as unknown as {
    inicio: string
    fim: string | null
    motivos_parada: { descricao: string; tipo: TipoParada } | null
    ordens: { numero: string; maquina_id: string; data_prog: string | null; turno_id: number | null }
  }[]).map((p) => ({
    inicio: p.inicio,
    fim: p.fim,
    segundos:
      ((p.fim ? new Date(p.fim).getTime() : Date.now()) - new Date(p.inicio).getTime()) / 1000,
    motivo: p.motivos_parada?.descricao ?? '?',
    tipo: p.motivos_parada?.tipo ?? 'Nao planejada',
    ordem_numero: p.ordens.numero,
    maquina_id: p.ordens.maquina_id,
    data_prog: p.ordens.data_prog,
    turno_id: p.ordens.turno_id,
  }))
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
      'id, nome, ativa, receita_itens ( produto_id, dose, produtos_quimicos ( codigo, nome, unidade, densidade ) )',
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
