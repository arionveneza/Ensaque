import { useEffect, useMemo, useState } from 'react'
import * as g from '@/dados/api-gestao'
import type { OrdemResumoReceita, ReceitaCompleta } from '@/dados/api-gestao'
import { pesoItemKg, volumeItemL } from '@/dominio/calculos'
import { Botao, Tag } from '@/componentes/ui'
import { imprimirTabela } from '@/lib/exportar'

/**
 * Calculadora de calda (mix) — a versão digital da folha "Calda (MIX)" que
 * fica pregada na sala de preparo: tratamento, volume de semente e a tabela
 * químico × dose × consumo. Vive FORA da tela de ordem de propósito (pedido
 * do PCP, 13/08/2026): a calda serve várias ordens de uma vez, e misturada à
 * preparação de UMA ordem confundia com o planejado por tanque, que é só
 * daquela ordem.
 *
 * O "consumo ideal" segue a MESMA conta da folha impressa: dose × semente,
 * SEM densidade — litros para produto dosado em ml, kg para dosado em g. A
 * coluna "peso na balança" (kg, com densidade) vem ao lado, porque é ela que
 * confere com a pesagem dos tanques.
 */

const num = (v: number, casas = 2) =>
  v.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas })

/** Ordens que ainda vão consumir calda: por fazer ou em andamento. */
const STATUS_ATIVOS = ['Aguardando lote', 'Pronto para produzir', 'Em producao', 'Parada']

interface Props {
  onFechar: () => void
}

