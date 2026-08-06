import { useMemo, useState } from 'react'
import type { LinhaMotivo, LinhaOrdem, LinhaProduto } from '@/dados/api'
import * as api from '@/dados/api'
import {
  mapaMotivos,
  mapaProdutos,
  paraOrdemDominio,
  pesoOrdemKg,
} from '@/dados/adaptadores'
import {
  consumoPorTanque,
  ensaquePorBagKg,
  formataHms,
  montaTanques,
  pesoQuimicoTotalKg,
  temposOrdem,
} from '@/dominio/calculos'
import { jaIniciada, statusEfetivo } from '@/dominio/status'
import { Aviso, diaCurto, enderecoLote, rotuloTanque } from '@/componentes/ui'
import { imprimirOrdemProducao } from '@/lib/exportar'

const num = (v: number | null | undefined, casas = 1) =>
  v == null || Number.isNaN(v)
    ? '—'
    : v.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas })

interface Props {
  ordem: LinhaOrdem
  produtos: LinhaProduto[]
  motivos: LinhaMotivo[]
  podeApontar: boolean
  agora: number
  onFechar: () => void
  onMudou: () => Promise<void>
}

export default function ModalOrdem({
  ordem,
  produtos,
  motivos,
  podeApontar,
  agora,
  onFechar,
  onMudou,
}: Props) {
  const [erro, setErro] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState(false)
  const [escolhendoParada, setEscolhendoParada] = useState(false)
  // obrigatória na finalização; em branco de propósito — nada de pré-preencher
  const [qtdProduzida, setQtdProduzida] = useState('')

  const prods = useMemo(() => mapaProdutos(produtos), [produtos])
  const mots = useMemo(() => mapaMotivos(motivos), [motivos])
  const dominio = useMemo(() => paraOrdemDominio(ordem), [ordem])

  const kg = pesoOrdemKg(ordem)
  const status = statusEfetivo(dominio, ordem.lotes_semente.status)
  const emAndamento = status === 'Em producao' || status === 'Parada'
  /**
   * A produção já tocou a ordem — inclui Finalizada e além. Distribuição e
   * peso inicial travam AQUI, não em `emAndamento`: usar `emAndamento`
   * destravava tudo de novo depois de finalizar, e a ordem virou histórico.
   */
  const tocada = jaIniciada(status)
  const tempos = temposOrdem(dominio, mots, agora)

  const consumos = useMemo(
    () => (dominio.tanques.length ? consumoPorTanque(dominio.tanques, prods, kg) : []),
    [dominio.tanques, prods, kg],
  )

  const quimicoTotal = useMemo(() => {
    try {
      return pesoQuimicoTotalKg(
        { id: ordem.receita_id, nome: ordem.receitas.nome, itens: dominio.tanques.flatMap((t) => t.itens) },
        prods,
        kg,
      )
    } catch {
      return null
    }
  }, [ordem, dominio.tanques, prods, kg])

  async function acao(fn: () => Promise<void>) {
    setErro(null)
    setOcupado(true)
    try {
      await fn()
      await onMudou()
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    } finally {
      setOcupado(false)
    }
  }

  /**
   * A folha de papel que acompanha a ordem: mesma informação da tela, com
   * quadros em branco para o operador anotar os pesos à caneta. O planejado
   * sai da RECEITA (não dos tanques montados) para poder imprimir antes do
   * Iniciar, que é quando a folha vai para o chão de fábrica.
   */
  function imprimir() {
    const itens = ordem.receitas.receita_itens.map((i) => ({
      produtoId: i.produto_id,
      dose: i.dose,
    }))
    // a folha sai com a distribuição que o operador escolheu nesta ordem
    const alocacao = ordem.ordem_produtos.map((op) => ({
      produtoId: op.produto_id,
      tanque: op.tanque,
    }))
    const destinoDe = new Map(alocacao.map((a) => [a.produtoId, a.tanque]))
    let planejadoPorTanque = new Map<number, number>()
    try {
      const cons = consumoPorTanque(
        montaTanques({ id: ordem.receita_id, nome: ordem.receitas.nome, itens }, alocacao),
        prods,
        kg,
      )
      planejadoPorTanque = new Map(cons.map((c) => [c.tanque, c.planejadoKg]))
    } catch {
      // densidade faltando: imprime com traço, igual à tela
    }
    const tanquesOrdenados = [...new Set(alocacao.map((a) => a.tanque))].sort((a, b) => a - b)
    imprimirOrdemProducao({
      numero: ordem.numero,
      cultivar: ordem.cultivar,
      receita: ordem.receitas.nome,
      embalagem: ordem.embalagem,
      bags: ordem.bags,
      loteId: ordem.lote_id,
      endereco: ordem.armazem || ordem.bloco || ordem.quadra ? enderecoLote(ordem) : null,
      cliente: ordem.cliente,
      observacao: ordem.observacao,
      maquina: ordem.maquina_id,
      dia: ordem.data_prog ? diaCurto(ordem.data_prog) : null,
      urgente: ordem.prioridade === 'Urgente',
      pesoSementeT: num(kg / 1000, 2),
      quimicoTotalKg: quimicoTotal == null ? '—' : num(quimicoTotal),
      pesoBagKg: num(ordem.lotes_semente.peso_bag_kg, 0),
      ensaqueBagKg:
        quimicoTotal == null
          ? '—'
          : num(ensaquePorBagKg(ordem.lotes_semente.peso_bag_kg, quimicoTotal, ordem.bags), 1),
      tanques: tanquesOrdenados.map((tq) => ({
        destino: rotuloTanque(tq),
        produtos: itens
          .filter((i) => destinoDe.get(i.produtoId) === tq)
          .map((i) => {
            const p = prods.get(i.produtoId)
            return `${p?.nome ?? i.produtoId} · ${num(i.dose, 2)} ${p?.unidade ?? ''}`
          }),
        planejadoKg: planejadoPorTanque.has(tq) ? num(planejadoPorTanque.get(tq)) : '—',
      })),
    })
  }

  // ---- validações antes de confirmar (o banco também barra, via trigger) ----
  const semPesoInicial = ordem.ordem_tanques.filter((t) => t.peso_inicial == null)
  const semDestino = ordem.receitas.receita_itens.filter(
    (i) => !ordem.ordem_produtos.some((op) => op.produto_id === i.produto_id),
  )

  const podeConfirmarInicio =
    semDestino.length === 0 && ordem.ordem_tanques.length > 0 && semPesoInicial.length === 0
  // peso final NÃO trava mais a finalização (o PCP digita no AGROTIS);
  // o que trava é a quantidade produzida
  const bagsProduzidos = parseInt(qtdProduzida, 10)
  const podeConfirmarFim = Number.isFinite(bagsProduzidos) && bagsProduzidos >= 1

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8">
      <div className="w-full max-w-4xl rounded-lg bg-white shadow-xl dark:bg-stone-900">
        <header className="flex items-start justify-between gap-4 border-b border-stone-200 p-5 dark:border-stone-800">
          <div>
            <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
              Ordem {ordem.numero} · {ordem.cultivar}
            </h2>
            <p className="mt-0.5 text-sm text-stone-500 dark:text-stone-400">
              {ordem.receitas.nome} · {ordem.embalagem} · {ordem.bags} bags · Lote{' '}
              <span className="font-medium">{ordem.lote_id}</span>
              {(ordem.armazem || ordem.bloco || ordem.quadra) && (
                <>
                  {' · '}
                  <span className="font-medium">{enderecoLote(ordem)}</span>
                </>
              )}
            </p>
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={imprimir}
              title="Folha da ordem para o apontamento manual no chão de fábrica"
              className="rounded-md border border-stone-300 px-3 py-1.5 text-sm dark:border-stone-700"
            >
              Imprimir
            </button>
            <button
              onClick={onFechar}
              className="rounded-md px-3 py-1.5 text-sm text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
            >
              Fechar
            </button>
          </div>
        </header>

        <div className="p-5">
          {ordem.observacao && (
            <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              <strong>Observação de processo:</strong> {ordem.observacao}
            </div>
          )}

          {erro && (
            <div className="mb-4 rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
              {erro}
            </div>
          )}

          <dl className="mb-5 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <Info rotulo="Status" valor={status} destaque />
            <Info rotulo="Peso de semente" valor={`${num(kg / 1000, 2)} t`} />
            <Info
              rotulo="Químico total"
              valor={quimicoTotal == null ? '—' : `${num(quimicoTotal)} kg`}
            />
            <Info
              rotulo="Ensaque por bag"
              valor={
                quimicoTotal == null
                  ? '—'
                  : `${num(ensaquePorBagKg(ordem.lotes_semente.peso_bag_kg, quimicoTotal, ordem.bags), 1)} kg`
              }
            />
          </dl>

          {tempos && (
            <dl className="mb-5 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <Info rotulo="Tempo bruto" valor={formataHms(tempos.brutoS)} />
              <Info rotulo="Tempo líquido" valor={formataHms(tempos.liquidoS)} />
              <Info rotulo="Paradas" valor={formataHms(tempos.paradasS)} />
              <Info
                rotulo="Disp. operacional"
                valor={tempos.dispOperacional == null ? '—' : `${num(tempos.dispOperacional * 100)}%`}
              />
            </dl>
          )}

          {/* Ordem que começou ANTES de o tanque virar escolha da ordem: a
              distribuição dela vivia na receita e não foi preservada. Dizer
              isso é melhor que mostrar tanque vazio com planejado zero, que
              pareceria erro de apontamento. */}
          {emAndamento && ordem.ordem_produtos.length === 0 &&
            ordem.receitas.receita_itens.length > 0 && (
            <div className="mb-5">
              <Aviso>
                <b>Distribuição não registrada.</b> Esta ordem começou antes de o tanque passar
                a ser informado por ordem, então não se sabe qual produto foi em qual tanque —
                por isso o planejado aparece zerado abaixo. Os pesos apontados continuam
                válidos; parar, retomar e finalizar funcionam normalmente. Só a comparação
                Real vs Planejado não fecha nesta ordem.
              </Aviso>
            </div>
          )}

          {/* -------- distribuição: o operador define o tanque de cada produto -------- */}
          {!tocada && (
            <div className="mb-5">
              <h3 className="mb-1 text-sm font-semibold text-stone-900 dark:text-stone-100">
                Distribuição dos produtos
              </h3>
              <p className="mb-3 text-xs text-stone-500 dark:text-stone-400">
                A receita traz produto e dose; o <b>tanque muda a cada ordem</b>, então é você
                quem informa. Dois produtos no mesmo tanque = mistura, e o planejado passa a ser
                a soma deles.
              </p>
              <div className="space-y-1.5">
                {ordem.receitas.receita_itens.map((i) => {
                  const p = prods.get(i.produto_id)
                  const atual = ordem.ordem_produtos.find((op) => op.produto_id === i.produto_id)
                  return (
                    <div
                      key={i.produto_id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-stone-200 px-3 py-2 dark:border-stone-800"
                    >
                      <span className="text-sm">
                        {p?.nome ?? i.produto_id}{' '}
                        <span className="text-stone-500">
                          · {num(i.dose, 2)} {p?.unidade}
                        </span>
                      </span>
                      <select
                        disabled={!podeApontar || ocupado}
                        value={atual ? String(atual.tanque) : ''}
                        onChange={(e) =>
                          acao(() =>
                            api.definirTanqueProduto(
                              ordem.id,
                              i.produto_id,
                              e.target.value === '' ? null : Number(e.target.value),
                            ),
                          )
                        }
                        className={`rounded border px-2 py-1 text-sm disabled:opacity-60 dark:bg-stone-800 ${
                          atual
                            ? 'border-stone-300 dark:border-stone-700'
                            : 'border-amber-400 dark:border-amber-700'
                        }`}
                      >
                        <option value="">escolha o tanque…</option>
                        {[1, 2, 3, 4, 5].map((t) => (
                          <option key={t} value={t}>T{t}</option>
                        ))}
                        <option value={0}>Transferidor</option>
                      </select>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* ---------------- tanques ---------------- */}
          {ordem.ordem_tanques.length === 0 ? (
            <p className="rounded-md bg-stone-50 px-4 py-6 text-center text-sm text-stone-500 dark:bg-stone-800/50 dark:text-stone-400">
              Nenhum tanque montado ainda — escolha o destino dos produtos acima. O cronômetro
              só começa no <b>Confirmar início</b>.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-stone-200 text-left text-xs uppercase tracking-wide text-stone-500 dark:border-stone-800 dark:text-stone-400">
                    <th className="py-2 pr-3">Destino</th>
                    <th className="py-2 pr-3">Produtos e doses</th>
                    <th className="py-2 pr-3 text-right">Planejado</th>
                    <th className="py-2 pr-3 text-right">Peso inicial</th>
                    <th
                      className="py-2 pr-3 text-right"
                      title="Opcional aqui — o PCP digita os pesos finais na tela AGROTIS"
                    >
                      Peso final*
                    </th>
                    <th className="py-2 pr-3 text-right">Real</th>
                    <th className="py-2 text-right">Desvio</th>
                  </tr>
                </thead>
                <tbody>
                  {ordem.ordem_tanques
                    .slice()
                    .sort((a, b) => a.tanque - b.tanque)
                    .map((t) => {
                      const c = consumos.find((x) => x.tanque === t.tanque)
                      const doTanque = new Set(
                        ordem.ordem_produtos
                          .filter((op) => op.tanque === t.tanque)
                          .map((op) => op.produto_id),
                      )
                      const itens = ordem.receitas.receita_itens.filter((i) =>
                        doTanque.has(i.produto_id),
                      )
                      const mistura = itens.length > 1
                      return (
                        <tr
                          key={t.id}
                          className="border-b border-stone-100 align-top dark:border-stone-800/60"
                        >
                          <td className="py-3 pr-3 font-medium">
                            {rotuloTanque(t.tanque)}
                            {mistura && (
                              <span className="ml-1.5 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                                mistura
                              </span>
                            )}
                          </td>
                          <td className="py-3 pr-3">
                            {itens.map((i) => {
                              const p = prods.get(i.produto_id)
                              return (
                                <div key={i.produto_id} className="mb-1.5 last:mb-0">
                                  <span className="text-stone-700 dark:text-stone-300">
                                    {p?.nome} · {num(i.dose, 2)} {p?.unidade}
                                  </span>
                                </div>
                              )
                            })}
                          </td>
                          <td className="num-tabular py-3 pr-3 text-right">
                            {num(c?.planejadoKg)} kg
                          </td>
                          <td className="py-3 pr-3 text-right">
                            <PesoInput
                              valor={t.peso_inicial}
                              // trava assim que a produção começa e NÃO destrava
                              // depois: ordem iniciada é registro histórico
                              travado={!podeApontar || tocada || ocupado}
                              onSalvar={(v) => acao(() => api.salvarPesoTanque(t.id, 'peso_inicial', v))}
                            />
                          </td>
                          <td className="py-3 pr-3 text-right">
                            <PesoInput
                              valor={t.peso_final}
                              // final só libera depois do clique em Finalizar
                              travado={!podeApontar || !ordem.fim_pendente || ocupado}
                              onSalvar={(v) => acao(() => api.salvarPesoTanque(t.id, 'peso_final', v))}
                            />
                          </td>
                          <td className="num-tabular py-3 pr-3 text-right">
                            {c?.realKg == null ? '—' : `${num(c.realKg)} kg`}
                          </td>
                          <td
                            className={`num-tabular py-3 text-right ${
                              c?.desvioPct == null
                                ? 'text-stone-400'
                                : Math.abs(c.desvioPct) <= 5
                                  ? 'text-emerald-600 dark:text-emerald-400'
                                  : Math.abs(c.desvioPct) <= 10
                                    ? 'text-amber-600 dark:text-amber-400'
                                    : 'text-red-600 dark:text-red-400'
                            }`}
                          >
                            {c?.desvioPct == null
                              ? '—'
                              : `${c.desvioPct > 0 ? '+' : ''}${num(c.desvioPct)}%`}
                          </td>
                        </tr>
                      )
                    })}
                </tbody>
              </table>
            </div>
          )}

          {ordem.fim_pendente && (
            <p className="mt-3 text-xs text-stone-500 dark:text-stone-400">
              * Peso final é opcional aqui: o operador anota na folha impressa e o PCP
              digita na tela AGROTIS — o lançamento exige todos os pesos.
            </p>
          )}

          {/* pendências que impedem confirmar — só antes de iniciar */}
          {!tocada && !podeConfirmarInicio && (
            <div className="mt-4 rounded-md bg-stone-50 px-4 py-3 text-sm text-stone-600 dark:bg-stone-800/50 dark:text-stone-300">
              <p className="font-medium">Para confirmar o início falta:</p>
              <ul className="mt-1 list-inside list-disc">
                {semDestino.length > 0 && (
                  <li>
                    Tanque de{' '}
                    {semDestino.map((i) => prods.get(i.produto_id)?.nome ?? i.produto_id).join(', ')}
                  </li>
                )}
                {semPesoInicial.length > 0 && (
                  <li>
                    Peso inicial em {semPesoInicial.map((t) => rotuloTanque(t.tanque)).join(', ')}
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>

        {/* ---------------- ações ---------------- */}
        <footer className="flex flex-wrap gap-2 border-t border-stone-200 p-5 dark:border-stone-800">
          {!podeApontar && (
            <p className="text-sm text-stone-500 dark:text-stone-400">
              Seu perfil não aponta produção — visualização apenas.
            </p>
          )}

          {podeApontar && status === 'Pronto para produzir' && (
            <button
              disabled={ocupado || !podeConfirmarInicio}
              onClick={() => acao(() => api.confirmarInicio(ordem.id))}
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              Confirmar início
            </button>
          )}

          {podeApontar && emAndamento && !ordem.fim_pendente && (
            <>
              {status === 'Em producao' ? (
                <button
                  disabled={ocupado}
                  onClick={() => setEscolhendoParada(true)}
                  className="rounded-md border border-stone-300 px-4 py-2 text-sm font-medium disabled:opacity-40 dark:border-stone-700"
                >
                  Registrar parada
                </button>
              ) : (
                <button
                  disabled={ocupado}
                  onClick={() => acao(() => api.retomar(ordem.id))}
                  className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
                >
                  Retomar
                </button>
              )}
              <button
                disabled={ocupado}
                onClick={() => acao(() => api.abrirPesagemFinal(ordem.id))}
                className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-stone-100 dark:text-stone-900"
              >
                Finalizar
              </button>
            </>
          )}

          {podeApontar && emAndamento && ordem.fim_pendente && (
            <>
              <label className="flex items-center gap-1.5 text-sm">
                Produzido
                <input
                  inputMode="numeric"
                  value={qtdProduzida}
                  onChange={(e) => setQtdProduzida(e.target.value)}
                  placeholder="bags"
                  className="num-tabular w-20 rounded-md border border-stone-300 px-2 py-2 text-right dark:border-stone-700 dark:bg-stone-800"
                />
              </label>
              <button
                disabled={ocupado || !podeConfirmarFim}
                title={podeConfirmarFim ? undefined : 'Informe a quantidade produzida (bags)'}
                onClick={() => acao(() => api.confirmarFim(ordem.id, bagsProduzidos))}
                className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
              >
                Confirmar finalização
              </button>
              {/* Finalizar clicado por engano tem volta. Os pesos finais já
                  digitados são descartados: a produção continua, a pesagem
                  velha não vale mais. */}
              <button
                disabled={ocupado}
                onClick={() => {
                  const digitados = ordem.ordem_tanques.filter((t) => t.peso_final != null).length
                  if (
                    digitados > 0 &&
                    !confirm(
                      `Voltar para produção descarta ${digitados} peso(s) final(is) já digitado(s) — ` +
                        'eles serão pesados de novo no próximo Finalizar. Continuar?',
                    )
                  )
                    return
                  acao(() => api.voltarParaProducao(ordem.id))
                }}
                className="rounded-md border border-stone-300 px-4 py-2 text-sm font-medium disabled:opacity-40 dark:border-stone-700"
              >
                Voltar para produção
              </button>
            </>
          )}

          {podeApontar && emAndamento && (
            <button
              disabled={ocupado}
              onClick={() => {
                const t = tempos
                const testes = ordem.qualidade_checks.length
                if (
                  !confirm(
                    `Cancelar o início da ordem ${ordem.numero}?\n\n` +
                      `Serão descartados ${formataHms(t?.brutoS ?? 0)} de tempo apontado, ` +
                      `${ordem.ordem_paradas.length} parada(s) e os pesos de tanque.\n` +
                      (testes > 0
                        ? `\n⚠ ATENÇÃO: ${testes} TESTE(S) DE QUALIDADE já apontado(s) ` +
                          'nesta ordem serão APAGADOS junto.\n'
                        : '') +
                      '\nA ordem volta para Programada e a máquina fica livre. ' +
                      'Esta ação fica registrada no histórico.',
                  )
                )
                  return
                acao(() =>
                  api.cancelarInicio(
                    ordem.id,
                    `${formataHms(t?.brutoS ?? 0)}, ${ordem.ordem_paradas.length} parada(s)` +
                      (testes > 0 ? ` e ${testes} teste(s) de qualidade` : '') +
                      ' descartados',
                  ),
                )
              }}
              className="ml-auto rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-700 disabled:opacity-40 dark:border-red-800 dark:text-red-400"
            >
              Cancelar início
            </button>
          )}
        </footer>

        {escolhendoParada && (
          <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4">
            <div className="w-full max-w-lg rounded-lg bg-white p-5 dark:bg-stone-900">
              <h3 className="text-base font-semibold">Motivo da parada</h3>
              <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
                A classificação separa tempo normal de processo (setup, limpeza) de perda
                real no indicador de disponibilidade.
              </p>
              {(['Planejada', 'Nao planejada'] as const).map((tipo) => (
                <div key={tipo} className="mt-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
                    {tipo === 'Planejada' ? 'Planejada' : 'Não planejada'}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-2">
                    {motivos
                      .filter((m) => m.tipo === tipo)
                      .map((m) => (
                        <button
                          key={m.id}
                          disabled={ocupado}
                          onClick={() => {
                            setEscolhendoParada(false)
                            acao(() => api.registrarParada(ordem.id, m.id))
                          }}
                          className="rounded-md border border-stone-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-stone-700"
                        >
                          {m.descricao}
                        </button>
                      ))}
                  </div>
                </div>
              ))}
              <button
                onClick={() => setEscolhendoParada(false)}
                className="mt-5 text-sm text-stone-500 underline"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Info({
  rotulo,
  valor,
  destaque,
}: {
  rotulo: string
  valor: string
  destaque?: boolean
}) {
  return (
    <div className="rounded-md bg-stone-50 px-3 py-2 dark:bg-stone-800/50">
      <dt className="text-xs uppercase tracking-wide text-stone-500 dark:text-stone-400">
        {rotulo}
      </dt>
      <dd
        className={`num-tabular mt-0.5 ${destaque ? 'font-semibold' : ''} text-stone-900 dark:text-stone-100`}
      >
        {valor}
      </dd>
    </div>
  )
}

/** Campo de peso: só grava ao sair do campo, para não salvar a cada tecla. */
function PesoInput({
  valor,
  travado,
  onSalvar,
}: {
  valor: number | null
  travado: boolean
  onSalvar: (v: number | null) => void
}) {
  const [texto, setTexto] = useState(valor == null ? '' : String(valor))
  return (
    <input
      inputMode="decimal"
      disabled={travado}
      value={texto}
      onChange={(e) => setTexto(e.target.value)}
      onBlur={() => {
        const limpo = texto.replace(',', '.').trim()
        const v = limpo === '' ? null : Number(limpo)
        if (v != null && Number.isNaN(v)) return
        if (v !== valor) onSalvar(v)
      }}
      placeholder="—"
      className="num-tabular w-24 rounded border border-stone-300 px-2 py-1 text-right disabled:cursor-not-allowed disabled:bg-stone-100 disabled:text-stone-400 dark:border-stone-700 dark:bg-stone-800 dark:disabled:bg-stone-800/50"
    />
  )
}
