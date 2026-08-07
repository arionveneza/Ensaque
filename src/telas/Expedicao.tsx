import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react'
import readXlsxFile from 'read-excel-file/browser'
import * as g from '@/dados/api-gestao'
import type { BalancoLinha, CarregamentoBanco } from '@/dados/api-gestao'
import {
  converterMontagemCarga,
  ehRelatorioMontagemCarga,
  normalizaLinhasXlsx,
  saldosExpedicao,
  SEM_TSI,
} from '@/dominio/expedicao'
import { EMBALAGEM_DEPARA } from '@/dominio/importacao/simpleagro'
import { jaIniciada } from '@/dominio/status'
import type { StatusEfetivo } from '@/dominio/tipos'
import { useRealtime } from '@/dados/useRealtime'
import { useAuth } from '@/auth/AuthProvider'
import {
  Aviso, Botao, Cartao, Erro, Pagina, Tabela, Tag, Vazio,
  diaCurto, inteiro,
} from '@/componentes/ui'

const CAMPO =
  'rounded-md border border-stone-300 px-2 py-1.5 text-sm dark:border-stone-700 dark:bg-stone-800'

/** Ordem que ainda vai virar produto: tudo que não foi apontado no AGROTIS. */
const ABERTAS = ['Nao programada', 'Programada', 'Aguardando lote', 'Pronto para produzir',
  'Em producao', 'Parada', 'Finalizada', 'Qualidade apontada']

/** Embalagens que o app conhece — fora disso o estoque nunca casa. */
const EMBALAGENS_APP = new Set(Object.values(EMBALAGEM_DEPARA).map((e) => e.codigo))

