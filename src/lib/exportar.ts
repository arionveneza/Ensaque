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