export default function CalculadoraCalda({ onFechar }: Props) {
  const [receitas, setReceitas] = useState<ReceitaCompleta[]>([])
  const [erro, setErro] = useState<string | null>(null)
  const [receitaId, setReceitaId] = useState('')
  const [ordensDaReceita, setOrdensDaReceita] = useState<OrdemResumoReceita[]>([])
  // vazio = usa a soma automática das ordens; digitou = vale o que digitou
  const [kgManual, setKgManual] = useState('')

  useEffect(() => {
    let vivo = true
    g.listarReceitas()
      .then((r) => vivo && setReceitas(r.filter((x) => x.ativa)))
      .catch((e) => vivo && setErro(e instanceof Error ? e.message : String(e)))
    return () => {
      vivo = false
    }
  }, [])

  useEffect(() => {
    if (!receitaId) {
      setOrdensDaReceita([])
      return
    }
    let vivo = true
    g.listarOrdensDaReceita(receitaId)
      .then((r) => vivo && setOrdensDaReceita(r))
      .catch(() => vivo && setOrdensDaReceita([]))
    return () => {
      vivo = false
    }
  }, [receitaId])

  const receita = receitas.find((r) => r.id === receitaId) ?? null
  const ordensAtivas = ordensDaReceita.filter((o) => STATUS_ATIVOS.includes(o.status_efetivo))
  const autoKg = ordensAtivas.reduce((s, o) => s + o.peso_kg, 0)

  const manualKg = (() => {
    const limpo = kgManual.replace(/\./g, '').replace(',', '.').trim()
    if (limpo === '') return null
    const v = Number(limpo)
    return Number.isFinite(v) && v > 0 ? v : null
  })()
  const pesoKg = manualKg ?? autoKg

  const linhas = useMemo(() => {
    if (!receita) return []
    return receita.receita_itens.map((i) => {
      const p = i.produtos_quimicos
      const item = { produtoId: i.produto_id, dose: i.dose }
      const produto = {
        id: i.produto_id,
        codigo: p.codigo,
        nome: p.nome,
        unidade: p.unidade,
        densidade: p.densidade,
      }
      const volumeL = pesoKg > 0 ? volumeItemL(item, produto, pesoKg) : null
      let balancaKg: number | null = null
      try {
        balancaKg = pesoKg > 0 ? pesoItemKg(item, produto, pesoKg) : null
      } catch {
        balancaKg = null // densidade faltando no cadastro
      }
      // consumo ideal = a conta da folha impressa: sem densidade.
      // ml → litros (volumeL); g → o próprio peso (kg).
      const consumoIdeal =
        volumeL != null ? `${num(volumeL)} L` : balancaKg != null ? `${num(balancaKg)} kg` : '—'
      return { nome: p.nome, dose: i.dose, unidade: p.unidade, consumoIdeal, balancaKg }
    })
  }, [receita, pesoKg])

  // origem do peso em uso — estampada na tela e na folha impressa, porque a
  // folha fica pregada na parede e alguém precisa saber se aquele número
  // veio das ordens de um momento (envelhece) ou foi decidido por uma pessoa
  const origemPeso =
    manualKg != null
      ? 'peso digitado manualmente'
      : `peso das ordens (${ordensAtivas.length} por fazer/em andamento)`

  function imprimir() {
    if (!receita) return
    imprimirTabela(
      'Calda (MIX)',
      `${receita.nome} · ${num(pesoKg, 0)} kg de semente · ${origemPeso}`,
      ['Químico', 'Dose', 'Consumo (ideal)', 'Peso na balança (kg)'],
      linhas.map((l) => [
        l.nome,
        `${num(l.dose, 0)} ${l.unidade}`,
        l.consumoIdeal,
        l.balancaKg == null ? '—' : num(l.balancaKg),
      ]),
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
      onClick={onFechar}
    >
      <div
        className="mt-8 w-full max-w-2xl rounded-lg bg-white p-5 shadow-xl dark:bg-stone-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
              Calda (MIX)
            </h2>
            <p className="text-sm text-stone-500 dark:text-stone-400">
              Quantidade de cada químico para preparar a mistura — igual à folha impressa.
            </p>
          </div>
          <div className="flex gap-2">
            {receita && linhas.length > 0 && <Botao onClick={imprimir}>Imprimir</Botao>}
            <Botao onClick={onFechar}>Fechar</Botao>
          </div>
        </div>

        {erro && (
          <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
            {erro}
          </p>
        )}

        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <label className="text-sm text-stone-600 dark:text-stone-300">
            Tratamento
            <select
              value={receitaId}
              onChange={(e) => {
                setReceitaId(e.target.value)
                setKgManual('')
              }}
              className="mt-1 w-full rounded-md border border-stone-300 px-2 py-2 dark:border-stone-700 dark:bg-stone-800"
            >
              <option value="">escolha a receita…</option>
              {receitas.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.nome}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm text-stone-600 dark:text-stone-300">
            Semente a tratar (kg)
            <input
              inputMode="decimal"
              value={kgManual}
              onChange={(e) => setKgManual(e.target.value)}
              placeholder={receitaId ? num(autoKg, 0) : '—'}
              className={`num-tabular mt-1 w-full rounded-md border px-2 py-2 text-right dark:bg-stone-800 ${
                manualKg != null
                  ? 'border-amber-400 dark:border-amber-700'
                  : 'border-stone-300 dark:border-stone-700'
              }`}
            />
            {receitaId && manualKg != null && (
              <span className="mt-1 block text-xs text-stone-500 dark:text-stone-400">
                <button type="button" onClick={() => setKgManual('')} className="underline">
                  voltar pro peso das ordens ({num(autoKg, 0)} kg)
                </button>
              </span>
            )}
          </label>
        </div>

        {receita && (
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-stone-600 dark:text-stone-300">
              Calculado para <b className="num-tabular">{num(pesoKg, 0)} kg</b> —
            </span>
            {manualKg != null ? (
              <Tag cor="alerta">peso digitado manualmente</Tag>
            ) : (
              <Tag cor="info">
                peso das ordens · {ordensAtivas.length} por fazer/em andamento
              </Tag>
            )}
          </div>
        )}

        {!receita ? (
          <p className="rounded-md bg-stone-50 px-4 py-6 text-center text-sm text-stone-500 dark:bg-stone-800/50 dark:text-stone-400">
            Escolha o tratamento para ver as quantidades.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-stone-200 dark:border-stone-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500 dark:bg-stone-800/60 dark:text-stone-400">
                  <th className="px-3 py-2">Químico</th>
                  <th className="px-3 py-2 text-right">Dose</th>
                  <th className="px-3 py-2 text-right">Consumo (ideal)</th>
                  <th className="px-3 py-2 text-right">Peso na balança (kg)</th>
                </tr>
              </thead>
              <tbody>
                {linhas.map((l) => (
                  <tr key={l.nome} className="border-t border-stone-100 dark:border-stone-800/60">
                    <td className="px-3 py-2 font-medium">{l.nome}</td>
                    <td className="num-tabular px-3 py-2 text-right text-stone-500">
                      {num(l.dose, 0)} {l.unidade}
                    </td>
                    <td className="num-tabular px-3 py-2 text-right font-semibold">
                      {l.consumoIdeal}
                    </td>
                    <td className="num-tabular px-3 py-2 text-right">
                      {l.balancaKg == null ? '—' : num(l.balancaKg)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="border-t border-stone-100 px-3 py-2 text-xs text-stone-500 dark:border-stone-800/60 dark:text-stone-400">
              Consumo (ideal) é a mesma conta da folha impressa: dose × semente, sem densidade
              (litros para dose em ml). Peso na balança é o que confere com a pesagem dos
              tanques.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
