/**
 * Etiqueta do lote em PDF → imagem pra ficha de químicos (17/09/2026).
 *
 * O PDF vem do SimpleAgro (JasperReports): página de 207 × 283 pt com
 * `/Rotate 90`, que o pdf.js já aplica — sai deitada, 99,8 × 73 mm, legível.
 * Rasterizamos a 1ª página aqui no navegador com o pdf.js
 * (carregado sob demanda — é um chunk grande e só quem imprime ficha usa),
 * a 300 dpi, e devolvemos um PNG mais o tamanho REAL em mm, pra imagem
 * sair no papel do tamanho da etiqueta física. Nada sobe pro servidor: o
 * arquivo fica só na memória enquanto o detalhe da ordem está aberto.
 */

import {
  mmDePontos,
  rotacaoSugeridaEtiqueta,
  type EtiquetaFicha,
  type RotacaoEtiqueta,
} from '@/dominio/fichaQuimicos'

/** 300 dpi: nítido pro código de barras/QR da etiqueta, sem estourar o data URL. */
const DPI = 300

export async function renderizarEtiquetaPdf(
  bytes: ArrayBuffer,
  rotacao: RotacaoEtiqueta | 'auto',
  nome: string,
): Promise<EtiquetaFicha> {
  const pdfjs = await import('pdfjs-dist')
  const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

  // o pdf.js TRANSFERE o buffer pro worker (fica vazio aqui) — manda cópia,
  // porque o chamador guarda os bytes pra girar de novo depois
  const tarefa = pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) })
  const doc = await tarefa.promise
  try {
    const pagina = await doc.getPage(1)
    const natural = pagina.getViewport({ scale: 1 })
    const giro: RotacaoEtiqueta =
      rotacao === 'auto' ? rotacaoSugeridaEtiqueta(natural.width, natural.height) : rotacao
    // `rotation` é o giro TOTAL da viewport (substitui o /Rotate da página, não soma)
    const rotacaoTotal = (pagina.rotate + giro) % 360
    const base = pagina.getViewport({ scale: 1, rotation: rotacaoTotal })
    const vp = pagina.getViewport({ scale: DPI / 72, rotation: rotacaoTotal })

    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(vp.width)
    canvas.height = Math.ceil(vp.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('O navegador não deu um canvas pra desenhar o PDF.')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await pagina.render({ canvasContext: ctx, canvas, viewport: vp }).promise

    return {
      dataUrl: canvas.toDataURL('image/png'),
      larguraMm: mmDePontos(base.width),
      alturaMm: mmDePontos(base.height),
      rotacao: giro,
      nome,
    }
  } finally {
    // destroy() é da TAREFA de carga (encerra o worker); o proxy do documento só tem cleanup()
    await tarefa.destroy()
  }
}
