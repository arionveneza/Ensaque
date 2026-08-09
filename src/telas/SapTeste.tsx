import { useState } from 'react'
import { supabase } from '@/lib/supabase'
import {
  entidadeDe,
  problemaNoCaminho,
  tabelaDe,
  textoCelula,
  type TabelaSap,
} from '@/lib/sapTeste'
import {
  Aviso,
  Botao,
  Cartao,
  Erro,
  Pagina,
  Tabela,
  Vazio,
  exportarCsv,
} from '@/componentes/ui'

/**
 * Laboratório do SAP em HOMOLOGAÇÃO.
 *
 * Aba visível só para o usuário da lista USUARIOS_SAP_TESTE (App.tsx); a
 * Edge Function `sap-teste` recusa qualquer outro login de novo, do lado do
 * servidor. Tudo aqui é LEITURA — a função só repassa GET.
 *
 * O objetivo é experimentar as consultas que vão virar a integração de
 * verdade (pedidos de venda, saldo por lote via TSI_SALDOS, itens) sem
 * PowerShell — os achados de docs/integracao-sap.md §6.4–§6.6 valem aqui.
 */

interface Resultado {
  dados: unknown
  base: string
  paginasLidas: number
  temMais: boolean
  tempoMs: number
  caminho: string
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

export default function SapTeste() {
  const [caminho, setCaminho] = useState(PRESETS[0].caminho)
  const [paginas, setPaginas] = useState(1)
  const [itemCode, setItemCode] = useState('SOJ00002')
  const [carregando, setCarregando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [resultado, setResultado] = useState<Resultado | null>(null)

  async function executar(cam: string, pags: number) {
    if (carregando) return // Enter repetido não dispara consultas concorrentes
    const problema = problemaNoCaminho(cam)
    if (problema) {
      setErro(problema)
      setResultado(null) // não deixa o resultado anterior parecer o desta tentativa
      return
    }
    setCaminho(cam)
    setPaginas(pags)
    setCarregando(true)
    setErro(null)
    const inicio = performance.now()
    try {
      const { data, error } = await supabase.functions.invoke('sap-teste', {
        body: { caminho: cam, paginas: pags },
      })
      if (error) throw new Error(error.message)
      const r = data as {
        ok: boolean
        erro?: string
        sap?: unknown
        base?: string
        dados?: unknown
        paginasLidas?: number
        temMais?: boolean
      }
      if (!r.ok) {
        setResultado(null)
        setErro(r.erro + (r.sap ? ` — resposta do SAP: ${JSON.stringify(r.sap)}` : ''))
        return
      }
      setResultado({
        dados: r.dados,
        base: r.base ?? 'SBOVENHOM',
        paginasLidas: r.paginasLidas ?? 1,
        temMais: r.temMais ?? false,
        tempoMs: Math.round(performance.now() - inicio),
        caminho: cam,
      })
    } catch (e) {
      setResultado(null)
      setErro(
        `Falha ao chamar a Edge Function sap-teste: ${e instanceof Error ? e.message : e}. ` +
          'Ela está publicada no Supabase? Os secrets SAP_USER/SAP_PASSWORD existem?',
      )
    } finally {
      setCarregando(false)
    }
  }

  const tabela = resultado ? tabelaDe(resultado.dados) : null
  // entidade única (Items('X'), Orders(4404)...) não é lista — tenta separar
  // campos escalares de coleções aninhadas antes de desistir pro JSON cru
  const entidade = resultado && !tabela ? entidadeDe(resultado.dados) : null

  return (
    <Pagina
      titulo="SAP — laboratório"
      descricao="Consultas de LEITURA na base de homologação (SBOVENHOM), via Edge Function. Dados de teste — não é a produção."
    >
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

      {carregando && <Vazio>Consultando o SAP…</Vazio>}

      {!carregando && resultado && (
        <Cartao
          titulo={`Resultado — ${resultado.base}`}
          acoes={
            tabela && tabela.linhas.length > 0 ? (
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
            ) : undefined
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
