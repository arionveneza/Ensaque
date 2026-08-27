import { useEffect, useMemo, useState } from 'react'
import * as g from '@/dados/api-gestao'
import type { BalancoLinha, EmbalagemLinha, ReceitaCompleta } from '@/dados/api-gestao'
import { calcularMrp, PESO_REF_BAG_KG, type NecessidadeProduto } from '@/dominio/mrp'
import { useRealtime } from '@/dados/useRealtime'
import { exportarXlsx } from '@/lib/exportar'
import {
  Aviso, Botao, Cartao, Erro, Pagina, Tabela, Tag, Vazio, inteiro, n,
} from '@/componentes/ui'

/**
 * MRP — quanto químico é preciso pra cobrir tudo que falta produzir.
 *
 * Lê o MESMO balanço do painel Demanda × Estoque × Planejado (pedidos
 * aprovados − estoque PA − ordens abertas) e cruza a demanda descoberta com
 * as receitas cadastradas. Duas parcelas: FIRME (pedido aprovado) e
 * AGUARDANDO (adicional se o pedido pendente de liberação financeira
 * aprovar). Não pede upload próprio: atualizar a carga de pedidos/saldos na
 * tela Ordens atualiza isto aqui junto.
 */
export default function Mrp() {
  const [balanco, setBalanco] = useState<BalancoLinha[]>([])
  const [receitas, setReceitas] = useState<ReceitaCompleta[]>([])
  const [embalagens, setEmbalagens] = useState<EmbalagemLinha[]>([])
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)
  const [aberto, setAberto] = useState<string | null>(null)

  const recarregar = () =>
    Promise.all([g.listarBalanco(), g.listarReceitas(), g.listarEmbalagens()])
      .then(([b, r, e]) => {
        setBalanco(b)
        setReceitas(r)
        setEmbalagens(e)
        setErro(null)
      })
      .catch((x) => setErro(x instanceof Error ? x.message : String(x)))

  useEffect(() => {
    recarregar().finally(() => setCarregando(false))
  }, [])
  useRealtime(['ordens', 'pedidos_venda', 'estoque_pa', 'receitas'], () => void recarregar())

  const mrp = useMemo(
    () => calcularMrp(balanco, receitas, embalagens),
    [balanco, receitas, embalagens],
  )

  function exportar() {
    void exportarXlsx(
      'mrp-necessidade-material',
      [
        { titulo: 'Produto', largura: 28 },
        { titulo: 'Código', largura: 12 },
        { titulo: 'Unidade da dose', largura: 14 },
        { titulo: 'Firme (kg)', largura: 14, tipo: 'numero' },
        { titulo: 'Aguardando (kg)', largura: 16, tipo: 'numero' },
        { titulo: 'Total (kg)', largura: 14, tipo: 'numero' },
        { titulo: 'Firme (L)', largura: 14, tipo: 'numero' },
        { titulo: 'Aguardando (L)', largura: 16, tipo: 'numero' },
      ],
      mrp.produtos.map((p) => [
        p.nome,
        p.codigo,
        p.unidade,
        arred(p.totalKg),
        arred(p.totalKgAguardando),
        arred(p.totalKg + p.totalKgAguardando),
        p.totalL != null ? arred(p.totalL) : '',
        p.totalLAguardando != null ? arred(p.totalLAguardando) : '',
      ]),
    )
  }

  if (carregando) return <p className="p-8 text-sm text-stone-500">Carregando MRP…</p>

  const avisoBags = (s: { bags: number; bagsAguardando: number }) =>
    s.bagsAguardando > 0
      ? `${inteiro(s.bags)} bg + ${inteiro(s.bagsAguardando)} aguard.`
      : `${inteiro(s.bags)} bg`

  return (
    <Pagina
      titulo="MRP — Necessidade de Material"
      descricao={`Falta produzir (pedidos aprovados − estoque − ordens abertas) × receita = químico necessário; a parcela "aguardando" é o adicional se os pedidos pendentes de liberação financeira aprovarem. Bags viram kg de semente pelo peso de referência: BG5M ${PESO_REF_BAG_KG.BG5M} kg · MEIOBAG ${PESO_REF_BAG_KG.MEIOBAG} kg (demanda ainda sem lote não tem PMS); saco de peso fixo usa o peso do cadastro.`}
    >
      {erro && <Erro>{erro}</Erro>}

      {mrp.semReceita.length > 0 && (
        <div className="mb-5">
          <Aviso gravidade="alerta">
            <b>{mrp.semReceita.length} combinação(ões) fora da conta por falta de receita:</b>{' '}
            {mrp.semReceita
              .map((s) => `${s.cultivar} · ${s.tratamento} · ${s.embalagem} (${avisoBags(s)})`)
              .join(' — ')}
          </Aviso>
        </div>
      )}
      {mrp.semPesoRef.length > 0 && (
        <div className="mb-5">
          <Aviso gravidade="alerta">
            <b>{mrp.semPesoRef.length} combinação(ões) sem peso de referência da embalagem:</b>{' '}
            {mrp.semPesoRef
              .map((s) => `${s.cultivar} · ${s.tratamento} · ${s.embalagem} (${avisoBags(s)})`)
              .join(' — ')}
          </Aviso>
        </div>
      )}

      {/* totais no topo: o tamanho do trabalho que falta, numa olhada */}
      <div className="mb-5 grid gap-2 sm:grid-cols-3">
        <CartaoTotal
          rotulo="Falta produzir (firme)"
          valor={`${inteiro(mrp.totais.bags)} bags`}
          detalhe={
            mrp.totais.bagsAguardando > 0
              ? `+ ${inteiro(mrp.totais.bagsAguardando)} bags aguardando aprovação`
              : `${mrp.combinacoes.length} combinação(ões) com receita`
          }
        />
        <CartaoTotal
          rotulo="Semente a tratar"
          valor={`${n(mrp.totais.kgSemente / 1000, 1)} t`}
          detalhe={
            mrp.totais.kgSementeAguardando > 0
              ? `+ ${n(mrp.totais.kgSementeAguardando / 1000, 1)} t aguardando`
              : `${inteiro(mrp.totais.kgSemente)} kg`
          }
        />
        <CartaoTotal
          rotulo="Químico necessário"
          valor={`${n(mrp.totais.kgQuimico, 1)} kg`}
          detalhe={
            mrp.totais.kgQuimicoAguardando > 0
              ? `+ ${n(mrp.totais.kgQuimicoAguardando, 1)} kg se o aguardando aprovar`
              : `${mrp.produtos.length} produto(s)`
          }
        />
      </div>

      {/* -------- necessidade por produto -------- */}
      <Cartao
        titulo={`Necessidade por produto (${mrp.produtos.length})`}
        acoes={<Botao onClick={exportar} disabled={mrp.produtos.length === 0}>Exportar .xlsx</Botao>}
        className="mb-5"
      >
        {mrp.produtos.length === 0 ? (
          <Vazio>
            Nada descoberto no balanço — ou nenhuma carga de pedidos importada ainda
            (o upload fica na tela Ordens).
          </Vazio>
        ) : (
          <Tabela
            cabecalho={[
              'Produto',
              { texto: 'Unidade da dose', className: 'hidden lg:table-cell' },
              '#Firme (kg)', '#Aguardando (kg)', '#Total (kg)',
              { texto: '#Total (L)', className: 'hidden lg:table-cell' },
              '',
            ]}
          >
            {mrp.produtos.map((p) => (
              <ProdutoLinhas
                key={p.codigo}
                produto={p}
                aberto={aberto === p.codigo}
                onToggle={() => setAberto(aberto === p.codigo ? null : p.codigo)}
              />
            ))}
          </Tabela>
        )}
        <p className="mt-2 text-xs text-stone-500">
          Isto é o consumo pra cobrir a demanda — não desconta o estoque de insumo, que o
          sistema ainda não acompanha. A coluna Aguardando é o ADICIONAL caso os pedidos
          pendentes de liberação financeira aprovem (sobra de estoque já abatida).
        </p>
      </Cartao>

      {/* -------- combinações que entraram na conta -------- */}
      <Cartao titulo={`Demanda coberta pela conta (${mrp.combinacoes.length})`}>
        {mrp.combinacoes.length === 0 ? (
          <Vazio>Nenhuma combinação descoberta com receita cadastrada.</Vazio>
        ) : (
          <Tabela
            cabecalho={[
              'Cultivar', 'Tratamento', 'Emb.',
              '#Firme (bg)', '#Aguardando (bg)', '#Semente (kg)',
            ]}
          >
            {mrp.combinacoes.map((c, i) => (
              <tr key={i} className="border-t border-stone-100 dark:border-stone-800/60">
                <td className="px-2 py-1.5">{c.cultivar}</td>
                <td className="px-2 py-1.5">{c.tratamento}</td>
                <td className="px-2 py-1.5">{c.embalagem}</td>
                <td className="num-tabular px-2 py-1.5 text-right">
                  {c.bags > 0 ? inteiro(c.bags) : <span className="text-stone-300">—</span>}
                </td>
                <td className="num-tabular px-2 py-1.5 text-right text-stone-500">
                  {c.bagsAguardando > 0 ? inteiro(c.bagsAguardando) : <span className="text-stone-300">—</span>}
                </td>
                <td className="num-tabular px-2 py-1.5 text-right">
                  {inteiro(c.kgSemente + c.kgSementeAguardando)}
                </td>
              </tr>
            ))}
          </Tabela>
        )}
      </Cartao>
    </Pagina>
  )
}

