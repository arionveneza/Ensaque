import { supabase } from '@/lib/supabase'
import type { Perfil, TipoParada, UnidadeDose } from '@/dominio/tipos'

/**
 * Edição de cadastros e administração de perfis.
 *
 * Só PCP/Gestor chegam aqui pelo RLS; a interface espelha isso, mas quem
 * garante é o banco.
 */

function erro(contexto: string, e: { message: string; code?: string } | null) {
  if (!e) return
  if (e.code === '23503') {
    throw new Error(
      `${contexto}: o registro está em uso por ordens ou receitas e não pode ser removido. ` +
        'Desative-o em vez de excluir.',
    )
  }
  if (e.code === '23505') throw new Error(`${contexto}: já existe um registro com esse código.`)
  if (e.code === '23514') {
    throw new Error(
      `${contexto}: valor inválido. Produto em ml/kg exige densidade; tanque vai de 1 a 5.`,
    )
  }
  throw new Error(`${contexto}: ${e.message}`)
}

// ---------------- máquinas ----------------

export async function salvarMaquina(m: {
  id: string
  nome: string
  capacidade_th: number
  qtd_tanques: number
  ativa?: boolean
}): Promise<void> {
  const { error } = await supabase.from('maquinas').upsert(m, { onConflict: 'id' })
  erro('salvar máquina', error)
}

// ---------------- turnos ----------------

export async function salvarTurno(t: {
  id: number
  nome: string
  inicio: string
  fim: string
  horas: number
}): Promise<void> {
  const { error } = await supabase.from('turnos').upsert(t, { onConflict: 'id' })
  erro('salvar turno', error)
}

// ---------------- embalagens ----------------

export async function salvarEmbalagem(e: {
  codigo: string
  codigo_ext: string | null
  descricao: string
  sementes: number
  fator_peso: number
}): Promise<void> {
  const { error } = await supabase.from('embalagens').upsert(e, { onConflict: 'codigo' })
  erro('salvar embalagem', error)
}

// ---------------- produtos químicos ----------------

export interface ProdutoEdicao {
  id?: string
  codigo: string
  nome: string
  unidade: UnidadeDose
  densidade: number | null
  ativo?: boolean
}

export async function salvarProduto(p: ProdutoEdicao): Promise<void> {
  const emMl = p.unidade.startsWith('ml')
  if (emMl && (p.densidade == null || p.densidade <= 0)) {
    throw new Error(
      `${p.nome}: produto dosado em ${p.unidade} exige densidade. Sem ela o peso de balança fica errado — ` +
        'consulte a FISPQ do fabricante.',
    )
  }
  const registro = {
    ...(p.id ? { id: p.id } : {}),
    codigo: p.codigo.trim().toUpperCase(),
    nome: p.nome.trim(),
    unidade: p.unidade,
    // dose em gramas já é peso: densidade não se aplica
    densidade: emMl ? p.densidade : null,
    ativo: p.ativo ?? true,
  }
  const { error } = p.id
    ? await supabase.from('produtos_quimicos').update(registro).eq('id', p.id)
    : await supabase.from('produtos_quimicos').insert(registro)
  erro('salvar produto químico', error)
}

export async function excluirProduto(id: string): Promise<void> {
  const { error } = await supabase.from('produtos_quimicos').delete().eq('id', id)
  erro('excluir produto', error)
}

// ---------------- receitas ----------------

export interface ItemReceitaEdicao {
  produto_id: string
  dose: number
  tanque: number
}

export async function salvarReceita(
  nome: string,
  itens: ItemReceitaEdicao[],
  receitaId?: string,
): Promise<string> {
  if (!nome.trim()) throw new Error('A receita precisa de um nome — use o código do comercial.')
  if (itens.length === 0) throw new Error('A receita precisa de ao menos um produto.')
  const tanques = new Set(itens.map((i) => i.tanque))
  if ([...tanques].some((t) => t < 1 || t > 5)) {
    throw new Error('Só existem 5 tanques: os produtos precisam ficar entre T1 e T5.')
  }
  if (itens.some((i) => !(i.dose > 0))) {
    throw new Error('Toda dose precisa ser maior que zero.')
  }
  const duplicados = itens.length !== new Set(itens.map((i) => i.produto_id)).size
  if (duplicados) throw new Error('O mesmo produto aparece duas vezes na receita.')

  let id = receitaId
  if (id) {
    const up = await supabase.from('receitas').update({ nome: nome.trim() }).eq('id', id)
    erro('salvar receita', up.error)
    const del = await supabase.from('receita_itens').delete().eq('receita_id', id)
    erro('limpar itens da receita', del.error)
  } else {
    const ins = await supabase
      .from('receitas')
      .insert({ nome: nome.trim() })
      .select('id')
      .single()
    erro('criar receita', ins.error)
    id = (ins.data as { id: string }).id
  }

  const itensIns = await supabase
    .from('receita_itens')
    .insert(itens.map((i) => ({ receita_id: id, ...i })))
  erro('gravar itens da receita', itensIns.error)
  return id!
}

