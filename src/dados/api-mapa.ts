/**
 * Dados da aba Mapa e Montagem de Carga (28/08/2026).
 *
 * A unidade é a COMBINAÇÃO lote + tratamento ('SEM TSI' = semente branca):
 * o mesmo lote existe branco e tratado ao mesmo tempo, em endereços
 * diferentes — o endereçamento físico do Arion provou (28/08/2026).
 *
 * `lotes_mapa` é outra vista do estoque, separada de `lotes_semente` de
 * propósito: TODO lote do SAP do depósito VEN_GER, com substituição total a
 * cada upload — o que não vem na carga é apagado (lote zerado some do
 * mapa), e os endereços (lote_enderecos) sobrevivem enquanto a combinação
 * existir, porque a gravação é upsert pela chave composta.
 */

import { supabase } from '@/lib/supabase'
import type { LoteMapaConvertido } from '@/dominio/importacao/mapa'

const erro = (contexto: string, e: { message: string } | null) => {
  if (e) throw new Error(`${contexto}: ${e.message}`)
}

export interface EnderecoLote {
  id: string
  armazem: string
  bloco: string
  /** Nem sempre é número (CORREDOR, SILO). Número maior = frente do bloco. */
  quadra: string
  /** Opcional — o endereçamento físico não controla bags por endereço. */
  bags: number | null
}

export interface LoteMapaLinha {
  lote: string
  /** 'SEM TSI' = semente branca. */
  tratamento: string
  cultivar: string
  embalagem: string
  pms: number | null
  peso_bag_kg: number
  bags: number
  destinacao: string | null
  classificacao: string | null
  peneira: string | null
  categoria: string | null
  lote_enderecos: EnderecoLote[]
}

/**
 * Todas as combinações do mapa, com endereços. Devolve null quando a tabela
 * ainda não existe no formato novo (migração mapa-lote-tratamento.sql
 * pendente) — a tela avisa em vez de quebrar.
 */
export async function listarLotesMapa(): Promise<LoteMapaLinha[] | null> {
  const { data, error } = await supabase
    .from('lotes_mapa')
    .select(
      'lote, tratamento, cultivar, embalagem, pms, peso_bag_kg, bags, destinacao, classificacao, peneira, categoria, lote_enderecos ( id, armazem, bloco, quadra, bags )',
    )
    .order('cultivar')
  if (error) return null
  return (data ?? []) as unknown as LoteMapaLinha[]
}

/**
 * Substituição total: upsert de tudo que veio (chave lote + tratamento), e
 * o que não veio é apagado (combinação que zerou no SAP some). O upsert
 * preserva os endereços das combinações que continuam; o delete em cascata
 * leva os endereços das que sumiram.
 */
export async function importarLotesMapa(lotes: LoteMapaConvertido[]): Promise<number> {
  const agora = new Date().toISOString()
  const registros = lotes.map((l) => ({ ...l, atualizado_em: agora }))
  for (let i = 0; i < registros.length; i += 500) {
    const { error } = await supabase.from('lotes_mapa').upsert(registros.slice(i, i + 500))
    if (error) {
      throw new Error(
        `gravar lotes do mapa: ${error.message} — a migração mapa-lote-tratamento.sql já rodou?`,
      )
    }
  }
  // o que não foi tocado nesta carga não existe mais no SAP → sai do mapa
  const del = await supabase.from('lotes_mapa').delete().lt('atualizado_em', agora)
  erro('remover lotes que sumiram do SAP', del.error)
  return registros.length
}

/** Substitui os endereços de UMA combinação lote + tratamento. */
export async function salvarEnderecos(
  lote: string,
  tratamento: string,
  enderecos: { armazem: string; bloco: string; quadra: string; bags: number | null }[],
  usuarioId: string,
): Promise<void> {
  const del = await supabase
    .from('lote_enderecos')
    .delete()
    .eq('lote', lote)
    .eq('tratamento', tratamento)
  erro('limpar endereços do lote', del.error)
  if (enderecos.length > 0) {
    const ins = await supabase.from('lote_enderecos').insert(
      enderecos.map((e) => ({ ...e, lote, tratamento, criado_por: usuarioId })),
    )
    erro('gravar endereços do lote', ins.error)
  }
}

export interface DestinoEndereco {
  armazem: string
  bloco: string
  quadra: string
}

/**
 * Movimenta um endereço — o lote INTEIRO daquele endereço (bagsAMover null)
 * ou uma parte (bagsAMover > 0). Regras (28/08/2026):
 *
 * - mover tudo: se o destino já tem um endereço da MESMA combinação, funde
 *   (bags somam quando ambos são conhecidos; qualquer desconhecido vira
 *   desconhecido) e apaga a origem; senão, só troca o endereço da linha.
 * - mover parcial: a origem perde X bags (se a contagem dela é conhecida;
 *   zerou, apaga a linha — se é desconhecida, continua desconhecida) e o
 *   destino ganha X (fundindo com endereço existente da combinação, mesma
 *   regra de soma).
 */
