import { useCallback, useEffect, useState } from 'react'
import * as g from '@/dados/api-gestao'
import type { ChecklistQualidade, OrdemVisao } from '@/dados/api-gestao'
import { useRealtime } from '@/dados/useRealtime'
import { useAuth } from '@/auth/AuthProvider'
import {
  Botao, Cartao, Erro, Pagina, Tabela, Tag, Vazio, diaCurto, n,
} from '@/componentes/ui'

/**
 * Encerramento no AGROTIS — etapa do PCP.
 *
 * Só entra aqui a ordem Finalizada COM a qualidade final apontada (status
 * 'Qualidade apontada'). O nº do lançamento é obrigatório e torna a ordem
 * registro definitivo ('Apontada').
 */
export default function Agrotis() {
  const { usuario, permitido } = useAuth()
  const podeLancar = permitido('agrotis', 'lancar')

  const [ordens, setOrdens] = useState<OrdemVisao[]>([])
  const [checks, setChecks] = useState<ChecklistQualidade[]>([])
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)

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

  const prontas = ordens.filter((o) => o.status_efetivo === 'Qualidade apontada')
  const bloqueadas = ordens.filter((o) => o.status_efetivo === 'Finalizada')
  const lancadas = ordens.filter((o) => o.status_efetivo === 'Apontada')

  const checkFinal = (id: string) =>
    checks.find((c) => c.ordem_id === id && c.etapa === 'final')

  if (carregando) return <p className="p-8 text-sm text-stone-500">Carregando AGROTIS…</p>

  return (
    <Pagina
      titulo="AGROTIS"
      descricao="Lançamento das ordens no AGROTIS. Só libera com a qualidade final apontada; o nº do lançamento encerra a ordem em definitivo."
    >
      {erro && <Erro>{erro}</Erro>}

      {/* ---------------- prontas para lançar ---------------- */}
      <Cartao titulo={`Prontas para lançar (${prontas.length})`} className="mb-5">
        {prontas.length === 0 ? (
          <Vazio>Nenhuma ordem com qualidade final apontada aguardando lançamento.</Vazio>
        ) : (
          <div className="space-y-3">
            {prontas.map((o) => {
              const f = checkFinal(o.id)
              return (
                <div key={o.id} className="rounded-md border border-stone-200 p-3 dark:border-stone-700">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                      <p className="font-medium">{o.numero} · {o.cultivar}</p>
                      <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-stone-500">
                        <span>{o.receita_nome} · lote {o.lote_id} · {o.bags} bg · {n(o.peso_t, 1)} t</span>
                        {f && (
                          <>
                            <span>· recobrimento <b>{f.recobrimento}</b>/5</span>
                            <Tag cor={f.umidade_ok ? 'ok' : 'alerta'}>
                              umidade {f.umidade_ok ? 'OK' : 'fora'}
                            </Tag>
                            <Tag cor={f.po_ok ? 'ok' : 'alerta'}>
                              pó {f.po_ok ? 'OK' : 'fora'}
                            </Tag>
                          </>
                        )}
                      </p>
                    </div>
                    {podeLancar && (
                      <FormLancamento
                        onLancar={(numero) =>
                          comErro(() => g.apontarAgrotis(o.id, numero, usuario!.id))
                        }
                      />
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Cartao>

      {/* ---------------- aguardando qualidade ---------------- */}
      {bloqueadas.length > 0 && (
        <Cartao titulo={`Aguardando qualidade final (${bloqueadas.length})`} className="mb-5">
          <p className="mb-3 text-sm text-stone-500">
            Finalizadas pela produção, mas a qualidade final ainda não foi apontada — sem ela o
            lançamento não libera.
          </p>
          <Tabela cabecalho={['Ordem', 'Cultivar', 'Tratamento', 'Lote', '#Bags', 'Dia']}>
            {bloqueadas.map((o) => (
              <tr key={o.id} className="border-t border-stone-100 dark:border-stone-800/60">
                <td className="px-2 py-1.5 font-medium">{o.numero}</td>
                <td className="px-2 py-1.5">{o.cultivar}</td>
                <td className="px-2 py-1.5">{o.receita_nome}</td>
                <td className="px-2 py-1.5">{o.lote_id}</td>
                <td className="num-tabular px-2 py-1.5 text-right">{o.bags}</td>
                <td className="px-2 py-1.5">{diaCurto(o.data_prog)}</td>
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

function FormLancamento({ onLancar }: { onLancar: (numero: string) => void }) {
  const [numero, setNumero] = useState('')
  return (
    <div className="flex items-center gap-2">
      <input
        value={numero}
        onChange={(e) => setNumero(e.target.value)}
        placeholder="nº do lançamento"
        className="w-40 rounded-md border border-stone-300 px-2 py-1.5 text-sm dark:border-stone-700 dark:bg-stone-800"
      />
      <Botao variante="primario" disabled={!numero.trim()} onClick={() => onLancar(numero)}>
        Lançar
      </Botao>
    </div>
  )
}
