import { supabase } from '@/lib/supabase'
import type { StatusPersistido, TipoParada, UnidadeDose } from '@/dominio/tipos'

/**
 * Acesso ao banco. As formas aqui espelham as linhas do schema `tsi`;
 * a interpretação (tempos, pesos, permissões) fica no domínio, não aqui.
 */

export interface LinhaMaquina {
  id: string
  nome: string
  capacidade_th: number
  qtd_tanques: number
}

export interface LinhaMotivo {
  id: string
  descricao: string
  tipo: TipoParada
}

export interface LinhaProduto {
  id: string
  codigo: string
  nome: string
  unidade: UnidadeDose
  densidade: number | null
}

export interface LinhaOrdem {
  id: string
  numero: string
  cultivar: string
  receita_id: string
  embalagem: string
  bags: number
  lote_id: string
  cliente: string | null
  observacao: string | null
  armazem: string | null
  bloco: string | null
  quadra: string | null
  prioridade: 'Normal' | 'Urgente'
  maquina_id: string | null
  data_prog: string | null
  seq: number | null
  turno_id: number | null
  status: StatusPersistido
  fim_pendente: boolean
  lotes_semente: {
    id: string
    cultivar: string
    pms: number | null
    peso_bag_kg: number
    status: 'Em estoque' | 'Baixado'
  }
  receitas: {
    nome: string
    receita_itens: { produto_id: string; dose: number; tanque: number }[]
  }
  ordem_eventos: { tipo: 'inicio' | 'fim'; ts: string }[]
  ordem_paradas: { id: string; motivo_id: string; inicio: string; fim: string | null }[]
  ordem_tanques: {
    id: string
    tanque: number
    peso_inicial: number | null
    peso_final: number | null
  }[]
}

const SELECT_ORDEM = `
  id, numero, cultivar, receita_id, embalagem, bags, lote_id, cliente, observacao,
  armazem, bloco, quadra,
  prioridade, maquina_id, data_prog, seq, turno_id, status, fim_pendente,
  lotes_semente ( id, cultivar, pms, peso_bag_kg, status ),
  receitas ( nome, receita_itens ( produto_id, dose, tanque ) ),
  ordem_eventos ( tipo, ts ),
  ordem_paradas ( id, motivo_id, inicio, fim ),
  ordem_tanques ( id, tanque, peso_inicial, peso_final )
`

function erro(contexto: string, e: { message: string } | null): never | void {
  if (e) throw new Error(`${contexto}: ${e.message}`)
}

/**
 * UPDATE barrado pelo RLS não dá erro: afeta 0 linhas em silêncio, e o app
 * seguiria adiante achando que gravou. Todo update de apontamento pede as
 * linhas de volta (.select) e trata 0 linhas como recusa.
 */
const SEM_LINHA = 'o banco não alterou nenhuma linha — o seu perfil não tem essa permissão'
function exigeLinha(contexto: string, linhas: unknown[] | null): void {
  if ((linhas ?? []).length === 0) throw new Error(`${contexto}: ${SEM_LINHA}`)
}

export async function carregarCadastros() {
  const [maquinas, motivos, produtos] = await Promise.all([
    supabase.from('maquinas').select('id, nome, capacidade_th, qtd_tanques').order('id'),
    supabase.from('motivos_parada').select('id, descricao, tipo').eq('ativo', true).order('descricao'),
    supabase.from('produtos_quimicos').select('id, codigo, nome, unidade, densidade'),
  ])
  erro('máquinas', maquinas.error)
  erro('motivos de parada', motivos.error)
  erro('produtos químicos', produtos.error)
  return {
    maquinas: (maquinas.data ?? []) as LinhaMaquina[],
    motivos: (motivos.data ?? []) as LinhaMotivo[],
    produtos: (produtos.data ?? []) as LinhaProduto[],
  }
}

/**
 * Ordens relevantes para a Execução: as do dia escolhido mais qualquer uma
 * em andamento, que pode ter começado num dia anterior e atravessado o turno 2.
 */