export async function moverEndereco(params: {
  origem: EnderecoLote
  lote: string
  tratamento: string
  bagsAMover: number | null
  destino: DestinoEndereco
  enderecosDaCombinacao: EnderecoLote[]
  usuarioId: string
}): Promise<void> {
  const { origem, lote, tratamento, bagsAMover, destino, enderecosDaCombinacao, usuarioId } = params
  const destinoExistente = enderecosDaCombinacao.find(
    (e) =>
      e.id !== origem.id &&
      e.armazem === destino.armazem &&
      e.bloco === destino.bloco &&
      e.quadra === destino.quadra,
  )

  const atualizar = async (id: string, campos: Record<string, unknown>) => {
    const { error } = await supabase.from('lote_enderecos').update(campos).eq('id', id)
    erro('mover endereço', error)
  }
  const apagar = async (id: string) => {
    const { error } = await supabase.from('lote_enderecos').delete().eq('id', id)
    erro('mover endereço (limpar origem)', error)
  }
  const inserir = async (campos: Record<string, unknown>) => {
    const { error } = await supabase
      .from('lote_enderecos')
      .insert({ lote, tratamento, criado_por: usuarioId, ...campos })
    erro('mover endereço (criar destino)', error)
  }

  const movendoTudo =
    bagsAMover == null || (origem.bags != null && bagsAMover >= origem.bags)

  if (movendoTudo) {
    if (destinoExistente) {
      const bags =
        destinoExistente.bags != null && origem.bags != null
          ? destinoExistente.bags + origem.bags
          : null
      await atualizar(destinoExistente.id, { bags })
      await apagar(origem.id)
    } else {
      await atualizar(origem.id, { ...destino })
    }
    return
  }

  // parcial
  if (origem.bags != null) {
    const resto = origem.bags - bagsAMover
    if (resto > 0) await atualizar(origem.id, { bags: resto })
    else await apagar(origem.id)
  }
  // origem com contagem desconhecida continua desconhecida — não inventamos número
  if (destinoExistente) {
    const bags = destinoExistente.bags != null ? destinoExistente.bags + bagsAMover : null
    await atualizar(destinoExistente.id, { bags })
  } else {
    await inserir({ ...destino, bags: bagsAMover })
  }
}

/**
 * A carga leva VÁRIOS produtos (decisão do Arion, 28/08/2026): primeiro se
 * monta a ordem de carregamento com cada produto (cultivar + tratamento +
 * bags pedidos) e depois se escolhem os lotes, produto a produto. O
 * cabeçalho não tem mais combinação única — migração carga-por-produto.sql.
 */
export interface NovaCargaMontada {
  numero: string
  peso_total_kg: number
  /** Placa/cliente/tara: saem na ordem de carregamento impressa (28/08/2026). */
  placa: string | null
  cliente: string | null
  tara_kg: number | null
}

export interface ItemCargaMontada {
  lote_id: string
  bags: number
  peso_kg: number
  /** Foto da destinação do SAP no momento — o aviso fica registrado. */
  destinacao: string | null
}

export interface ProdutoCargaMontada {
  cultivar: string
  /** 'SEM TSI' = semente branca. */
  tratamento: string
  /** Quanto foi PEDIDO — os lotes escolhidos podem ainda não cobrir tudo. */
  bags_solicitados: number
  itens: ItemCargaMontada[]
}

/**
 * Toda gravação passa pela RPC salvar_carga_montada (transacional, migração
 * carga-por-produto.sql): criar/editar em requisições separadas deixava
 * carga órfã ou apagava os lotes salvos quando uma falhava no meio (achado
 * da revisão de 28/08/2026). SECURITY INVOKER — a RLS vale pra quem chama.
 */
async function salvarViaRpc(
  id: string | null,
  carga: NovaCargaMontada,
  produtos: ProdutoCargaMontada[],
  usuarioId: string | null,
): Promise<string> {
  const { data, error } = await supabase.rpc('salvar_carga_montada', {
    p_id: id,
    p_carga: carga,
    p_produtos: produtos,
    p_usuario: usuarioId,
  })
  erro('salvar carga montada — a migração carga-por-produto.sql já rodou?', error)
  return data as string
}

export async function criarCargaMontada(
  carga: NovaCargaMontada,
  produtos: ProdutoCargaMontada[],
  usuarioId: string,
): Promise<string> {
  return salvarViaRpc(null, carga, produtos, usuarioId)
}

