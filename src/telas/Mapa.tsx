import { useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from 'react'
import readXlsxFile from 'read-excel-file/browser'
import * as m from '@/dados/api-mapa'
import type {
  CargaMontadaLinha, ConsumoOrdens, EnderecoLote, LoteComprometido, LoteMapaLinha,
  ProdutoCargaLinha,
} from '@/dados/api-mapa'
import {
  converterLotesMapa, DEPOSITO_MAPA, ehRelatorioMapa, SEM_TSI, type ResultadoLotesMapa,
} from '@/dominio/importacao/mapa'
import type { Linha } from '@/dominio/importacao/simpleagro'
import { useAuth } from '@/auth/AuthProvider'
import { useRealtime } from '@/dados/useRealtime'
import { useRascunho, type Rascunho } from '@/lib/useRascunho'
import { imprimirCroquiCarga, imprimirOrdemCarregamento } from '@/lib/exportar'
import { VEICULOS_CARGA, veiculoDe } from '@/dominio/croqui'
import {
  Aviso, Botao, Cartao, Erro, Pagina, Tabela, Tag, Vazio, dataHoraCurta, inteiro, n,
} from '@/componentes/ui'

/**
 * Mapa e Montagem de Carga (28/08/2026).
 *
 * A unidade é a COMBINAÇÃO lote + tratamento ('SEM TSI' = semente branca).
 * O mapa é uma GRADE por armazém (blocos nas colunas, quadras nas linhas,
 * quadra maior no topo = frente = acesso fácil), no formato do painel que a
 * operação já usava. Clicar numa posição abre os lotes que estão ali, com
 * a Destinação do SAP (ou "livre") e as ações de mover/endereçar.
 *
 * Os bags de um lote em vários endereços são RATEADOS: contagem por
 * endereço quando existe; o que falta divide igual entre os endereços sem
 * contagem (marcado ~ estimado) — sem isso o lote inteiro aparecia somado
 * em cada lugar e o total do armazém dobrava (achado do Arion, 28/08/2026).
 */

const rotuloTratamento = (t: string) => (t === SEM_TSI ? 'SEM TSI (branca)' : t)
const chaveDe = (l: { lote: string; tratamento: string }) => `${l.lote}|${l.tratamento}`

const ehNumero = (q: string) => /^\d+$/.test(q)
/** Quadra numérica ordena da maior pra menor (frente primeiro); texto (CORREDOR, SILO) vai pro fim. */
const ordenaQuadras = (a: string, b: string): number => {
  const na = ehNumero(a) ? Number(a) : null
  const nb = ehNumero(b) ? Number(b) : null
  if (na != null && nb != null) return nb - na
  if (na != null) return -1
  if (nb != null) return 1
  return a.localeCompare(b)
}
const rotuloQuadra = (q: string) => (ehNumero(q) ? `QD${q.padStart(2, '0')}` : q)

/** "1C" → "01C", mesma casa do 01C — normalização usada no endereçamento. */
const normalizaBloco = (s: string): string => {
  const b = s.replace(/\s+/g, ' ').trim().toUpperCase()
  const m2 = b.match(/^(\d)([A-Z])$/)
  return m2 ? `0${m2[1]}${m2[2]}` : b
}

const INPUT =
  'rounded-lg border border-stone-300 px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-800'

/** Um lote alocado num endereço, com os bags RATEADOS daquele lugar. */
interface Alocacao {
  lote: LoteMapaLinha
  endereco: EnderecoLote
  bags: number
  /** true quando o rateio dividiu o total entre endereços sem contagem. */
  estimado: boolean
}

/**
 * Rateia os bags do lote entre os endereços dele: contagem explícita vale;
 * o restante divide igual entre os endereços sem contagem. Um lote em 2
 * barracões aparece com a parte de cada um — nunca o total nos dois.
 */
function alocar(lotes: LoteMapaLinha[]): Alocacao[] {
  const out: Alocacao[] = []
  for (const l of lotes) {
    const es = l.lote_enderecos
    if (es.length === 0) continue
    const somaConhecida = es.reduce((s, e) => s + (e.bags ?? 0), 0)
    const desconhecidos = es.filter((e) => e.bags == null)
    const restante = Math.max(0, l.bags - somaConhecida)
    const porDesconhecido = desconhecidos.length > 0 ? restante / desconhecidos.length : 0
    for (const e of es) {
      if (e.bags != null) out.push({ lote: l, endereco: e, bags: e.bags, estimado: false })
      else out.push({ lote: l, endereco: e, bags: porDesconhecido, estimado: desconhecidos.length > 1 })
    }
  }
  return out
}

interface ItemCargaForm {
  loteId: string
  bags: string
}

/** Um produto da carga em montagem: a combinação pedida e os lotes escolhidos. */
interface ProdutoCargaForm {
  /** Chave estável de React — o produto não tem id antes de salvar. */
  chave: string
  cultivar: string
  tratamento: string
  bags: string
  itens: ItemCargaForm[]
}

/** Rascunho da MONTAGEM (1ª etapa) — editandoId preenchido = editando carga salva. */
interface CargaForm {
  numero: string
  placa: string
  cliente: string
  tara: string
  /** Tipo de veículo (id de VEICULOS_CARGA) — desenha o croqui. */
  veiculo: string
  produtos: ProdutoCargaForm[]
  editandoId: string
}

const CARGA_VAZIA: CargaForm = {
  numero: '', placa: '', cliente: '', tara: '', veiculo: '', produtos: [], editandoId: '',
}

/**
 * Rascunho do LOTEAMENTO (2ª etapa, 29/08/2026) — etapa separada, com o
 * próprio Salvar: a montagem grava a carga "aguardando lotear" e o Lotear
 * abre a carga salva pra escolher os lotes. cargaId vazio = nada aberto.
 */
interface LotearForm {
  cargaId: string
  produtos: ProdutoCargaForm[]
}

const LOTEAR_VAZIO: LotearForm = { cargaId: '', produtos: [] }

const novaChave = (): string =>
  globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)

const produtoVazio = (): ProdutoCargaForm => ({
  chave: novaChave(), cultivar: '', tratamento: '', bags: '', itens: [],
})

/**
 * Migra o rascunho da carga do formato antigo (uma combinação no topo, no ar
 * em 28/08/2026) pro novo (produtos[]): sem isso o merge do useRascunho
 * devolvia produtos vazio e os lotes já escolhidos sumiam da tela em
 * silêncio. Roda uma vez, no import da tela.
 */
function migraRascunhoCargaAntigo() {
  try {
    const bruto = localStorage.getItem('tsi.rascunho.mapa.carga')
    if (!bruto) return
    const v = JSON.parse(bruto) as Record<string, unknown>
    if (!v || typeof v !== 'object' || 'produtos' in v) return
    if (!('itens' in v) && !('cultivar' in v)) return
    const temConteudo =
      (typeof v.cultivar === 'string' && v.cultivar) ||
      (Array.isArray(v.itens) && v.itens.length > 0)
    const novo: CargaForm = {
      numero: typeof v.numero === 'string' ? v.numero : '',
      placa: typeof v.placa === 'string' ? v.placa : '',
      cliente: typeof v.cliente === 'string' ? v.cliente : '',
      tara: typeof v.tara === 'string' ? v.tara : '',
      veiculo: '',
      editandoId: typeof v.editandoId === 'string' ? v.editandoId : '',
      produtos: temConteudo
        ? [{
            chave: novaChave(),
            cultivar: typeof v.cultivar === 'string' ? v.cultivar : '',
            tratamento: typeof v.tratamento === 'string' ? v.tratamento : '',
            bags: typeof v.bags === 'string' ? v.bags : '',
            itens: Array.isArray(v.itens) ? (v.itens as ItemCargaForm[]) : [],
          }]
        : [],
    }
    localStorage.setItem('tsi.rascunho.mapa.carga', JSON.stringify(novo))
  } catch {
    /* sem storage não há rascunho a migrar */
  }
}
migraRascunhoCargaAntigo()

interface Posicao {
  armazem: string
  bloco: string
  quadra: string
}

/** Letra da classificação de qualidade ("Classe C" → "C"). */
const letraClasse = (classificacao: string | null): string | null => {
  const m = (classificacao ?? '').trim().match(/([A-Z])$/i)
  return m ? m[1].toUpperCase() : null
}

/** Valor especial do filtro de destinação pros lotes livres. */
const LIVRE = '(livre)'

const enderecoDe = (l: LoteMapaLinha) =>
  l.lote_enderecos
    .slice()
    .sort((a, b) => ordenaQuadras(a.quadra, b.quadra))
    .map((e) => `${e.armazem} ${e.bloco}${ehNumero(e.quadra) ? `-Q${e.quadra}` : ` ${e.quadra}`}`)
    .join(' · ')

/** Nota de acesso do lote: quadra numérica maior = frente; sem endereço por último. */
const maiorQuadra = (l: LoteMapaLinha): number => {
  const numericas = l.lote_enderecos
    .map((e) => (ehNumero(e.quadra) ? Number(e.quadra) : null))
    .filter((q): q is number => q != null)
  if (numericas.length > 0) return Math.max(...numericas)
  return l.lote_enderecos.length > 0 ? -1 : -2
}

/**
 * Quantos bags estão NA FRENTE do lote (quadras numéricas maiores do mesmo
 * armazém+bloco, rateado), no melhor endereço dele — é o material que
 * precisa sair da frente do box pra alcançar o lote. null = sem endereço
 * numérico, não dá pra ranquear. O próprio lote na frente não conta.
 */
function bagsNaFrenteDe(l: LoteMapaLinha, alocacoes: Alocacao[]): number | null {
  const custos = l.lote_enderecos
    .filter((e) => ehNumero(e.quadra))
    .map((e) =>
      alocacoes
        .filter(
          (a) =>
            a.endereco.armazem === e.armazem &&
            a.endereco.bloco === e.bloco &&
            ehNumero(a.endereco.quadra) &&
            Number(a.endereco.quadra) > Number(e.quadra) &&
            !(a.lote.lote === l.lote && a.lote.tratamento === l.tratamento),
        )
        .reduce((s, a) => s + a.bags, 0),
    )
  if (custos.length === 0) return null
  return Math.round(Math.min(...custos))
}

