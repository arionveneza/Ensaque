import { useCallback, useEffect, useState } from 'react'
import * as api from '@/dados/api'
import * as g from '@/dados/api-gestao'
import * as adm from '@/dados/api-admin'
import type { ReceitaCompleta } from '@/dados/api-gestao'
import { capacidadeDiaT, pesoItemKg } from '@/dominio/calculos'
import type { ProdutoQuimico, TipoParada, UnidadeDose } from '@/dominio/tipos'
import { useAuth } from '@/auth/AuthProvider'
import { Aviso, Botao, Cartao, Erro, Pagina, Tabela, Tag, Vazio, inteiro, n, rotuloTanque } from '@/componentes/ui'

/** Peso de referência usado só para exibir a receita numa escala legível. */
const REFERENCIA_KG = 40_000

const INPUT =
  'rounded-md border border-stone-300 px-2 py-1 text-sm dark:border-stone-700 dark:bg-stone-800'

type Aba = 'quimicos' | 'receitas' | 'maquinas' | 'embalagens' | 'motivos' | 'lotes'

const ABAS: { id: Aba; nome: string }[] = [
  { id: 'quimicos', nome: 'Produtos químicos' },
  { id: 'receitas', nome: 'Receitas' },
  { id: 'maquinas', nome: 'Máquinas e turnos' },
  { id: 'embalagens', nome: 'Embalagens' },
  { id: 'motivos', nome: 'Motivos de parada' },
  { id: 'lotes', nome: 'Lotes de semente' },
]

export default function Cadastros() {
  const { permitido } = useAuth()
  const podeEditar = permitido('cadastros', 'editar')

  const [aba, setAba] = useState<Aba>('quimicos')
  const [cad, setCad] = useState<Awaited<ReturnType<typeof api.carregarCadastros>> | null>(null)
  const [receitas, setReceitas] = useState<ReceitaCompleta[]>([])
  const [embalagens, setEmbalagens] = useState<g.EmbalagemLinha[]>([])
  const [turnos, setTurnos] = useState<g.TurnoLinha[]>([])
  const [lotes, setLotes] = useState<g.LoteSementeLinha[]>([])
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)

  const recarregar = useCallback(async () => {
    const [c, r, e, t, l] = await Promise.all([
      api.carregarCadastros(), g.listarReceitas(), g.listarEmbalagens(),
      g.listarTurnos(), g.listarLotes(),
    ])
    setCad(c); setReceitas(r); setEmbalagens(e); setTurnos(t); setLotes(l)
  }, [])

  useEffect(() => {
    setCarregando(true)
    recarregar()
      .catch((x) => setErro(x instanceof Error ? x.message : String(x)))
      .finally(() => setCarregando(false))
  }, [recarregar])

  const acao = useCallback(
    async (fn: () => Promise<void>) => {
      try {
        setErro(null)
        await fn()
        await recarregar()
      } catch (e) {
        setErro(e instanceof Error ? e.message : String(e))
      }
    },
    [recarregar],
  )

  if (carregando) return <p className="p-8 text-sm text-stone-500">Carregando cadastros…</p>

  return (
    <Pagina
      titulo="Cadastros"
      descricao="Base do sistema. Alterar aqui muda o planejado de todas as ordens futuras."
    >
      {erro && <Erro>{erro}</Erro>}

      <nav className="mb-5 flex flex-wrap gap-2">
        {ABAS.map((a) => (
          <button
            key={a.id}
            onClick={() => setAba(a.id)}
            className={`rounded-md border px-3 py-1.5 text-sm ${
              aba === a.id
                ? 'border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900'
                : 'border-stone-200 dark:border-stone-700'
            }`}
          >
            {a.nome}
          </button>
        ))}
      </nav>

      {aba === 'quimicos' && (
        <AbaQuimicos
          produtos={cad?.produtos ?? []}
          lotesQuimico={cad?.lotesQuimico ?? []}
          podeEditar={!!podeEditar}
          acao={acao}
        />
      )}
      {aba === 'receitas' && (
        <AbaReceitas
          receitas={receitas}
          produtos={cad?.produtos ?? []}
          podeEditar={!!podeEditar}
          acao={acao}
        />
      )}
      {aba === 'maquinas' && (
        <AbaMaquinas
          maquinas={cad?.maquinas ?? []}
          turnos={turnos}
          podeEditar={!!podeEditar}
          acao={acao}
        />
      )}
      {aba === 'embalagens' && (
        <AbaEmbalagens embalagens={embalagens} podeEditar={!!podeEditar} acao={acao} />
      )}
      {aba === 'motivos' && (
        <AbaMotivos motivos={cad?.motivos ?? []} podeEditar={!!podeEditar} acao={acao} />
      )}
      {aba === 'lotes' && (
        <AbaLotes lotes={lotes} podeEditar={!!podeEditar} acao={acao} />
      )}
    </Pagina>
  )
}

type Acao = (fn: () => Promise<void>) => Promise<void>

// ================================================================
// Produtos químicos — onde entram as densidades da FISPQ
// ================================================================

