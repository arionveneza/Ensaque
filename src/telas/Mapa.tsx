import { useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from 'react'
import readXlsxFile from 'read-excel-file/browser'
import * as m from '@/dados/api-mapa'
import type {
  CargaMontadaLinha, EnderecoLote, LoteMapaLinha, ProdutoCargaLinha,
} from '@/dados/api-mapa'
import {
  converterLotesMapa, DEPOSITO_MAPA, ehRelatorioMapa, SEM_TSI, type ResultadoLotesMapa,
} from '@/dominio/importacao/mapa'
import type { Linha } from '@/dominio/importacao/simpleagro'
import { useAuth } from '@/auth/AuthProvider'
import { useRealtime } from '@/dados/useRealtime'
import { useRascunho, type Rascunho } from '@/lib/useRascunho'
import { imprimirOrdemCarregamento } from '@/lib/exportar'
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

/** Rascunho da carga em montagem — editandoId preenchido = editando carga salva. */
interface CargaForm {
  numero: string
  placa: string
  cliente: string
  tara: string
  produtos: ProdutoCargaForm[]
  editandoId: string
  /** 1ª etapa monta a carga inteira (produtos); a 2ª escolhe os lotes (29/08/2026). */
  etapa: 'produtos' | 'lotes'
}

const CARGA_VAZIA: CargaForm = {
  numero: '', placa: '', cliente: '', tara: '', produtos: [], editandoId: '', etapa: 'produtos',
}

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
      editandoId: typeof v.editandoId === 'string' ? v.editandoId : '',
      etapa: 'produtos',
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

export default function Mapa() {
  const { usuario, permitido } = useAuth()
  const podeImportar = permitido('mapa', 'importar')
  const podeEnderecar = permitido('mapa', 'enderecar')
  const podeMontar = permitido('mapa', 'montar_carga')

  const [lotes, setLotes] = useState<LoteMapaLinha[] | null>([])
  const [cargas, setCargas] = useState<CargaMontadaLinha[]>([])
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [previa, setPrevia] = useState<ResultadoLotesMapa | null>(null)
  const [importando, setImportando] = useState(false)
  const [enderecando, setEnderecando] = useState<LoteMapaLinha | null>(null)
  const [posicao, setPosicao] = useState<Posicao | null>(null)
  const [movendo, setMovendo] = useState<Alocacao | null>(null)

  const recarregar = () =>
    Promise.all([m.listarLotesMapa(), m.listarCargasMontadas()])
      .then(([l, c]) => {
        setLotes(l)
        setCargas(c)
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

  // rascunho da carga em montagem mora AQUI (não no cartão) de propósito:
  // o "+ Carga" do detalhe da posição e o "editar" das cargas salvas
  // escrevem nele de fora (pedido do Arion, 28/08/2026)
  const rascunhoCarga = useRascunho<CargaForm>('mapa.carga', CARGA_VAZIA)

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

  /**
   * "+ Carga" do detalhe da posição: joga o lote na carga em montagem, no
   * produto da combinação dele — criando o produto se ainda não existe
   * (a carga leva vários produtos, 28/08/2026).
   */
  function adicionarNaCarga(l: LoteMapaLinha) {
    const c = rascunhoCarga.valor
    const existente = c.produtos.find(
      (p) => p.cultivar === l.cultivar && p.tratamento === l.tratamento,
    )
    if (existente?.itens.some((i) => i.loteId === l.lote)) {
      setMsg(`${l.lote} já está na carga em montagem.`)
      return
    }
    const item = { loteId: l.lote, bags: String(l.bags) }
    rascunhoCarga.definir({
      etapa: 'lotes',
      produtos: existente
        ? c.produtos.map((p) =>
            p.chave === existente.chave ? { ...p, itens: [...p.itens, item] } : p,
          )
        : [
            ...c.produtos,
            { chave: novaChave(), cultivar: l.cultivar, tratamento: l.tratamento, bags: '', itens: [item] },
          ],
    })
    setMsg(
      `${l.lote} adicionado à carga em montagem (produto ${l.cultivar} · ${rotuloTratamento(l.tratamento)}).`,
    )
  }

  /** Reabre uma carga salva pra edição — o rascunho vira a carga. */
  function editarCarga(c: CargaMontadaLinha) {
    rascunhoCarga.substituir({
      numero: c.numero,
      placa: c.placa ?? '',
      cliente: c.cliente ?? '',
      tara: c.tara_kg != null ? String(c.tara_kg) : '',
      produtos: c.carga_montada_produtos.map((p) => ({
        chave: novaChave(),
        cultivar: p.cultivar,
        tratamento: p.tratamento,
        bags: String(p.bags_solicitados || ''),
        itens: p.carga_montada_itens.map((i) => ({ loteId: i.lote_id, bags: String(i.bags) })),
      })),
      editandoId: c.id,
      // quem edita normalmente vem completar os lotes — abre direto na 2ª etapa
      etapa: 'lotes',
    })
    setMsg(`Editando a carga ${c.numero} — salve na Montagem de carga abaixo.`)
  }

  async function excluirCarga(c: CargaMontadaLinha) {
    if (!confirm(`Excluir a ordem de carregamento ${c.numero}?`)) return
    try {
      await m.excluirCargaMontada(c.id)
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
    const celulaCarga = (
      <td rowSpan={totalLinhas} className="px-2 py-1.5 align-top">
        <span className="font-medium">{c.numero}</span>
        <span className="block text-xs text-stone-500">
          {inteiro(totalBags)} bg · {inteiro(c.peso_total_kg)} kg
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
            <Botao onClick={() => imprimirCarga(c)}>Imprimir</Botao>
            {podeMontar && <Botao onClick={() => editarCarga(c)}>Editar</Botao>}
            {podeMontar && (
              <button
                type="button"
                onClick={() => void excluirCarga(c)}
                className="px-1 text-xs text-stone-400 underline hover:text-red-600"
              >
                excluir
              </button>
            )}
          </div>
        </td>
      </>
    )

    if (produtos.length === 0) {
      return [
        <tr key={c.id} className="border-t-2 border-stone-200 dark:border-stone-700">
          {celulaCarga}
          <td colSpan={4} className="px-2 py-1.5 text-xs italic text-stone-400">
            sem produtos
          </td>
          {celulasFinais}
        </tr>,
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

      {/* -------- montagem de carga -------- */}
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
          onFechar={() => setPosicao(null)}
          onMover={(a) => {
            setMovendo(a)
            setPosicao(null)
          }}
          onEnderecar={(l) => {
            setEnderecando(l)
            setPosicao(null)
          }}
          onAdicionarCarga={(l) => {
            adicionarNaCarga(l)
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
  posicao, alocacoes, podeEnderecar, podeMontar, onFechar, onMover, onEnderecar, onAdicionarCarga,
}: {
  posicao: Posicao
  alocacoes: Alocacao[]
  podeEnderecar: boolean
  podeMontar: boolean
  onFechar: () => void
  onMover: (a: Alocacao) => void
  onEnderecar: (l: LoteMapaLinha) => void
  onAdicionarCarga: (l: LoteMapaLinha) => void
}) {
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
              {(podeEnderecar || podeMontar) && (
                <div className="flex shrink-0 gap-2">
                  {podeMontar && (
                    <Botao onClick={() => onAdicionarCarga(a.lote)}>+ Carga</Botao>
                  )}
                  {podeEnderecar && (
                    <>
                      <Botao onClick={() => onMover(a)}>Mover</Botao>
                      <Botao onClick={() => onEnderecar(a.lote)}>Endereços</Botao>
                    </>
                  )}
                </div>
              )}
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
 * Montagem de carga da Balança, em DUAS etapas (pedido do Arion,
 * 28/08/2026): primeiro a ordem de carregamento — cabeçalho e cada PRODUTO
 * que vai na carga (cultivar + tratamento + bags) — e depois os lotes,
 * produto a produto. Produto sem lote pode ser salvo: a ordem nasce antes,
 * os lotes entram editando a carga. Rascunho persistente vem do pai — o
 * "+ Carga" do mapa e o editar das cargas salvas escrevem nele.
 */
function MontagemCarga({
  lotes, usuarioId, rascunho, onSalva,
}: {
  lotes: LoteMapaLinha[]
  usuarioId: string
  rascunho: Rascunho<CargaForm>
  onSalva: (msg: string) => void
}) {
  const { numero, placa, cliente, tara, produtos, editandoId, etapa } = rascunho.valor
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const definir = rascunho.definir

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
  const todosSelecionados = completos.flatMap((p) => selecionadosDe(p))
  // bags vazio/0 derrubaria o check (bags > 0) do banco — travar antes
  const itensInvalidos = todosSelecionados.filter((i) => !(Number(i.bags) > 0))
  const totalBags = todosSelecionados.reduce((s, i) => s + (Number(i.bags) || 0), 0)
  const totalPesoKg = todosSelecionados.reduce(
    (s, i) => s + (Number(i.bags) || 0) * i.lote.peso_bag_kg,
    0,
  )
  const comDestinacao = todosSelecionados.filter((i) => i.lote.destinacao)
  // carga editada pode citar lote que zerou no SAP desde então — avisar, não sumir calado
  const foraDoMapa = completos.flatMap((p) => p.itens.filter((i) => !loteDe(p, i.loteId)))
  const bloqueado =
    duplicados.length > 0 ||
    incompletos.length > 0 ||
    semQuantidade.length > 0 ||
    itensInvalidos.length > 0

  // pode avançar pra 2ª etapa: carga inteira montada, sem pendência de produto
  const prontoParaLotes =
    !!numero.trim() &&
    completos.length > 0 &&
    incompletos.length === 0 &&
    semQuantidade.length === 0 &&
    duplicados.length === 0
  // rascunho estranho (ex.: produtos todos removidos na 2ª etapa) volta pra 1ª
  const etapaEfetiva = etapa === 'lotes' && completos.length === 0 ? 'produtos' : etapa

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
      const texto = editandoId ? `Carga ${carga.numero} atualizada.` : 'Carga gravada.'
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
      </div>

      {etapaEfetiva === 'produtos' ? (
        <>
          {/* 1ª etapa: a carga INTEIRA — todos os produtos, nenhum lote ainda */}
          <p className="mt-4 mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">
            1ª etapa · Produtos da carga ({completos.length})
          </p>
          {produtos.length === 0 && (
            <p className="mb-1 text-sm text-stone-500 dark:text-stone-400">
              Monte a carga inteira primeiro — cultivar, tratamento e quantidade de cada
              produto. Os lotes são escolhidos todos juntos, na etapa seguinte.
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
                remova (×) antes de avançar.
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

          {produtos.length > 0 && (
            <div className="mt-4 flex gap-2">
              <Botao
                variante="primario"
                disabled={!prontoParaLotes}
                onClick={() => definir({ etapa: 'lotes' })}
              >
                Escolher lotes →
              </Botao>
              <Botao onClick={() => rascunho.limpar()}>Limpar</Botao>
            </div>
          )}
        </>
      ) : (
        <>
          {/* 2ª etapa: os lotes disponíveis, produto a produto */}
          <div className="mt-4 mb-1 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">
              2ª etapa · Lotes por produto
            </p>
            <button
              type="button"
              onClick={() => definir({ etapa: 'produtos' })}
              className="text-sm text-green-800 underline dark:text-green-400"
            >
              ← voltar aos produtos
            </button>
          </div>
          <div className="space-y-3">
            {completos.map((p) => (
              <ProdutoLotes
                key={p.chave}
                produto={p}
                lotes={lotes}
                selecionados={selecionadosDe(p)}
                onMudar={(patch) => mudarProduto(p.chave, patch)}
              />
            ))}
          </div>

          {incompletos.length > 0 && (
            <div className="mt-3">
              <Aviso gravidade="alerta">
                {incompletos.length} produto(s) incompleto(s) da 1ª etapa — volte e
                complete ou remova antes de salvar.
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
              <Botao
                variante="primario"
                disabled={salvando || !numero.trim() || bloqueado}
                onClick={salvar}
              >
                {salvando ? 'gravando…' : editandoId ? 'Salvar alterações' : 'Salvar carga'}
              </Botao>
              <Botao onClick={() => rascunho.limpar()}>Limpar</Botao>
            </div>
          </div>
        </>
      )}
    </Cartao>
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
 * 2ª etapa — os lotes de UM produto: candidatos do acesso mais fácil pro
 * mais difícil, com busca por nº ou endereço. Produto pode ficar sem lote
 * (a ordem nasce antes da separação; completa-se depois, editando).
 */
function ProdutoLotes({
  produto: p, lotes, selecionados, onMudar,
}: {
  produto: ProdutoCargaForm
  lotes: LoteMapaLinha[]
  selecionados: (ItemCargaForm & { lote: LoteMapaLinha })[]
  onMudar: (patch: Partial<ProdutoCargaForm>) => void
}) {
  const [buscaLote, setBuscaLote] = useState('')

  const candidatos = useMemo(() => {
    if (!p.cultivar || !p.tratamento) return []
    return lotes
      .filter((l) => l.cultivar === p.cultivar && l.tratamento === p.tratamento && l.bags > 0)
      .sort((a, b) => maiorQuadra(b) - maiorQuadra(a))
  }, [lotes, p.cultivar, p.tratamento])

  const filtrados = useMemo(() => {
    const b = buscaLote.trim().toLowerCase()
    if (!b) return candidatos
    return candidatos.filter(
      (l) => l.lote.toLowerCase().includes(b) || enderecoDe(l).toLowerCase().includes(b),
    )
  }, [candidatos, buscaLote])

  const solicitados = Number(p.bags) || 0
  const bagsDoProduto = selecionados.reduce((s, i) => s + (Number(i.bags) || 0), 0)
  const pesoDoProduto = selecionados.reduce(
    (s, i) => s + (Number(i.bags) || 0) * i.lote.peso_bag_kg,
    0,
  )

  const adicionar = (l: LoteMapaLinha) => {
    if (p.itens.some((i) => i.loteId === l.lote)) return
    const restante = Math.max(0, solicitados - bagsDoProduto)
    const sugestao = restante > 0 ? Math.min(restante, l.bags) : l.bags
    onMudar({ itens: [...p.itens, { loteId: l.lote, bags: String(sugestao) }] })
  }
  const atualizarBags = (loteId: string, v: string) =>
    onMudar({ itens: p.itens.map((i) => (i.loteId === loteId ? { ...i, bags: v } : i)) })
  const remover = (loteId: string) =>
    onMudar({ itens: p.itens.filter((i) => i.loteId !== loteId) })

  return (
    <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-700">
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
          className={`text-sm ${solicitados > 0 && bagsDoProduto >= solicitados ? 'font-medium text-green-700 dark:text-green-400' : 'text-stone-500 dark:text-stone-400'}`}
        >
          {inteiro(bagsDoProduto)}
          {solicitados > 0 ? ` de ${inteiro(solicitados)}` : ''} bg em lotes ·{' '}
          {inteiro(pesoDoProduto)} kg
        </span>
      </div>

      <>
          <div className="mt-3 mb-1 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">
              Lotes disponíveis ({filtrados.length}
              {buscaLote.trim() ? ` de ${candidatos.length}` : ''}) — acesso mais fácil primeiro
            </p>
            <input
              value={buscaLote}
              onChange={(e) => setBuscaLote(e.target.value)}
              placeholder="buscar lote ou endereço…"
              className={`${INPUT} w-56 py-1.5`}
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
              {filtrados.map((l) => {
                const jaSelecionado = p.itens.some((i) => i.loteId === l.lote)
                return (
                  <button
                    key={chaveDe(l)}
                    type="button"
                    disabled={jaSelecionado}
                    onClick={() => adicionar(l)}
                    className={`flex w-full items-center justify-between gap-2 border-b border-stone-100 px-3 py-1.5 text-left text-xs last:border-b-0 dark:border-stone-800/60 ${
                      jaSelecionado
                        ? 'opacity-40'
                        : l.destinacao
                          ? 'bg-red-50 hover:bg-red-100 dark:bg-red-950/30 dark:hover:bg-red-950/50'
                          : 'hover:bg-stone-100 dark:hover:bg-stone-800'
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="font-medium">{l.lote}</span> · {inteiro(l.bags)} bg
                      <span className="block text-[10px] text-stone-500 dark:text-stone-400">
                        {enderecoDe(l) || 'sem endereço'}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {l.destinacao
                        ? <Tag cor="perigo">{l.destinacao}</Tag>
                        : <Tag cor="ok">livre</Tag>}
                      <span className={jaSelecionado ? 'text-stone-400' : 'font-medium text-green-800 dark:text-green-400'}>
                        {jaSelecionado ? 'na carga' : '+ adicionar'}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {selecionados.length > 0 && (
            <div className="mt-3">
              <Tabela cabecalho={['Lote', 'Endereço', '#Bags', '#Peso (kg)', 'Destinação', '']}>
                {selecionados.map((i) => (
                  <tr key={i.loteId} className="border-t border-stone-100 dark:border-stone-800/60">
                    <td className="px-2 py-1.5 font-medium">{i.loteId}</td>
                    <td className="px-2 py-1.5 text-xs text-stone-500">
                      {enderecoDe(i.lote) || '—'}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <input
                        type="number"
                        min={1}
                        max={i.lote.bags}
                        value={i.bags}
                        onChange={(e) => atualizarBags(i.loteId, e.target.value)}
                        className={`${INPUT} w-20 py-1 text-right`}
                      />
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
                ))}
              </Tabela>
            </div>
          )}
      </>
    </div>
  )
}
