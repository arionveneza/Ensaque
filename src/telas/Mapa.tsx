import { useEffect, useMemo, useState, type ChangeEvent } from 'react'
import readXlsxFile from 'read-excel-file/browser'
import * as m from '@/dados/api-mapa'
import type { CargaMontadaLinha, EnderecoLote, LoteMapaLinha } from '@/dados/api-mapa'
import {
  converterLotesMapa, DEPOSITO_MAPA, ehRelatorioMapa, SEM_TSI, type ResultadoLotesMapa,
} from '@/dominio/importacao/mapa'
import type { Linha } from '@/dominio/importacao/simpleagro'
import { useAuth } from '@/auth/AuthProvider'
import { useRealtime } from '@/dados/useRealtime'
import { useRascunho } from '@/lib/useRascunho'
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

interface Posicao {
  armazem: string
  bloco: string
  quadra: string
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
  useRealtime(['lotes_mapa', 'lote_enderecos', 'cargas_montadas'], () => void recarregar())

  // -------- filtros do mapa --------
  const [fCultivar, setFCultivar] = useState('')
  const [fTratamento, setFTratamento] = useState('')
  const [fEmbalagem, setFEmbalagem] = useState('')
  const [busca, setBusca] = useState('')
  const filtroAtivo = !!(fCultivar || fTratamento || fEmbalagem || busca.trim())

  const casaFiltro = (l: LoteMapaLinha): boolean => {
    if (fCultivar && l.cultivar !== fCultivar) return false
    if (fTratamento && l.tratamento !== fTratamento) return false
    if (fEmbalagem && l.embalagem !== fEmbalagem) return false
    if (busca.trim() && !l.lote.toLowerCase().includes(busca.trim().toLowerCase())) return false
    return true
  }

  const todos = useMemo(() => lotes ?? [], [lotes])
  const cultivares = useMemo(() => [...new Set(todos.map((l) => l.cultivar))].sort(), [todos])
  const tratamentos = useMemo(
    () => [...new Set(todos.map((l) => l.tratamento).filter((t) => t !== SEM_TSI))].sort(),
    [todos],
  )
  const semEndereco = todos.filter((l) => l.lote_enderecos.length === 0)
  const aloc = useMemo(() => alocar(todos), [todos])

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
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="buscar lote…"
            className={INPUT}
          />
          {filtroAtivo && (
            <button
              type="button"
              onClick={() => { setFCultivar(''); setFTratamento(''); setFEmbalagem(''); setBusca('') }}
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
          onSalva={() => {
            setMsg('Carga gravada.')
            void recarregar()
          }}
        />
      )}

      {/* -------- cargas recentes -------- */}
      <Cartao titulo={`Cargas montadas (${cargas.length} recentes)`}>
        {cargas.length === 0 ? (
          <Vazio>Nenhuma carga montada ainda.</Vazio>
        ) : (
          <Tabela cabecalho={['Ordem', 'Cultivar', 'Tratamento', '#Bags', '#Peso (kg)', 'Lotes', 'Quando']}>
            {cargas.map((c) => (
              <tr key={c.id} className="border-t border-stone-100 dark:border-stone-800/60">
                <td className="px-2 py-1.5 font-medium">{c.numero}</td>
                <td className="px-2 py-1.5">{c.cultivar}</td>
                <td className="px-2 py-1.5">{rotuloTratamento(c.tratamento)}</td>
                <td className="num-tabular px-2 py-1.5 text-right">
                  {inteiro(c.carga_montada_itens.reduce((s, i) => s + i.bags, 0))}
                </td>
                <td className="num-tabular px-2 py-1.5 text-right">{inteiro(c.peso_total_kg)}</td>
                <td className="px-2 py-1.5 text-xs text-stone-500">
                  {c.carga_montada_itens.map((i) => `${i.lote_id} (${inteiro(i.bags)})`).join(' · ')}
                </td>
                <td className="px-2 py-1.5 text-xs text-stone-500">{dataHoraCurta(c.criada_em)}</td>
              </tr>
            ))}
          </Tabela>
        )}
      </Cartao>