export async function carregarOrdens(dia: string): Promise<LinhaOrdem[]> {
  const { data, error } = await supabase
    .from('ordens')
    .select(SELECT_ORDEM)
    .or(`data_prog.eq.${dia},status.in.("Em producao","Parada")`)
    .order('maquina_id')
    .order('seq')
  erro('ordens', error)
  return (data ?? []) as unknown as LinhaOrdem[]
}

/** Prepara os tanques da receita. NÃO inicia — o cronômetro só corre no confirmar. */
export async function prepararTanques(
  ordemId: string,
  tanques: number[],
): Promise<void> {
  if (tanques.length === 0) return
  const { error } = await supabase
    .from('ordem_tanques')
    .upsert(
      tanques.map((tanque) => ({ ordem_id: ordemId, tanque })),
      { onConflict: 'ordem_id,tanque', ignoreDuplicates: true },
    )
  erro('preparar tanques', error)
}

export async function salvarPesoTanque(
  tanqueId: string,
  campo: 'peso_inicial' | 'peso_final',
  valor: number | null,
): Promise<void> {
  const { data, error } = await supabase
    .from('ordem_tanques')
    .update({ [campo]: valor })
    .eq('id', tanqueId)
    .select('id')
  erro('salvar peso', error)
  exigeLinha('salvar peso', data)
}

/**
 * Confirma o início: grava o evento e muda o status.
 * Os triggers do banco recusam se faltar peso inicial em algum tanque ou se
 * o lote de semente não estiver baixado — o app valida antes, mas a defesa
 * final é do banco.
 */
export async function confirmarInicio(ordemId: string, usuarioId: string): Promise<void> {
  const ev = await supabase
    .from('ordem_eventos')
    .insert({ ordem_id: ordemId, tipo: 'inicio', usuario_id: usuarioId })
  erro('registrar início', ev.error)

  const up = await supabase
    .from('ordens')
    .update({ status: 'Em producao' })
    .eq('id', ordemId)
    .select('id')
  if (up.error || (up.data ?? []).length === 0) {
    // desfaz o evento para não deixar início órfão de status
    await supabase.from('ordem_eventos').delete().eq('ordem_id', ordemId).eq('tipo', 'inicio')
    throw new Error(`confirmar início: ${up.error?.message ?? SEM_LINHA}`)
  }
}

export async function abrirPesagemFinal(ordemId: string): Promise<void> {
  const { data, error } = await supabase
    .from('ordens')
    .update({ fim_pendente: true })
    .eq('id', ordemId)
    .select('id')
  erro('abrir pesagem final', error)
  exigeLinha('abrir pesagem final', data)
}

/**
 * Desiste da finalização e volta a produzir. Não descarta nada: os pesos
 * finais já digitados ficam guardados (e travados) para a próxima tentativa.
 * Sem isto, um Finalizar clicado por engano só saía pelo Cancelar início,
 * que joga fora a ordem inteira.
 */
export async function voltarParaProducao(ordemId: string): Promise<void> {
  const { data, error } = await supabase
    .from('ordens')
    .update({ fim_pendente: false })
    .eq('id', ordemId)
    .select('id')
  erro('voltar para produção', error)
  exigeLinha('voltar para produção', data)
}

export async function confirmarFim(ordemId: string, usuarioId: string): Promise<void> {
  // fecha parada em aberto antes de encerrar, guardando quais para poder desfazer
  const par = await supabase
    .from('ordem_paradas')
    .update({ fim: new Date().toISOString() })
    .eq('ordem_id', ordemId)
    .is('fim', null)
    .select('id')
  erro('fechar parada em aberto', par.error)

  const ev = await supabase
    .from('ordem_eventos')
    .insert({ ordem_id: ordemId, tipo: 'fim', usuario_id: usuarioId })
  erro('registrar fim', ev.error)

  const up = await supabase
    .from('ordens')
    .update({ status: 'Finalizada', fim_pendente: false })
    .eq('id', ordemId)
    .select('id')
  if (up.error || (up.data ?? []).length === 0) {
    // sem o status, o fim não aconteceu: apaga o evento e reabre as paradas
    await supabase.from('ordem_eventos').delete().eq('ordem_id', ordemId).eq('tipo', 'fim')
    const ids = (par.data ?? []).map((p) => (p as { id: string }).id)
    if (ids.length > 0)
      await supabase.from('ordem_paradas').update({ fim: null }).in('id', ids)
    throw new Error(`confirmar finalização: ${up.error?.message ?? SEM_LINHA}`)
  }
}

