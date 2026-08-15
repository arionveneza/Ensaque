/**
 * Foto da câmera → dataURL JPEG de no máximo 1600 px.
 *
 * Roda na SELEÇÃO, não no envio: (1) a foto original tem vários MB e
 * travaria o upload na rede do galpão; (2) o dataURL é texto e serve de
 * prévia imediata antes de a foto ter uma URL assinada; (3) soltar o File
 * original cedo alivia a memória do tablet.
 */
export async function fotoParaDataUrl(
  arquivo: File,
  maxLado = 1600,
  qualidade = 0.8,
): Promise<string> {
  const bitmap = await createImageBitmap(arquivo)
  const escala = Math.min(1, maxLado / Math.max(bitmap.width, bitmap.height))
  const w = Math.round(bitmap.width * escala)
  const h = Math.round(bitmap.height * escala)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Este navegador não consegue processar a imagem.')
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  return canvas.toDataURL('image/jpeg', qualidade)
}
