import { useEffect, useState } from 'react'
import * as api from '@/dados/api'
import * as g from '@/dados/api-gestao'
import type { ReceitaCompleta } from '@/dados/api-gestao'
import { capacidadeDiaT, pesoItemKg } from '@/dominio/calculos'
import type { ProdutoQuimico } from '@/dominio/tipos'
import { Aviso, Cartao, Erro, Pagina, Tabela, Tag, Vazio, inteiro, n } from '@/componentes/ui'

/** Peso de referência usado só para exibir a receita numa escala legível. */
const REFERENCIA_KG = 40_000

export default function Cadastros() {
  const [cad, setCad] = useState<Awaited<ReturnType<typeof api.carregarCadastros>> | null>(null)
  const [receitas, setReceitas] = useState<ReceitaCompleta[]>([])
  const [embalagens, setEmbalagens] = useState<g.EmbalagemLinha[]>([])
  const [turnos, setTurnos] = useState<g.TurnoLinha[]>([])
  const [lotes, setLotes] = useState<g.LoteSementeLinha[]>([])
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)

  useEffect(() => {
    let vivo = true
    Promise.all([
      api.carregarCadastros(), g.listarReceitas(), g.listarEmbalagens(),
      g.listarTurnos(), g.listarLotes(),
    ])
      .then(([c, r, e, t, l]) => {
        if (!vivo) return
        setCad(c); setReceitas(r); setEmbalagens(e); setTurnos(t); setLotes(l)
      })
      .catch((x) => vivo && setErro(x instanceof Error ? x.message : String(x)))
      .finally(() => vivo && setCarregando(false))
    return () => { vivo = false }
  }, [])

  if (carregando) return <p className="p-8 text-sm text-stone-500">Carregando cadastros…</p>

  const horasTurnos = turnos.map((t) => Number(t.horas))

  return (
    <Pagina
      titulo="Cadastros"
      descricao="Base do sistema. Nesta versão são somente leitura — a edição entra com a tela de administração."
    >
      {erro && <Erro>{erro}</Erro>}

      <Cartao titulo="Máquinas e capacidade" className="mb-5">
        <Tabela cabecalho={['Máquina', '#Capacidade', '#Tanques', '#Cap. dia']}>
          {(cad?.maquinas ?? []).map((m) => (
            <tr key={m.id} className="border-t border-stone-100 dark:border-stone-800/60">
              <td className="px-2 py-2 font-medium">{m.nome}</td>
              <td className="num-tabular px-2 py-2 text-right">{n(m.capacidade_th, 0)} t/h</td>
              <td className="num-tabular px-2 py-2 text-right">{m.qtd_tanques}</td>
              <td className="num-tabular px-2 py-2 text-right font-semibold">
                {n(capacidadeDiaT(m.capacidade_th, horasTurnos), 0)} t
              </td>
            </tr>
          ))}
        </Tabela>
      </Cartao>

      <Cartao titulo="Turnos" className="mb-5">
        <p className="mb-3 text-sm text-stone-500">
          O turno não é programado: é atribuído pelo horário real do início. Até 17:30 é Turno 1.
          O Turno 2 cruza a meia-noite e pertence ao dia de produção que começou às 07:30.
        </p>
        <Tabela cabecalho={['Turno', 'Início', 'Fim', '#Horas']}>
          {turnos.map((t) => (
            <tr key={t.id} className="border-t border-stone-100 dark:border-stone-800/60">
              <td className="px-2 py-2 font-medium">{t.nome}</td>
              <td className="px-2 py-2">{t.inicio}</td>
              <td className="px-2 py-2">{t.fim}</td>
              <td className="num-tabular px-2 py-2 text-right">{n(Number(t.horas), 1)}</td>
            </tr>
          ))}
        </Tabela>
      </Cartao>

      <Cartao titulo="Embalagens" className="mb-5">
        <Tabela cabecalho={['Código', 'SimpleAgro', 'Descrição', '#Sementes', '#Fator de peso']}>
          {embalagens.map((e) => (
            <tr key={e.codigo} className="border-t border-stone-100 dark:border-stone-800/60">
              <td className="px-2 py-2 font-medium">{e.codigo}</td>
              <td className="px-2 py-2 text-stone-500">{e.codigo_ext ?? '—'}</td>
              <td className="px-2 py-2">{e.descricao}</td>
              <td className="num-tabular px-2 py-2 text-right">{inteiro(e.sementes)}</td>
              <td className="num-tabular px-2 py-2 text-right">PMS × {n(e.fator_peso, 1)}</td>
            </tr>
          ))}
        </Tabela>
      </Cartao>

      <Cartao titulo="Produtos químicos" className="mb-5">
        <div className="mb-3">
          <Aviso>
            A densidade converte a dose em <b>peso de balança</b> — é o valor que a produção afere
            nos tanques. Densidade errada desloca todo o planejado. Confira contra a FISPQ.
          </Aviso>
        </div>
        <Tabela cabecalho={['Produto', 'Código', 'Unidade de dose', '#Densidade', 'Lotes']}>
          {(cad?.produtos ?? []).map((p) => {
            const lotesDele = (cad?.lotesQuimico ?? []).filter((l) => l.produto_id === p.id)
            return (
              <tr key={p.id} className="border-t border-stone-100 dark:border-stone-800/60">
                <td className="px-2 py-2 font-medium">{p.nome}</td>
                <td className="px-2 py-2 text-stone-500">{p.codigo}</td>
                <td className="px-2 py-2">{p.unidade}</td>
                <td className="num-tabular px-2 py-2 text-right">
                  {p.densidade == null ? (
                    <span className="text-stone-400">— dose já em peso</span>
                  ) : (
                    `${n(p.densidade, 2)} g/ml`
                  )}
                </td>
                <td className="px-2 py-2 text-xs text-stone-500">
                  {lotesDele.map((l) => l.id).join(', ') || '—'}
                </td>
              </tr>
            )
          })}
        </Tabela>
      </Cartao>

      <Cartao titulo="Receitas de tratamento" className="mb-5">
        <p className="mb-4 text-sm text-stone-500">
          O nome da receita é o <b>código do comercial</b> — língua única entre venda e produção,
          sem tabela de-para. Os valores abaixo são para {inteiro(REFERENCIA_KG)} kg de semente.
        </p>
        {receitas.length === 0 ? (
          <Vazio>Nenhuma receita cadastrada.</Vazio>
        ) : (
          receitas.map((r) => {
            const porTanque = new Map<number, typeof r.receita_itens>()
            for (const i of r.receita_itens) {
              const atual = porTanque.get(i.tanque)
              if (atual) atual.push(i)
              else porTanque.set(i.tanque, [i])
            }
            return (
              <div key={r.id} className="mb-5 last:mb-0">
                <h4 className="mb-2 text-sm font-semibold">
                  {r.nome}
                  {r.receita_itens.length > 5 && (
                    <span className="ml-2">
                      <Tag cor="roxo">{r.receita_itens.length} produtos em 5 tanques</Tag>
                    </span>
                  )}
                </h4>
                <Tabela cabecalho={['Tanque', 'Produto', '#Dose', '#Densidade', '#Peso de balança']}>
                  {[...porTanque.keys()].sort((a, b) => a - b).map((tq) => {
                    const itens = porTanque.get(tq)!
                    return itens.map((i, idx) => {
                      const q = i.produtos_quimicos
                      const produto: ProdutoQuimico = {
                        id: i.produto_id, codigo: q.codigo, nome: q.nome,
                        unidade: q.unidade, densidade: q.densidade,
                      }
                      let peso: number | null = null
                      try {
                        peso = pesoItemKg(
                          { produtoId: i.produto_id, dose: i.dose, tanque: tq },
                          produto,
                          REFERENCIA_KG,
                        )
                      } catch {
                        peso = null
                      }
                      return (
                        <tr
                          key={`${tq}-${i.produto_id}`}
                          className="border-t border-stone-100 dark:border-stone-800/60"
                        >
                          <td className="px-2 py-1.5">
                            {idx === 0 ? `T${tq}` : ''}
                            {idx === 0 && itens.length > 1 && (
                              <span className="ml-1"><Tag cor="roxo">mistura</Tag></span>
                            )}
                          </td>
                          <td className="px-2 py-1.5">{q.nome}</td>
                          <td className="num-tabular px-2 py-1.5 text-right">
                            {n(i.dose, 2)} {q.unidade}
                          </td>
                          <td className="num-tabular px-2 py-1.5 text-right">
                            {q.densidade == null ? '—' : `${n(q.densidade, 2)} g/ml`}
                          </td>
                          <td className="num-tabular px-2 py-1.5 text-right font-medium">
                            {peso == null ? (
                              <span className="text-red-600">densidade ausente</span>
                            ) : (
                              `${n(peso, 1)} kg`
                            )}
                          </td>
                        </tr>
                      )
                    })
                  })}
                </Tabela>
              </div>
            )
          })
        )}
      </Cartao>

      <Cartao titulo="Motivos de parada" className="mb-5">
        <Tabela cabecalho={['Motivo', 'Tipo', 'Efeito no indicador']}>
          {(cad?.motivos ?? []).map((m) => (
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
            </tr>
          ))}
        </Tabela>
      </Cartao>

      <Cartao titulo={`Lotes de semente (${lotes.length})`}>
        <Tabela cabecalho={['Lote', 'Cultivar', '#PMS', '#Peso/bag', '#Bags', 'Status']}>
          {lotes.slice(0, 200).map((l) => (
            <tr key={l.id} className="border-t border-stone-100 dark:border-stone-800/60">
              <td className="px-2 py-1.5 font-medium">{l.id}</td>
              <td className="px-2 py-1.5">{l.cultivar}</td>
              <td className="num-tabular px-2 py-1.5 text-right">
                {l.pms == null ? '—' : n(l.pms, 1)}
              </td>
              <td className="num-tabular px-2 py-1.5 text-right">{n(l.peso_bag_kg, 0)} kg</td>
              <td className="num-tabular px-2 py-1.5 text-right">{inteiro(l.bags_disp)}</td>
              <td className="px-2 py-1.5">
                <Tag cor={l.status === 'Baixado' ? 'ok' : 'neutro'}>{l.status}</Tag>
              </td>
            </tr>
          ))}
        </Tabela>
        {lotes.length > 200 && (
          <p className="mt-3 text-xs text-stone-500">
            Mostrando os 200 primeiros de {lotes.length} lotes.
          </p>
        )}
      </Cartao>
    </Pagina>
  )
}