export default function Mapa() {
  const { usuario, permitido } = useAuth()
  const podeImportar = permitido('mapa', 'importar')
  const podeEnderecar = permitido('mapa', 'enderecar')
  const podeMontar = permitido('mapa', 'montar_carga')

  const [lotes, setLotes] = useState<LoteMapaLinha[] | null>([])
  const [cargas, setCargas] = useState<CargaMontadaLinha[]>([])
  const [comprometidos, setComprometidos] = useState<LoteComprometido[]>([])
  const [consumoOrdens, setConsumoOrdens] = useState<ConsumoOrdens[]>([])
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [previa, setPrevia] = useState<ResultadoLotesMapa | null>(null)
  const [importando, setImportando] = useState(false)
  const [enderecando, setEnderecando] = useState<LoteMapaLinha | null>(null)
  const [posicao, setPosicao] = useState<Posicao | null>(null)
  const [movendo, setMovendo] = useState<Alocacao | null>(null)

  const recarregar = () =>
    Promise.all([
      m.listarLotesMapa(),
      m.listarCargasMontadas(),
      m.listarLotesComprometidos(),
      m.listarConsumoOrdens(),
    ])
      .then(([l, c, cp, co]) => {
        setLotes(l)
        setCargas(c)
        setComprometidos(cp)
        setConsumoOrdens(co)
      })
      .catch((x) => setErro(x instanceof Error ? x.message : String(x)))

  useEffect(() => {
    recarregar().finally(() => setCarregando(false))
  }, [])
  // as tabelas filhas também: o cabeçalho da carga quase não carrega dado
  // exibido — sem os eventos de produtos/itens, outro tablet recarregava no
  // meio da gravação e ficava com a carga vazia até um F5 (revisão 28/08/2026)
  useRealtime(
    ['lotes_mapa', 'lote_enderecos', 'cargas_montadas', 'carga_montada_produtos', 'carga_montada_itens'],
    () => void recarregar(),
  )

  // rascunhos moram AQUI (não nos cartões) de propósito: o "editar" e o
  // "lotear" das cargas salvas escrevem neles de fora (28–29/08/2026)
  const rascunhoCarga = useRascunho<CargaForm>('mapa.carga', CARGA_VAZIA)
  const rascunhoLotear = useRascunho<LotearForm>('mapa.lotear', LOTEAR_VAZIO)

  // -------- filtros do mapa --------
  const [fCultivar, setFCultivar] = useState('')
  const [fTratamento, setFTratamento] = useState('')
  const [fEmbalagem, setFEmbalagem] = useState('')
  const [fDestinacao, setFDestinacao] = useState<string[]>([])
  const [fClasse, setFClasse] = useState<string[]>([])
  const [busca, setBusca] = useState('')
  const filtroAtivo = !!(
    fCultivar || fTratamento || fEmbalagem || busca.trim() ||
    fDestinacao.length > 0 || fClasse.length > 0
  )

  const casaFiltro = (l: LoteMapaLinha): boolean => {
    if (fCultivar && l.cultivar !== fCultivar) return false
    if (fTratamento && l.tratamento !== fTratamento) return false
    if (fEmbalagem && l.embalagem !== fEmbalagem) return false
    if (fDestinacao.length > 0) {
      const alvo = l.destinacao ?? LIVRE
      if (!fDestinacao.includes(alvo)) return false
    }
    if (fClasse.length > 0) {
      const letra = letraClasse(l.classificacao)
      if (!letra || !fClasse.includes(letra)) return false
    }
    if (busca.trim() && !l.lote.toLowerCase().includes(busca.trim().toLowerCase())) return false
    return true
  }

  const todos = useMemo(() => lotes ?? [], [lotes])
  const cultivares = useMemo(() => [...new Set(todos.map((l) => l.cultivar))].sort(), [todos])
  const tratamentos = useMemo(
    () => [...new Set(todos.map((l) => l.tratamento).filter((t) => t !== SEM_TSI))].sort(),
    [todos],
  )
  const destinacoes = useMemo(
    () => [LIVRE, ...[...new Set(todos.map((l) => l.destinacao).filter((d): d is string => !!d))].sort()],
    [todos],
  )
  const classes = useMemo(() => {
    // A–D sempre aparecem (pedido do Arion, 28/08/2026); letras extras do dado entram junto
    const doDado = todos.map((l) => letraClasse(l.classificacao)).filter((c): c is string => !!c)
    return [...new Set(['A', 'B', 'C', 'D', ...doDado])].sort()
  }, [todos])
  const semEndereco = todos.filter((l) => l.lote_enderecos.length === 0)
  const aloc = useMemo(() => alocar(todos), [todos])

  /** Reabre uma carga salva pra edição do CABEÇALHO e dos produtos (1ª etapa). */
  function editarCarga(c: CargaMontadaLinha) {
    rascunhoCarga.substituir({
      numero: c.numero,
      placa: c.placa ?? '',
      cliente: c.cliente ?? '',
      tara: c.tara_kg != null ? String(c.tara_kg) : '',
      veiculo: c.veiculo ?? '',
      produtos: c.carga_montada_produtos.map((p) => ({
        chave: novaChave(),
        cultivar: p.cultivar,
        tratamento: p.tratamento,
        bags: String(p.bags_solicitados || ''),
        itens: p.carga_montada_itens.map((i) => ({ loteId: i.lote_id, bags: String(i.bags) })),
      })),
      editandoId: c.id,
    })
    setMsg(`Editando a carga ${c.numero} — salve na Montagem de carga abaixo.`)
  }

  /** Abre a 2ª etapa: escolher os lotes de uma carga JÁ SALVA. */
  function lotearCarga(c: CargaMontadaLinha) {
    rascunhoLotear.substituir({
      cargaId: c.id,
      produtos: c.carga_montada_produtos.map((p) => ({
        chave: p.id,
        cultivar: p.cultivar,
        tratamento: p.tratamento,
        bags: String(p.bags_solicitados || ''),
        itens: p.carga_montada_itens.map((i) => ({ loteId: i.lote_id, bags: String(i.bags) })),
      })),
    })
    setMsg(`Loteando a carga ${c.numero} — escolha os lotes e salve.`)
  }

  // derivado do rascunho: sobrevive a F5, e some sozinho se a carga sumir
  const loteando = cargas.find((c) => c.id === rascunhoLotear.valor.cargaId) ?? null

  /** Quanto FALTA do pedido do produto da combinação do lote na carga (0 = completo). */
  const faltaNaCarga = (l: LoteMapaLinha, c: CargaMontadaLinha): number => {
    // com o lotear da própria carga aberto, o rascunho (não salvo) é a verdade
    if (rascunhoLotear.valor.cargaId === c.id) {
      const p = rascunhoLotear.valor.produtos.find(
        (x) => x.cultivar === l.cultivar && x.tratamento === l.tratamento,
      )
      if (!p) return 0
      return Math.max(
        0,
        (Number(p.bags) || 0) - p.itens.reduce((s, i) => s + (Number(i.bags) || 0), 0),
      )
    }
    const p = c.carga_montada_produtos.find(
      (x) => x.cultivar === l.cultivar && x.tratamento === l.tratamento,
    )
    if (!p) return 0
    return Math.max(
      0,
      p.bags_solicitados - p.carga_montada_itens.reduce((s, i) => s + i.bags, 0),
    )
  }

  /**
   * Cargas ATIVAS que ainda PRECISAM da combinação do lote — destinos do
   * "+ carga" do mapa. Pedido completo fica de fora: nunca se loteia além
   * do que a carga pede (30/08/2026).
   */
  const cargasParaLote = (l: LoteMapaLinha) =>
    cargas.filter(
      (c) => !c.carregada_em && !c.finalizada_em && faltaNaCarga(l, c) > 0,
    )

  /**
   * Manda o lote direto do mapa pro LOTEAR de uma carga pendente (30/08/2026
   * — o "+ Carga" antigo, adaptado às operações separadas): abre o lotear da
   * carga com o lote já no produto da combinação. Lotear da MESMA carga já
   * aberto acumula sem perder as escolhas não salvas.
   */
  function enviarLoteParaCarga(
    l: LoteMapaLinha,
    c: CargaMontadaLinha,
    bagsEscolhidos: number | null,
  ) {
    const draft = rascunhoLotear.valor
    const mesmaCarga = draft.cargaId === c.id
    if (!mesmaCarga && loteando && loteando.id !== c.id) {
      if (
        !confirm(
          `Abrir o lotear da carga ${c.numero} descarta as escolhas NÃO SALVAS da ${loteando.numero}. Continuar?`,
        )
      ) {
        return
      }
    }
    const produtosBase: ProdutoCargaForm[] = mesmaCarga
      ? draft.produtos
      : c.carga_montada_produtos.map((p) => ({
          chave: p.id,
          cultivar: p.cultivar,
          tratamento: p.tratamento,
          bags: String(p.bags_solicitados || ''),
          itens: p.carga_montada_itens.map((i) => ({ loteId: i.lote_id, bags: String(i.bags) })),
        }))
    const alvo = produtosBase.find(
      (p) => p.cultivar === l.cultivar && p.tratamento === l.tratamento,
    )
    if (!alvo) return
    if (alvo.itens.some((i) => i.loteId === l.lote)) {
      setMsg(`${l.lote} já está na carga ${c.numero}.`)
      return
    }
    const jaEmLotes = alvo.itens.reduce((s, i) => s + (Number(i.bags) || 0), 0)
    const restante = Math.max(0, (Number(alvo.bags) || 0) - jaEmLotes)
    // NUNCA além do PEDIDO do produto (regra do Arion, 30/08/2026): a
    // quantidade escolhida vale, capada no que falta do pedido e no saldo
    if (restante <= 0) {
      setMsg(
        `O produto ${l.cultivar} · ${rotuloTratamento(l.tratamento)} da carga ${c.numero} já está com o pedido completo — abra Ajustar lotes se quiser trocar de lote.`,
      )
      return
    }
    const pedidos = bagsEscolhidos && bagsEscolhidos > 0 ? bagsEscolhidos : restante
    const qtd = Math.min(pedidos, restante, l.bags)
    rascunhoLotear.substituir({
      cargaId: c.id,
      produtos: produtosBase.map((p) =>
        p.chave === alvo.chave
          ? { ...p, itens: [...p.itens, { loteId: l.lote, bags: String(qtd) }] }
          : p,
      ),
    })
    setMsg(
      `${l.lote}: ${inteiro(qtd)} bg adicionados ao lotear da carga ${c.numero}${qtd < pedidos ? ' (limitado ao que falta do pedido)' : ''} — confira e salve.`,
    )
  }

  /** Imprime o croqui de carregamento (réplica do formulário de papel). */
  function imprimirCroqui(c: CargaMontadaLinha) {
    const v = veiculoDe(c.veiculo)
    if (!v) {
      setErro(
        `A carga ${c.numero} não tem o veículo definido — abra Editar e escolha o tipo (o croqui é desenhado por veículo).`,
      )
      return
    }
    const lotesDistintos = new Set(
      c.carga_montada_produtos.flatMap((p) => p.carga_montada_itens.map((i) => i.lote_id)),
    ).size
    imprimirCroquiCarga({
      numero: c.numero,
      veiculo: v,
      data: new Date().toLocaleDateString('pt-BR'),
      lotesNaCarga: lotesDistintos,
      totalBags: Math.round(
        c.carga_montada_produtos.reduce(
          (s, p) => s + p.carga_montada_itens.reduce((si, i) => si + i.bags, 0),
          0,
        ),
      ),
    })
  }

  /** Carregada (caminhão saiu → sai da conta de saldo) e Finalizada (encerra). */
  async function marcarCarga(c: CargaMontadaLinha, marco: m.MarcoCarga) {
    try {
      await m.marcarCargaMontada(c.id, marco, usuario?.id ?? null)
      if (marco === 'carregada' && rascunhoLotear.valor.cargaId === c.id) {
        rascunhoLotear.limpar()
      }
      setMsg(
        marco === 'carregada'
          ? `Carga ${c.numero} carregada — os lotes dela não descontam mais o saldo.`
          : `Carga ${c.numero} finalizada.`,
      )
      await recarregar()
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    }
  }

  /** Desfaz o ÚLTIMO marco (misclick): finalizada → carregada → loteada. */
  async function desfazerMarca(c: CargaMontadaLinha) {
    try {
      const marco: m.MarcoCarga = c.finalizada_em ? 'finalizada' : 'carregada'
      await m.desmarcarCargaMontada(c.id, marco)
      setMsg(`Carga ${c.numero}: ${marco} desfeita.`)
      await recarregar()
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    }
  }

  async function excluirCarga(c: CargaMontadaLinha) {
    if (!confirm(`Excluir a ordem de carregamento ${c.numero}?`)) return
    try {
      await m.excluirCargaMontada(c.id)
      if (rascunhoLotear.valor.cargaId === c.id) rascunhoLotear.limpar()
      setMsg(`Carga ${c.numero} excluída.`)
      await recarregar()
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    }
  }

  /** Imprime a folha da ordem de carregamento, com o endereço ATUAL de cada lote. */
  function imprimirCarga(c: CargaMontadaLinha) {
    const itensDe = (p: ProdutoCargaLinha) =>
      p.carga_montada_itens.map((i) => {
        const lote = todos.find((l) => l.lote === i.lote_id && l.tratamento === p.tratamento)
        return {
          lote: i.lote_id,
          endereco: lote ? enderecoDe(lote) : '',
          bags: i.bags,
          pesoBagKg: lote?.peso_bag_kg ?? (i.bags > 0 ? Math.round(i.peso_kg / i.bags) : null),
          pesoKg: i.peso_kg,
          destinacao: i.destinacao,
        }
      })
    imprimirOrdemCarregamento({
      numero: c.numero,
      cliente: c.cliente,
      placa: c.placa,
      data: dataHoraCurta(c.criada_em),
      produtos: c.carga_montada_produtos.map((p) => ({
        cultivar: p.cultivar,
        tratamento: rotuloTratamento(p.tratamento),
        bagsSolicitados: p.bags_solicitados,
        itens: itensDe(p),
      })),
      totalBags: c.carga_montada_produtos.reduce(
        (s, p) => s + p.carga_montada_itens.reduce((si, i) => si + i.bags, 0),
        0,
      ),
      pesoTotalKg: c.peso_total_kg,
      taraKg: c.tara_kg,
    })
  }

  /**
   * Linhas de uma carga na tabela: uma por LOTE, com o produto e a carga
   * fundidos por rowSpan — o resumo tudo-numa-célula ficava ilegível com
   * mais de um produto (pedido do Arion, 29/08/2026).
   */
  function linhasDaCarga(c: CargaMontadaLinha): ReactNode[] {
    const produtos = c.carga_montada_produtos
    const totalLinhas = Math.max(
      1,
      produtos.reduce((s, p) => s + Math.max(1, p.carga_montada_itens.length), 0),
    )
    const totalBags = produtos.reduce(
      (s, p) => s + p.carga_montada_itens.reduce((si, i) => si + i.bags, 0),
      0,
    )
    // ciclo: aguardando lotear → loteada → carregada → finalizada
    const pendente =
      produtos.length === 0 || produtos.some((p) => p.carga_montada_itens.length === 0)
    const finalizada = !!c.finalizada_em
    const carregada = !!c.carregada_em
    // ativa = ainda em montagem/loteamento (editável)
    const ativa = !carregada && !finalizada
    const celulaCarga = (
      <td rowSpan={totalLinhas} className="px-2 py-1.5 align-top">
        <span className="font-medium">{c.numero}</span>
        <span className="block text-xs text-stone-500">
          {inteiro(totalBags)} bg · {inteiro(c.peso_total_kg)} kg
        </span>
        <span className="mt-1 block">
          {finalizada
            ? <Tag cor="neutro">finalizada</Tag>
            : carregada
              ? <Tag cor="info">carregada</Tag>
              : pendente
                ? <Tag cor="alerta">aguardando lotear</Tag>
                : <Tag cor="ok">loteada</Tag>}
        </span>
      </td>
    )
    const celulasFinais = (
      <>
        <td rowSpan={totalLinhas} className="px-2 py-1.5 align-top text-xs text-stone-500">
          {[c.placa, c.cliente].filter(Boolean).join(' · ') || '—'}
        </td>
        <td rowSpan={totalLinhas} className="px-2 py-1.5 align-top text-xs text-stone-500">
          {dataHoraCurta(c.criada_em)}
        </td>
        <td rowSpan={totalLinhas} className="px-2 py-1.5 align-top">
          <div className="flex justify-end gap-1.5 whitespace-nowrap">
            {/* loteada continua ajustável até marcar Carregada (30/08/2026) */}
            {podeMontar && ativa && (
              <Botao variante={pendente ? 'primario' : 'normal'} onClick={() => lotearCarga(c)}>
                {pendente ? 'Lotear' : 'Ajustar lotes'}
              </Botao>
            )}
            {podeMontar && ativa && !pendente && (
              <Botao variante="primario" onClick={() => void marcarCarga(c, 'carregada')}>
                Carregada
              </Botao>
            )}
            {podeMontar && carregada && !finalizada && (
              <Botao variante="primario" onClick={() => void marcarCarga(c, 'finalizada')}>
                Finalizada
              </Botao>
            )}
            <Botao onClick={() => imprimirCarga(c)}>Imprimir</Botao>
            <Botao onClick={() => imprimirCroqui(c)}>Croqui</Botao>
            {podeMontar && ativa && <Botao onClick={() => editarCarga(c)}>Editar</Botao>}
            {podeMontar && ativa && (
              <button
                type="button"
                onClick={() => void excluirCarga(c)}
                className="px-1 text-xs text-stone-400 underline hover:text-red-600"
              >
                excluir
              </button>
            )}
            {podeMontar && !ativa && (
              <button
                type="button"
                onClick={() => void desfazerMarca(c)}
                title={finalizada ? 'Volta pra carregada' : 'Volta pra loteada'}
                className="px-1 text-xs text-stone-400 underline hover:text-amber-600"
              >
                desfazer
              </button>
            )}
          </div>
        </td>
      </>
    )

    // o painel de lotear abre AQUI, logo abaixo da carga referenciada
    // (pedido do Arion, 29/08/2026 — antes abria acima da lista inteira)
    const linhaLotear =
      podeMontar && ativa && loteando?.id === c.id ? (
        <tr key={`${c.id}-lotear`}>
          <td colSpan={8} className="bg-stone-50 p-3 dark:bg-stone-900/40">
            <LotearCarga
              carga={loteando}
              lotes={todos}
              alocacoes={aloc}
              comprometidos={comprometidos}
              consumoOrdens={consumoOrdens}
              rascunho={rascunhoLotear}
              onFechar={() => rascunhoLotear.limpar()}
              onSalva={(texto) => {
                setMsg(texto)
                void recarregar()
              }}
            />
          </td>
        </tr>
      ) : null

    if (produtos.length === 0) {
      return [
        <tr key={c.id} className="border-t-2 border-stone-200 dark:border-stone-700">
          {celulaCarga}
          <td colSpan={4} className="px-2 py-1.5 text-xs italic text-stone-400">
            sem produtos
          </td>
          {celulasFinais}
        </tr>,
        linhaLotear,
      ]
    }

    const linhas: ReactNode[] = []
    let primeira = true
    for (const p of produtos) {
      const itens: (typeof p.carga_montada_itens[number] | null)[] =
        p.carga_montada_itens.length > 0 ? p.carga_montada_itens : [null]
      itens.forEach((i, idx) => {
        linhas.push(
          <tr
            key={`${c.id}-${p.id}-${i ? i.lote_id : 'vazio'}-${idx}`}
            className={
              primeira
                ? 'border-t-2 border-stone-200 dark:border-stone-700'
                : 'border-t border-stone-100 dark:border-stone-800/60'
            }
          >
            {primeira && celulaCarga}
            {idx === 0 && (
              <td rowSpan={itens.length} className="px-2 py-1.5 align-top">
                {p.cultivar} · {rotuloTratamento(p.tratamento)}
                <span className="block text-xs text-stone-500">
                  pedido {inteiro(p.bags_solicitados)} bg
                </span>
              </td>
            )}
            {i ? (
              <>
                <td className="px-2 py-1.5 text-xs">
                  {i.lote_id}
                  {i.destinacao && (
                    <span className="ml-1.5">
                      <Tag cor="perigo">{i.destinacao}</Tag>
                    </span>
                  )}
                </td>
                <td className="num-tabular px-2 py-1.5 text-right">{inteiro(i.bags)}</td>
                <td className="num-tabular px-2 py-1.5 text-right">{inteiro(i.peso_kg)}</td>
              </>
            ) : (
              <td colSpan={3} className="px-2 py-1.5 text-xs italic text-stone-400">
                lotes a definir
              </td>
            )}
            {primeira && celulasFinais}
          </tr>,
        )
        primeira = false
      })
    }
    linhas.push(linhaLotear)
    return linhas
  }

  // -------- upload --------
  async function lerPlanilha(ev: ChangeEvent<HTMLInputElement>) {
    const arquivo = ev.target.files?.[0]
    ev.target.value = ''
    if (!arquivo) return
    setErro(null)
    setMsg(null)
    setPrevia(null)
    try {
      const bruto = (await readXlsxFile(arquivo)) as unknown
      const arr = bruto as { data?: Linha[] }[]
      const linhas =
        Array.isArray(arr) && arr.length > 0 && !Array.isArray(arr[0]) && Array.isArray(arr[0]?.data)
          ? (arr[0].data as Linha[])
          : (bruto as Linha[])
      if (!ehRelatorioMapa(linhas)) {
        throw new Error(
          'Não parece o export de saldo do SAP com Destinação — esperava as colunas "Nº do Lote", "Destinação" e "Depósito".',
        )
      }
      setPrevia(converterLotesMapa(linhas))
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    }
  }

  async function confirmarImportacao() {
    if (!previa) return
    setImportando(true)
    setErro(null)
    try {
      const qtd = await m.importarLotesMapa(previa.lotes)
      setPrevia(null)
      setMsg(`${qtd} lote(s) gravados — lote que zerou no SAP saiu do mapa.`)
      await recarregar()
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    } finally {
      setImportando(false)
    }
  }

  if (carregando) return <p className="p-8 text-sm text-stone-500">Carregando mapa…</p>

  const naPosicao = posicao
    ? aloc.filter(
        (a) =>
          a.endereco.armazem === posicao.armazem &&
          a.endereco.bloco === posicao.bloco &&
          a.endereco.quadra === posicao.quadra,
      )
    : []

  return (
    <Pagina
      titulo="Mapa e Montagem de Carga"
      descricao={`Todo lote do SAP no depósito ${DEPOSITO_MAPA} — semente branca e tratada, por lote + tratamento. A Logística endereça e movimenta (inteiro ou parcial); a Balança monta a carga, e o sistema avisa lote com Destinação e soma o peso.`}
    >
      {erro && <Erro>{erro}</Erro>}
      {msg && (
        <div className="mb-4">
          <Aviso gravidade="ok">{msg}</Aviso>
        </div>
      )}

      {lotes === null && (
        <div className="mb-5">
          <Aviso gravidade="bloqueio">
            O banco ainda não está no formato novo do mapa — rode a migração{' '}
            <code>supabase/mapa-lote-tratamento.sql</code> no SQL Editor e recarregue.
          </Aviso>
        </div>
      )}

      {/* -------- carga do SAP -------- */}
      <Cartao
        titulo={`Saldo do SAP (${todos.length} lotes no mapa)`}
        acoes={
          podeImportar ? (
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-stone-300 px-3 py-2 text-sm font-medium hover:bg-stone-100 sm:py-1.5 dark:border-stone-700 dark:hover:bg-stone-800">
              Carregar planilha (.xlsx)
              <input type="file" accept=".xlsx,.xls" className="hidden" onChange={lerPlanilha} />
            </label>
          ) : undefined
        }
        className="mb-5"
      >
        {previa ? (
          <>
            <Aviso gravidade="alerta">
              <b>Prévia — nada foi gravado ainda.</b> {previa.lotes.length} combinação(ões)
              lote + tratamento do {DEPOSITO_MAPA} ({previa.brancos} branca(s),{' '}
              {previa.tratados} tratada(s), {previa.comDestinacao} com destinação ·{' '}
              {inteiro(previa.totalBags)} bags). Fora: {previa.outrosDepositos} de outros
              depósitos, {previa.zerados} zeradas, {previa.granel} granel. Confirmar
              SUBSTITUI o mapa inteiro — o que não veio some (endereços de quem continua
              são preservados).
            </Aviso>
            <div className="mt-3 flex gap-2">
              <Botao variante="primario" disabled={importando} onClick={confirmarImportacao}>
                {importando ? 'gravando…' : `Confirmar importação (${previa.lotes.length})`}
              </Botao>
              <Botao onClick={() => setPrevia(null)}>Cancelar</Botao>
            </div>
          </>
        ) : (
          <p className="text-sm text-stone-500 dark:text-stone-400">
            {todos.length === 0
              ? `Nenhum lote no mapa ainda. Suba o export de saldo do SAP (com as colunas Destinação e Depósito) — só o ${DEPOSITO_MAPA} entra.`
              : `${semEndereco.length} combinação(ões) aguardando localização · ${todos.filter((l) => l.destinacao).length} com destinação no SAP. Suba a planilha de novo pra atualizar o saldo.`}
          </p>
        )}
      </Cartao>

      {/* -------- fila de endereçamento -------- */}
      {semEndereco.length > 0 && (
        <Cartao titulo={`Sem localização (${semEndereco.length})`} className="mb-5">
          <p className="mb-3 text-sm text-stone-500 dark:text-stone-400">
            Combinações do SAP ainda sem endereço físico — a Logística informa armazém,
            bloco e quadra (pode dividir em mais de um endereço).
          </p>
          <Tabela cabecalho={['Lote', 'Cultivar', 'Tratamento', 'Emb.', '#Bags', 'Destinação', '']}>
            {semEndereco.map((l) => (
              <tr key={chaveDe(l)} className="border-t border-stone-100 dark:border-stone-800/60">
                <td className="px-2 py-1.5 font-medium">{l.lote}</td>
                <td className="px-2 py-1.5">{l.cultivar}</td>
                <td className="px-2 py-1.5">
                  {l.tratamento === SEM_TSI ? <span className="text-stone-400">branca</span> : l.tratamento}
                </td>
                <td className="px-2 py-1.5">{l.embalagem}</td>
                <td className="num-tabular px-2 py-1.5 text-right">{inteiro(l.bags)}</td>
                <td className="px-2 py-1.5">
                  {l.destinacao
                    ? <Tag cor="perigo">{l.destinacao}</Tag>
                    : <Tag cor="ok">livre</Tag>}
                </td>
                <td className="px-2 py-1.5 text-right">
                  {podeEnderecar && <Botao onClick={() => setEnderecando(l)}>Endereçar</Botao>}
                </td>
              </tr>
            ))}
          </Tabela>
        </Cartao>
      )}

      {/* -------- mapa em grade -------- */}
      <Cartao titulo="Mapa (visão superior)" className="mb-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <select value={fCultivar} onChange={(e) => setFCultivar(e.target.value)} className={INPUT}>
            <option value="">todos os cultivares</option>
            {cultivares.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={fTratamento} onChange={(e) => setFTratamento(e.target.value)} className={INPUT}>
            <option value="">todos os tratamentos</option>
            <option value={SEM_TSI}>SEM TSI (branca)</option>
            {tratamentos.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select value={fEmbalagem} onChange={(e) => setFEmbalagem(e.target.value)} className={INPUT}>
            <option value="">todas as embalagens</option>
            <option value="BG5M">BG5M</option>
            <option value="MEIOBAG">MEIOBAG</option>
          </select>
          <FiltroMulti
            rotulo="destinação"
            opcoes={destinacoes}
            selecionadas={fDestinacao}
            onMudar={setFDestinacao}
          />
          <FiltroMulti
            rotulo="classe"
            opcoes={classes}
            selecionadas={fClasse}
            onMudar={setFClasse}
          />
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="buscar lote…"
            className={INPUT}
          />
          {filtroAtivo && (
            <button
              type="button"
              onClick={() => {
                setFCultivar(''); setFTratamento(''); setFEmbalagem('')
                setFDestinacao([]); setFClasse([]); setBusca('')
              }}
              className="rounded-md border border-stone-300 px-3 py-1.5 text-xs text-stone-600 underline hover:bg-stone-100 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800"
            >
              Limpar filtros
            </button>
          )}
        </div>

        <MapaGrade
          alocacoes={aloc}
          casaFiltro={casaFiltro}
          filtroAtivo={filtroAtivo}
          onPosicao={setPosicao}
        />
      </Cartao>

      {/* -------- 1ª etapa: montagem de carga -------- */}
      {podeMontar && (
        <MontagemCarga
          lotes={todos}
          usuarioId={usuario?.id ?? ''}
          rascunho={rascunhoCarga}
          onSalva={(texto) => {
            setMsg(texto)
            void recarregar()
          }}
        />
      )}

      {/* -------- cargas recentes: 1 linha por produto, 1 por lote (28/08/2026) -------- */}
      <Cartao titulo={`Cargas montadas (${cargas.length} recentes)`}>
        {cargas.length === 0 ? (
          <Vazio>Nenhuma carga montada ainda.</Vazio>
        ) : (
          <Tabela cabecalho={['Ordem', 'Produto', 'Lote', '#Bags', '#Peso (kg)', 'Placa · Cliente', 'Quando', '']}>
            {cargas.flatMap((c) => linhasDaCarga(c))}
          </Tabela>
        )}
      </Cartao>

      {/* -------- modais -------- */}
      {posicao && (
        <ModalPosicao
          posicao={posicao}
          alocacoes={naPosicao}
          podeEnderecar={podeEnderecar}
          podeMontar={podeMontar}
          cargasParaLote={cargasParaLote}
          faltaNaCarga={faltaNaCarga}
          onFechar={() => setPosicao(null)}
          onMover={(a) => {
            setMovendo(a)
            setPosicao(null)
          }}
          onEnderecar={(l) => {
            setEnderecando(l)
            setPosicao(null)
          }}
          onEnviarParaCarga={(l, c, bags) => {
            enviarLoteParaCarga(l, c, bags)
            setPosicao(null)
          }}
        />
      )}

      {movendo && usuario && (
        <ModalMover
          alocacao={movendo}
          onFechar={() => setMovendo(null)}
          onMover={async (bagsAMover, destino) => {
            try {
              await m.moverEndereco({
                origem: movendo.endereco,
                lote: movendo.lote.lote,
                tratamento: movendo.lote.tratamento,
                bagsAMover,
                destino,
                enderecosDaCombinacao: movendo.lote.lote_enderecos,
                usuarioId: usuario.id,
              })
              setMovendo(null)
              setMsg(
                `${movendo.lote.lote} movido pra ${destino.armazem} ${destino.bloco} ${rotuloQuadra(destino.quadra)}.`,
              )
              await recarregar()
            } catch (e) {
              setErro(e instanceof Error ? e.message : String(e))
            }
          }}
        />
      )}

      {enderecando && usuario && (
        <ModalEnderecos
          lote={enderecando}
          onFechar={() => setEnderecando(null)}
          onSalvar={async (enderecos) => {
            try {
              await m.salvarEnderecos(enderecando.lote, enderecando.tratamento, enderecos, usuario.id)
              setEnderecando(null)
              await recarregar()
            } catch (e) {
              setErro(e instanceof Error ? e.message : String(e))
            }
          }}
        />
      )}
    </Pagina>
  )
}

/** Dropdown de multiseleção com checkboxes — destinação e classe (28/08/2026). */
function FiltroMulti({
  rotulo, opcoes, selecionadas, onMudar,
}: {
  rotulo: string
  opcoes: string[]
  selecionadas: string[]
  onMudar: (v: string[]) => void
}) {
  const [aberto, setAberto] = useState(false)
  const alternar = (o: string) =>
    onMudar(selecionadas.includes(o) ? selecionadas.filter((s) => s !== o) : [...selecionadas, o])
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        className={`${INPUT} ${selecionadas.length > 0 ? 'font-medium' : 'text-stone-500 dark:text-stone-400'}`}
      >
        {selecionadas.length > 0 ? `${rotulo} (${selecionadas.length})` : `toda ${rotulo}`} ▾
      </button>
      {aberto && (
        <>
          <button
            type="button"
            aria-label="fechar"
            onClick={() => setAberto(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div className="absolute z-20 mt-1 max-h-64 min-w-48 overflow-y-auto rounded-lg border border-stone-300 bg-white p-1.5 shadow-lg dark:border-stone-700 dark:bg-stone-900">
            {opcoes.map((o) => (
              <label
                key={o}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-stone-100 dark:hover:bg-stone-800"
              >
                <input
                  type="checkbox"
                  checked={selecionadas.includes(o)}
                  onChange={() => alternar(o)}
                />
                {o}
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Grade por armazém no formato do painel antigo: BLOCOS nas colunas,
 * QUADRAS nas linhas (maior no topo = frente). Cada célula soma os bags
 * rateados da posição; clicar abre o detalhe com os lotes dali.
 */
function MapaGrade({
  alocacoes, casaFiltro, filtroAtivo, onPosicao,
}: {
  alocacoes: Alocacao[]
  casaFiltro: (l: LoteMapaLinha) => boolean
  filtroAtivo: boolean
  onPosicao: (p: Posicao) => void
}) {
  const porArmazem = useMemo(() => {
    const arm = new Map<string, Alocacao[]>()
    for (const a of alocacoes) {
      const lista = arm.get(a.endereco.armazem) ?? []
      lista.push(a)
      arm.set(a.endereco.armazem, lista)
    }
    return [...arm.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [alocacoes])

  if (porArmazem.length === 0) {
    return <Vazio>Nenhum lote endereçado ainda — o mapa aparece conforme a Logística endereça.</Vazio>
  }

  return (
    <div className="space-y-6">
      {porArmazem.map(([armazem, itens]) => {
        const blocos = [...new Set(itens.map((a) => a.endereco.bloco))].sort((a, b) =>
          a.localeCompare(b, undefined, { numeric: true }),
        )
        const quadras = [...new Set(itens.map((a) => a.endereco.quadra))].sort(ordenaQuadras)
        const celulas = new Map<string, Alocacao[]>()
        for (const a of itens) {
          const k = `${a.endereco.bloco}|${a.endereco.quadra}`
          const lista = celulas.get(k) ?? []
          lista.push(a)
          celulas.set(k, lista)
        }
        const maxCelula = Math.max(
          1,
          ...[...celulas.values()].map((cs) => cs.reduce((s, c) => s + c.bags, 0)),
        )
        const totalBags = itens.reduce((s, a) => s + a.bags, 0)
        const posicoesEncontradas = filtroAtivo
          ? [...celulas.values()].filter((cs) => cs.some((c) => casaFiltro(c.lote))).length
          : 0

        return (
          <div key={armazem} className="overflow-hidden rounded-lg border border-stone-300 dark:border-stone-700">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-300 bg-stone-100 px-3 py-2 dark:border-stone-700 dark:bg-stone-800">
              <p className="text-sm font-bold tracking-wide">ARMAZÉM {armazem}</p>
              <p className="text-xs text-stone-600 dark:text-stone-300">
                <span className="num-tabular font-semibold">{inteiro(Math.round(totalBags))} bags</span>
                {filtroAtivo && (
                  <span className="ml-3 font-medium text-green-700 dark:text-green-400">
                    {posicoesEncontradas} posição(ões) encontrada(s)
                  </span>
                )}
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-center text-xs">
                <thead>
                  <tr className="border-b border-stone-200 dark:border-stone-800">
                    <th className="sticky left-0 bg-white px-2 py-1.5 text-left font-medium text-stone-500 dark:bg-stone-900">
                      QD ↓ / BL →
                    </th>
                    {blocos.map((b) => (
                      <th key={b} className="min-w-20 px-2 py-1.5 font-semibold">{b}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {quadras.map((q) => (
                    <tr key={q} className="border-b border-stone-100 last:border-b-0 dark:border-stone-800/60">
                      <td className="sticky left-0 bg-white px-2 py-2 text-left font-semibold text-stone-500 dark:bg-stone-900">
                        {rotuloQuadra(q)}
                      </td>
                      {blocos.map((b) => {
                        const cs = celulas.get(`${b}|${q}`)
                        if (!cs) {
                          return (
                            <td key={b} className="px-1 py-1">
                              <span className="text-stone-300 dark:text-stone-700">—</span>
                            </td>
                          )
                        }
                        const bags = cs.reduce((s, c) => s + c.bags, 0)
                        const casa = cs.some((c) => casaFiltro(c.lote))
                        const apagada = filtroAtivo && !casa
                        const intensidade = bags / maxCelula
                        const cor = apagada
                          ? 'bg-stone-100 text-stone-300 dark:bg-stone-800/40 dark:text-stone-600'
                          : filtroAtivo && casa
                            ? 'bg-green-200 text-green-950 ring-2 ring-green-600 dark:bg-green-900 dark:text-green-100'
                            : intensidade > 0.66
                              ? 'bg-sky-600/80 text-white dark:bg-sky-800'
                              : intensidade > 0.33
                                ? 'bg-sky-400/70 text-sky-950 dark:bg-sky-900/80 dark:text-sky-100'
                                : 'bg-sky-200/70 text-sky-950 dark:bg-sky-950/70 dark:text-sky-200'
                        return (
                          <td key={b} className="px-1 py-1">
                            <button
                              type="button"
                              onClick={() => onPosicao({ armazem, bloco: b, quadra: q })}
                              className={`w-full min-w-16 rounded-md px-1.5 py-1.5 transition-transform hover:scale-105 ${cor}`}
                            >
                              <span className="num-tabular block text-sm font-bold">
                                {inteiro(Math.round(bags))} b
                              </span>
                              <span className="block text-[10px] opacity-80">
                                {cs.length} lote(s)
                              </span>
                            </button>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}
      <p className="text-xs text-stone-500">
        Quadra maior no topo = frente do bloco (acesso mais fácil); CORREDOR/SILO no fim.
        Clique numa posição pra ver os lotes dali — com a destinação do SAP (ou livre) e as
        ações de mover e endereçar. Com filtro ativo, as posições que casam ficam verdes.
      </p>
    </div>
  )
}

/** Detalhe de uma posição: os lotes que estão ali, destinação/livre, mover, + carga. */
function ModalPosicao({
  posicao, alocacoes, podeEnderecar, podeMontar, cargasParaLote, faltaNaCarga,
  onFechar, onMover, onEnderecar, onEnviarParaCarga,
}: {
  posicao: Posicao
  alocacoes: Alocacao[]
  podeEnderecar: boolean
  podeMontar: boolean
  cargasParaLote: (l: LoteMapaLinha) => CargaMontadaLinha[]
  faltaNaCarga: (l: LoteMapaLinha, c: CargaMontadaLinha) => number
  onFechar: () => void
  onMover: (a: Alocacao) => void
  onEnderecar: (l: LoteMapaLinha) => void
  onEnviarParaCarga: (l: LoteMapaLinha, c: CargaMontadaLinha, bags: number | null) => void
}) {
  // bags a enviar por linha — nasce com o que há NESTA posição (rateado)
  const [bagsEnvio, setBagsEnvio] = useState<Record<string, string>>({})
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white p-5 dark:bg-stone-900">
        <h3 className="text-base font-semibold">
          Armazém {posicao.armazem} · Bloco {posicao.bloco} · {rotuloQuadra(posicao.quadra)}
        </h3>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          {alocacoes.length} lote(s) nesta posição ·{' '}
          {inteiro(Math.round(alocacoes.reduce((s, a) => s + a.bags, 0)))} bags
        </p>

        <div className="mt-4 space-y-2">
          {alocacoes.map((a) => (
            <div
              key={`${chaveDe(a.lote)}-${a.endereco.id}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-stone-200 px-3 py-2 text-sm dark:border-stone-700"
            >
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
                  {a.lote.lote}
                  {a.lote.destinacao
                    ? <Tag cor="perigo">{a.lote.destinacao}</Tag>
                    : <Tag cor="ok">livre</Tag>}
                </p>
                <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
                  {a.lote.cultivar} · {rotuloTratamento(a.lote.tratamento)} · {a.lote.embalagem} ·{' '}
                  <b>
                    {a.estimado ? '~' : ''}
                    {inteiro(Math.round(a.bags))} bg aqui
                  </b>{' '}
                  ({inteiro(a.lote.bags)} no lote{a.lote.lote_enderecos.length > 1 ? `, em ${a.lote.lote_enderecos.length} locais` : ''})
                  {a.estimado && ' · estimado — sem contagem por endereço'}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                {/* manda o lote pro lotear de uma carga pendente da combinação;
                    a quantidade nasce com o que há NESTA posição e é editável */}
                {podeMontar && cargasParaLote(a.lote).length > 0 && (() => {
                  const chaveEnvio = `${chaveDe(a.lote)}|${a.endereco.id}`
                  const valor = bagsEnvio[chaveEnvio] ?? String(Math.max(1, Math.round(a.bags)))
                  return (
                    <>
                      <label className="flex items-center gap-1 text-xs text-stone-500 dark:text-stone-400">
                        enviar
                        <input
                          type="number"
                          min={1}
                          value={valor}
                          onChange={(e) =>
                            setBagsEnvio((m) => ({ ...m, [chaveEnvio]: e.target.value }))
                          }
                          className={`${INPUT} w-20 py-1 text-right`}
                        />
                        bg
                      </label>
                      {cargasParaLote(a.lote).map((c) => (
                        <Botao
                          key={c.id}
                          variante="primario"
                          onClick={() => onEnviarParaCarga(a.lote, c, Number(valor) || null)}
                        >
                          + carga {c.numero}{c.cliente ? ` · ${c.cliente}` : ''} (falta{' '}
                          {inteiro(faltaNaCarga(a.lote, c))})
                        </Botao>
                      ))}
                    </>
                  )
                })()}
                {podeEnderecar && (
                  <>
                    <Botao onClick={() => onMover(a)}>Mover</Botao>
                    <Botao onClick={() => onEnderecar(a.lote)}>Endereços</Botao>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 flex justify-end">
          <Botao onClick={onFechar}>Fechar</Botao>
        </div>
      </div>
    </div>
  )
}

/** Movimentação: o lote inteiro daquele endereço, ou uma parte. */
function ModalMover({
  alocacao: a, onFechar, onMover,
}: {
  alocacao: Alocacao
  onFechar: () => void
  onMover: (bagsAMover: number | null, destino: { armazem: string; bloco: string; quadra: string }) => Promise<void>
}) {
  const [bags, setBags] = useState('')
  const [armazem, setArmazem] = useState(a.endereco.armazem)
  const [bloco, setBloco] = useState('')
  const [quadra, setQuadra] = useState('')
  const [salvando, setSalvando] = useState(false)

  const bagsNum = Number(bags) || 0
  const parcial = bags.trim() !== '' && bagsNum > 0
  const valido = armazem.trim() && bloco.trim() && quadra.trim()

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-lg bg-white p-5 dark:bg-stone-900">
        <h3 className="text-base font-semibold">
          Mover — {a.lote.lote} · {rotuloTratamento(a.lote.tratamento)}
        </h3>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          De <b>{a.endereco.armazem} {a.endereco.bloco} {rotuloQuadra(a.endereco.quadra)}</b>
          {' '}({a.estimado ? '~' : ''}{inteiro(Math.round(a.bags))} bg aqui). Deixe a
          quantidade em branco pra mover TUDO deste endereço.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <input
            type="number"
            min={1}
            value={bags}
            onChange={(e) => setBags(e.target.value)}
            placeholder="bags (vazio = tudo)"
            className={`${INPUT} w-40`}
          />
          <span className="text-sm text-stone-400">→</span>
          <input value={armazem} onChange={(e) => setArmazem(e.target.value)} placeholder="armazém" className={`${INPUT} w-24`} />
          <input value={bloco} onChange={(e) => setBloco(e.target.value)} placeholder="bloco" className={`${INPUT} w-24`} />
          <input value={quadra} onChange={(e) => setQuadra(e.target.value)} placeholder="quadra" className={`${INPUT} w-28`} />
        </div>

        {parcial && a.endereco.bags == null && (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
            Este endereço não tem contagem própria — o destino ganha {inteiro(bagsNum)} bg e
            a origem continua sem contagem (o rateio ajusta o resto).
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Botao onClick={onFechar}>Cancelar</Botao>
          <Botao
            variante="primario"
            disabled={salvando || !valido}
            onClick={async () => {
              setSalvando(true)
              try {
                await onMover(parcial ? bagsNum : null, {
                  armazem: armazem.trim().toUpperCase(),
                  bloco: normalizaBloco(bloco),
                  quadra: quadra.trim().toUpperCase(),
                })
              } finally {
                setSalvando(false)
              }
            }}
          >
            {salvando ? 'movendo…' : parcial ? `Mover ${inteiro(bagsNum)} bags` : 'Mover tudo'}
          </Botao>
        </div>
      </div>
    </div>
  )
}

/** Endereços de uma combinação lote + tratamento: substituição total. */
function ModalEnderecos({
  lote, onFechar, onSalvar,
}: {
  lote: LoteMapaLinha
  onFechar: () => void
  onSalvar: (enderecos: { armazem: string; bloco: string; quadra: string; bags: number | null }[]) => Promise<void>
}) {
  const [linhas, setLinhas] = useState<{ armazem: string; bloco: string; quadra: string; bags: string }[]>(
    lote.lote_enderecos.length > 0
      ? lote.lote_enderecos.map((e) => ({
          armazem: e.armazem, bloco: e.bloco, quadra: e.quadra, bags: e.bags != null ? String(e.bags) : '',
        }))
      : [{ armazem: '', bloco: '', quadra: '', bags: '' }],
  )
  const [salvando, setSalvando] = useState(false)

  const validas = linhas.filter((l) => l.armazem.trim() && l.bloco.trim() && l.quadra.trim() !== '')

  const atualizar = (i: number, campo: keyof (typeof linhas)[number], valor: string) =>
    setLinhas((ls) => ls.map((l, idx) => (idx === i ? { ...l, [campo]: valor } : l)))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-lg bg-white p-5 dark:bg-stone-900">
        <h3 className="text-base font-semibold">
          Endereçar — {lote.lote} · {lote.cultivar} · {rotuloTratamento(lote.tratamento)}
        </h3>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          {inteiro(lote.bags)} bags no SAP. Quanto maior a QUADRA (número), mais fácil o
          acesso — CORREDOR/SILO também valem. Bags por endereço é opcional. Pode dividir
          em mais de um endereço.
        </p>

        <div className="mt-4 space-y-2">
          {linhas.map((l, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <input value={l.armazem} onChange={(e) => atualizar(i, 'armazem', e.target.value)} placeholder="armazém" className={`${INPUT} w-28`} />
              <input value={l.bloco} onChange={(e) => atualizar(i, 'bloco', e.target.value)} placeholder="bloco" className={`${INPUT} w-24`} />
              <input value={l.quadra} onChange={(e) => atualizar(i, 'quadra', e.target.value)} placeholder="quadra" className={`${INPUT} w-28`} />
              <input type="number" min={1} value={l.bags} onChange={(e) => atualizar(i, 'bags', e.target.value)} placeholder="bags (opc.)" className={`${INPUT} w-28`} />
              {linhas.length > 1 && (
                <button
                  type="button"
                  onClick={() => setLinhas((ls) => ls.filter((_, idx) => idx !== i))}
                  title="Remover"
                  className="px-1 text-lg leading-none text-stone-400 hover:text-red-600"
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setLinhas((ls) => [...ls, { armazem: ls[0]?.armazem ?? '', bloco: '', quadra: '', bags: '' }])}
          className="mt-2 text-sm text-green-800 underline dark:text-green-400"
        >
          + adicionar endereço
        </button>

        <div className="mt-4 flex justify-end gap-2">
          <Botao onClick={onFechar}>Cancelar</Botao>
          <Botao
            variante="primario"
            disabled={salvando || validas.length === 0}
            onClick={async () => {
              setSalvando(true)
              try {
                await onSalvar(
                  validas.map((l) => ({
                    armazem: l.armazem.trim().toUpperCase(),
                    bloco: normalizaBloco(l.bloco),
                    quadra: l.quadra.trim().toUpperCase(),
                    bags: Number(l.bags) > 0 ? Number(l.bags) : null,
                  })),
                )
              } finally {
                setSalvando(false)
              }
            }}
          >
            {salvando ? 'salvando…' : 'Salvar endereços'}
          </Botao>
        </div>
      </div>
    </div>
  )
}

/**
 * 1ª etapa — MONTAGEM da carga, com o próprio Salvar (pedido do Arion,
 * 29/08/2026): cabeçalho + cada produto (cultivar, tratamento e quantidade
 * obrigatórios), SEM lote nenhum. Salvar grava a carga "aguardando lotear";
 * os lotes são a 2ª etapa (LotearCarga), aberta pelo botão Lotear da lista.
 * Ao editar, os lotes já loteados são carregados invisíveis e preservados.
 */
function MontagemCarga({
  lotes, usuarioId, rascunho, onSalva,
}: {
  lotes: LoteMapaLinha[]
  usuarioId: string
  rascunho: Rascunho<CargaForm>
  onSalva: (msg: string) => void
}) {
  const { numero, placa, cliente, tara, veiculo, produtos, editandoId } = rascunho.valor
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const definir = rascunho.definir
  const veiculoSel = veiculoDe(veiculo)

  const cultivares = useMemo(() => [...new Set(lotes.map((l) => l.cultivar))].sort(), [lotes])

  const mudarProduto = (chave: string, patch: Partial<ProdutoCargaForm>) =>
    definir({ produtos: produtos.map((p) => (p.chave === chave ? { ...p, ...patch } : p)) })
  const removerProduto = (chave: string) =>
    definir({ produtos: produtos.filter((p) => p.chave !== chave) })

  // por lote + tratamento (a PK de lotes_mapa) — casar também pelo cultivar
  // derrubava o lote da carga quando o TEXTO do cultivar mudava num upload
  // do SAP, com aviso de motivo errado (revisão 28/08/2026)
  const loteDe = (p: ProdutoCargaForm, loteId: string) =>
    lotes.find((l) => l.lote === loteId && l.tratamento === p.tratamento)
  const selecionadosDe = (p: ProdutoCargaForm) =>
    p.itens
      .map((i) => ({ ...i, lote: loteDe(p, i.loteId) }))
      .filter((i): i is ItemCargaForm & { lote: LoteMapaLinha } => i.lote != null)

  // produtos com cultivar + tratamento definidos — os que contam pra salvar
  const completos = produtos.filter((p) => p.cultivar && p.tratamento)
  // meio-preenchido não pode ser descartado em silêncio: bloqueia o salvar
  const incompletos = produtos.filter((p) => !p.cultivar || !p.tratamento)
  // quantidade é OBRIGATÓRIA no produto (pedido do Arion, 29/08/2026)
  const semQuantidade = completos.filter((p) => !(Number(p.bags) > 0))
  const duplicados = completos.filter((p, idx) =>
    completos.some(
      (o, oidx) => oidx < idx && o.cultivar === p.cultivar && o.tratamento === p.tratamento,
    ),
  )
  // os itens vêm carregados invisíveis no Editar — o peso salvo sai deles
  const todosSelecionados = completos.flatMap((p) => selecionadosDe(p))
  const totalPesoKg = todosSelecionados.reduce(
    (s, i) => s + (Number(i.bags) || 0) * i.lote.peso_bag_kg,
    0,
  )
  const totalPedido = completos.reduce((s, p) => s + (Number(p.bags) || 0), 0)
  // carga editada pode citar lote que zerou no SAP desde então — avisar, não sumir calado
  const foraDoMapa = completos.flatMap((p) => p.itens.filter((i) => !loteDe(p, i.loteId)))
  const bloqueado =
    duplicados.length > 0 || incompletos.length > 0 || semQuantidade.length > 0

  async function salvar() {
    if (!numero.trim() || completos.length === 0 || bloqueado) return
    setSalvando(true)
    setErro(null)
    const carga = {
      numero: numero.trim(),
      peso_total_kg: Math.round(totalPesoKg * 100) / 100,
      placa: placa.trim() ? placa.trim().toUpperCase() : null,
      cliente: cliente.trim() || null,
      tara_kg: Number(tara) > 0 ? Number(tara) : null,
      veiculo: veiculo || null,
    }
    const produtosGravar = completos.map((p) => {
      const sel = selecionadosDe(p)
      return {
        cultivar: p.cultivar,
        tratamento: p.tratamento,
        bags_solicitados: Number(p.bags) || sel.reduce((s, i) => s + (Number(i.bags) || 0), 0),
        itens: sel.map((i) => ({
          lote_id: i.loteId,
          bags: Number(i.bags) || 0,
          peso_kg: Math.round((Number(i.bags) || 0) * i.lote.peso_bag_kg * 100) / 100,
          destinacao: i.lote.destinacao,
        })),
      }
    })
    try {
      if (editandoId) await m.atualizarCargaMontada(editandoId, carga, produtosGravar)
      else await m.criarCargaMontada(carga, produtosGravar, usuarioId)
      const pendentes = produtosGravar.filter((x) => x.itens.length === 0).length
      const texto = editandoId
        ? `Carga ${carga.numero} atualizada.`
        : pendentes > 0
          ? `Carga ${carga.numero} gravada — aguardando lotear.`
          : `Carga ${carga.numero} gravada.`
      rascunho.limpar()
      onSalva(texto)
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    } finally {
      setSalvando(false)
    }
  }

  return (
    <Cartao titulo="Montagem de carga" className="mb-5">
      {erro && <Erro>{erro}</Erro>}
      {editandoId && (
        <div className="mb-3">
          <Aviso gravidade="alerta">
            Editando a carga <b>{numero}</b> — salvar SUBSTITUI a carga salva.{' '}
            <button type="button" onClick={() => rascunho.limpar()} className="underline">
              cancelar edição
            </button>
          </Aviso>
        </div>
      )}
      {/* etapa 1: o cabeçalho da ordem de carregamento */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={numero}
          onChange={(e) => definir({ numero: e.target.value })}
          placeholder="nº da ordem de carregamento"
          className={`${INPUT} w-56`}
        />
        <input
          value={placa}
          onChange={(e) => definir({ placa: e.target.value })}
          placeholder="placa do veículo (opc.)"
          className={`${INPUT} w-44`}
        />
        <input
          value={cliente}
          onChange={(e) => definir({ cliente: e.target.value })}
          placeholder="cliente (opc.)"
          className={`${INPUT} w-56`}
        />
        <input
          type="number"
          min={0}
          value={tara}
          onChange={(e) => definir({ tara: e.target.value })}
          placeholder="tara do veículo (kg, opc.)"
          className={`${INPUT} w-48`}
        />
        <select
          value={veiculo}
          onChange={(e) => definir({ veiculo: e.target.value })}
          className={INPUT}
        >
          <option value="">veículo (pro croqui)…</option>
          {VEICULOS_CARGA.map((v) => (
            <option key={v.id} value={v.id}>{v.nome} — {v.capacidadeBags} bg</option>
          ))}
        </select>
      </div>

      {/* a carga inteira — todos os produtos, nenhum lote nesta etapa */}
      <p className="mt-4 mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">
        Produtos da carga ({completos.length})
      </p>
      {produtos.length === 0 && (
        <p className="mb-1 text-sm text-stone-500 dark:text-stone-400">
          Monte a carga — cultivar, tratamento e quantidade de cada produto — e salve.
          A carga fica <b>aguardando lotear</b>; os lotes são escolhidos depois, pelo
          botão Lotear da lista de cargas.
        </p>
      )}
      <div className="space-y-2">
        {produtos.map((p) => (
          <ProdutoLinha
            key={p.chave}
            produto={p}
            lotes={lotes}
            cultivares={cultivares}
            duplicado={duplicados.includes(p)}
            onMudar={(patch) => mudarProduto(p.chave, patch)}
            onRemover={() => removerProduto(p.chave)}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={() => definir({ produtos: [...produtos, produtoVazio()] })}
        className="mt-2 text-sm text-green-800 underline dark:text-green-400"
      >
        + adicionar produto
      </button>

      {duplicados.length > 0 && (
        <div className="mt-3">
          <Aviso gravidade="bloqueio">
            Produto repetido na carga:{' '}
            {duplicados.map((p) => `${p.cultivar} · ${rotuloTratamento(p.tratamento)}`).join(' · ')}
            {' '}— junte as quantidades numa linha só.
          </Aviso>
        </div>
      )}
      {produtos.length > 0 && incompletos.length > 0 && (
        <div className="mt-3">
          <Aviso gravidade="alerta">
            {incompletos.length} produto(s) sem cultivar ou tratamento — complete ou
            remova (×) antes de salvar.
          </Aviso>
        </div>
      )}
      {semQuantidade.length > 0 && (
        <div className="mt-3">
          <Aviso gravidade="alerta">
            A quantidade de bags é obrigatória — falta em:{' '}
            {semQuantidade
              .map((p) => `${p.cultivar} · ${rotuloTratamento(p.tratamento)}`)
              .join(' · ')}
          </Aviso>
        </div>
      )}
      {foraDoMapa.length > 0 && (
        <div className="mt-3">
          <Aviso gravidade="alerta">
            Lote(s) desta carga que saíram do saldo do SAP e por isso saem da carga ao
            salvar: {foraDoMapa.map((i) => i.loteId).join(' · ')}
          </Aviso>
        </div>
      )}
      {veiculoSel && totalPedido > veiculoSel.capacidadeBags && (
        <div className="mt-3">
          <Aviso gravidade="alerta">
            A carga pede <b>{inteiro(totalPedido)} bags</b> — acima da capacidade do{' '}
            {veiculoSel.nome} ({veiculoSel.capacidadeBags} bg). Aviso apenas; não bloqueia.
          </Aviso>
        </div>
      )}

      {produtos.length > 0 && (
        <div className="mt-4">
          <p className="text-sm font-medium text-stone-600 dark:text-stone-300">
            Total pedido: <b>{inteiro(totalPedido)} bags</b>
          </p>
          <div className="mt-3 flex gap-2">
            <Botao
              variante="primario"
              disabled={salvando || !numero.trim() || completos.length === 0 || bloqueado}
              onClick={salvar}
            >
              {salvando ? 'gravando…' : editandoId ? 'Salvar alterações' : 'Salvar carga'}
            </Botao>
            <Botao onClick={() => rascunho.limpar()}>Limpar</Botao>
          </div>
        </div>
      )}
    </Cartao>
  )
}

/**
 * 2ª etapa — LOTEAR uma carga já salva, com o próprio Salvar (29/08/2026):
 * escolhe os lotes produto a produto e grava. Sobrou produto sem lote, a
 * carga continua "aguardando lotear" e o botão Lotear permanece na lista.
 */
function LotearCarga({
  carga, lotes, alocacoes, comprometidos, consumoOrdens, rascunho, onFechar, onSalva,
}: {
  carga: CargaMontadaLinha
  lotes: LoteMapaLinha[]
  alocacoes: Alocacao[]
  comprometidos: LoteComprometido[]
  consumoOrdens: ConsumoOrdens[]
  rascunho: Rascunho<LotearForm>
  onFechar: () => void
  onSalva: (msg: string) => void
}) {
  const { produtos } = rascunho.valor
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  // acordeão: só a lista de UM produto aberta por vez — 10 produtos com as
  // listas todas abertas viravam rolagem sem fim (pedido do Arion, 29/08/2026)
  const [aberto, setAberto] = useState<string | null>(
    produtos.length === 1 ? produtos[0].chave : null,
  )

  const mudarProduto = (chave: string, patch: Partial<ProdutoCargaForm>) =>
    rascunho.definir({
      produtos: produtos.map((p) => (p.chave === chave ? { ...p, ...patch } : p)),
    })

  const loteDe = (p: ProdutoCargaForm, loteId: string) =>
    lotes.find((l) => l.lote === loteId && l.tratamento === p.tratamento)
  const selecionadosDe = (p: ProdutoCargaForm) =>
    p.itens
      .map((i) => ({ ...i, lote: loteDe(p, i.loteId) }))
      .filter((i): i is ItemCargaForm & { lote: LoteMapaLinha } => i.lote != null)

  /** Bags do lote já tomados por OUTRAS cargas salvas — o saldo não pode ser loteado 2×. */
  const usadoFora = (tratamento: string, loteId: string) =>
    comprometidos
      .filter(
        (x) => x.carga_id !== carga.id && x.tratamento === tratamento && x.lote_id === loteId,
      )
      .reduce((s, x) => s + x.bags, 0)

  /**
   * Saldo real do lote: o do SAP menos outras cargas E menos as ordens de
   * produção abertas (só semente branca — ordem consome lote SEM TSI; o
   * peso da ordem vira bags DO LOTE dividindo pelo peso do bag dele).
   */
  const saldoDe = (p: ProdutoCargaForm, l: LoteMapaLinha) => {
    const emCargas = usadoFora(p.tratamento, l.lote)
    const emOrdens =
      p.tratamento === SEM_TSI && l.peso_bag_kg > 0
        ? (consumoOrdens.find((x) => x.lote_id === l.lote)?.peso_kg ?? 0) / l.peso_bag_kg
        : 0
    return {
      emCargas,
      emOrdens,
      disponivel: Math.max(0, l.bags - emCargas - emOrdens),
    }
  }

  const todosSelecionados = produtos.flatMap((p) =>
    selecionadosDe(p).map((i) => ({ ...i, disponivel: saldoDe(p, i.lote).disponivel })),
  )
  // bags vazio/0 derrubaria o check (bags > 0) do banco — travar antes
  const itensInvalidos = todosSelecionados.filter((i) => !(Number(i.bags) > 0))
  // mais do que o saldo menos o que já está em outras cargas: travado
  const excedidos = todosSelecionados.filter((i) => Number(i.bags) > i.disponivel)
  const semQuantidade = produtos.filter((p) => !(Number(p.bags) > 0))
  // não se loteia MAIS que o pedido do produto (regra do Arion, 30/08/2026)
  const pedidoExcedido = produtos
    .map((p) => ({
      p,
      soma: selecionadosDe(p).reduce((s, i) => s + (Number(i.bags) || 0), 0),
      pedido: Number(p.bags) || 0,
    }))
    .filter((x) => x.pedido > 0 && x.soma > x.pedido)
  const comDestinacao = todosSelecionados.filter((i) => i.lote.destinacao)
  const foraDoMapa = produtos.flatMap((p) => p.itens.filter((i) => !loteDe(p, i.loteId)))
  const totalBags = todosSelecionados.reduce((s, i) => s + (Number(i.bags) || 0), 0)
  const totalPesoKg = todosSelecionados.reduce(
    (s, i) => s + (Number(i.bags) || 0) * i.lote.peso_bag_kg,
    0,
  )
  const bloqueado =
    itensInvalidos.length > 0 ||
    semQuantidade.length > 0 ||
    excedidos.length > 0 ||
    pedidoExcedido.length > 0

  async function salvar() {
    if (bloqueado) return
    setSalvando(true)
    setErro(null)
    const produtosGravar = produtos.map((p) => {
      const sel = selecionadosDe(p)
      return {
        cultivar: p.cultivar,
        tratamento: p.tratamento,
        bags_solicitados: Number(p.bags) || 0,
        itens: sel.map((i) => ({
          lote_id: i.loteId,
          bags: Number(i.bags) || 0,
          peso_kg: Math.round((Number(i.bags) || 0) * i.lote.peso_bag_kg * 100) / 100,
          destinacao: i.lote.destinacao,
        })),
      }
    })
    try {
      await m.atualizarCargaMontada(
        carga.id,
        {
          numero: carga.numero,
          peso_total_kg: Math.round(totalPesoKg * 100) / 100,
          placa: carga.placa,
          cliente: carga.cliente,
          tara_kg: carga.tara_kg,
          veiculo: carga.veiculo,
        },
        produtosGravar,
      )
      const pendentes = produtosGravar.filter((x) => x.itens.length === 0).length
      rascunho.limpar()
      onSalva(
        pendentes > 0
          ? `Carga ${carga.numero} salva — ${pendentes} produto(s) ainda sem lote.`
          : `Carga ${carga.numero} loteada.`,
      )
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    } finally {
      setSalvando(false)
    }
  }

  return (
    <div className="rounded-lg border-2 border-green-700/40 bg-white p-4 dark:border-green-500/30 dark:bg-stone-900">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold">Lotear carga {carga.numero}</h3>
        <Botao onClick={onFechar}>Fechar sem salvar</Botao>
      </div>
      <p className="mt-1 mb-3 text-sm text-stone-500 dark:text-stone-400">
        {[carga.placa, carga.cliente].filter(Boolean).join(' · ') || 'sem placa/cliente'} ·
        escolha os lotes de cada produto e salve — produto pode ficar pra depois (a carga
        continua aguardando lotear).
      </p>

      {erro && <Erro>{erro}</Erro>}

      <div className="space-y-3">
        {produtos.map((p) => (
          <ProdutoLotes
            key={p.chave}
            produto={p}
            lotes={lotes}
            alocacoes={alocacoes}
            selecionados={selecionadosDe(p)}
            saldoDe={(l) => saldoDe(p, l)}
            aberto={aberto === p.chave}
            onAlternar={() => setAberto((a) => (a === p.chave ? null : p.chave))}
            onMudar={(patch) => mudarProduto(p.chave, patch)}
          />
        ))}
      </div>

      {semQuantidade.length > 0 && (
        <div className="mt-3">
          <Aviso gravidade="alerta">
            A quantidade pedida é obrigatória — falta em:{' '}
            {semQuantidade
              .map((p) => `${p.cultivar} · ${rotuloTratamento(p.tratamento)}`)
              .join(' · ')}
          </Aviso>
        </div>
      )}
      {excedidos.length > 0 && (
        <div className="mt-3">
          <Aviso gravidade="bloqueio">
            Mais bags que o disponível do lote (o saldo desconta o que JÁ está em outras
            cargas):{' '}
            {excedidos
              .map((i) => `${i.loteId} (${inteiro(Number(i.bags))} > ${inteiro(i.disponivel)} disp.)`)
              .join(' · ')}
          </Aviso>
        </div>
      )}
      {pedidoExcedido.length > 0 && (
        <div className="mt-3">
          <Aviso gravidade="bloqueio">
            Mais bags que o PEDIDO do produto:{' '}
            {pedidoExcedido
              .map(
                (x) =>
                  `${x.p.cultivar} · ${rotuloTratamento(x.p.tratamento)} (${inteiro(x.soma)} > ${inteiro(x.pedido)})`,
              )
              .join(' · ')}
            {' '}— ajuste as quantidades pra salvar.
          </Aviso>
        </div>
      )}
      {comDestinacao.length > 0 && (
        <div className="mt-3">
          <Aviso gravidade="bloqueio">
            <b>Atenção:</b> lote(s) com DESTINAÇÃO no SAP selecionado(s):{' '}
            {comDestinacao.map((i) => `${i.loteId} → ${i.lote.destinacao}`).join(' · ')}
          </Aviso>
        </div>
      )}
      {foraDoMapa.length > 0 && (
        <div className="mt-3">
          <Aviso gravidade="alerta">
            Fora do mapa (saíram do saldo do SAP) e por isso FORA da carga:{' '}
            {foraDoMapa.map((i) => i.loteId).join(' · ')}
          </Aviso>
        </div>
      )}
      {itensInvalidos.length > 0 && (
        <div className="mt-3">
          <Aviso gravidade="alerta">
            Lote(s) com bags em branco ou zero:{' '}
            {itensInvalidos.map((i) => i.loteId).join(' · ')} — informe a quantidade ou
            remova o lote.
          </Aviso>
        </div>
      )}

      <div className="mt-4">
        <p className="text-sm font-medium text-stone-600 dark:text-stone-300">
          Total da carga: <b>{inteiro(totalBags)} bags</b> ·{' '}
          <b>{inteiro(totalPesoKg)} kg</b> ({n(totalPesoKg / 1000, 1)} t)
        </p>
        <div className="mt-3 flex gap-2">
          <Botao variante="primario" disabled={salvando || bloqueado} onClick={salvar}>
            {salvando ? 'gravando…' : 'Salvar lotes'}
          </Botao>
        </div>
      </div>
    </div>
  )
}

/**
 * 1ª etapa — uma LINHA de produto: cultivar + tratamento + quantidade,
 * todos obrigatórios. Nenhum lote aqui: a carga inteira é montada antes, e
 * os lotes vêm todos juntos na 2ª etapa (pedido do Arion, 29/08/2026).
 */
function ProdutoLinha({
  produto: p, lotes, cultivares, duplicado, onMudar, onRemover,
}: {
  produto: ProdutoCargaForm
  lotes: LoteMapaLinha[]
  cultivares: string[]
  duplicado: boolean
  onMudar: (patch: Partial<ProdutoCargaForm>) => void
  onRemover: () => void
}) {
  const tratamentosDoCultivar = useMemo(
    () =>
      [...new Set(
        lotes
          .filter((l) => !p.cultivar || l.cultivar === p.cultivar)
          .map((l) => l.tratamento)
          .filter((t) => t !== SEM_TSI),
      )].sort(),
    [lotes, p.cultivar],
  )

  return (
    <div
      className={`flex flex-wrap items-center gap-2 rounded-lg border p-2.5 ${duplicado ? 'border-red-400 dark:border-red-700' : 'border-stone-200 dark:border-stone-700'}`}
    >
      {/* trocar cultivar/tratamento descarta os lotes já escolhidos na 2ª etapa */}
      <select
        value={p.cultivar}
        onChange={(e) => onMudar({ cultivar: e.target.value, tratamento: '', itens: [] })}
        className={INPUT}
      >
        <option value="">cultivar…</option>
        {cultivares.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <select
        value={p.tratamento}
        onChange={(e) => onMudar({ tratamento: e.target.value, itens: [] })}
        className={INPUT}
      >
        <option value="">tratamento…</option>
        <option value={SEM_TSI}>SEM TSI (branca)</option>
        {tratamentosDoCultivar.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <input
        type="number"
        min={1}
        value={p.bags}
        onChange={(e) => onMudar({ bags: e.target.value })}
        placeholder="bags *"
        className={`${INPUT} w-24 ${
          p.cultivar && p.tratamento && !(Number(p.bags) > 0)
            ? 'border-red-400 dark:border-red-700'
            : ''
        }`}
      />
      {p.itens.length > 0 && (
        <span className="text-xs text-stone-500 dark:text-stone-400">
          {p.itens.length} lote(s) escolhido(s)
        </span>
      )}
      <button
        type="button"
        onClick={onRemover}
        title="Remover produto"
        className="ml-auto px-1 text-lg leading-none text-stone-400 hover:text-red-600"
      >
        ×
      </button>
    </div>
  )
}

/**
 * 2ª etapa — os lotes de UM produto, RECOLHIDO por padrão (acordeão): com
 * vários produtos, as listas todas abertas viravam rolagem sem fim. Os
 * candidatos saem ordenados pelo que tem MENOS material na frente do box
 * (menos remoção pra alcançar), com a classe do lote e o saldo já
 * descontando o que outras cargas tomaram (29/08/2026).
 */
function ProdutoLotes({
  produto: p, lotes, alocacoes, selecionados, saldoDe, aberto, onAlternar, onMudar,
}: {
  produto: ProdutoCargaForm
  lotes: LoteMapaLinha[]
  alocacoes: Alocacao[]
  selecionados: (ItemCargaForm & { lote: LoteMapaLinha })[]
  saldoDe: (l: LoteMapaLinha) => { disponivel: number; emCargas: number; emOrdens: number }
  aberto: boolean
  onAlternar: () => void
  onMudar: (patch: Partial<ProdutoCargaForm>) => void
}) {
  const [buscaLote, setBuscaLote] = useState('')

  const candidatos = useMemo(() => {
    if (!p.cultivar || !p.tratamento) return []
    return lotes
      .filter((l) => l.cultivar === p.cultivar && l.tratamento === p.tratamento && l.bags > 0)
      .map((l) => ({
        lote: l,
        frente: bagsNaFrenteDe(l, alocacoes),
        ...saldoDe(l),
      }))
      .sort((a, b) => {
        // esgotado (cargas + ordens) vai pro fim; depois, menos material na
        // frente primeiro; sem endereço numérico não ranqueia (fim)
        if (a.disponivel > 0 !== b.disponivel > 0) return a.disponivel > 0 ? -1 : 1
        if ((a.frente == null) !== (b.frente == null)) return a.frente == null ? 1 : -1
        if (a.frente != null && b.frente != null && a.frente !== b.frente) {
          return a.frente - b.frente
        }
        return maiorQuadra(b.lote) - maiorQuadra(a.lote)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lotes, alocacoes, p.cultivar, p.tratamento, selecionados.length])

  const filtrados = useMemo(() => {
    const b = buscaLote.trim().toLowerCase()
    if (!b) return candidatos
    return candidatos.filter(
      (c) =>
        c.lote.lote.toLowerCase().includes(b) ||
        enderecoDe(c.lote).toLowerCase().includes(b) ||
        (c.lote.classificacao ?? '').toLowerCase().includes(b),
    )
  }, [candidatos, buscaLote])

  const solicitados = Number(p.bags) || 0
  const bagsDoProduto = selecionados.reduce((s, i) => s + (Number(i.bags) || 0), 0)
  const pesoDoProduto = selecionados.reduce(
    (s, i) => s + (Number(i.bags) || 0) * i.lote.peso_bag_kg,
    0,
  )
  const completo = solicitados > 0 && bagsDoProduto >= solicitados
  const excedeu = solicitados > 0 && bagsDoProduto > solicitados

  const adicionar = (l: LoteMapaLinha, disponivel: number) => {
    if (p.itens.some((i) => i.loteId === l.lote) || disponivel <= 0) return
    // nunca além do PEDIDO: pedido completo não recebe mais lote (30/08/2026)
    const restante = Math.max(0, solicitados - bagsDoProduto)
    if (restante <= 0) return
    const sugestao = Math.min(restante, disponivel)
    onMudar({ itens: [...p.itens, { loteId: l.lote, bags: String(sugestao) }] })
  }
  const atualizarBags = (loteId: string, v: string) =>
    onMudar({ itens: p.itens.map((i) => (i.loteId === loteId ? { ...i, bags: v } : i)) })
  const remover = (loteId: string) =>
    onMudar({ itens: p.itens.filter((i) => i.loteId !== loteId) })

  return (
    <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-700">
      {/* cabeçalho sempre visível; a lista abre pelo botão (acordeão) */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="text-sm font-semibold">
          {p.cultivar} · {rotuloTratamento(p.tratamento)}
        </p>
        <label className="flex items-center gap-1.5 text-xs text-stone-500 dark:text-stone-400">
          pedido
          <input
            type="number"
            min={1}
            value={p.bags}
            onChange={(e) => onMudar({ bags: e.target.value })}
            className={`${INPUT} w-20 py-1 ${!(Number(p.bags) > 0) ? 'border-red-400 dark:border-red-700' : ''}`}
          />
          bg
        </label>
        <span
          className={`text-sm ${
            excedeu
              ? 'font-medium text-red-700 dark:text-red-400'
              : completo
                ? 'font-medium text-green-700 dark:text-green-400'
                : 'text-stone-500 dark:text-stone-400'
          }`}
        >
          {excedeu ? '⚠ ' : completo ? '✓ ' : ''}
          {inteiro(bagsDoProduto)}
          {solicitados > 0 ? ` de ${inteiro(solicitados)}` : ''} bg em lotes ·{' '}
          {inteiro(pesoDoProduto)} kg
        </span>
        <div className="ml-auto">
          <Botao variante={aberto || completo ? 'normal' : 'primario'} onClick={onAlternar}>
            {aberto ? 'Fechar lotes' : selecionados.length > 0 ? 'Ajustar lotes' : 'Escolher lotes'}
          </Botao>
        </div>
      </div>

      {/* recolhido: só o resumo do que já foi escolhido */}
      {!aberto && selecionados.length > 0 && (
        <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">
          {selecionados
            .map((i) => `${i.loteId} (${inteiro(Number(i.bags) || 0)} bg)`)
            .join(' · ')}
        </p>
      )}

      {aberto && (
        <>
          <div className="mt-3 mb-1 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">
              Lotes disponíveis ({filtrados.length}
              {buscaLote.trim() ? ` de ${candidatos.length}` : ''}) — menos material na
              frente primeiro
            </p>
            <input
              value={buscaLote}
              onChange={(e) => setBuscaLote(e.target.value)}
              placeholder="buscar lote, endereço ou classe…"
              className={`${INPUT} w-64 py-1.5`}
            />
          </div>
          {candidatos.length === 0 ? (
            <Vazio>Nenhum lote de {p.cultivar} · {rotuloTratamento(p.tratamento)} no mapa.</Vazio>
          ) : filtrados.length === 0 ? (
            <p className="rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-500 dark:border-stone-700 dark:text-stone-400">
              Nenhum lote casa com “{buscaLote.trim()}”.
            </p>
          ) : (
            <div className="max-h-72 overflow-y-auto rounded-lg border border-stone-200 dark:border-stone-700">
              {filtrados.map((c) => {
                const l = c.lote
                const jaSelecionado = p.itens.some((i) => i.loteId === l.lote)
                const esgotado = c.disponivel <= 0
                const pedidoCompleto = completo && !jaSelecionado
                const detalhes = [
                  c.emCargas > 0 ? `${inteiro(c.emCargas)} em outras cargas` : null,
                  c.emOrdens > 0 ? `${inteiro(c.emOrdens)} em ordens de produção` : null,
                ].filter(Boolean)
                return (
                  <button
                    key={chaveDe(l)}
                    type="button"
                    disabled={jaSelecionado || esgotado || pedidoCompleto}
                    onClick={() => adicionar(l, c.disponivel)}
                    className={`flex w-full items-center justify-between gap-2 border-b border-stone-100 px-3 py-1.5 text-left text-xs last:border-b-0 dark:border-stone-800/60 ${
                      jaSelecionado || esgotado || pedidoCompleto
                        ? 'opacity-40'
                        : l.destinacao
                          ? 'bg-red-50 hover:bg-red-100 dark:bg-red-950/30 dark:hover:bg-red-950/50'
                          : 'hover:bg-stone-100 dark:hover:bg-stone-800'
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="font-medium">{l.lote}</span> ·{' '}
                      <b>{inteiro(c.disponivel)} bg disp.</b>
                      {detalhes.length > 0 && (
                        <span className="text-stone-500"> ({detalhes.join(' · ')})</span>
                      )}
                      {l.classificacao && (
                        <span className="ml-1.5">
                          <Tag cor="neutro">{l.classificacao}</Tag>
                        </span>
                      )}
                      <span className="block text-[10px] text-stone-500 dark:text-stone-400">
                        {enderecoDe(l) || 'sem endereço'}
                        {c.frente != null &&
                          ` · ${c.frente === 0 ? 'nada na frente' : `~${inteiro(c.frente)} bg na frente`}`}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {l.destinacao
                        ? <Tag cor="perigo">{l.destinacao}</Tag>
                        : <Tag cor="ok">livre</Tag>}
                      <span className={jaSelecionado || esgotado || pedidoCompleto ? 'text-stone-400' : 'font-medium text-green-800 dark:text-green-400'}>
                        {jaSelecionado
                          ? 'na carga'
                          : esgotado
                            ? 'esgotado'
                            : pedidoCompleto
                              ? 'pedido completo'
                              : '+ adicionar'}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {selecionados.length > 0 && (
            <div className="mt-3">
              <Tabela cabecalho={['Lote', 'Classe', 'Endereço', '#Bags', '#Peso (kg)', 'Destinação', '']}>
                {selecionados.map((i) => {
                  const { disponivel } = saldoDe(i.lote)
                  const excede = Number(i.bags) > disponivel
                  return (
                    <tr key={i.loteId} className="border-t border-stone-100 dark:border-stone-800/60">
                      <td className="px-2 py-1.5 font-medium">{i.loteId}</td>
                      <td className="px-2 py-1.5 text-xs text-stone-500">
                        {i.lote.classificacao || '—'}
                      </td>
                      <td className="px-2 py-1.5 text-xs text-stone-500">
                        {enderecoDe(i.lote) || '—'}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <input
                          type="number"
                          min={1}
                          max={disponivel}
                          value={i.bags}
                          onChange={(e) => atualizarBags(i.loteId, e.target.value)}
                          className={`${INPUT} w-20 py-1 text-right ${excede ? 'border-red-400 dark:border-red-700' : ''}`}
                        />
                        <span className="block text-[10px] text-stone-400">
                          de {inteiro(disponivel)} disp.
                        </span>
                      </td>
                      <td className="num-tabular px-2 py-1.5 text-right">
                        {inteiro((Number(i.bags) || 0) * i.lote.peso_bag_kg)}
                      </td>
                      <td className="px-2 py-1.5">
                        {i.lote.destinacao
                          ? <Tag cor="perigo">{i.lote.destinacao}</Tag>
                          : <Tag cor="ok">livre</Tag>}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <button
                          type="button"
                          onClick={() => remover(i.loteId)}
                          className="text-xs text-stone-400 underline hover:text-red-600"
                        >
                          remover
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </Tabela>
            </div>
          )}
        </>
      )}
    </div>
  )
}