export async function excluirReceita(id: string): Promise<void> {
  const { error } = await supabase.from('receitas').delete().eq('id', id)
  erro('excluir receita', error)
}

// ---------------- motivos de parada ----------------

export async function salvarMotivo(m: {
  id?: string
  descricao: string
  tipo: TipoParada
  ativo?: boolean
}): Promise<void> {
  const registro = { descricao: m.descricao.trim(), tipo: m.tipo, ativo: m.ativo ?? true }
  const { error } = m.id
    ? await supabase.from('motivos_parada').update(registro).eq('id', m.id)
    : await supabase.from('motivos_parada').insert(registro)
  erro('salvar motivo de parada', error)
}

export async function excluirMotivo(id: string): Promise<void> {
  const { error } = await supabase.from('motivos_parada').delete().eq('id', id)
  erro('excluir motivo', error)
}

// ---------------- lotes de semente ----------------

/**
 * Só apaga lote que nenhuma ordem e nenhum movimento referenciam. O banco
 * recusa o resto — e deve recusar: apagar quebraria o histórico da ordem.
 */
export async function excluirLoteSemente(id: string): Promise<void> {
  const { error } = await supabase.from('lotes_semente').delete().eq('id', id)
  if (error?.code === '23503') {
    throw new Error(
      `O lote ${id} está em uso por alguma ordem ou já tem baixa registrada, então não pode ` +
        'ser excluído — apagá-lo quebraria o histórico. Para zerar tudo de uma vez ao sair ' +
        'dos testes, use o script supabase/limpar-dados-teste.sql.',
    )
  }
  erro('excluir lote de semente', error)
}

/** Quantos lotes dá para apagar agora. */
export async function contarLotesSemUso(): Promise<number> {
  const { data, error } = await supabase.rpc('contar_lotes_sem_uso')
  erro('contar lotes sem uso', error)
  return Number(data ?? 0)
}

/** Apaga de uma vez todos os lotes sem ordem e sem movimento. */
export async function excluirLotesSemUso(): Promise<number> {
  const { data, error } = await supabase.rpc('excluir_lotes_sem_uso')
  erro('excluir lotes sem uso', error)
  return Number(data ?? 0)
}

// ---------------- usuários e permissões ----------------

export interface UsuarioLinha {
  id: string
  nome: string
  perfil: Perfil
  ativo: boolean
  criado_em: string
}

export async function listarUsuarios(): Promise<UsuarioLinha[]> {
  const { data, error } = await supabase
    .from('usuarios')
    .select('id, nome, perfil, ativo, criado_em')
    .order('nome')
  erro('usuários', error)
  return (data ?? []) as UsuarioLinha[]
}

export async function salvarUsuario(u: {
  id: string
  nome: string
  perfil: Perfil
  ativo: boolean
}): Promise<void> {
  const { error } = await supabase.from('usuarios').upsert(u, { onConflict: 'id' })
  erro('salvar usuário', error)
}

export interface PermissaoLinha {
  perfil: Perfil
  recurso: string
  acao: string
  permitido: boolean
}

export const RECURSOS = [
  'ordens', 'programacao', 'lotes', 'execucao', 'qualidade', 'indicadores', 'cadastros',
] as const

export const ACOES = [
  'ver', 'criar', 'editar', 'excluir', 'priorizar', 'baixar_lote', 'apontar', 'qualidade', 'agrotis',
] as const

export async function listarPermissoes(): Promise<PermissaoLinha[]> {
  const { data, error } = await supabase
    .from('perfil_permissoes')
    .select('perfil, recurso, acao, permitido')
  erro('permissões', error)
  return (data ?? []) as PermissaoLinha[]
}

export async function salvarPermissao(p: PermissaoLinha): Promise<void> {
  const { error } = await supabase
    .from('perfil_permissoes')
    .upsert(p, { onConflict: 'perfil,recurso,acao' })
  erro('salvar permissão', error)
}

/**
 * Apaga tudo que o gestor mexeu para um perfil. Sem linhas explícitas, o
 * perfil volta a seguir a matriz padrão da especificação.
 */
export async function restaurarPadrao(perfil: Perfil): Promise<void> {
  const { error } = await supabase
    .from('perfil_permissoes')
    .delete()
    .eq('perfil', perfil)
  erro('restaurar padrão', error)
}
