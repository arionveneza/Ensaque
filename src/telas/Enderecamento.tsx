import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Aviso,
  Botao,
  Cartao,
  Erro,
  Pagina,
  SeletorArmazem,
  Tabela,
  Tag,
  Vazio,
  dataHoraCurta,
  inteiro,
} from '@/componentes/ui'
import {
  chaveBloco,
  ehQuadraNumerica,
  ordenaPorFacilidade,
  ranquear,
  resumoPorBloco,
  rotuloQuadra,
  totaisEnderecamento,
  VERSAO_FOTO,
  type FotoEnderecamento,
  type LinhaRanqueada,
} from '@/dominio/enderecamento'
import { buscarLotePa, NOME_ABA, PLANILHA_ID, URL_PLANILHA } from '@/dados/planilhaEnderecamento'
import { carregarFoto, salvarFoto } from '@/lib/fotoEnderecamento'
import { exportarXlsx } from '@/lib/exportar'

const INPUT =
  'rounded-md border border-stone-300 px-2 py-2 text-sm sm:py-1 dark:border-stone-700 dark:bg-stone-800'

/** "há 3 min" — a idade da foto importa mais que a hora exata. */
function idadeCurta(iso: string, agora: number): string {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const min = Math.max(0, Math.round((agora - t) / 60000))
  if (min < 1) return 'agora'
  if (min < 60) return `há ${min} min`
  const h = Math.round(min / 60)
  return h < 24 ? `há ${h} h` : `há ${Math.round(h / 24)} dia(s)`
}

function Indicador({
  rotulo, valor, detalhe, cor = 'neutro', ativo, onClick,
}: {
  rotulo: string
  valor: string
  detalhe: string
  cor?: 'neutro' | 'ok' | 'alerta'
  ativo?: boolean
  onClick?: () => void
}) {
  const corValor =
    cor === 'ok'
      ? 'text-green-700 dark:text-green-400'
      : cor === 'alerta'
        ? 'text-amber-700 dark:text-amber-400'
        : 'text-stone-800 dark:text-stone-100'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={`rounded-lg border p-3 text-left transition-colors ${
        ativo
          ? 'border-green-600 bg-green-50 dark:border-green-700 dark:bg-green-950/30'
          : 'border-stone-200 dark:border-stone-700'
      } ${onClick ? 'hover:bg-stone-50 dark:hover:bg-stone-800' : 'cursor-default'}`}
    >
      <p className="text-xs uppercase tracking-wide text-stone-500 dark:text-stone-400">{rotulo}</p>
      <p className={`num-tabular text-2xl font-semibold ${corValor}`}>{valor}</p>
      <p className="text-xs text-stone-500 dark:text-stone-400">{detalhe}</p>
    </button>
  )
}

