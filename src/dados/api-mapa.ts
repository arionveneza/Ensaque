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
import { SEM_TSI, type EnriquecimentoTratado, type LoteMapaConvertido } from '@/dominio/importacao/mapa'

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
  // bags > 0: carga CARREGADA zera o lote no mapa (gatilho) — a linha fica
  // no banco pro desfazer devolver, mas some da tela
  const { data, error } = await supabase
    .from('lotes_mapa')
    .select(
      'lote, tratamento, cultivar, embalagem, pms, peso_bag_kg, bags, destinacao, classificacao, peneira, categoria, lote_enderecos ( id, armazem, bloco, quadra, bags )',
    )
    .gt('bags', 0)
    .order('cultivar')
  if (error) return null
  return (data ?? []) as unknown as LoteMapaLinha[]
}

/**
 * Upload do SAP no modelo alimentado pela produção (30/08/2026):
 * - semente BRANCA segue com substituição total (upsert + delete do que não
 *   veio — combinação que zerou no SAP some; endereços de quem continua
 *   sobrevivem pelo upsert);
 * - lote TRATADO não é criado nem apagado pelo upload (quem cria é a ordem
 *   de produção em "Qualidade apontada"; quem baixa é a carga CARREGADA) —
 *   o upload só ENRIQUECE destinação/classe pela RPC, casando número base
 *   + tratamento.
 */
export async function importarLotesMapa(
  brancos: LoteMapaConvertido[],
  enriquecimentos: EnriquecimentoTratado[],
): Promise<{ gravados: number; enriquecidos: number }> {
  const agora = new Date().toISOString()
  const registros = brancos.map((l) => ({ ...l, atualizado_em: agora }))
  for (let i = 0; i < registros.length; i += 500) {
    const { error } = await supabase.from('lotes_mapa').upsert(registros.slice(i, i + 500))
    if (error) {
      throw new Error(
        `gravar lotes do mapa: ${error.message} — a migração mapa-lote-tratamento.sql já rodou?`,
      )
    }
  }
  // branca que não veio nesta carga não existe mais no SAP → sai do mapa
  const del = await supabase
    .from('lotes_mapa')
    .delete()
    .eq('tratamento', SEM_TSI)
    .lt('atualizado_em', agora)
  erro('remover lotes brancos que sumiram do SAP', del.error)

  const rpc = await supabase.rpc('enriquecer_tratados', { p_itens: enriquecimentos })
  if (rpc.error) {
    throw new Error(
      `carimbar destinação dos tratados: ${rpc.error.message} — a migração mapa-alimentado-pela-producao.sql já rodou?`,
    )
  }
  return { gravados: registros.length, enriquecidos: (rpc.data as number) ?? 0 }
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
  /** Tipo de veículo (id de VEICULOS_CARGA) — desenha o croqui (29/08/2026). */
  veiculo: string | null
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
  /** Caminhão saiu — a carga não desconta mais o saldo dos lotes. */
  carregada_em: string | null
  /** Ciclo encerrado (depois de carregada). */
  finalizada_em: string | null
  /** Caminhos no bucket `cargas` — foto da carga pronta e da placa. */
  fotos: string[]
  carga_montada_produtos: ProdutoCargaLinha[]
}

// ================================================================
// Fotos da carga/placa — bucket `cargas`, mesma receita da Qualidade
// (upload na seleção; ver `src/componentes/SeletorFotos.tsx`)
// ================================================================

const BUCKET_FOTOS = 'cargas'

export async function enviarFotoCarga(cargaId: string, dataUrl: string): Promise<string> {
  const blob = await (await fetch(dataUrl)).blob()
  const caminho = `${cargaId}/${Date.now()}.jpg`
  const { error } = await supabase.storage
    .from(BUCKET_FOTOS)
    .upload(caminho, blob, { contentType: 'image/jpeg', upsert: false })
  if (error) {
    throw new Error(`enviar foto: ${error.message} — a migração carga-fotos.sql já rodou?`)
  }
  return caminho
}

/** O bucket é privado: a imagem só abre por link assinado, que expira. */
export async function urlFotoCarga(caminho: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(BUCKET_FOTOS)
    .createSignedUrl(caminho, 3600)
  if (error) return null
  return data?.signedUrl ?? null
}

/** Best-effort: falhar aqui só deixa um arquivo órfão no bucket privado. */
export async function removerFotoCarga(caminho: string): Promise<void> {
  await supabase.storage.from(BUCKET_FOTOS).remove([caminho])
}

