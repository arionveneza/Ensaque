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
          <>
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
            <Botao
              variante="primario"
              disabled={ocupado}
              titulo="Busca os pedidos em aberto por OData, sem passar por consulta SQL — usa a mesma permissão que já funciona para os itens."
              onClick={() =>
                acao('buscando pedidos por OData…', async () => {
                  setResultado({
                    codigo: 'pedidos em aberto (OData)',
                    linhas: await sap.pedidosAbertos(),
                  })
                })
              }
            >
              Pedidos em aberto
            </Botao>
            {ehGestor && (
              <Botao
                disabled={ocupado}
                titulo="Lista as consultas que já existem no SAP. Só leitura — serve para descobrir o código de uma consulta criada pelo cliente B1."
                onClick={() =>
                  acao('lendo consultas do SAP…', async () => {
                    const lista = await sap.consultasNoSap()
                    setResultado({
                      codigo: 'consultas registradas no SAP',
                      linhas: lista as unknown as LinhaResultado[],
                    })
                  })
                }
              >
                Ver o que existe no SAP
              </Botao>
            )}
          </>
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
            <b>Criada no B1:</b> você monta a consulta no Query Manager do SAP e cadastra aqui só
            o código dela. O app apenas executa — é o caminho que funciona hoje, porque o usuário
            de integração não tem permissão para criar consulta.
            <br />
            <b>Registrada pelo app:</b> o SQL daqui é enviado ao SAP no botão Registrar. Depende
            de o usuário de integração ganhar essa permissão.
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
                          {c.origem === 'sap' ? (
                            <Tag cor="info">criada no B1</Tag>
                          ) : c.registrada_em ? (
                            <Tag cor="ok">registrada pelo app</Tag>
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
                      {ehGestor && c.origem === 'app' && !c.registrada_em && (
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
                        disabled={ocupado || (c.origem === 'app' && !c.registrada_em)}
                        titulo={
                          c.origem === 'app' && !c.registrada_em
                            ? 'Registre no SAP antes de executar'
                            : undefined
                        }
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
  const [origem, setOrigem] = useState<sap.OrigemConsulta>(inicial?.origem ?? 'sap')

  const criadaNoB1 = origem === 'sap'
  const comecaComSelect = /^\s*select\s/i.test(sql)
  // consulta criada no B1 não manda SQL para lugar nenhum: o texto é documentação
  const sqlObrigatorio = !criadaNoB1

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-stone-200 p-3 dark:border-stone-700">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-stone-500">
          Onde a consulta vive
        </p>
        <div className="space-y-2">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              checked={criadaNoB1}
              onChange={() => setOrigem('sap')}
              className="mt-1"
            />
            <span>
              <b>Criada no cliente B1.</b> Você monta no Query Manager do SAP e informa aqui o
              código dela. O app só executa. <i>É o que funciona hoje.</i>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              checked={!criadaNoB1}
              onChange={() => setOrigem('app')}
              className="mt-1"
            />
            <span>
              <b>Registrada pelo app.</b> O SQL abaixo é enviado ao SAP. Depende de o usuário de
              integração ter permissão para criar consulta — hoje ele não tem.
            </span>
          </label>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-xs font-medium uppercase tracking-wide text-stone-500">
          Código
          <input
            value={codigo}
            disabled={!!inicial}
            onChange={(e) => setCodigo(e.target.value)}
            placeholder="ex.: LotesSA"
            title={
              inicial
                ? 'O código é a chave no SAP e não muda depois de criado'
                : 'Copie exatamente como aparece em "Ver o que existe no SAP" — o SAP diferencia maiúsculas de minúsculas'
            }
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
        SQL (HANA){criadaNoB1 && ' — opcional, só documentação'}
        <textarea
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          rows={criadaNoB1 ? 8 : 14}
          spellCheck={false}
          placeholder={
            criadaNoB1
              ? 'Opcional: cole aqui o SQL da consulta do B1, para quem for entender ou refazer depois.'
              : 'SELECT ...\nFROM "ORDR" T0\nWHERE ...'
          }
          className={`${INPUT} mt-1 font-mono text-xs normal-case`}
        />
      </label>

      {sqlObrigatorio && sql.trim() !== '' && !comecaComSelect && (
        <Aviso gravidade="bloqueio">
          A consulta precisa começar com <b>SELECT</b>. A função recusa qualquer outro comando —
          e a autorização do usuário no SAP é a última barreira.
        </Aviso>
      )}

      <p className="text-xs text-stone-500">
        {criadaNoB1 ? (
          <>
            O <b>código</b> precisa ser exatamente o mesmo da consulta no SAP. Use o botão
            <b> Ver o que existe no SAP</b>, no cartão de conexão, para descobri-lo.
          </>
        ) : (
          <>
            Sintaxe HANA, com os nomes de tabela entre aspas duplas. Não use o prefixo do schema
            (<code>"SBOVENPRD".</code>) — sem ele a mesma consulta serve homologação. Comentários
            podem ficar: são removidos antes de enviar ao SAP.
          </>
        )}
      </p>

      <div className="flex gap-2">
        <Botao
          variante="primario"
          disabled={
            !codigo.trim() || !nome.trim() || (sqlObrigatorio && !comecaComSelect)
          }
          onClick={() => onSalvar({ codigo, nome, descricao, sql, origem })}
        >
          Salvar
        </Botao>
        <Botao onClick={onCancelar}>Cancelar</Botao>
      </div>
    </div>
  )
}
