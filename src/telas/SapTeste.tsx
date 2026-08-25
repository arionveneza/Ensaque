import { useState } from 'react'
import { supabase } from '@/lib/supabase'
import {
  entidadeDe,
  problemaNoCaminho,
  relatorioComPedido,
  resumoItem,
  tabelaDe,
  textoCelula,
  type RelatorioComPedido,
  type ResumoItem,
  type TabelaSap,
} from '@/lib/sapTeste'
import {
  Aviso,
  Botao,
  Cartao,
  Erro,
  Pagina,
  Tabela,
  Tag,
  Vazio,
  exportarCsv,
} from '@/componentes/ui'

/**
 * Laboratório do SAP — homologação (dados de teste) e, desde 12/08/2026,
 * produção também (dados REAIS da empresa, com a mesma trava de só leitura).
 *
 * Aba visível só para o usuário da lista USUARIOS_SAP_TESTE (App.tsx); a
 * Edge Function `sap-teste` recusa qualquer outro login de novo, do lado do
 * servidor. Tudo aqui é LEITURA — a função só repassa GET, em qualquer base.
 *
 * O objetivo é experimentar as consultas que vão virar a integração de
 * verdade (pedidos de venda, saldo por lote via TSI_SALDOS, itens) sem
 * PowerShell — os achados de docs/integracao-sap.md §6.4–§6.6 valem aqui.
 */

type Ambiente = 'homolog' | 'producao'

interface Resultado {
  dados: unknown
  base: string
  ambiente: Ambiente
  paginasLidas: number
  temMais: boolean
  tempoMs: number
  caminho: string
}

type RespostaSap =
  | { ok: true; dados: unknown; base: string; ambiente: Ambiente; paginasLidas: number; temMais: boolean }
  | { ok: false; erro: string }

/** Só a chamada de rede, sem tocar estado — reusada pelo `executar()` e
 *  pelo "Resumo do item". */
async function chamarSap(caminho: string, paginas: number, ambiente: Ambiente): Promise<RespostaSap> {
  const problema = problemaNoCaminho(caminho)
  if (problema) return { ok: false, erro: problema }
  try {
    const { data, error } = await supabase.functions.invoke('sap-teste', {
      body: { caminho, paginas, ambiente },
    })
    if (error) throw new Error(error.message)
    const r = data as {
      ok: boolean
      erro?: string
      sap?: unknown
      base?: string
      ambiente?: Ambiente
      dados?: unknown
      paginasLidas?: number
      temMais?: boolean
    }
    if (!r.ok) {
      return { ok: false, erro: r.erro + (r.sap ? ` — resposta do SAP: ${JSON.stringify(r.sap)}` : '') }
    }
    return {
      ok: true,
      dados: r.dados,
      base: r.base ?? 'SBOVENHOM',
      ambiente: r.ambiente ?? 'homolog',
      paginasLidas: r.paginasLidas ?? 1,
      temMais: r.temMais ?? false,
    }
  } catch (e) {
    return {
      ok: false,
      erro:
        `Falha ao chamar a Edge Function sap-teste: ${e instanceof Error ? e.message : e}. ` +
        'Ela está publicada no Supabase? Os secrets SAP_USER/SAP_PASSWORD existem?',
    }
  }
}

const PRESETS: { nome: string; caminho: string; paginas?: number }[] = [
  { nome: 'Ping (1 item)', caminho: "Items?$select=ItemCode,ItemName&$top=1" },
  {
    nome: 'Pedidos de venda abertos',
    caminho:
      "Orders?$select=DocEntry,DocNum,DocDate,CardCode,CardName,DocumentStatus&$filter=DocumentStatus eq 'bost_Open'&$orderby=DocEntry desc",
    paginas: 2,
  },
  {
    nome: 'Insumos com estoque',
    caminho:
      "Items?$select=ItemCode,ItemName,QuantityOnStock,InventoryUOM&$filter=startswith(ItemCode,'INS') and QuantityOnStock gt 0&$orderby=ItemCode",
  },
  { nome: 'Saldo por lote (TSI_SALDOS)', caminho: "SQLQueries('TSI_SALDOS')/List", paginas: 5 },
  { nome: 'Consultas salvas', caminho: 'SQLQueries?$select=SqlCode,SqlName' },
]

// quantas linhas a tabela mostra; o resto vai pelo Exportar
const LIMITE_LINHAS = 300

