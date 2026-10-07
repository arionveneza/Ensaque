import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/auth/AuthProvider'
import * as api from '@/dados/api-gerencial'
import { useRealtime } from '@/dados/useRealtime'
import { diaDeProducao } from '@/dominio/calculos'
import {
  carregamentoDaSemana, planejadoExecutado, producaoDaSemana, semanaDe, somaDiasIso,
  type CarregamentoDia, type MudancaDeDia, type OrdemPlano,
} from '@/dominio/gerencial'
import { exportarXlsx } from '@/lib/exportar'
import {
  Aviso, Botao, Cartao, Erro, Pagina, Tabela, Tag, diaCurto, inteiro, n,
} from '@/componentes/ui'

/**
 * Relatório gerencial (07/10/2026, pedido do Arion): o carregamento do dia
 * digitado pelo PCP, com o acumulado da semana (segunda a domingo), e a produção
 * planejado × executado sem a cascata apagar o que foi empurrado pra frente.
 * Domínio em src/dominio/gerencial.ts; tabela relatorio_carregamento
 * (migração gerencial.sql); recurso `gerencial` (ver/editar).
 */

const DIA_SEMANA = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom']

const INPUT_NUM =
  'w-16 rounded-md border border-stone-300 px-2 py-1 text-right text-sm dark:border-stone-700 dark:bg-stone-800'

type Rascunho = Record<'veiculos_carregados' | 'bags_carregados' | 'veiculos_descarregados' | 'veiculos_patio', string>

const CAMPOS: { chave: keyof Rascunho; inteiro: boolean }[] = [
  { chave: 'veiculos_carregados', inteiro: true },
  { chave: 'bags_carregados', inteiro: false },
  { chave: 'veiculos_descarregados', inteiro: true },
  { chave: 'veiculos_patio', inteiro: true },
]

const paraTexto = (v: number | null | undefined) => (v == null ? '' : String(v).replace('.', ','))

/** Vazio = não informado (null); inválido = undefined (bloqueia o Salvar). */
const doTexto = (t: string, soInteiro: boolean): number | null | undefined => {
  const s = t.trim()
  if (s === '') return null
  if (!(soInteiro ? /^\d+$/ : /^\d+([.,]\d{1,2})?$/).test(s)) return undefined
  return Number(s.replace(',', '.'))
}

const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : null)

function TagPct({ valor }: { valor: number | null }) {
  if (valor == null) return <span className="text-stone-400">—</span>
  return (
    <Tag cor={valor >= 90 ? 'ok' : valor >= 70 ? 'alerta' : 'perigo'} className="min-w-14 text-center">
      {n(valor, 0)}%
    </Tag>
  )
}

/** t em cima, bags · ordens embaixo; dia sem ordem nenhuma vira traço. */
function Volume({ t, bags, ordens }: { t: number; bags: number; ordens: number }) {
  if (ordens === 0) return <span className="text-stone-400">—</span>
  return (
    <>
      {n(t, 1)} t
      <span className="block text-xs text-stone-500">
        {inteiro(bags)} bg · {ordens} ord.
      </span>
    </>
  )
}

