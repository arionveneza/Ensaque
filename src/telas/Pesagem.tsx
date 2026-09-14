import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import * as api from '@/dados/api-pesagem'
import type { PesagemLinha, TipoVeiculo } from '@/dados/api-pesagem'
import {
  avaliarPesagem,
  COR_LEGISLACAO,
  COR_LIBERADO,
  COR_ORDEM,
  COR_PODE_CARREGAR,
  conferenciaFinal,
  formatarDifKg,
  formatarPct,
  inteiroPositivo,
  normalizarPlaca,
  placaValida,
  preConferencia,
  resumoPesagens,
  ROTULO_LEGISLACAO,
  ROTULO_LIBERADO,
  ROTULO_ORDEM,
  ROTULO_PODE_CARREGAR,
  type Liberado,
  type PesagemAvaliada,
} from '@/dominio/pesagem'
import { useRealtime } from '@/dados/useRealtime'
import { useAuth } from '@/auth/AuthProvider'
import { useRascunho } from '@/lib/useRascunho'
import { exportarXlsx } from '@/lib/exportar'
import {
  Aviso, Botao, Cartao, Erro, Pagina, Tabela, Tag, Vazio, dataHoraCurta, diaCurto, inteiro,
} from '@/componentes/ui'

const INPUT =
  'rounded-md border border-stone-300 px-2 py-2 text-sm sm:py-1 dark:border-stone-700 dark:bg-stone-800'

/** Executa, recarrega e devolve a mensagem de erro (null = deu certo) — o modal decide onde mostrar. */
type Acao = (fn: () => Promise<void>) => Promise<string | null>

interface Avaliada {
  p: PesagemLinha
  a: PesagemAvaliada
}

type Modal =
  | { tipo: 'nova' }
  | { tipo: 'ajustar'; pesagem: PesagemLinha }
  | { tipo: 'pesar'; pesagem: PesagemLinha; correcao: boolean }
  | null

/** Data-calendário local: a pesagem é documento do caminhão, não turno de produção. */
const hojeIso = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const dataValida = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)
/** Conflito de versão: o modal fecha e a lista, já recarregada, mostra o que o outro gravou. */
const ehConflito = (m: string) => m.includes('outro operador')

/**
 * Pesagem — checklist de carregamento com conferência de peso (14/09/2026).
 * Etapa 1 (pré-conferência: tara + ordem × PBT) e Etapa 2 (bruto da balança
 * → líquido, legislação, × ordem, Liberado?). Regras em src/dominio/pesagem.ts.
 */
