import { useCallback, useEffect, useState } from 'react'
import * as adm from '@/dados/api-admin'
import type { PermissaoLinha, UsuarioLinha } from '@/dados/api-admin'
import type { Perfil } from '@/dominio/tipos'
import { useAuth } from '@/auth/AuthProvider'
import { Aviso, Botao, Cartao, Erro, Pagina, Tabela, Tag, Vazio } from '@/componentes/ui'

const PERFIS: Perfil[] = ['PCP', 'Logistica', 'Producao', 'Qualidade', 'Gestor']

/** Ações que fazem sentido em cada recurso — evita uma matriz cheia de célula inútil. */
const ACOES_POR_RECURSO: Record<string, string[]> = {
  ordens: ['ver', 'criar', 'editar', 'excluir', 'priorizar'],
  programacao: ['ver', 'editar'],
  lotes: ['ver', 'baixar_lote'],
  execucao: ['ver', 'apontar'],
  qualidade: ['ver', 'qualidade', 'agrotis'],
  indicadores: ['ver'],
  cadastros: ['ver', 'editar'],
}

const ROTULO_ACAO: Record<string, string> = {
  ver: 'Ver',
  criar: 'Criar',
  editar: 'Editar',
  excluir: 'Excluir',
  priorizar: 'Priorizar',
  baixar_lote: 'Baixar lote',
  apontar: 'Apontar',
  qualidade: 'Apontar qualidade',
  agrotis: 'Lançar AGROTIS',
}

export default function Administracao() {
  const { usuario } = useAuth()
  const ehGestor = usuario?.perfil === 'Gestor'

  const [usuarios, setUsuarios] = useState<UsuarioLinha[]>([])
  const [permissoes, setPermissoes] = useState<PermissaoLinha[]>([])
  const [perfilSel, setPerfilSel] = useState<Perfil>('PCP')
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

  const permitido = (recurso: string, acaoNome: string) =>
    permissoes.find(
      (p) => p.perfil === perfilSel && p.recurso === recurso && p.acao === acaoNome,
    )?.permitido ?? false

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

      <Cartao titulo={`Usuários (${usuarios.length})`} className="mb-5">
        <div className="mb-3">
          <Aviso>
            Criar o login é feito em <b>Authentication → Users</b> no painel do Supabase, porque
            envolve senha. Aqui se define o nome e o perfil de quem já tem login. Enquanto não
            houver registro nesta tabela, o RLS bloqueia todo o acesso da pessoa.
          </Aviso>
        </div>

        {usuarios.length === 0 ? (
          <Vazio>Nenhum usuário cadastrado.</Vazio>
        ) : (
          <Tabela cabecalho={['Nome', 'Perfil', 'Situação', 'Desde', '']}>
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
          <select
            value={perfilSel}
            onChange={(e) => setPerfilSel(e.target.value as Perfil)}
            className="rounded-md border border-stone-300 px-2 py-1 text-sm dark:border-stone-700 dark:bg-stone-800"
          >
            {PERFIS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        }
      >
        <div className="mb-3">
          <Aviso>
            Esta matriz controla a <b>interface</b>. A proteção real é o RLS no banco, que já
            espelha os mesmos papéis — desmarcar aqui esconde o botão, mas quem impede a operação
            de verdade é o PostgreSQL.
          </Aviso>
        </div>

        <Tabela cabecalho={['Recurso', 'Ações']}>
          {adm.RECURSOS.map((recurso) => (
            <tr key={recurso} className="border-t border-stone-100 dark:border-stone-800/60">
              <td className="px-2 py-2 font-medium capitalize">{recurso}</td>
              <td className="px-2 py-2">
                <div className="flex flex-wrap gap-3">
                  {(ACOES_POR_RECURSO[recurso] ?? ['ver']).map((a) => (
                    <label key={a} className="flex items-center gap-1.5 text-sm">
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
        <td className="px-2 py-2 text-stone-500">
          {new Date(usuario.criado_em).toLocaleDateString('pt-BR')}
        </td>
        <td className="px-2 py-2 text-right">
          <button onClick={() => setEdit(true)} className="text-xs underline">editar</button>
        </td>
      </tr>
    )
  }

  return (
    <tr className="border-t border-stone-100 dark:border-stone-800/60">
      <td className="px-2 py-2">
        <input
          value={nome}
          onChange={(e) => setNome(e.target.value)}
          className="rounded-md border border-stone-300 px-2 py-1 text-sm dark:border-stone-700 dark:bg-stone-800"
        />
      </td>
      <td className="px-2 py-2">
        <select
          value={perfil}
          onChange={(e) => setPerfil(e.target.value as Perfil)}
          disabled={ehVoce}
          title={ehVoce ? 'Você não pode mudar o próprio perfil — evita perder o acesso de gestor' : undefined}
          className="rounded-md border border-stone-300 px-2 py-1 text-sm disabled:opacity-50 dark:border-stone-700 dark:bg-stone-800"
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
      <td />
      <td className="px-2 py-2 text-right whitespace-nowrap">
        <Botao onClick={salvar}>salvar</Botao>
        <span className="ml-2">
          <button onClick={() => setEdit(false)} className="text-xs text-stone-500 underline">
            cancelar
          </button>
        </span>
      </td>
    </tr>
  )
}
