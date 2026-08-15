import { useEffect, useState } from 'react'
import { fotoParaDataUrl } from '@/lib/imagem'

/**
 * Seletor de fotos genérico (Qualidade final, checklist de veículo — o
 * `capture="environment"` abre a câmera traseira direto).
 *
 * Cada foto é enviada ao Storage NA SELEÇÃO, uma por vez — o rascunho do
 * formulário do chamador guarda só o CAMINHO devolvido por `enviar`, nunca a
 * dataURL inteira. Antes a dataURL (200 KB a poucos MB por foto) ia inteira
 * pro rascunho, e `useRascunho` engole em silêncio qualquer erro do
 * `localStorage.setItem` — cota estourada não dava erro nenhum, só não
 * gravava, e a foto sumia no próximo reload (o que o Android faz sempre que
 * a câmera abre por cima da aba). Caminho é texto curto: nunca chega perto
 * da cota. A prévia de uma foto recém-tirada usa a dataURL local
 * (`previasLocais`, não persistida); depois de um reload, sem essa prévia
 * em memória, busca a URL assinada via `urlAssinada` — a foto já está
 * segura no Storage de qualquer forma. Ver `PENDENCIAS.md` (retrospecto
 * 15/08/2026) para o histórico completo do bug que isto corrige.
 */
export function SeletorFotos({
  max, titulo, fotos, onMudar, enviar, remover, urlAssinada,
}: {
  max: number
  /** Rótulo acima da lista; default `Fotos (até {max})`. */
  titulo?: string
  fotos: string[]
  onMudar: (f: string[]) => void
  /** Sobe uma foto (dataURL já reduzida) e devolve o caminho no Storage. */
  enviar: (dataUrl: string) => Promise<string>
  /** Best-effort: falhar aqui só deixa um arquivo órfão no bucket privado. */
  remover: (caminho: string) => Promise<void>
  urlAssinada: (caminho: string) => Promise<string | null>
}) {
  const [processando, setProcessando] = useState(false)
  const [erroFoto, setErroFoto] = useState<string | null>(null)
  const [previasLocais, setPreviasLocais] = useState<Record<string, string>>({})
  const [urlsAssinadas, setUrlsAssinadas] = useState<Record<string, string | null>>({})
  const chaveFotos = fotos.join('|')

  useEffect(() => {
    const faltando = fotos.filter((c) => !(c in previasLocais) && !(c in urlsAssinadas))
    if (!faltando.length) return
    let vivo = true
    Promise.all(faltando.map(async (c) => [c, await urlAssinada(c)] as const)).then((pares) => {
      if (!vivo) return
      setUrlsAssinadas((u) => ({ ...u, ...Object.fromEntries(pares) }))
    })
    return () => { vivo = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chaveFotos])

  async function aoEscolher(arquivos: File[]) {
    setErroFoto(null)
    setProcessando(true)
    try {
      let atuais = fotos
      for (const a of arquivos.slice(0, max - fotos.length)) {
        const dataUrl = await fotoParaDataUrl(a)
        const caminho = await enviar(dataUrl)
        setPreviasLocais((p) => ({ ...p, [caminho]: dataUrl }))
        atuais = [...atuais, caminho].slice(0, max)
        // grava no rascunho a cada foto — se a próxima falhar (ou a aba
        // morrer no meio), as já enviadas não se perdem
        onMudar(atuais)
      }
    } catch (e) {
      setErroFoto(e instanceof Error ? e.message : String(e))
    } finally {
      setProcessando(false)
    }
  }

  function aoRemover(caminho: string) {
    onMudar(fotos.filter((c) => c !== caminho))
    void remover(caminho)
  }

  return (
    <div className="mt-3">
      <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
        {titulo ?? `Fotos (até ${max})`}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {fotos.map((c) => {
          const src = previasLocais[c] ?? urlsAssinadas[c]
          return (
            <div key={c} className="relative">
              {src ? (
                <img
                  src={src}
                  alt="Foto"
                  className="h-20 w-20 rounded-md border border-stone-200 object-cover dark:border-stone-700"
                />
              ) : (
                <div className="flex h-20 w-20 items-center justify-center rounded-md border border-dashed border-stone-300 text-center text-[10px] text-stone-400 dark:border-stone-700">
                  {urlsAssinadas[c] === null ? 'falha ao carregar' : 'carregando…'}
                </div>
              )}
              <button
                onClick={() => aoRemover(c)}
                title="Remover"
                className="absolute -right-2 -top-2 flex h-7 w-7 items-center justify-center rounded-full bg-red-600 text-sm font-bold text-white"
              >
                ×
              </button>
            </div>
          )
        })}
        {fotos.length < max && (
          <label className="flex h-20 w-20 cursor-pointer flex-col items-center justify-center rounded-md border border-dashed border-stone-300 text-xs text-stone-500 hover:bg-stone-50 dark:border-stone-600 dark:hover:bg-stone-800">
            {processando ? (
              <span className="animate-pulse text-[10px]">enviando…</span>
            ) : (
              <>
                <span className="text-lg leading-none">+</span>
                <span>foto</span>
              </>
            )}
            <input
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              disabled={processando}
              className="hidden"
              onChange={(e) => {
                const novas = Array.from(e.target.files ?? [])
                // permite escolher o MESMO arquivo de novo depois de remover
                e.target.value = ''
                if (novas.length) void aoEscolher(novas)
              }}
            />
          </label>
        )}
      </div>
      {erroFoto && (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">
          Não deu para enviar a foto: {erroFoto}
        </p>
      )}
    </div>
  )
}
