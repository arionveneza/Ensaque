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
  /** Destinação da produção (31/08/2026) — sai na folha impressa. */
  destinacao: string | null
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
  bags_produzidos: number | null
  /** Liberação DESTA ordem — por ordem, não pelo lote inteiro (10/08/2026). */
  lote_liberado_em: string | null
  /** PCP confirmou a ordem programada — antes disso é invisível à Logística (11/08/2026). */
  confirmada_em: string | null
  /**
   * Embalagem DA ORDEM: peso do bag = peso_fixo_kg (saco de 10/20 kg,
   * 24/08/2026) ou pms × fator_peso (13/08/2026), nessa ordem.
   */
  embalagens: { fator_peso: number | null; peso_fixo_kg: number | null } | null
  lotes_semente: {
    id: string
    cultivar: string
    pms: number | null
    peso_bag_kg: number
    status: 'Em estoque' | 'Baixado'
    /** Do export do SAP — null em lote da SimpleAgro. Saem na etiqueta DM. */
    peneira: string | null
    categoria: string | null
  }
  receitas: {
    nome: string
    receita_itens: { produto_id: string; dose: number }[]
  }
  /** Destino escolhido pelo operador nesta ordem: 1–5 ou 0 = transferidor. */
  ordem_produtos: { produto_id: string; tanque: number }[]
  ordem_eventos: { tipo: 'inicio' | 'fim'; ts: string }[]
  ordem_paradas: { id: string; motivo_id: string; inicio: string; fim: string | null }[]
  /** Só para o aviso do Cancelar início: quantos testes serão descartados. */
  qualidade_checks: { id: string }[]
  ordem_tanques: {
    id: string
    tanque: number
    peso_inicial: number | null
    peso_final: number | null
    /** O que foi acrescentado ao tanque durante a ordem (produto acabou). */
    ordem_tanque_abastecimentos: { id: string; peso_kg: number; ts: string }[]
  }[]
}

