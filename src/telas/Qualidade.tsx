import { Fragment, useCallback, useEffect, useState } from 'react'
import * as g from '@/dados/api-gestao'
import type { ChecklistQualidade, DadosChecklist, OrdemVisao } from '@/dados/api-gestao'
import { useRealtime } from '@/dados/useRealtime'
import { exportarXlsx } from '@/lib/exportar'
import { limparRascunhoDe, useRascunho } from '@/lib/useRascunho'
import { useAuth } from '@/auth/AuthProvider'
import {
  AlternadorOkFora, Botao, Cartao, Erro, Pagina, Tabela, Tag, Vazio, n,
} from '@/componentes/ui'
import { SeletorFotos } from '@/componentes/SeletorFotos'

const EM_EXECUCAO = ['Em producao', 'Parada']

export default function Qualidade() {
  const { usuario, permitido } = useAuth()
  const podeApontar = permitido('qualidade', 'qualidade')

  const [ordens, setOrdens] = useState<OrdemVisao[]>([])
  const [checks, setChecks] = useState<ChecklistQualidade[]>([])
  const [nomes, setNomes] = useState<Record<string, string>>({})
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)
  /**
   * Qual formulário está aberto vive em RASCUNHO, não em useState: tirar
   * foto abre o app de câmera, o Android descarta a aba do navegador para
   * liberar memória e, ao voltar, a página recarrega DO ZERO — o formulário
   * fechava, a foto ia para um campo que não existia mais, e o inspetor
   * ficava no ciclo câmera → tela limpa → câmera. Persistindo qual form
   * está aberto (e o conteúdo dele, mais abaixo), a volta da câmera cai
   * exatamente onde parou.
   */
  const abertaRasc = useRascunho<{ id: string | null }>('qualidade-aberta', { id: null })
  const aberta = abertaRasc.valor.id
  const setAberta = (id: string | null) => abertaRasc.definir({ id })
  const [expandidas, setExpandidas] = useState<Set<string>>(new Set())

  /** Chave do rascunho do formulário de uma ordem — o pai limpa após gravar. */
  const chaveForm = (idForm: string) => `qualidade-form-${idForm}`

  const recarregar = useCallback(async () => {
    const [o, c, u] = await Promise.all([
      g.listarOrdens(), g.listarChecksQualidade(), g.listarNomesUsuarios(),
    ])
    setOrdens(o)
    setChecks(c)
    setNomes(u)
  }, [])

  useEffect(() => {
    setCarregando(true)
    recarregar()
      .catch((e) => setErro(e instanceof Error ? e.message : String(e)))
      .finally(() => setCarregando(false))
  }, [recarregar])

  useRealtime(['ordens', 'qualidade_checks'], recarregar)

  async function comErro(fn: () => Promise<void>) {
    try {
      setErro(null)
      await fn()
      await recarregar()
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    }
  }

  const emExecucao = ordens.filter((o) => EM_EXECUCAO.includes(o.status_efetivo))
  const finalizadas = ordens.filter((o) => o.status_efetivo === 'Finalizada')
  const concluidas = ordens.filter(
    (o) => o.status_efetivo === 'Qualidade apontada' || o.status_efetivo === 'Apontada',
  )

  const checksDe = (id: string, etapa: 'processo' | 'final') =>
    checks.filter((c) => c.ordem_id === id && c.etapa === etapa)

  /**
   * Relatório completo: uma linha por teste, com a ordem inteira do lado.
   * Ordenado do mais recente para o mais antigo.
   */
  async function exportarRelatorio() {
    const porId = new Map(ordens.map((o) => [o.id, o]))
    await exportarXlsx(
      'testes-de-qualidade',
      [
        { titulo: 'Data/hora', largura: 18 },
        { titulo: 'Ordem', largura: 14 },
        { titulo: 'Lote', largura: 14 },
        { titulo: 'Cultivar', largura: 18 },
        { titulo: 'Tratamento', largura: 18 },
        { titulo: 'Embalagem', largura: 12 },
        { titulo: 'Bags', largura: 8, tipo: 'numero', casas: 0 },
        { titulo: 'Peso (t)', largura: 10, tipo: 'numero', casas: 2 },
        { titulo: 'Etapa', largura: 12 },
        { titulo: 'Origem', largura: 10 },
        { titulo: 'Q. geral (1-5)', largura: 12, tipo: 'numero', casas: 0 },
        { titulo: 'Umidade', largura: 14 },
        { titulo: 'Desprend. pó', largura: 14 },
        { titulo: 'Observação', largura: 30 },
        { titulo: 'Inspetor', largura: 20 },
      ],
      checks.map((c) => {
        const o = porId.get(c.ordem_id)
        return [
          new Date(c.ts).toLocaleString('pt-BR'),
          o?.numero ?? '?', o?.lote_id ?? '?', o?.cultivar ?? '?',
          o?.receita_nome ?? '?', o?.embalagem ?? '?', o?.bags ?? '',
          o?.peso_t ?? '',
          c.etapa === 'processo' ? 'Em processo' : 'Final',
          c.origem ?? '—',
          c.recobrimento,
          c.umidade_ok ? 'OK' : 'Fora do padrão',
          c.po_ok ? 'OK' : 'Fora do padrão',
          c.observacao ?? '',
          c.inspetor_id ? (nomes[c.inspetor_id] ?? '?') : '',
        ]
      }),
    )
  }

  if (carregando) return <p className="p-8 text-sm text-stone-500">Carregando qualidade…</p>

  return (
    <Pagina
      titulo="Qualidade"
      descricao="Checklist informativo em duas etapas: durante a execução e após a finalização. Nota baixa não bloqueia — é registro para análise."
      acoes={
        <Botao
          disabled={checks.length === 0}
          titulo="Todos os testes registrados, um por linha, com a ordem completa"
          onClick={() => exportarRelatorio().catch((e) => setErro(String(e)))}
        >
          Relatório de testes (.xlsx)
        </Botao>
      }
    >
      {erro && <Erro>{erro}</Erro>}

      {/* ---------------- em processo ---------------- */}
      <Cartao titulo={`Em processo — ordens em execução (${emExecucao.length})`} className="mb-5">
        {emExecucao.length === 0 ? (
          <Vazio>Nenhuma máquina rodando agora.</Vazio>
        ) : (
          <div className="space-y-3">
            {emExecucao.map((o) => {
              const feitos = checksDe(o.id, 'processo')
              const idForm = `p-${o.id}`
              return (
                <div key={o.id} className="rounded-md border border-stone-200 p-3 dark:border-stone-700">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                      <p className="font-medium">
                        {o.numero} · {o.cultivar}{' '}
                        <Tag cor={o.status_efetivo === 'Parada' ? 'alerta' : 'ok'}>
                          {o.status_efetivo}
                        </Tag>
                      </p>
                      <p className="text-xs text-stone-500">
                        {o.receita_nome} · lote {o.lote_id} · {n(o.peso_t, 1)} t · {o.maquina_id}
                        {feitos.length > 0 && (
                          <> · <b>{feitos.length}</b> verificação(ões) registradas</>
                        )}
                      </p>
                    </div>
                    {podeApontar && (
                      <Botao onClick={() => setAberta(aberta === idForm ? null : idForm)}>
                        {aberta === idForm ? 'Cancelar' : 'Registrar verificação'}
                      </Botao>
                    )}
                  </div>

                  {aberta === idForm && (
                    <FormChecklist
                      chave={chaveForm(idForm)}
                      ordemId={o.id}
                      rotuloSalvar="Registrar verificação"
                      comOrigem
                      onSalvar={(d) =>
                        comErro(async () => {
                          await g.registrarCheckProcesso(o.id, d, usuario!.id)
                          // só depois de gravar: falha no envio mantém o rascunho
                          limparRascunhoDe(chaveForm(idForm))
                          setAberta(null)
                        })
                      }
                    />
                  )}

                  {feitos.length > 0 && <ListaChecks checks={feitos} />}
                </div>
              )
            })}
          </div>
        )}
      </Cartao>

      {/* ---------------- qualidade final ---------------- */}
      <Cartao titulo={`Qualidade final — ordens finalizadas (${finalizadas.length})`} className="mb-5">
        {finalizadas.length === 0 ? (
          <Vazio>Nenhuma ordem finalizada aguardando a qualidade final.</Vazio>
        ) : (
          <div className="space-y-3">
            {finalizadas.map((o) => {
              const emProc = checksDe(o.id, 'processo')
              const idForm = `f-${o.id}`
              return (
                <div key={o.id} className="rounded-md border border-stone-200 p-3 dark:border-stone-700">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                      <p className="font-medium">{o.numero} · {o.cultivar}</p>
                      <p className="text-xs text-stone-500">
                        {o.receita_nome} · lote {o.lote_id} · {n(o.peso_t, 1)} t ·{' '}
                        {o.maquina_id ?? '—'}
                        {emProc.length > 0
                          ? <> · {emProc.length} verificação(ões) em processo</>
                          : <> · <span className="text-amber-600 dark:text-amber-400">sem verificação em processo</span></>}
                      </p>
                    </div>
                    {podeApontar && (
                      <Botao onClick={() => setAberta(aberta === idForm ? null : idForm)}>
                        {aberta === idForm ? 'Cancelar' : 'Apontar qualidade final'}
                      </Botao>
                    )}
                  </div>

                  {aberta === idForm && (
                    <FormChecklist
                      chave={chaveForm(idForm)}
                      ordemId={o.id}
                      rotuloSalvar="Salvar qualidade final"
                      comFotos
                      onSalvar={(d) =>
                        comErro(async () => {
                          await g.apontarQualidadeFinal(o.id, d)
                          // só depois de gravar: falha no envio mantém o rascunho
                          limparRascunhoDe(chaveForm(idForm))
                          setAberta(null)
                        })
                      }
                    />
                  )}

                  {emProc.length > 0 && <ListaChecks checks={emProc} />}
                </div>
              )
            })}
          </div>
        )}
      </Cartao>

      {/* ---------------- concluídas ---------------- */}
      <Cartao titulo={`Qualidade concluída (${concluidas.length})`}>
        {concluidas.length === 0 ? (
          <Vazio>Nenhuma ordem com qualidade final apontada.</Vazio>
        ) : (
          <>
            <p className="mb-3 text-sm text-stone-500">
              O lançamento no AGROTIS é feito pelo PCP na tela <b>AGROTIS</b>.
            </p>
            <Tabela cabecalho={[
              '', 'Ordem',
              { texto: 'Cultivar', className: 'hidden lg:table-cell' },
              { texto: 'Tratamento', className: 'hidden lg:table-cell' },
              '#Peso', 'Q. geral', 'Umidade', 'Pó', 'Obs', 'Status',
            ]}>
              {concluidas.map((o) => {
                const f = checksDe(o.id, 'final')[0]
                const emProc = checksDe(o.id, 'processo')
                const expandida = expandidas.has(o.id)
                const totalTestes = emProc.length + (f ? 1 : 0)
                return (
                  <Fragment key={o.id}>
                    <tr className="border-t border-stone-100 dark:border-stone-800/60">
                      {/* antes só o relatório em .xlsx mostrava os testes de uma
                          ordem concluída — para conferir uma reclamação era
                          preciso baixar a planilha inteira e procurar a linha */}
                      <td className="px-1 py-1.5">
                        <button
                          onClick={() =>
                            setExpandidas((s) => {
                              const novo = new Set(s)
                              if (novo.has(o.id)) novo.delete(o.id)
                              else novo.add(o.id)
                              return novo
                            })
                          }
                          title={expandida ? 'Recolher' : `Ver os ${totalTestes} teste(s)`}
                          className="flex h-9 w-9 items-center justify-center rounded text-sm text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
                        >
                          {expandida ? '▾' : '▸'}
                        </button>
                      </td>
                      <td className="px-2 py-1.5 font-medium">
                        {o.numero}
                        {!!f?.fotos?.length && (
                          <span className="ml-1 text-[10px] text-stone-400" title={`${f.fotos.length} foto(s)`}>
                            {f.fotos.length}📷
                          </span>
                        )}
                        {/* cultivar/tratamento somem em lg: — mostra aqui no celular/tablet */}
                        <p className="text-xs font-normal text-stone-500 lg:hidden">
                          {o.cultivar} · {o.receita_nome}
                        </p>
                      </td>
                      <td className="hidden px-2 py-1.5 lg:table-cell">{o.cultivar}</td>
                      <td className="hidden px-2 py-1.5 lg:table-cell">{o.receita_nome}</td>
                      <td className="num-tabular px-2 py-1.5 text-right">{n(o.peso_t, 1)} t</td>
                      <td className="px-2 py-1.5 text-center">{f ? <Nota valor={f.recobrimento} /> : '—'}</td>
                      <td className="px-2 py-1.5">{f ? <OkFora ok={f.umidade_ok} /> : '—'}</td>
                      <td className="px-2 py-1.5">{f ? <OkFora ok={f.po_ok} /> : '—'}</td>
                      {/* sem truncate: quebra em várias linhas em vez de cortar
                          — em toque não há hover pra abrir o title */}
                      <td className="max-w-40 px-2 py-1.5 break-words text-stone-500">
                        {f?.observacao ?? '—'}
                      </td>
                      <td className="px-2 py-1.5">
                        <Tag cor={o.status_efetivo === 'Apontada' ? 'roxo' : 'info'}>
                          {o.status_efetivo}
                        </Tag>
                      </td>
                    </tr>
                    {expandida && (
                      <tr className="bg-stone-50/70 dark:bg-stone-800/30">
                        <td />
                        <td colSpan={9} className="px-2 pb-4 pt-1">
                          <p className="mb-1 text-xs text-stone-500">
                            Lote {o.lote_id} · {o.maquina_id ?? 'sem máquina'} ·{' '}
                            {totalTestes === 0
                              ? 'nenhum teste registrado'
                              : `${totalTestes} teste(s)`}
                          </p>
                          {emProc.length > 0 && (
                            <>
                              <p className="mt-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
                                Em processo
                              </p>
                              <ListaChecks checks={emProc} nomes={nomes} />
                            </>
                          )}
                          {f && (
                            <>
                              <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-stone-500">
                                Final
                              </p>
                              <ListaChecks checks={[f]} nomes={nomes} />
                              {!!f.fotos?.length && <Fotos caminhos={f.fotos} />}
                            </>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </Tabela>
          </>
        )}
      </Cartao>
    </Pagina>
  )
}

/** Nota 1–5 com cor: 1–2 vermelho, 3 âmbar, 4–5 verde. Informativo. */
function Nota({ valor }: { valor: number }) {
  const cor =
    valor >= 4
      ? 'text-emerald-600 dark:text-emerald-400'
      : valor === 3
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-red-600 dark:text-red-400'
  return <span className={`num-tabular font-semibold ${cor}`}>{valor}</span>
}

function OkFora({ ok }: { ok: boolean }) {
  return <Tag cor={ok ? 'ok' : 'alerta'}>{ok ? 'OK' : 'Fora do padrão'}</Tag>
}

function ListaChecks({
  checks, nomes,
}: {
  checks: ChecklistQualidade[]
  /** Quando informado, mostra quem fez o teste. */
  nomes?: Record<string, string>
}) {
  const cabecalho = ['Hora', 'Origem', 'Q. geral', 'Umidade', 'Pó', 'Obs']
  if (nomes) cabecalho.push('Inspetor')
  return (
    <div className="mt-2 border-t border-stone-200 pt-2 dark:border-stone-700">
      <Tabela cabecalho={cabecalho}>
        {checks.map((c) => (
          <tr key={c.id} className="border-t border-stone-100 dark:border-stone-800/60">
            <td className="px-2 py-1 text-xs text-stone-500">
              {new Date(c.ts).toLocaleString('pt-BR')}
            </td>
            <td className="px-2 py-1">
              {c.origem ? <Tag cor={c.origem === 'BOWL' ? 'info' : 'roxo'}>{c.origem}</Tag> : '—'}
            </td>
            <td className="px-2 py-1 text-center"><Nota valor={c.recobrimento} /></td>
            <td className="px-2 py-1"><OkFora ok={c.umidade_ok} /></td>
            <td className="px-2 py-1"><OkFora ok={c.po_ok} /></td>
            <td className="max-w-40 px-2 py-1 break-words text-xs text-stone-500">
              {c.observacao ?? '—'}
            </td>
            {nomes && (
              <td className="px-2 py-1 text-xs text-stone-500">
                {c.inspetor_id ? (nomes[c.inspetor_id] ?? '—') : '—'}
              </td>
            )}
          </tr>
        ))}
      </Tabela>
    </div>
  )
}

/**
 * As fotos do teste. O bucket é privado, então cada imagem precisa de um
 * link assinado — buscados só quando a ordem é expandida, para uma tela com
 * dezenas de ordens não pedir centenas de links que ninguém vai olhar.
 */
function Fotos({ caminhos }: { caminhos: string[] }) {
  const [urls, setUrls] = useState<(string | null)[]>([])
  const [prontos, setProntos] = useState(false)

  /**
   * A dependência é o CONTEÚDO dos caminhos, não a referência do array: a
   * tela recarrega via realtime toda hora que `ordens`/`qualidade_checks`
   * mudam (qualquer apontamento do dia) e o pai recria um array NOVO com os
   * MESMOS caminhos a cada vez. Com `[caminhos]`, o efeito reiniciava antes
   * do link assinado voltar — se o realtime disparasse de novo dentro desse
   * intervalo, a foto nunca chegava a aparecer, ficava "carregando…" pra
   * sempre (achado 14/08/2026, "não aparece a foto").
   */
  const chaveCaminhos = JSON.stringify(caminhos)

  useEffect(() => {
    let vivo = true
    setProntos(false)
    Promise.all(caminhos.map((c) => g.urlFotoQualidade(c)))
      .then((r) => {
        if (!vivo) return
        setUrls(r)
        setProntos(true)
      })
      .catch(() => {
        if (!vivo) return
        setUrls(caminhos.map(() => null))
        setProntos(true)
      })
    return () => {
      vivo = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chaveCaminhos])

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {caminhos.map((c, i) => {
        const url = urls[i]
        return url ? (
          <a key={c} href={url} target="_blank" rel="noopener noreferrer" title="Abrir em tamanho real">
            <img
              src={url}
              alt={`Foto ${i + 1} do teste de qualidade`}
              className="h-24 w-24 rounded-md border border-stone-200 object-cover dark:border-stone-700"
            />
          </a>
        ) : (
          <div
            key={c}
            className="flex h-24 w-24 items-center justify-center rounded-md border border-dashed border-stone-300 text-[10px] text-stone-400 dark:border-stone-700"
          >
            {/* distinto de "carregando" — sem isso, um link assinado que
                falha (RLS, arquivo apagado) parecia eternamente pendente,
                sem nenhum sinal de que algo deu errado de verdade */}
            {prontos ? 'falha ao carregar' : 'carregando…'}
          </div>
        )
      })}
    </div>
  )
}

/** O que o inspetor digitou — persiste no rascunho para sobreviver à câmera. */
interface FormChecklistValor {
  origem: 'BOWL' | 'BAG' | null
  recobrimento: number
  umidadeOk: boolean
  poOk: boolean
  obs: string
  /** Caminhos no Storage — já enviados na seleção, texto curto no localStorage. */
  fotos: string[]
}

const FORM_VAZIO: FormChecklistValor = {
  origem: null,
  recobrimento: 0,
  umidadeOk: true,
  poOk: true,
  obs: '',
  fotos: [],
}

/**
 * O checklist das duas etapas — mesmo formulário, destino diferente.
 * `comOrigem` (só em processo): de onde saiu a amostra, BOWL ou BAG.
 *
 * TODO o estado vive em rascunho persistente (`chave`): tirar foto abre a
 * câmera, o Android descarta a aba, e a página volta recarregada — sem o
 * rascunho, nota, observação e fotos anteriores evaporavam e o apontamento
 * final era impossível de concluir no tablet. Quem grava com sucesso limpa
 * o rascunho (o PAI chama `limparRascunhoDe`, porque este componente já foi
 * desmontado quando o sucesso chega).
 */
function FormChecklist({
  chave, ordemId, rotuloSalvar, comOrigem = false, comFotos = false, onSalvar,
}: {
  chave: string
  ordemId: string
  rotuloSalvar: string
  comOrigem?: boolean
  /** Até 3 imagens — só na etapa final. */
  comFotos?: boolean
  onSalvar: (d: DadosChecklist) => void
}) {
  const { valor, definir } = useRascunho<FormChecklistValor>(chave, FORM_VAZIO)
  const { origem, recobrimento, umidadeOk, poOk, obs, fotos } = valor
  const setOrigem = (v: 'BOWL' | 'BAG') => definir({ origem: v })
  const setRecobrimento = (v: number) => definir({ recobrimento: v })
  const setUmidadeOk = (v: boolean) => definir({ umidadeOk: v })
  const setPoOk = (v: boolean) => definir({ poOk: v })
  const setObs = (v: string) => definir({ obs: v })
  const setFotos = (v: string[]) => definir({ fotos: v })

  const incompleto = recobrimento === 0 || (comOrigem && origem === null)

  return (
    <div className="mt-3 border-t border-stone-200 pt-3 dark:border-stone-700">
      {comOrigem && (
        <div className="mb-4">
          <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
            Origem da amostra
          </p>
          <div className="mt-1 flex gap-2">
            {(['BOWL', 'BAG'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setOrigem(v)}
                className={`rounded-md border px-4 py-2.5 text-sm font-medium sm:py-1.5 ${
                  origem === v
                    ? 'border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900'
                    : 'border-stone-300 dark:border-stone-700'
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
            Qualidade geral do tratamento (1 a 5)
          </p>
          <div className="mt-1 flex gap-2">
            {[1, 2, 3, 4, 5].map((v) => (
              <button
                key={v}
                onClick={() => setRecobrimento(v)}
                className={`h-11 w-11 rounded-md border text-sm font-semibold sm:h-9 sm:w-9 ${
                  recobrimento === v
                    ? 'border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900'
                    : 'border-stone-300 dark:border-stone-700'
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
        <AlternadorOkFora rotulo="Umidade do tratamento" ok={umidadeOk} onMudar={setUmidadeOk} />
        <AlternadorOkFora rotulo="Desprendimento de pó" ok={poOk} onMudar={setPoOk} />
      </div>
      <input
        value={obs}
        onChange={(e) => setObs(e.target.value)}
        placeholder="observação (opcional)"
        className="mt-3 w-full rounded-md border border-stone-300 px-2 py-1.5 text-sm dark:border-stone-700 dark:bg-stone-800"
      />
      {comFotos && (
        <SeletorFotos
          max={3}
          titulo="Fotos do teste (até 3)"
          fotos={fotos}
          onMudar={setFotos}
          enviar={async (dataUrl) => (await g.enviarFotosQualidade(ordemId, [dataUrl]))[0]}
          remover={g.removerFotoQualidade}
          urlAssinada={g.urlFotoQualidade}
        />
      )}
      <div className="mt-3">
        <Botao
          variante="primario"
          disabled={incompleto}
          titulo={
            incompleto
              ? comOrigem && origem === null
                ? 'Escolha a origem da amostra (BOWL ou BAG)'
                : 'Escolha a nota de qualidade geral do tratamento'
              : undefined
          }
          onClick={() =>
            onSalvar({
              origem: origem ?? undefined,
              recobrimento,
              umidadeOk,
              poOk,
              observacao: obs.trim() || null,
              fotos: comFotos ? fotos : undefined,
            })
          }
        >
          {rotuloSalvar}
        </Botao>
      </div>
    </div>
  )
}

