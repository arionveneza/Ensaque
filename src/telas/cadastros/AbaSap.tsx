import { useState } from 'react'
import * as sap from '@/dados/sap'
import type { LoteSap, PedidoSap, SementeSap } from '@/dados/sap'
import { useAuth } from '@/auth/AuthProvider'
import { Aviso, Botao, Cartao, Erro, Tabela, Tag, Vazio, inteiro, n } from '@/componentes/ui'

/**
 * Leitura do SAP. Nesta fase serve para conferência: o cadastro de lotes do
 * TSI continua vindo da planilha de Saldos da SimpleAgro. Comparar as duas
 * fontes aqui é o que vai dar confiança para, na fase 2, trocar a origem.
 */
export default function AbaSap() {
  const { usuario } = useAuth()
  const ehGestor = usuario?.perfil === 'Gestor'

  const [sementes, setSementes] = useState<SementeSap[] | null>(null)
  const [pedidos, setPedidos] = useState<PedidoSap[] | null>(null)
  const [lotes, setLotes] = useState<{ item: string; lista: LoteSap[] } | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState(false)
  const [busca, setBusca] = useState('')

  async function acao(rotulo: string, fn: () => Promise<void>) {
    setErro(null)
    setStatus(rotulo)
    setOcupado(true)
    try {
      await fn()
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    } finally {
      setOcupado(false)
      setStatus(null)
    }
  }

  const filtradas = (sementes ?? []).filter(
    (s) =>
      !busca.trim() ||
      `${s.itemCode} ${s.nome}`.toLowerCase().includes(busca.trim().toLowerCase()),
  )

  return (
    <>
      <div className="mb-4">
        <Aviso>
          Integração <b>somente leitura</b>. O SAP é a fonte de verdade do estoque; o
          apontamento de tratamento continua gravando no Supabase. Escrita no SAP — baixa de
          granel e entrada de sacos — fica para a fase 2.
        </Aviso>
      </div>

      {erro && <Erro>{erro}</Erro>}

      <Cartao
        titulo="Conexão"
        acoes={
          <Botao
            disabled={ocupado}
            onClick={() =>
              acao('testando conexão…', async () => {
                const r = await sap.pingSap()
                setStatus(null)
                setErro(null)
                alert(`SAP ${r.sap} · base ${r.base}`)
              })
            }
          >
            Testar conexão
          </Botao>
        }
        className="mb-5"
      >
        <p className="text-sm text-stone-500">
          O navegador não fala com o SAP: a chamada passa pela Edge Function{' '}
          <code>sap</code>, que guarda usuário e senha como secrets do projeto e reaproveita a
          sessão do Service Layer.
        </p>
        {status && <p className="mt-2 text-sm text-stone-500">{status}</p>}
      </Cartao>

      <Cartao
        titulo={`Sementes com estoque no SAP${sementes ? ` (${filtradas.length})` : ''}`}
        acoes={
          <>
            {sementes && (
              <input
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder="buscar item ou nome…"
                className="rounded-md border border-stone-300 px-2 py-1 text-sm dark:border-stone-700 dark:bg-stone-800"
              />
            )}
            <Botao
              variante="primario"
              disabled={ocupado}
              onClick={() =>
                acao('consultando o SAP…', async () => {
                  setSementes(await sap.sementesComEstoque())
                  setLotes(null)
                })
              }
            >
              {sementes ? 'Atualizar' : 'Carregar do SAP'}
            </Botao>
          </>
        }
        className="mb-5"
      >
        {sementes == null ? (
          <Vazio>
            Nenhuma consulta feita ainda. O filtro traz itens com código iniciando em{' '}
            <code>SOJ</code> e saldo maior que zero.
          </Vazio>
        ) : filtradas.length === 0 ? (
          <Vazio>Nenhum item corresponde à busca.</Vazio>
        ) : (
          <Tabela cabecalho={['Item', 'Descrição', '#Estoque', '#Grupo', '']}>
            {filtradas.map((s) => (
              <tr
                key={s.itemCode}
                className="border-t border-stone-100 dark:border-stone-800/60"
              >
                <td className="px-2 py-1.5 font-medium">{s.itemCode}</td>
                <td className="px-2 py-1.5">{s.nome}</td>
                <td className="num-tabular px-2 py-1.5 text-right">{n(s.estoque, 0)}</td>
                <td className="num-tabular px-2 py-1.5 text-right text-stone-400">
                  {s.grupo ?? '—'}
                </td>
                <td className="px-2 py-1.5 text-right">
                  <button
                    disabled={ocupado}
                    onClick={() =>
                      acao('buscando lotes…', async () => {
                        setLotes({ item: s.itemCode, lista: await sap.lotesDoItem(s.itemCode) })
                      })
                    }
                    className="text-xs underline disabled:opacity-40"
                  >
                    ver lotes
                  </button>
                </td>
              </tr>
            ))}
          </Tabela>
        )}
      </Cartao>

      <Cartao
        titulo={`Pedidos de venda em aberto${pedidos ? ` (${pedidos.length} linhas)` : ''}`}
        acoes={
          <>
            {ehGestor && !pedidos && (
              <Botao
                disabled={ocupado}
                titulo="Cria a consulta salva no SAP. Roda uma vez; não altera dado de negócio."
                onClick={() =>
                  acao('registrando a consulta no SAP…', async () => {
                    const r = await sap.registrarConsultaPedidos()
                    alert(
                      r.jaExistia
                        ? `A consulta ${r.codigo} já existia no SAP — nada foi alterado.`
                        : `Consulta ${r.codigo} registrada no SAP.`,
                    )
                  })
                }
              >
                Registrar consulta
              </Botao>
            )}
            <Botao
              variante="primario"
              disabled={ocupado}
              onClick={() =>
                acao('consultando pedidos…', async () => {
                  setPedidos(await sap.pedidosVenda())
                })
              }
            >
              {pedidos ? 'Atualizar' : 'Carregar pedidos'}
            </Botao>
          </>
        }
        className="mb-5"
      >
        {pedidos == null ? (
          <Vazio>
            Substitui o relatório de pedidos da SimpleAgro. Exige a consulta{' '}
            <code>TSI_PEDIDOS</code> registrada no SAP — o botão ao lado faz isso uma vez.
          </Vazio>
        ) : pedidos.length === 0 ? (
          <Vazio>Nenhum pedido de venda em aberto.</Vazio>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap gap-4 text-sm text-stone-500">
              <span>
                <b className="text-stone-800 dark:text-stone-200">
                  {inteiro(pedidos.reduce((a, p) => a + Number(p.QuantidadePendente ?? 0), 0))}
                </b>{' '}
                em quantidade pendente
              </span>
              <span>
                <b className="text-stone-800 dark:text-stone-200">
                  {new Set(pedidos.map((p) => p.Tratamento).filter(Boolean)).size}
                </b>{' '}
                códigos de tratamento distintos
              </span>
              <span>
                <b className="text-stone-800 dark:text-stone-200">
                  {pedidos.filter((p) => !p.Tratamento).length}
                </b>{' '}
                linhas sem tratamento
              </span>
            </div>
            <Tabela
              cabecalho={['PV', 'Cliente', 'Item', 'Descrição', 'Tratamento',
                '#Qtd', '#Pendente', 'Situação']}
            >
              {pedidos.slice(0, 200).map((p, i) => (
                <tr key={i} className="border-t border-stone-100 dark:border-stone-800/60">
                  <td className="px-2 py-1.5 font-medium">{p.PV}</td>
                  <td className="max-w-40 truncate px-2 py-1.5">{p.NomePN ?? '—'}</td>
                  <td className="px-2 py-1.5">{p.CodItem}</td>
                  <td className="max-w-48 truncate px-2 py-1.5">{p.DescricaoItem}</td>
                  <td className="px-2 py-1.5">
                    {p.Tratamento ? (
                      <Tag cor="info">{p.Tratamento}</Tag>
                    ) : (
                      <span className="text-stone-400">—</span>
                    )}
                  </td>
                  <td className="num-tabular px-2 py-1.5 text-right">
                    {n(Number(p.Quantidade ?? 0), 0)}
                  </td>
                  <td className="num-tabular px-2 py-1.5 text-right font-medium">
                    {n(Number(p.QuantidadePendente ?? 0), 0)}
                  </td>
                  <td className="px-2 py-1.5 text-xs text-stone-500">
                    {p.SituacaoPedido ?? '—'}
                  </td>
                </tr>
              ))}
            </Tabela>
            {pedidos.length > 200 && (
              <p className="mt-3 text-xs text-stone-500">
                Mostrando as 200 primeiras de {pedidos.length} linhas.
              </p>
            )}
          </>
        )}
      </Cartao>

      {lotes && (
        <Cartao
          titulo={`Lotes de ${lotes.item} (${lotes.lista.length})`}
          acoes={<Botao onClick={() => setLotes(null)}>Fechar</Botao>}
        >
          {lotes.lista.length === 0 ? (
            <Vazio>Este item não tem lotes registrados no SAP.</Vazio>
          ) : (
            <Tabela cabecalho={['Lote', '#Quantidade', 'Fabricação', 'Validade']}>
              {lotes.lista.map((l) => {
                const vencido = l.validade != null && new Date(l.validade) < new Date()
                return (
                  <tr
                    key={l.numero}
                    className="border-t border-stone-100 dark:border-stone-800/60"
                  >
                    <td className="px-2 py-1.5 font-medium">{l.numero}</td>
                    <td className="num-tabular px-2 py-1.5 text-right">
                      {inteiro(l.quantidade)}
                    </td>
                    <td className="px-2 py-1.5">
                      {l.fabricacao ? l.fabricacao.slice(0, 10).split('-').reverse().join('/') : '—'}
                    </td>
                    <td className="px-2 py-1.5">
                      {l.validade ? (
                        <>
                          {l.validade.slice(0, 10).split('-').reverse().join('/')}
                          {vencido && (
                            <span className="ml-2">
                              <Tag cor="perigo">vencido</Tag>
                            </span>
                          )}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                )
              })}
            </Tabela>
          )}
        </Cartao>
      )}
    </>
  )
}