const arred = (v: number) => Math.round(v * 100) / 100

function CartaoTotal({ rotulo, valor, detalhe }: { rotulo: string; valor: string; detalhe: string }) {
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm dark:border-stone-800 dark:bg-stone-900">
      <p className="text-xs uppercase tracking-wide text-stone-500">{rotulo}</p>
      <p className="num-tabular mt-1 text-2xl font-bold">{valor}</p>
      <p className="mt-0.5 text-xs text-stone-500">{detalhe}</p>
    </div>
  )
}

function ProdutoLinhas({
  produto: p, aberto, onToggle,
}: {
  produto: NecessidadeProduto
  aberto: boolean
  onToggle: () => void
}) {
  const semDensidade = p.densidade == null && p.unidade.startsWith('ml')
  const totalL =
    p.totalL != null || p.totalLAguardando != null
      ? (p.totalL ?? 0) + (p.totalLAguardando ?? 0)
      : null
  return (
    <>
      <tr className="border-t border-stone-100 dark:border-stone-800/60">
        <td className="px-2 py-1.5 font-medium">
          {p.nome}
          {semDensidade && (
            <span className="ml-1.5">
              <Tag cor="perigo">sem densidade — kg indisponível</Tag>
            </span>
          )}
        </td>
        <td className="hidden px-2 py-1.5 text-stone-500 lg:table-cell">{p.unidade}</td>
        <td className="num-tabular px-2 py-1.5 text-right">
          {semDensidade ? '—' : n(p.totalKg, 1)}
        </td>
        <td className="num-tabular px-2 py-1.5 text-right text-stone-500">
          {semDensidade ? '—' : p.totalKgAguardando > 0 ? n(p.totalKgAguardando, 1) : <span className="text-stone-300">—</span>}
        </td>
        <td className="num-tabular px-2 py-1.5 text-right font-semibold">
          {semDensidade ? '—' : n(p.totalKg + p.totalKgAguardando, 1)}
        </td>
        <td className="num-tabular hidden px-2 py-1.5 text-right lg:table-cell">
          {totalL != null ? n(totalL, 1) : <span className="text-stone-300">—</span>}
        </td>
        <td className="px-2 py-1.5 text-right">
          <button
            type="button"
            onClick={onToggle}
            className="text-xs text-stone-500 underline hover:text-stone-700 dark:hover:text-stone-300"
          >
            {aberto ? 'fechar' : 'detalhar'}
          </button>
        </td>
      </tr>
      {aberto &&
        p.combinacoes.map((c, i) => (
          <tr key={i} className="bg-stone-50/60 text-xs dark:bg-stone-800/20">
            <td className="px-2 py-1 pl-6 text-stone-600 dark:text-stone-300">
              {c.cultivar} · {c.tratamento} · {c.embalagem}
            </td>
            <td className="hidden px-2 py-1 text-stone-500 lg:table-cell">
              {inteiro(c.bags + c.bagsAguardando)} bg · {inteiro(c.kgSemente + c.kgSementeAguardando)} kg semente
            </td>
            <td className="num-tabular px-2 py-1 text-right">{n(c.kg, 1)}</td>
            <td className="num-tabular px-2 py-1 text-right text-stone-500">
              {c.kgAguardando > 0 ? n(c.kgAguardando, 1) : ''}
            </td>
            <td className="num-tabular px-2 py-1 text-right">{n(c.kg + c.kgAguardando, 1)}</td>
            <td className="hidden lg:table-cell" />
            <td />
          </tr>
        ))}
    </>
  )
}