      {/* -------- modais -------- */}
      {posicao && (
        <ModalPosicao
          posicao={posicao}
          alocacoes={naPosicao}
          podeEnderecar={podeEnderecar}
          onFechar={() => setPosicao(null)}
          onMover={(a) => {
            setMovendo(a)
            setPosicao(null)
          }}
          onEnderecar={(l) => {
            setEnderecando(l)
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

/** Detalhe de uma posição: os lotes que estão ali, destinação/livre, mover. */
function ModalPosicao({
  posicao, alocacoes, podeEnderecar, onFechar, onMover, onEnderecar,
}: {
  posicao: Posicao
  alocacoes: Alocacao[]
  podeEnderecar: boolean
  onFechar: () => void
  onMover: (a: Alocacao) => void
  onEnderecar: (l: LoteMapaLinha) => void
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
              {podeEnderecar && (
                <div className="flex shrink-0 gap-2">
                  <Botao onClick={() => onMover(a)}>Mover</Botao>
                  <Botao onClick={() => onEnderecar(a.lote)}>Endereços</Botao>
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
 * Montagem de carga da Balança. Rascunho persistente (mesmo padrão do
 * Programar em Ordens): fechar a tela no meio não perde a carga em
 * montagem. Os candidatos saem ordenados do acesso mais fácil pro mais
 * difícil (maior quadra numérica primeiro; sem endereço por último).
 */
function MontagemCarga({
  lotes, usuarioId, onSalva,
}: {
  lotes: LoteMapaLinha[]
  usuarioId: string
  onSalva: () => void
}) {
  const rascunho = useRascunho<{
    numero: string
    cultivar: string
    tratamento: string
    bags: string
    itens: ItemCargaForm[]
  }>('mapa.carga', { numero: '', cultivar: '', tratamento: '', bags: '', itens: [] })
  const { numero, cultivar, tratamento, bags, itens } = rascunho.valor
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  const cultivares = useMemo(() => [...new Set(lotes.map((l) => l.cultivar))].sort(), [lotes])
  const tratamentosDoCultivar = useMemo(
    () =>
      [...new Set(
        lotes
          .filter((l) => !cultivar || l.cultivar === cultivar)
          .map((l) => l.tratamento)
          .filter((t) => t !== SEM_TSI),
      )].sort(),
    [lotes, cultivar],
  )

  const maiorQuadra = (l: LoteMapaLinha) => {
    const numericas = l.lote_enderecos
      .map((e) => (ehNumero(e.quadra) ? Number(e.quadra) : null))
      .filter((q): q is number => q != null)
    if (numericas.length > 0) return Math.max(...numericas)
    return l.lote_enderecos.length > 0 ? -1 : -2
  }

  const candidatos = useMemo(() => {
    if (!cultivar || !tratamento) return []
    return lotes
      .filter((l) => l.cultivar === cultivar && l.tratamento === tratamento && l.bags > 0)
      .sort((a, b) => maiorQuadra(b) - maiorQuadra(a))
  }, [lotes, cultivar, tratamento])

  const porLote = useMemo(() => {
    const mapa = new Map<string, LoteMapaLinha>()
    for (const l of lotes) if (l.tratamento === tratamento) mapa.set(l.lote, l)
    return mapa
  }, [lotes, tratamento])
  const selecionados = itens
    .map((i) => ({ ...i, lote: porLote.get(i.loteId) }))
    .filter((i): i is ItemCargaForm & { lote: LoteMapaLinha } => i.lote != null)

  const totalBags = selecionados.reduce((s, i) => s + (Number(i.bags) || 0), 0)
  const totalPesoKg = selecionados.reduce(
    (s, i) => s + (Number(i.bags) || 0) * i.lote.peso_bag_kg,
    0,
  )
  const solicitados = Number(bags) || 0
  const comDestinacao = selecionados.filter((i) => i.lote.destinacao)

  const definir = rascunho.definir
  const adicionar = (l: LoteMapaLinha) => {
    if (itens.some((i) => i.loteId === l.lote)) return
    const restante = Math.max(0, solicitados - totalBags)
    const sugestao = restante > 0 ? Math.min(restante, l.bags) : l.bags
    definir({ itens: [...itens, { loteId: l.lote, bags: String(sugestao) }] })
  }
  const atualizarBags = (loteId: string, v: string) =>
    definir({ itens: itens.map((i) => (i.loteId === loteId ? { ...i, bags: v } : i)) })
  const remover = (loteId: string) =>
    definir({ itens: itens.filter((i) => i.loteId !== loteId) })

  const enderecoDe = (l: LoteMapaLinha) =>
    l.lote_enderecos
      .slice()
      .sort((a, b) => ordenaQuadras(a.quadra, b.quadra))
      .map((e) => `${e.armazem} ${e.bloco}${ehNumero(e.quadra) ? `-Q${e.quadra}` : ` ${e.quadra}`}`)
      .join(' · ')

  async function salvar() {
    if (!numero.trim() || !cultivar || !tratamento || selecionados.length === 0) return
    setSalvando(true)
    setErro(null)
    try {
      await m.criarCargaMontada(
        {
          numero: numero.trim(),
          cultivar,
          tratamento,
          bags_solicitados: solicitados || totalBags,
          peso_total_kg: Math.round(totalPesoKg * 100) / 100,
        },
        selecionados.map((i) => ({
          lote_id: i.loteId,
          bags: Number(i.bags) || 0,
          peso_kg: Math.round((Number(i.bags) || 0) * i.lote.peso_bag_kg * 100) / 100,
          destinacao: i.lote.destinacao,
        })),
        usuarioId,
      )
      rascunho.limpar()
      onSalva()
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    } finally {
      setSalvando(false)
    }
  }

  return (
    <Cartao titulo="Montagem de carga" className="mb-5">
      {erro && <Erro>{erro}</Erro>}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={numero}
          onChange={(e) => definir({ numero: e.target.value })}
          placeholder="nº da ordem de carregamento"
          className={`${INPUT} w-56`}
        />
        <select
          value={cultivar}
          onChange={(e) => definir({ cultivar: e.target.value, itens: [] })}
          className={INPUT}
        >
          <option value="">cultivar…</option>
          {cultivares.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select
          value={tratamento}
          onChange={(e) => definir({ tratamento: e.target.value, itens: [] })}
          className={INPUT}
        >
          <option value="">tratamento…</option>
          <option value={SEM_TSI}>SEM TSI (branca)</option>
          {tratamentosDoCultivar.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input
          type="number"
          min={1}
          value={bags}
          onChange={(e) => definir({ bags: e.target.value })}
          placeholder="bags"
          className={`${INPUT} w-24`}
        />
      </div>

      {cultivar && tratamento && (
        <>
          {/* candidatos, do acesso mais fácil pro mais difícil */}
          <p className="mt-4 mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">
            Lotes disponíveis ({candidatos.length}) — acesso mais fácil primeiro
          </p>
          {candidatos.length === 0 ? (
            <Vazio>Nenhum lote de {cultivar} · {rotuloTratamento(tratamento)} no mapa.</Vazio>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {candidatos.map((l) => {
                const jaSelecionado = itens.some((i) => i.loteId === l.lote)
                return (
                  <button
                    key={chaveDe(l)}
                    type="button"
                    disabled={jaSelecionado}
                    onClick={() => adicionar(l)}
                    title={l.destinacao ? `DESTINAÇÃO: ${l.destinacao}` : 'livre'}
                    className={`rounded-md border px-2 py-1 text-left text-xs transition-colors ${
                      jaSelecionado
                        ? 'border-stone-200 text-stone-300 dark:border-stone-800'
                        : l.destinacao
                          ? 'border-red-300 bg-red-50 text-red-900 hover:bg-red-100 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200'
                          : 'border-stone-300 hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800'
                    }`}
                  >
                    <span className="font-medium">{l.lote}</span> · {inteiro(l.bags)} bg
                    {l.destinacao && <span className="ml-1 font-semibold">· {l.destinacao}</span>}
                    <span className="block text-[10px] opacity-70">
                      {enderecoDe(l) || 'sem endereço'}
                    </span>
                  </button>
                )
              })}
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

              <p className={`mt-3 text-sm font-medium ${solicitados > 0 && totalBags >= solicitados ? 'text-green-700 dark:text-green-400' : 'text-stone-600 dark:text-stone-300'}`}>
                {inteiro(totalBags)}{solicitados > 0 ? ` de ${inteiro(solicitados)}` : ''} bags ·
                peso total <b>{inteiro(totalPesoKg)} kg</b> ({n(totalPesoKg / 1000, 1)} t)
              </p>

              <div className="mt-3 flex gap-2">
                <Botao
                  variante="primario"
                  disabled={salvando || !numero.trim() || selecionados.length === 0}
                  onClick={salvar}
                >
                  {salvando ? 'gravando…' : 'Salvar carga'}
                </Botao>
                <Botao onClick={() => rascunho.limpar()}>Limpar</Botao>
              </div>
            </div>
          )}
        </>
      )}
    </Cartao>
  )
}
