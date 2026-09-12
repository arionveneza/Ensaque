/**
 * Destinação da produção (COMIGO, Multiplicação, Venda…), sempre com a
 * mesma cara em toda tela: uma pastilha neutra, da largura da etiqueta de
 * status que fica em cima dela (min-w-36), em caixa alta pequena. Vazia
 * mostra um traço apagado, para a coluna não "pular" entre linhas
 * (pedido do Arion, 12/09/2026: "capriche no visual, algo padronizado").
 */
export function Destinacao({
  valor,
  className = '',
}: {
  valor: string | null | undefined
  className?: string
}) {
  const texto = (valor ?? '').trim()
  return (
    <span
      title={texto ? `Destinação: ${texto}` : 'Sem destinação informada'}
      className={`inline-flex min-w-36 max-w-56 items-center justify-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        texto
          ? 'border-stone-300 bg-stone-50 text-stone-600 dark:border-stone-700 dark:bg-stone-800/60 dark:text-stone-300'
          : 'border-dashed border-stone-200 text-stone-300 dark:border-stone-800 dark:text-stone-600'
      } ${className}`}
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        className="shrink-0 opacity-70"
        aria-hidden
      >
        <path d="M2 8h9M8 4l4 4-4 4" />
      </svg>
      <span className="truncate">{texto || 'sem destinação'}</span>
    </span>
  )
}