function AbaQuimicos({
  produtos, lotesQuimico, podeEditar, acao,
}: {
  produtos: api.LinhaProduto[]
  lotesQuimico: api.LinhaLoteQuimico[]
  podeEditar: boolean
  acao: Acao
}) {
  const [editando, setEditando] = useState<string | null>(null)
  const [novo, setNovo] = useState(false)

  const semDensidade = produtos.filter(
    (p) => p.unidade.startsWith('ml') && p.densidade == null,
  )

  return (
    <>
      <div className="mb-4">
        <Aviso gravidade={semDensidade.length > 0 ? 'bloqueio' : 'alerta'}>
          {semDensidade.length > 0 ? (
            <>
              <b>{semDensidade.length} produto(s) dosado(s) em ml sem densidade.</b> O peso de
              balança não pode ser calculado e a ordem não inicia:{' '}
              {semDensidade.map((p) => p.nome).join(', ')}
            </>
          ) : (
            <>
              A densidade converte a dose em <b>peso de balança</b> — o número que a produção afere
              no tanque. Confira cada valor contra a <b>FISPQ do fabricante</b>: densidade errada
              desloca todo o planejado sem gerar nenhum alerta.
            </>
          )}
        </Aviso>
      </div>

      <Cartao
        titulo={`Produtos químicos (${produtos.length})`}
        acoes={podeEditar ? <Botao onClick={() => setNovo(!novo)}>{novo ? 'Cancelar' : 'Novo produto'}</Botao> : undefined}
        className="mb-5"
      >
        {novo && (
          <div className="mb-4 rounded-md border border-stone-200 p-3 dark:border-stone-700">
            <FormProduto
              onSalvar={(p) => acao(async () => { await adm.salvarProduto(p); setNovo(false) })}
              onCancelar={() => setNovo(false)}
            />
          </div>
        )}
        <Tabela cabecalho={['Produto', 'Código', 'Unidade', '#Densidade', 'Lotes', '']}>
          {produtos.map((p) =>
            editando === p.id ? (
              <tr key={p.id} className="border-t border-stone-100 dark:border-stone-800/60">
                <td colSpan={6} className="px-2 py-3">
                  <FormProduto
                    inicial={p}
                    onSalvar={(x) =>
                      acao(async () => { await adm.salvarProduto({ ...x, id: p.id }); setEditando(null) })
                    }
                    onCancelar={() => setEditando(null)}
                  />
                </td>
              </tr>
            ) : (
              <tr key={p.id} className="border-t border-stone-100 dark:border-stone-800/60">
                <td className="px-2 py-2 font-medium">{p.nome}</td>
                <td className="px-2 py-2 text-stone-500">{p.codigo}</td>
                <td className="px-2 py-2">{p.unidade}</td>
                <td className="num-tabular px-2 py-2 text-right">
                  {!p.unidade.startsWith('ml') ? (
                    <span className="text-stone-400">— dose já em peso</span>
                  ) : p.densidade == null ? (
                    <span className="font-medium text-red-600">falta densidade</span>
                  ) : (
                    `${n(p.densidade, 3)} g/ml`
                  )}
                </td>
                <td className="px-2 py-2 text-xs text-stone-500">
                  {lotesQuimico.filter((l) => l.produto_id === p.id).map((l) => l.id).join(', ') || '—'}
                </td>
                <td className="px-2 py-2 text-right">
                  {podeEditar && (
                    <button onClick={() => setEditando(p.id)} className="text-xs underline">
                      editar
                    </button>
                  )}
                </td>
              </tr>
            ),
          )}
        </Tabela>
      </Cartao>

      <Cartao titulo={`Lotes de químico (${lotesQuimico.filter((l) => l.ativo).length} ativos)`}>
        <p className="mb-3 text-sm text-stone-500">
          Cada tanque exige o lote do produto no início da ordem — é o que dá rastreabilidade do
          tratamento. Por isso lote já usado <b>não pode ser excluído</b>: apagá-lo quebraria o
          histórico da ordem. Para tirá-lo da lista do operador, use <b>desativar</b>.
        </p>
        {podeEditar && <FormLoteQuimico produtos={produtos} acao={acao} />}
        <Tabela cabecalho={['Lote', 'Produto', 'Situação', '']}>
          {lotesQuimico.map((l) => (
            <tr
              key={l.id}
              className={`border-t border-stone-100 dark:border-stone-800/60 ${l.ativo ? '' : 'opacity-60'}`}
            >
              <td className="px-2 py-1.5 font-medium">{l.id}</td>
              <td className="px-2 py-1.5">
                {produtos.find((p) => p.id === l.produto_id)?.nome ?? '—'}
              </td>
              <td className="px-2 py-1.5">
                <Tag cor={l.ativo ? 'ok' : 'neutro'}>{l.ativo ? 'Ativo' : 'Desativado'}</Tag>
              </td>
              <td className="px-2 py-1.5 text-right whitespace-nowrap">
                {podeEditar && (
                  <>
                    <button
                      onClick={() => acao(() => adm.definirAtivoLoteQuimico(l.id, !l.ativo))}
                      className="mr-3 text-xs underline"
                    >
                      {l.ativo ? 'desativar' : 'reativar'}
                    </button>
                    <button
                      onClick={() => {
                        if (!confirm(`Excluir o lote ${l.id} do cadastro?`)) return
                        acao(() => adm.excluirLoteQuimico(l.id))
                      }}
                      className="text-xs text-red-600 underline"
                      title="Só funciona se o lote nunca foi usado numa ordem"
                    >
                      excluir
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </Tabela>
      </Cartao>
    </>
  )
}

function FormProduto({
  inicial, onSalvar, onCancelar,
}: {
  inicial?: api.LinhaProduto
  onSalvar: (p: adm.ProdutoEdicao) => void
  onCancelar: () => void
}) {
  const [codigo, setCodigo] = useState(inicial?.codigo ?? '')
  const [nome, setNome] = useState(inicial?.nome ?? '')
  // produto novo nasce em ml/100kg: é a base que as bulas de TSI usam
  const [unidade, setUnidade] = useState<UnidadeDose>(inicial?.unidade ?? 'ml/100kg')
  const [densidade, setDensidade] = useState(inicial?.densidade?.toString() ?? '')

  const emMl = unidade.startsWith('ml')
  const dens = densidade.trim() === '' ? null : Number(densidade.replace(',', '.'))
  const faltaDensidade = emMl && (dens == null || !(dens > 0))

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="text-xs text-stone-500">
        Código
        <input value={codigo} onChange={(e) => setCodigo(e.target.value)} className={`${INPUT} mt-1 block w-24`} />
      </label>
      <label className="text-xs text-stone-500">
        Nome
        <input value={nome} onChange={(e) => setNome(e.target.value)} className={`${INPUT} mt-1 block w-56`} />
      </label>
      <label className="text-xs text-stone-500">
        Unidade de dose
        <select
          value={unidade}
          onChange={(e) => setUnidade(e.target.value as UnidadeDose)}
          className={`${INPUT} mt-1 block`}
          title="Copie a unidade exata da bula/FISPQ — as bulas de TSI costumam dosar por 100 kg de semente"
        >
          <option value="ml/100kg">ml / 100 kg</option>
          <option value="g/100kg">g / 100 kg</option>
          <option value="ml/kg">ml / kg</option>
          <option value="g/kg">g / kg</option>
        </select>
      </label>
      <label className="text-xs text-stone-500">
        Densidade (g/ml)
        <input
          value={emMl ? densidade : ''}
          disabled={!emMl}
          onChange={(e) => setDensidade(e.target.value)}
          placeholder={emMl ? 'ex.: 1,08' : 'não se aplica'}
          className={`${INPUT} mt-1 block w-32 disabled:opacity-50`}
        />
      </label>
      <Botao
        variante="primario"
        disabled={!codigo.trim() || !nome.trim() || faltaDensidade}
        titulo={faltaDensidade ? `Produto em ${unidade} exige densidade da FISPQ` : undefined}
        onClick={() => onSalvar({ codigo, nome, unidade, densidade: dens })}
      >
        Salvar
      </Botao>
      <Botao onClick={onCancelar}>Cancelar</Botao>
    </div>
  )
}

function FormLoteQuimico({ produtos, acao }: { produtos: api.LinhaProduto[]; acao: Acao }) {
  const [id, setId] = useState('')
  const [produtoId, setProdutoId] = useState('')
  const [validade, setValidade] = useState('')
  return (
    <div className="mb-4 flex flex-wrap items-end gap-2">
      <label className="text-xs text-stone-500">
        Nº do lote
        <input value={id} onChange={(e) => setId(e.target.value)} className={`${INPUT} mt-1 block w-40`} />
      </label>
      <label className="text-xs text-stone-500">
        Produto
        <select value={produtoId} onChange={(e) => setProdutoId(e.target.value)} className={`${INPUT} mt-1 block`}>
          <option value="">escolha…</option>
          {produtos.map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
        </select>
      </label>
      <label className="text-xs text-stone-500">
        Validade
        <input type="date" value={validade} onChange={(e) => setValidade(e.target.value)} className={`${INPUT} mt-1 block`} />
      </label>
      <Botao
        disabled={!id.trim() || !produtoId}
        onClick={() =>
          acao(async () => {
            await adm.salvarLoteQuimico({ id: id.trim(), produto_id: produtoId, validade: validade || null })
            setId(''); setValidade('')
          })
        }
      >
        Adicionar lote
      </Botao>
    </div>
  )
}

// ================================================================
// Receitas
// ================================================================

function AbaReceitas({
  receitas, produtos, podeEditar, acao,
}: {
  receitas: ReceitaCompleta[]
  produtos: api.LinhaProduto[]
  podeEditar: boolean
  acao: Acao
}) {
  const [editando, setEditando] = useState<string | 'nova' | null>(null)

  return (
    <>
      <div className="mb-4">
        <Aviso>
          O nome da receita é o <b>código do comercial</b> — língua única entre venda e produção.
          Só existem 5 tanques: receita com mais produtos agrupa dois no mesmo tanque, e o
          planejado passa a ser a soma deles.
        </Aviso>
      </div>

      {podeEditar && (
        <div className="mb-4">
          <Botao variante="primario" onClick={() => setEditando(editando === 'nova' ? null : 'nova')}>
            {editando === 'nova' ? 'Cancelar' : 'Nova receita'}
          </Botao>
        </div>
      )}

      {editando === 'nova' && (
        <Cartao titulo="Nova receita" className="mb-5">
          <FormReceita
            produtos={produtos}
            onSalvar={(nome, itens) =>
              acao(async () => { await adm.salvarReceita(nome, itens); setEditando(null) })
            }
            onCancelar={() => setEditando(null)}
          />
        </Cartao>
      )}

      {receitas.length === 0 ? (
        <Vazio>Nenhuma receita cadastrada.</Vazio>
      ) : (
        receitas.map((r) => (
          <Cartao
            key={r.id}
            titulo={r.nome}
            acoes={
              podeEditar ? (
                <>
                  <Botao onClick={() => setEditando(editando === r.id ? null : r.id)}>
                    {editando === r.id ? 'Cancelar' : 'Editar'}
                  </Botao>
                  <Botao
                    variante="perigo"
                    onClick={() => {
                      if (!confirm(`Excluir a receita ${r.nome}?`)) return
                      acao(() => adm.excluirReceita(r.id))
                    }}
                  >
                    Excluir
                  </Botao>
                </>
              ) : undefined
            }
            className="mb-4"
          >
            {editando === r.id ? (
              <FormReceita
                produtos={produtos}
                inicialNome={r.nome}
                inicialItens={r.receita_itens.map((i) => ({
                  produto_id: i.produto_id, dose: i.dose, tanque: i.tanque,
                }))}
                onSalvar={(nome, itens) =>
                  acao(async () => { await adm.salvarReceita(nome, itens, r.id); setEditando(null) })
                }
                onCancelar={() => setEditando(null)}
              />
            ) : (
              <TabelaReceita receita={r} />
            )}
          </Cartao>
        ))
      )}
    </>
  )
}

function TabelaReceita({ receita }: { receita: ReceitaCompleta }) {
  const porTanque = new Map<number, typeof receita.receita_itens>()
  for (const i of receita.receita_itens) {
    const atual = porTanque.get(i.tanque)
    if (atual) atual.push(i)
    else porTanque.set(i.tanque, [i])
  }
  return (
    <>
      <p className="mb-2 text-xs text-stone-500">
        Valores para {inteiro(REFERENCIA_KG)} kg de semente.
      </p>
      <Tabela cabecalho={['Destino', 'Produto', '#Dose', '#Densidade', '#Peso de balança']}>
        {[...porTanque.keys()].sort((a, b) => a - b).flatMap((tq) => {
          const itens = porTanque.get(tq)!
          return itens.map((i, idx) => {
            const q = i.produtos_quimicos
            const produto: ProdutoQuimico = {
              id: i.produto_id, codigo: q.codigo, nome: q.nome,
              unidade: q.unidade, densidade: q.densidade,
            }
            let peso: number | null = null
            try {
              peso = pesoItemKg({ produtoId: i.produto_id, dose: i.dose, tanque: tq }, produto, REFERENCIA_KG)
            } catch { peso = null }
            return (
              <tr key={`${tq}-${i.produto_id}`} className="border-t border-stone-100 dark:border-stone-800/60">
                <td className="px-2 py-1.5">
                  {idx === 0 ? rotuloTanque(tq) : ''}
                  {idx === 0 && itens.length > 1 && (
                    <span className="ml-1"><Tag cor="roxo">mistura</Tag></span>
                  )}
                </td>
                <td className="px-2 py-1.5">{q.nome}</td>
                <td className="num-tabular px-2 py-1.5 text-right">{n(i.dose, 2)} {q.unidade}</td>
                <td className="num-tabular px-2 py-1.5 text-right">
                  {q.densidade == null ? '—' : `${n(q.densidade, 3)} g/ml`}
                </td>
                <td className="num-tabular px-2 py-1.5 text-right font-medium">
                  {peso == null ? <span className="text-red-600">densidade ausente</span> : `${n(peso, 1)} kg`}
                </td>
              </tr>
            )
          })
        })}
      </Tabela>
    </>
  )
}

/**
 * A dose fica como TEXTO enquanto se digita: convertê-la a cada tecla
 * engolia a vírgula (digitar "2," virava 2 e "0,5" virava 5). A conversão
 * acontece só no salvar, aceitando vírgula ou ponto.
 */
interface ItemReceitaForm {
  produto_id: string
  doseTxt: string
  tanque: number
}

const doseNumero = (txt: string): number => {
  const v = parseFloat(txt.trim().replace(',', '.'))
  return Number.isFinite(v) ? v : NaN
}

function FormReceita({
  produtos, inicialNome = '', inicialItens = [], onSalvar, onCancelar,
}: {
  produtos: api.LinhaProduto[]
  inicialNome?: string
  inicialItens?: adm.ItemReceitaEdicao[]
  onSalvar: (nome: string, itens: adm.ItemReceitaEdicao[]) => void
  onCancelar: () => void
}) {
  const [nome, setNome] = useState(inicialNome)
  const [itens, setItens] = useState<ItemReceitaForm[]>(
    inicialItens.length > 0
      ? inicialItens.map((i) => ({
          produto_id: i.produto_id,
          doseTxt: String(i.dose).replace('.', ','),
          tanque: i.tanque,
        }))
      : [{ produto_id: '', doseTxt: '', tanque: 1 }],
  )

  const atualizar = (i: number, campo: Partial<ItemReceitaForm>) =>
    setItens(itens.map((it, idx) => (idx === i ? { ...it, ...campo } : it)))

  const tanquesUsados = new Set(itens.map((i) => i.tanque))
  const unidadeDe = (produtoId: string) =>
    produtos.find((p) => p.id === produtoId)?.unidade

  return (
    <div>
      <label className="text-xs text-stone-500">
        Nome da receita (código do comercial)
        <input value={nome} onChange={(e) => setNome(e.target.value)} className={`${INPUT} mt-1 block w-64`} />
      </label>

      <div className="mt-4 space-y-2">
        {itens.map((it, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-stone-500">
              Produto
              <select
                value={it.produto_id}
                onChange={(e) => atualizar(i, { produto_id: e.target.value })}
                className={`${INPUT} mt-1 block w-52`}
              >
                <option value="">escolha…</option>
                {produtos.map((p) => (
                  <option key={p.id} value={p.id}>{p.nome} ({p.unidade})</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-stone-500">
              Dose{unidadeDe(it.produto_id) ? ` (${unidadeDe(it.produto_id)})` : ''}
              <input
                inputMode="decimal"
                value={it.doseTxt}
                onChange={(e) => atualizar(i, { doseTxt: e.target.value })}
                placeholder="ex.: 2,5"
                className={`${INPUT} mt-1 block w-24 text-right`}
              />
            </label>
            <label className="text-xs text-stone-500">
              Destino
              <select
                value={it.tanque}
                onChange={(e) => atualizar(i, { tanque: Number(e.target.value) })}
                className={`${INPUT} mt-1 block w-32`}
                title="Pó secante nunca vai em tanque: use o Transferidor"
              >
                {[1, 2, 3, 4, 5].map((t) => <option key={t} value={t}>T{t}</option>)}
                <option value={0}>Transferidor</option>
              </select>
            </label>
            <button
              onClick={() => setItens(itens.filter((_, idx) => idx !== i))}
              disabled={itens.length === 1}
              className="pb-1.5 text-xs text-red-600 underline disabled:opacity-30"
            >
              remover
            </button>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Botao onClick={() => setItens([...itens, { produto_id: '', doseTxt: '', tanque: 1 }])}>
          Adicionar produto
        </Botao>
        <span className="text-xs text-stone-500">
          {itens.length} produto(s) em {tanquesUsados.size} destino(s)
          {itens.length > tanquesUsados.size && ' — há mistura'}
        </span>
      </div>

      <div className="mt-4 flex gap-2">
        <Botao
          variante="primario"
          disabled={!nome.trim() || itens.some((i) => !i.produto_id || !(doseNumero(i.doseTxt) > 0))}
          onClick={() =>
            onSalvar(
              nome,
              itens.map((i) => ({
                produto_id: i.produto_id,
                dose: doseNumero(i.doseTxt),
                tanque: i.tanque,
              })),
            )
          }
        >
          Salvar receita
        </Botao>
        <Botao onClick={onCancelar}>Cancelar</Botao>
      </div>
    </div>
  )
}

// ================================================================
// Máquinas e turnos
// ================================================================

function AbaMaquinas({
  maquinas, turnos, podeEditar, acao,
}: {
  maquinas: api.LinhaMaquina[]
  turnos: g.TurnoLinha[]
  podeEditar: boolean
  acao: Acao
}) {
  const horas = turnos.map((t) => Number(t.horas))
  return (
    <>
      <Cartao titulo="Máquinas e capacidade" className="mb-5">
        <Tabela cabecalho={['Máquina', '#Capacidade (t/h)', '#Tanques', '#Cap. dia', '']}>
          {maquinas.map((m) => (
            <LinhaMaquinaEdit key={m.id} maquina={m} horas={horas} podeEditar={podeEditar} acao={acao} />
          ))}
        </Tabela>
        <p className="mt-3 text-xs text-stone-500">
          A capacidade do dia é a capacidade horária multiplicada pelas horas dos dois turnos.
          Mudá-la altera o cálculo de ocupação e o tempo planejado de toda ordem futura.
        </p>
      </Cartao>

      <Cartao titulo="Turnos">
        <p className="mb-3 text-sm text-stone-500">
          O turno não é programado: é atribuído pelo horário real do início. Até 17:30 é Turno 1.
          O Turno 2 cruza a meia-noite e pertence ao dia que começou às 07:30.
        </p>
        <Tabela cabecalho={['Turno', 'Início', 'Fim', '#Horas', '']}>
          {turnos.map((t) => (
            <LinhaTurnoEdit key={t.id} turno={t} podeEditar={podeEditar} acao={acao} />
          ))}
        </Tabela>
      </Cartao>
    </>
  )
}

function LinhaMaquinaEdit({
  maquina, horas, podeEditar, acao,
}: {
  maquina: api.LinhaMaquina
  horas: number[]
  podeEditar: boolean
  acao: Acao
}) {
  const [edit, setEdit] = useState(false)
  const [nome, setNome] = useState(maquina.nome)
  const [cap, setCap] = useState(String(maquina.capacidade_th))
  const [tanques, setTanques] = useState(String(maquina.qtd_tanques))

  if (!edit) {
    return (
      <tr className="border-t border-stone-100 dark:border-stone-800/60">
        <td className="px-2 py-2 font-medium">{maquina.nome}</td>
        <td className="num-tabular px-2 py-2 text-right">{n(maquina.capacidade_th, 1)}</td>
        <td className="num-tabular px-2 py-2 text-right">{maquina.qtd_tanques}</td>
        <td className="num-tabular px-2 py-2 text-right font-semibold">
          {n(capacidadeDiaT(maquina.capacidade_th, horas), 0)} t
        </td>
        <td className="px-2 py-2 text-right">
          {podeEditar && <button onClick={() => setEdit(true)} className="text-xs underline">editar</button>}
        </td>
      </tr>
    )
  }
  return (
    <tr className="border-t border-stone-100 dark:border-stone-800/60">
      <td className="px-2 py-2"><input value={nome} onChange={(e) => setNome(e.target.value)} className={`${INPUT} w-28`} /></td>
      <td className="px-2 py-2 text-right"><input value={cap} onChange={(e) => setCap(e.target.value)} className={`${INPUT} w-20 text-right`} /></td>
      <td className="px-2 py-2 text-right"><input value={tanques} onChange={(e) => setTanques(e.target.value)} className={`${INPUT} w-16 text-right`} /></td>
      <td />
      <td className="px-2 py-2 text-right whitespace-nowrap">
        <button
          onClick={() =>
            acao(async () => {
              await adm.salvarMaquina({
                id: maquina.id, nome,
                capacidade_th: Number(cap.replace(',', '.')),
                qtd_tanques: Number(tanques),
              })
              setEdit(false)
            })
          }
          className="mr-2 text-xs underline"
        >
          salvar
        </button>
        <button onClick={() => setEdit(false)} className="text-xs text-stone-500 underline">cancelar</button>
      </td>
    </tr>
  )
}

function LinhaTurnoEdit({
  turno, podeEditar, acao,
}: { turno: g.TurnoLinha; podeEditar: boolean; acao: Acao }) {
  const [edit, setEdit] = useState(false)
  const [inicio, setInicio] = useState(turno.inicio.slice(0, 5))
  const [fim, setFim] = useState(turno.fim.slice(0, 5))
  const [horas, setHoras] = useState(String(turno.horas))

  if (!edit) {
    return (
      <tr className="border-t border-stone-100 dark:border-stone-800/60">
        <td className="px-2 py-2 font-medium">{turno.nome}</td>
        <td className="px-2 py-2">{turno.inicio}</td>
        <td className="px-2 py-2">{turno.fim}</td>
        <td className="num-tabular px-2 py-2 text-right">{n(Number(turno.horas), 1)}</td>
        <td className="px-2 py-2 text-right">
          {podeEditar && <button onClick={() => setEdit(true)} className="text-xs underline">editar</button>}
        </td>
      </tr>
    )
  }
  return (
    <tr className="border-t border-stone-100 dark:border-stone-800/60">
      <td className="px-2 py-2 font-medium">{turno.nome}</td>
      <td className="px-2 py-2"><input type="time" value={inicio} onChange={(e) => setInicio(e.target.value)} className={INPUT} /></td>
      <td className="px-2 py-2"><input type="time" value={fim} onChange={(e) => setFim(e.target.value)} className={INPUT} /></td>
      <td className="px-2 py-2 text-right"><input value={horas} onChange={(e) => setHoras(e.target.value)} className={`${INPUT} w-16 text-right`} /></td>
      <td className="px-2 py-2 text-right whitespace-nowrap">
        <button
          onClick={() =>
            acao(async () => {
              await adm.salvarTurno({
                id: turno.id, nome: turno.nome, inicio, fim,
                horas: Number(horas.replace(',', '.')),
              })
              setEdit(false)
            })
          }
          className="mr-2 text-xs underline"
        >
          salvar
        </button>
        <button onClick={() => setEdit(false)} className="text-xs text-stone-500 underline">cancelar</button>
      </td>
    </tr>
  )
}

// ================================================================
// Embalagens e motivos
// ================================================================

function AbaEmbalagens({
  embalagens, podeEditar, acao,
}: { embalagens: g.EmbalagemLinha[]; podeEditar: boolean; acao: Acao }) {
  return (
    <Cartao titulo="Embalagens">
      <p className="mb-3 text-sm text-stone-500">
        O fator de peso multiplica o PMS do lote para dar o peso do bag. Mudá-lo altera o peso de
        toda ordem futura que use a embalagem.
      </p>
      <Tabela cabecalho={['Código', 'SimpleAgro', 'Descrição', '#Sementes', '#Fator', '']}>
        {embalagens.map((e) => (
          <LinhaEmbalagemEdit key={e.codigo} emb={e} podeEditar={podeEditar} acao={acao} />
        ))}
      </Tabela>
    </Cartao>
  )
}

function LinhaEmbalagemEdit({
  emb, podeEditar, acao,
}: { emb: g.EmbalagemLinha; podeEditar: boolean; acao: Acao }) {
  const [edit, setEdit] = useState(false)
  const [descricao, setDescricao] = useState(emb.descricao)
  const [fator, setFator] = useState(String(emb.fator_peso))
  const [codigoExt, setCodigoExt] = useState(emb.codigo_ext ?? '')

  if (!edit) {
    return (
      <tr className="border-t border-stone-100 dark:border-stone-800/60">
        <td className="px-2 py-2 font-medium">{emb.codigo}</td>
        <td className="px-2 py-2 text-stone-500">{emb.codigo_ext ?? '—'}</td>
        <td className="px-2 py-2">{emb.descricao}</td>
        <td className="num-tabular px-2 py-2 text-right">{inteiro(emb.sementes)}</td>
        <td className="num-tabular px-2 py-2 text-right">PMS × {n(emb.fator_peso, 1)}</td>
        <td className="px-2 py-2 text-right">
          {podeEditar && <button onClick={() => setEdit(true)} className="text-xs underline">editar</button>}
        </td>
      </tr>
    )
  }
  return (
    <tr className="border-t border-stone-100 dark:border-stone-800/60">
      <td className="px-2 py-2 font-medium">{emb.codigo}</td>
      <td className="px-2 py-2"><input value={codigoExt} onChange={(e) => setCodigoExt(e.target.value)} className={`${INPUT} w-20`} /></td>
      <td className="px-2 py-2"><input value={descricao} onChange={(e) => setDescricao(e.target.value)} className={`${INPUT} w-56`} /></td>
      <td className="num-tabular px-2 py-2 text-right">{inteiro(emb.sementes)}</td>
      <td className="px-2 py-2 text-right"><input value={fator} onChange={(e) => setFator(e.target.value)} className={`${INPUT} w-16 text-right`} /></td>
      <td className="px-2 py-2 text-right whitespace-nowrap">
        <button
          onClick={() =>
            acao(async () => {
              await adm.salvarEmbalagem({
                codigo: emb.codigo, codigo_ext: codigoExt.trim() || null, descricao,
                sementes: emb.sementes, fator_peso: Number(fator.replace(',', '.')),
              })
              setEdit(false)
            })
          }
          className="mr-2 text-xs underline"
        >
          salvar
        </button>
        <button onClick={() => setEdit(false)} className="text-xs text-stone-500 underline">cancelar</button>
      </td>
    </tr>
  )
}

function AbaMotivos({
  motivos, podeEditar, acao,
}: { motivos: api.LinhaMotivo[]; podeEditar: boolean; acao: Acao }) {
  const [descricao, setDescricao] = useState('')
  const [tipo, setTipo] = useState<TipoParada>('Nao planejada')

  return (
    <Cartao titulo="Motivos de parada">
      <div className="mb-4">
        <Aviso>
          A classificação é o que separa tempo normal de processo de perda real. Sem ela o setup
          penalizaria a disponibilidade como se fosse falha de equipamento.
        </Aviso>
      </div>

      {podeEditar && (
        <div className="mb-4 flex flex-wrap items-end gap-2">
          <label className="text-xs text-stone-500">
            Descrição
            <input value={descricao} onChange={(e) => setDescricao(e.target.value)} className={`${INPUT} mt-1 block w-64`} />
          </label>
          <label className="text-xs text-stone-500">
            Tipo
            <select value={tipo} onChange={(e) => setTipo(e.target.value as TipoParada)} className={`${INPUT} mt-1 block`}>
              <option value="Planejada">Planejada</option>
              <option value="Nao planejada">Não planejada</option>
            </select>
          </label>
          <Botao
            disabled={!descricao.trim()}
            onClick={() => acao(async () => { await adm.salvarMotivo({ descricao, tipo }); setDescricao('') })}
          >
            Adicionar
          </Botao>
        </div>
      )}

      <Tabela cabecalho={['Motivo', 'Tipo', 'Efeito no indicador', '']}>
        {motivos.map((m) => (
          <tr key={m.id} className="border-t border-stone-100 dark:border-stone-800/60">
            <td className="px-2 py-2">{m.descricao}</td>
            <td className="px-2 py-2">
              <Tag cor={m.tipo === 'Planejada' ? 'info' : 'perigo'}>{m.tipo}</Tag>
            </td>
            <td className="px-2 py-2 text-xs text-stone-500">
              {m.tipo === 'Planejada'
                ? 'descontada da disponibilidade operacional'
                : 'contabilizada como perda real'}
            </td>
            <td className="px-2 py-2 text-right">
              {podeEditar && (
                <button
                  onClick={() => acao(() => adm.excluirMotivo(m.id))}
                  className="text-xs text-red-600 underline"
                >
                  excluir
                </button>
              )}
            </td>
          </tr>
        ))}
      </Tabela>
    </Cartao>
  )
}

function AbaLotes({
  lotes, podeEditar, acao,
}: {
  lotes: g.LoteSementeLinha[]
  podeEditar: boolean
  acao: Acao
}) {
  const [busca, setBusca] = useState('')
  const [semUso, setSemUso] = useState<number | null>(null)
  const [novo, setNovo] = useState(false)

  const filtrados = lotes.filter(
    (l) =>
      !busca.trim() ||
      `${l.id} ${l.cultivar} ${l.tratamento ?? ''}`
        .toLowerCase()
        .includes(busca.trim().toLowerCase()),
  )

  return (
    <Cartao
      titulo={`Lotes de semente (${filtrados.length} de ${lotes.length})`}
      acoes={
        <>
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="buscar lote ou cultivar…"
            className={INPUT}
          />
          {podeEditar && (
            <Botao variante="primario" onClick={() => setNovo((v) => !v)}>
              {novo ? 'Cancelar' : 'Novo lote'}
            </Botao>
          )}
          {podeEditar && lotes.length > 0 && (
            <Botao
              titulo="Apaga de uma vez os lotes que nenhuma ordem e nenhuma baixa referenciam"
              onClick={() =>
                acao(async () => {
                  const quantos = await adm.contarLotesSemUso()
                  setSemUso(quantos)
                  if (quantos === 0) {
                    alert(
                      'Nenhum lote pode ser apagado: todos estão em uso por alguma ordem ou já ' +
                        'têm baixa registrada.\n\nPara zerar tudo ao sair dos testes, use o ' +
                        'script supabase/limpar-dados-teste.sql.',
                    )
                    return
                  }
                  if (
                    !confirm(
                      `Excluir ${quantos} lote(s) sem uso?\n\nSão os que nenhuma ordem e ` +
                        'nenhuma baixa referenciam. Os demais permanecem.\n\nNão tem desfazer.',
                    )
                  )
                    return
                  const removidos = await adm.excluirLotesSemUso()
                  setSemUso(null)
                  alert(`${removidos} lote(s) excluído(s).`)
                })
              }
            >
              Excluir sem uso{semUso != null && semUso > 0 ? ` (${semUso})` : ''}
            </Botao>
          )}
        </>
      }
    >
      <p className="mb-3 text-sm text-stone-500">
        Os lotes vêm do relatório de Saldos da SimpleAgro, importado na tela de Ordens — o
        cadastro manual é para exceções. Lote que já tem ordem ou baixa registrada{' '}
        <b>não pode ser excluído</b> — apagá-lo quebraria o histórico. Para limpar tudo ao
        encerrar os testes, use <code>supabase/limpar-dados-teste.sql</code>.
      </p>

      {novo && (
        <div className="mb-4 rounded-md border border-stone-200 p-4 dark:border-stone-700">
          <FormNovoLote
            onSalvar={(l) =>
              acao(async () => {
                await g.criarLote(l)
                setNovo(false)
              })
            }
          />
        </div>
      )}
      <Tabela
        cabecalho={['Lote', 'Cultivar', 'Tratamento', '#PMS', '#Peso/bag', '#Bags', 'Status', '']}
      >
        {filtrados.slice(0, 300).map((l) => (
          <tr key={l.id} className="border-t border-stone-100 dark:border-stone-800/60">
            <td className="px-2 py-1.5 font-medium">{l.id}</td>
            <td className="px-2 py-1.5">{l.cultivar}</td>
            <td className="px-2 py-1.5">
              {l.tratamento ? (
                <Tag cor={l.tratamento.toUpperCase() === 'SEM TSI' ? 'neutro' : 'info'}>
                  {l.tratamento}
                </Tag>
              ) : (
                <span className="text-stone-400">—</span>
              )}
            </td>
            <td className="num-tabular px-2 py-1.5 text-right">{l.pms == null ? '—' : n(l.pms, 1)}</td>
            <td className="num-tabular px-2 py-1.5 text-right">{n(l.peso_bag_kg, 0)} kg</td>
            <td className="num-tabular px-2 py-1.5 text-right">{inteiro(l.bags_disp)}</td>
            <td className="px-2 py-1.5">
              <Tag cor={l.status === 'Baixado' ? 'ok' : 'neutro'}>{l.status}</Tag>
            </td>
            <td className="px-2 py-1.5 text-right">
              {podeEditar && (
                <button
                  onClick={() => {
                    if (!confirm(`Excluir o lote ${l.id}?`)) return
                    acao(() => adm.excluirLoteSemente(l.id))
                  }}
                  className="text-xs text-red-600 underline"
                  title="Só funciona se o lote não tem ordem nem baixa"
                >
                  excluir
                </button>
              )}
            </td>
          </tr>
        ))}
      </Tabela>
      {filtrados.length > 300 && (
        <p className="mt-3 text-xs text-stone-500">Mostrando os 300 primeiros.</p>
      )}
    </Cartao>
  )
}

/**
 * Cadastro manual, no mesmo padrão da tabela: Lote · Cultivar · Tratamento ·
 * PMS · Peso/bag · Bags. O peso/bag segue PMS × fator da embalagem
 * (5 no BG5M, 2,5 no MEIOBAG), editável para exceções.
 */
function FormNovoLote({
  onSalvar,
}: {
  onSalvar: (l: {
    id: string
    cultivar: string
    tratamento: string | null
    pms: number | null
    peso_bag_kg: number
    bags_disp: number
  }) => void
}) {
  const [id, setId] = useState('')
  const [cultivar, setCultivar] = useState('')
  const [tratamento, setTratamento] = useState('SEM TSI')
  const [pms, setPms] = useState('')
  const [fator, setFator] = useState(5)
  const [pesoBag, setPesoBag] = useState('')
  const [bags, setBags] = useState('')

  const pmsNum = parseFloat(pms.replace(',', '.'))
  const sugestao = Number.isFinite(pmsNum) && pmsNum > 0 ? Math.round(pmsNum * fator) : null
  const pesoNum = pesoBag.trim()
    ? parseFloat(pesoBag.replace(',', '.'))
    : (sugestao ?? NaN)
  const bagsNum = parseInt(bags, 10)
  const valido =
    id.trim() !== '' && cultivar.trim() !== '' &&
    Number.isFinite(pesoNum) && pesoNum > 0 &&
    Number.isFinite(bagsNum) && bagsNum > 0

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-xs font-medium uppercase tracking-wide text-stone-500">
          Lote
          <input
            value={id}
            onChange={(e) => setId(e.target.value.toUpperCase())}
            placeholder="ex.: SV-0999"
            className={`${INPUT} mt-1 normal-case`}
          />
        </label>
        <label className="text-xs font-medium uppercase tracking-wide text-stone-500">
          Cultivar
          <input
            value={cultivar}
            onChange={(e) => setCultivar(e.target.value.toUpperCase())}
            placeholder="ex.: NEO771 I2X"
            className={`${INPUT} mt-1 normal-case`}
          />
        </label>
        <label className="text-xs font-medium uppercase tracking-wide text-stone-500">
          Tratamento
          <input
            value={tratamento}
            onChange={(e) => setTratamento(e.target.value.toUpperCase())}
            className={`${INPUT} mt-1 normal-case`}
          />
        </label>
        <label className="text-xs font-medium uppercase tracking-wide text-stone-500">
          PMS (g)
          <input
            value={pms}
            onChange={(e) => setPms(e.target.value)}
            placeholder="ex.: 171"
            inputMode="decimal"
            className={`${INPUT} mt-1 normal-case`}
          />
        </label>
        <label className="text-xs font-medium uppercase tracking-wide text-stone-500">
          Peso/bag (kg)
          <div className="mt-1 flex gap-2">
            <select
              value={fator}
              onChange={(e) => setFator(Number(e.target.value))}
              className={`${INPUT} w-28 normal-case`}
              title="Fator da embalagem: define a sugestão PMS × fator"
            >
              <option value={5}>BG5M ×5</option>
              <option value={2.5}>MEIOBAG ×2,5</option>
            </select>
            <input
              value={pesoBag}
              onChange={(e) => setPesoBag(e.target.value)}
              placeholder={sugestao != null ? `${sugestao} (PMS × ${fator})` : 'kg'}
              inputMode="decimal"
              className={`${INPUT} normal-case`}
            />
          </div>
        </label>
        <label className="text-xs font-medium uppercase tracking-wide text-stone-500">
          Bags disponíveis
          <input
            value={bags}
            onChange={(e) => setBags(e.target.value)}
            placeholder="ex.: 20"
            inputMode="numeric"
            className={`${INPUT} mt-1 normal-case`}
          />
        </label>
      </div>
      <p className="mt-2 text-xs text-stone-500">
        Peso/bag em branco usa a sugestão PMS × fator. O lote entra como <b>Em estoque</b>.
      </p>
      <div className="mt-3">
        <Botao
          variante="primario"
          disabled={!valido}
          onClick={() =>
            onSalvar({
              id: id.trim(),
              cultivar: cultivar.trim(),
              tratamento: tratamento.trim() || null,
              pms: Number.isFinite(pmsNum) && pmsNum > 0 ? pmsNum : null,
              peso_bag_kg: pesoNum,
              bags_disp: bagsNum,
            })
          }
        >
          Cadastrar lote
        </Botao>
      </div>
    </div>
  )
}
