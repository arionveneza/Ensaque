// o pacote não tem export raiz: no navegador é o subcaminho /browser
import writeXlsxFile, { type SheetData } from 'write-excel-file/browser'

/**
 * Exportação para .xlsx de verdade (não CSV renomeado) e impressão.
 *
 * O Excel em pt-BR abre CSV com ponto e vírgula, mas números viram texto e a
 * formatação se perde. Como a operação leva esses relatórios para reunião,
 * vale gerar a planilha real.
 */

export type Celula = string | number | null | undefined

export interface ColunaExport {
  titulo: string
  /** Largura em caracteres. Sem isso o Excel corta tudo na largura padrão. */
  largura?: number
  tipo?: 'texto' | 'numero'
  casas?: number
}

/**
 * Gera um .xlsx com cabeçalho em negrito e colunas tipadas.
 * `linhas` é uma matriz de valores na mesma ordem das colunas.
 */
export async function exportarXlsx(
  nomeArquivo: string,
  colunas: ColunaExport[],
  linhas: Celula[][],
): Promise<void> {
  const cabecalho = colunas.map((c) => ({
    value: c.titulo,
    fontWeight: 'bold' as const,
    backgroundColor: '#F5F5F4',
  }))

  const corpo = linhas.map((linha) =>
    linha.map((valor, i) => {
      const col = colunas[i]
      if (valor == null || valor === '') return { value: null, type: String }
      if (col?.tipo === 'numero') {
        const num = typeof valor === 'number' ? valor : Number(String(valor).replace(',', '.'))
        return Number.isNaN(num)
          ? { value: String(valor), type: String }
          : {
              value: num,
              type: Number,
              format: col.casas === 0 ? '#,##0' : `#,##0.${'0'.repeat(col.casas ?? 1)}`,
            }
      }
      return { value: String(valor), type: String }
    }),
  )

  // sem o unknown no meio o TS escolhe a sobrecarga de "múltiplas abas"
  const dados = [cabecalho, ...corpo] as unknown as SheetData

  // a API devolve um handle: toFile dispara o download com o nome escolhido
  const planilha = writeXlsxFile(dados, {
    columns: colunas.map((c) => ({ width: c.largura ?? Math.max(12, c.titulo.length + 2) })),
  })
  await planilha.toFile(nomeArquivo.endsWith('.xlsx') ? nomeArquivo : `${nomeArquivo}.xlsx`)
}

/**
 * Abre a janela de impressão com um documento próprio, em vez de imprimir a
 * tela inteira — o chão de fábrica imprime a lista do dia e prega no quadro.
 */
