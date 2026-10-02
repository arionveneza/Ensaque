/**
 * Observação de processo da ordem ("SEM GRAFITE", "SEM CLASSIFICACAO"…),
 * embaixo do número em toda lista e em QUALQUER status (01/10/2026, pedido
 * do Arion: "quero ver as observações das ordens, mas em ordens finalizadas
 * eu não consigo"). Até aqui ela só aparecia no formulário de edição — que
 * some assim que a produção toca a ordem — e na faixa do detalhe. Texto
 * longo é cortado; o inteiro fica no título (passar o mouse).
 */
export function ObservacaoOrdem({
  texto,
  className = '',
}: {
  texto: string | null | undefined
  className?: string
}) {
  const t = (texto ?? '').trim()
  if (!t) return null
  return (
    <p
      className={`max-w-56 truncate text-xs font-normal text-amber-700 dark:text-amber-400 ${className}`}
      title={`Observação de processo: ${t}`}
    >
      obs: {t}
    </p>
  )
}