// tamanho de cada lote e teto de lotes do relatório por prefixo — 10×100 = até
// 1000 itens. Cada item pesa ~59KB com a coleção de depósitos (medido em
// 09/08/2026: SOJ tem 315 itens, 4 lotes, ~24MB no total); pedir tudo numa
// chamada só arrisca estourar o limite de resposta da Edge Function, então
// cada lote é uma chamada própria, acumulada aqui na tela.
const TAMANHO_LOTE = 100
const MAX_LOTES = 10

/** Tabela genérica com o aviso de colunas cortadas e o corte de linhas — usada
 *  tanto pro resultado principal quanto pras coleções aninhadas de uma entidade
 *  (ex.: ItemWarehouseInfoCollection dentro de um Items('CODIGO')). */
function TabelaResultado({ tabela }: { tabela: TabelaSap }) {
  if (tabela.linhas.length === 0) return <Vazio>Sem linhas.</Vazio>
  return (
    <>
      {tabela.colunasCortadas && (
        <div className="mb-3">
          <Aviso>
            Mostrando as primeiras {tabela.colunas.length} colunas — esta consulta traz
            muitas. Use <code>$select=Campo1,Campo2</code> para escolher.
          </Aviso>
        </div>
      )}
      <Tabela cabecalho={tabela.colunas}>
        {tabela.linhas.slice(0, LIMITE_LINHAS).map((linha, i) => (
          <tr key={i} className="border-t border-stone-100 dark:border-stone-800/60">
            {tabela.colunas.map((c) => {
              const texto = textoCelula(linha[c])
              return (
                <td key={c} className="max-w-64 truncate px-2 py-1.5" title={texto}>
                  {texto}
                </td>
              )
            })}
          </tr>
        ))}
      </Tabela>
      {tabela.linhas.length > LIMITE_LINHAS && (
        <p className="mt-2 text-xs text-stone-500">
          Mostrando {LIMITE_LINHAS} de {tabela.linhas.length} linhas — o Exportar leva todas.
        </p>
      )}
    </>
  )
}

function NumeroResumo({
  rotulo,
  valor,
  // 'auto': cor pelo sinal do PRÓPRIO valor (certo pra "saldo final", que pode
  // ser negativo ou positivo). 'critico'/'ok': cor fixa — necessário pra uma
  // contagem ou soma que é sempre má notícia mesmo sendo um número positivo
  // (ex.: "quantos itens estão negativos" é sempre exibido em vermelho).
  tom,
  titulo,
}: {
  rotulo: string
  valor: number
  tom?: 'auto' | 'critico' | 'ok'
  titulo?: string
}) {
  const cor =
    tom === 'critico'
      ? 'text-red-600 dark:text-red-400'
      : tom === 'ok'
        ? 'text-green-700 dark:text-green-400'
        : tom === 'auto'
          ? valor < 0
            ? 'text-red-600 dark:text-red-400'
            : 'text-green-700 dark:text-green-400'
          : ''
  return (
    <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800" title={titulo}>
      <p className="text-[10px] uppercase tracking-wide text-stone-500">{rotulo}</p>
      <p className={`num-tabular mt-0.5 text-2xl font-bold ${cor}`}>
        {valor.toLocaleString('pt-BR')}
      </p>
    </div>
  )
}

