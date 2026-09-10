import {
  useCallback, useEffect, useMemo, useState,
  type ChangeEvent, type Dispatch, type ReactNode, type SetStateAction,
} from 'react'
import readXlsxFile from 'read-excel-file/browser'
import * as g from '@/dados/api-gestao'
import type { AgendamentoBanco } from '@/dados/api-gestao'
import {
  converterAgendados,
  ehRelatorioAgendados,
  normalizaLinhasXlsx,
  resumoPorTipoVenda,
  saldosExpedicao,
  situacaoSaldo,
  SEM_TSI,
  type AlocacaoCaminhao,
  type LadoTipoVenda,
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

/**
 * Expedição (12/09/2026): o relatório de PEDIDOS AGENDADOS da SimpleAgro
 * cruzado com o estoque do SAP (lotes de semente pra branca, estoque PA pro
 * tratado — o upload da aba Ordens) e com a produção aberta, caminhão a
 * caminhão. A fila consolidada por produto decide o que é coberto; a visão
 * por tipo de venda (VENDA COOPERADO × OUTRAS) só detalha — nunca conta
 * estoque duas vezes.
 */
export default function Expedicao() {
  const { usuario, permitido } = useAuth()
  const podeImportar = permitido('expedicao', 'importar')

  const [agendamentos, setAgendamentos] = useState<AgendamentoBanco[]>([])
  const [lotes, setLotes] = useState<g.LoteSementeLinha[]>([])
  const [estoquePa, setEstoquePa] = useState<g.EstoquePaLinha[]>([])
  const [ordens, setOrdens] = useState<g.OrdemVisao[]>([])
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  // ---- filtros ----
  const [de, setDe] = useState('')
  const [ate, setAte] = useState('')
  const [tipoSel, setTipoSel] = useState<Set<string>>(new Set())
  const [statusSel, setStatusSel] = useState<Set<string>>(new Set())
  const [fCultivar, setFCultivar] = useState('')
  const [fTratamento, setFTratamento] = useState('')
  const [fEmbalagem, setFEmbalagem] = useState('')
  const [busca, setBusca] = useState('')

  const recarregar = useCallback(async () => {
    const [a, l, e, o] = await Promise.all([
      g.listarAgendamentos(), g.listarLotes(), g.listarEstoquePa(), g.listarOrdens(),
    ])
    setAgendamentos(a)
    setLotes(l)
    setEstoquePa(e)
    setOrdens(o)
  }, [])

  useEffect(() => {
    setCarregando(true)
    recarregar()
      .catch((e) => setErro(e instanceof Error ? e.message : String(e)))
      .finally(() => setCarregando(false))
  }, [recarregar])

  useRealtime(['agendamentos', 'ordens', 'lotes_semente'], recarregar)

  // chips começam todos ligados; um upload novo pode trazer valores novos, então
  // o padrão é refeito depois de importar
  const tiposExistentes = useMemo(
    () => [...new Set(agendamentos.map((a) => a.tipo_venda || '(sem tipo)'))].sort(),
    [agendamentos],
  )
  const statusExistentes = useMemo(
    () => [...new Set(agendamentos.map((a) => a.status_entrega))].sort(),
    [agendamentos],
  )
  const [chipsIniciados, setChipsIniciados] = useState(false)
  useEffect(() => {
    if (chipsIniciados || agendamentos.length === 0) return
    setTipoSel(new Set(tiposExistentes))
    setStatusSel(new Set(statusExistentes))
    setChipsIniciados(true)
  }, [agendamentos.length, tiposExistentes, statusExistentes, chipsIniciados])

  const filtrados = useMemo(
    () =>
      agendamentos.filter((a) => {
        if (de && (a.data == null || a.data < de)) return false
        if (ate && (a.data == null || a.data > ate)) return false
        if (tipoSel.size > 0 && !tipoSel.has(a.tipo_venda || '(sem tipo)')) return false
        if (statusSel.size > 0 && !statusSel.has(a.status_entrega)) return false
        if (fCultivar && a.cultivar !== fCultivar) return false
        if (fTratamento && a.tratamento !== fTratamento) return false
        if (fEmbalagem && a.embalagem !== fEmbalagem) return false
        if (busca.trim()) {
          const q = busca.trim().toLowerCase()
          const alvo = `${a.cliente ?? ''} ${a.pedido ?? ''} ${a.carga ?? ''} ${a.identificador} ${a.cidade ?? ''} ${a.estado ?? ''}`.toLowerCase()
          if (!alvo.includes(q)) return false
        }
        return true
      }),
    [agendamentos, de, ate, tipoSel, statusSel, fCultivar, fTratamento, fEmbalagem, busca],
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
          // fora_balanco (sacaria): a produção não vira estoque vendável —
          // não pode contar como material garantido/futuro pros caminhões
          .filter((o) => ABERTAS.includes(o.status_efetivo) && !o.fora_balanco)
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

  const porTipo = useMemo(() => resumoPorTipoVenda(saldos, (a) => a.cooperado), [saldos])
  /** Cobertura de cada agendamento, pela fila consolidada do produto dele. */
  const alocacao = useMemo(
    () =>
      new Map<string, AlocacaoCaminhao<AgendamentoBanco>>(
        saldos.flatMap((s) => s.caminhoes.map((c) => [c.caminhao.id, c] as const)),
      ),
    [saldos],
  )

  const faltas = saldos.filter((s) => situacaoSaldo(s) === 'falta')
  const precisamAdiantar = saldos.filter((s) => situacaoSaldo(s) === 'adiantar')
  const aguardando = saldos.filter((s) => situacaoSaldo(s) === 'aguardando-producao')

  const opcoes = useMemo(
    () => ({
      cultivares: [...new Set(agendamentos.map((a) => a.cultivar))].sort(),
      tratamentos: [...new Set(agendamentos.map((a) => a.tratamento))].sort(),
      embalagens: [...new Set(agendamentos.map((a) => a.embalagem))].sort(),
    }),
    [agendamentos],
  )

  const temFiltro =
    !!(de || ate || fCultivar || fTratamento || fEmbalagem || busca.trim()) ||
    tipoSel.size !== tiposExistentes.length ||
    statusSel.size !== statusExistentes.length

  function limparFiltros() {
    setDe('')
    setAte('')
    setFCultivar('')
    setFTratamento('')
    setFEmbalagem('')
    setBusca('')
    setTipoSel(new Set(tiposExistentes))
    setStatusSel(new Set(statusExistentes))
  }

  const alternar = (setter: Dispatch<SetStateAction<Set<string>>>, valor: string) =>
    setter((sel) => {
      const novo = new Set(sel)
      if (novo.has(valor)) novo.delete(valor)
      else novo.add(valor)
      return novo
    })

  // ---- upload ----
  async function importar(ev: ChangeEvent<HTMLInputElement>) {
    const arquivo = ev.target.files?.[0]
    ev.target.value = ''
    if (!arquivo) return
    setErro(null)
    setMsg(null)
    try {
      // aba nomeada faz o leitor devolver [{sheet, data}] em vez das linhas
      const rows = normalizaLinhasXlsx(await readXlsxFile(arquivo), ehRelatorioAgendados)
      if (!ehRelatorioAgendados(rows)) {
        throw new Error(
          'Este arquivo não parece o relatório de pedidos agendados (faltam as colunas IDENTIFICADOR / TIPO VENDA / QTD AGENDADA / DATA AGENDADA).',
        )
      }
      const { linhas, resumo } = converterAgendados(rows)
      await g.substituirAgendamentos(
        linhas.map((l) => ({
          identificador: l.identificador, pedido: l.pedido || null, tipo_venda: l.tipoVenda,
          cooperado: l.cooperado, cliente: l.cliente || null, cidade: l.cidade, estado: l.estado,
          cultivar: l.cultivar, categoria: l.categoria, tratamento: l.tratamento,
          embalagem: l.embalagem, qtd_pedido: l.qtdPedido, bags: l.bags,
          status_entrega: l.statusEntrega, carga: l.carga, status_carga: l.statusCarga,
          data: l.data, observacao: l.observacao,
        })),
        usuario!.id,
      )
      const status = Object.entries(resumo.porStatusEntrega).map(([s, n]) => `${s} ${n}`).join(', ')
      const avisos: string[] = []
      if (resumo.semData > 0) avisos.push(`${resumo.semData} sem data`)
      if (resumo.semQuantidade > 0) avisos.push(`${resumo.semQuantidade} sem quantidade (ignorados)`)
      if (resumo.identificadorRepetido > 0) avisos.push(`${resumo.identificadorRepetido} identificador(es) repetido(s)`)
      const embDesc = Object.keys(resumo.embalagemDesconhecida)
      if (embDesc.length > 0) avisos.push(`embalagem sem de-para: ${embDesc.join(', ')}`)
      setMsg(
        `${resumo.aproveitadas} agendamento(s) importados (substituição total): ` +
          `${inteiro(resumo.bagsCooperado)} bg cooperado · ${inteiro(resumo.bagsOutras)} bg outras` +
          (status ? ` · status: ${status}` : '') +
          (avisos.length ? `. Atenção: ${avisos.join(' · ')}.` : '.'),
      )
      setChipsIniciados(false) // tipos/status podem ter mudado; refaz o padrão
      await recarregar()
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    }
  }

  if (carregando) return <p className="p-8 text-sm text-stone-500">Carregando expedição…</p>

  return (
    <Pagina
      titulo="Expedição"
      descricao="Pedidos agendados cruzados com o saldo do SAP e a produção programada: o que atende, o que falta e em que data — no total e por tipo de venda."
      acoes={
        podeImportar ? (
          <label className="cursor-pointer rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-300">
            Importar pedidos agendados (.xlsx)
            <input type="file" accept=".xlsx" className="hidden" onChange={importar} />
          </label>
        ) : undefined
      }
    >
      {erro && <Erro>{erro}</Erro>}
      {msg && <div className="mb-4"><Aviso gravidade="ok">{msg}</Aviso></div>}

      {agendamentos.length === 0 ? (
        <Cartao titulo="Agendamentos" className="mb-5">
          <Vazio>
            Nenhum pedido agendado importado.
            {podeImportar
              ? ' Exporte o relatório de pedidos agendados na SimpleAgro e importe aqui.'
              : ' Peça ao PCP ou à logística para importar o relatório de pedidos agendados.'}
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
                Cliente, pedido, carga, cidade…
                <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="buscar" className={`${CAMPO} mt-1 block w-full`} />
              </label>
              {temFiltro && <Botao onClick={limparFiltros}>Limpar filtros</Botao>}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-xs uppercase tracking-wide text-stone-500">Tipo de venda:</span>
              {tiposExistentes.map((t) => (
                <Chip key={t} ativo={tipoSel.has(t)} onClick={() => alternar(setTipoSel, t)}>{t}</Chip>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-xs uppercase tracking-wide text-stone-500">Status entrega:</span>
              {statusExistentes.map((s) => (
                <Chip key={s} ativo={statusSel.has(s)} onClick={() => alternar(setStatusSel, s)}>{s}</Chip>
              ))}
              <span className="ml-1 text-xs text-stone-400">
                ("Aguardando Estoque" entra: é exatamente a demanda que precisa de estoque)
              </span>
            </div>
          </Cartao>

          {/* ---------------- o veredito ---------------- */}
          {faltas.length > 0 && (
            <div className="mb-5">
              <Aviso gravidade="bloqueio">
                <b>
                  {faltas.length} produto(s) não atendem o agendado
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
                <b>{precisamAdiantar.length} produto(s) só atendem adiantando a produção:</b>{' '}
                {precisamAdiantar
                  .map((s) => `${s.cultivar} · ${s.tratamento} (adiantar ≥ ${inteiro(s.deficitPrazo)} bg)`)
                  .join(' — ')}.
                Vale marcar essas ordens como urgentes na Programação.
              </Aviso>
            </div>
          )}
          {aguardando.length > 0 && (
            <div className="mb-5">
              <Aviso gravidade="alerta">
                <b>{aguardando.length} produto(s) sem estoque pronto</b> — dependem de
                produção programada (no prazo):{' '}
                {aguardando
                  .map((s) => `${s.cultivar} · ${s.tratamento} (${inteiro(s.agendado - s.estoque)} bg a produzir)`)
                  .join(' — ')}.
                O caminhão só carrega se essas ordens rodarem.
              </Aviso>
            </div>
          )}
          {faltas.length === 0 && precisamAdiantar.length === 0 && aguardando.length === 0 &&
            filtrados.length > 0 && (
            <div className="mb-5">
              <Aviso gravidade="ok">
                O estoque físico {ate ? `atende os agendamentos até ${diaCurto(ate)}` : 'atende tudo que está agendado'}.
              </Aviso>
            </div>
          )}

          {/* ---------------- saldo por produto (consolidado) ---------------- */}
          <Cartao
            titulo={`Estoque × agendado (${saldos.length} produtos)`}
            className="mb-5"
          >
            {saldos.length === 0 ? (
              <Vazio>Nenhum agendamento passa pelos filtros.</Vazio>
            ) : (
              <>
                <Tabela cabecalho={[
                  'Cultivar', 'Tratamento',
                  { texto: 'Emb.', className: 'hidden lg:table-cell' },
                  '#Agendado', '#Estoque',
                  { texto: '#Prod. prevista', className: 'hidden lg:table-cell' },
                  '#Saldo',
                  { texto: '#Descoberto', className: 'hidden lg:table-cell' },
                  '',
                ]}>
                  {saldos.map((s) => {
                    const situacao = situacaoSaldo(s)
                    const descoberto = s.caminhoes.reduce((t, c) => t + c.descoberto, 0)
                    // embalagem que o app não conhece nunca casa com o estoque:
                    // a "falta" seria artefato do de-para, não falta real
                    const embDesconhecida = !s.semTsi && !EMBALAGENS_APP.has(s.embalagem)
                    const fundo = embDesconhecida
                      ? 'bg-amber-50/60 dark:bg-amber-950/20'
                      : situacao === 'falta'
                        ? 'bg-red-50/60 dark:bg-red-950/20'
                        : situacao === 'adiantar'
                          ? 'bg-amber-50/60 dark:bg-amber-950/20'
                          : situacao === 'aguardando-producao'
                            ? 'bg-sky-50/60 dark:bg-sky-950/20'
                            : ''
                    return (
                      <tr
                        key={`${s.cultivar}|${s.tratamento}|${s.embalagem}`}
                        className={`border-t border-stone-100 dark:border-stone-800/60 ${fundo}`}
                      >
                        <td className="px-2 py-1.5 font-medium">
                          {s.cultivar}
                          <p className="text-xs font-normal text-stone-500 lg:hidden">
                            {s.embalagem}
                          </p>
                        </td>
                        <td className="px-2 py-1.5">
                          {s.semTsi ? <Tag cor="neutro">SEM TSI</Tag> : s.tratamento}
                        </td>
                        <td className="hidden px-2 py-1.5 lg:table-cell">{s.embalagem}</td>
                        <td className="num-tabular px-2 py-1.5 text-right">{inteiro(s.agendado)}</td>
                        <td className="num-tabular px-2 py-1.5 text-right" title={s.semTsi ? 'Lotes de semente em estoque deste cultivar, todas as embalagens' : 'Estoque de produto acabado tratado'}>
                          {inteiro(s.estoque)}
                        </td>
                        <td className="hidden num-tabular px-2 py-1.5 text-right text-stone-500 lg:table-cell" title={s.semTsi ? 'Semente branca não passa pela produção' : 'Todas as ordens abertas da combinação — produção se adianta, então a data não corta a conta'}>
                          {s.semTsi ? '—' : inteiro(s.producaoPrevista)}
                        </td>
                        <td className={`num-tabular px-2 py-1.5 text-right font-semibold ${
                          s.saldo < 0 ? 'text-red-700 dark:text-red-400' : 'text-green-700 dark:text-green-400'
                        }`}>
                          {s.saldo > 0 ? '+' : ''}{inteiro(s.saldo)}
                        </td>
                        <td className="hidden num-tabular px-2 py-1.5 text-right lg:table-cell" title="Bags que ficam fora dos caminhões se nada for adiantado — soma da fila em ordem de data">
                          {descoberto > 0 ? <span className="text-red-700 dark:text-red-400">{inteiro(descoberto)}</span> : '—'}
                        </td>
                        <td className="px-2 py-1.5 whitespace-nowrap">
                          {embDesconhecida ? (
                            <Tag cor="alerta">embalagem sem de-para</Tag>
                          ) : situacao === 'falta' ? (
                            <Tag cor="perigo">faltam {inteiro(-s.saldo)}</Tag>
                          ) : situacao === 'adiantar' ? (
                            <Tag cor="alerta">adiantar ≥ {inteiro(s.deficitPrazo)} bg</Tag>
                          ) : situacao === 'aguardando-producao' ? (
                            <span title={`${inteiro(s.agendado - s.estoque)} bags dependem de produção ainda não realizada (programada no prazo)`}>
                              <Tag cor="info">aguardando produção</Tag>
                            </span>
                          ) : (
                            <Tag cor="ok">atende</Tag>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </Tabela>
                <p className="mt-3 text-xs text-stone-500">
                  O estoque é o do <b>upload do SAP na aba Ordens</b>: <b>SEM TSI</b> compara com
                  os lotes de semente — o cultivar vira uma linha só, somando as embalagens,
                  porque o pool de lotes é um; tratamento real compara com o estoque de produto
                  acabado mais <b>todas as ordens abertas</b> (produção se adianta, a data não
                  corta a conta). <b>Adiantar ≥ X</b> vem da fila em ordem de data: caminhão a
                  caminhão, conta como garantido o estoque, as ordens já iniciadas e as
                  programadas até a data de cada um; X é o pior buraco. <b>Descoberto</b> é o que
                  fica fora dos caminhões se nada for adiantado. <b>Atende</b> é reservado a
                  estoque físico — coberta só por produção futura, a linha fica em{' '}
                  <b>aguardando produção</b>.
                </p>
              </>
            )}
          </Cartao>

          {/* ---------------- por tipo de venda ---------------- */}
          <Cartao titulo="Por tipo de venda" className="mb-5">
            <div className="grid gap-4 md:grid-cols-2">
              <PainelLado titulo="VENDA COOPERADO" lado={porTipo.cooperado} cor="roxo" />
              <PainelLado titulo="OUTRAS VENDAS" lado={porTipo.outras} cor="neutro" />
            </div>
            <p className="mt-3 text-xs text-stone-500">
              A fila é <b>uma só</b>: o estoque de cada produto é dado aos caminhões em ordem de
              data, sem olhar o tipo de venda — cada lado só soma o que coube e o que ficou
              descoberto nos seus caminhões. Nenhum bag é contado duas vezes.
            </p>
          </Cartao>

          {/* ---------------- agendamentos ---------------- */}
          <Cartao titulo={`Agendamentos (${filtrados.length} de ${agendamentos.length})`} className="mb-5">
            {filtrados.length === 0 ? (
              <Vazio>Nenhum agendamento passa pelos filtros.</Vazio>
            ) : (
              <Tabela cabecalho={[
                'Data',
                { texto: 'Pedido', className: 'hidden lg:table-cell' },
                { texto: 'Tipo venda', className: 'hidden lg:table-cell' },
                'Status', 'Cliente', 'Cultivar',
                { texto: 'Tratamento', className: 'hidden lg:table-cell' },
                { texto: 'Emb.', className: 'hidden lg:table-cell' },
                '#Agendado',
                { texto: 'Carga', className: 'hidden lg:table-cell' },
                '',
              ]}>
                {[...filtrados]
                  .sort((a, b) => (a.data ?? '').localeCompare(b.data ?? '') || (a.cliente ?? '').localeCompare(b.cliente ?? ''))
                  .map((a) => {
                    const al = alocacao.get(a.id)
                    return (
                      <tr key={a.id} className="border-t border-stone-100 dark:border-stone-800/60">
                        <td className="px-2 py-1.5 whitespace-nowrap">
                          {a.data ? diaCurto(a.data) : (
                            <span className="text-amber-600 dark:text-amber-400">sem data</span>
                          )}
                        </td>
                        <td className="hidden num-tabular px-2 py-1.5 lg:table-cell">{a.pedido ?? '—'}</td>
                        <td className="hidden px-2 py-1.5 lg:table-cell">
                          {a.cooperado ? <Tag cor="roxo">{a.tipo_venda}</Tag> : <span className="text-stone-600 dark:text-stone-300">{a.tipo_venda || '—'}</span>}
                        </td>
                        <td className="px-2 py-1.5"><Tag cor={corStatusEntrega(a.status_entrega)}>{a.status_entrega}</Tag></td>
                        {/* break-words em vez de truncate: em toque não há hover pro title */}
                        <td className="max-w-56 break-words px-2 py-1.5">
                          {a.cliente ?? '—'}
                          {(a.cidade || a.estado) && (
                            <p className="text-xs text-stone-500">{[a.cidade, a.estado].filter(Boolean).join('/')}</p>
                          )}
                          <p className="text-xs text-stone-500 lg:hidden">
                            {[a.pedido && `pedido ${a.pedido}`, a.cooperado ? 'COOPERADO' : null, a.carga && `carga ${a.carga}`]
                              .filter(Boolean)
                              .join(' · ')}
                          </p>
                        </td>
                        <td className="px-2 py-1.5 font-medium">
                          {a.cultivar}
                          <p className="text-xs font-normal text-stone-500 lg:hidden">
                            {a.tratamento === SEM_TSI ? 'SEM TSI' : a.tratamento} · {a.embalagem}
                          </p>
                        </td>
                        <td className="hidden px-2 py-1.5 lg:table-cell">
                          {a.tratamento === SEM_TSI ? <Tag cor="neutro">SEM TSI</Tag> : a.tratamento}
                        </td>
                        <td className="hidden px-2 py-1.5 lg:table-cell">{a.embalagem}</td>
                        <td
                          className="num-tabular px-2 py-1.5 text-right"
                          title={a.qtd_pedido !== a.bags ? `Pedido de ${inteiro(a.qtd_pedido)} bags — agendados ${inteiro(a.bags)}` : undefined}
                        >
                          {inteiro(a.bags)}
                          {a.qtd_pedido > a.bags && <span className="text-xs text-stone-400"> / {inteiro(a.qtd_pedido)}</span>}
                        </td>
                        <td className="hidden px-2 py-1.5 text-xs text-stone-500 lg:table-cell">
                          {a.carga ? `${a.carga}${a.status_carga ? ` · ${a.status_carga}` : ''}` : '—'}
                        </td>
                        <td className="px-2 py-1.5 whitespace-nowrap">
                          {al == null ? null : al.descoberto <= 0 ? (
                            <Tag cor="ok">coberto</Tag>
                          ) : al.coberto <= 0 ? (
                            <Tag cor="perigo">descoberto {inteiro(al.descoberto)}</Tag>
                          ) : (
                            <Tag cor="alerta">parcial {inteiro(al.coberto)} de {inteiro(al.bags)}</Tag>
                          )}
                        </td>
                      </tr>
                    )
                  })}
              </Tabela>
            )}
          </Cartao>
        </>
      )}
    </Pagina>
  )
}

function Chip({ ativo, onClick, children }: { ativo: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-2.5 py-1.5 text-xs sm:py-0.5 ${
        ativo
          ? 'border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900'
          : 'border-stone-300 text-stone-500 dark:border-stone-700'
      }`}
    >
      {children}
    </button>
  )
}

function PainelLado({ titulo, lado, cor }: { titulo: string; lado: LadoTipoVenda; cor: Parameters<typeof Tag>[0]['cor'] }) {
  return (
    <div className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
      <div className="flex items-baseline justify-between gap-2">
        <Tag cor={cor}>{titulo}</Tag>
        <span className="text-xs text-stone-500">{lado.caminhoes} agendamento(s)</span>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div>
          <dt className="text-xs text-stone-500">Agendado</dt>
          <dd className="num-tabular text-lg font-semibold">{inteiro(lado.agendado)}</dd>
        </div>
        <div>
          <dt className="text-xs text-stone-500">Coberto</dt>
          <dd className="num-tabular text-lg font-semibold text-green-700 dark:text-green-400">{inteiro(lado.coberto)}</dd>
        </div>
        <div>
          <dt className="text-xs text-stone-500">Descoberto</dt>
          <dd className={`num-tabular text-lg font-semibold ${lado.descoberto > 0 ? 'text-red-700 dark:text-red-400' : 'text-stone-400'}`}>
            {inteiro(lado.descoberto)}
          </dd>
        </div>
      </dl>
      {lado.produtosEmFalta.length > 0 ? (
        <ul className="mt-3 space-y-1 text-sm">
          {lado.produtosEmFalta.map((p) => (
            <li key={`${p.cultivar}|${p.tratamento}|${p.embalagem}`} className="flex items-baseline justify-between gap-2">
              <span>
                <b>{p.cultivar}</b> · {p.tratamento === SEM_TSI ? 'SEM TSI' : p.tratamento}
                <span className="text-xs text-stone-500"> · {p.embalagem}</span>
              </span>
              <Tag cor="perigo">faltam {inteiro(p.descoberto)}</Tag>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-xs text-green-700 dark:text-green-400">
          {lado.caminhoes === 0 ? 'Nenhum agendamento deste tipo nos filtros.' : 'Tudo coberto na data.'}
        </p>
      )}
    </div>
  )
}

function corStatusEntrega(s: string): Parameters<typeof Tag>[0]['cor'] {
  if (/aprovado/i.test(s)) return 'ok'
  if (/aguardando/i.test(s)) return 'alerta'
  if (/cancel/i.test(s)) return 'perigo'
  return 'neutro'
}