export function imprimirTabela(
  titulo: string,
  subtitulo: string,
  colunas: string[],
  linhas: Celula[][],
): void {
  const escapar = (v: Celula) =>
    String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)

  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>${escapar(titulo)}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  body { font: 11px system-ui, sans-serif; color: #1c1917; }
  h1 { font-size: 15px; margin: 0 0 2px; }
  p.sub { margin: 0 0 12px; color: #57534e; font-size: 11px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border-bottom: 1px solid #d6d3d1; padding: 4px 6px; text-align: left; }
  th { background: #f5f5f4; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
  tr { break-inside: avoid; }
  tfoot { color: #57534e; font-size: 10px; }
</style></head><body>
<h1>${escapar(titulo)}</h1>
<p class="sub">${escapar(subtitulo)}</p>
<table>
  <thead><tr>${colunas.map((c) => `<th>${escapar(c)}</th>`).join('')}</tr></thead>
  <tbody>${linhas
    .map((l) => `<tr>${l.map((c) => `<td>${escapar(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody>
</table>
<p class="sub" style="margin-top:12px">Emitido em ${new Date().toLocaleString('pt-BR')} · TSI — Sementes Veneza</p>
</body></html>`

  abrirParaImpressao(html)
}

/**
 * Abre a janela de impressão AINDA no clique (gesto do usuário) — quem
 * precisa buscar dados antes de montar o HTML (croqui com fotos) chama
 * isto primeiro e passa a janela adiante, senão o window.open depois do
 * await cai no bloqueador de pop-up em rede lenta (varredura 30/08/2026).
 */
export function abrirJanelaImpressao(): Window | null {
  const janela = window.open('', '_blank', 'width=1024,height=768')
  if (!janela) {
    alert('O navegador bloqueou a janela de impressão. Libere os pop-ups para este site.')
    return null
  }
  janela.document.write(
    '<p style="font-family:system-ui;padding:24px;color:#666">Preparando a impressão…</p>',
  )
  return janela
}

function abrirParaImpressao(html: string, aguardarImagens = false, janelaPronta?: Window): void {
  const janela = janelaPronta ?? window.open('', '_blank', 'width=1024,height=768')
  if (!janela) {
    alert('O navegador bloqueou a janela de impressão. Libere os pop-ups para este site.')
    return
  }
  if (janelaPronta) {
    janela.document.open()
  }
  janela.document.write(html)
  janela.document.close()
  janela.focus()
  if (aguardarImagens) {
    // fotos vêm por URL assinada: sem esperar, o diálogo abria com o quadro vazio
    const imagens = Array.from(janela.document.images)
    void Promise.all(
      imagens.map((img) =>
        img.complete
          ? null
          : new Promise((res) => {
              img.onload = img.onerror = res
            }),
      ),
    ).then(() => setTimeout(() => janela.print(), 150))
    return
  }
  // dá um tique para o layout assentar antes de abrir o diálogo
  setTimeout(() => janela.print(), 250)
}

const esc = (v: Celula) =>
  String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)

export interface OrdemImpressao {
  numero: string
  cultivar: string
  receita: string
  embalagem: string
  bags: number
  loteId: string
  endereco: string | null
  cliente: string | null
  observacao: string | null
  maquina: string | null
  dia: string | null
  urgente: boolean
  pesoSementeT: string
  quimicoTotalKg: string
  pesoBagKg: string
  ensaqueBagKg: string
  tanques: { destino: string; produtos: string[]; planejadoKg: string }[]
}

/**
 * A ordem de produção em papel: a mesma informação da tela de Execução,
 * com quadros em branco para o operador anotar à caneta os pesos inicial e
 * final de cada tanque, os horários e as paradas. O apontamento no sistema
 * continua obrigatório — a folha é o rascunho de chão de fábrica.
 */
export function imprimirOrdemProducao(o: OrdemImpressao): void {
  const campo = (rotulo: string, valor: Celula) =>
    `<div class="campo"><span>${esc(rotulo)}</span><b>${esc(valor) || '—'}</b></div>`

  // só o que se preenche à caneta: peso inicial e final. Execução, paradas
  // e o consumo real são apontados/calculados no sistema — não vão no papel.
  const linhasTanques = o.tanques
    .map(
      (t) => `<tr>
        <td class="destino">${esc(t.destino)}</td>
        <td>${t.produtos.map((p) => esc(p)).join('<br>')}</td>
        <td class="num">${esc(t.planejadoKg)}</td>
        <td class="mao"></td>
        <td class="mao"></td>
      </tr>`,
    )
    .join('')

  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Ordem ${esc(o.numero)}</title>
<style>
  @page { size: A4 portrait; margin: 12mm; }
  body { font: 12px system-ui, sans-serif; color: #1c1917; }
  header { display: flex; justify-content: space-between; align-items: baseline;
           border-bottom: 2px solid #1c1917; padding-bottom: 6px; margin-bottom: 10px; }
  h1 { font-size: 16px; margin: 0; }
  h1 small { font-weight: normal; color: #57534e; }
  .urgente { border: 2px solid #b91c1c; color: #b91c1c; font-weight: bold;
             padding: 2px 8px; text-transform: uppercase; font-size: 11px; }
  .grade { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px 12px; margin-bottom: 10px; }
  .campo span { display: block; font-size: 9px; text-transform: uppercase;
                letter-spacing: .05em; color: #57534e; }
  .campo b { font-size: 13px; }
  .obs { border: 1.5px solid #b45309; background: #fffbeb; padding: 6px 8px;
         margin-bottom: 10px; font-size: 12px; }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
       color: #57534e; margin: 14px 0 4px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #a8a29e; padding: 5px 6px; text-align: left; vertical-align: top; }
  th { background: #f5f5f4; font-size: 9px; text-transform: uppercase; letter-spacing: .04em; }
  td.num { text-align: right; white-space: nowrap; }
  td.destino { font-weight: bold; white-space: nowrap; }
  td.mao { height: 34px; }               /* quadro para escrever à caneta */
  tr { break-inside: avoid; }
  .linha-ass { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 18px; margin-top: 22px; }
  .ass { border-top: 1px solid #1c1917; padding-top: 3px; font-size: 10px;
         color: #57534e; text-align: center; }
  footer { margin-top: 14px; font-size: 10px; color: #57534e; }
</style></head><body>
<header>
  <h1>ORDEM DE PRODUÇÃO ${esc(o.numero)} <small>· TSI — Sementes Veneza</small></h1>
  ${o.urgente ? '<span class="urgente">Urgente</span>' : ''}
</header>

<div class="grade">
  ${campo('Cultivar', o.cultivar)}
  ${campo('Tratamento', o.receita)}
  ${campo('Embalagem', o.embalagem)}
  ${campo('Bags', o.bags)}
  ${campo('Lote', o.loteId)}
  ${campo('Endereço do lote', o.endereco)}
  ${campo('Máquina', o.maquina)}
  ${campo('Dia programado', o.dia)}
  ${campo('Peso de semente', `${o.pesoSementeT} t`)}
  ${campo('Químico total', `${o.quimicoTotalKg} kg`)}
  ${campo('Peso do bag', `${o.pesoBagKg} kg`)}
  ${campo('Ensaque por bag', `${o.ensaqueBagKg} kg`)}
  ${o.cliente ? campo('Cliente', o.cliente) : ''}
</div>

${o.observacao ? `<div class="obs"><b>Observação de processo:</b> ${esc(o.observacao)}</div>` : ''}

<h2>Tanques — receita e pesagem</h2>
<table>
  <thead><tr>
    <th style="width:13%">Destino</th>
    <th>Produtos e doses</th>
    <th style="width:14%">Planejado (kg)</th>
    <th style="width:18%">Peso inicial (kg)</th>
    <th style="width:18%">Peso final (kg)</th>
  </tr></thead>
  <tbody>${linhasTanques}</tbody>
</table>

<div class="linha-ass">
  <div class="ass">Operador</div>
  <div class="ass">Qualidade</div>
  <div class="ass">PCP</div>
</div>

<footer>Emitido em ${new Date().toLocaleString('pt-BR')} · a folha é apoio de campo — o
apontamento oficial é o do sistema.</footer>
</body></html>`

  abrirParaImpressao(html)
}

// ================================================================
// Etiqueta DM — réplica da aba ETQ. DM da planilha DM 2025
// ================================================================

/** Constantes da empresa impressas na etiqueta — mudar aqui muda em toda etiqueta futura. */
const EMPRESA = {
  nome: 'SEMENTES VENEZA LTDA',
  cnpj: 'CNPJ: 34.457.781/0001-60',
  ie: 'INSCRIÇÃO ESTADUAL: 10.775.604-8',
  endereco: 'Endereço: Rodovia GO - 174 - Sentido Montividiu - Iporá, km 314 A Direita',
  renasem: 'RENASEM: GO-02708/2019',
}

/** Fixos por decisão do Arion (25/08/2026) — sem campo pra mudar. */
const GERMINACAO_MINIMA = '80%'
const PUREZA = '99%'

export interface EtiquetaDm {
  cultivar: string
  loteId: string
  /** "P 6.75 mm" — do lote (export do SAP); null imprime "—". */
  peneira: string | null
  /** "S2" — idem. */
  categoria: string | null
  /** Peso do bag DA ORDEM, já formatado (ex.: "10"). */
  pesoKg: string
  /** PMS formatado (ex.: "210,00"); null imprime "—". */
  pms: string | null
  /** Nome da receita — SEM TSI vira "SEM TRATAMENTO" no chamador. */
  tratamento: string
}

/**
 * Etiqueta de DM (Difusão de Mercado), uma por página — cópias pelo
 * diálogo de impressão do navegador. Logo em texto por enquanto
 * (decisão de 25/08/2026); quando houver arquivo de logo, entra aqui.
 */
export function imprimirEtiquetaDm(e: EtiquetaDm): void {
  // etiqueta física de 97 × 63 mm (pedido do Arion, 25/08/2026): a página
  // de impressão É a etiqueta — o driver da impressora de etiquetas casa
  // com a mídia; numa A4 sai no canto, no tamanho certo, pra recortar
  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Etiqueta DM ${esc(e.loteId)}</title>
<style>
  @page { size: 97mm 63mm; margin: 0; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; color: #000; margin: 0;
         width: 97mm; height: 63mm; padding: 1.5mm; }
  table { width: 100%; height: 100%; border-collapse: collapse; table-layout: fixed; }
  td { border: 0.4mm solid #000; padding: 0.4mm 1.2mm; vertical-align: middle; }
  .cab { text-align: center; font-size: 5.5pt; line-height: 1.25; padding: 0.4mm; }
  .cab b { font-size: 7pt; }
  .soja { text-align: center; font-weight: bold; font-size: 8pt; }
  .rotulo { font-weight: bold; font-size: 8pt; white-space: nowrap; width: 22%; }
  .gigante { font-size: 17pt; font-weight: bold; letter-spacing: .01em; white-space: nowrap; }
  .medio { font-size: 10pt; font-weight: bold; }
  .mini { font-size: 6.5pt; font-weight: bold; }
  .rodape { text-align: center; font-size: 6pt; font-weight: bold; padding: 0.4mm; }
</style></head><body>
<table>
  <tr><td colspan="4" class="cab">
    <b>${esc(EMPRESA.nome)}</b><br>
    ${esc(EMPRESA.cnpj)}<br>
    ${esc(EMPRESA.ie)}<br>
    ${esc(EMPRESA.endereco)}
  </td></tr>
  <tr><td colspan="4" class="soja">SEMENTE DE SOJA</td></tr>
  <tr>
    <td class="rotulo">CULTIVAR:</td>
    <td colspan="3" class="gigante">${esc(e.cultivar)}</td>
  </tr>
  <tr>
    <td class="rotulo">LOTE:</td>
    <td colspan="3" class="gigante">${esc(e.loteId)}</td>
  </tr>
  <tr>
    <td class="rotulo">PENEIRA:</td>
    <td class="medio">${esc(e.peneira) || '—'}</td>
    <td class="rotulo">CATEGORIA:</td>
    <td class="medio">${esc(e.categoria) || '—'}</td>
  </tr>
  <tr>
    <td class="rotulo">PESO:</td>
    <td class="medio">${esc(e.pesoKg)} kg</td>
    <td class="rotulo">PMS:</td>
    <td class="medio">${esc(e.pms) || '—'}</td>
  </tr>
  <tr>
    <td colspan="2" class="mini">GERMINAÇÃO MÍNIMA: ${GERMINACAO_MINIMA}</td>
    <td colspan="2" class="mini">PUREZA: ${PUREZA}</td>
  </tr>
  <tr>
    <td class="rotulo" style="font-size:6.5pt">TRATAMENTO:</td>
    <td colspan="3" class="mini">${esc(e.tratamento)}</td>
  </tr>
  <tr><td colspan="4" class="rodape">${esc(EMPRESA.renasem)}</td></tr>
</table>
</body></html>`

  abrirParaImpressao(html)
}

export interface ItemCarregamentoImpressao {
  lote: string
  endereco: string
  bags: number
  pesoBagKg: number | null
  pesoKg: number
  destinacao: string | null
}

/** Um produto da carga: a combinação pedida e os lotes escolhidos pra ela. */
export interface ProdutoCarregamentoImpressao {
  cultivar: string
  tratamento: string
  bagsSolicitados: number
  itens: ItemCarregamentoImpressao[]
}

export interface OrdemCarregamentoImpressao {
  numero: string
  cliente: string | null
  placa: string | null
  data: string
  /** A carga leva VÁRIOS produtos (28/08/2026) — a folha agrupa por produto. */
  produtos: ProdutoCarregamentoImpressao[]
  totalBags: number
  pesoTotalKg: number
  /** Informada, a impressao ja soma tara + carga; em branco, sai campo pra anotar. */
  taraKg: number | null
}

/**
 * A ordem de carregamento em papel (pedido do Arion, 28/08/2026): a folha
 * que acompanha o caminhao — cliente, placa, os lotes com endereco fisico
 * (onde buscar), quantidades e pesos, e o quadro de pesagem com o peso da
 * carga, o campo de TARA e o peso bruto (tara + carga). Tara em branco na
 * impressao quando nao informada, pra anotar na balanca.
 */
export function imprimirOrdemCarregamento(c: OrdemCarregamentoImpressao): void {
  const fmt = (v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: 0 })
  // bags são fracionários por projeto (MEIOBAG consome 0,5 bag): arredondar
  // no papel mandava buscar bag que o lote não tem (varredura 30/08/2026)
  const fmtBags = (v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: 2 })
  const linhas = c.produtos
    .map((p) => {
      const carregados = p.itens.reduce((s, i) => s + i.bags, 0)
      const cabecalho = `<tr class="produto"><td colspan="5">${esc(p.cultivar)} · ${esc(p.tratamento)} — pedido ${fmtBags(p.bagsSolicitados)} bags${Math.abs(carregados - p.bagsSolicitados) > 0.005 ? ` · na carga ${fmtBags(carregados)}` : ''}</td></tr>`
      if (p.itens.length === 0) {
        return `${cabecalho}<tr><td colspan="5" class="pendente">lotes a definir</td></tr>`
      }
      const itens = p.itens
        .map(
          (i) => `<tr>
        <td><b>${esc(i.lote)}</b>${i.destinacao ? `<br><span class="dest">DESTINAÇÃO: ${esc(i.destinacao)}</span>` : ''}</td>
        <td>${esc(i.endereco) || '—'}</td>
        <td class="num">${fmtBags(i.bags)}</td>
        <td class="num">${i.pesoBagKg != null ? fmt(i.pesoBagKg) : '—'}</td>
        <td class="num">${fmt(i.pesoKg)}</td>
      </tr>`,
        )
        .join('')
      return cabecalho + itens
    })
    .join('')

  // com produto ainda sem lote, o peso é PARCIAL: imprimir um "peso bruto"
  // definitivo enganava a balança (varredura de 30/08/2026)
  const parcial = c.produtos.some((p) => p.itens.length === 0)
  const brutoKg = !parcial && c.taraKg != null ? c.taraKg + c.pesoTotalKg : null

  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Ordem de carregamento ${esc(c.numero)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; color: #111; margin: 24px; font-size: 13px; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .empresa { font-size: 11px; color: #444; margin-bottom: 14px; }
  .grade { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px 16px; margin-bottom: 14px; }
  .campo span { display: block; font-size: 10px; text-transform: uppercase; color: #666; }
  .campo b { font-size: 14px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
  th, td { border: 1px solid #999; padding: 5px 8px; text-align: left; vertical-align: top; }
  th { background: #eee; font-size: 11px; text-transform: uppercase; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .dest { color: #b00020; font-weight: bold; font-size: 11px; }
  .produto td { background: #e8e8e8; font-weight: bold; font-size: 12px; }
  .pendente { color: #666; font-style: italic; }
  .totais td { font-weight: bold; background: #f5f5f5; }
  .pesagem { border: 2px solid #111; padding: 10px 14px; margin-top: 8px; }
  .pesagem h2 { font-size: 13px; text-transform: uppercase; margin: 0 0 8px; }
  .pesagem .linha { display: flex; justify-content: space-between; align-items: baseline;
                    border-bottom: 1px dotted #999; padding: 7px 0; font-size: 14px; }
  .pesagem .linha:last-child { border-bottom: none; }
  .pesagem .valor { font-weight: bold; font-size: 16px; }
  .escrever { display: inline-block; min-width: 180px; border-bottom: 1.5px solid #111; }
  .assin { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-top: 44px; }
  .assin div { border-top: 1px solid #111; padding-top: 4px; text-align: center; font-size: 11px; }
  @media print { body { margin: 10mm; } }
</style></head><body>
<h1>ORDEM DE CARREGAMENTO Nº ${esc(c.numero)}</h1>
<p class="empresa">${esc(EMPRESA.nome)} · ${esc(EMPRESA.cnpj)} · Emitida em ${esc(c.data)}</p>

<div class="grade">
  <div class="campo"><span>Cliente</span><b>${esc(c.cliente) || '—'}</b></div>
  <div class="campo"><span>Placa do veículo</span><b>${esc(c.placa) || '—'}</b></div>
  <div class="campo"><span>Data</span><b>${esc(c.data)}</b></div>
  <div class="campo"><span>Produtos</span><b>${fmt(c.produtos.length)}</b></div>
  <div class="campo"><span>Total</span><b>${fmtBags(c.totalBags)} bags</b></div>
  <div class="campo"><span>Peso da carga</span><b>${fmt(c.pesoTotalKg)} kg</b></div>
</div>

<table>
  <thead><tr><th>Lote</th><th>Endereço (onde buscar)</th><th class="num">Bags</th><th class="num">Peso/bag (kg)</th><th class="num">Peso (kg)</th></tr></thead>
  <tbody>
    ${linhas}
    <tr class="totais"><td colspan="2">TOTAL</td><td class="num">${fmtBags(c.totalBags)}</td><td></td><td class="num">${fmt(c.pesoTotalKg)}</td></tr>
  </tbody>
</table>

<div class="pesagem">
  <h2>Pesagem</h2>
  <div class="linha"><span>Peso da carga (ordem de carregamento)${parcial ? ' — PARCIAL: há produto sem lote' : ''}</span><span class="valor">${fmt(c.pesoTotalKg)} kg</span></div>
  <div class="linha"><span>Tara do veículo</span>${
    c.taraKg != null
      ? `<span class="valor">${fmt(c.taraKg)} kg</span>`
      : `<span class="escrever">&nbsp;</span>`
  }</div>
  <div class="linha"><span>Peso bruto (tara + carga)</span>${
    brutoKg != null
      ? `<span class="valor">${fmt(brutoKg)} kg</span>`
      : `<span class="escrever">&nbsp;</span>`
  }</div>
</div>

<div class="assin">
  <div>Operador(a) da balança</div>
  <div>Motorista</div>
</div>
</body></html>`

  abrirParaImpressao(html)
}

export interface CroquiCargaImpressao {
  numero: string
  veiculo: import('@/dominio/croqui').VeiculoCarga
  /** Data de emissão (dd/mm/aaaa) — o carregamento assina em cima. */
  data: string
  lotesNaCarga: number
  totalBags: number
  /** URLs (assinadas) das fotos da carga/placa — saem no quadro do croqui. */
  fotos: string[]
}

/**
 * Croqui da carga (29/08/2026) — réplica fiel do formulário de papel
 * "Registro de Expedição de Sementes — Croqui da Carga" que a expedição
 * já usa: veículo visto de cima com as FILAS EM BRANCO (o conferente
 * anota à mão o que foi em cada posição), quadro pra foto da carga/placa
 * e os campos de assinatura. Paisagem, uma folha por carga.
 */
export function imprimirCroquiCarga(c: CroquiCargaImpressao, janelaPronta?: Window): void {
  const carretas = c.veiculo.carretas
    .map(
      (filas, idx) => `${idx > 0 ? '<div class="engate"></div>' : ''}
      <div class="carreta">${'<div class="fila"></div>'.repeat(filas)}</div>`,
    )
    .join('')

  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Croqui da carga ${esc(c.numero)}</title>
<style>
  @page { size: A4 portrait; margin: 8mm; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; color: #111; margin: 0; font-size: 13px; }
  .moldura { border: 1.5px solid #333; }
  .topo { display: grid; grid-template-columns: 165px 1fr 150px; border-bottom: 1.5px solid #333; }
  .topo > div { padding: 8px 10px; }
  .logo { border-right: 1.5px solid #333; font-weight: 800; font-size: 15px; color: #1a7a3a; }
  .logo small { display: block; color: #666; font-weight: 600; font-size: 9px; }
  .titulo { display: flex; align-items: center; justify-content: center; text-align: center;
            font-weight: 700; font-size: 14px; text-transform: uppercase; }
  .revisao { border-left: 1.5px solid #333; font-size: 10px; color: #444; }
  .campos { display: flex; flex-wrap: wrap; gap: 4px 24px; padding: 8px 10px;
            border-bottom: 1.5px solid #333; font-size: 13px; }
  .campos b { font-size: 14px; }
  .linha-escrever { display: inline-block; min-width: 120px; border-bottom: 1.2px solid #333; }
  .corpo { display: grid; grid-template-columns: 330px 1fr; min-height: 800px; }
  .desenho { border-right: 1.5px solid #333; padding: 12px; text-align: center; }
  .desenho h2 { margin: 0 0 10px; font-size: 17px; }
  .cab { width: 150px; height: 84px; margin: 0 auto; border: 2.5px solid #333;
         border-radius: 14px 14px 6px 6px; position: relative; }
  .cab::after { content: ''; position: absolute; left: 16px; right: 16px; top: 11px; height: 20px;
                border: 2px solid #333; border-radius: 4px; }
  .chassi { width: 4px; height: 18px; background: #333; margin: 0 auto; }
  .carreta { width: 240px; margin: 0 auto; border: 2.5px solid #333; }
  .fila { height: 40px; border-bottom: 1.6px solid #333; }
  .fila:last-child { border-bottom: none; }
  .engate { width: 4px; height: 22px; background: #333; margin: 0 auto; }
  .foto { padding: 8px 10px; }
  .foto h2 { margin: 0; font-size: 15px; text-align: center; border-bottom: 1.5px solid #333;
             padding-bottom: 6px; }
  .grade-fotos { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; padding-top: 10px; }
  .grade-fotos.uma { grid-template-columns: 1fr; }
  .grade-fotos img { width: 100%; max-height: 340px; object-fit: contain; border: 1px solid #999; }
  .rodape { display: flex; flex-wrap: wrap; gap: 4px 24px; padding: 9px 10px;
            border-top: 1.5px solid #333; font-size: 13px; }
</style></head><body>
<div class="moldura">
  <div class="topo">
    <div class="logo">${esc(EMPRESA.nome)}<small>${esc(EMPRESA.cnpj)}</small></div>
    <div class="titulo">Registro de Expedição de Sementes — Croqui da Carga</div>
    <div class="revisao">Emitido em ${esc(c.data)}<br>Página 1/1</div>
  </div>
  <div class="campos">
    <span>Nº da Ordem de carregamento: <b>${esc(c.numero)}</b></span>
    <span>Data do Carregamento: <span class="linha-escrever">&nbsp;</span></span>
    <span>Ass. Conf.: <span class="linha-escrever">&nbsp;</span></span>
  </div>
  <div class="corpo">
    <div class="desenho">
      <h2>${esc(c.veiculo.nome)}</h2>
      <div class="cab"></div>
      <div class="chassi"></div>
      ${carretas}
    </div>
    <div class="foto">
      <h2>Foto carga/placa</h2>
      ${
        c.fotos.length > 0
          ? `<div class="grade-fotos${c.fotos.length === 1 ? ' uma' : ''}">${c.fotos
              .slice(0, 4)
              .map((u) => `<img src="${esc(u)}" alt="Foto da carga">`)
              .join('')}</div>`
          : ''
      }
    </div>
  </div>
  <div class="rodape">
    <span>Quantidade lotes na Carga: <b>${c.lotesNaCarga > 0 ? c.lotesNaCarga : ''}</b><span class="linha-escrever" style="min-width:${c.lotesNaCarga > 0 ? 20 : 90}px">&nbsp;</span></span>
    <span>Numero de Big Bag: <b>${c.totalBags > 0 ? c.totalBags : ''}</b><span class="linha-escrever" style="min-width:${c.totalBags > 0 ? 20 : 90}px">&nbsp;</span></span>
    <span>Ass. Mot.: <span class="linha-escrever" style="min-width:180px">&nbsp;</span></span>
  </div>
</div>
</body></html>`

  abrirParaImpressao(html, c.fotos.length > 0, janelaPronta)
}
