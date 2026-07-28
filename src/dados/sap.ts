import { supabase } from '@/lib/supabase'

/**
 * SAP Business One através da Edge Function `sap`.
 *
 * O navegador nunca fala com o Service Layer: as credenciais ficam nos
 * secrets da função. Aqui só existem as ações que ela aceita.
 *
 * Consultas salvas: o SQL fica em `tsi.consultas_sap`, é enviado ao Service
 * Layer com "Registrar" e executado por código com "Executar".
 */

export interface SementeSap {
  itemCode: string
  nome: string
  estoque: number
  grupo: number | null
}

export interface LoteSap {
  numero: string
  itemCode: string
  quantidade: number
  validade: string | null
  fabricacao: string | null
}

/** Onde a consulta nasceu — muda quem é responsável por colocá-la no SAP. */
export type OrigemConsulta = 'app' | 'sap'

export interface ConsultaSap {
  id: string
  codigo: string
  nome: string
  descricao: string | null
  sql: string
  /** null = nunca registrada, ou o SQL mudou depois do último registro. */
  registrada_em: string | null
  /** 'sap' = criada no cliente B1; o app só executa. */
  origem: OrigemConsulta
  ativa: boolean
  atualizada_em: string
}

/** Linha genérica: as colunas variam conforme o SQL de cada consulta. */
export type LinhaResultado = Record<string, unknown>

interface Resposta<T> {
  dados?: T
  erro?: string
  permitidas?: string[]
}

async function chamar<T>(corpo: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<Resposta<T>>('sap', { body: corpo })

  if (error) {
    const detalhe = await extraiMensagem(error)
    throw new Error(detalhe ?? `Falha ao chamar o SAP: ${error.message}`)
  }
  if (!data) throw new Error('O SAP não devolveu resposta.')
  if (data.erro) throw new Error(data.erro)
  if (data.dados === undefined) throw new Error('Resposta do SAP sem dados.')
  return data.dados
}

/** FunctionsHttpError carrega a resposta original; sem isso o erro vira "non-2xx". */
async function extraiMensagem(error: unknown): Promise<string | null> {
  const contexto = (error as { context?: Response }).context
  if (!contexto || typeof contexto.json !== 'function') return null
  try {
    const corpo = (await contexto.json()) as { erro?: string }
    return corpo?.erro ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------
// Ações no SAP
// ---------------------------------------------------------------

export const pingSap = () => chamar<{ sap: string; base: string }>({ acao: 'ping' })

export const sementesComEstoque = () => chamar<SementeSap[]>({ acao: 'sementesComEstoque' })

export const lotesDoItem = (itemCode: string) =>
  chamar<LoteSap[]>({ acao: 'lotesDoItem', itemCode })

/**
 * Pedidos em aberto pelo OData, sem consulta SQL.
 *
 * Usa a mesma natureza de permissão que já funciona para os itens —
 * autorização de módulo, não a do Query Manager, que é de administrador.
 */
export const pedidosAbertos = () => chamar<LinhaResultado[]>({ acao: 'pedidosAbertos' })

/** Executa uma consulta já registrada no Service Layer. */
export const executarConsulta = (codigo: string) =>
  chamar<LinhaResultado[]>({ acao: 'executarConsulta', codigo })

/** Envia o SQL ao SAP. Cria se não existir, sobrescreve se existir. Só Gestor. */
export const registrarConsulta = (codigo: string) =>
  chamar<{ codigo: string; atualizou: boolean }>({ acao: 'registrarConsulta', codigo })

/** Apaga a consulta do SAP. O cadastro no Supabase continua. Só Gestor. */
export const removerConsultaDoSap = (codigo: string) =>
  chamar<{ codigo: string; removida: boolean }>({ acao: 'removerConsulta', codigo })

/** O que está registrado no SAP hoje, independente do nosso cadastro. */
export const consultasNoSap = () =>
  chamar<{ SqlCode: string; SqlName: string }[]>({ acao: 'consultasNoSap' })

// ---------------------------------------------------------------
// Cadastro das consultas (tabela do Supabase, não do SAP)
// ---------------------------------------------------------------

export async function listarConsultas(): Promise<ConsultaSap[]> {
  const { data, error } = await supabase
    .from('consultas_sap')
    .select('id, codigo, nome, descricao, sql, registrada_em, origem, ativa, atualizada_em')
    .order('codigo')
  if (error) throw new Error(`consultas: ${error.message}`)
  return (data ?? []) as ConsultaSap[]
}

export interface NovaConsulta {
  codigo: string
  nome: string
  descricao?: string | null
  sql: string
  origem: OrigemConsulta
}

export async function salvarConsulta(c: NovaConsulta, id?: string): Promise<void> {
  const registro = {
    codigo: c.codigo.trim().toUpperCase(),
    nome: c.nome.trim(),
    descricao: c.descricao?.trim() || null,
    sql: c.sql.trim(),
    origem: c.origem,
  }
  const { error } = id
    ? await supabase.from('consultas_sap').update(registro).eq('id', id)
    : await supabase.from('consultas_sap').insert(registro)

  if (error) {
    if (error.code === '23505') throw new Error(`Já existe consulta com o código ${registro.codigo}.`)
    if (error.code === '23514') {
      throw new Error(
        'Código inválido: use letras maiúsculas, números e underscore, começando por letra (3 a 30 caracteres).',
      )
    }
    throw new Error(`salvar consulta: ${error.message}`)
  }
}

export async function excluirConsulta(id: string): Promise<void> {
  const { error } = await supabase.from('consultas_sap').delete().eq('id', id)
  if (error) throw new Error(`excluir consulta: ${error.message}`)
}