/** Edita uma carga salva: atualiza o cabeçalho e SUBSTITUI produtos e lotes. */
export async function atualizarCargaMontada(
  id: string,
  carga: NovaCargaMontada,
  produtos: ProdutoCargaMontada[],
): Promise<void> {
  await salvarViaRpc(id, carga, produtos, null)
}

export async function excluirCargaMontada(id: string): Promise<void> {
  const { error } = await supabase.from('cargas_montadas').delete().eq('id', id)
  erro('excluir carga montada', error)
}

export interface ProdutoCargaLinha {
  id: string
  cultivar: string
  tratamento: string
  bags_solicitados: number
  carga_montada_itens: { lote_id: string; bags: number; peso_kg: number; destinacao: string | null }[]
}

export interface CargaMontadaLinha extends NovaCargaMontada {
  id: string
  criada_em: string
  carga_montada_produtos: ProdutoCargaLinha[]
}

/** Bags de um lote já alocados numa carga salva — trava o loteamento duplo. */
export interface LoteComprometido {
  carga_id: string
  /** Tratamento do PRODUTO da carga (o item não guarda tratamento). */
  tratamento: string
  lote_id: string
  bags: number
}

/**
 * Tudo que as cargas salvas já tomaram de cada lote (29/08/2026): o mesmo
 * lote pode estar em várias cargas, e a soma não pode passar do saldo do
 * SAP. Sem limite de linhas de propósito — a lista de cargas recentes
 * corta em 20, mas o comprometimento precisa enxergar todas.
 */
export async function listarLotesComprometidos(): Promise<LoteComprometido[]> {
  const { data, error } = await supabase
    .from('carga_montada_produtos')
    .select('carga_id, tratamento, carga_montada_itens ( lote_id, bags )')
  if (error) return []
  const linhas = (data ?? []) as unknown as {
    carga_id: string
    tratamento: string
    carga_montada_itens: { lote_id: string; bags: number }[]
  }[]
  return linhas.flatMap((p) =>
    (p.carga_montada_itens ?? []).map((i) => ({
      carga_id: p.carga_id,
      tratamento: p.tratamento,
      lote_id: i.lote_id,
      bags: i.bags,
    })),
  )
}

/** Peso de semente já comprometido por ordens de PRODUÇÃO, por lote. */
export interface ConsumoOrdens {
  /** lotes_semente.id = o próprio nº do lote (bate com lotes_mapa.lote). */
  lote_id: string
  peso_kg: number
}

/**
 * Ordens de produção abertas consomem semente branca que o saldo do SAP
 * ainda mostra (mesma régua do balanço: tudo que não é Apontada — a
 * apontada já foi lançada e o próximo upload desconta). O loteamento da
 * carga precisa descontar isso do disponível (pedido do Arion, 29/08/2026).
 * peso_kg vem da v_ordens (bags × peso do bag DA ORDEM); a conversão pra
 * bags DO LOTE é no front, dividindo pelo peso_bag_kg do lote no mapa.
 */
export async function listarConsumoOrdens(): Promise<ConsumoOrdens[]> {
  const { data, error } = await supabase
    .from('v_ordens')
    .select('lote_id, peso_kg, status')
    .not('status', 'in', '("Apontada","Excluida")')
  if (error) return []
  const porLote = new Map<string, number>()
  for (const o of (data ?? []) as { lote_id: string | null; peso_kg: number | null }[]) {
    if (!o.lote_id) continue
    porLote.set(o.lote_id, (porLote.get(o.lote_id) ?? 0) + (o.peso_kg ?? 0))
  }
  return [...porLote.entries()].map(([lote_id, peso_kg]) => ({ lote_id, peso_kg }))
}

export async function listarCargasMontadas(limite = 20): Promise<CargaMontadaLinha[]> {
  // itens penduram no PRODUTO (produto_id) — o embed aninhado usa essa FK
  const r = await supabase
    .from('cargas_montadas')
    .select(
      'id, numero, placa, cliente, tara_kg, peso_total_kg, criada_em, carga_montada_produtos ( id, cultivar, tratamento, bags_solicitados, carga_montada_itens ( lote_id, bags, peso_kg, destinacao ) )',
    )
    .order('criada_em', { ascending: false })
    .limit(limite)
  if (r.error) {
    // só a janela pré-migração vira lista vazia (tabela/relacionamento ainda
    // não existem); o resto é erro de verdade e a tela mostra — devolver []
    // pra queda de rede fazia a Balança ver "nenhuma carga" e remontar uma
    // carga que já existia (achado da revisão de 28/08/2026)
    if (['42P01', 'PGRST200', 'PGRST205'].includes(r.error.code ?? '')) return []
    erro('listar cargas montadas', r.error)
  }
  return (r.data ?? []) as unknown as CargaMontadaLinha[]
}
