import { supabase } from '@/lib/supabase'
import { TOL_LEGAL_PADRAO, TOL_ORDEM_PADRAO, normalizarPlaca } from '@/dominio/pesagem'

/**
 * Pesagem — checklist de carregamento (14/09/2026). Tabelas `tipos_veiculo`,
 * `parametros_pesagem` e `pesagens` (migração `pesagem.sql`). A tela lê a
 * TABELA base (realtime não emite evento de view) e calcula os derivados pelo
 * domínio; a view `v_pesagens` fica para relatórios.
 */

function erro(contexto: string, e: { message: string } | null) {
  if (e) throw new Error(`${contexto}: ${e.message}`)
}

/** Tabela ainda não existe (migração não rodou) — só isso vira "vazio", o resto é erro de verdade. */
const tabelaAusente = (e: { code?: string }) => e.code === '42P01' || e.code === 'PGRST205'

// ================================================================
// Tipos de veículo
// ================================================================

export interface TipoVeiculo {
  id: string
  nome: string
  pbt_max_kg: number
  ativo: boolean
}

export async function listarTiposVeiculo(): Promise<TipoVeiculo[]> {
  const { data, error } = await supabase
    .from('tipos_veiculo')
    .select('id, nome, pbt_max_kg, ativo')
    .order('nome')
  erro('tipos de veículo', error)
  return (data ?? []) as TipoVeiculo[]
}

export async function salvarTipoVeiculo(t: {
  id?: string
  nome: string
  pbt_max_kg: number
  ativo: boolean
}): Promise<void> {
  const { error } = t.id
    ? await supabase.from('tipos_veiculo').update({ nome: t.nome, pbt_max_kg: t.pbt_max_kg, ativo: t.ativo }).eq('id', t.id)
    : await supabase.from('tipos_veiculo').insert({ nome: t.nome, pbt_max_kg: t.pbt_max_kg, ativo: t.ativo })
  erro('salvar tipo de veículo', error)
}

// ================================================================
// Parâmetros (linha única)
// ================================================================

export interface ParametrosPesagemLinha {
  tolerancia_legal_pct: number
  tolerancia_ordem_pct: number
  atualizado_em: string | null
  /** Falso quando a linha não existe (migração não rodou): a tela avisa e usa o padrão. */
  existe: boolean
}

export async function lerParametros(): Promise<ParametrosPesagemLinha> {
  const { data, error } = await supabase
    .from('parametros_pesagem')
    .select('tolerancia_legal_pct, tolerancia_ordem_pct, atualizado_em')
    .eq('id', 1)
    .maybeSingle()
  if (error && !tabelaAusente(error)) erro('parâmetros de pesagem', error)
  if (!data) {
    return {
      tolerancia_legal_pct: TOL_LEGAL_PADRAO,
      tolerancia_ordem_pct: TOL_ORDEM_PADRAO,
      atualizado_em: null,
      existe: false,
    }
  }
  const d = data as { tolerancia_legal_pct: number; tolerancia_ordem_pct: number; atualizado_em: string }
  return {
    tolerancia_legal_pct: Number(d.tolerancia_legal_pct),
    tolerancia_ordem_pct: Number(d.tolerancia_ordem_pct),
    atualizado_em: d.atualizado_em,
    existe: true,
  }
}

export async function salvarParametros(
  p: { tolerancia_legal_pct: number; tolerancia_ordem_pct: number },
  usuarioId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from('parametros_pesagem')
    .update({ ...p, atualizado_em: new Date().toISOString(), atualizado_por: usuarioId })
    .eq('id', 1)
    .select('id')
  erro('salvar parâmetros de pesagem', error)
  if (!data || data.length === 0) throw new Error('Parâmetros de pesagem: nada gravado — sem permissão ou a migração pesagem.sql não rodou.')
}

// ================================================================
// Pesagens
// ================================================================

export interface PesagemLinha {
  id: string
  data: string
  numero_ordem: string
  placa: string
  tipo_veiculo_id: string
  peso_tara_kg: number
  peso_ordem_kg: number
  pbt_max_kg_aplicado: number
  peso_bruto_final_kg: number | null
  tol_legal_pct_aplicada: number | null
  tol_ordem_pct_aplicada: number | null
  pesado_em: string | null
  pesado_por: string | null
  excesso_autorizado_em: string | null
  excesso_autorizado_por: string | null
  corrigido_em: string | null
  corrigido_por: string | null
  observacoes: string | null
  criado_em: string
  criado_por: string | null
  atualizado_em: string
  versao: number
}