export default function Pesagem() {
  const { usuario, permitido } = useAuth()
  const podeRegistrar = permitido('pesagem', 'registrar')
  const podeAdministrar = permitido('pesagem', 'administrar')

  const [tipos, setTipos] = useState<TipoVeiculo[]>([])
  const [params, setParams] = useState<api.ParametrosPesagemLinha | null>(null)
  const [pesagens, setPesagens] = useState<PesagemLinha[]>([])
  const [nomes, setNomes] = useState<Map<string, string>>(new Map())
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [modal, setModal] = useState<Modal>(null)
  const [mostrarParametros, setMostrarParametros] = useState(false)

  // ---- filtros ----
  const [de, setDe] = useState(hojeIso)
  const [ate, setAte] = useState(hojeIso)
  const [fPlaca, setFPlaca] = useState('')
  const [fOrdem, setFOrdem] = useState('')
  const [fTipo, setFTipo] = useState('')
  const [fLiberado, setFLiberado] = useState<Set<Liberado>>(new Set())

  /**
   * O período só refaz a consulta de pesagens — sem passar pelo "Carregando…"
   * que desmontaria a página (o input de data dispara onChange a cada
   * segmento digitado) e sem consultar com data pela metade.
   */
  const recarregar = useCallback(async () => {
    if (!dataValida(de) || !dataValida(ate)) return
    const [t, pr, ps, nm] = await Promise.all([
      api.listarTiposVeiculo(),
      api.lerParametros(),
      api.listarPesagens({ de, ate }),
      api.mapaNomesUsuarios(),
    ])
    setTipos(t)
    setParams(pr)
    setPesagens(ps)
    setNomes(nm)
  }, [de, ate])

  useEffect(() => {
    let vivo = true
    recarregar()
      .then(() => vivo && setErro(null))
      .catch((e) => vivo && setErro(e instanceof Error ? e.message : String(e)))
      .finally(() => vivo && setCarregando(false))
    return () => {
      vivo = false
    }
  }, [recarregar])

  useRealtime(['pesagens', 'tipos_veiculo', 'parametros_pesagem'], recarregar)

  const acao = useCallback<Acao>(
    async (fn) => {
      try {
        setErro(null)
        setMsg(null)
        await fn()
        await recarregar()
        return null
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e)
        setErro(m)
        // conflito de versão: a lista precisa refletir o que o outro operador gravou
        await recarregar().catch(() => undefined)
        return m
      }
    },
    [recarregar],
  )

  const tol = useMemo(
    () => ({
      tolLegalPct: params?.tolerancia_legal_pct ?? 0.05,
      tolOrdemPct: params?.tolerancia_ordem_pct ?? 0.005,
    }),
    [params],
  )

  const tipoNome = useCallback(
    (id: string) => tipos.find((t) => t.id === id)?.nome ?? '—',
    [tipos],
  )
  const nome = useCallback((id: string | null) => (id ? (nomes.get(id) ?? '—') : '—'), [nomes])

  const avaliadas = useMemo<Avaliada[]>(
    () => pesagens.map((p) => ({ p, a: avaliarPesagem(p, tol) })),
    [pesagens, tol],
  )

  const filtradas = useMemo(() => {
    const placa = normalizarPlaca(fPlaca)
    const ordem = fOrdem.trim().toLowerCase()
    return avaliadas
      .filter(({ p, a }) => {
        if (placa && !p.placa.includes(placa)) return false
        if (ordem && !p.numero_ordem.toLowerCase().includes(ordem)) return false
        if (fTipo && p.tipo_veiculo_id !== fTipo) return false
        if (fLiberado.size > 0 && !fLiberado.has(a.liberado)) return false
        return true
      })
      // pendente primeiro dentro do dia: é o caminhão no pátio esperando a balança
      .sort(
        (x, y) =>
          y.p.data.localeCompare(x.p.data) ||
          (x.a.liberado === 'PENDENTE' ? 0 : 1) - (y.a.liberado === 'PENDENTE' ? 0 : 1) ||
          y.p.criado_em.localeCompare(x.p.criado_em),
      )
  }, [avaliadas, fPlaca, fOrdem, fTipo, fLiberado])

  const resumo = useMemo(
    () => resumoPesagens(filtradas.map(({ p, a }) => ({ base: p, avaliada: a }))),
    [filtradas],
  )

  const temFiltro = !!(fPlaca || fOrdem || fTipo || fLiberado.size > 0)
  const limparFiltros = () => {
    setFPlaca('')
    setFOrdem('')
    setFTipo('')
    setFLiberado(new Set())
  }
  const alternarLiberado = (v: Liberado) =>
    setFLiberado((s) => {
      const n = new Set(s)
      if (n.has(v)) n.delete(v)
      else n.add(v)
      return n
    })

  async function exportar() {
    const linhas = filtradas.map(({ p, a }) => [
      diaCurto(p.data),
      p.numero_ordem,
      p.placa,
      tipoNome(p.tipo_veiculo_id),
      p.peso_tara_kg,
      p.peso_ordem_kg,
      p.pbt_max_kg_aplicado,
      a.capacidadeLiquidaKg,
      a.brutoPrevistoKg,
      a.excessoPrevistoKg,
      a.podeCarregar,
      p.peso_bruto_final_kg,
      a.liquidoKg,
      a.pbtComToleranciaKg == null ? null : Math.round(a.pbtComToleranciaKg),
      a.excessoRealKg,
      a.diferencaKg,
      a.diferencaPct == null ? null : Math.round(a.diferencaPct * 10000) / 100,
      a.statusLegislacao,
      a.statusOrdem,
      a.liberado,
      nome(p.pesado_por ?? p.criado_por),
      p.excesso_autorizado_em ? `${nome(p.excesso_autorizado_por)} em ${dataHoraCurta(p.excesso_autorizado_em)}` : '',
      p.corrigido_em ? `${nome(p.corrigido_por)} em ${dataHoraCurta(p.corrigido_em)}` : '',
      p.observacoes ?? '',
    ])
    const num = (titulo: string, largura = 12) => ({ titulo, largura, tipo: 'numero' as const, casas: 0 })
    await exportarXlsx(`pesagens-${de}${ate !== de ? `-a-${ate}` : ''}`, [
      { titulo: 'Data', largura: 11 },
      { titulo: 'Nº Ordem', largura: 12 },
      { titulo: 'Placa', largura: 10 },
      { titulo: 'Tipo', largura: 12 },
      num('Tara (kg)'), num('Peso ordem (kg)', 14), num('PBT máx (kg)'),
      num('Capacidade líquida (kg)', 18), num('Bruto previsto (kg)', 16), num('Excesso previsto (kg)', 18),
      { titulo: 'Pode carregar?', largura: 14 },
      num('Bruto final (kg)', 14), num('Líquido (kg)'), num('PBT c/ tolerância (kg)', 18),
      num('Excesso real (kg)', 14), num('Diferença ordem (kg)', 16),
      { titulo: 'Diferença ordem (%)', largura: 16, tipo: 'numero', casas: 2 },
      { titulo: 'Status legislação', largura: 16 },
      { titulo: 'Status x ordem', largura: 18 },
      { titulo: 'Liberado?', largura: 10 },
      { titulo: 'Responsável', largura: 18 },
      { titulo: 'Excesso autorizado', largura: 26 },
      { titulo: 'Corrigido', largura: 26 },
      { titulo: 'Observações', largura: 40 },
    ], linhas)
  }

  if (carregando) return <p className="p-8 text-sm text-stone-500">Carregando pesagens…</p>

  return (
    <Pagina
      titulo="Pesagem"
      descricao="Checklist de carregamento: antes de carregar, tara + peso da ordem × PBT do veículo; depois da balança, líquido, legislação e conferência com a ordem."
      acoes={
        <div className="flex flex-wrap items-center gap-2">
          {podeAdministrar && (
            <Botao onClick={() => setMostrarParametros((v) => !v)}>
              {mostrarParametros ? 'Fechar parâmetros' : 'Parâmetros'}
            </Botao>
          )}
          <Botao onClick={() => acao(exportar)} disabled={filtradas.length === 0}>
            Exportar .xlsx
          </Botao>
          {podeRegistrar && (
            <Botao variante="primario" onClick={() => setModal({ tipo: 'nova' })}>
              Novo carregamento
            </Botao>
          )}
        </div>
      }
    >
      {erro && <Erro>{erro}</Erro>}
      {msg && <div className="mb-4"><Aviso gravidade="ok">{msg}</Aviso></div>}
      {params && !params.existe && (
        <div className="mb-4">
          <Aviso gravidade="alerta">
            Parâmetros de pesagem não encontrados no banco — usando 5% (legislação) e 0,5% (ordem).
            Rode a migração <code>pesagem.sql</code>.
          </Aviso>
        </div>
      )}

      {mostrarParametros && podeAdministrar && params && usuario && (
        // key: mudança vinda de outro Gestor (realtime) reabre o cartão com os valores novos
        <CartaoParametros key={params.atualizado_em ?? 'sem'} tipos={tipos} params={params} usuarioId={usuario.id} acao={acao} />
      )}

      {/* ---------------- resumo ---------------- */}
      <Cartao titulo="Resumo do período" className="mb-5">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Indicador rotulo="Carregamentos" valor={resumo.registrados} />
          <Indicador rotulo="Pré-conferência" valor={`${resumo.preSim} sim · ${resumo.preNao} não`} cor={resumo.preNao > 0 ? 'perigo' : undefined} />
          <Indicador rotulo="Pesagens concluídas" valor={resumo.pesados} />
          <Indicador
            rotulo="Legislação"
            valor={`${resumo.legislacaoOk} ok · ${resumo.legislacaoAtencao} atenção · ${resumo.legislacaoExcesso} excesso`}
            cor={resumo.legislacaoExcesso > 0 ? 'perigo' : resumo.legislacaoAtencao > 0 ? 'alerta' : undefined}
          />
          <Indicador rotulo="× Ordem" valor={`${resumo.ordemOk} ok · ${resumo.ordemDivergente} divergente`} cor={resumo.ordemDivergente > 0 ? 'perigo' : undefined} />
          <Indicador
            rotulo="Liberado?"
            valor={`${resumo.liberadoSim} sim · ${resumo.liberadoNao} não · ${resumo.liberadoPendente} pend.`}
            cor={resumo.liberadoPendente > 0 ? 'alerta' : undefined}
          />
          <Indicador rotulo="Líquido carregado" valor={`${inteiro(resumo.liquidoKg)} kg`} />
          <Indicador rotulo="Ordens pesadas" valor={`${inteiro(resumo.ordemPesadaKg)} kg`} />
        </div>
      </Cartao>

      {/* ---------------- filtros ---------------- */}
      <Cartao titulo="Filtros" className="mb-5">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-stone-500">
            De
            <input type="date" value={de} onChange={(e) => setDe(e.target.value)} className={`${INPUT} mt-1 block`} />
          </label>
          <label className="text-xs text-stone-500">
            Até
            <input type="date" value={ate} onChange={(e) => setAte(e.target.value)} className={`${INPUT} mt-1 block`} />
          </label>
          <label className="text-xs text-stone-500">
            Placa
            <input value={fPlaca} onChange={(e) => setFPlaca(e.target.value)} placeholder="ABC1D23" className={`${INPUT} mt-1 block w-28 uppercase`} />
          </label>
          <label className="text-xs text-stone-500">
            Nº ordem
            <input value={fOrdem} onChange={(e) => setFOrdem(e.target.value)} className={`${INPUT} mt-1 block w-28`} />
          </label>
          <label className="text-xs text-stone-500">
            Tipo de veículo
            <select value={fTipo} onChange={(e) => setFTipo(e.target.value)} className={`${INPUT} mt-1 block`}>
              <option value="">todos</option>
              {tipos.map((t) => <option key={t.id} value={t.id}>{t.nome}</option>)}
            </select>
          </label>
          {temFiltro && <Botao onClick={limparFiltros}>Limpar filtros</Botao>}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-stone-500">Liberado?:</span>
          {(['PENDENTE', 'SIM', 'NAO'] as const).map((v) => (
            <Chip key={v} ativo={fLiberado.has(v)} onClick={() => alternarLiberado(v)}>
              {ROTULO_LIBERADO[v]}
            </Chip>
          ))}
          <span className="ml-1 text-xs text-stone-400">(nenhum marcado = todos)</span>
        </div>
      </Cartao>

      {/* ---------------- lista ---------------- */}
      <Cartao titulo={`Carregamentos (${filtradas.length} de ${pesagens.length})`}>
        {filtradas.length === 0 ? (
          <Vazio>
            {pesagens.length === 0
              ? 'Nenhum carregamento no período.'
              : 'Nenhum carregamento passa pelos filtros.'}
          </Vazio>
        ) : (
          <Tabela cabecalho={[
            'Data', 'Nº Ordem', 'Placa',
            { texto: 'Tipo', className: 'hidden lg:table-cell' },
            { texto: '#Tara', className: 'hidden lg:table-cell' },
            { texto: '#Peso ordem', className: 'hidden md:table-cell' },
            'Pode carregar?',
            '#Bruto final', '#Líquido',
            { texto: '#Dif. ordem', className: 'hidden md:table-cell' },
            'Legislação', '× Ordem', 'Liberado?',
            { texto: 'Responsável', className: 'hidden lg:table-cell' },
            '',
          ]}>
            {filtradas.map(({ p, a }) => {
              const pendente = a.liberado === 'PENDENTE'
              return (
                <tr
                  key={p.id}
                  className={`border-t border-stone-100 dark:border-stone-800/60 [&>td]:py-2 [&>td]:align-middle ${
                    pendente ? 'bg-amber-50/70 dark:bg-amber-950/20' : ''
                  }`}
                >
                  <td className="px-2 whitespace-nowrap">{diaCurto(p.data)}</td>
                  <td className="px-2 font-medium">
                    {p.numero_ordem}
                    <p className="text-xs font-normal text-stone-500 lg:hidden">
                      {tipoNome(p.tipo_veiculo_id)} · tara {inteiro(p.peso_tara_kg)} · ordem {inteiro(p.peso_ordem_kg)}
                    </p>
                  </td>
                  <td className="num-tabular px-2 font-mono text-xs">{p.placa}</td>
                  <td className="hidden px-2 lg:table-cell">{tipoNome(p.tipo_veiculo_id)}</td>
                  <td className="num-tabular hidden px-2 text-right lg:table-cell">{inteiro(p.peso_tara_kg)}</td>
                  <td className="num-tabular hidden px-2 text-right md:table-cell">{inteiro(p.peso_ordem_kg)}</td>
                  <td className="px-2">
                    <span title={a.mensagem}>
                      <Tag cor={COR_PODE_CARREGAR[a.podeCarregar]} className="min-w-16 justify-center">
                        {a.podeCarregar === 'NAO' ? `NÃO · +${inteiro(a.excessoPrevistoKg)} kg` : a.podeCarregar}
                      </Tag>
                    </span>
                  </td>
                  <td className="num-tabular px-2 text-right">
                    {p.peso_bruto_final_kg == null ? <span className="text-stone-400">—</span> : inteiro(p.peso_bruto_final_kg)}
                  </td>
                  <td className="num-tabular px-2 text-right font-semibold">
                    {a.liquidoKg == null ? <span className="font-normal text-stone-400">—</span> : inteiro(a.liquidoKg)}
                  </td>
                  <td className="num-tabular hidden px-2 text-right md:table-cell" title={a.diferencaPct == null ? undefined : formatarPct(a.diferencaPct)}>
                    {a.diferencaKg == null ? <span className="text-stone-400">—</span> : (
                      <>
                        {formatarDifKg(a.diferencaKg)}
                        <span className="block text-[10px] text-stone-500">{formatarPct(a.diferencaPct)}</span>
                      </>
                    )}
                  </td>
                  <td className="px-2">
                    <span title={ROTULO_LEGISLACAO[a.statusLegislacao]}>
                      <Tag cor={COR_LEGISLACAO[a.statusLegislacao]} className="min-w-24 justify-center">
                        {a.statusLegislacao === 'AGUARDANDO' ? 'aguardando' : a.statusLegislacao === 'ATENCAO' ? 'ATENÇÃO' : a.statusLegislacao}
                      </Tag>
                    </span>
                  </td>
                  <td className="px-2">
                    <span title={ROTULO_ORDEM[a.statusOrdem]}>
                      <Tag cor={COR_ORDEM[a.statusOrdem]} className="min-w-24 justify-center">
                        {a.statusOrdem === 'AGUARDANDO' ? 'aguardando' : a.statusOrdem === 'OK' ? 'OK' : a.statusOrdem === 'DIVERGENTE_ACIMA' ? 'ACIMA' : 'ABAIXO'}
                      </Tag>
                    </span>
                  </td>
                  <td className="px-2">
                    <div className="flex flex-col items-start gap-1">
                      <Tag cor={COR_LIBERADO[a.liberado]} className="min-w-24 justify-center font-semibold">
                        {a.liberado === 'PENDENTE' ? 'PENDENTE' : a.liberado === 'SIM' ? 'LIBERADO' : 'NÃO LIBERADO'}
                      </Tag>
                      {p.excesso_autorizado_em && (
                        <span
                          className="text-[10px] text-amber-700 dark:text-amber-400"
                          title={`Pesado mesmo com a pré-conferência NÃO — autorizado por ${nome(p.excesso_autorizado_por)} em ${dataHoraCurta(p.excesso_autorizado_em)}`}
                        >
                          excesso autorizado
                        </span>
                      )}
                      {p.corrigido_em && (
                        <span
                          className="text-[10px] text-stone-500"
                          title={`Bruto corrigido por ${nome(p.corrigido_por)} em ${dataHoraCurta(p.corrigido_em)}`}
                        >
                          corrigido
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="hidden px-2 text-xs lg:table-cell">
                    {nome(p.pesado_por ?? p.criado_por)}
                    {p.pesado_em && <span className="block text-[10px] text-stone-500">{dataHoraCurta(p.pesado_em)}</span>}
                  </td>
                  <td className="px-2 whitespace-nowrap text-right">
                    {podeRegistrar && p.peso_bruto_final_kg == null && (
                      <>
                        <Botao
                          variante="primario"
                          className="mr-1.5"
                          onClick={() => setModal({ tipo: 'pesar', pesagem: p, correcao: false })}
                        >
                          Pesar
                        </Botao>
                        <button
                          onClick={() => setModal({ tipo: 'ajustar', pesagem: p })}
                          className="-m-1.5 rounded p-1.5 text-xs underline"
                        >
                          ajustar
                        </button>
                      </>
                    )}
                    {podeAdministrar && p.peso_bruto_final_kg != null && (
                      <button
                        onClick={() => setModal({ tipo: 'pesar', pesagem: p, correcao: true })}
                        className="-m-1.5 rounded p-1.5 text-xs underline"
                      >
                        corrigir bruto
                      </button>
                    )}
                    {p.observacoes && (
                      <span className="ml-2 cursor-help text-xs text-stone-400" title={p.observacoes}>obs.</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </Tabela>
        )}
      </Cartao>

      {modal?.tipo === 'nova' && usuario && (
        <ModalEtapa1
          tipos={tipos}
          usuarioId={usuario.id}
          acao={acao}
          onFechar={() => setModal(null)}
          onGravado={(n) => setMsg(`Carregamento da ordem ${n} registrado.`)}
        />
      )}
      {modal?.tipo === 'ajustar' && usuario && (
        <ModalEtapa1
          tipos={tipos}
          usuarioId={usuario.id}
          acao={acao}
          existente={modal.pesagem}
          onFechar={() => setModal(null)}
          onGravado={(n) => setMsg(`Carregamento da ordem ${n} ajustado.`)}
        />
      )}
      {modal?.tipo === 'pesar' && usuario && (
        <ModalEtapa2
          pesagem={modal.pesagem}
          correcao={modal.correcao}
          tipoNome={tipoNome(modal.pesagem.tipo_veiculo_id)}
          tol={tol}
          responsavel={usuario.nome}
          acao={acao}
          onFechar={() => setModal(null)}
          onGravado={(lib) =>
            setMsg(
              lib === 'SIM'
                ? 'Pesagem registrada — veículo LIBERADO.'
                : 'Pesagem registrada — veículo NÃO liberado; veja legislação e conferência com a ordem.',
            )
          }
        />
      )}
    </Pagina>
  )
}

// ================================================================
// Peças
// ================================================================

function Indicador({ rotulo, valor, cor }: { rotulo: string; valor: ReactNode; cor?: 'alerta' | 'perigo' }) {
  const corValor =
    cor === 'perigo'
      ? 'text-red-700 dark:text-red-400'
      : cor === 'alerta'
        ? 'text-amber-700 dark:text-amber-400'
        : ''
  return (
    <div className="rounded-lg border border-stone-200 px-3 py-2 dark:border-stone-800">
      <p className="text-[10px] uppercase tracking-wide text-stone-500">{rotulo}</p>
      <p className={`num-tabular mt-0.5 text-sm font-semibold ${corValor}`}>{valor}</p>
    </div>
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

function Casca({ titulo, children, onFechar }: { titulo: string; children: ReactNode; onFechar: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onFechar}>
      <div
        className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white p-5 dark:bg-stone-900"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold">{titulo}</h3>
        {children}
      </div>
    </div>
  )
}

function Linha({ rotulo, valor, destaque }: { rotulo: string; valor: ReactNode; destaque?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-stone-100 py-1 text-sm last:border-0 dark:border-stone-800">
      <span className="text-stone-500">{rotulo}</span>
      <span className={`num-tabular text-right ${destaque ? 'font-semibold' : ''}`}>{valor}</span>
    </div>
  )
}

// ================================================================
// Etapa 1 — registrar / ajustar carregamento
// ================================================================

interface FormEtapa1 {
  data: string
  numeroOrdem: string
  placa: string
  tipoId: string
  tara: string
  ordem: string
}

function ModalEtapa1({
  tipos, usuarioId, acao, existente, onFechar, onGravado,
}: {
  tipos: TipoVeiculo[]
  usuarioId: string
  acao: Acao
  existente?: PesagemLinha
  onFechar: () => void
  onGravado: (numeroOrdem: string) => void
}) {
  const vazio: FormEtapa1 = { data: hojeIso(), numeroOrdem: '', placa: '', tipoId: '', tara: '', ordem: '' }
  // registro novo sobrevive a F5/troca de tela; ajuste de um existente não usa rascunho
  const rasc = useRascunho<FormEtapa1>('pesagem-etapa1', vazio)
  const [local, setLocal] = useState<FormEtapa1>(() =>
    existente
      ? {
          data: existente.data,
          numeroOrdem: existente.numero_ordem,
          placa: existente.placa,
          tipoId: existente.tipo_veiculo_id,
          tara: String(existente.peso_tara_kg),
          ordem: String(existente.peso_ordem_kg),
        }
      : vazio,
  )
  const f = existente ? local : rasc.valor
  const definir = (patch: Partial<FormEtapa1>) =>
    existente ? setLocal((v) => ({ ...v, ...patch })) : rasc.definir(patch)
  const [salvando, setSalvando] = useState(false)
  const [erroModal, setErroModal] = useState<string | null>(null)

  const ativos = tipos.filter((t) => t.ativo || t.id === f.tipoId)
  const tipo = tipos.find((t) => t.id === f.tipoId) ?? null
  const taraKg = inteiroPositivo(f.tara)
  const ordemKg = inteiroPositivo(f.ordem)
  const pre = preConferencia({ taraKg, ordemKg, pbtMaxKg: tipo?.pbt_max_kg ?? null })

  const placaOk = placaValida(f.placa)
  const podeSalvar =
    !salvando && !!f.data && f.numeroOrdem.trim() !== '' && placaOk && !!tipo && taraKg != null && ordemKg != null

  async function salvar() {
    setSalvando(true)
    setErroModal(null)
    const numero = f.numeroOrdem.trim()
    const falha = await acao(async () => {
      const e = {
        data: f.data,
        numero_ordem: numero,
        placa: normalizarPlaca(f.placa),
        tipo_veiculo_id: f.tipoId,
        peso_tara_kg: taraKg!,
        peso_ordem_kg: ordemKg!,
      }
      if (existente) await api.editarEtapa1(existente.id, existente.versao, e)
      else await api.criarPesagem(e, usuarioId)
    })
    setSalvando(false)
    if (falha) {
      // o erro da página fica atrás do overlay: mostra aqui; conflito fecha (a lista já mudou)
      if (existente && ehConflito(falha)) onFechar()
      else setErroModal(falha)
      return
    }
    if (!existente) rasc.limpar()
    onGravado(numero)
    onFechar()
  }

  return (
    <Casca titulo={existente ? `Ajustar carregamento · ordem ${existente.numero_ordem}` : 'Novo carregamento — pré-conferência'} onFechar={onFechar}>
      <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
        Antes de carregar: a ordem cabe no peso bruto total (PBT) permitido para este veículo?
      </p>
      {!existente && rasc.recuperado && (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">Rascunho recuperado — confira antes de salvar.</p>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-stone-500">
          Data
          <input type="date" value={f.data} onChange={(e) => definir({ data: e.target.value })} className={`${INPUT} mt-1 block w-full`} />
        </label>
        <label className="text-xs text-stone-500">
          Nº da ordem de carregamento
          <input value={f.numeroOrdem} onChange={(e) => definir({ numeroOrdem: e.target.value })} className={`${INPUT} mt-1 block w-full`} autoFocus={!existente} />
        </label>
        <label className="text-xs text-stone-500">
          Placa
          <input
            value={f.placa}
            onChange={(e) => definir({ placa: e.target.value.toUpperCase() })}
            onBlur={() => definir({ placa: normalizarPlaca(f.placa) })}
            placeholder="ABC1D23"
            className={`${INPUT} mt-1 block w-full font-mono uppercase ${f.placa && !placaOk ? 'border-red-400' : ''}`}
          />
          {f.placa && !placaOk && <span className="text-red-600">7 letras/números (ABC1D23)</span>}
        </label>
        <label className="text-xs text-stone-500">
          Tipo de veículo
          <select value={f.tipoId} onChange={(e) => definir({ tipoId: e.target.value })} className={`${INPUT} mt-1 block w-full`}>
            <option value="">escolher…</option>
            {ativos.map((t) => (
              <option key={t.id} value={t.id}>{t.nome} · PBT {inteiro(t.pbt_max_kg)} kg{t.ativo ? '' : ' (inativo)'}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-stone-500">
          Peso tara (kg)
          <input inputMode="numeric" value={f.tara} onChange={(e) => definir({ tara: e.target.value })} className={`${INPUT} mt-1 block w-full text-right`} />
        </label>
        <label className="text-xs text-stone-500">
          Peso da ordem (kg)
          <input inputMode="numeric" value={f.ordem} onChange={(e) => definir({ ordem: e.target.value })} className={`${INPUT} mt-1 block w-full text-right`} />
        </label>
      </div>

      {/* prévia ao vivo */}
      <div className="mt-4 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
        <Linha rotulo="PBT máximo do veículo" valor={tipo ? `${inteiro(tipo.pbt_max_kg)} kg` : '—'} />
        <Linha rotulo="Capacidade líquida (PBT − tara)" valor={pre.capacidadeLiquidaKg == null ? '—' : `${inteiro(pre.capacidadeLiquidaKg)} kg`} />
        <Linha rotulo="Peso bruto previsto (tara + ordem)" valor={pre.brutoPrevistoKg == null ? '—' : `${inteiro(pre.brutoPrevistoKg)} kg`} />
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="text-sm text-stone-500">Pode carregar?</span>
          <Tag cor={COR_PODE_CARREGAR[pre.podeCarregar]} className="font-semibold">
            {pre.podeCarregar === 'INCOMPLETO' ? 'INCOMPLETO' : pre.podeCarregar === 'SIM' ? 'SIM' : 'NÃO'} · {pre.podeCarregar === 'SIM' ? ROTULO_PODE_CARREGAR.SIM : pre.mensagem}
          </Tag>
        </div>
      </div>
      {pre.podeCarregar === 'NAO' && (
        <div className="mt-3">
          <Aviso gravidade="bloqueio">
            A ordem excede o PBT em <b>{inteiro(pre.excessoPrevistoKg)} kg</b>. Reduza a carga (ajuste o peso da ordem)
            antes de carregar. O registro pode ser salvo assim; a pesagem final só será aceita com justificativa.
          </Aviso>
        </div>
      )}

      {erroModal && <div className="mt-3"><Erro>{erroModal}</Erro></div>}
      <div className="mt-4 flex justify-end gap-2">
        <Botao onClick={onFechar}>Cancelar</Botao>
        <Botao variante="primario" onClick={salvar} disabled={!podeSalvar}>
          {existente ? 'Salvar ajuste' : 'Registrar carregamento'}
        </Botao>
      </div>
    </Casca>
  )
}

// ================================================================
// Etapa 2 — pesagem final (e correção pelo administrador)
// ================================================================

function ModalEtapa2({
  pesagem: p, correcao, tipoNome, tol, responsavel, acao, onFechar, onGravado,
}: {
  pesagem: PesagemLinha
  correcao: boolean
  tipoNome: string
  tol: { tolLegalPct: number; tolOrdemPct: number }
  responsavel: string
  acao: Acao
  onFechar: () => void
  onGravado: (liberado: Liberado) => void
}) {
  const [bruto, setBruto] = useState(p.peso_bruto_final_kg == null ? '' : String(p.peso_bruto_final_kg))
  const [obs, setObs] = useState(p.observacoes ?? '')
  const [salvando, setSalvando] = useState(false)
  const [erroModal, setErroModal] = useState<string | null>(null)

  const pre = preConferencia({ taraKg: p.peso_tara_kg, ordemKg: p.peso_ordem_kg, pbtMaxKg: p.pbt_max_kg_aplicado })
  const brutoKg = inteiroPositivo(bruto)
  // pesagem já feita usa a tolerância congelada; a nova mostra a atual, que será congelada ao salvar
  const tolLegal = p.tol_legal_pct_aplicada ?? tol.tolLegalPct
  const tolOrdem = p.tol_ordem_pct_aplicada ?? tol.tolOrdemPct
  const fin = conferenciaFinal({
    taraKg: p.peso_tara_kg,
    ordemKg: p.peso_ordem_kg,
    pbtMaxKg: p.pbt_max_kg_aplicado,
    brutoKg,
    tolLegalPct: tolLegal,
    tolOrdemPct: tolOrdem,
  })
  const excedePre = pre.podeCarregar === 'NAO'
  const precisaJustificar = excedePre && !p.excesso_autorizado_em
  const podeSalvar =
    !salvando &&
    brutoKg != null &&
    fin.erroBruto == null &&
    (!precisaJustificar || obs.trim() !== '') &&
    (!correcao || brutoKg !== p.peso_bruto_final_kg || obs !== (p.observacoes ?? ''))

  async function salvar() {
    setSalvando(true)
    setErroModal(null)
    const falha = await acao(async () => {
      const d = { peso_bruto_final_kg: brutoKg!, observacoes: obs.trim() || null }
      if (correcao) await api.corrigirPesoFinal(p.id, p.versao, d)
      else await api.registrarPesoFinal(p.id, p.versao, d)
    })
    setSalvando(false)
    if (falha) {
      if (ehConflito(falha)) onFechar()
      else setErroModal(falha)
      return
    }
    onGravado(fin.liberado)
    onFechar()
  }

  const pct = (x: number) => `${(x * 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`

  return (
    <Casca
      titulo={correcao ? `Corrigir peso bruto (administrador) · ordem ${p.numero_ordem}` : `Pesagem final · ordem ${p.numero_ordem}`}
      onFechar={onFechar}
    >
      {correcao && (
        <div className="mt-2">
          <Aviso gravidade="alerta">
            Correção de uma pesagem já registrada por {responsavel === '' ? 'outro operador' : 'um operador'}. Quem pesou e quando ficam
            guardados; a correção é registrada à parte, com as tolerâncias congeladas na pesagem original.
          </Aviso>
        </div>
      )}

      {/* etapa 1, somente leitura */}
      <div className="mt-3 grid grid-cols-2 gap-x-6 rounded-lg border border-stone-200 p-3 text-sm sm:grid-cols-3 dark:border-stone-800">
        <Linha rotulo="Data" valor={diaCurto(p.data)} />
        <Linha rotulo="Placa" valor={<span className="font-mono">{p.placa}</span>} />
        <Linha rotulo="Tipo" valor={tipoNome} />
        <Linha rotulo="Tara" valor={`${inteiro(p.peso_tara_kg)} kg`} />
        <Linha rotulo="Peso da ordem" valor={`${inteiro(p.peso_ordem_kg)} kg`} />
        <Linha rotulo="PBT aplicado" valor={`${inteiro(p.pbt_max_kg_aplicado)} kg`} />
        <div className="col-span-2 mt-1 flex items-center justify-between gap-3 sm:col-span-3">
          <span className="text-stone-500">Pré-conferência</span>
          <Tag cor={COR_PODE_CARREGAR[pre.podeCarregar]}>
            {pre.podeCarregar === 'SIM' ? 'SIM · cabe no veículo' : `NÃO · ${pre.mensagem}`}
          </Tag>
        </div>
      </div>

      {excedePre && (
        <div className="mt-3">
          <Aviso gravidade="bloqueio">
            Tara + ordem excedem o PBT em <b>{inteiro(pre.excessoPrevistoKg)} kg</b>. Pesar mesmo assim exige uma
            <b> justificativa em observações</b> (escreva-a agora — ela não pode ser apagada depois); quem
            autorizou e quando ficam registrados.
          </Aviso>
        </div>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-stone-500">
          Peso bruto final (kg) — balança
          <input
            inputMode="numeric"
            value={bruto}
            onChange={(e) => setBruto(e.target.value)}
            autoFocus
            className={`${INPUT} mt-1 block w-full text-right text-base font-semibold ${fin.erroBruto ? 'border-red-400' : ''}`}
          />
          {fin.erroBruto && <span className="text-red-600">{fin.erroBruto}</span>}
        </label>
        <label className="text-xs text-stone-500">
          Responsável
          <input value={responsavel} readOnly className={`${INPUT} mt-1 block w-full bg-stone-50 dark:bg-stone-800/60`} />
        </label>
        <label className="text-xs text-stone-500 sm:col-span-2">
          Observações{precisaJustificar ? ' (justificativa obrigatória)' : ''}
          <textarea
            value={obs}
            onChange={(e) => setObs(e.target.value)}
            rows={2}
            className={`${INPUT} mt-1 block w-full ${precisaJustificar && obs.trim() === '' ? 'border-amber-400' : ''}`}
          />
        </label>
      </div>

      {/* prévia ao vivo */}
      <div className="mt-4 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
        <Linha rotulo="Peso líquido (bruto − tara)" valor={fin.liquidoKg == null ? '—' : `${inteiro(fin.liquidoKg)} kg`} destaque />
        <Linha rotulo={`PBT com tolerância legal (${pct(tolLegal)})`} valor={fin.pbtComToleranciaKg == null ? '—' : `${inteiro(Math.round(fin.pbtComToleranciaKg))} kg`} />
        <Linha rotulo="Excesso sobre o PBT" valor={fin.liquidoKg == null ? '—' : `${inteiro(fin.excessoRealKg)} kg`} />
        <Linha
          rotulo={`Diferença × ordem (tolerância ${pct(tolOrdem)})`}
          valor={fin.diferencaKg == null ? '—' : `${formatarDifKg(fin.diferencaKg)} kg · ${formatarPct(fin.diferencaPct)}`}
        />
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-stone-500">Legislação</p>
            <Tag cor={COR_LEGISLACAO[fin.statusLegislacao]}>{ROTULO_LEGISLACAO[fin.statusLegislacao]}</Tag>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-stone-500">× Ordem</p>
            <Tag cor={COR_ORDEM[fin.statusOrdem]}>{ROTULO_ORDEM[fin.statusOrdem]}</Tag>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-stone-500">Liberado?</p>
            <Tag cor={COR_LIBERADO[fin.liberado]} className="font-semibold">{ROTULO_LIBERADO[fin.liberado].toUpperCase()}</Tag>
          </div>
        </div>
        {!correcao && p.tol_legal_pct_aplicada == null && (
          <p className="mt-2 text-[10px] text-stone-500">
            As tolerâncias em vigor ({pct(tol.tolLegalPct)} legislação · {pct(tol.tolOrdemPct)} ordem) ficam congeladas nesta pesagem ao salvar.
          </p>
        )}
      </div>

      {erroModal && <div className="mt-3"><Erro>{erroModal}</Erro></div>}
      <div className="mt-4 flex justify-end gap-2">
        <Botao onClick={onFechar}>Cancelar</Botao>
        <Botao variante="primario" onClick={salvar} disabled={!podeSalvar}>
          {correcao ? 'Gravar correção' : 'Registrar pesagem final'}
        </Botao>
      </div>
    </Casca>
  )
}

// ================================================================
// Parâmetros (administrador)
// ================================================================

function CartaoParametros({
  tipos, params, usuarioId, acao,
}: {
  tipos: TipoVeiculo[]
  params: api.ParametrosPesagemLinha
  usuarioId: string
  acao: Acao
}) {
  const pctTexto = (x: number) => (x * 100).toLocaleString('pt-BR', { maximumFractionDigits: 3 })
  const [tolLegal, setTolLegal] = useState(pctTexto(params.tolerancia_legal_pct))
  const [tolOrdem, setTolOrdem] = useState(pctTexto(params.tolerancia_ordem_pct))
  const [novo, setNovo] = useState({ nome: '', pbt: '' })

  const pctNum = (s: string) => {
    const n = Number(s.replace(',', '.'))
    return Number.isFinite(n) && n >= 0 && n < 100 ? n / 100 : null
  }

  return (
    <Cartao titulo="Parâmetros da pesagem" className="mb-5">
      <div className="grid gap-5 lg:grid-cols-2">
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-stone-500">Tipos de veículo e PBT (kg)</p>
          <Tabela cabecalho={['Tipo', '#PBT máx (kg)', 'Ativo', '']}>
            {tipos.map((t) => (
              <LinhaTipoVeiculo key={`${t.id}|${t.nome}|${t.pbt_max_kg}`} tipo={t} acao={acao} />
            ))}
            <tr className="border-t border-stone-200 dark:border-stone-700">
              <td className="px-2 py-2">
                <input value={novo.nome} onChange={(e) => setNovo({ ...novo, nome: e.target.value })} placeholder="novo tipo" className={`${INPUT} w-32`} />
              </td>
              <td className="px-2 py-2 text-right">
                <input value={novo.pbt} onChange={(e) => setNovo({ ...novo, pbt: e.target.value })} inputMode="numeric" placeholder="kg" className={`${INPUT} w-24 text-right`} />
              </td>
              <td />
              <td className="px-2 py-2 text-right">
                <Botao
                  disabled={!novo.nome.trim() || inteiroPositivo(novo.pbt) == null}
                  onClick={() =>
                    acao(async () => {
                      await api.salvarTipoVeiculo({ nome: novo.nome.trim(), pbt_max_kg: inteiroPositivo(novo.pbt)!, ativo: true })
                      setNovo({ nome: '', pbt: '' })
                    })
                  }
                >
                  Incluir
                </Botao>
              </td>
            </tr>
          </Tabela>
          <p className="mt-2 text-xs text-stone-500">
            Alterar o PBT de um tipo vale só para carregamentos novos: cada registro guarda o PBT aplicado na hora.
          </p>
        </div>
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-stone-500">Tolerâncias</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-stone-500">
              Legal (% sobre o PBT, Lei 7.408/85)
              <input value={tolLegal} onChange={(e) => setTolLegal(e.target.value)} inputMode="decimal" className={`${INPUT} mt-1 block w-full text-right`} />
            </label>
            <label className="text-xs text-stone-500">
              Ordem (% de diferença aceitável)
              <input value={tolOrdem} onChange={(e) => setTolOrdem(e.target.value)} inputMode="decimal" className={`${INPUT} mt-1 block w-full text-right`} />
            </label>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <Botao
              variante="primario"
              disabled={pctNum(tolLegal) == null || pctNum(tolOrdem) == null}
              onClick={() =>
                acao(async () => {
                  await api.salvarParametros(
                    { tolerancia_legal_pct: pctNum(tolLegal)!, tolerancia_ordem_pct: pctNum(tolOrdem)! },
                    usuarioId,
                  )
                })
              }
            >
              Salvar tolerâncias
            </Botao>
            {params.atualizado_em && (
              <span className="text-xs text-stone-500">alteradas em {dataHoraCurta(params.atualizado_em)}</span>
            )}
          </div>
          <p className="mt-2 text-xs text-stone-500">
            Mudança vale só para pesagens finais futuras — as já pesadas mantêm a tolerância congelada nelas.
          </p>
        </div>
      </div>
    </Cartao>
  )
}

function LinhaTipoVeiculo({ tipo, acao }: { tipo: TipoVeiculo; acao: Acao }) {
  const [edit, setEdit] = useState(false)
  const [nome, setNome] = useState(tipo.nome)
  const [pbt, setPbt] = useState(String(tipo.pbt_max_kg))

  if (!edit) {
    return (
      <tr className="border-t border-stone-100 dark:border-stone-800/60">
        <td className="px-2 py-1.5 font-medium">{tipo.nome}</td>
        <td className="num-tabular px-2 py-1.5 text-right">{inteiro(tipo.pbt_max_kg)}</td>
        <td className="px-2 py-1.5">
          <button
            onClick={() => acao(() => api.salvarTipoVeiculo({ ...tipo, ativo: !tipo.ativo }))}
            className="text-xs underline"
            title={tipo.ativo ? 'Desativar (some do formulário; histórico fica)' : 'Reativar'}
          >
            {tipo.ativo ? 'ativo' : 'inativo'}
          </button>
        </td>
        <td className="px-2 py-1.5 text-right">
          <button onClick={() => setEdit(true)} className="-m-1.5 rounded p-1.5 text-xs underline">editar</button>
        </td>
      </tr>
    )
  }
  return (
    <tr className="border-t border-stone-100 dark:border-stone-800/60">
      <td className="px-2 py-1.5"><input value={nome} onChange={(e) => setNome(e.target.value)} className={`${INPUT} w-32`} /></td>
      <td className="px-2 py-1.5 text-right"><input value={pbt} onChange={(e) => setPbt(e.target.value)} inputMode="numeric" className={`${INPUT} w-24 text-right`} /></td>
      <td />
      <td className="px-2 py-1.5 text-right whitespace-nowrap">
        <button
          disabled={!nome.trim() || inteiroPositivo(pbt) == null}
          onClick={() =>
            acao(async () => {
              await api.salvarTipoVeiculo({ id: tipo.id, nome: nome.trim(), pbt_max_kg: inteiroPositivo(pbt)!, ativo: tipo.ativo })
              setEdit(false)
            })
          }
          className="-my-1.5 mr-2 rounded px-1.5 py-1.5 text-xs underline disabled:opacity-40"
        >
          salvar
        </button>
        <button onClick={() => setEdit(false)} className="-m-1.5 rounded p-1.5 text-xs text-stone-500 underline">cancelar</button>
      </td>
    </tr>
  )
}
