import { useCallback, useEffect, useState } from 'react'
import * as adm from '@/dados/api-admin'
import type { PermissaoLinha, UsuarioLinha } from '@/dados/api-admin'
import type { Perfil } from '@/dominio/tipos'
import {
  ACOES_POR_RECURSO, ROTULO_ACAO, permissaoEfetiva, permitidoPadrao,
} from '@/dominio/permissoes'
import { useAuth } from '@/auth/AuthProvider'
import { useRascunho } from '@/lib/useRascunho'
import { Aviso, Botao, Cartao, Erro, Pagina, Tabela, Tag, Vazio } from '@/componentes/ui'

const PERFIS: Perfil[] = ['PCP', 'Logistica', 'Producao', 'Qualidade', 'Direcao', 'Gestor']

export default function Administracao() {
  const { usuario } = useAuth()
  const ehGestor = usuario?.perfil === 'Gestor'

  const [usuarios, setUsuarios] = useState<UsuarioLinha[]>([])
  const [permissoes, setPermissoes] = useState<PermissaoLinha[]>([])
  const [perfilSel, setPerfilSel] = useState<Perfil>('PCP')
  const [novo, setNovo] = useState(false)
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)

  const recarregar = useCallback(async () => {
    const [u, p] = await Promise.all([adm.listarUsuarios(), adm.listarPermissoes()])
    setUsuarios(u)
    setPermissoes(p)
  }, [])

  useEffect(() => {
    setCarregando(true)
    recarregar()
      .catch((e) => setErro(e instanceof Error ? e.message : String(e)))
      .finally(() => setCarregando(false))
  }, [recarregar])

  async function acao(fn: () => Promise<void>) {
    try {
      setErro(null)
      await fn()
      await recarregar()
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    }
  }

  // valor EFETIVO: o que o gestor gravou manda; célula nunca gravada segue o
  // padrão do perfil — é o que o usuário logado vê de verdade.
  const doPerfil = permissoes.filter((p) => p.perfil === perfilSel)
  const permitido = (recurso: string, acaoNome: string) =>
    permissaoEfetiva(perfilSel, recurso, acaoNome, doPerfil)
  const mexida = (recurso: string, acaoNome: string) => {
    const linha = doPerfil.find((p) => p.recurso === recurso && p.acao === acaoNome)
    return linha != null && linha.permitido !== permitidoPadrao(perfilSel, recurso, acaoNome)
  }

  if (carregando) return <p className="p-8 text-sm text-stone-500">Carregando administração…</p>

  if (!ehGestor) {
    return (
      <Pagina titulo="Administração">
        <Aviso gravidade="bloqueio">
          Apenas o perfil Gestor administra usuários e permissões.
        </Aviso>
      </Pagina>
    )
  }

  return (
    <Pagina
      titulo="Administração"
      descricao="Usuários nominais e matriz de permissões por perfil."
    >
      {erro && <Erro>{erro}</Erro>}

      <Cartao
        titulo={`Usuários (${usuarios.length})`}
        acoes={
          <Botao variante="primario" onClick={() => setNovo((v) => !v)}>
            {novo ? 'Cancelar' : 'Novo usuário'}
          </Botao>
        }
        className="mb-5"
      >
        <div className="mb-3">
          <Aviso>
            São <b>dois passos</b>, porque criar senha só acontece no Supabase.
            <br />
            <b>1.</b> No painel do Supabase, <b>Authentication → Users → Add user</b>: informe
            e-mail e uma senha inicial, e copie o <b>UUID</b> que aparece na lista.
            <br />
            <b>2.</b> Aqui em <b>Novo usuário</b>: cole o UUID, informe o nome e escolha o
            perfil.
            <br />
            Sem o passo 2 a pessoa consegue entrar, mas o RLS bloqueia tudo e ela vê a tela de
            &quot;usuário sem perfil cadastrado&quot;.
          </Aviso>
        </div>

        {novo && (
          <div className="mb-4 rounded-md border border-stone-200 p-4 dark:border-stone-700">
            <FormNovoUsuario
              onSalvar={(u) =>
                acao(async () => {
                  await adm.salvarUsuario(u)
                  setNovo(false)
                })
              }
              onCancelar={() => setNovo(false)}
            />
          </div>
        )}

        {usuarios.length === 0 ? (
          <Vazio>Nenhum usuário cadastrado.</Vazio>
        ) : (
          <Tabela cabecalho={[
            'Nome', 'Perfil', 'Situação',
            { texto: 'Desde', className: 'hidden lg:table-cell' },
            '',
          ]}>
            {usuarios.map((u) => (
              <LinhaUsuario
                key={u.id}
                usuario={u}
                ehVoce={u.id === usuario?.id}
                acao={acao}
              />
            ))}
          </Tabela>
        )}
      </Cartao>

      <Cartao
        titulo="Matriz de permissões"
        acoes={
          <div className="flex items-center gap-2">
            {doPerfil.length > 0 && (
              <Botao
                onClick={() =>
                  acao(async () => {
                    if (!confirm(`Descartar os ajustes de ${perfilSel} e voltar ao padrão?`)) return
                    await adm.restaurarPadrao(perfilSel)
                  })
                }
              >
                Restaurar padrão
              </Botao>
            )}
            <select
              value={perfilSel}
              onChange={(e) => setPerfilSel(e.target.value as Perfil)}
              className="rounded-md border border-stone-300 px-2 py-2 text-sm sm:py-1 dark:border-stone-700 dark:bg-stone-800"
            >
              {PERFIS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
        }
      >
        <div className="mb-3">
          <Aviso>
            A navegação e os botões <b>obedecem a esta matriz</b>. Célula que você nunca mexeu
            segue o padrão do perfil; a marcação em <b>âmbar</b> é ajuste seu sobre o padrão.
            Mudanças valem no próximo carregamento da página de quem estiver logado. A proteção
            de verdade continua sendo o RLS no banco — esconder o botão não substitui o
            PostgreSQL.
          </Aviso>
        </div>

        <Tabela cabecalho={['Recurso', 'Ações']}>
          {Object.keys(ACOES_POR_RECURSO).map((recurso) => (
            <tr key={recurso} className="border-t border-stone-100 dark:border-stone-800/60">
              <td className="px-2 py-2 font-medium capitalize">{recurso}</td>
              <td className="px-2 py-2">
                <div className="flex flex-wrap gap-3">
                  {(ACOES_POR_RECURSO[recurso] ?? ['ver']).map((a) => (
                    <label
                      key={a}
                      className={`flex items-center gap-1.5 rounded px-1 py-1.5 text-sm ${
                        mexida(recurso, a)
                          ? 'bg-amber-100 dark:bg-amber-950/60'
                          : ''
                      }`}
                      title={
                        mexida(recurso, a)
                          ? 'Ajustado pelo gestor — difere do padrão do perfil'
                          : undefined
                      }
                    >
                      <input
                        type="checkbox"
                        checked={permitido(recurso, a)}
                        onChange={(e) =>
                          acao(() =>
                            adm.salvarPermissao({
                              perfil: perfilSel,
                              recurso,
                              acao: a,
                              permitido: e.target.checked,
                            }),
                          )
                        }
                      />
                      {ROTULO_ACAO[a] ?? a}
                    </label>
                  ))}
                </div>
              </td>
            </tr>
          ))}
        </Tabela>
      </Cartao>
    </Pagina>
  )
}