const SELECT_PESAGEM =
  'id, data, numero_ordem, placa, tipo_veiculo_id, peso_tara_kg, peso_ordem_kg, pbt_max_kg_aplicado, ' +
  'peso_bruto_final_kg, tol_legal_pct_aplicada, tol_ordem_pct_aplicada, pesado_em, pesado_por, ' +
  'excesso_autorizado_em, excesso_autorizado_por, corrigido_em, corrigido_por, observacoes, ' +
  'criado_em, criado_por, atualizado_em, versao'

/** numeric vem como string do PostgREST: normaliza as tolerâncias congeladas. */
function normalizaLinha(l: PesagemLinha): PesagemLinha {
  return {
    ...l,
    tol_legal_pct_aplicada: l.tol_legal_pct_aplicada == null ? null : Number(l.tol_legal_pct_aplicada),
    tol_ordem_pct_aplicada: l.tol_ordem_pct_aplicada == null ? null : Number(l.tol_ordem_pct_aplicada),
  }
}

export interface FiltroPesagens {
  de: string
  ate: string
}

export async function listarPesagens(f: FiltroPesagens): Promise<PesagemLinha[]> {
  const { data, error } = await supabase
    .from('pesagens')
    .select(SELECT_PESAGEM)
    .gte('data', f.de)
    .lte('data', f.ate)
    .order('data', { ascending: false })
    .order('criado_em', { ascending: false })
  if (error) {
    if (tabelaAusente(error)) return []
    erro('pesagens', error)
  }
  return ((data ?? []) as unknown as PesagemLinha[]).map(normalizaLinha)
}

export interface Etapa1 {
  data: string
  numero_ordem: string
  placa: string
  tipo_veiculo_id: string
  peso_tara_kg: number
  peso_ordem_kg: number
}

export async function criarPesagem(e: Etapa1, usuarioId: string): Promise<PesagemLinha> {
  const { data, error } = await supabase
    .from('pesagens')
    .insert({ ...e, placa: normalizarPlaca(e.placa), criado_por: usuarioId })
    .select(SELECT_PESAGEM)
    .single()
  if (error?.code === '23505') {
    throw new Error(
      `Já existe um carregamento em aberto da ordem ${e.numero_ordem.trim()} com a placa ${normalizarPlaca(e.placa)} — outro operador registrou. Pese aquele em vez de criar outro.`,
    )
  }
  erro('registrar carregamento', error)
  return normalizaLinha(data as unknown as PesagemLinha)
}

/**
 * Concorrência otimista: o update só casa se a `versao` for a que a tela leu.
 * Zero linhas = outro operador mexeu no registro entre a abertura do modal e
 * o Salvar — a tela recarrega e mostra o aviso. Nunca mandamos `versao`,
 * `pbt_max_kg_aplicado`, `pesado_*` etc. no payload: o gatilho cuida deles.
 */
async function atualizarComVersao(
  id: string,
  versao: number,
  campos: Record<string, unknown>,
  contexto: string,
): Promise<PesagemLinha> {
  const { data, error } = await supabase
    .from('pesagens')
    .update(campos)
    .eq('id', id)
    .eq('versao', versao)
    .select(SELECT_PESAGEM)
    .maybeSingle()
  erro(contexto, error)
  if (!data) {
    throw new Error(
      `${contexto}: este registro foi alterado por outro operador (ou você não tem permissão). A lista foi atualizada — confira e tente de novo.`,
    )
  }
  return normalizaLinha(data as unknown as PesagemLinha)
}

export const editarEtapa1 = (id: string, versao: number, e: Etapa1) =>
  atualizarComVersao(id, versao, { ...e, placa: normalizarPlaca(e.placa) }, 'ajustar carregamento')

export const registrarPesoFinal = (
  id: string,
  versao: number,
  d: { peso_bruto_final_kg: number; observacoes: string | null },
) => atualizarComVersao(id, versao, d, 'registrar pesagem final')

/** Só administrador (o gatilho recusa sem `pesagem/administrar`). */
export const corrigirPesoFinal = (
  id: string,
  versao: number,
  d: { peso_bruto_final_kg: number; observacoes: string | null },
) => atualizarComVersao(id, versao, d, 'corrigir pesagem')

/** Nomes de quem criou/pesou/autorizou/corrigiu — resolvidos no cliente. */
export async function mapaNomesUsuarios(): Promise<Map<string, string>> {
  const { data, error } = await supabase.from('usuarios').select('id, nome')
  erro('usuários', error)
  return new Map(((data ?? []) as { id: string; nome: string }[]).map((u) => [u.id, u.nome]))
}