export default function Expedicao() {
  const { usuario, permitido } = useAuth()
  const podeImportar = permitido('expedicao', 'importar')

  const [carregamentos, setCarregamentos] = useState<CarregamentoBanco[]>([])
  const [lotes, setLotes] = useState<g.LoteSementeLinha[]>([])
  const [estoquePa, setEstoquePa] = useState<g.EstoquePaLinha[]>([])
  const [ordens, setOrdens] = useState<g.OrdemVisao[]>([])
  const [balanco, setBalanco] = useState<BalancoLinha[]>([])
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  // ---- filtros dos carregamentos ----
  const [de, setDe] = useState('')
  const [ate, setAte] = useState('')
  const [statusSel, setStatusSel] = useState<Set<string>>(new Set())
  const [fCultivar, setFCultivar] = useState('')
  const [fTratamento, setFTratamento] = useState('')
  const [fEmbalagem, setFEmbalagem] = useState('')
  const [busca, setBusca] = useState('')

  // ---- filtros dos pedidos ----
  const [pCultivar, setPCultivar] = useState('')
  const [pTratamento, setPTratamento] = useState('')
  const [pEmbalagem, setPEmbalagem] = useState('')
  const [pLiberacao, setPLiberacao] = useState<'todos' | 'aprovado' | 'pendente'>('todos')

  const recarregar = useCallback(async () => {
    const [c, l, e, o, b] = await Promise.all([
      g.listarCarregamentos(), g.listarLotes(), g.listarEstoquePa(),
      g.listarOrdens(), g.listarBalanco(),
    ])
    setCarregamentos(c)
    setLotes(l)
    setEstoquePa(e)
    setOrdens(o)
    setBalanco(b)
  }, [])

  useEffect(() => {
    setCarregando(true)
    recarregar()
      .catch((e) => setErro(e instanceof Error ? e.message : String(e)))
      .finally(() => setCarregando(false))
  }, [recarregar])

  useRealtime(['carregamentos', 'ordens', 'lotes_semente'], recarregar)

  /**
   * "Finalizado" começa desmarcado: o caminhão já saiu, e contá-lo de novo
   * descontaria do estoque um bag que o upload seguinte de saldos já
   * desconta — a falta apareceria dobrada.
   */
  const statusExistentes = useMemo(
    () => [...new Set(carregamentos.map((c) => c.status))].sort(),
    [carregamentos],
  )
  const [statusIniciado, setStatusIniciado] = useState(false)
  useEffect(() => {
    if (statusIniciado || statusExistentes.length === 0) return
    setStatusSel(new Set(statusExistentes.filter((s) => s !== 'Finalizado')))
    setStatusIniciado(true)
  }, [statusExistentes, statusIniciado])

  const filtrados = useMemo(
    () =>
      carregamentos.filter((c) => {
        if (de && (c.data == null || c.data < de)) return false
        if (ate && (c.data == null || c.data > ate)) return false
        if (statusSel.size > 0 && !statusSel.has(c.status)) return false
        if (fCultivar && c.cultivar !== fCultivar) return false
        if (fTratamento && c.tratamento !== fTratamento) return false
        if (fEmbalagem && c.embalagem !== fEmbalagem) return false
        if (busca.trim()) {
          const q = busca.trim().toLowerCase()
          const alvo = `${c.cliente ?? ''} ${c.pedido ?? ''} ${c.carga} ${c.transportadora ?? ''} ${c.motorista ?? ''} ${c.placa ?? ''}`.toLowerCase()
          if (!alvo.includes(q)) return false
        }
        return true
      }),
    [carregamentos, de, ate, statusSel, fCultivar, fTratamento, fEmbalagem, busca],
  )

  /** O cruzamento usa SÓ o que passou pelos filtros: o período é a pergunta. */
  const saldos = useMemo(
    () =>
      saldosExpedicao(
        filtrados,
        lotes
          .filter((l) => l.status === 'Em estoque')
          .map((l) => ({ cultivar: l.cultivar, bags: l.bags_disp ?? 0 })),
        estoquePa,
        ordens
          .filter((o) => ABERTAS.includes(o.status_efetivo))
          .map((o) => ({
            cultivar: o.cultivar,
            tratamento: (o.receita_nome ?? '').toUpperCase(),
            embalagem: o.embalagem,
            bags: o.bags_produzidos ?? o.bags,
            dataProg: o.data_prog,
            // ordem que a produção já tocou é material garantido — inclusive a
            // ADIANTADA, cuja data programada continua no futuro
            iniciada: jaIniciada(o.status_efetivo as StatusEfetivo),
          })),
        new Date().toISOString().slice(0, 10),
      ),
    [filtrados, lotes, estoquePa, ordens],
  )

  const faltas = saldos.filter((s) => s.saldo < 0)
  const precisamAdiantar = saldos.filter((s) => s.saldo >= 0 && s.deficitPrazo > 0)

  const opcoes = useMemo(
    () => ({
      cultivares: [...new Set(carregamentos.map((c) => c.cultivar))].sort(),
      tratamentos: [...new Set(carregamentos.map((c) => c.tratamento))].sort(),
      embalagens: [...new Set(carregamentos.map((c) => c.embalagem))].sort(),
    }),
    [carregamentos],
  )

  const temFiltro =
    !!(de || ate || fCultivar || fTratamento || fEmbalagem || busca.trim()) ||
    statusSel.size !== statusExistentes.filter((s) => s !== 'Finalizado').length

  function limparFiltros() {
    setDe('')
    setAte('')
    setFCultivar('')
    setFTratamento('')
    setFEmbalagem('')
    setBusca('')
    setStatusSel(new Set(statusExistentes.filter((s) => s !== 'Finalizado')))
  }

  // ---- upload ----
  async function importar(ev: ChangeEvent<HTMLInputElement>) {
    const arquivo = ev.target.files?.[0]
    ev.target.value = ''
    if (!arquivo) return
    setErro(null)
    setMsg(null)
    try {
      // aba nomeada faz o leitor devolver [{sheet, data}] em vez das linhas
      const rows = normalizaLinhasXlsx(await readXlsxFile(arquivo))
      if (!ehRelatorioMontagemCarga(rows)) {
        throw new Error(
          'Este arquivo não parece o relatório de montagem de carga (faltam as colunas Carga / Status Carga / Qtd Agendada).',
        )
      }
      const { linhas, resumo } = converterMontagemCarga(rows)
      await g.substituirCarregamentos(
        linhas.map((l) => ({
          carga: l.carga, status: l.status, data: l.data, pedido: l.pedido || null,
          cliente: l.cliente || null, cultivar: l.cultivar, tratamento: l.tratamento,
          embalagem: l.embalagem, bags: l.bags, transportadora: l.transportadora,
          motorista: l.motorista, placa: l.placa,
        })),
        usuario!.id,
      )
      const avisos: string[] = []
      if (resumo.semData > 0) avisos.push(`${resumo.semData} sem data`)
      const embDesc = Object.keys(resumo.embalagemDesconhecida)
      if (embDesc.length > 0) avisos.push(`embalagem sem de-para: ${embDesc.join(', ')}`)
      setMsg(
        `${resumo.aproveitadas} carregamento(s) importados (substituição total).` +
          (avisos.length ? ` Atenção: ${avisos.join(' · ')}.` : ''),
      )
      setStatusIniciado(false) // os status podem ter mudado; refaz o padrão
      await recarregar()
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    }
  }

  // ---- pedidos filtrados ----
  const pedidos = useMemo(
    () =>
      balanco.filter((b) => {
        if (b.pedido_aprovado <= 0 && b.pedido_pendente <= 0) return false
        if (pCultivar && b.cultivar !== pCultivar) return false
        if (pTratamento && b.tratamento !== pTratamento) return false
        if (pEmbalagem && b.embalagem !== pEmbalagem) return false
        if (pLiberacao === 'aprovado' && b.pedido_aprovado <= 0) return false
        if (pLiberacao === 'pendente' && b.pedido_pendente <= 0) return false
        return true
      }),
    [balanco, pCultivar, pTratamento, pEmbalagem, pLiberacao],
  )

  const opcoesPedidos = useMemo(() => {
    const comPedido = balanco.filter((b) => b.pedido_aprovado > 0 || b.pedido_pendente > 0)
    return {
      cultivares: [...new Set(comPedido.map((b) => b.cultivar))].sort(),
      tratamentos: [...new Set(comPedido.map((b) => b.tratamento))].sort(),
      embalagens: [...new Set(comPedido.map((b) => b.embalagem))].sort(),
    }
  }, [balanco])

  if (carregando) return <p className="p-8 text-sm text-stone-500">Carregando expedição…</p>

  return (
    <Pagina
      titulo="Expedição"
      descricao="Carregamentos agendados cruzados com o estoque e a produção programada: o que está vendido atende, o que falta aparece primeiro."
      acoes={
        podeImportar ? (
          <label className="cursor-pointer rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-300">
            Importar montagem de carga (.xlsx)
            <input type="file" accept=".xlsx" className="hidden" onChange={importar} />
          </label>
        ) : undefined
      }
    >
      {erro && <Erro>{erro}</Erro>}
      {msg && <div className="mb-4"><Aviso gravidade="ok">{msg}</Aviso></div>}

      {carregamentos.length === 0 ? (
        <Cartao titulo="Carregamentos" className="mb-5">
          <Vazio>
            Nenhum carregamento importado.
            {podeImportar
              ? ' Exporte o relatório de montagem de carga na SimpleAgro e importe aqui.'
              : ' Peça ao PCP ou à logística para importar o relatório de montagem de carga.'}
          </Vazio>
        </Cartao>
      ) : (
        <>
          {/* ---------------- filtros ---------------- */}
          <Cartao titulo="Filtros" className="mb-5">
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-xs text-stone-500">
                De
                <input type="date" value={de} onChange={(e) => setDe(e.target.value)} className={`${CAMPO} mt-1 block`} />
              </label>
              <label className="text-xs text-stone-500">
                Até
                <input type="date" value={ate} onChange={(e) => setAte(e.target.value)} className={`${CAMPO} mt-1 block`} />
              </label>
              <label className="text-xs text-stone-500">
                Cultivar
                <select value={fCultivar} onChange={(e) => setFCultivar(e.target.value)} className={`${CAMPO} mt-1 block`}>
                  <option value="">todos</option>
                  {opcoes.cultivares.map((c) => <option key={c}>{c}</option>)}
                </select>
              </label>
              <label className="text-xs text-stone-500">
                Tratamento
                <select value={fTratamento} onChange={(e) => setFTratamento(e.target.value)} className={`${CAMPO} mt-1 block`}>
                  <option value="">todos</option>
                  {opcoes.tratamentos.map((t) => <option key={t}>{t}</option>)}
                </select>
              </label>
              <label className="text-xs text-stone-500">
                Embalagem
                <select value={fEmbalagem} onChange={(e) => setFEmbalagem(e.target.value)} className={`${CAMPO} mt-1 block`}>
                  <option value="">todas</option>
                  {opcoes.embalagens.map((e2) => <option key={e2}>{e2}</option>)}
                </select>
              </label>
              <label className="min-w-44 flex-1 text-xs text-stone-500">
                Cliente, pedido, carga, motorista…
                <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="buscar" className={`${CAMPO} mt-1 block w-full`} />
              </label>
              {temFiltro && <Botao onClick={limparFiltros}>Limpar filtros</Botao>}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="text-xs uppercase tracking-wide text-stone-500">Status:</span>
              {statusExistentes.map((s) => {
                const ativo = statusSel.has(s)
                return (
                  <button
                    key={s}
                    onClick={() =>
                      setStatusSel((sel) => {
                        const novo = new Set(sel)
                        if (novo.has(s)) novo.delete(s)
                        else novo.add(s)
                        return novo
                      })
                    }
                    className={`rounded-full border px-2.5 py-0.5 text-xs ${
                      ativo
                        ? 'border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900'
                        : 'border-stone-300 text-stone-500 dark:border-stone-700'
                    }`}
                  >
                    {s}
                  </button>
                )
              })}
              <span className="ml-1 text-xs text-stone-400">
                (Finalizado começa fora: o caminhão já saiu e o estoque já desconta)
              </span>
            </div>
          </Cartao>

          {/* ---------------- o veredito ---------------- */}
          {faltas.length > 0 && (
            <div className="mb-5">
              <Aviso gravidade="bloqueio">
                <b>
                  {faltas.length} combinação(ões) não atendem os carregamentos
                  {ate && ` até ${diaCurto(ate)}`}:
                </b>{' '}
                faltam {inteiro(faltas.reduce((a, s) => a + -s.saldo, 0))} bags no total —
                nem adiantando a produção já aberta.
              </Aviso>
            </div>
          )}
          {precisamAdiantar.length > 0 && (
            <div className="mb-5">
              <Aviso gravidade="alerta">
                <b>{precisamAdiantar.length} combinação(ões) só atendem adiantando a produção:</b>{' '}
                {precisamAdiantar
                  .map((s) => `${s.cultivar} · ${s.tratamento} (adiantar ≥ ${inteiro(s.deficitPrazo)} bg)`)
                  .join(' — ')}.
                Vale marcar essas ordens como urgentes na Programação.
              </Aviso>
            </div>
          )}
          {faltas.length === 0 && precisamAdiantar.length === 0 && filtrados.length > 0 && (
            <div className="mb-5">
              <Aviso gravidade="ok">
                O estoque {ate ? `atende os carregamentos até ${diaCurto(ate)}` : 'atende tudo que está agendado'}.
              </Aviso>
            </div>
          )}

          {/* ---------------- saldo por combinação ---------------- */}
          <Cartao
            titulo={`Estoque × agendado (${saldos.length} combinações)`}
            className="mb-5"
          >
            {saldos.length === 0 ? (
              <Vazio>Nenhum carregamento passa pelos filtros.</Vazio>
            ) : (
              <>
                <Tabela cabecalho={['Cultivar', 'Tratamento', 'Emb.', '#Agendado',
                  '#Estoque', '#Prod. prevista', '#Saldo', '']}>
                  {saldos.map((s) => {
                    const precisaAdiantar = s.saldo >= 0 && s.deficitPrazo > 0
                    // embalagem que o app não conhece nunca casa com o estoque:
                    // a "falta" seria artefato do de-para, não falta real
                    const embDesconhecida = !s.semTsi && !EMBALAGENS_APP.has(s.embalagem)
                    return (
                      <tr
                        key={`${s.cultivar}|${s.tratamento}|${s.embalagem}`}
                        className={`border-t border-stone-100 dark:border-stone-800/60 ${
                          embDesconhecida
                            ? 'bg-amber-50/60 dark:bg-amber-950/20'
                            : s.saldo < 0
                              ? 'bg-red-50/60 dark:bg-red-950/20'
                              : precisaAdiantar
                                ? 'bg-amber-50/60 dark:bg-amber-950/20'
                                : ''
                        }`}
                      >
                        <td className="px-2 py-1.5 font-medium">{s.cultivar}</td>
                        <td className="px-2 py-1.5">
                          {s.semTsi ? <Tag cor="neutro">SEM TSI</Tag> : s.tratamento}
                        </td>
                        <td className="px-2 py-1.5">{s.embalagem}</td>
                        <td className="num-tabular px-2 py-1.5 text-right">{inteiro(s.agendado)}</td>
                        <td className="num-tabular px-2 py-1.5 text-right" title={s.semTsi ? 'Lotes de semente em estoque deste cultivar, todas as embalagens' : 'Estoque de produto acabado tratado'}>
                          {inteiro(s.estoque)}
                        </td>
                        <td className="num-tabular px-2 py-1.5 text-right text-stone-500" title={s.semTsi ? 'Semente branca não passa pela produção' : 'Todas as ordens abertas da combinação — produção se adianta, então a data não corta a conta'}>
                          {s.semTsi ? '—' : inteiro(s.producaoPrevista)}
                        </td>
                        <td className={`num-tabular px-2 py-1.5 text-right font-semibold ${
                          s.saldo < 0 ? 'text-red-700 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400'
                        }`}>
                          {s.saldo > 0 ? '+' : ''}{inteiro(s.saldo)}
                        </td>
                        <td className="px-2 py-1.5 whitespace-nowrap">
                          {embDesconhecida ? (
                            <Tag cor="alerta">embalagem sem de-para</Tag>
                          ) : s.saldo < 0 ? (
                            <Tag cor="perigo">faltam {inteiro(-s.saldo)}</Tag>
                          ) : precisaAdiantar ? (
                            <Tag cor="alerta">adiantar ≥ {inteiro(s.deficitPrazo)} bg</Tag>
                          ) : (
                            <Tag cor="ok">atende</Tag>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </Tabela>
                <p className="mt-3 text-xs text-stone-500">
                  <b>SEM TSI</b> compara com os lotes de semente em estoque — o cultivar vira
                  uma linha só, somando as embalagens, porque o pool de lotes é um.
                  Tratamento real compara com o estoque de produto acabado mais{' '}
                  <b>todas as ordens abertas</b> — a data programada não corta a conta, porque
                  produção se adianta. <b>Adiantar ≥ X</b> vem da linha do tempo: caminhão a
                  caminhão, conta como garantido o estoque, as ordens já iniciadas e as
                  programadas até a data de cada um; X é o pior buraco — o mínimo a puxar
                  para frente (candidata a urgência na Programação).
                </p>
              </>
            )}
          </Cartao>

          {/* ---------------- carregamentos ---------------- */}
          <Cartao titulo={`Carregamentos (${filtrados.length} de ${carregamentos.length})`} className="mb-5">
            {filtrados.length === 0 ? (
              <Vazio>Nenhum carregamento passa pelos filtros.</Vazio>
            ) : (
              <Tabela cabecalho={['Data', 'Carga', 'Status', 'Cliente', 'Cultivar',
                'Tratamento', 'Emb.', '#Bags', 'Transporte']}>
                {filtrados.map((c) => (
                  <tr key={c.id} className="border-t border-stone-100 dark:border-stone-800/60">
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      {c.data ? diaCurto(c.data) : (
                        <span className="text-amber-600 dark:text-amber-400">sem data</span>
                      )}
                    </td>
                    <td className="num-tabular px-2 py-1.5">{c.carga}</td>
                    <td className="px-2 py-1.5"><Tag cor={corStatusCarga(c.status)}>{c.status}</Tag></td>
                    <td className="max-w-56 truncate px-2 py-1.5" title={c.cliente ?? ''}>
                      {c.cliente ?? '—'}
                    </td>
                    <td className="px-2 py-1.5 font-medium">{c.cultivar}</td>
                    <td className="px-2 py-1.5">
                      {c.tratamento === SEM_TSI ? <Tag cor="neutro">SEM TSI</Tag> : c.tratamento}
                    </td>
                    <td className="px-2 py-1.5">{c.embalagem}</td>
                    <td className="num-tabular px-2 py-1.5 text-right">{inteiro(c.bags)}</td>
                    <td className="max-w-44 truncate px-2 py-1.5 text-xs text-stone-500"
                        title={`${c.transportadora ?? ''} · ${c.motorista ?? ''} · ${c.placa ?? ''}`}>
                      {c.placa ?? c.transportadora ?? '—'}
                    </td>
                  </tr>
                ))}
              </Tabela>
            )}
          </Cartao>
        </>
      )}

      {/* ---------------- pedidos de venda ---------------- */}
      <Cartao titulo={`Pedidos de venda (${pedidos.length} combinações)`}>
        <p className="mb-3 text-xs text-stone-500">
          O upload da SimpleAgro agrega os pedidos por cultivar + tratamento + embalagem — o
          detalhe por cliente não é guardado. <b>Aprovado</b> entra no balanço;{' '}
          <b>aguardando</b> é pedido integrado sem liberação financeira.
        </p>
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <label className="text-xs text-stone-500">
            Cultivar
            <select value={pCultivar} onChange={(e) => setPCultivar(e.target.value)} className={`${CAMPO} mt-1 block`}>
              <option value="">todos</option>
              {opcoesPedidos.cultivares.map((c) => <option key={c}>{c}</option>)}
            </select>
          </label>
          <label className="text-xs text-stone-500">
            Tratamento
            <select value={pTratamento} onChange={(e) => setPTratamento(e.target.value)} className={`${CAMPO} mt-1 block`}>
              <option value="">todos</option>
              {opcoesPedidos.tratamentos.map((t) => <option key={t}>{t}</option>)}
            </select>
          </label>
          <label className="text-xs text-stone-500">
            Embalagem
            <select value={pEmbalagem} onChange={(e) => setPEmbalagem(e.target.value)} className={`${CAMPO} mt-1 block`}>
              <option value="">todas</option>
              {opcoesPedidos.embalagens.map((e2) => <option key={e2}>{e2}</option>)}
            </select>
          </label>
          <label className="text-xs text-stone-500">
            Liberação financeira
            <select
              value={pLiberacao}
              onChange={(e) => setPLiberacao(e.target.value as typeof pLiberacao)}
              className={`${CAMPO} mt-1 block`}
            >
              <option value="todos">todas</option>
              <option value="aprovado">aprovado</option>
              <option value="pendente">aguardando aprovação</option>
            </select>
          </label>
          {(pCultivar || pTratamento || pEmbalagem || pLiberacao !== 'todos') && (
            <Botao onClick={() => { setPCultivar(''); setPTratamento(''); setPEmbalagem(''); setPLiberacao('todos') }}>
              Limpar filtros
            </Botao>
          )}
        </div>
        {pedidos.length === 0 ? (
          <Vazio>Nenhum pedido passa pelos filtros — ou nenhum upload de pedidos foi feito ainda (tela Ordens).</Vazio>
        ) : (
          <Tabela cabecalho={['Cultivar', 'Tratamento', 'Emb.', '#Aprovado', '#Aguardando',
            '#Estoque PA', '#Em ordens', '#Falta produzir', '']}>
            {pedidos.map((b) => (
              <tr key={`${b.cultivar}|${b.tratamento}|${b.embalagem}`}
                  className="border-t border-stone-100 dark:border-stone-800/60">
                <td className="px-2 py-1.5 font-medium">{b.cultivar}</td>
                <td className="px-2 py-1.5">{b.tratamento}</td>
                <td className="px-2 py-1.5">{b.embalagem}</td>
                <td className="num-tabular px-2 py-1.5 text-right">{inteiro(b.pedido_aprovado)}</td>
                <td className="num-tabular px-2 py-1.5 text-right text-stone-500">
                  {b.pedido_pendente > 0 ? inteiro(b.pedido_pendente) : '—'}
                </td>
                <td className="num-tabular px-2 py-1.5 text-right">{inteiro(b.estoque_pa)}</td>
                <td className="num-tabular px-2 py-1.5 text-right">{inteiro(b.ordens_abertas)}</td>
                <td className={`num-tabular px-2 py-1.5 text-right font-semibold ${
                  b.saldo > 0 ? 'text-red-700 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400'
                }`}>
                  {b.saldo > 0 ? inteiro(b.saldo) : '—'}
                </td>
                <td className="px-2 py-1.5">
                  {!b.receita_cadastrada && <Tag cor="alerta">receita não cadastrada</Tag>}
                </td>
              </tr>
            ))}
          </Tabela>
        )}
      </Cartao>
    </Pagina>
  )
}

function corStatusCarga(s: string): Parameters<typeof Tag>[0]['cor'] {
  if (/finalizado/i.test(s)) return 'roxo'
  if (/faturado/i.test(s)) return 'info'
  if (/agendado/i.test(s)) return 'ok'
  if (/aguardando/i.test(s)) return 'alerta'
  return 'neutro'
}