const SELECT_ORDEM = `
  id, numero, cultivar, receita_id, embalagem, bags, lote_id, cliente, observacao,
  destinacao, armazem, bloco, quadra,
  prioridade, maquina_id, data_prog, seq, turno_id, status, fim_pendente, bags_produzidos,
  lote_liberado_em, confirmada_em,
  embalagens ( fator_peso, peso_fixo_kg ),
  lotes_semente ( id, cultivar, pms, peso_bag_kg, status, peneira, categoria ),
  receitas ( nome, receita_itens ( produto_id, dose ) ),
  ordem_produtos ( produto_id, tanque ),
  ordem_eventos ( tipo, ts ),
  ordem_paradas ( id, motivo_id, inicio, fim ),
  ordem_tanques ( id, tanque, peso_inicial, peso_final,
                  ordem_tanque_abastecimentos ( id, peso_kg, ts ) ),
  qualidade_checks ( id )
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
    .neq('status', 'Excluida')
    .order('maquina_id')
    .order('seq')
  erro('ordens', error)
  return (data ?? []) as unknown as LinhaOrdem[]
}

/**
 * Uma ordem específica, com o mesmo detalhe rico de `carregarOrdens` (tanques,
 * paradas, receita) mas SEM recorte de dia — para abrir qualquer ordem do
 * histórico (tela Ordens) fora do dia atual, que é o que `carregarOrdens`
 * exige.
 */
export async function carregarOrdemPorId(id: string): Promise<LinhaOrdem | null> {
  const { data, error } = await supabase
    .from('ordens')
    .select(SELECT_ORDEM)
    .eq('id', id)
    .maybeSingle()
  erro('ordem', error)
  return data as unknown as LinhaOrdem | null
}

/**
 * Define o destino de um produto nesta ordem (1–5 ou 0 = transferidor;
 * null desfaz). Vai por RPC porque uma escolha mexe em duas tabelas: cria o
 * tanque quando ele passa a ser usado e remove o que ficou sem produto.
 */
export async function definirTanqueProduto(
  ordemId: string,
  produtoId: string,
  tanque: number | null,
): Promise<void> {
  const { error } = await supabase.rpc('definir_tanque_produto', {
    p_ordem: ordemId,
    p_produto: produtoId,
    p_tanque: tanque,
  })
  erro('definir tanque do produto', error)
}

/**
 * Registra o que foi acrescentado ao tanque com a ordem já rodando — o
 * produto acabou e o operador completou. Vai por RPC porque o consumo real
 * depende disto: `inicial − final` sozinho contaria só a última carga.
 */
export async function abastecerTanque(tanqueId: string, pesoKg: number): Promise<void> {
  const { error } = await supabase.rpc('abastecer_tanque', {
    p_tanque: tanqueId,
    p_peso: pesoKg,
  })
  erro('abastecer tanque', error)
}

/** Desfaz um abastecimento digitado errado. */
export async function apagarAbastecimento(id: string): Promise<void> {
  const { data, error } = await supabase
    .from('ordem_tanque_abastecimentos')
    .delete()
    .eq('id', id)
    .select('id')
  erro('apagar abastecimento', error)
  exigeLinha('apagar abastecimento', data)
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
 * Confirma o início. Evento + status são UMA transação no banco (RPC):
 * queda no meio não deixa evento órfão, e o unique index em
 * (ordem_id, tipo) impede 'inicio' duplicado para sempre. Os triggers
 * seguem recusando sem peso inicial ou sem o lote baixado.
 * Requer supabase/matriz-permissoes-no-banco.sql aplicado.
 */
export async function confirmarInicio(ordemId: string): Promise<void> {
  const { error } = await supabase.rpc('confirmar_inicio', { p_ordem: ordemId })
  erro('confirmar início', error)
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
 * Desiste da finalização e volta a produzir. Os pesos finais digitados são
 * DESCARTADOS pelo banco: a produção continuou, a pesagem velha não vale
 * mais — sem isso um peso obsoleto validaria o próximo Confirmar sem
 * re-pesagem. Sem este botão, um Finalizar clicado por engano só saía
 * pelo Cancelar início, que joga fora a ordem inteira.
 */
export async function voltarParaProducao(ordemId: string): Promise<void> {
  const { error } = await supabase.rpc('voltar_para_producao', { p_ordem: ordemId })
  erro('voltar para produção', error)
}

/**
 * Fecha paradas abertas, grava o evento e finaliza — uma transação só.
 * A quantidade produzida é obrigatória (decisão de 05/08/2026); o peso
 * final dos tanques deixou de ser exigido aqui — o PCP digita na tela
 * AGROTIS, e o lançamento é que cobra todos.
 */
export async function confirmarFim(ordemId: string, bagsProduzidos: number): Promise<void> {
  const { error } = await supabase.rpc('confirmar_fim', {
    p_ordem: ordemId,
    p_bags_produzidos: bagsProduzidos,
  })
  erro('confirmar finalização', error)
}

export async function registrarParada(ordemId: string, motivoId: string): Promise<void> {
  const { error } = await supabase.rpc('registrar_parada', {
    p_ordem: ordemId,
    p_motivo: motivoId,
  })
  erro('registrar parada', error)
}

export async function retomar(ordemId: string): Promise<void> {
  const { error } = await supabase.rpc('retomar_producao', { p_ordem: ordemId })
  erro('retomar produção', error)
}

/**
 * Cancelar início: o operador começou a ordem errada. Auditoria, volta do
 * status e descarte de eventos/paradas/pesos numa transação só — ou o
 * cancelamento inteiro acontece, ou nada muda.
 */
export async function cancelarInicio(ordemId: string, detalhe: string): Promise<void> {
  const { error } = await supabase.rpc('cancelar_inicio', {
    p_ordem: ordemId,
    p_detalhe: detalhe,
  })
  erro('cancelar início', error)
}