export async function registrarParada(
  ordemId: string,
  motivoId: string,
  usuarioId: string,
): Promise<void> {
  const p = await supabase
    .from('ordem_paradas')
    .insert({ ordem_id: ordemId, motivo_id: motivoId, usuario_id: usuarioId })
    .select('id')
    .single()
  erro('registrar parada', p.error)
  const up = await supabase
    .from('ordens')
    .update({ status: 'Parada' })
    .eq('id', ordemId)
    .select('id')
  if (up.error || (up.data ?? []).length === 0) {
    // parada sem status é meia-verdade: descarta a parada recém-criada
    if (p.data) await supabase.from('ordem_paradas').delete().eq('id', p.data.id)
    throw new Error(`mudar status para Parada: ${up.error?.message ?? SEM_LINHA}`)
  }
}

export async function retomar(ordemId: string): Promise<void> {
  const p = await supabase
    .from('ordem_paradas')
    .update({ fim: new Date().toISOString() })
    .eq('ordem_id', ordemId)
    .is('fim', null)
    .select('id')
  erro('fechar parada', p.error)
  const up = await supabase
    .from('ordens')
    .update({ status: 'Em producao' })
    .eq('id', ordemId)
    .select('id')
  if (up.error || (up.data ?? []).length === 0) {
    // status não voltou: reabre a parada para não parar de contar o tempo
    const ids = (p.data ?? []).map((x) => (x as { id: string }).id)
    if (ids.length > 0)
      await supabase.from('ordem_paradas').update({ fim: null }).in('id', ids)
    throw new Error(`retomar produção: ${up.error?.message ?? SEM_LINHA}`)
  }
}

/**
 * Cancelar início: o operador começou a ordem errada. Descarta os
 * apontamentos, devolve a ordem para Programada e libera a máquina.
 * Fica registrado quem cancelou e o que foi descartado.
 */
export async function cancelarInicio(
  ordemId: string,
  usuarioId: string,
  detalhe: string,
): Promise<void> {
  const aud = await supabase.from('ordem_auditoria').insert({
    ordem_id: ordemId,
    acao: 'cancelou o início',
    detalhe,
    usuario_id: usuarioId,
  })
  erro('registrar auditoria', aud.error)

  // o status volta antes de apagar os eventos: o trigger de imutabilidade
  // só libera a ordem depois que ela deixa de estar em andamento.
  // Se o RLS recusar aqui, parar ANTES dos deletes — senão os apontamentos
  // seriam apagados com a ordem ainda em andamento.
  const up = await supabase
    .from('ordens')
    .update({ status: 'Programada', turno_id: null, fim_pendente: false })
    .eq('id', ordemId)
    .select('id')
  erro('devolver ordem para Programada', up.error)
  exigeLinha('devolver ordem para Programada', up.data)

  // os deletes também devolvem as linhas: descarte recusado não pode passar
  // batido, senão sobra evento duplicado inflando o tempo bruto da próxima
  const delPar = await supabase.from('ordem_paradas').delete().eq('ordem_id', ordemId).select('id')
  erro('descartar paradas', delPar.error)
  const delEv = await supabase.from('ordem_eventos').delete().eq('ordem_id', ordemId).select('id')
  erro('descartar eventos', delEv.error)
  const delTq = await supabase.from('ordem_tanques').delete().eq('ordem_id', ordemId).select('id')
  erro('descartar tanques', delTq.error)
  if ((delEv.data ?? []).length === 0)
    throw new Error(`descartar eventos: ${SEM_LINHA} — o cancelamento ficou incompleto, avise o gestor`)
}