function Chip({
  children, ativo, onClick,
}: {
  children: React.ReactNode
  ativo: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs ${
        ativo
          ? 'border-green-700 bg-green-700 text-white'
          : 'border-stone-300 hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800'
      }`}
    >
      {children}
    </button>
  )
}

/**
 * Endereçamento planilha (18/09/2026, pedido do Arion: "a planilha é
 * dinâmica, tem como colocar uma aba dentro do app… e um botão pra
 * atualizar?").
 *
 * Espelho de LEITURA da aba "Lote PA" da planilha "Produção 2026" do Google,
 * onde a operação anota à mão onde cada lote está. Não é o Mapa do app e não
 * grava nada — nem aqui nem lá. Destaque da tela: o lote mais fácil de puxar
 * em cada bloco, que é o de MAIOR quadra (quadra maior fica junto do portão).
 */
export default function Enderecamento() {
  const [foto, setFoto] = useState<FotoEnderecamento | null>(() => carregarFoto())
  const [buscando, setBuscando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [agora, setAgora] = useState(() => Date.now())

  const [busca, setBusca] = useState('')
  const [armazem, setArmazem] = useState('')
  const [bloco, setBloco] = useState('')
  const [cultivar, setCultivar] = useState('')
  const [tratamento, setTratamento] = useState('')
  const [soFaceis, setSoFaceis] = useState(false)
  const [soSemQuadra, setSoSemQuadra] = useState(false)
  const [soIncompletos, setSoIncompletos] = useState(false)
  const [comZerados, setComZerados] = useState(false)
  const [vista, setVista] = useState<'lista' | 'bloco'>('lista')
  const [verProblemas, setVerProblemas] = useState(false)

  const vivo = useRef(true)
  const emVoo = useRef<AbortController | null>(null)

  const atualizar = useCallback(async () => {
    // clique repetido não dispara duas buscas; a anterior continua valendo
    if (emVoo.current) return
    const controle = new AbortController()
    emVoo.current = controle
    setBuscando(true)
    setErro(null)
    try {
      const r = await buscarLotePa(controle.signal)
      if (!vivo.current || controle.signal.aborted) return
      const nova = { posicoes: r.posicoes, problemas: r.problemas, buscadoEm: r.buscadoEm }
      setFoto({ ...nova, versao: VERSAO_FOTO, planilhaId: PLANILHA_ID })
      salvarFoto(nova)
      setAgora(Date.now())
    } catch (e) {
      // falha NUNCA apaga a foto anterior: o erro vai em cima, a lista fica embaixo
      if (!vivo.current || controle.signal.aborted) return
      setErro(e instanceof Error ? e.message : String(e))
    } finally {
      emVoo.current = null
      if (vivo.current) setBuscando(false)
    }
  }, [])

  useEffect(() => {
    vivo.current = true
    // só busca sozinha na primeiríssima vez; depois é pelo botão (decisão do
    // Arion, 18/09/2026) — senão a tela abriria vazia para quem nunca entrou
    if (!carregarFoto()) void atualizar()
    const relogio = setInterval(() => setAgora(Date.now()), 30_000)
    return () => {
      vivo.current = false
      emVoo.current?.abort()
      clearInterval(relogio)
    }
  }, [atualizar])

  const linhas = useMemo(
    () => (foto ? ranquear(foto.posicoes).sort(ordenaPorFacilidade) : []),
    [foto],
  )
  const comSaldo = useMemo(() => linhas.filter((l) => l.bags > 0), [linhas])
  const base = comZerados ? linhas : comSaldo
  const totais = useMemo(() => totaisEnderecamento(base), [base])
  const zeradas = linhas.length - comSaldo.length

  const opcoes = useMemo(() => {
    const unico = (f: (l: LinhaRanqueada) => string) =>
      [...new Set(base.map(f).filter((v) => v !== ''))].sort((a, b) =>
        a.localeCompare(b, 'pt-BR', { numeric: true }),
      )
    return {
      blocos: unico((l) => l.bloco),
      cultivares: unico((l) => l.cultivar),
      tratamentos: unico((l) => l.tratamento),
    }
  }, [base])

  const filtradas = useMemo(() => {
    const b = busca.trim().toLowerCase()
    return base.filter((l) => {
      if (armazem && l.armazem !== armazem) return false
      if (bloco && l.bloco !== bloco) return false
      if (cultivar && l.cultivar !== cultivar) return false
      if (tratamento && l.tratamento !== tratamento) return false
      if (soFaceis && l.posicaoNoBloco !== 1) return false
      if (soSemQuadra && (!l.enderecoCompleto || ehQuadraNumerica(l.quadra))) return false
      if (soIncompletos && l.enderecoCompleto) return false
      if (
        b &&
        !`${l.lote} ${l.cultivar} ${l.tratamento} ${l.armazem} ${l.bloco} ${l.quadra}`
          .toLowerCase()
          .includes(b)
      ) {
        return false
      }
      return true
    })
  }, [base, busca, armazem, bloco, cultivar, tratamento, soFaceis, soSemQuadra, soIncompletos])

  const blocos = useMemo(() => resumoPorBloco(filtradas), [filtradas])

  const limparFiltros = () => {
    setBusca('')
    setArmazem('')
    setBloco('')
    setCultivar('')
    setTratamento('')
    setSoFaceis(false)
    setSoSemQuadra(false)
    setSoIncompletos(false)
  }
  const temFiltro =
    busca !== '' || armazem !== '' || bloco !== '' || cultivar !== '' || tratamento !== '' ||
    soFaceis || soSemQuadra || soIncompletos

  async function exportar() {
    await exportarXlsx(
      `enderecamento-planilha-${new Date().toISOString().slice(0, 10)}`,
      [
        { titulo: 'Lote', largura: 20 },
        { titulo: 'Cultivar', largura: 16 },
        { titulo: 'Tratamento', largura: 28 },
        { titulo: 'Classe', largura: 8 },
        { titulo: 'Armazém', largura: 10 },
        { titulo: 'Bloco', largura: 10 },
        { titulo: 'Quadra', largura: 9 },
        { titulo: 'Posição no bloco', largura: 14, tipo: 'numero', casas: 0 },
        { titulo: 'Lotes no bloco', largura: 13, tipo: 'numero', casas: 0 },
        { titulo: 'Bags na frente', largura: 13, tipo: 'numero', casas: 0 },
        { titulo: 'Bags', largura: 10, tipo: 'numero', casas: 0 },
        { titulo: 'Destinação', largura: 20 },
        { titulo: 'Data', largura: 12 },
      ],
      filtradas.map((l) => [
        l.lote, l.cultivar, l.tratamento, l.classe, l.armazem, l.bloco, l.quadra,
        l.posicaoNoBloco, l.totalNoBloco, l.bagsNaFrente, l.bags, l.destinacao, l.data,
      ]),
    )
  }

  const idadeMin = foto ? (agora - new Date(foto.buscadoEm).getTime()) / 60000 : 0
  const corIdade = idadeMin > 720 ? 'perigo' : idadeMin > 60 ? 'alerta' : 'neutro'

  return (
    <Pagina
      titulo="Endereçamento planilha"
      descricao={`Foto da aba "${NOME_ABA}" da planilha Produção 2026, que a operação mantém à mão. Quadra de número MAIOR fica junto do portão — é o lote mais fácil de puxar.`}
      acoes={
        <div className="flex flex-wrap items-center gap-2">
          <Botao variante="primario" onClick={() => void atualizar()} disabled={buscando}>
            {buscando ? 'Buscando…' : 'Atualizar agora'}
          </Botao>
          <Botao onClick={() => void exportar()} disabled={filtradas.length === 0}>
            Exportar .xlsx
          </Botao>
          <a
            href={URL_PLANILHA}
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800"
          >
            Abrir a planilha ↗
          </a>
        </div>
      }
    >
      {erro && <Erro>{erro}</Erro>}

      {foto && (
        <p className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-stone-600 dark:text-stone-300">
          <span>Atualizado em</span>
          <Tag cor={corIdade}>
            {dataHoraCurta(foto.buscadoEm)} · {idadeCurta(foto.buscadoEm, agora)}
          </Tag>
          <span>
            {inteiro(totais.linhas)} linhas · {inteiro(totais.bags)} bags · {totais.blocos} blocos
          </span>
          {buscando && <span className="text-stone-500">· buscando…</span>}
        </p>
      )}

      <div className="mb-4">
        <Aviso>
          Esta tela só <b>lê</b> a planilha do Google. Ela não é o Mapa do TSI e não altera nada,
          nem aqui nem lá — para corrigir um endereço, corrija na planilha e toque em Atualizar.
        </Aviso>
      </div>

      {!foto ? (
        buscando ? (
          <p className="p-8 text-sm text-stone-500">Buscando a planilha…</p>
        ) : (
          <Vazio>Nenhuma foto da planilha ainda. Toque em "Atualizar agora".</Vazio>
        )
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Indicador rotulo="Bags endereçados" valor={inteiro(totais.bags)} detalhe={`em ${inteiro(totais.linhas)} linhas`} />
            <Indicador rotulo="Blocos ocupados" valor={String(totais.blocos)} detalhe={`${totais.lotes} lotes distintos`} />
            <Indicador
              rotulo="Fáceis de puxar"
              valor={String(totais.faceis)}
              detalhe="na frente do bloco, sem tirar nada"
              cor="ok"
              ativo={soFaceis}
              onClick={() => setSoFaceis((v) => !v)}
            />
            <Indicador
              rotulo="Precisam de atenção"
              valor={String(totais.semEndereco + totais.semQuadra)}
              detalhe="endereço incompleto ou quadra sem número"
              cor="alerta"
              ativo={soIncompletos || soSemQuadra}
              onClick={() => {
                const ligar = !(soIncompletos || soSemQuadra)
                setSoIncompletos(ligar)
                setSoSemQuadra(false)
              }}
            />
          </div>

          <Cartao className="mb-4">
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder="buscar lote, cultivar, bloco…"
                className={`${INPUT} w-60`}
              />
              <SeletorArmazem valor={armazem} aoMudar={setArmazem} />
              <select value={bloco} onChange={(e) => setBloco(e.target.value)} className={INPUT}>
                <option value="">bloco…</option>
                {opcoes.blocos.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
              <select value={cultivar} onChange={(e) => setCultivar(e.target.value)} className={INPUT}>
                <option value="">cultivar…</option>
                {opcoes.cultivares.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <select value={tratamento} onChange={(e) => setTratamento(e.target.value)} className={INPUT}>
                <option value="">tratamento…</option>
                {opcoes.tratamentos.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              {temFiltro && (
                <button type="button" onClick={limparFiltros} className="text-xs text-stone-500 underline">
                  limpar
                </button>
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Chip ativo={soFaceis} onClick={() => setSoFaceis((v) => !v)}>
                Só os fáceis ({totais.faceis})
              </Chip>
              <Chip ativo={soSemQuadra} onClick={() => setSoSemQuadra((v) => !v)}>
                Sem quadra ({totais.semQuadra})
              </Chip>
              <Chip ativo={soIncompletos} onClick={() => setSoIncompletos((v) => !v)}>
                Endereço incompleto ({totais.semEndereco})
              </Chip>
              <Chip ativo={comZerados} onClick={() => setComZerados((v) => !v)}>
                Incluir saldo zerado ({zeradas})
              </Chip>
              <span className="mx-1 text-stone-300">|</span>
              <Chip ativo={vista === 'lista'} onClick={() => setVista('lista')}>Lista</Chip>
              <Chip ativo={vista === 'bloco'} onClick={() => setVista('bloco')}>Por bloco</Chip>
            </div>
          </Cartao>

          {vista === 'lista' ? (
            <Cartao titulo={`Lotes (${filtradas.length} de ${base.length})`} semPadding>
              {filtradas.length === 0 ? (
                <div className="p-4">
                  <Vazio>Nenhum lote passa pelos filtros.</Vazio>
                </div>
              ) : (
                <Tabela
                  cabecalho={[
                    'Lote',
                    { texto: 'Cultivar', className: 'hidden lg:table-cell' },
                    { texto: 'Tratamento', className: 'hidden lg:table-cell' },
                    'Endereço',
                    'Posição',
                    '#Na frente',
                    '#Bags',
                  ]}
                >
                  {filtradas.map((l) => (
                    <tr
                      key={`${l.lote}|${l.tratamento}|${chaveBloco(l)}|${l.quadra}`}
                      className={`border-t border-stone-100 dark:border-stone-800/60 ${
                        l.posicaoNoBloco === 1 && l.bagsNaFrente === 0
                          ? 'border-l-2 border-l-green-600'
                          : ''
                      }`}
                    >
                      <td className="px-2 py-1.5">
                        <p className="font-medium">{l.lote}</p>
                        <p className="text-xs text-stone-500 lg:hidden">
                          {l.cultivar}
                          {l.tratamento ? ` · ${l.tratamento}` : ''}
                        </p>
                      </td>
                      <td className="hidden px-2 py-1.5 lg:table-cell">{l.cultivar}</td>
                      <td className="hidden px-2 py-1.5 text-xs lg:table-cell">{l.tratamento || '—'}</td>
                      <td className="px-2 py-1.5">
                        {l.enderecoCompleto ? (
                          <span className="font-medium">
                            {l.armazem} · {l.bloco} · <b>{rotuloQuadra(l.quadra)}</b>
                          </span>
                        ) : (
                          <Tag cor="alerta">endereço incompleto</Tag>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        {l.posicaoNoBloco == null ? (
                          <Tag cor="neutro">sem quadra</Tag>
                        ) : (
                          <Tag cor={l.posicaoNoBloco === 1 ? 'ok' : 'neutro'}>
                            {l.posicaoNoBloco}º de {l.totalNoBloco}
                            {l.empatados > 1 ? ' · empate' : ''}
                          </Tag>
                        )}
                      </td>
                      <td className="num-tabular px-2 py-1.5 text-right">
                        {l.bagsNaFrente == null ? (
                          <span className="text-stone-400">—</span>
                        ) : l.bagsNaFrente === 0 ? (
                          <span className="font-semibold text-green-700 dark:text-green-400">
                            puxa direto
                          </span>
                        ) : (
                          <span title={`tirar ${inteiro(l.bagsNaFrente)} bags da frente`}>
                            {inteiro(l.bagsNaFrente)}
                          </span>
                        )}
                      </td>
                      <td className="num-tabular px-2 py-1.5 text-right font-medium">
                        {inteiro(l.bags)}
                      </td>
                    </tr>
                  ))}
                </Tabela>
              )}
            </Cartao>
          ) : (
            <div className="space-y-3">
              {blocos.length === 0 && <Vazio>Nenhum bloco passa pelos filtros.</Vazio>}
              {blocos.map((b) => (
                <Cartao
                  key={`${b.armazem}|${b.bloco}`}
                  titulo={`Armazém ${b.armazem} · Bloco ${b.bloco}`}
                  acoes={
                    <span className="text-xs text-stone-500">
                      {b.linhas} lote(s) · {inteiro(b.bags)} bags
                    </span>
                  }
                >
                  <p className="mb-2 text-xs uppercase tracking-wide text-green-700 dark:text-green-400">
                    ↑ frente do bloco (portão)
                  </p>
                  <div className="space-y-1.5">
                    {b.quadras.map((q) => (
                      <div
                        key={q.quadra || 'sem'}
                        className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-t border-stone-100 pt-1.5 dark:border-stone-800/60"
                      >
                        <span className="w-20 shrink-0 text-sm font-semibold">
                          {q.quadra ? rotuloQuadra(q.quadra) : 'sem quadra'}
                        </span>
                        <span className="num-tabular w-20 shrink-0 text-xs text-stone-500">
                          {inteiro(q.bags)} bags
                        </span>
                        <span className="text-xs">
                          {q.linhas
                            .map((l) => `${l.lote}${l.tratamento ? ` (${l.tratamento})` : ''}`)
                            .join(' · ')}
                        </span>
                      </div>
                    ))}
                  </div>
                </Cartao>
              ))}
            </div>
          )}

          {foto.problemas.length > 0 && (
            <Cartao
              titulo={`Problemas na planilha (${foto.problemas.length})`}
              className="mt-4"
              acoes={
                <Botao onClick={() => setVerProblemas((v) => !v)}>
                  {verProblemas ? 'Esconder' : 'Ver'}
                </Botao>
              }
            >
              {verProblemas ? (
                <Tabela cabecalho={['Lote', 'O que está faltando']}>
                  {foto.problemas.map((p, i) => (
                    <tr key={`${p.lote}|${i}`} className="border-t border-stone-100 dark:border-stone-800/60">
                      <td className="px-2 py-1.5 font-medium">{p.lote}</td>
                      <td className="px-2 py-1.5 text-stone-600 dark:text-stone-300">{p.motivo}</td>
                    </tr>
                  ))}
                </Tabela>
              ) : (
                <p className="text-sm text-stone-500">
                  Linhas da planilha sem endereço completo, com quadra que não é número ou
                  repetidas. Corrigir na planilha melhora o ranking.
                </p>
              )}
            </Cartao>
          )}
        </>
      )}
    </Pagina>
  )
}
