import { useCallback, useEffect, useState } from 'react'
import * as g from '@/dados/api-gestao'
import type { ChecklistQualidade, OrdemEtapasLinha, TanqueLinha } from '@/dados/api-gestao'
import { salvarPesoTanque } from '@/dados/api'
import { useRealtime } from '@/dados/useRealtime'
import { useAuth } from '@/auth/AuthProvider'
import {
  Botao, Cartao, Erro, Pagina, Tabela, Tag, Vazio, diaCurto, n, rotuloTanque,
} from '@/componentes/ui'

/**
 * Encerramento no AGROTIS — etapa do PCP, a última da régua.
 *
 * Pré-requisitos: qualidade final apontada E conferência de estoque da
 * logística. É AQUI que o PCP digita os pesos finais dos tanques, lendo
 * da folha impressa da ordem (decisão de 05/08/2026) — o lançamento só
 * libera com todos preenchidos. O nº do lançamento é obrigatório e torna
 * a ordem registro definitivo ('Apontada'). O banco revalida tudo (triggers).
 */
export default function Agrotis() {
  const { usuario, permitido } = useAuth()
  const podeLancar = permitido('agrotis', 'lancar')

  const [ordens, setOrdens] = useState<OrdemEtapasLinha[]>([])
  const [checks, setChecks] = useState<ChecklistQualidade[]>([])
  const [tanques, setTanques] = useState<TanqueLinha[]>([])
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)

  const recarregar = useCallback(async () => {
    const [o, c] = await Promise.all([g.listarOrdensEtapas(), g.listarChecksQualidade()])
    setOrdens(o)
    setChecks(c)
    const prontasIds = o
      .filter((x) => x.status_efetivo === 'Qualidade apontada' && x.conferida)
      .map((x) => x.id)
    setTanques(await g.listarTanquesDeOrdens(prontasIds))
  }, [])

  useEffect(() => {
    setCarregando(true)
    recarregar()
      .catch((e) => setErro(e instanceof Error ? e.message : String(e)))
      .finally(() => setCarregando(false))
  }, [recarregar])

  useRealtime(['ordens', 'qualidade_checks', 'ordem_conferencias'], recarregar)

  async function comErro(fn: () => Promise<void>) {
    try {
      setErro(null)
      await fn()
      await recarregar()
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    }
  }

  // pronta = qualidade final apontada E conferida pela logística
  const prontas = ordens.filter(
    (o) => o.status_efetivo === 'Qualidade apontada' && o.conferida,
  )
  const aguardando = ordens.filter(
    (o) =>
      o.status_efetivo === 'Finalizada' ||
      (o.status_efetivo === 'Qualidade apontada' && !o.conferida),
  )
  const lancadas = ordens.filter((o) => o.status_efetivo === 'Apontada')

  const checkFinal = (id: string) =>
    checks.find((c) => c.ordem_id === id && c.etapa === 'final')

  const faltaDe = (o: OrdemEtapasLinha): string => {
    const falta: string[] = []
    if (o.status_efetivo === 'Finalizada') falta.push('qualidade final')
    if (!o.conferida) falta.push('conferência de estoque')
    return falta.join(' e ')
  }

  if (carregando) return <p className="p-8 text-sm text-stone-500">Carregando AGROTIS…</p>

  return (
    <Pagina
      titulo="AGROTIS"
      descricao="Última etapa da ordem. Só libera com a qualidade final apontada E a conferência de estoque feita; o nº do lançamento encerra em definitivo."
    >
      {erro && <Erro>{erro}</Erro>}

      {/* ---------------- prontas para lançar ---------------- */}
      <Cartao titulo={`Prontas para lançar (${prontas.length})`} className="mb-5">
        {prontas.length === 0 ? (
          <Vazio>
            Nenhuma ordem com os dois pré-requisitos cumpridos (qualidade final + conferência).
          </Vazio>
        ) : (
          <div className="space-y-3">
            {prontas.map((o) => {
              const f = checkFinal(o.id)
              const tqs = tanques.filter((t) => t.ordem_id === o.id)
              const semPesoFinal = tqs.filter((t) => t.peso_final == null)
              return (
                <div key={o.id} className="rounded-md border border-stone-200 p-3 dark:border-stone-700">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                      <p className="font-medium">{o.numero} · {o.cultivar}</p>
                      <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-stone-500">
                        <span>{o.receita_nome} · lote {o.lote_id} · {o.bags} bg · {n(o.peso_t, 1)} t</span>
                        {f && (
                          <>
                            <span>· q. geral <b>{f.recobrimento}</b>/5</span>
                            <Tag cor={f.umidade_ok ? 'ok' : 'alerta'}>
                              umidade {f.umidade_ok ? 'OK' : 'fora'}
                            </Tag>
                            <Tag cor={f.po_ok ? 'ok' : 'alerta'}>
                              pó {f.po_ok ? 'OK' : 'fora'}
                            </Tag>
                          </>
                        )}
                        <Tag cor={o.bags_produzidos != null ? 'neutro' : 'alerta'}>
                          produzido: {o.bags_produzidos ?? '—'} bg
                        </Tag>
                        <Tag
                          cor={o.bags_contados === (o.bags_produzidos ?? o.bags) ? 'ok' : 'alerta'}
                        >
                          conferido: {o.bags_contados} bg
                        </Tag>
                      </p>
                    </div>
                    {podeLancar && (
                      <FormLancamento
                        podeLancar={semPesoFinal.length === 0}
                        motivo={
                          semPesoFinal.length > 0
                            ? `Falta o peso final em ${semPesoFinal
                                .map((t) => rotuloTanque(t.tanque))
                                .join(', ')}`
                            : undefined
                        }
                        onLancar={(numero) =>
                          comErro(() => g.apontarAgrotis(o.id, numero, usuario!.id))
                        }
                      />
                    )}
                  </div>

                  {/* pesos finais, transcritos da folha impressa da ordem */}
                  {podeLancar && tqs.length > 0 && (
                    <div className="mt-3 flex flex-wrap items-end gap-3">
                      {tqs.map((t) => (
                        <PesoFinalTanque
                          key={t.id}
                          tanque={t}
                          onSalvar={(v) =>
                            comErro(() => salvarPesoTanque(t.id, 'peso_final', v))
                          }
                        />
                      ))}
                      {semPesoFinal.length > 0 && (
                        <p className="text-xs text-amber-600 dark:text-amber-400">
                          Transcreva da folha da ordem — o lançamento só libera com todos.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Cartao>

      {/* ---------------- aguardando pré-requisitos ---------------- */}
      {aguardando.length > 0 && (
        <Cartao titulo={`Aguardando pré-requisitos (${aguardando.length})`} className="mb-5">
          <p className="mb-3 text-sm text-stone-500">
            Finalizadas pela produção, mas ainda sem tudo que o lançamento exige.
          </p>
          <Tabela cabecalho={['Ordem', 'Cultivar', 'Tratamento', 'Lote', '#Bags', 'Dia', 'Falta']}>
            {aguardando.map((o) => (
              <tr key={o.id} className="border-t border-stone-100 dark:border-stone-800/60">
                <td className="px-2 py-1.5 font-medium">{o.numero}</td>
                <td className="px-2 py-1.5">{o.cultivar}</td>
                <td className="px-2 py-1.5">{o.receita_nome}</td>
                <td className="px-2 py-1.5">{o.lote_id}</td>
                <td className="num-tabular px-2 py-1.5 text-right">{o.bags}</td>
                <td className="px-2 py-1.5">{diaCurto(o.data_prog)}</td>
                <td className="px-2 py-1.5">
                  <Tag cor="alerta">{faltaDe(o)}</Tag>
                </td>
              </tr>
            ))}
          </Tabela>
        </Cartao>
      )}

      {/* ---------------- lançadas ---------------- */}
      <Cartao titulo={`Lançadas (${lancadas.length})`}>
        {lancadas.length === 0 ? (
          <Vazio>Nenhuma ordem lançada no AGROTIS ainda.</Vazio>
        ) : (
          <Tabela cabecalho={['Ordem', 'Cultivar', 'Tratamento', '#Bags', '#Peso', 'Nº lançamento']}>
            {lancadas.map((o) => (
              <tr key={o.id} className="border-t border-stone-100 dark:border-stone-800/60">
                <td className="px-2 py-1.5 font-medium">{o.numero}</td>
                <td className="px-2 py-1.5">{o.cultivar}</td>
                <td className="px-2 py-1.5">{o.receita_nome}</td>
                <td className="num-tabular px-2 py-1.5 text-right">{o.bags}</td>
                <td className="num-tabular px-2 py-1.5 text-right">{n(o.peso_t, 1)} t</td>
                <td className="px-2 py-1.5 font-semibold">{o.agrotis_num ?? '—'}</td>
              </tr>
            ))}
          </Tabela>
        )}
      </Cartao>
    </Pagina>
  )
}

function FormLancamento({
  onLancar, podeLancar, motivo,
}: {
  onLancar: (numero: string) => void
  podeLancar: boolean
  motivo?: string
}) {
  const [numero, setNumero] = useState('')
  return (
    <div className="flex items-center gap-2">
      <input
        value={numero}
        onChange={(e) => setNumero(e.target.value)}
        placeholder="nº do lançamento"
        className="w-40 rounded-md border border-stone-300 px-2 py-1.5 text-sm dark:border-stone-700 dark:bg-stone-800"
      />
      <Botao
        variante="primario"
        disabled={!numero.trim() || !podeLancar}
        titulo={motivo}
        onClick={() => onLancar(numero)}
      >
        Lançar
      </Botao>
    </div>
  )
}

/** Peso final de um tanque, digitado pelo PCP a partir da folha da ordem. */
function PesoFinalTanque({
  tanque, onSalvar,
}: {
  tanque: TanqueLinha
  onSalvar: (v: number | null) => void
}) {
  const [texto, setTexto] = useState(
    tanque.peso_final == null ? '' : String(tanque.peso_final),
  )
  return (
    <label className="text-xs text-stone-500 dark:text-stone-400">
      {rotuloTanque(tanque.tanque)}
      <span className="mx-1 text-stone-400">
        ini {tanque.peso_inicial == null ? '—' : n(tanque.peso_inicial, 1)}
      </span>
      <input
        inputMode="decimal"
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        onBlur={() => {
          const limpo = texto.replace(',', '.').trim()
          const v = limpo === '' ? null : Number(limpo)
          if (v != null && Number.isNaN(v)) return
          if (v !== tanque.peso_final) onSalvar(v)
        }}
        placeholder="final"
        className="num-tabular ml-1 w-20 rounded-md border border-stone-300 px-2 py-1.5 text-right text-sm dark:border-stone-700 dark:bg-stone-800"
      />
    </label>
  )
}
