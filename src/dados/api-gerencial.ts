/**
 * Dados do relatório gerencial (07/10/2026): o carregamento do dia digitado
 * pelo PCP (tabela `relatorio_carregamento`, migração gerencial.sql) e o que o
 * planejado × executado de produção precisa ler — ordens, fim real de cada uma
 * e as mudanças de dia (`ordem_reprogramacoes`). A conta fica no domínio
 * (src/dominio/gerencial.ts).
 */

import { supabase } from '@/lib/supabase'
import {
  inicioDoDiaProducao, somaDiasIso, type CarregamentoDia, type MudancaDeDia, type OrdemPlano,
} from '@/dominio/gerencial'

const erro = (contexto: string, e: { message: string } | null) => {
  if (e) throw new Error(`${contexto}: ${e.message}`)
}

/** Janela pré-migração (tabela ausente) — a tela avisa em vez de quebrar. */
const PRE_MIGRACAO = ['42P01', 'PGRST200', 'PGRST205']

/** O PostgREST corta em 1.000 linhas em silêncio: lê todas as páginas (ordem estável). */
async function todasAsPaginas<T>(
  pagina: (de: number, ate: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  contexto: string,
): Promise<T[]> {
  const todos: T[] = []
  for (let de = 0; ; de += 1000) {
    const { data, error } = await pagina(de, de + 999)
    erro(contexto, error)
    const bloco = (data ?? []) as T[]
    todos.push(...bloco)
    if (bloco.length < 1000) break
  }
  return todos
}

// ---------------------------------------------------------------------------
// Carregamento digitado
// ---------------------------------------------------------------------------

/** null = migração gerencial.sql ainda não rodou. */
export async function listarCarregamento(de: string, ate: string): Promise<CarregamentoDia[] | null> {
  const { data, error } = await supabase
    .from('relatorio_carregamento')
    .select('dia, veiculos_carregados, bags_carregados, veiculos_descarregados, veiculos_patio, observacao')
    .gte('dia', de)
    .lte('dia', ate)
    .order('dia')
  if (error) {
    if (PRE_MIGRACAO.includes(error.code ?? '')) return null
    throw new Error(`carregamento do dia: ${error.message}`)
  }
  return ((data ?? []) as CarregamentoDia[]).map((l) => ({
    ...l,
    // numeric chega como texto do PostgREST em alguns casos
    bags_carregados: l.bags_carregados == null ? null : Number(l.bags_carregados),
  }))
}

/** Grava (ou substitui) o lançamento do dia. */
export async function salvarCarregamento(l: CarregamentoDia): Promise<void> {
  const { error } = await supabase.from('relatorio_carregamento').upsert(
    {
      dia: l.dia,
      veiculos_carregados: l.veiculos_carregados,
      bags_carregados: l.bags_carregados,
      veiculos_descarregados: l.veiculos_descarregados,
      veiculos_patio: l.veiculos_patio,
      observacao: l.observacao?.trim() || null,
    },
    { onConflict: 'dia' },
  )
  erro('gravar o carregamento do dia', error)
}

// ---------------------------------------------------------------------------
// Produção: planejado × executado
// ---------------------------------------------------------------------------

const PEDACO = 150 // ids por consulta `in (...)` — a URL tem limite

/**
 * Tudo que a conta de [de, ate] precisa: as ordens programadas no período, as
 * que SAÍRAM de um dia do período depois que ele começou (a cascata as tirou
 * dali) e as que terminaram no período — cada uma com o fim real.
 */
export async function dadosPlanejadoExecutado(
  de: string,
  ate: string,
): Promise<{ ordens: OrdemPlano[]; mudancas: MudancaDeDia[] }> {
  const inicio = inicioDoDiaProducao(de).toISOString()
  const fim = inicioDoDiaProducao(somaDiasIso(ate, 1)).toISOString()

  const [mudancas, programadas, terminadas] = await Promise.all([
    todasAsPaginas<MudancaDeDia>(
      (i, f) =>
        supabase
          .from('ordem_reprogramacoes')
          .select('ordem_id, de_dia, para_dia, ts')
          .gte('ts', inicio)
          .order('ts')
          .order('id')
          .range(i, f),
      'mudanças de dia das ordens',
    ),
    todasAsPaginas<{ id: string }>(
      (i, f) =>
        supabase
          .from('ordens')
          .select('id')
          .gte('data_prog', de)
          .lte('data_prog', ate)
          .neq('status', 'Excluida')
          .order('id')
          .range(i, f),
      'ordens do período',
    ),
    todasAsPaginas<{ ordem_id: string }>(
      (i, f) =>
        supabase
          .from('v_ordem_tempos')
          .select('ordem_id')
          .gte('fim', inicio)
          .lt('fim', fim)
          .order('ordem_id')
          .range(i, f),
      'ordens terminadas no período',
    ),
  ])

  const ids = new Set<string>([
    ...programadas.map((o) => o.id),
    ...terminadas.map((t) => t.ordem_id),
    ...mudancas.filter((m) => m.de_dia != null && m.de_dia >= de && m.de_dia <= ate).map((m) => m.ordem_id),
  ])
  const lista = [...ids]
  const ordens: OrdemPlano[] = []
  for (let i = 0; i < lista.length; i += PEDACO) {
    const pedaco = lista.slice(i, i + PEDACO)
    const [o, t] = await Promise.all([
      supabase
        .from('v_ordens')
        .select('id, data_prog, bags, bags_produzidos, peso_t, status')
        .in('id', pedaco),
      supabase.from('v_ordem_tempos').select('ordem_id, fim').in('ordem_id', pedaco),
    ])
    erro('ordens do relatório', o.error)
    erro('tempos das ordens do relatório', t.error)
    const fimDe = new Map(((t.data ?? []) as { ordem_id: string; fim: string | null }[]).map((x) => [x.ordem_id, x.fim]))
    for (const x of (o.data ?? []) as {
      id: string; data_prog: string | null; bags: number; bags_produzidos: number | null; peso_t: number; status: string
    }[]) {
      // excluída não é trabalho de ninguém (a v_ordens não emite Excluida no status_efetivo: olhar o cru)
      if (x.status === 'Excluida') continue
      ordens.push({
        id: x.id, data_prog: x.data_prog, bags: Number(x.bags),
        bags_produzidos: x.bags_produzidos == null ? null : Number(x.bags_produzidos),
        peso_t: Number(x.peso_t), fim: fimDe.get(x.id) ?? null,
      })
    }
  }
  return { ordens, mudancas: mudancas.filter((m) => ids.has(m.ordem_id)) }
}