/** O UUID vem do Supabase Auth; só o formato é validado aqui. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function FormNovoUsuario({
  onSalvar, onCancelar,
}: {
  onSalvar: (u: { id: string; nome: string; perfil: Perfil; ativo: boolean }) => void
  onCancelar: () => void
}) {
  const { valor, definir, limpar } = useRascunho('usuario.novo', {
    id: '', nome: '', perfil: 'Producao' as Perfil,
  })
  const { id, nome, perfil } = valor
  const setId = (v: string) => definir({ id: v })
  const setNome = (v: string) => definir({ nome: v })
  const setPerfil = (v: Perfil) => definir({ perfil: v })

  const idLimpo = id.trim()
  const idValido = UUID.test(idLimpo)

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-xs font-medium uppercase tracking-wide text-stone-500">
          UUID do login
          <input
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="cole de Authentication → Users"
            className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1.5 font-mono text-xs normal-case dark:border-stone-700 dark:bg-stone-800"
          />
        </label>
        <label className="text-xs font-medium uppercase tracking-wide text-stone-500">
          Nome da pessoa
          <input
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            placeholder="quem aparece no apontamento"
            className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1.5 text-sm normal-case dark:border-stone-700 dark:bg-stone-800"
          />
        </label>
        <label className="text-xs font-medium uppercase tracking-wide text-stone-500">
          Perfil
          <select
            value={perfil}
            onChange={(e) => setPerfil(e.target.value as Perfil)}
            className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1.5 text-sm normal-case dark:border-stone-700 dark:bg-stone-800"
          >
            {PERFIS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
      </div>

      <p className="mt-2 text-xs text-stone-500">
        O apontamento registra <b>a pessoa</b>, não o perfil — por isso cada operador precisa do
        seu próprio login. {DESCRICAO_PERFIL[perfil]}
      </p>

      {idLimpo !== '' && !idValido && (
        <div className="mt-3">
          <Aviso gravidade="bloqueio">
            Isso não parece um UUID. Copie o valor da coluna <b>UID</b> em Authentication →
            Users — tem 36 caracteres, no formato
            <code> 08050b65-fbb8-425e-b879-747ec0d5d814</code>.
          </Aviso>
        </div>
      )}

      <div className="mt-4 flex gap-2">
        <Botao
          variante="primario"
          disabled={!idValido || !nome.trim()}
          onClick={() => {
            onSalvar({ id: idLimpo, nome: nome.trim(), perfil, ativo: true })
            limpar()
          }}
        >
          Cadastrar
        </Botao>
        <Botao onClick={onCancelar}>Cancelar</Botao>
      </div>
    </div>
  )
}

/** O que cada perfil enxerga, para escolher sem consultar a documentação. */
const DESCRICAO_PERFIL: Record<Perfil, string> = {
  PCP: 'Vê todas as telas menos Administração; cria e programa ordens, importa planilhas e lança no AGROTIS.',
  Logistica: 'Vê Programação, Lotes e Indicadores; é quem baixa e estorna lote de semente.',
  Producao: 'Vê Programação, Execução e Indicadores; aponta início, paradas, fim e os pesos de tanque.',
  Qualidade: 'Vê Execução, Qualidade e Indicadores; aponta a avaliação visual e a retirada de amostra.',
  Direcao: 'Somente leitura: enxerga todas as telas da operação e baixa os relatórios, sem alterar nada.',
  Gestor: 'Vê tudo, inclusive Administração. Use com parcimônia.',
}