/** Grava a lista de caminhos na carga (a RPC de salvar não toca em fotos). */
export async function salvarFotosCarga(id: string, fotos: string[]): Promise<void> {
  const { error } = await supabase.from('cargas_montadas').update({ fotos }).eq('id', id)
  erro('gravar fotos da carga — a migração carga-fotos.sql já rodou?', error)
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
  // carga CARREGADA não desconta mais: o caminhão saiu e o próximo upload
  // do SAP já reflete a saída — contar de novo dobrava (29/08/2026)
  let r = await supabase
    .from('carga_montada_produtos')
    .select('carga_id, tratamento, carga_montada_itens ( lote_id, bags ), cargas_montadas!inner ( carregada_em )')
    .is('cargas_montadas.carregada_em', null)
  if (r.error) {
    // antes da migração carga-carregada-finalizada.sql a coluna não existe
    r = (await supabase
      .from('carga_montada_produtos')
      .select('carga_id, tratamento, carga_montada_itens ( lote_id, bags )')) as unknown as typeof r
  }
  if (r.error) return []
  const linhas = (r.data ?? []) as unknown as {
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

/**
 * Marcos do ciclo da carga (29/08/2026): CARREGADA quando o caminhão sai
 * (sai da conta de saldo dos lotes) e FINALIZADA encerrando o ciclo.
 * Ambos com data e autor, e desfazíveis (misclick no chão de fábrica).
 */
export type MarcoCarga = 'carregada' | 'finalizada'

export async function marcarCargaMontada(
  id: string,
  marco: MarcoCarga,
  usuarioId: string | null,
): Promise<void> {
  const campos =
    marco === 'carregada'
      ? { carregada_em: new Date().toISOString(), carregada_por: usuarioId }
      : { finalizada_em: new Date().toISOString(), finalizada_por: usuarioId }
  const { error } = await supabase.from('cargas_montadas').update(campos).eq('id', id)
  erro(
    `marcar carga como ${marco} — a migração carga-carregada-finalizada.sql já rodou?`,
    error,
  )
}

export async function desmarcarCargaMontada(id: string, marco: MarcoCarga): Promise<void> {
  const campos =
    marco === 'carregada'
      ? { carregada_em: null, carregada_por: null }
      : { finalizada_em: null, finalizada_por: null }
  const { error } = await supabase.from('cargas_montadas').update(campos).eq('id', id)
  erro(`desfazer ${marco}`, error)
}

/** Peso de semente já comprometido por ordens de PRODUÇÃO, por lote. */
export interface ConsumoOrdens {
  /** lotes_semente.id = o próprio nº do lote (bate com lotes_mapa.lote). */
  lote_id: string
  peso_kg: number
}

/**
 * Ordens de produção abertas consomem semente branca que o mapa ainda
 * mostra. O loteamento desconta isso do disponível (pedido do Arion,
 * 29/08/2026). A régua vai até a ordem virar "Qualidade apontada": desse
 * ponto em diante o PRÓPRIO MAPA já foi debitado pelo gatilho
 * (mapa-consumo-branca.sql, 30/08/2026) — contar de novo dobraria.
 * peso_kg vem da v_ordens (bags × peso do bag DA ORDEM); a conversão pra
 * bags DO LOTE é no front, dividindo pelo peso_bag_kg do lote no mapa.
 */
export async function listarConsumoOrdens(): Promise<ConsumoOrdens[]> {
  const { data, error } = await supabase
    .from('v_ordens')
    .select('lote_id, peso_kg, status')
    .not('status', 'in', '("Qualidade apontada","Apontada","Excluida")')
  if (error) return []
  const porLote = new Map<string, number>()
  for (const o of (data ?? []) as { lote_id: string | null; peso_kg: number | null }[]) {
    if (!o.lote_id) continue
    porLote.set(o.lote_id, (porLote.get(o.lote_id) ?? 0) + (o.peso_kg ?? 0))
  }
  return [...porLote.entries()].map(([lote_id, peso_kg]) => ({ lote_id, peso_kg }))
}

const SELECT_PRODUTOS_CARGA =
  'carga_montada_produtos ( id, cultivar, tratamento, bags_solicitados, carga_montada_itens ( lote_id, bags, peso_kg, destinacao ) )'

export async function listarCargasMontadas(limite = 20): Promise<CargaMontadaLinha[]> {
  // itens penduram no PRODUTO (produto_id) — o embed aninhado usa essa FK
  let r = await supabase
    .from('cargas_montadas')
    .select(
      `id, numero, placa, cliente, tara_kg, peso_total_kg, veiculo, criada_em, carregada_em, finalizada_em, fotos, ${SELECT_PRODUTOS_CARGA}`,
    )
    .order('criada_em', { ascending: false })
    .limit(limite)
  if (r.error?.code === '42703') {
    // janela pré-migração (carga-veiculo.sql / carga-carregada-finalizada.sql)
    r = (await supabase
      .from('cargas_montadas')
      .select(`id, numero, placa, cliente, tara_kg, peso_total_kg, criada_em, ${SELECT_PRODUTOS_CARGA}`)
      .order('criada_em', { ascending: false })
      .limit(limite)) as unknown as typeof r
  }
  if (r.error) {
    // só a janela pré-migração vira lista vazia (tabela/relacionamento ainda
    // não existem); o resto é erro de verdade e a tela mostra — devolver []
    // pra queda de rede fazia a Balança ver "nenhuma carga" e remontar uma
    // carga que já existia (achado da revisão de 28/08/2026)
    if (['42P01', 'PGRST200', 'PGRST205'].includes(r.error.code ?? '')) return []
    erro('listar cargas montadas', r.error)
  }
  return (r.data ?? []).map((c) => ({
    carregada_em: null,
    finalizada_em: null,
    veiculo: null,
    fotos: [],
    ...(c as object),
  })) as unknown as CargaMontadaLinha[]
}
