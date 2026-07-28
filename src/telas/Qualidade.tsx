import { useCallback, useEffect, useState } from 'react'
import * as g from '@/dados/api-gestao'
import type { OrdemVisao, QualidadeLinha } from '@/dados/api-gestao'
import type { QualidadeVisual } from '@/dominio/tipos'
import { useAuth } from '@/auth/AuthProvider'
import {
  Aviso, Botao, Cartao, Erro, Pagina, Tabela, Tag, Vazio, n,
} from '@/componentes/ui'

const VISUAIS: QualidadeVisual[] = ['Aprovado', 'Aprovado com observacao', 'Reprovado']

export default function Qualidade() {
  const { usuario } = useAuth()
  const podeApontarQualidade =
    usuario?.perfil === 'Qualidade' || usuario?.perfil === 'Gestor'
  const podeEncerrar = usuario?.perfil === 'PCP' || usuario?.perfil === 'Gestor'

  const [ordens, setOrdens] = useState<OrdemVisao[]>([])
  const [apontamentos, setApontamentos] = useState<QualidadeLinha[]>([])
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)
  const [aberta, setAberta] = useState<string | null>(null)

  const recarregar = useCallback(async () => {
    const [o, q] = await Promise.all([g.listarOrdens(), g.listarQualidade()])
    setOrdens(o)
    setApontamentos(q)
  }, [])

  useEffect(() => {
    setCarregando(true)
    recarregar()
      .catch((e) => setErro(e instanceof Error ? e.message : String(e)))
      .finally(() => setCarregando(false))
  }, [recarregar])

  async function comErro(fn: () => Promise<void>) {
    try {
      setErro(null)
      await fn()
      await recarregar()
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    }
  }

  const aguardando = ordens.filter((o) => o.status_efetivo === 'Finalizada')
  const apontadas = ordens.filter((o) => o.status_efetivo === 'Qualidade apontada')
  const encerradas = ordens.filter((o) => o.status_efetivo === 'Apontada')

  const doApontamento = (id: string) => apontamentos.find((a) => a.ordem_id === id)

  if (carregando) return <p className="p-8 text-sm text-stone-500">Carregando qualidade…</p>

  return (
    <Pagina
      titulo="Qualidade"
      descricao="Avaliação visual e retirada de amostra. Depois o PCP lança no AGROTIS e encerra a ordem."
    >
      {erro && <Erro>{erro}</Erro>}

      <Cartao titulo={`Aguardando qualidade (${aguardando.length})`} className="mb-5">
        {aguardando.length === 0 ? (
          <Vazio>Nenhuma ordem finalizada aguardando avaliação.</Vazio>
        ) : (
          <div className="space-y-3">
            {aguardando.map((o) => (
              <div
                key={o.id}
                className="rounded-md border border-stone-200 p-3 dark:border-stone-700"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <p className="font-medium">
                      {o.numero} · {o.cultivar}
                    </p>
                    <p className="text-xs text-stone-500">
                      {o.receita_nome} · lote {o.lote_id} · {n(o.peso_t, 1)} t ·{' '}
                      {o.maquina_id ?? '—'}
                    </p>
                  </div>
                  {podeApontarQualidade && (
                    <Botao onClick={() => setAberta(aberta === o.id ? null : o.id)}>
                      {aberta === o.id ? 'Cancelar' : 'Apontar qualidade'}
                    </Botao>
                  )}
                </div>
                {aberta === o.id && (
                  <FormQualidade
                    onSalvar={(visual, amostra, obs) =>
                      comErro(async () => {
                        await g.apontarQualidade(o.id, visual, amostra, obs, usuario!.id)
                        setAberta(null)
                      })
                    }
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </Cartao>

      <Cartao titulo={`Qualidade apontada — aguardando AGROTIS (${apontadas.length})`} className="mb-5">
        {apontadas.length === 0 ? (
          <Vazio>Nenhuma ordem aguardando lançamento no AGROTIS.</Vazio>
        ) : (
          <div className="space-y-3">
            {apontadas.map((o) => {
              const a = doApontamento(o.id)
              return (
                <div
                  key={o.id}
                  className="rounded-md border border-stone-200 p-3 dark:border-stone-700"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                      <p className="font-medium">
                        {o.numero} · {o.cultivar}
                      </p>
                      <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-stone-500">
                        <Tag
                          cor={
                            a?.visual === 'Aprovado'
                              ? 'ok'
                              : a?.visual === 'Reprovado'
                                ? 'perigo'
                                : 'alerta'
                          }
                        >
                          {a?.visual ?? '—'}
                        </Tag>
                        <span>amostra: {a?.amostra ? 'sim' : 'não'}</span>
                        {a?.observacao && <span>· {a.observacao}</span>}
                      </p>
                    </div>
                    {podeEncerrar && <FormAgrotis
                      onEncerrar={(numero) =>
                        comErro(() => g.apontarAgrotis(o.id, numero, usuario!.id))
                      }
                    />}
                  </div>
                  {a?.visual === 'Reprovado' && (
                    <div className="mt-3">
                      <Aviso gravidade="bloqueio">
                        Ordem reprovada. O tratamento de retrabalho ainda não está definido no
                        sistema — decidir com a qualidade antes de encerrar.
                      </Aviso>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Cartao>

      <Cartao titulo={`Encerradas no AGROTIS (${encerradas.length})`}>
        {encerradas.length === 0 ? (
          <Vazio>Nenhuma ordem encerrada.</Vazio>
        ) : (
          <Tabela cabecalho={['Ordem', 'Cultivar', 'Tratamento', '#Peso', 'Qualidade', 'AGROTIS']}>
            {encerradas.map((o) => {
              const a = doApontamento(o.id)
              return (
                <tr key={o.id} className="border-t border-stone-100 dark:border-stone-800/60">
                  <td className="px-2 py-1.5 font-medium">{o.numero}</td>
                  <td className="px-2 py-1.5">{o.cultivar}</td>
                  <td className="px-2 py-1.5">{o.receita_nome}</td>
                  <td className="num-tabular px-2 py-1.5 text-right">{n(o.peso_t, 1)} t</td>
                  <td className="px-2 py-1.5">{a?.visual ?? '—'}</td>
                  <td className="px-2 py-1.5 font-medium">{o.agrotis_num ?? '—'}</td>
                </tr>
              )
            })}
          </Tabela>
        )}
      </Cartao>
    </Pagina>
  )
}

function FormQualidade({
  onSalvar,
}: {
  onSalvar: (visual: QualidadeVisual, amostra: boolean, obs: string | null) => void
}) {
  const [visual, setVisual] = useState<QualidadeVisual>('Aprovado')
  const [amostra, setAmostra] = useState(true)
  const [obs, setObs] = useState('')

  return (
    <div className="mt-3 border-t border-stone-200 pt-3 dark:border-stone-700">
      <div className="flex flex-wrap gap-2">
        {VISUAIS.map((v) => (
          <button
            key={v}
            onClick={() => setVisual(v)}
            className={`rounded-md border px-3 py-1.5 text-sm ${
              visual === v
                ? 'border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900'
                : 'border-stone-300 dark:border-stone-700'
            }`}
          >
            {v}
          </button>
        ))}
      </div>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={amostra} onChange={(e) => setAmostra(e.target.checked)} />
        Amostra retirada
      </label>
      <input
        value={obs}
        onChange={(e) => setObs(e.target.value)}
        placeholder="observação (opcional)"
        className="mt-3 w-full rounded-md border border-stone-300 px-2 py-1.5 text-sm dark:border-stone-700 dark:bg-stone-800"
      />
      <div className="mt-3">
        <Botao variante="primario" onClick={() => onSalvar(visual, amostra, obs.trim() || null)}>
          Salvar avaliação
        </Botao>
      </div>
    </div>
  )
}

function FormAgrotis({ onEncerrar }: { onEncerrar: (numero: string) => void }) {
  const [numero, setNumero] = useState('')
  return (
    <div className="flex items-center gap-2">
      <input
        value={numero}
        onChange={(e) => setNumero(e.target.value)}
        placeholder="nº do lançamento"
        className="w-40 rounded-md border border-stone-300 px-2 py-1.5 text-sm dark:border-stone-700 dark:bg-stone-800"
      />
      <Botao variante="primario" disabled={!numero.trim()} onClick={() => onEncerrar(numero)}>
        Encerrar
      </Botao>
    </div>
  )
}