export default function Gerencial() {
  const { permitido } = useAuth()
  const podeEditar = permitido('gerencial', 'editar')
  const hoje = diaDeProducao(new Date())
  // qualquer dia da semana à vista; a semana sai dele (segunda a domingo)
  const [referencia, setReferencia] = useState(hoje)
  const dias = useMemo(() => semanaDe(referencia), [referencia])
  const de = dias[0]
  const ate = dias[6]
  const estaSemana = dias.includes(hoje)

  const [lancados, setLancados] = useState<CarregamentoDia[] | null>([])
  const [producao, setProducao] = useState<{ ordens: OrdemPlano[]; mudancas: MudancaDeDia[] } | null>(null)
  const [rascunho, setRascunho] = useState<Record<string, Rascunho>>({})
  const [salvando, setSalvando] = useState<string | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [carregando, setCarregando] = useState(true)

  const recarregarCarregamento = useCallback(async () => {
    try {
      setLancados(await api.listarCarregamento(de, ate))
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    }
  }, [de, ate])

  const recarregarProducao = useCallback(async () => {
    try {
      setProducao(await api.dadosPlanejadoExecutado(de, ate))
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    }
  }, [de, ate])

  useEffect(() => {
    let vivo = true
    setCarregando(true)
    setErro(null)
    setRascunho({})
    Promise.all([recarregarCarregamento(), recarregarProducao()]).finally(() => vivo && setCarregando(false))
    return () => { vivo = false }
  }, [recarregarCarregamento, recarregarProducao])

  useRealtime(['relatorio_carregamento'], () => void recarregarCarregamento())
  useRealtime(['ordens', 'ordem_eventos'], () => void recarregarProducao(), { agruparMs: 2000 })

  const linhas = useMemo(() => carregamentoDaSemana(dias, lancados ?? []), [dias, lancados])
  const porDia = useMemo(
    () => (producao ? planejadoExecutado(dias, producao.ordens, producao.mudancas) : []),
    [dias, producao],
  )
  const semana = useMemo(
    () => (producao ? producaoDaSemana(dias, producao.ordens, producao.mudancas) : null),
    [dias, producao],
  )

  const rascunhoDe = (l: CarregamentoDia): Rascunho =>
    rascunho[l.dia] ?? {
      veiculos_carregados: paraTexto(l.veiculos_carregados),
      bags_carregados: paraTexto(l.bags_carregados),
      veiculos_descarregados: paraTexto(l.veiculos_descarregados),
      veiculos_patio: paraTexto(l.veiculos_patio),
    }

  async function salvar(l: CarregamentoDia) {
    const r = rascunhoDe(l)
    const valores = Object.fromEntries(
      CAMPOS.map(({ chave, inteiro: so }) => [chave, doTexto(r[chave], so)]),
    ) as Record<keyof Rascunho, number | null | undefined>
    if (Object.values(valores).some((v) => v === undefined)) {
      setErro('Número inválido — veículos são inteiros; bags aceitam até 2 casas com vírgula.')
      return
    }
    setSalvando(l.dia)
    setErro(null)
    try {
      await api.salvarCarregamento({ dia: l.dia, ...(valores as Record<keyof Rascunho, number | null>) })
      setRascunho((x) => {
        const novo = { ...x }
        delete novo[l.dia]
        return novo
      })
      await recarregarCarregamento()
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    } finally {
      setSalvando(null)
    }
  }

  const totalCarr = linhas.reduce(
    (t, l) => ({
      vc: t.vc + (l.veiculos_carregados ?? 0),
      bc: t.bc + (l.bags_carregados ?? 0),
      vd: t.vd + (l.veiculos_descarregados ?? 0),
    }),
    { vc: 0, bc: 0, vd: 0 },
  )
  const ultimoPatio = [...linhas].reverse().find((l) => l.veiculos_patio != null)

  async function exportarCarregamento() {
    await exportarXlsx(
      `gerencial-carregamento-${de}-a-${ate}`,
      [
        { titulo: 'Dia', largura: 12 }, { titulo: 'Dia da semana', largura: 10 },
        { titulo: 'Veículos carregados', largura: 12, tipo: 'numero', casas: 0 },
        { titulo: 'Bags carregados', largura: 12, tipo: 'numero', casas: 2 },
        { titulo: 'Veículos descarregados', largura: 12, tipo: 'numero', casas: 0 },
        { titulo: 'Veículos no pátio', largura: 12, tipo: 'numero', casas: 0 },
        { titulo: 'Acumulado semana · veículos', largura: 14, tipo: 'numero', casas: 0 },
        { titulo: 'Acumulado semana · bags', largura: 14, tipo: 'numero', casas: 2 },
      ],
      linhas.map((l, i) => [
        l.dia, DIA_SEMANA[i], l.veiculos_carregados ?? '', l.bags_carregados ?? '',
        l.veiculos_descarregados ?? '', l.veiculos_patio ?? '', l.acumVeiculos, l.acumBags,
      ]),
    )
  }

  async function exportarProducao() {
    if (!semana) return
    await exportarXlsx(
      `gerencial-producao-${de}-a-${ate}`,
      [
        { titulo: 'Dia', largura: 12 }, { titulo: 'Dia da semana', largura: 10 },
        { titulo: 'Planejado (t)', largura: 12, tipo: 'numero', casas: 1 },
        { titulo: 'Planejado (bags)', largura: 12, tipo: 'numero', casas: 0 },
        { titulo: 'Ordens planejadas', largura: 10, tipo: 'numero', casas: 0 },
        { titulo: 'Empurrado pra frente (t)', largura: 14, tipo: 'numero', casas: 1 },
        { titulo: 'Executado (t)', largura: 12, tipo: 'numero', casas: 1 },
        { titulo: 'Executado (bags)', largura: 12, tipo: 'numero', casas: 0 },
        { titulo: 'Do planejado (t)', largura: 12, tipo: 'numero', casas: 1 },
        { titulo: 'Executado / planejado (%)', largura: 14, tipo: 'numero', casas: 0 },
        { titulo: 'Aderência ao plano (%)', largura: 14, tipo: 'numero', casas: 0 },
      ],
      [
        ...porDia.map((d, i) => [
          d.dia, DIA_SEMANA[i], d.planejadoT, d.planejadoBags, d.planejadoOrdens, d.empurradoT,
          d.executadoT, d.executadoBags, d.doPlanoT,
          pct(d.executadoT, d.planejadoT) ?? '', pct(d.doPlanoT, d.planejadoT) ?? '',
        ]),
        [
          'Semana', '', semana.planejadoT, semana.planejadoBags, semana.planejadoOrdens, '',
          semana.executadoT, semana.executadoBags, semana.doPlanoT,
          pct(semana.executadoT, semana.planejadoT) ?? '', pct(semana.doPlanoT, semana.planejadoT) ?? '',
        ],
      ],
    )
  }

  return (
    <Pagina
      titulo="Relatório gerencial"
      descricao="Carregamento lançado pelo PCP e produção planejado × executado, da segunda ao domingo."
      acoes={
        <div className="flex flex-wrap items-center gap-2">
          <Botao onClick={() => setReferencia(somaDiasIso(de, -7))}>◂ Semana anterior</Botao>
          <span className="text-sm font-medium">
            {diaCurto(de)} a {diaCurto(ate)}
          </span>
          <Botao onClick={() => setReferencia(somaDiasIso(de, 7))}>Próxima ▸</Botao>
          {!estaSemana && <Botao onClick={() => setReferencia(hoje)}>Esta semana</Botao>}
          <input
            type="date"
            value={referencia}
            onChange={(e) => e.target.value && setReferencia(e.target.value)}
            title="Ir para a semana deste dia"
            className="rounded-md border border-stone-300 px-2 py-1.5 text-sm dark:border-stone-700 dark:bg-stone-800"
          />
        </div>
      }
    >
      {erro && <Erro>{erro}</Erro>}

      {/* -------- carregamento -------- */}
      <Cartao
        titulo="Carregamento"
        acoes={<Botao onClick={() => void exportarCarregamento()}>Exportar (.xlsx)</Botao>}
        className="mb-5"
      >
        {lancados === null ? (
          <Aviso gravidade="bloqueio">
            A migração <code>supabase/gerencial.sql</code> ainda não rodou no banco.
          </Aviso>
        ) : (
          <>
            <p className="mb-2 text-xs text-stone-500 dark:text-stone-400">
              {podeEditar
                ? 'Digite os números de cada dia e clique em Salvar na linha. Campo em branco = não informado.'
                : 'Lançado pelo PCP.'}{' '}
              O acumulado soma veículos e bags carregados de segunda até o dia; veículos no pátio é a
              foto do fim do dia (não soma).
            </p>
            <Tabela
              cabecalho={[
                'Dia', '#Veículos carregados', '#Bags carregados', '#Veículos descarregados',
                '#Veículos no pátio', '#Acumulado semana', ...(podeEditar ? [''] : []),
              ]}
              rodape={
                <tr className="border-t-2 border-stone-300 font-semibold dark:border-stone-700">
                  <td className="px-2 py-2">Semana</td>
                  <td className="num-tabular px-2 py-2 text-right">{inteiro(totalCarr.vc)}</td>
                  <td className="num-tabular px-2 py-2 text-right">{n(totalCarr.bc, totalCarr.bc % 1 === 0 ? 0 : 2)}</td>
                  <td className="num-tabular px-2 py-2 text-right">{inteiro(totalCarr.vd)}</td>
                  <td className="num-tabular px-2 py-2 text-right text-xs font-normal text-stone-500">
                    {ultimoPatio ? `${inteiro(ultimoPatio.veiculos_patio)} em ${diaCurto(ultimoPatio.dia)}` : '—'}
                  </td>
                  <td />
                  {podeEditar && <td />}
                </tr>
              }
            >
              {linhas.map((l, i) => {
                const r = rascunhoDe(l)
                const sujo = rascunho[l.dia] != null
                const futuro = l.dia > hoje
                return (
                  <tr
                    key={l.dia}
                    className={`border-t border-stone-100 dark:border-stone-800/60 ${l.dia === hoje ? 'bg-green-50/60 dark:bg-green-950/30' : ''}`}
                  >
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      <span className="inline-block w-8 text-xs text-stone-500">{DIA_SEMANA[i]}</span>
                      {diaCurto(l.dia)}
                    </td>
                    {CAMPOS.map(({ chave }) => (
                      <td key={chave} className="num-tabular px-2 py-1.5 text-right">
                        {podeEditar ? (
                          <input
                            value={r[chave]}
                            inputMode="decimal"
                            disabled={futuro}
                            onChange={(e) =>
                              setRascunho((x) => ({ ...x, [l.dia]: { ...r, [chave]: e.target.value } }))
                            }
                            onKeyDown={(e) => e.key === 'Enter' && sujo && void salvar(l)}
                            className={`${INPUT_NUM} ${sujo ? 'border-amber-500' : ''} disabled:opacity-40`}
                          />
                        ) : l[chave] == null ? (
                          <span className="text-stone-400">—</span>
                        ) : (
                          n(l[chave] as number, (l[chave] as number) % 1 === 0 ? 0 : 2)
                        )}
                      </td>
                    ))}
                    <td className="num-tabular px-2 py-1.5 text-right whitespace-nowrap">
                      <b>{inteiro(l.acumVeiculos)}</b> veíc.
                      <span className="block">
                        <b>{n(l.acumBags, l.acumBags % 1 === 0 ? 0 : 2)}</b> bg
                      </span>
                    </td>
                    {podeEditar && (
                      <td className="px-2 py-1.5 text-right">
                        <Botao
                          variante={sujo ? 'primario' : 'normal'}
                          disabled={!sujo || salvando === l.dia}
                          onClick={() => void salvar(l)}
                        >
                          {salvando === l.dia ? 'Salvando…' : 'Salvar'}
                        </Botao>
                      </td>
                    )}
                  </tr>
                )
              })}
            </Tabela>
          </>
        )}
      </Cartao>

      {/* -------- produção -------- */}
      <Cartao
        titulo="Produção · planejado × executado"
        acoes={
          <Botao disabled={!semana} onClick={() => void exportarProducao()}>
            Exportar (.xlsx)
          </Botao>
        }
      >
        {carregando && !producao ? (
          <p className="text-sm text-stone-500">Carregando…</p>
        ) : !semana ? null : (
          <>
            <Tabela
              cabecalho={[
                'Dia', '#Planejado', '#Empurrado p/ frente', '#Executado', '#Do planejado',
                '#Executado / planejado', '#Aderência ao plano',
              ]}
              rodape={
                <tr className="border-t-2 border-stone-300 font-semibold dark:border-stone-700">
                  <td className="px-2 py-2">Semana</td>
                  <td className="num-tabular px-2 py-2 text-right">
                    {n(semana.planejadoT, 1)} t
                    <span className="block text-xs font-normal text-stone-500">
                      {inteiro(semana.planejadoBags)} bg · {semana.planejadoOrdens} ordens
                    </span>
                  </td>
                  <td />
                  <td className="num-tabular px-2 py-2 text-right">
                    {n(semana.executadoT, 1)} t
                    <span className="block text-xs font-normal text-stone-500">
                      {inteiro(semana.executadoBags)} bg · {semana.executadoOrdens} ordens
                    </span>
                  </td>
                  <td className="num-tabular px-2 py-2 text-right">{n(semana.doPlanoT, 1)} t</td>
                  <td className="px-2 py-2 text-right"><TagPct valor={pct(semana.executadoT, semana.planejadoT)} /></td>
                  <td className="px-2 py-2 text-right"><TagPct valor={pct(semana.doPlanoT, semana.planejadoT)} /></td>
                </tr>
              }
            >
              {porDia.map((d, i) => (
                <tr
                  key={d.dia}
                  className={`border-t border-stone-100 dark:border-stone-800/60 ${d.dia === hoje ? 'bg-green-50/60 dark:bg-green-950/30' : ''}`}
                >
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <span className="inline-block w-8 text-xs text-stone-500">{DIA_SEMANA[i]}</span>
                    {diaCurto(d.dia)}
                  </td>
                  <td className="num-tabular px-2 py-1.5 text-right">
                    <Volume t={d.planejadoT} bags={d.planejadoBags} ordens={d.planejadoOrdens} />
                  </td>
                  <td className="num-tabular px-2 py-1.5 text-right">
                    {d.empurradoT > 0 ? (
                      <span className="text-amber-700 dark:text-amber-400">
                        {n(d.empurradoT, 1)} t
                        <span className="block text-xs">{d.empurradoOrdens} ord.</span>
                      </span>
                    ) : (
                      <span className="text-stone-400">—</span>
                    )}
                  </td>
                  <td className="num-tabular px-2 py-1.5 text-right">
                    <Volume t={d.executadoT} bags={d.executadoBags} ordens={d.executadoOrdens} />
                  </td>
                  <td className="num-tabular px-2 py-1.5 text-right">
                    {d.planejadoOrdens === 0 || d.dia > hoje ? (
                      <span className="text-stone-400">—</span>
                    ) : (
                      `${n(d.doPlanoT, 1)} t`
                    )}
                  </td>
                  {/* dia que ainda não começou não tem % (seria 0% de algo que nem rodou) */}
                  <td className="px-2 py-1.5 text-right">
                    <TagPct valor={d.dia > hoje ? null : pct(d.executadoT, d.planejadoT)} />
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <TagPct valor={d.dia > hoje ? null : pct(d.doPlanoT, d.planejadoT)} />
                  </td>
                </tr>
              ))}
            </Tabela>
            <div className="mt-3 space-y-1 text-xs text-stone-500 dark:text-stone-400">
              <p>
                <b>Planejado</b>: o que está programado pro dia <b>mais o que saiu dele</b> pra um dia seguinte
                (ou voltou ao pool) depois que o dia começou, às 07:30, sem ter terminado. A reprogramação em
                cascata não apaga mais o plano: a ordem empurrada conta no dia de onde saiu (coluna{' '}
                <b>Empurrado p/ frente</b>) e no dia pra onde foi.
              </p>
              <p>
                <b>Executado</b>: tudo que terminou no dia de produção (07:30 às 03:00), inclusive o que foi
                adiantado de outro dia. <b>Do planejado</b>: das ordens do plano, as que terminaram no próprio
                dia — é a base da <b>aderência ao plano</b>.
              </p>
              <p>
                Na linha <b>Semana</b> cada ordem conta uma vez: a que foi empurrada de segunda pra terça está no
                plano dos dois dias, mas não é somada duas vezes. No meio da semana o % dela compara com o plano
                da semana inteira, inclusive os dias que ainda não chegaram.
              </p>
            </div>
          </>
        )}
      </Cartao>
    </Pagina>
  )
}
