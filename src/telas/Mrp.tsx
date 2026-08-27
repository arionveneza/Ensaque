import { useEffect, useMemo, useState, type ChangeEvent } from 'react'
import readXlsxFile from 'read-excel-file/browser'
import * as g from '@/dados/api-gestao'
import type {
  BalancoLinha, EmbalagemLinha, EstoquePaLinha, EstoqueQuimicoLinha, ReceitaCompleta,
} from '@/dados/api-gestao'
import {
  calcularMrp, chaveCombinacao, conferirCadastro, cruzarEstoqueQuimico,
  estoqueSapPorCombinacao, PESO_REF_BAG_KG,
  type EstoqueCruzado, type NecessidadeProduto,
} from '@/dominio/mrp'
import {
  ARMAZEM_QUIMICOS, converterQuimicos, ehRelatorioQuimicos, type ResultadoQuimicos,
} from '@/dominio/importacao/quimicos'
import type { Linha } from '@/dominio/importacao/simpleagro'
import { useAuth } from '@/auth/AuthProvider'
import { useRealtime } from '@/dados/useRealtime'
import { exportarXlsx } from '@/lib/exportar'
import {
  Aviso, Botao, Cartao, Erro, Pagina, Tabela, Tag, Vazio, dataHoraCurta, inteiro, n,
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
  const { usuario, permitido } = useAuth()
  const podeImportar = permitido('mrp', 'importar')
  const [balanco, setBalanco] = useState<BalancoLinha[]>([])
  const [receitas, setReceitas] = useState<ReceitaCompleta[]>([])
  const [embalagens, setEmbalagens] = useState<EmbalagemLinha[]>([])
  const [estoquePa, setEstoquePa] = useState<EstoquePaLinha[]>([])
  const [estoqueQuimicos, setEstoqueQuimicos] = useState<
    { itens: EstoqueQuimicoLinha[]; criadaEm: string } | null
  >(null)
  const [previaQuimicos, setPreviaQuimicos] = useState<ResultadoQuimicos | null>(null)
  const [importando, setImportando] = useState(false)
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)
  const [aberto, setAberto] = useState<string | null>(null)

  const recarregar = () =>
    Promise.all([
      g.listarBalanco(), g.listarReceitas(), g.listarEmbalagens(), g.listarEstoquePa(),
      g.listarEstoqueQuimicos(),
    ])
      .then(([b, r, e, pa, eq]) => {
        setBalanco(b)
        setReceitas(r)
        setEmbalagens(e)
        setEstoquePa(pa)
        setEstoqueQuimicos(eq)
        setErro(null)
      })
      .catch((x) => setErro(x instanceof Error ? x.message : String(x)))

  useEffect(() => {
    recarregar().finally(() => setCarregando(false))
  }, [])
  useRealtime(
    ['ordens', 'pedidos_venda', 'estoque_pa', 'receitas', 'estoque_quimicos'],
    () => void recarregar(),
  )

  async function lerPlanilhaQuimicos(ev: ChangeEvent<HTMLInputElement>) {
    const arquivo = ev.target.files?.[0]
    ev.target.value = ''
    if (!arquivo) return
    setErro(null)
    setPreviaQuimicos(null)
    try {
      const bruto = (await readXlsxFile(arquivo)) as unknown
      const arr = bruto as { data?: Linha[] }[]
      const linhas =
        Array.isArray(arr) && arr.length > 0 && !Array.isArray(arr[0]) && Array.isArray(arr[0]?.data)
          ? (arr[0].data as Linha[])
          : (bruto as Linha[])
      if (!ehRelatorioQuimicos(linhas)) {
        throw new Error(
          'Não parece o export de químicos do SAP — esperava as colunas "Nº do item", "Descrição do Item", "Cód. Armazém" e "Qtd em Estoque".',
        )
      }
      setPreviaQuimicos(converterQuimicos(linhas))
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    }
  }

  async function confirmarImportacaoQuimicos() {
    if (!previaQuimicos || !usuario) return
    setImportando(true)
    setErro(null)
    try {
      await g.importarEstoqueQuimicos(previaQuimicos.itens, usuario.id)
      setPreviaQuimicos(null)
      await recarregar()
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    } finally {
      setImportando(false)
    }
  }

  const mrp = useMemo(
    () => calcularMrp(balanco, receitas, embalagens),
    [balanco, receitas, embalagens],
  )
  const conferencia = useMemo(() => conferirCadastro(balanco, receitas), [balanco, receitas])
  const estoqueSap = useMemo(() => estoqueSapPorCombinacao(estoquePa), [estoquePa])

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
        { titulo: 'Em estoque', largura: 14, tipo: 'numero' },
        { titulo: 'Unid. estoque', largura: 12 },
        { titulo: 'Saldo (firme)', largura: 14, tipo: 'numero' },
        { titulo: 'Saldo (total)', largura: 14, tipo: 'numero' },
        { titulo: 'Falta comprar (firme)', largura: 18, tipo: 'numero' },
        { titulo: 'Falta comprar (total)', largura: 18, tipo: 'numero' },
      ],
      mrp.produtos.map((p) => {
        const cz = estoqueQuimicos ? cruzarEstoqueQuimico(p, estoqueQuimicos.itens) : null
        return [
          p.nome,
          p.codigo,
          p.unidade,
          arred(p.totalKg),
          arred(p.totalKgAguardando),
          arred(p.totalKg + p.totalKgAguardando),
          p.totalL != null ? arred(p.totalL) : '',
          p.totalLAguardando != null ? arred(p.totalLAguardando) : '',
          cz?.disponivel != null ? arred(cz.disponivel) : '',
          cz ? cz.unidadeComparacao : '',
          cz?.saldoFirme != null ? arred(cz.saldoFirme) : '',
          cz?.saldoTotal != null ? arred(cz.saldoTotal) : '',
          cz ? arred(cz.faltaFirme) : '',
          cz ? arred(cz.faltaTotal) : '',
        ]
      }),
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

      {/* -------- estoque de químicos (upload do SAP) -------- */}
      <Cartao
        titulo="Estoque de químicos (SAP)"
        acoes={
          podeImportar ? (
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-stone-300 px-3 py-2 text-sm font-medium hover:bg-stone-100 sm:py-1.5 dark:border-stone-700 dark:hover:bg-stone-800">
              Carregar planilha (.xlsx)
              <input type="file" accept=".xlsx,.xls" className="hidden" onChange={lerPlanilhaQuimicos} />
            </label>
          ) : undefined
        }
        className="mb-5"
      >
        {previaQuimicos ? (
          <>
            <Aviso gravidade="alerta">
              <b>Prévia — nada foi gravado ainda.</b> {previaQuimicos.itens.length} item(ns) do
              armazém {ARMAZEM_QUIMICOS} ({inteiro(previaQuimicos.linhasLidas)} linhas lidas,{' '}
              {inteiro(previaQuimicos.linhasOutrosArmazens)} de outros armazéns ignoradas).
              Confirmar substitui a carga vigente.
            </Aviso>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {previaQuimicos.itens.slice(0, 10).map((i) => (
                <Tag key={`${i.codigo_sap}|${i.unidade}`} cor="neutro">
                  {i.nome}: {n(i.quantidade, 1)} {i.unidade}
                </Tag>
              ))}
              {previaQuimicos.itens.length > 10 && (
                <Tag cor="neutro">+{previaQuimicos.itens.length - 10} item(ns)</Tag>
              )}
            </div>
            <div className="mt-3 flex gap-2">
              <Botao variante="primario" disabled={importando} onClick={confirmarImportacaoQuimicos}>
                {importando ? 'gravando…' : `Confirmar importação (${previaQuimicos.itens.length} itens)`}
              </Botao>
              <Botao onClick={() => setPreviaQuimicos(null)}>Cancelar</Botao>
            </div>
          </>
        ) : estoqueQuimicos ? (
          <p className="text-sm text-stone-600 dark:text-stone-300">
            Carga vigente de <b>{dataHoraCurta(estoqueQuimicos.criadaEm)}</b> —{' '}
            {estoqueQuimicos.itens.length} item(ns) do armazém {ARMAZEM_QUIMICOS}. As colunas
            "Em estoque" e "Falta comprar" abaixo cruzam com esta carga; suba a planilha de
            novo pra atualizar.
          </p>
        ) : (
          <p className="text-sm text-stone-500 dark:text-stone-400">
            Nenhuma carga importada ainda. Suba o export de estoque de insumos do SAP
            (Quimicos.xlsx) — só o armazém {ARMAZEM_QUIMICOS} entra na conta — pra ver
            "Em estoque" e "Falta comprar" na tabela abaixo.
          </p>
        )}
      </Cartao>

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
              '#Em estoque', '#Saldo', '#Falta comprar',
              '',
            ]}
          >
            {mrp.produtos.map((p) => (
              <ProdutoLinhas
                key={p.codigo}
                produto={p}
                cruzado={estoqueQuimicos ? cruzarEstoqueQuimico(p, estoqueQuimicos.itens) : null}
                aberto={aberto === p.codigo}
                onToggle={() => setAberto(aberto === p.codigo ? null : p.codigo)}
              />
            ))}
          </Tabela>
        )}
        <p className="mt-2 text-xs text-stone-500">
          A coluna Aguardando é o ADICIONAL caso os pedidos pendentes de liberação
          financeira aprovem (sobra de estoque já abatida). "Em estoque" vem da carga de
          químicos do SAP acima (armazém {ARMAZEM_QUIMICOS}, casado pelo nome do produto):
          líquido compara em LITROS, pó em KG. "Saldo" é estoque − necessário total, com
          sinal (positivo sobra, negativo falta); "Falta comprar" é sobre a parcela firme,
          com o "c/ aguardando" embaixo incluindo o pendente.
        </p>
      </Cartao>

      {/* -------- cadastro × pedidos, nos dois sentidos -------- */}
      <div className="mb-5 grid gap-5 lg:grid-cols-2">
        <Cartao titulo={`Pedidos sem receita cadastrada (${conferencia.pedidosSemReceita.length})`}>
          {conferencia.pedidosSemReceita.length === 0 ? (
            <Vazio>Todo tratamento vendido tem receita cadastrada.</Vazio>
          ) : (
            <>
              <p className="mb-3 text-sm text-stone-500 dark:text-stone-400">
                O comercial vendeu estes códigos, mas a produção não tem a receita — o
                pedido não vira ordem enquanto o cadastro não existir.
              </p>
              <Tabela cabecalho={['Tratamento', '#Aprovado (bg)', '#Aguardando (bg)']}>
                {conferencia.pedidosSemReceita.map((t) => (
                  <tr key={t.tratamento} className="border-t border-stone-100 dark:border-stone-800/60">
                    <td className="px-2 py-1.5 font-medium">
                      {t.tratamento}
                      <span className="ml-1.5"><Tag cor="perigo">sem receita</Tag></span>
                    </td>
                    <td className="num-tabular px-2 py-1.5 text-right">
                      {t.bagsAprovado > 0 ? inteiro(t.bagsAprovado) : <span className="text-stone-300">—</span>}
                    </td>
                    <td className="num-tabular px-2 py-1.5 text-right text-stone-500">
                      {t.bagsPendente > 0 ? inteiro(t.bagsPendente) : <span className="text-stone-300">—</span>}
                    </td>
                  </tr>
                ))}
              </Tabela>
            </>
          )}
        </Cartao>

        <Cartao titulo={`Receitas cadastradas sem pedido (${conferencia.receitasSemPedido.length})`}>
          {conferencia.receitasSemPedido.length === 0 ? (
            <Vazio>Toda receita cadastrada tem pedido na carga vigente.</Vazio>
          ) : (
            <>
              <p className="mb-3 text-sm text-stone-500 dark:text-stone-400">
                Cadastradas, mas sem nenhum pedido (aprovado ou aguardando) na carga
                vigente — só informativo: pode ser fora de época ou código que mudou.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {conferencia.receitasSemPedido.map((nome) => (
                  <Tag key={nome} cor="neutro">{nome}</Tag>
                ))}
              </div>
            </>
          )}
        </Cartao>
      </div>

      {/* -------- combinações que entraram na conta -------- */}
      <Cartao titulo={`Demanda coberta pela conta (${mrp.combinacoes.length})`}>
        {mrp.combinacoes.length === 0 ? (
          <Vazio>Nenhuma combinação descoberta com receita cadastrada.</Vazio>
        ) : (
          <>
            {/* a equação inteira, coluna a coluna — só a "falta" parecia
                número errado pra quem procurava o pedido (achado do Arion,
                27/08/2026: "tenho de pedido firme 45 bags e aí aparece 0",
                quando os 45 já estavam cobertos por 45 em estoque) */}
            <Tabela
              cabecalho={[
                'Cultivar', 'Tratamento', 'Emb.',
                '#Pedido firme (bg)', '#Pedido aguard. (bg)',
                '#Estoque SAP (bg)',
                { texto: '#Ordens abertas (bg)', className: 'hidden lg:table-cell' },
                '#Falta produzir (bg)', '#Falta se aprovar (bg)',
              ]}
            >
              {mrp.combinacoes.map((c, i) => {
                // estoque de OUTRA embalagem da mesma combinação, se houver —
                // fora da equação desta linha, mas é estoque da combinação
                const somaCombinacao = estoqueSap.get(chaveCombinacao(c.cultivar, c.tratamento)) ?? 0
                const outrasEmb = Math.max(0, somaCombinacao - c.estoquePa)
                return (
                  <tr key={i} className="border-t border-stone-100 dark:border-stone-800/60">
                    <td className="px-2 py-1.5">{c.cultivar}</td>
                    <td className="px-2 py-1.5">{c.tratamento}</td>
                    <td className="px-2 py-1.5">{c.embalagem}</td>
                    <td className="num-tabular px-2 py-1.5 text-right">
                      {c.pedidoAprovado > 0 ? inteiro(c.pedidoAprovado) : <span className="text-stone-300">—</span>}
                    </td>
                    <td className="num-tabular px-2 py-1.5 text-right text-stone-500">
                      {c.pedidoPendente > 0 ? inteiro(c.pedidoPendente) : <span className="text-stone-300">—</span>}
                    </td>
                    <td className="num-tabular px-2 py-1.5 text-right">
                      {c.estoquePa > 0 ? inteiro(c.estoquePa) : <span className="text-stone-300">—</span>}
                      {outrasEmb > 0 && (
                        <span
                          className="ml-1 text-xs text-stone-400"
                          title="Estoque da mesma combinação em outra embalagem — fora da conta desta linha"
                        >
                          +{inteiro(outrasEmb)}
                        </span>
                      )}
                    </td>
                    <td className="num-tabular hidden px-2 py-1.5 text-right text-stone-500 lg:table-cell">
                      {c.ordensAbertas > 0 ? inteiro(c.ordensAbertas) : <span className="text-stone-300">—</span>}
                    </td>
                    <td className="num-tabular px-2 py-1.5 text-right font-semibold">
                      {c.bags > 0 ? inteiro(c.bags) : <span className="text-stone-300">—</span>}
                    </td>
                    <td className="num-tabular px-2 py-1.5 text-right text-stone-500">
                      {c.bagsAguardando > 0 ? inteiro(c.bagsAguardando) : <span className="text-stone-300">—</span>}
                    </td>
                  </tr>
                )
              })}
            </Tabela>
            <p className="mt-2 text-xs text-stone-500">
              Falta produzir = pedido firme − estoque SAP − ordens abertas (é o que puxa
              químico na tabela acima). "Falta se aprovar" é o adicional caso o pedido
              aguardando liberação financeira aprove, já abatendo sobra de estoque. Estoque
              SAP = produto JÁ TRATADO (estoque PA da última carga de saldos); o "+N" é
              estoque da mesma combinação em outra embalagem, fora da conta desta linha.
            </p>
          </>
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
  produto: p, cruzado, aberto, onToggle,
}: {
  produto: NecessidadeProduto
  /** Cruzamento com o estoque de químicos do SAP — null sem carga importada. */
  cruzado: EstoqueCruzado | null
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
        <td className="num-tabular px-2 py-1.5 text-right whitespace-nowrap">
          {cruzado == null ? (
            <span className="text-stone-300" title="Suba a planilha de químicos do SAP no cartão acima">—</span>
          ) : cruzado.incompativel ? (
            <Tag cor="alerta">unid. SAP incompatível</Tag>
          ) : cruzado.disponivel == null ? (
            <Tag cor="alerta">não achei no SAP</Tag>
          ) : (
            <span title={cruzado.nomesSap.join(' + ')}>
              {n(cruzado.disponivel, 1)} {cruzado.unidadeComparacao}
            </span>
          )}
        </td>
        <td className="num-tabular px-2 py-1.5 text-right whitespace-nowrap">
          {cruzado == null || cruzado.saldoTotal == null ? (
            <span className="text-stone-300">—</span>
          ) : (
            <>
              <span
                className={
                  cruzado.saldoTotal < 0
                    ? 'font-semibold text-red-600 dark:text-red-400'
                    : 'font-medium text-green-700 dark:text-green-400'
                }
              >
                {cruzado.saldoTotal >= 0 ? '+' : ''}
                {n(cruzado.saldoTotal, 1)} {cruzado.unidadeComparacao}
              </span>
              {cruzado.saldoFirme != null && cruzado.saldoFirme !== cruzado.saldoTotal && (
                <p className="text-xs font-normal text-stone-500">
                  só firme: {cruzado.saldoFirme >= 0 ? '+' : ''}
                  {n(cruzado.saldoFirme, 1)}
                </p>
              )}
            </>
          )}
        </td>
        <td className="num-tabular px-2 py-1.5 text-right whitespace-nowrap">
          {cruzado == null || cruzado.disponivel == null ? (
            <span className="text-stone-300">—</span>
          ) : cruzado.faltaFirme > 0 ? (
            <>
              <span className="font-semibold text-red-600 dark:text-red-400">
                {n(cruzado.faltaFirme, 1)} {cruzado.unidadeComparacao}
              </span>
              {cruzado.faltaTotal > cruzado.faltaFirme && (
                <p className="text-xs font-normal text-stone-500">
                  c/ aguard.: {n(cruzado.faltaTotal, 1)} {cruzado.unidadeComparacao}
                </p>
              )}
            </>
          ) : cruzado.faltaTotal > 0 ? (
            <>
              <span className="font-medium text-green-700 dark:text-green-400">cobre o firme</span>
              <p className="text-xs font-normal text-amber-700 dark:text-amber-400">
                c/ aguard.: falta {n(cruzado.faltaTotal, 1)} {cruzado.unidadeComparacao}
              </p>
            </>
          ) : (
            <span className="font-medium text-green-700 dark:text-green-400">cobre tudo</span>
          )}
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
            <td />
            <td />
            <td />
          </tr>
        ))}
    </>
  )
}
