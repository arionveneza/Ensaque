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

function abrirParaImpressao(html: string): void {
  const janela = window.open('', '_blank', 'width=1024,height=768')
  if (!janela) {
    alert('O navegador bloqueou a janela de impressão. Libere os pop-ups para este site.')
    return
  }
  janela.document.write(html)
  janela.document.close()
  janela.focus()
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

  const linhasTanques = o.tanques
    .map(
      (t) => `<tr>
        <td class="destino">${esc(t.destino)}</td>
        <td>${t.produtos.map((p) => esc(p)).join('<br>')}</td>
        <td class="num">${esc(t.planejadoKg)}</td>
        <td class="mao"></td>
        <td class="mao"></td>
        <td class="mao"></td>
      </tr>`,
    )
    .join('')

  const linhasParadas = Array.from({ length: 4 })
    .map(() => '<tr><td class="mao"></td><td class="mao"></td><td class="mao"></td></tr>')
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
    <th style="width:12%">Destino</th>
    <th>Produtos e doses</th>
    <th style="width:12%">Planejado (kg)</th>
    <th style="width:14%">Peso inicial (kg)</th>
    <th style="width:14%">Peso final (kg)</th>
    <th style="width:12%">Real (kg)</th>
  </tr></thead>
  <tbody>${linhasTanques}</tbody>
</table>

<h2>Execução</h2>
<table>
  <thead><tr><th>Início (data/hora)</th><th>Fim (data/hora)</th><th>Turno</th></tr></thead>
  <tbody><tr><td class="mao"></td><td class="mao"></td><td class="mao"></td></tr></tbody>
</table>

<h2>Paradas</h2>
<table>
  <thead><tr><th>Motivo</th><th style="width:22%">Início</th><th style="width:22%">Fim</th></tr></thead>
  <tbody>${linhasParadas}</tbody>
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