function LinhaUsuario({
  usuario, ehVoce, acao,
}: {
  usuario: UsuarioLinha
  ehVoce: boolean
  acao: (fn: () => Promise<void>) => Promise<void>
}) {
  const [edit, setEdit] = useState(false)
  const [nome, setNome] = useState(usuario.nome)
  const [perfil, setPerfil] = useState<Perfil>(usuario.perfil)
  const [ativo, setAtivo] = useState(usuario.ativo)

  const salvar = () =>
    acao(async () => {
      await adm.salvarUsuario({ id: usuario.id, nome, perfil, ativo })
      setEdit(false)
    })

  if (!edit) {
    return (
      <tr className="border-t border-stone-100 dark:border-stone-800/60">
        <td className="px-2 py-2 font-medium">
          {usuario.nome}
          {ehVoce && <span className="ml-2 text-xs text-stone-400">(você)</span>}
        </td>
        <td className="px-2 py-2"><Tag>{usuario.perfil}</Tag></td>
        <td className="px-2 py-2">
          <Tag cor={usuario.ativo ? 'ok' : 'neutro'}>{usuario.ativo ? 'Ativo' : 'Inativo'}</Tag>
        </td>
        <td className="hidden px-2 py-2 text-stone-500 lg:table-cell">
          {new Date(usuario.criado_em).toLocaleDateString('pt-BR')}
        </td>
        <td className="px-2 py-2 text-right">
          <button
            onClick={() => setEdit(true)}
            className="-m-1.5 rounded p-1.5 text-xs underline"
          >
            editar
          </button>
        </td>
      </tr>
    )
  }

  return (
    <tr className="border-t border-stone-100 dark:border-stone-800/60">
      <td className="px-2 py-2">
        {/* w-full+max-w: sem largura definida, o input ficava com a largura
            intrínseca do navegador (~170px) e empurrava salvar/cancelar
            para fora da tela no celular */}
        <input
          value={nome}
          onChange={(e) => setNome(e.target.value)}
          className="w-full max-w-32 rounded-md border border-stone-300 px-2 py-2 text-sm sm:py-1 dark:border-stone-700 dark:bg-stone-800"
        />
      </td>
      <td className="px-2 py-2">
        <select
          value={perfil}
          onChange={(e) => setPerfil(e.target.value as Perfil)}
          disabled={ehVoce}
          title={ehVoce ? 'Você não pode mudar o próprio perfil — evita perder o acesso de gestor' : undefined}
          className="w-full max-w-28 rounded-md border border-stone-300 px-2 py-2 text-sm disabled:opacity-50 sm:py-1 dark:border-stone-700 dark:bg-stone-800"
        >
          {PERFIS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </td>
      <td className="px-2 py-2">
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={ativo}
            disabled={ehVoce}
            onChange={(e) => setAtivo(e.target.checked)}
          />
          Ativo
        </label>
      </td>
      {/* mesma coluna "Desde" escondida no celular — precisa bater com a
          linha de visualização, senão as colunas desalinham entre linhas */}
      <td className="hidden lg:table-cell" />
      <td className="px-2 py-2 text-right whitespace-nowrap">
        <Botao onClick={salvar}>salvar</Botao>
        <span className="ml-2">
          <button
            onClick={() => setEdit(false)}
            className="-m-1.5 rounded p-1.5 text-xs text-stone-500 underline"
          >
            cancelar
          </button>
        </span>
      </td>
    </tr>
  )
}