export default function SapTeste() {
  const [caminho, setCaminho] = useState(PRESETS[0].caminho)
  const [paginas, setPaginas] = useState(1)
  const [itemCode, setItemCode] = useState('SOJ00002')
  const [prefixo, setPrefixo] = useState('SOJ')
  // homolog por padrão sempre — trocar para produção é ação explícita de
  // quem está usando a tela, nunca o estado inicial (dados reais da empresa)
  const [ambiente, setAmbiente] = useState<Ambiente>('homolog')
  const [carregando, setCarregando] = useState(false)
  const [progresso, setProgresso] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [resultado, setResultado] = useState<Resultado | null>(null)
  const [resumo, setResumo] = useState<ResumoItem | null>(null)
  const [relatorio, setRelatorio] = useState<RelatorioComPedido | null>(null)
  const [relatorioCapAtingido, setRelatorioCapAtingido] = useState(false)
  const [criandoConsulta, setCriandoConsulta] = useState(false)
  const [criacaoResultado, setCriacaoResultado] = useState<string | null>(null)

  /**
   * Ação única: cria a TSI_SALDOS em produção via Edge Function própria
   * (`sap-criar-tsi-saldos` — POST de corpo FIXO, não é o proxy genérico; a
   * `sap-teste` continua só-leitura). Depois de criada, o preset "Saldo por
   * lote (TSI_SALDOS)" passa a funcionar também com Produção selecionada.
   */
  async function criarTsiSaldos() {
    if (criandoConsulta) return
    if (!window.confirm(
      'Criar a consulta salva TSI_SALDOS no SAP de PRODUÇÃO?\n\n' +
      'É uma ação única de configuração (um POST). Não altera nenhum dado de ' +
      'estoque/pedido — só registra a consulta (que é um SELECT) para poder ' +
      'executá-la depois, como a LotesSASaldo já é hoje.',
    )) return
    setCriandoConsulta(true)
    setCriacaoResultado(null)
    try {
      const { data, error } = await supabase.functions.invoke('sap-criar-tsi-saldos', { body: {} })
      if (error) throw new Error(error.message)
      const r = data as {
        ok: boolean
        erro?: string
        sap?: unknown
        execucao?: { ok: boolean; status: number; dados?: unknown }
      }
      if (!r.ok) {
        setCriacaoResultado(
          `FALHOU: ${r.erro}${r.sap ? ` — resposta do SAP: ${JSON.stringify(r.sap)}` : ''}`,
        )
      } else {
        const linhas = (r.execucao?.dados as { value?: unknown[] } | undefined)?.value?.length
        setCriacaoResultado(
          r.execucao?.ok
            ? `CRIADA e executada com sucesso — ${linhas ?? '?'} linha(s) de saldo na primeira página. O preset "Saldo por lote (TSI_SALDOS)" já funciona em produção.`
            : `Criada, mas a execução de teste falhou (HTTP ${r.execucao?.status}): ${JSON.stringify(r.execucao?.dados)}`,
        )
      }
    } catch (e) {
      setCriacaoResultado(
        `Falha ao chamar a Edge Function sap-criar-tsi-saldos: ${e instanceof Error ? e.message : e}. Ela está publicada no Supabase?`,
      )
    }
    setCriandoConsulta(false)
  }

  async function executar(cam: string, pags: number) {
    if (carregando) return // Enter repetido não dispara consultas concorrentes
    setCaminho(cam)
    setPaginas(pags)
    setCarregando(true)
    setErro(null)
    setResumo(null) // um resultado por vez — some os outros painéis
    setRelatorio(null)
    const inicio = performance.now()
    const r = await chamarSap(cam, pags, ambiente)
    if (!r.ok) {
      setResultado(null)
      setErro(r.erro)
    } else {
      setResultado({ ...r, tempoMs: Math.round(performance.now() - inicio), caminho: cam })
    }
    setCarregando(false)
  }

  /**
   * Resumo de um item — uma chamada a `Items('CODIGO')`. O total em pedidos
   * não soma `Orders` na mão: `$expand=DocumentLines` dá `400 "Cannot expand
   * invalid navigation property"` nesta versão do Service Layer (testado
   * em 09/08/2026); usa-se `ItemWarehouseInfoCollection[].Committed`, que o
   * próprio SAP já calcula (ver comentário de `resumoItem` em sapTeste.ts).
   */
  async function buscarResumo(codigo: string) {
    if (carregando || !codigo) return
    setCarregando(true)
    setErro(null)
    setResultado(null) // um resultado por vez — some os outros painéis
    setResumo(null)
    setRelatorio(null)

    const r = await chamarSap(`Items('${codigo}')`, 1, ambiente)
    if (!r.ok) {
      setErro(r.erro)
      setCarregando(false)
      return
    }
    const calculado = resumoItem(r.dados)
    if (!calculado) {
      setErro(`"${codigo}" não parece um item válido — confira o código.`)
    } else {
      setResumo(calculado)
    }
    setCarregando(false)
  }

  /**
   * Todos os itens de um prefixo (`SOJ`, `INS`...) que têm pedido em aberto,
   * do maior déficit pro maior excedente — o que antes só saía num script
   * avulso (09/08/2026), agora dentro do app.
   *
   * Busca em lotes de TAMANHO_LOTE via `$skip`, em vez de pedir tudo numa
   * chamada só: cada item pesa ~59KB com a coleção de depósitos (medido com
   * SOJ), e um prefixo com muitos itens numa resposta só arrisca estourar o
   * limite de tamanho da Edge Function.
   */
  async function buscarComPedido(pref: string) {
    if (carregando || !pref) return
    setCarregando(true)
    setErro(null)
    setResultado(null) // um resultado por vez — some os outros painéis
    setResumo(null)
    setRelatorio(null)
    setRelatorioCapAtingido(false)

    const todosOsItens: unknown[] = []
    let capAtingido = false
    for (let lote = 0; lote < MAX_LOTES; lote++) {
      setProgresso(`Lendo itens ${lote * TAMANHO_LOTE + 1}–${(lote + 1) * TAMANHO_LOTE}…`)
      const skip = lote * TAMANHO_LOTE
      const r = await chamarSap(
        `Items?$filter=startswith(ItemCode,'${pref}')&$orderby=ItemCode&$top=${TAMANHO_LOTE}&$skip=${skip}`,
        1,
        ambiente,
      )
      if (!r.ok) {
        setErro(r.erro)
        setCarregando(false)
        setProgresso('')
        return
      }
      const pagina = (r.dados as { value?: unknown[] } | null)?.value ?? []
      todosOsItens.push(...pagina)
      if (pagina.length < TAMANHO_LOTE) break
      if (lote === MAX_LOTES - 1) capAtingido = true
    }

    setProgresso('')
    setRelatorioCapAtingido(capAtingido)
    setRelatorio(relatorioComPedido(todosOsItens, pref))
    setCarregando(false)
  }

  const tabela = resultado ? tabelaDe(resultado.dados) : null
  // entidade única (Items('X'), Orders(4404)...) não é lista — tenta separar
  // campos escalares de coleções aninhadas antes de desistir pro JSON cru
  const entidade = resultado && !tabela ? entidadeDe(resultado.dados) : null

  return (
    <Pagina
      titulo="SAP — laboratório"
      descricao="Consultas de LEITURA, via Edge Function — nunca grava nada, em nenhuma base."
    >
      <Cartao titulo="Ambiente" className="mb-5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded-md border border-stone-300 dark:border-stone-700">
            <button
              onClick={() => setAmbiente('homolog')}
              className={`rounded-l-md px-3 py-2 text-sm font-medium sm:py-1.5 ${
                ambiente === 'homolog'
                  ? 'bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900'
                  : 'text-stone-600 dark:text-stone-300'
              }`}
            >
              Homologação (SBOVENHOM)
            </button>
            <button
              onClick={() => setAmbiente('producao')}
              className={`rounded-r-md px-3 py-2 text-sm font-medium sm:py-1.5 ${
                ambiente === 'producao'
                  ? 'bg-red-700 text-white'
                  : 'text-stone-600 dark:text-stone-300'
              }`}
            >
              Produção (SBOVENPRD)
            </button>
          </div>
          {ambiente === 'producao' && (
            <Tag cor="perigo">dados reais da empresa — só leitura</Tag>
          )}
        </div>
        <p className="mt-2 text-xs text-stone-500">
          {ambiente === 'homolog'
            ? 'Dados de teste — pode explorar sem medo de confundir com o real.'
            : 'Isto é o SAP de verdade. A Edge Function só repassa GET (nunca cria/altera/apaga nada), mas o número que aparecer aqui é o número real.'}
        </p>
      </Cartao>

      <Cartao titulo="Consultas prontas" className="mb-5">
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <Botao
              key={p.nome}
              disabled={carregando}
              onClick={() => executar(p.caminho, p.paginas ?? 1)}
            >
              {p.nome}
            </Botao>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-sm">
            <span className="mb-1 block text-xs text-stone-500">Código do item</span>
            <input
              value={itemCode}
              onChange={(e) => setItemCode(e.target.value.trim())}
              className="w-36 rounded border border-stone-300 px-2 py-2 text-sm sm:py-1.5 dark:border-stone-700 dark:bg-stone-800"
            />
          </label>
          <Botao
            variante="primario"
            disabled={carregando || !itemCode}
            onClick={() => buscarResumo(itemCode)}
            titulo="Cultivar, estoque por depósito (só os com saldo), total em pedidos abertos e saldo final"
          >
            Resumo do item
          </Botao>
          <Botao
            disabled={carregando || !itemCode}
            onClick={() => executar(`Items('${itemCode}')`, 1)}
          >
            Item completo
          </Botao>
          <Botao
            disabled={carregando || !itemCode}
            onClick={() =>
              executar(
                `BatchNumberDetails?$filter=ItemCode eq '${itemCode}'&$select=Batch,Status,ExpirationDate,U_AGRT_PMS,U_LoteTSI,U_AGRT_Safra`,
                5,
              )
            }
          >
            Lotes do item (cadastro)
          </Botao>
        </div>
      </Cartao>

      {ambiente === 'producao' && (
        <Cartao titulo="Ação única: criar TSI_SALDOS em produção" className="mb-5">
          <p className="mb-2 text-xs text-stone-500">
            A consulta de saldo por lote (join OBTN×OBTQ, mesma já validada na homologação)
            ainda não existe em SBOVENPRD — é por isso que o preset "Saldo por lote" dá
            -2028 lá. Este botão a cria <strong>uma vez</strong> (registro de configuração,
            nenhum dado de estoque é alterado) e já executa pra conferir. Se falhar com erro
            de autorização, falta o assunto "Modify SQL Queries in Service Layer" pro usuário
            de integração do SAP.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Botao variante="primario" disabled={criandoConsulta} onClick={criarTsiSaldos}>
              {criandoConsulta ? 'Criando…' : 'Criar TSI_SALDOS em produção'}
            </Botao>
          </div>
          {criacaoResultado && (
            <p className="mt-2 break-all text-xs text-stone-600 dark:text-stone-300">
              {criacaoResultado}
            </p>
          )}
        </Cartao>
      )}

      <Cartao titulo="Relatório: itens com pedido em aberto" className="mb-5">
        <p className="mb-2 text-xs text-stone-500">
          Todos os itens do prefixo com saldo × pedido (<code>Committed</code>) × saldo final,
          do maior déficit pro maior excedente. Lê em lotes de {TAMANHO_LOTE} — pode levar
          alguns segundos pra prefixos com muitos itens (SOJ tem 315).
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-sm">
            <span className="mb-1 block text-xs text-stone-500">Prefixo</span>
            <input
              value={prefixo}
              onChange={(e) => setPrefixo(e.target.value.trim().toUpperCase())}
              className="w-28 rounded border border-stone-300 px-2 py-2 text-sm sm:py-1.5 dark:border-stone-700 dark:bg-stone-800"
            />
          </label>
          <Botao
            variante="primario"
            disabled={carregando || !prefixo}
            onClick={() => buscarComPedido(prefixo)}
          >
            Itens com pedido
          </Botao>
          {carregando && progresso && (
            <span className="text-xs text-stone-500">{progresso}</span>
          )}
        </div>
      </Cartao>

      <Cartao titulo="Caminho livre (OData)" className="mb-5">
        <p className="mb-2 text-xs text-stone-500">
          O que vier depois de <code>/b1s/v1/</code> — ex.:{' '}
          <code>Items?$top=5</code> · <code>SQLQueries('TSI_SALDOS')/List</code>. Só GET.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            value={caminho}
            onChange={(e) => setCaminho(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && executar(caminho, paginas)}
            spellCheck={false}
            className="min-w-0 flex-1 rounded border border-stone-300 px-2 py-2 font-mono text-xs sm:py-1.5 dark:border-stone-700 dark:bg-stone-800"
          />
          <div className="flex items-center gap-2">
            <label className="text-xs text-stone-500">
              páginas{' '}
              <select
                value={paginas}
                onChange={(e) => setPaginas(Number(e.target.value))}
                className="rounded border border-stone-300 px-1 py-2 text-sm sm:py-1.5 dark:border-stone-700 dark:bg-stone-800"
              >
                {[1, 2, 5, 10].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
            <Botao onClick={() => executar(caminho, paginas)} disabled={carregando}>
              {carregando ? 'Consultando…' : 'Executar'}
            </Botao>
          </div>
        </div>
      </Cartao>

      {erro && <Erro>{erro}</Erro>}

      {carregando && <Vazio>{progresso || 'Consultando o SAP…'}</Vazio>}

      {!carregando && resumo && (
        <Cartao titulo={`Resumo — ${resumo.itemCode}`} className="mb-5">
          <p className="mb-4 text-sm text-stone-600 dark:text-stone-300">
            {resumo.itemName}
            {resumo.cultivar && (
              <>
                {' '}
                · cultivar <span className="font-semibold">{resumo.cultivar}</span>
              </>
            )}
            {resumo.embalagem && <> · embalagem {resumo.embalagem}</>}
            {resumo.tratado && (
              <span className="ml-2">
                <Tag cor="info">tratado</Tag>
              </span>
            )}
          </p>

          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <NumeroResumo rotulo="Saldo em estoque (total)" valor={resumo.saldoTotal} />
            <NumeroResumo
              rotulo="Em pedidos abertos"
              valor={resumo.totalPedidos}
              titulo="Soma do Committed (reservado em pedidos de venda abertos) de todos os depósitos"
            />
            <NumeroResumo rotulo="Saldo final" valor={resumo.saldoFinal} tom="auto" />
          </div>

          <p className="mb-2 text-xs font-semibold text-stone-500">
            Estoque por depósito ({resumo.porArmazem.length} com saldo)
          </p>
          {resumo.porArmazem.length === 0 ? (
            <Vazio>Nenhum depósito com saldo diferente de zero.</Vazio>
          ) : (
            <Tabela cabecalho={['Depósito', '#Saldo', '#Comprometido']}>
              {resumo.porArmazem.map((w) => (
                <tr key={w.armazem} className="border-t border-stone-100 dark:border-stone-800/60">
                  <td className="px-2 py-1.5">{w.armazem}</td>
                  <td className="num-tabular px-2 py-1.5 text-right">
                    {w.saldo.toLocaleString('pt-BR')}
                  </td>
                  <td className="num-tabular px-2 py-1.5 text-right">
                    {w.comprometido.toLocaleString('pt-BR')}
                  </td>
                </tr>
              ))}
            </Tabela>
          )}
        </Cartao>
      )}

      {!carregando && relatorio && (() => {
        const negativos = relatorio.itens.filter((i) => i.saldoFinal < 0)
        const positivos = relatorio.itens.length - negativos.length
        const faltaTotal = negativos.reduce((s, i) => s + Math.abs(i.saldoFinal), 0)
        return (
          <Cartao
            titulo={`Itens ${relatorio.prefixo}* com pedido — ${relatorio.itens.length}`}
            className="mb-5"
            acoes={
              relatorio.itens.length > 0 ? (
                <Botao
                  onClick={() =>
                    exportarCsv('itens-com-pedido', [
                      ['Item', 'Cultivar', 'Embalagem', 'Semente', 'Saldo', 'EmPedidos', 'SaldoFinal'],
                      ...relatorio.itens.map((i) => [
                        i.itemCode, i.cultivar, i.embalagem, i.tratado ? 'Tratada' : 'Branca',
                        i.saldoTotal, i.totalPedidos, i.saldoFinal,
                      ]),
                    ])
                  }
                >
                  Exportar
                </Botao>
              ) : undefined
            }
          >
            {relatorioCapAtingido && (
              <div className="mb-3">
                <Aviso>
                  Parou em {MAX_LOTES * TAMANHO_LOTE} itens lidos — pode haver mais itens
                  {' '}"{relatorio.prefixo}*" no SAP além desse teto.
                </Aviso>
              </div>
            )}
            {relatorio.ignorados > 0 && (
              <p className="mb-3 text-xs text-stone-500">
                {relatorio.ignorados} item(ns) com pedido ignorado(s) por não ter embalagem
                reconhecida (BB5M/BMB) — provavelmente matéria-prima/granel, não lote de
                cultivar.
              </p>
            )}
            {relatorio.itens.length === 0 ? (
              <Vazio>
                Nenhum item "{relatorio.prefixo}*" com pedido em aberto ({relatorio.totalLido}
                {' '}lido(s)).
              </Vazio>
            ) : (
              <>
                <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <NumeroResumo rotulo={`Itens ${relatorio.prefixo}* lidos`} valor={relatorio.totalLido} />
                  <NumeroResumo rotulo="Com saldo negativo" valor={negativos.length} tom="critico" />
                  <NumeroResumo rotulo="Com saldo positivo" valor={positivos} tom="ok" />
                  <NumeroResumo rotulo="Falta total (negativos)" valor={faltaTotal} tom="critico" />
                </div>
                <Tabela
                  cabecalho={[
                    'Item', 'Cultivar', 'Emb.', 'Semente', '#Saldo', '#Em pedidos', '#Saldo final',
                  ]}
                >
                  {relatorio.itens.map((i) => (
                    <tr
                      key={i.itemCode}
                      className={`border-t border-stone-100 dark:border-stone-800/60 ${
                        i.saldoFinal < 0
                          ? 'border-l-4 border-l-red-500'
                          : 'border-l-4 border-l-green-500'
                      }`}
                    >
                      <td className="px-2 py-1.5 font-medium whitespace-nowrap">{i.itemCode}</td>
                      <td className="px-2 py-1.5">{i.cultivar || '—'}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{i.embalagem}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{i.tratado ? 'Tratada' : 'Branca'}</td>
                      <td className="num-tabular px-2 py-1.5 text-right">
                        {i.saldoTotal.toLocaleString('pt-BR')}
                      </td>
                      <td className="num-tabular px-2 py-1.5 text-right">
                        {i.totalPedidos.toLocaleString('pt-BR')}
                      </td>
                      <td
                        className={`num-tabular px-2 py-1.5 text-right font-semibold ${
                          i.saldoFinal < 0
                            ? 'text-red-600 dark:text-red-400'
                            : 'text-green-700 dark:text-green-400'
                        }`}
                      >
                        {i.saldoFinal.toLocaleString('pt-BR')}
                      </td>
                    </tr>
                  ))}
                </Tabela>
              </>
            )}
          </Cartao>
        )
      })()}

      {!carregando && resultado && (
        <Cartao
          titulo={`Resultado — ${resultado.base}`}
          acoes={
            <>
              {resultado.ambiente === 'producao' && <Tag cor="perigo">dados reais</Tag>}
              {tabela && tabela.linhas.length > 0 && (
                <Botao
                  onClick={() =>
                    exportarCsv('sap-teste', [
                      tabela.colunas,
                      // número vai cru para o exportarCsv trocar ponto por
                      // vírgula (Excel pt-BR); nulo vira vazio (não "—", que
                      // sujaria coluna numérica); objeto vira JSON
                      ...tabela.linhas.map((l) =>
                        tabela.colunas.map((c) => {
                          const v = l[c]
                          if (v === null || v === undefined) return ''
                          if (typeof v === 'object') return textoCelula(v)
                          return v as string | number
                        }),
                      ),
                    ])
                  }
                >
                  Exportar
                </Botao>
              )}
            </>
          }
        >
          <p className="mb-2 text-xs text-stone-500">
            <code className="break-all">{resultado.caminho}</code> · {resultado.tempoMs} ms ·{' '}
            {resultado.paginasLidas} página(s)
            {tabela ? ` · ${tabela.linhas.length} linha(s)` : ''}
          </p>
          {resultado.temMais && (
            <div className="mb-3">
              <Aviso>
                Há mais páginas no SAP além do limite pedido — aumente “páginas” para trazer
                o resto.
              </Aviso>
            </div>
          )}
          {tabela ? (
            <TabelaResultado tabela={tabela} />
          ) : entidade ? (
            <div className="space-y-4">
              {entidade.campos.length > 0 && (
                <Tabela cabecalho={['Campo', 'Valor']}>
                  {entidade.campos.map(([chave, valor]) => (
                    <tr key={chave} className="border-t border-stone-100 dark:border-stone-800/60">
                      <td className="px-2 py-1.5 font-medium whitespace-nowrap">{chave}</td>
                      <td className="max-w-96 truncate px-2 py-1.5" title={textoCelula(valor)}>
                        {textoCelula(valor)}
                      </td>
                    </tr>
                  ))}
                </Tabela>
              )}
              {entidade.colecoes.map(({ nome, tabela: sub }) => (
                <div key={nome}>
                  <p className="mb-2 text-xs font-semibold text-stone-500">
                    {nome} ({sub.linhas.length})
                  </p>
                  <TabelaResultado tabela={sub} />
                </div>
              ))}
            </div>
          ) : (
            <pre className="max-h-[32rem] overflow-auto rounded bg-stone-100 p-3 text-xs dark:bg-stone-800">
              {JSON.stringify(resultado.dados, null, 2)}
            </pre>
          )}
        </Cartao>
      )}
    </Pagina>
  )
}
