import { useCallback, useEffect, useState } from 'react'
import * as v from '@/dados/api-veiculos'
import { useRealtime } from '@/dados/useRealtime'
import { useAuth } from '@/auth/AuthProvider'
import { useRascunho } from '@/lib/useRascunho'
import {
  AlternadorOkFora, Aviso, Botao, Cartao, Erro, Pagina, Tabela, Tag, Vazio, dataHoraCurta,
} from '@/componentes/ui'
import { SeletorFotos } from '@/componentes/SeletorFotos'

const INPUT =
  'rounded-md border border-stone-300 px-2 py-2 text-sm sm:py-1 dark:border-stone-700 dark:bg-stone-800'

type AbaVeiculos = 'chamar' | 'checklist' | 'historico'
type Acao = (fn: () => Promise<void>) => Promise<void>

export default function Veiculos() {
  const { usuario, permitido } = useAuth()
  const podeChamar = permitido('veiculos', 'chamar')
  const podeChecklist = permitido('veiculos', 'checklist')

  const TODAS_ABAS: { id: AbaVeiculos; nome: string }[] = [
    { id: 'chamar', nome: 'Chamar motorista' },
    { id: 'checklist', nome: 'Checklist' },
    { id: 'historico', nome: 'Histórico' },
  ]
  const ABAS = TODAS_ABAS.filter((a) =>
    a.id === 'historico' ? true : a.id === 'chamar' ? podeChamar : podeChecklist,
  )

  // sobrevive a recarregar a página, mesmo padrão da aba de Cadastros
  const abaRasc = useRascunho<{ aba: AbaVeiculos }>('veiculos-aba', { aba: 'historico' })
  const aba = ABAS.some((a) => a.id === abaRasc.valor.aba) ? abaRasc.valor.aba : (ABAS[0]?.id ?? 'historico')
  const setAba = (val: AbaVeiculos) => abaRasc.definir({ aba: val })

  const [tipos, setTipos] = useState<v.TipoChecklist[]>([])
  const [chamadas, setChamadas] = useState<v.ChamadaMotorista[]>([])
  const [checklists, setChecklists] = useState<v.ChecklistVeiculoCompleto[]>([])
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)

  const recarregar = useCallback(async () => {
    const [t, c, h] = await Promise.all([
      v.listarTiposChecklist(), v.listarChamadas(), v.listarChecklistsVeiculo(),
    ])
    setTipos(t); setChamadas(c); setChecklists(h)
  }, [])

  useEffect(() => {
    setCarregando(true)
    recarregar()
      .catch((e) => setErro(e instanceof Error ? e.message : String(e)))
      .finally(() => setCarregando(false))
  }, [recarregar])

  useRealtime(['chamadas_motorista', 'veiculo_checklists'], recarregar)

  const acao = useCallback<Acao>(
    async (fn) => {
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

  if (carregando) return <p className="p-8 text-sm text-stone-500">Carregando…</p>

  return (
    <Pagina titulo="Veículos" descricao="Checklist de veículo e chamada de motorista no pátio.">
      {erro && <Erro>{erro}</Erro>}

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

      {aba === 'chamar' && podeChamar && usuario && (
        <AbaChamar chamadas={chamadas} usuarioId={usuario.id} acao={acao} />
      )}
      {aba === 'checklist' && podeChecklist && <AbaChecklistVeiculo tipos={tipos} acao={acao} />}
      {aba === 'historico' && <AbaHistorico checklists={checklists} />}
    </Pagina>
  )
}

// ================================================================
// Chamar motorista
// ================================================================

interface FormChamarValor {
  placa: string
  motorista: string
  motivo: string
  observacao: string
}
const CHAMAR_VAZIO: FormChamarValor = { placa: '', motorista: '', motivo: '', observacao: '' }
const MOTIVOS_SUGERIDOS = ['Carregamento', 'Retirada de nota fiscal']

function AbaChamar({
  chamadas, usuarioId, acao,
}: {
  chamadas: v.ChamadaMotorista[]
  usuarioId: string
  acao: Acao
}) {
  const { valor, definir, limpar } = useRascunho('veiculos-chamar-form', CHAMAR_VAZIO)
  const { placa, motorista, motivo, observacao } = valor

  return (
    <div>
      <Cartao titulo="Chamar motorista" className="mb-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-stone-500">
            Placa
            <input
              value={placa}
              onChange={(e) => definir({ placa: e.target.value.toUpperCase() })}
              className={`${INPUT} mt-1 block w-full`}
            />
          </label>
          <label className="text-xs text-stone-500">
            Motorista
            <input
              value={motorista}
              onChange={(e) => definir({ motorista: e.target.value })}
              className={`${INPUT} mt-1 block w-full`}
            />
          </label>
        </div>

        <div className="mt-3">
          <p className="text-xs text-stone-500">Motivo</p>
          <div className="mt-1 flex flex-wrap gap-2">
            {MOTIVOS_SUGERIDOS.map((m) => (
              <button
                key={m}
                onClick={() => definir({ motivo: m })}
                className={`rounded-md border px-3 py-2.5 text-sm sm:py-1.5 ${
                  motivo === m
                    ? 'border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900'
                    : 'border-stone-300 dark:border-stone-700'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
          <input
            value={motivo}
            onChange={(e) => definir({ motivo: e.target.value })}
            placeholder="ou digite outro motivo (ex.: inspeção, entrega)"
            className={`${INPUT} mt-2 block w-full sm:w-96`}
          />
        </div>

        <label className="mt-3 block text-xs text-stone-500">
          Observação (opcional)
          <input
            value={observacao}
            onChange={(e) => definir({ observacao: e.target.value })}
            className={`${INPUT} mt-1 block w-full`}
          />
        </label>

        <div className="mt-4">
          <Botao
            variante="primario"
            disabled={!placa.trim() || !motorista.trim() || !motivo.trim()}
            onClick={() =>
              acao(async () => {
                await v.chamarMotorista(placa, motorista, motivo, observacao.trim() || null, usuarioId)
                limpar()
              })
            }
          >
            Chamar
          </Botao>
        </div>
      </Cartao>

      <Cartao titulo={`Últimas chamadas (${chamadas.length})`}>
        {chamadas.length === 0 ? (
          <Vazio>Nenhuma chamada ainda.</Vazio>
        ) : (
          <Tabela cabecalho={['Hora', 'Placa', 'Motorista', 'Motivo']}>
            {chamadas.map((c) => (
              <tr key={c.id} className="border-t border-stone-100 dark:border-stone-800/60">
                <td className="px-2 py-1.5 whitespace-nowrap">{dataHoraCurta(c.chamado_em)}</td>
                <td className="px-2 py-1.5">{c.placa}</td>
                <td className="px-2 py-1.5">{c.motorista}</td>
                <td className="px-2 py-1.5">{c.motivo}</td>
              </tr>
            ))}
          </Tabela>
        )}
      </Cartao>
    </div>
  )
}

// ================================================================
// Checklist de veículo — lançamento solto (sem vínculo com Expedição)
// ================================================================

interface FormChecklistVeiculoValor {
  /** Gerado no cliente (crypto.randomUUID) ao escolher o tipo — pasta das fotos e PK do checklist. */
  id: string | null
  tipoId: string
  placa: string
  motorista: string
  transportadora: string
  observacao: string
  fotos: string[]
  itens: Record<string, { ok: boolean | null; observacao: string }>
}
const CHECKLIST_VAZIO: FormChecklistVeiculoValor = {
  id: null, tipoId: '', placa: '', motorista: '', transportadora: '', observacao: '', fotos: [], itens: {},
}

function AbaChecklistVeiculo({
  tipos, acao,
}: {
  tipos: v.TipoChecklist[]
  acao: Acao
}) {
  const { valor, definir, limpar, recuperado } = useRascunho('veiculos-checklist-form', CHECKLIST_VAZIO)
  const { id, tipoId, placa, motorista, transportadora, observacao, fotos, itens } = valor
  const tipo = tipos.find((t) => t.id === tipoId) ?? null

  // trocar de tipo começa um checklist NOVO (id/fotos/itens são por tipo);
  // placa/motorista/transportadora continuam — é comum fazer pré e pós do
  // mesmo caminhão em seguida
  function escolherTipo(novoTipoId: string) {
    if (novoTipoId === tipoId) return
    definir({ tipoId: novoTipoId, id: crypto.randomUUID(), itens: {}, fotos: [] })
  }

  function responder(perguntaId: string, patch: Partial<{ ok: boolean; observacao: string }>) {
    const atual = itens[perguntaId] ?? { ok: null, observacao: '' }
    definir({ itens: { ...itens, [perguntaId]: { ...atual, ...patch } } })
  }

  const perguntasFaltando = tipo
    ? tipo.checklist_perguntas.filter((p) => p.obrigatoria && itens[p.id]?.ok == null)
    : []
  const podeSalvar = !!tipo && !!id && !!placa.trim() && !!motorista.trim() && perguntasFaltando.length === 0

  async function salvar() {
    if (!tipo || !id) return
    const itensArr: v.ItemChecklistVeiculo[] = Object.entries(itens)
      .filter(([, r]) => r.ok != null)
      .map(([pergunta_id, r]) => ({ pergunta_id, ok: r.ok as boolean, observacao: r.observacao.trim() || null }))
    await v.salvarChecklistVeiculo(
      id, tipo.id, placa.trim(), motorista.trim(), transportadora.trim() || null,
      observacao.trim() || null, fotos, itensArr,
    )
    limpar()
  }

  return (
    <div>
      {recuperado && (
        <div className="mb-3">
          <Aviso>
            <b>Rascunho recuperado.</b> O checklist que você estava preenchendo foi restaurado.{' '}
            <button onClick={limpar} className="underline">descartar</button>
          </Aviso>
        </div>
      )}

      <Cartao>
        <label className="text-xs text-stone-500">
          Tipo de checklist
          <select
            value={tipoId}
            onChange={(e) => escolherTipo(e.target.value)}
            className={`${INPUT} mt-1 block w-64`}
          >
            <option value="">escolha…</option>
            {tipos.filter((t) => t.ativo).map((t) => (
              <option key={t.id} value={t.id}>{t.nome}</option>
            ))}
          </select>
        </label>

        {tipo && (
          <>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <label className="text-xs text-stone-500">
                Placa
                <input
                  value={placa}
                  onChange={(e) => definir({ placa: e.target.value.toUpperCase() })}
                  className={`${INPUT} mt-1 block w-full`}
                />
              </label>
              <label className="text-xs text-stone-500">
                Motorista
                <input
                  value={motorista}
                  onChange={(e) => definir({ motorista: e.target.value })}
                  className={`${INPUT} mt-1 block w-full`}
                />
              </label>
              <label className="text-xs text-stone-500">
                Transportadora (opcional)
                <input
                  value={transportadora}
                  onChange={(e) => definir({ transportadora: e.target.value })}
                  className={`${INPUT} mt-1 block w-full`}
                />
              </label>
            </div>

            <div className="mt-4 space-y-3">
              {tipo.checklist_perguntas.length === 0 ? (
                <p className="text-xs text-stone-500">
                  Este tipo ainda não tem perguntas cadastradas — em Cadastros → Checklist de
                  veículos.
                </p>
              ) : (
                tipo.checklist_perguntas.map((p) => {
                  const resposta = itens[p.id]
                  return (
                    <div key={p.id} className="rounded-md border border-stone-200 p-3 dark:border-stone-700">
                      <AlternadorOkFora
                        rotulo={`${p.texto}${p.obrigatoria ? ' *' : ''}`}
                        ok={resposta?.ok ?? null}
                        onMudar={(ok) => responder(p.id, { ok })}
                      />
                      {resposta?.ok === false && (
                        <input
                          value={resposta.observacao}
                          onChange={(e) => responder(p.id, { observacao: e.target.value })}
                          placeholder="o que está fora do padrão? (opcional)"
                          className={`${INPUT} mt-2 block w-full`}
                        />
                      )}
                    </div>
                  )
                })
              )}
            </div>

            <SeletorFotos
              max={6}
              titulo="Fotos do checklist (até 6)"
              fotos={fotos}
              onMudar={(f) => definir({ fotos: f })}
              enviar={(dataUrl) => v.enviarFotoVeiculo(id!, dataUrl)}
              remover={v.removerFotoVeiculo}
              urlAssinada={v.urlFotoVeiculo}
            />

            <label className="mt-3 block text-xs text-stone-500">
              Observação geral (opcional)
              <input
                value={observacao}
                onChange={(e) => definir({ observacao: e.target.value })}
                className={`${INPUT} mt-1 block w-full`}
              />
            </label>

            <div className="mt-4">
              <Botao
                variante="primario"
                disabled={!podeSalvar}
                titulo={
                  perguntasFaltando.length > 0
                    ? `Falta responder: ${perguntasFaltando.map((p) => p.texto).join(', ')}`
                    : undefined
                }
                onClick={() => acao(salvar)}
              >
                Salvar checklist
              </Botao>
            </div>
          </>
        )}
      </Cartao>
    </div>
  )
}

// ================================================================
// Histórico
// ================================================================

function AbaHistorico({ checklists }: { checklists: v.ChecklistVeiculoCompleto[] }) {
  const [aberto, setAberto] = useState<string | null>(null)

  if (checklists.length === 0) return <Vazio>Nenhum checklist registrado ainda.</Vazio>

  return (
    <div className="space-y-3">
      {checklists.map((c) => (
        <Cartao
          key={c.id}
          titulo={`${c.checklist_tipos.nome} · ${c.placa}`}
          acoes={
            <Botao onClick={() => setAberto(aberto === c.id ? null : c.id)}>
              {aberto === c.id ? 'Fechar' : 'Ver'}
            </Botao>
          }
        >
          <p className="text-xs text-stone-500">
            {c.motorista}{c.transportadora ? ` · ${c.transportadora}` : ''} · {dataHoraCurta(c.ts)}
          </p>
          {aberto === c.id && (
            <div className="mt-3">
              {c.veiculo_checklist_itens.length === 0 ? (
                <p className="text-xs text-stone-500">Sem perguntas respondidas.</p>
              ) : (
                <Tabela cabecalho={['Pergunta', 'Resposta', 'Observação']}>
                  {c.veiculo_checklist_itens.map((it, i) => (
                    <tr key={i} className="border-t border-stone-100 dark:border-stone-800/60">
                      <td className="px-2 py-1.5">
                        {it.checklist_perguntas.texto}
                        {it.checklist_perguntas.obrigatoria && ' *'}
                      </td>
                      <td className="px-2 py-1.5">
                        <Tag cor={it.ok ? 'ok' : 'alerta'}>{it.ok ? 'OK' : 'Fora do padrão'}</Tag>
                      </td>
                      <td className="px-2 py-1.5">{it.observacao ?? '—'}</td>
                    </tr>
                  ))}
                </Tabela>
              )}
              {c.observacao && <p className="mt-2 text-sm">{c.observacao}</p>}
              {c.fotos.length > 0 && <FotosHistorico caminhos={c.fotos} />}
            </div>
          )}
        </Cartao>
      ))}
    </div>
  )
}

function FotosHistorico({ caminhos }: { caminhos: string[] }) {
  const [urls, setUrls] = useState<(string | null)[]>([])
  const [prontos, setProntos] = useState(false)
  const chaveCaminhos = JSON.stringify(caminhos)

  useEffect(() => {
    let vivo = true
    setProntos(false)
    Promise.all(caminhos.map((c) => v.urlFotoVeiculo(c)))
      .then((r) => {
        if (!vivo) return
        setUrls(r)
        setProntos(true)
      })
      .catch(() => {
        if (!vivo) return
        setUrls(caminhos.map(() => null))
        setProntos(true)
      })
    return () => { vivo = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chaveCaminhos])

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {caminhos.map((c, i) => {
        const url = urls[i]
        return url ? (
          <a key={c} href={url} target="_blank" rel="noopener noreferrer" title="Abrir em tamanho real">
            <img
              src={url}
              alt={`Foto ${i + 1} do checklist`}
              className="h-24 w-24 rounded-md border border-stone-200 object-cover dark:border-stone-700"
            />
          </a>
        ) : (
          <div
            key={c}
            className="flex h-24 w-24 items-center justify-center rounded-md border border-dashed border-stone-300 text-[10px] text-stone-400 dark:border-stone-700"
          >
            {prontos ? 'falha ao carregar' : 'carregando…'}
          </div>
        )
      })}
    </div>
  )
}
