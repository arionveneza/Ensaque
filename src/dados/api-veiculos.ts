import { supabase } from '@/lib/supabase'

/** Checklist de veículo (pré-carregamento, pós-carregamento, faturamento) e chamada de motorista. */

function erro(contexto: string, e: { message: string } | null) {
  if (e) throw new Error(`${contexto}: ${e.message}`)
}

// ================================================================
// Tipos de checklist — cadastro (leitura aqui; escrita em api-admin.ts,
// junto dos outros cadastros)
// ================================================================

export interface PerguntaChecklist {
  id: string
  texto: string
  obrigatoria: boolean
  ordem: number
}

export interface TipoChecklist {
  id: string
  nome: string
  ativo: boolean
  checklist_perguntas: PerguntaChecklist[]
}

export async function listarTiposChecklist(): Promise<TipoChecklist[]> {
  const { data, error } = await supabase
    .from('checklist_tipos')
    .select('id, nome, ativo, checklist_perguntas ( id, texto, obrigatoria, ordem )')
    .order('nome')
  erro('tipos de checklist', error)
  return ((data ?? []) as unknown as TipoChecklist[]).map((t) => ({
    ...t,
    checklist_perguntas: [...t.checklist_perguntas].sort((a, b) => a.ordem - b.ordem),
  }))
}

// ================================================================
// Fotos do checklist de veículo — bucket `veiculos`, mesma receita da
// Qualidade (upload na seleção; ver `src/componentes/SeletorFotos.tsx`)
// ================================================================

const BUCKET_FOTOS = 'veiculos'

export async function enviarFotoVeiculo(checklistId: string, dataUrl: string): Promise<string> {
  const blob = await (await fetch(dataUrl)).blob()
  // sem contador de índice: cada chamada já é uma foto por vez (upload na seleção)
  const caminho = `${checklistId}/${Date.now()}.jpg`
  const { error } = await supabase.storage
    .from(BUCKET_FOTOS)
    .upload(caminho, blob, { contentType: 'image/jpeg', upsert: false })
  if (error) throw new Error(`enviar foto: ${error.message}`)
  return caminho
}

/** O bucket é privado: a imagem só abre por link assinado, que expira. */
export async function urlFotoVeiculo(caminho: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(BUCKET_FOTOS)
    .createSignedUrl(caminho, 3600)
  if (error) return null
  return data?.signedUrl ?? null
}

/** Best-effort: falhar aqui só deixa um arquivo órfão no bucket privado. */
export async function removerFotoVeiculo(caminho: string): Promise<void> {
  await supabase.storage.from(BUCKET_FOTOS).remove([caminho])
}

// ================================================================
// Preenchimento do checklist — lançamento solto (sem vínculo com
// carregamentos importados da Expedição)
// ================================================================

export interface ItemChecklistVeiculo {
  pergunta_id: string
  ok: boolean
  observacao: string | null
}

export interface ChecklistVeiculoCompleto {
  id: string
  tipo_id: string
  placa: string
  motorista: string
  transportadora: string | null
  observacao: string | null
  fotos: string[]
  ts: string
  checklist_tipos: { nome: string }
  veiculo_checklist_itens: {
    ok: boolean
    observacao: string | null
    checklist_perguntas: { texto: string; obrigatoria: boolean }
  }[]
}

export async function listarChecklistsVeiculo(): Promise<ChecklistVeiculoCompleto[]> {
  const { data, error } = await supabase
    .from('veiculo_checklists')
    .select(
      'id, tipo_id, placa, motorista, transportadora, observacao, fotos, ts, ' +
        'checklist_tipos ( nome ), ' +
        'veiculo_checklist_itens ( ok, observacao, checklist_perguntas ( texto, obrigatoria ) )',
    )
    .order('ts', { ascending: false })
  erro('checklists de veículo', error)
  return (data ?? []) as unknown as ChecklistVeiculoCompleto[]
}

/**
 * Chama a RPC `salvar_checklist_veiculo` — upsert idempotente por `id`
 * (gerado no cliente, ver `Veiculos.tsx`) + validação das perguntas
 * obrigatórias no servidor.
 */
export async function salvarChecklistVeiculo(
  id: string,
  tipoId: string,
  placa: string,
  motorista: string,
  transportadora: string | null,
  observacao: string | null,
  fotos: string[],
  itens: ItemChecklistVeiculo[],
): Promise<void> {
  const { error } = await supabase.rpc('salvar_checklist_veiculo', {
    p_id: id,
    p_tipo_id: tipoId,
    p_placa: placa,
    p_motorista: motorista,
    p_transportadora: transportadora,
    p_observacao: observacao,
    p_fotos: fotos,
    p_itens: itens,
  })
  erro('salvar checklist de veículo', error)
}

// ================================================================
// Chamada de motorista — log simples pro Painel de Chamada
// ================================================================

export interface ChamadaMotorista {
  id: string
  placa: string
  motorista: string
  motivo: string
  observacao: string | null
  chamado_em: string
}

export async function listarChamadas(limite = 20): Promise<ChamadaMotorista[]> {
  const { data, error } = await supabase
    .from('chamadas_motorista')
    .select('id, placa, motorista, motivo, observacao, chamado_em')
    .order('chamado_em', { ascending: false })
    .limit(limite)
  erro('chamadas de motorista', error)
  return (data ?? []) as ChamadaMotorista[]
}

export async function chamarMotorista(
  placa: string,
  motorista: string,
  motivo: string,
  observacao: string | null,
  chamadoPor: string,
): Promise<void> {
  if (!placa.trim()) throw new Error('Informe a placa do veículo.')
  if (!motorista.trim()) throw new Error('Informe o motorista.')
  if (!motivo.trim()) throw new Error('Informe o motivo da chamada.')
  const { error } = await supabase.from('chamadas_motorista').insert({
    placa: placa.trim().toUpperCase(),
    motorista: motorista.trim(),
    motivo: motivo.trim(),
    observacao: observacao?.trim() || null,
    chamado_por: chamadoPor,
  })
  erro('chamar motorista', error)
}
