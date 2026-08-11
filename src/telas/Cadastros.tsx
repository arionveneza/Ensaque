import { useCallback, useEffect, useMemo, useState } from 'react'
import * as api from '@/dados/api'
import * as g from '@/dados/api-gestao'
import * as adm from '@/dados/api-admin'
import type { ReceitaCompleta } from '@/dados/api-gestao'
import { capacidadeDiaT, pesoItemKg } from '@/dominio/calculos'
import {
  CLASSES_AGRONOMICAS,
  type ClasseAgronomica, type ProdutoQuimico, type TipoParada, type UnidadeDose,
} from '@/dominio/tipos'
import { useAuth } from '@/auth/AuthProvider'
import { useRascunho } from '@/lib/useRascunho'
import { Aviso, Botao, Cartao, Erro, Pagina, Tabela, Tag, Vazio, inteiro, n } from '@/componentes/ui'

/** Peso de referência usado só para exibir a receita numa escala legível. */
const REFERENCIA_KG = 40_000

// py-2 no celular (~40px de alvo de toque, usado por TODO input/select/date
// desta tela); sm: devolve py-1, que é o que desktop/tablet já tinham
const INPUT =
  'rounded-md border border-stone-300 px-2 py-2 text-sm sm:py-1 dark:border-stone-700 dark:bg-stone-800'

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

  // sobrevive a recarregar a página (F5, aba suspensa em segundo plano) —
  // sem isto, um reload trocava a aba para "Produtos químicos" e escondia
  // o formulário que estava aberto, mesmo com o rascunho dele intacto
  const abaRasc = useRascunho<{ aba: Aba }>('cadastros-aba', { aba: 'quimicos' })
  const aba = abaRasc.valor.aba
  const setAba = (v: Aba) => abaRasc.definir({ aba: v })
  const [cad, setCad] = useState<Awaited<ReturnType<typeof api.carregarCadastros>> | null>(null)
  const [receitas, setReceitas] = useState<ReceitaCompleta[]>([])
  const [embalagens, setEmbalagens] = useState<g.EmbalagemLinha[]>([])
  const [turnos, setTurnos] = useState<g.TurnoLinha[]>([])
  const [lotes, setLotes] = useState<g.LoteSementeLinha[]>([])
  const [principios, setPrincipios] = useState<adm.PrincipioLinha[]>([])
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)

  const recarregar = useCallback(async () => {
    const [c, r, e, t, l, pa] = await Promise.all([
      api.carregarCadastros(), g.listarReceitas(), g.listarEmbalagens(),
      g.listarTurnos(), g.listarLotes(), adm.listarPrincipios(),
    ])
    setCad(c); setReceitas(r); setEmbalagens(e); setTurnos(t); setLotes(l)
    setPrincipios(pa)
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

      {/* rola em 1 linha no celular em vez de empilhar 3 linhas de aba antes
          de qualquer conteúdo — mesmo padrão da navegação principal */}
      <nav className="scroll-oculto mb-5 flex gap-2 overflow-x-auto">
        {ABAS.map((a) => (
          <button
            key={a.id}
            onClick={() => setAba(a.id)}
            className={`shrink-0 rounded-md border px-3 py-2.5 text-sm whitespace-nowrap sm:py-1.5 ${
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
          principios={principios}
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
  produtos, principios, podeEditar, acao,
}: {
  produtos: api.LinhaProduto[]
  principios: adm.PrincipioLinha[]
  podeEditar: boolean
  acao: Acao
}) {
  // qual produto está aberto (id, 'novo' ou nenhum) sobrevive a recarregar a
  // página — sem isto, o rascunho do FormProduto ficava salvo mas invisível,
  // porque a tabela nem mostrava o formulário aberto de novo
  const abertoRasc = useRascunho<{ aberto: string | 'novo' | null }>(
    'cadastros-quimico-aberto',
    { aberto: null },
  )
  const editando = abertoRasc.valor.aberto !== 'novo' ? abertoRasc.valor.aberto : null
  const novo = abertoRasc.valor.aberto === 'novo'
  const setEditando = (id: string | null) => abertoRasc.definir({ aberto: id })
  const setNovo = (v: boolean) => abertoRasc.definir({ aberto: v ? 'novo' : null })

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
        <Tabela cabecalho={['Produto', 'Código', 'Unidade', '#Densidade',
          'Princípios ativos', '']}>
          {produtos.map((p) => {
            const doProduto = principios.filter((x) => x.produto_id === p.id)
            return editando === p.id ? (
              <tr key={p.id} className="border-t border-stone-100 dark:border-stone-800/60">
                <td colSpan={6} className="px-2 py-3">
                  <FormProduto
                    inicial={p}
                    inicialPrincipios={doProduto}
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
                <td className="num-tabular px-2 py-2 text-right whitespace-nowrap">
                  {!p.unidade.startsWith('ml') ? (
                    <span className="text-stone-400">— dose já em peso</span>
                  ) : p.densidade == null ? (
                    <span className="font-medium text-red-600">falta densidade</span>
                  ) : (
                    `${n(p.densidade, 3)} g/ml`
                  )}
                </td>
                <td className="px-2 py-2">
                  {doProduto.length === 0 ? (
                    <span className="text-xs text-stone-400">—</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {doProduto.map((a) => (
                        <span key={a.id} title={`${a.nome} · ${a.classe}`}>
                          <Tag cor={COR_CLASSE[a.classe] ?? 'neutro'}>
                            {a.nome}
                            {a.concentracao != null && ` ${n(a.concentracao, 0)} ${a.unidade_conc}`}
                          </Tag>
                        </span>
                      ))}
                    </div>
                  )}
                </td>
                <td className="px-2 py-2 text-right">
                  {podeEditar && (
                    <button onClick={() => setEditando(p.id)} className="-m-1.5 rounded p-1.5 text-xs underline">
                      editar
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </Tabela>
      </Cartao>
    </>
  )
}

/** Linha do princípio ativo no formulário — concentração como texto por causa da vírgula. */
interface PrincipioForm {
  nome: string
  concTxt: string
  unidade_conc: 'g/L' | 'g/kg' | '%'
  classe: ClasseAgronomica
}

const PRINCIPIO_VAZIO: PrincipioForm = {
  nome: '', concTxt: '', unidade_conc: 'g/L', classe: 'Fungicida',
}

const COR_CLASSE: Record<string, 'ok' | 'alerta' | 'info' | 'roxo' | 'perigo' | 'neutro'> = {
  Fungicida: 'info',
  Inseticida: 'perigo',
  Biologico: 'ok',
  Nematicida: 'roxo',
  Inoculante: 'alerta',
  Outros: 'neutro',
}

function FormProduto({
  inicial, inicialPrincipios = [], onSalvar, onCancelar,
}: {
  inicial?: api.LinhaProduto
  inicialPrincipios?: adm.PrincipioLinha[]
  onSalvar: (p: adm.ProdutoEdicao) => void
  onCancelar: () => void
}) {
  const inicialForm = useMemo(
    () => ({
      codigo: inicial?.codigo ?? '',
      nome: inicial?.nome ?? '',
      // produto novo nasce em ml/100kg: é a base que as bulas de TSI usam
      unidade: (inicial?.unidade ?? 'ml/100kg') as UnidadeDose,
      densidade: inicial?.densidade?.toString() ?? '',
      principios:
        inicialPrincipios.length > 0
          ? inicialPrincipios.map((x) => ({
              nome: x.nome,
              concTxt: x.concentracao == null ? '' : String(x.concentracao).replace('.', ','),
              unidade_conc: x.unidade_conc,
              classe: x.classe,
            }))
          : [PRINCIPIO_VAZIO],
    }),
    [inicial, inicialPrincipios],
  )
  const { valor, definir, limpar } = useRascunho(
    inicial ? `produto.${inicial.id}` : 'produto.novo',
    inicialForm,
  )
  const { codigo, nome, unidade, densidade, principios } = valor
  const setCodigo = (v: string) => definir({ codigo: v })
  const setNome = (v: string) => definir({ nome: v })
  const setUnidade = (v: UnidadeDose) => definir({ unidade: v })
  const setDensidade = (v: string) => definir({ densidade: v })
  const setPrincipios = (v: PrincipioForm[]) => definir({ principios: v })
  const atualizaPrincipio = (i: number, campo: Partial<PrincipioForm>) =>
    setPrincipios(principios.map((p, idx) => (idx === i ? { ...p, ...campo } : p)))

  const emMl = unidade.startsWith('ml')
  const dens = densidade.trim() === '' ? null : Number(densidade.replace(',', '.'))
  const faltaDensidade = emMl && (dens == null || !(dens > 0))

  const principiosParaSalvar = () =>
    principios
      .filter((p) => p.nome.trim() !== '')
      .map((p) => {
        const c = parseFloat(p.concTxt.trim().replace(',', '.'))
        return {
          nome: p.nome.trim(),
          concentracao: Number.isFinite(c) ? c : null,
          unidade_conc: p.unidade_conc,
          classe: p.classe,
        }
      })

  return (
    <div>
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
    </div>

    {/* ---------------- princípios ativos ---------------- */}
    <div className="mt-4 border-t border-stone-200 pt-3 dark:border-stone-700">
      <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
        Princípios ativos
      </p>
      <p className="mb-2 text-xs text-stone-500">
        Um produto pode ter vários — cada um com a própria classe, porque é comum o mesmo
        produto juntar fungicida e inseticida. Copie nome e concentração da bula.
      </p>
      <div className="space-y-2">
        {principios.map((pa, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-stone-500">
              Princípio ativo
              <input
                value={pa.nome}
                onChange={(e) => atualizaPrincipio(i, { nome: e.target.value })}
                placeholder="ex.: Tiametoxam"
                className={`${INPUT} mt-1 block w-52`}
              />
            </label>
            <label className="text-xs text-stone-500">
              Concentração
              <div className="mt-1 flex gap-1">
                <input
                  value={pa.concTxt}
                  onChange={(e) => atualizaPrincipio(i, { concTxt: e.target.value })}
                  placeholder="ex.: 350"
                  inputMode="decimal"
                  className={`${INPUT} w-24 text-right`}
                />
                <select
                  value={pa.unidade_conc}
                  onChange={(e) =>
                    atualizaPrincipio(i, {
                      unidade_conc: e.target.value as PrincipioForm['unidade_conc'],
                    })
                  }
                  className={`${INPUT} w-20`}
                >
                  <option value="g/L">g/L</option>
                  <option value="g/kg">g/kg</option>
                  <option value="%">%</option>
                </select>
              </div>
            </label>
            <label className="text-xs text-stone-500">
              Classe
              <select
                value={pa.classe}
                onChange={(e) =>
                  atualizaPrincipio(i, { classe: e.target.value as ClasseAgronomica })
                }
                className={`${INPUT} mt-1 block w-36`}
              >
                {CLASSES_AGRONOMICAS.map((c) => (
                  <option key={c} value={c}>{c === 'Biologico' ? 'Biológico' : c}</option>
                ))}
              </select>
            </label>
            <button
              onClick={() => setPrincipios(principios.filter((_, idx) => idx !== i))}
              disabled={principios.length === 1}
              className="-m-1.5 rounded p-1.5 pb-1.5 text-xs text-red-600 underline disabled:opacity-30"
            >
              remover
            </button>
          </div>
        ))}
      </div>
      <div className="mt-2">
        <Botao onClick={() => setPrincipios([...principios, PRINCIPIO_VAZIO])}>
          Adicionar princípio ativo
        </Botao>
      </div>
    </div>

    <div className="mt-4 flex gap-2">
      <Botao
        variante="primario"
        disabled={!codigo.trim() || !nome.trim() || faltaDensidade}
        titulo={faltaDensidade ? `Produto em ${unidade} exige densidade da FISPQ` : undefined}
        onClick={() => {
          onSalvar({
            codigo, nome, unidade, densidade: dens,
            principios: principiosParaSalvar(),
          })
          limpar()
        }}
      >
        Salvar
      </Botao>
      <Botao onClick={onCancelar}>Cancelar</Botao>
    </div>
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
  // qual receita está aberta (nome, 'nova' ou nenhuma) sobrevive a
  // recarregar a página — sem isto, o rascunho do FormReceita ficava salvo
  // mas invisível, porque a tela nem mostrava o formulário aberto de novo
  const abertaRasc = useRascunho<{ aberta: string | 'nova' | null }>(
    'cadastros-receita-aberta',
    { aberta: null },
  )
  const editando = abertaRasc.valor.aberta
  const setEditando = (v: string | 'nova' | null) => abertaRasc.definir({ aberta: v })

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
                  produto_id: i.produto_id, dose: i.dose,
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
  return (
    <>
      <p className="mb-2 text-xs text-stone-500">
        Valores para {inteiro(REFERENCIA_KG)} kg de semente. O <b>tanque de cada produto</b> é
        escolhido pelo operador ao preparar a ordem.
      </p>
      <Tabela cabecalho={['Produto', '#Dose', '#Densidade', '#Peso de balança']}>
        {receita.receita_itens.map((i) => {
          const q = i.produtos_quimicos
          const produto: ProdutoQuimico = {
            id: i.produto_id, codigo: q.codigo, nome: q.nome,
            unidade: q.unidade, densidade: q.densidade,
          }
          let peso: number | null = null
          try {
            peso = pesoItemKg({ produtoId: i.produto_id, dose: i.dose }, produto, REFERENCIA_KG)
          } catch { peso = null }
          return (
            <tr key={i.produto_id} className="border-t border-stone-100 dark:border-stone-800/60">
              <td className="px-2 py-1.5">{q.nome}</td>
              <td className="num-tabular px-2 py-1.5 text-right whitespace-nowrap">{n(i.dose, 2)} {q.unidade}</td>
              <td className="num-tabular px-2 py-1.5 text-right whitespace-nowrap">
                {q.densidade == null ? '—' : `${n(q.densidade, 3)} g/ml`}
              </td>
              <td className="num-tabular px-2 py-1.5 text-right font-medium whitespace-nowrap">
                {peso == null ? <span className="text-red-600">densidade ausente</span> : `${n(peso, 1)} kg`}
              </td>
            </tr>
          )
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
  // sobrevive a sair da tela ou trocar de aba — a navegação desmonta o
  // componente e o React descartaria a receita inteira digitada
  const inicial = useMemo(
    () => ({
      nome: inicialNome,
      itens:
        inicialItens.length > 0
          ? inicialItens.map((i) => ({
              produto_id: i.produto_id,
              doseTxt: String(i.dose).replace('.', ','),
            }))
          : [{ produto_id: '', doseTxt: '' }],
    }),
    [inicialNome, inicialItens],
  )
  const { valor, definir, limpar, recuperado } = useRascunho(
    inicialNome ? `receita.${inicialNome}` : 'receita.nova',
    inicial,
  )
  const { nome, itens } = valor
  const setNome = (v: string) => definir({ nome: v })
  const setItens = (v: ItemReceitaForm[]) => definir({ itens: v })

  const atualizar = (i: number, campo: Partial<ItemReceitaForm>) =>
    setItens(itens.map((it, idx) => (idx === i ? { ...it, ...campo } : it)))

  const unidadeDe = (produtoId: string) =>
    produtos.find((p) => p.id === produtoId)?.unidade

  return (
    <div>
      {recuperado && (
        <div className="mb-3">
          <Aviso>
            <b>Rascunho recuperado.</b> A receita que você estava montando foi restaurada.{' '}
            <button onClick={limpar} className="underline">descartar</button>
          </Aviso>
        </div>
      )}
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
            <button
              onClick={() => setItens(itens.filter((_, idx) => idx !== i))}
              disabled={itens.length === 1}
              className="-m-1.5 rounded p-1.5 pb-1.5 text-xs text-red-600 underline disabled:opacity-30"
            >
              remover
            </button>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Botao onClick={() => setItens([...itens, { produto_id: '', doseTxt: '' }])}>
          Adicionar produto
        </Botao>
        <span className="text-xs text-stone-500">
          {itens.length} produto(s) — o <b>tanque</b> é informado pelo operador na ordem,
          porque a distribuição muda a cada uma.
        </span>
      </div>

      <div className="mt-4 flex gap-2">
        <Botao
          variante="primario"
          disabled={!nome.trim() || itens.some((i) => !i.produto_id || !(doseNumero(i.doseTxt) > 0))}
          onClick={() => {
            onSalvar(
              nome,
              itens.map((i) => ({
                produto_id: i.produto_id,
                dose: doseNumero(i.doseTxt),
              })),
            )
            limpar() // gravou: o rascunho não serve mais
          }}
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
  // a capacidade de cada turno é a coluna que o PCP usa quando o dia roda um
  // turno só — a soma sozinha não dizia quanto rende um sábado de 1º turno
  const cabecalho = [
    'Máquina',
    '#Capacidade (t/h)',
    '#Tanques',
    ...turnos.map((t) => `#${t.nome} (${n(Number(t.horas), 1)} h)`),
    '#Cap. dia',
    '',
  ]
  return (
    <>
      <Cartao titulo="Máquinas e capacidade" className="mb-5">
        <Tabela cabecalho={cabecalho}>
          {maquinas.map((m) => (
            <LinhaMaquinaEdit key={m.id} maquina={m} horas={horas} podeEditar={podeEditar} acao={acao} />
          ))}
        </Tabela>
        <p className="mt-3 text-xs text-stone-500">
          A capacidade de cada turno é a capacidade horária multiplicada pelas horas daquele
          turno; a do dia é a soma dos dois. Um dia que roda um turno só rende apenas a coluna
          correspondente — quais turnos cada dia roda é definido na tela de Programação.
          Mudar a capacidade horária altera a ocupação e o tempo planejado de toda ordem futura.
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
        {horas.map((h, i) => (
          <td key={i} className="num-tabular px-2 py-2 text-right whitespace-nowrap text-stone-600 dark:text-stone-300">
            {n(maquina.capacidade_th * h, 0)} t
          </td>
        ))}
        <td className="num-tabular px-2 py-2 text-right font-semibold whitespace-nowrap">
          {n(capacidadeDiaT(maquina.capacidade_th, horas), 0)} t
        </td>
        <td className="px-2 py-2 text-right">
          {podeEditar && <button onClick={() => setEdit(true)} className="-m-1.5 rounded p-1.5 text-xs underline">editar</button>}
        </td>
      </tr>
    )
  }
  return (
    <tr className="border-t border-stone-100 dark:border-stone-800/60">
      <td className="px-2 py-2"><input value={nome} onChange={(e) => setNome(e.target.value)} className={`${INPUT} w-28`} /></td>
      <td className="px-2 py-2 text-right"><input value={cap} onChange={(e) => setCap(e.target.value)} className={`${INPUT} w-20 text-right`} /></td>
      <td className="px-2 py-2 text-right"><input value={tanques} onChange={(e) => setTanques(e.target.value)} className={`${INPUT} w-16 text-right`} /></td>
      {horas.map((_, i) => (
        <td key={i} />
      ))}
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
          className="-my-1.5 mr-2 rounded px-1.5 py-1.5 text-xs underline"
        >
          salvar
        </button>
        <button onClick={() => setEdit(false)} className="-m-1.5 rounded p-1.5 text-xs text-stone-500 underline">cancelar</button>
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
          {podeEditar && <button onClick={() => setEdit(true)} className="-m-1.5 rounded p-1.5 text-xs underline">editar</button>}
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
          className="-my-1.5 mr-2 rounded px-1.5 py-1.5 text-xs underline"
        >
          salvar
        </button>
        <button onClick={() => setEdit(false)} className="-m-1.5 rounded p-1.5 text-xs text-stone-500 underline">cancelar</button>
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
        <td className="num-tabular px-2 py-2 text-right whitespace-nowrap">PMS × {n(emb.fator_peso, 1)}</td>
        <td className="px-2 py-2 text-right">
          {podeEditar && <button onClick={() => setEdit(true)} className="-m-1.5 rounded p-1.5 text-xs underline">editar</button>}
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
          className="-my-1.5 mr-2 rounded px-1.5 py-1.5 text-xs underline"
        >
          salvar
        </button>
        <button onClick={() => setEdit(false)} className="-m-1.5 rounded p-1.5 text-xs text-stone-500 underline">cancelar</button>
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
                  className="-m-1.5 rounded p-1.5 text-xs text-red-600 underline"
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
            <td className="num-tabular px-2 py-1.5 text-right whitespace-nowrap">{n(l.peso_bag_kg, 0)} kg</td>
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
                  className="-m-1.5 rounded p-1.5 text-xs text-red-600 underline"
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
  const { valor, definir, limpar } = useRascunho('lote.novo', {
    id: '', cultivar: '', tratamento: 'SEM TSI',
    pms: '', fator: 5, pesoBag: '', bags: '',
  })
  const { id, cultivar, tratamento, pms, fator, pesoBag, bags } = valor
  const setId = (v: string) => definir({ id: v })
  const setCultivar = (v: string) => definir({ cultivar: v })
  const setTratamento = (v: string) => definir({ tratamento: v })
  const setPms = (v: string) => definir({ pms: v })
  const setFator = (v: number) => definir({ fator: v })
  const setPesoBag = (v: string) => definir({ pesoBag: v })
  const setBags = (v: string) => definir({ bags: v })

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
          onClick={() => {
            onSalvar({
              id: id.trim(),
              cultivar: cultivar.trim(),
              tratamento: tratamento.trim() || null,
              pms: Number.isFinite(pmsNum) && pmsNum > 0 ? pmsNum : null,
              peso_bag_kg: pesoNum,
              bags_disp: bagsNum,
            })
            limpar()
          }}
        >
          Cadastrar lote
        </Botao>
      </div>
    </div>
  )
}
