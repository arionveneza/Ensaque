import { useCallback, useEffect, useState } from 'react'
import * as sap from '@/dados/sap'
import type { ConsultaSap, LinhaResultado, LoteSap, SementeSap } from '@/dados/sap'
import { useAuth } from '@/auth/AuthProvider'
import {
  Aviso, Botao, Cartao, Erro, Tabela, Tag, Vazio, inteiro, n,
} from '@/componentes/ui'
import { exportarXlsx } from '@/lib/exportar'

const INPUT =
  'w-full rounded-md border border-stone-300 px-2 py-1.5 text-sm dark:border-stone-700 dark:bg-stone-800'

/**
 * Leitura do SAP e gerenciamento das consultas salvas.
 *
 * O SQL fica no Supabase (editável, com histórico de quem mexeu) e é enviado
 * ao Service Layer sob demanda. Assim dá para ajustar uma consulta sem
 * publicar a Edge Function de novo.
 */
export default function AbaSap() {
  const { usuario } = useAuth()
  const ehGestor = usuario?.perfil === 'Gestor'

  const [consultas, setConsultas] = useState<ConsultaSap[]>([])
  const [resultado, setResultado] = useState<{ codigo: string; linhas: LinhaResultado[] } | null>(null)
  const [sementes, setSementes] = useState<SementeSap[] | null>(null)
  const [lotes, setLotes] = useState<{ item: string; lista: LoteSap[] } | null>(null)
  const [editando, setEditando] = useState<ConsultaSap | 'nova' | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState(false)

  const recarregar = useCallback(async () => {
    setConsultas(await sap.listarConsultas())
  }, [])

  useEffect(() => {
    recarregar().catch((e) => setErro(e instanceof Error ? e.message : String(e)))
  }, [recarregar])

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

  return (
    <>
      <div className="mb-4">
        <Aviso>
          Integração <b>somente leitura</b> de dados. O SAP é a fonte de verdade do estoque e dos
          pedidos; o apontamento de tratamento continua gravando no Supabase.
        </Aviso>
      </div>

      {erro && <Erro>{erro}</Erro>}
      {status && (
        <p className="mb-4 text-sm text-stone-500 dark:text-stone-400">{status}</p>
      )}

      {/* ---------------- conexão ---------------- */}
      <Cartao
        titulo="Conexão"
        acoes={
          <Botao
            disabled={ocupado}
            onClick={() =>
              acao('testando conexão…', async () => {
                const r = await sap.pingSap()
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
          As chamadas passam pela Edge Function <code>sap</code>, que guarda usuário e senha como
          secrets do projeto e reaproveita a sessão do Service Layer.
        </p>
      </Cartao>

      {/* ---------------- consultas salvas ---------------- */}
      <Cartao
        titulo={`Consultas SQL (${consultas.length})`}
        acoes={
          ehGestor ? (
            <Botao
              variante="primario"
              onClick={() => setEditando(editando === 'nova' ? null : 'nova')}
            >
              {editando === 'nova' ? 'Cancelar' : 'Nova consulta'}
            </Botao>
          ) : undefined
        }
        className="mb-5"
      >
        <div className="mb-3">
          <Aviso>
            O SQL fica guardado aqui e é enviado ao SAP com <b>Registrar</b>. Editar o SQL
            invalida o registro anterior — o botão volta a aparecer até você registrar de novo,
            para não executar no SAP uma versão diferente da que está na tela.
          </Aviso>
        </div>

        {editando === 'nova' && (
          <div className="mb-4 rounded-md border border-stone-200 p-4 dark:border-stone-700">
            <FormConsulta
              onSalvar={(c) =>
                acao('salvando…', async () => {
                  await sap.salvarConsulta(c)
                  await recarregar()
                  setEditando(null)
                })
              }
              onCancelar={() => setEditando(null)}
            />
          </div>
        )}

        {consultas.length === 0 ? (
          <Vazio>Nenhuma consulta cadastrada.</Vazio>
        ) : (
          <div className="space-y-3">
            {consultas.map((c) =>
              editando !== 'nova' && editando?.id === c.id ? (
                <div key={c.id} className="rounded-md border border-stone-200 p-4 dark:border-stone-700">
                  <FormConsulta
                    inicial={c}
                    onSalvar={(nova) =>
                      acao('salvando…', async () => {
                        await sap.salvarConsulta(nova, c.id)
                        await recarregar()
                        setEditando(null)
                      })
                    }
                    onCancelar={() => setEditando(null)}
                  />
                </div>
              ) : (
                <div
                  key={c.id}
                  className="rounded-md border border-stone-200 p-3 dark:border-stone-700"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium">
                        <code className="text-sm">{c.codigo}</code>
                        <span className="ml-2 font-normal">{c.nome}</span>
                        <span className="ml-2">
                          {c.registrada_em ? (
                            <Tag cor="ok">registrada</Tag>
                          ) : (
                            <Tag cor="alerta">não registrada no SAP</Tag>
                          )}
                        </span>
                      </p>
                      {c.descricao && (
                        <p className="mt-0.5 text-xs text-stone-500">{c.descricao}</p>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {ehGestor && !c.registrada_em && (
                        <Botao
                          disabled={ocupado}
                          titulo="Envia este SQL ao Service Layer. Cria ou sobrescreve."
                          onClick={() =>
                            acao('registrando no SAP…', async () => {
                              const r = await sap.registrarConsulta(c.codigo)
                              await recarregar()
                              alert(
                                r.atualizou
                                  ? `Consulta ${r.codigo} atualizada no SAP.`
                                  : `Consulta ${r.codigo} criada no SAP.`,
                              )
                            })
                          }
                        >
                          Registrar
                        </Botao>
                      )}
                      <Botao
                        variante="primario"
                        disabled={ocupado || !c.registrada_em}
                        titulo={c.registrada_em ? undefined : 'Registre no SAP antes de executar'}
                        onClick={() =>
                          acao('executando no SAP…', async () => {
                            setResultado({
                              codigo: c.codigo,
                              linhas: await sap.executarConsulta(c.codigo),
                            })
                          })
                        }
                      >
                        Executar
                      </Botao>
                      {ehGestor && (
                        <>
                          <Botao disabled={ocupado} onClick={() => setEditando(c)}>
                            Editar
                          </Botao>
                          <Botao
                            variante="perigo"
                            disabled={ocupado}
                            onClick={() => {
                              if (!confirm(`Excluir a consulta ${c.codigo} do cadastro?`)) return
                              acao('excluindo…', async () => {
                                if (c.registrada_em) await sap.removerConsultaDoSap(c.codigo)
                                await sap.excluirConsulta(c.id)
                                await recarregar()
                                if (resultado?.codigo === c.codigo) setResultado(null)
                              })
                            }}
                          >
                            Excluir
                          </Botao>
                        </>
                      )}
                    </div>
                  </div>
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-stone-500">ver SQL</summary>
                    <pre className="mt-2 max-h-64 overflow-auto rounded bg-stone-50 p-3 text-xs dark:bg-stone-800/50">
                      {c.sql}
                    </pre>
                  </details>
                </div>
              ),
            )}
          </div>
        )}
      </Cartao>

      {/* ---------------- resultado ---------------- */}
      {resultado && (
        <Cartao
          titulo={`Resultado de ${resultado.codigo} (${resultado.linhas.length} linhas)`}
          acoes={
            <>
              <Botao
                disabled={resultado.linhas.length === 0}
                onClick={() => {
                  const colunas = Object.keys(resultado.linhas[0] ?? {})
                  exportarXlsx(
                    resultado.codigo.toLowerCase(),
                    colunas.map((c) => ({ titulo: c, largura: 18 })),
                    resultado.linhas.map((l) =>
                      colunas.map((c) => {
                        const v = l[c]
                        return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
                      }),
                    ),
                  ).catch((e) => setErro(String(e)))
                }}
              >
                Exportar .xlsx
              </Botao>
              <Botao onClick={() => setResultado(null)}>Fechar</Botao>
            </>
          }
          className="mb-5"
        >
          {resultado.linhas.length === 0 ? (
            <Vazio>A consulta não devolveu nenhuma linha.</Vazio>
          ) : (
            <ResultadoGenerico linhas={resultado.linhas} />
          )}
        </Cartao>
      )}

      {/* ---------------- itens e lotes ---------------- */}
      <Cartao
        titulo={`Sementes com estoque${sementes ? ` (${sementes.length})` : ''}`}
        acoes={
          <Botao
            disabled={ocupado}
            onClick={() =>
              acao('consultando itens…', async () => {
                setSementes(await sap.sementesComEstoque())
                setLotes(null)
              })
            }
          >
            {sementes ? 'Atualizar' : 'Carregar itens SOJ'}
          </Botao>
        }
        className="mb-5"
      >
        {sementes == null ? (
          <Vazio>
            Consulta direta por OData: itens com código iniciando em <code>SOJ</code> e saldo
            maior que zero.
          </Vazio>
        ) : (
          <Tabela cabecalho={['Item', 'Descrição', '#Estoque', '']}>
            {sementes.map((s) => (
              <tr key={s.itemCode} className="border-t border-stone-100 dark:border-stone-800/60">
                <td className="px-2 py-1.5 font-medium">{s.itemCode}</td>
                <td className="px-2 py-1.5">{s.nome}</td>
                <td className="num-tabular px-2 py-1.5 text-right">{n(s.estoque, 0)}</td>
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
                  <tr key={l.numero} className="border-t border-stone-100 dark:border-stone-800/60">
                    <td className="px-2 py-1.5 font-medium">{l.numero}</td>
                    <td className="num-tabular px-2 py-1.5 text-right">{inteiro(l.quantidade)}</td>
                    <td className="px-2 py-1.5">{dataCurta(l.fabricacao)}</td>
                    <td className="px-2 py-1.5">
                      {dataCurta(l.validade)}
                      {vencido && (
                        <span className="ml-2">
                          <Tag cor="perigo">vencido</Tag>
                        </span>
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

const dataCurta = (iso: string | null) =>
  !iso ? '—' : iso.slice(0, 10).split('-').reverse().join('/')

/** As colunas vêm do SQL, então a tabela se monta a partir da primeira linha. */
function ResultadoGenerico({ linhas }: { linhas: LinhaResultado[] }) {
  const colunas = Object.keys(linhas[0] ?? {})
  const LIMITE = 300
  return (
    <>
      <Tabela cabecalho={colunas}>
        {linhas.slice(0, LIMITE).map((l, i) => (
          <tr key={i} className="border-t border-stone-100 dark:border-stone-800/60">
            {colunas.map((c) => {
              const v = l[c]
              const numero = typeof v === 'number'
              return (
                <td
                  key={c}
                  className={`max-w-56 truncate px-2 py-1.5 ${numero ? 'num-tabular text-right' : ''}`}
                  title={v == null ? '' : String(v)}
                >
                  {v == null ? <span className="text-stone-400">—</span> : String(v)}
                </td>
              )
            })}
          </tr>
        ))}
      </Tabela>
      {linhas.length > LIMITE && (
        <p className="mt-3 text-xs text-stone-500">
          Mostrando as {LIMITE} primeiras de {linhas.length} linhas. O export traz todas.
        </p>
      )}
    </>
  )
}

function FormConsulta({
  inicial, onSalvar, onCancelar,
}: {
  inicial?: ConsultaSap
  onSalvar: (c: sap.NovaConsulta) => void
  onCancelar: () => void
}) {
  const [codigo, setCodigo] = useState(inicial?.codigo ?? '')
  const [nome, setNome] = useState(inicial?.nome ?? '')
  const [descricao, setDescricao] = useState(inicial?.descricao ?? '')
  const [sql, setSql] = useState(inicial?.sql ?? '')

  const comecaComSelect = /^\s*select\s/i.test(sql)

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-xs font-medium uppercase tracking-wide text-stone-500">
          Código
          <input
            value={codigo}
            disabled={!!inicial}
            onChange={(e) => setCodigo(e.target.value.toUpperCase())}
            placeholder="TSI_PEDIDOS"
            title={inicial ? 'O código é a chave no SAP e não muda depois de criado' : undefined}
            className={`${INPUT} mt-1 normal-case disabled:opacity-60`}
          />
        </label>
        <label className="text-xs font-medium uppercase tracking-wide text-stone-500">
          Nome
          <input
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            className={`${INPUT} mt-1 normal-case`}
          />
        </label>
        <label className="text-xs font-medium uppercase tracking-wide text-stone-500">
          Descrição
          <input
            value={descricao ?? ''}
            onChange={(e) => setDescricao(e.target.value)}
            className={`${INPUT} mt-1 normal-case`}
          />
        </label>
      </div>

      <label className="block text-xs font-medium uppercase tracking-wide text-stone-500">
        SQL (HANA)
        <textarea
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          rows={14}
          spellCheck={false}
          placeholder={'SELECT ...\nFROM "ORDR" T0\nWHERE ...'}
          className={`${INPUT} mt-1 font-mono text-xs normal-case`}
        />
      </label>

      {sql.trim() !== '' && !comecaComSelect && (
        <Aviso gravidade="bloqueio">
          A consulta precisa começar com <b>SELECT</b>. A função recusa qualquer outro comando —
          e a autorização do usuário no SAP é a última barreira.
        </Aviso>
      )}

      <p className="text-xs text-stone-500">
        Sintaxe HANA, com os nomes de tabela entre aspas duplas. Não use o prefixo do schema
        (<code>"SBOVENPRD".</code>) — sem ele a mesma consulta serve homologação.
      </p>

      <div className="flex gap-2">
        <Botao
          variante="primario"
          disabled={!codigo.trim() || !nome.trim() || !comecaComSelect}
          onClick={() => onSalvar({ codigo, nome, descricao, sql })}
        >
          Salvar
        </Botao>
        <Botao onClick={onCancelar}>Cancelar</Botao>
      </div>
    </div>
  )
}
