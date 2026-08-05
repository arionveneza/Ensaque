import { useCallback, useEffect, useMemo, useState } from 'react'
import * as g from '@/dados/api-gestao'
import type { OrdemEtapasLinha } from '@/dados/api-gestao'
import {
  etapasDaOrdem, etapasPendentes, ordemConcluida, type EtapaOrdem,
} from '@/dominio/etapas'
import { useRealtime } from '@/dados/useRealtime'
import { Cartao, Erro, Pagina, Tabela, Tag, Vazio, corDoStatus, diaCurto } from '@/componentes/ui'

/**
 * Visão geral: cada ordem com a régua de etapas —
 * Produção → Q. processo → Q. final → Conferência → AGROTIS.
 */
export default function Etapas() {
  const [ordens, setOrdens] = useState<OrdemEtapasLinha[]>([])
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)
  const [busca, setBusca] = useState('')
  const [soPendentes, setSoPendentes] = useState(true)

  const recarregar = useCallback(async () => {
    setOrdens(await g.listarOrdensEtapas())
  }, [])

  useEffect(() => {
    setCarregando(true)
    recarregar()
      .catch((e) => setErro(e instanceof Error ? e.message : String(e)))
      .finally(() => setCarregando(false))
  }, [recarregar])

  useRealtime(['ordens', 'qualidade_checks', 'ordem_conferencias'], recarregar)

  const filtradas = useMemo(() => {
    const termo = busca.trim().toLowerCase()
    return ordens
      .filter((o) => !soPendentes || !ordemConcluida(o))
      .filter(
        (o) =>
          !termo ||
          [o.numero, o.cultivar, o.receita_nome, o.lote_id, o.maquina_id ?? '']
            .join(' ')
            .toLowerCase()
            .includes(termo),
      )
      // quem tem mais etapa aberta primeiro; empate por dia
      .sort(
        (a, b) =>
          etapasPendentes(b) - etapasPendentes(a) ||
          (a.data_prog ?? '9999').localeCompare(b.data_prog ?? '9999'),
      )
  }, [ordens, busca, soPendentes])

  const concluidas = ordens.filter(ordemConcluida).length

  if (carregando) return <p className="p-8 text-sm text-stone-500">Carregando etapas…</p>

  return (
    <Pagina
      titulo="Etapas"
      descricao="Cada ordem e sua régua: Produção → Q. processo → Q. final → Conferência → AGROTIS. Verde feita, âmbar pendente, cinza ainda não se aplica."
    >
      {erro && <Erro>{erro}</Erro>}

      <Cartao
        titulo={`Ordens (${filtradas.length} de ${ordens.length} · ${concluidas} concluídas)`}
        acoes={
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={soPendentes}
                onChange={(e) => setSoPendentes(e.target.checked)}
              />
              só com etapa pendente
            </label>
            <input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="buscar ordem, lote, cultivar…"
              className="w-52 rounded-md border border-stone-300 px-2 py-1 text-sm dark:border-stone-700 dark:bg-stone-800"
            />
          </div>
        }
      >
        {filtradas.length === 0 ? (
          <Vazio>
            {ordens.length === 0
              ? 'Nenhuma ordem cadastrada.'
              : 'Nada nesse filtro — nenhuma ordem com etapa pendente.'}
          </Vazio>
        ) : (
          <Tabela cabecalho={['Ordem', 'Lote', 'Cultivar', 'Tratamento', 'Dia', 'Máq.',
            'Produção', 'Q. processo', 'Q. final', 'Conferência', 'AGROTIS', 'Status']}>
            {filtradas.map((o) => (
              <tr key={o.id} className="border-t border-stone-100 dark:border-stone-800/60">
                <td className="px-2 py-1.5 font-medium">{o.numero}</td>
                <td className="px-2 py-1.5">{o.lote_id}</td>
                <td className="px-2 py-1.5">{o.cultivar}</td>
                <td className="px-2 py-1.5">{o.receita_nome}</td>
                <td className="px-2 py-1.5">{diaCurto(o.data_prog)}</td>
                <td className="px-2 py-1.5">{o.maquina_id ?? '—'}</td>
                {etapasDaOrdem(o).map((e) => (
                  <td key={e.id} className="px-2 py-1.5 text-center">
                    <ChipEtapa etapa={e} />
                  </td>
                ))}
                <td className="px-2 py-1.5">
                  <Tag cor={corDoStatus(o.status_efetivo)}>{o.status_efetivo}</Tag>
                </td>
              </tr>
            ))}
          </Tabela>
        )}
      </Cartao>
    </Pagina>
  )
}

function ChipEtapa({ etapa }: { etapa: EtapaOrdem }) {
  if (etapa.situacao === 'feita') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
        title={etapa.detalhe}
      >
        ✓{etapa.detalhe ? ` ${etapa.detalhe}` : ''}
      </span>
    )
  }
  if (etapa.situacao === 'pendente') {
    return (
      <span
        className="inline-flex items-center rounded border border-amber-400 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:border-amber-700 dark:text-amber-400"
        title={etapa.detalhe ?? 'pendente'}
      >
        pendente
      </span>
    )
  }
  return (
    <span className="text-xs text-stone-300 dark:text-stone-600" title={etapa.detalhe}>
      {etapa.detalhe === 'não realizada' ? 'não realizada' : '—'}
    </span>
  )
}
