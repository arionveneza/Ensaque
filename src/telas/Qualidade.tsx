import { useCallback, useEffect, useState } from 'react'
import * as g from '@/dados/api-gestao'
import type { ChecklistQualidade, DadosChecklist, OrdemVisao } from '@/dados/api-gestao'
import { useRealtime } from '@/dados/useRealtime'
import { useAuth } from '@/auth/AuthProvider'
import {
  Botao, Cartao, Erro, Pagina, Tabela, Tag, Vazio, n,
} from '@/componentes/ui'

const EM_EXECUCAO = ['Em producao', 'Parada']

export default function Qualidade() {
  const { usuario, permitido } = useAuth()
  const podeApontar = permitido('qualidade', 'qualidade')

  const [ordens, setOrdens] = useState<OrdemVisao[]>([])
  const [checks, setChecks] = useState<ChecklistQualidade[]>([])
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)
  const [aberta, setAberta] = useState<string | null>(null)

  const recarregar = useCallback(async () => {
    const [o, c] = await Promise.all([g.listarOrdens(), g.listarChecksQualidade()])
    setOrdens(o)
    setChecks(c)
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

  if (carregando) return <p className="p-8 text-sm text-stone-500">Carregando qualidade…</p>

  return (
    <Pagina
      titulo="Qualidade"
      descricao="Checklist informativo em duas etapas: durante a execução e após a finalização. Nota baixa não bloqueia — é registro para análise."
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
                      rotuloSalvar="Registrar verificação"
                      comOrigem
                      onSalvar={(d) =>
                        comErro(async () => {
                          await g.registrarCheckProcesso(o.id, d, usuario!.id)
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
                      rotuloSalvar="Salvar qualidade final"
                      onSalvar={(d) =>
                        comErro(async () => {
                          await g.apontarQualidadeFinal(o.id, d)
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
            <Tabela cabecalho={['Ordem', 'Cultivar', 'Tratamento', '#Peso', 'Q. geral',
              'Umidade', 'Pó', 'Obs', 'Status']}>
              {concluidas.map((o) => {
                const f = checksDe(o.id, 'final')[0]
                return (
                  <tr key={o.id} className="border-t border-stone-100 dark:border-stone-800/60">
                    <td className="px-2 py-1.5 font-medium">{o.numero}</td>
                    <td className="px-2 py-1.5">{o.cultivar}</td>
                    <td className="px-2 py-1.5">{o.receita_nome}</td>
                    <td className="num-tabular px-2 py-1.5 text-right">{n(o.peso_t, 1)} t</td>
                    <td className="px-2 py-1.5 text-center">{f ? <Nota valor={f.recobrimento} /> : '—'}</td>
                    <td className="px-2 py-1.5">{f ? <OkFora ok={f.umidade_ok} /> : '—'}</td>
                    <td className="px-2 py-1.5">{f ? <OkFora ok={f.po_ok} /> : '—'}</td>
                    <td className="max-w-40 truncate px-2 py-1.5 text-stone-500">
                      {f?.observacao ?? '—'}
                    </td>
                    <td className="px-2 py-1.5">
                      <Tag cor={o.status_efetivo === 'Apontada' ? 'roxo' : 'info'}>
                        {o.status_efetivo}
                      </Tag>
                    </td>
                  </tr>
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

function ListaChecks({ checks }: { checks: ChecklistQualidade[] }) {
  return (
    <div className="mt-3 border-t border-stone-200 pt-2 dark:border-stone-700">
      <Tabela cabecalho={['Hora', 'Origem', 'Q. geral', 'Umidade', 'Pó', 'Obs']}>
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
            <td className="max-w-40 truncate px-2 py-1 text-xs text-stone-500">
              {c.observacao ?? '—'}
            </td>
          </tr>
        ))}
      </Tabela>
    </div>
  )
}

/**
 * O checklist das duas etapas — mesmo formulário, destino diferente.
 * `comOrigem` (só em processo): de onde saiu a amostra, BOWL ou BAG.
 */
function FormChecklist({
  rotuloSalvar, comOrigem = false, onSalvar,
}: {
  rotuloSalvar: string
  comOrigem?: boolean
  onSalvar: (d: DadosChecklist) => void
}) {
  const [origem, setOrigem] = useState<'BOWL' | 'BAG' | null>(null)
  const [recobrimento, setRecobrimento] = useState(0)
  const [umidadeOk, setUmidadeOk] = useState(true)
  const [poOk, setPoOk] = useState(true)
  const [obs, setObs] = useState('')

  const incompleto = recobrimento === 0 || (comOrigem && origem === null)

  return (
    <div className="mt-3 border-t border-stone-200 pt-3 dark:border-stone-700">
      {comOrigem && (
        <div className="mb-4">
          <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
            Origem da amostra
          </p>
          <div className="mt-1 flex gap-1">
            {(['BOWL', 'BAG'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setOrigem(v)}
                className={`rounded-md border px-4 py-1.5 text-sm font-medium ${
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
          <div className="mt-1 flex gap-1">
            {[1, 2, 3, 4, 5].map((v) => (
              <button
                key={v}
                onClick={() => setRecobrimento(v)}
                className={`h-9 w-9 rounded-md border text-sm font-semibold ${
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
            })
          }
        >
          {rotuloSalvar}
        </Botao>
      </div>
    </div>
  )
}

function AlternadorOkFora({
  rotulo, ok, onMudar,
}: {
  rotulo: string
  ok: boolean
  onMudar: (v: boolean) => void
}) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-stone-500">{rotulo}</p>
      <div className="mt-1 flex gap-1">
        {([true, false] as const).map((v) => (
          <button
            key={String(v)}
            onClick={() => onMudar(v)}
            className={`rounded-md border px-3 py-1.5 text-sm ${
              ok === v
                ? v
                  ? 'border-emerald-600 bg-emerald-600 text-white'
                  : 'border-amber-500 bg-amber-500 text-white'
                : 'border-stone-300 dark:border-stone-700'
            }`}
          >
            {v ? 'OK' : 'Fora do padrão'}
          </button>
        ))}
      </div>
    </div>
  )
}
