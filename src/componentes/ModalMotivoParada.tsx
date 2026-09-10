import type { LinhaMotivo } from '@/dados/api'

/**
 * Escolha do motivo da parada — um clique, sem formulário.
 *
 * Nasceu inline no detalhe da ordem e saiu de lá em 12/09/2026, quando a
 * Execução passou a registrar parada de MÁQUINA (sem ordem) e precisou da
 * mesma lista. O componente não sabe o que vai ser feito com o motivo:
 * quem chama decide, então serve para a ordem e para a máquina.
 */
export function ModalMotivoParada({
  titulo = 'Motivo da parada',
  descricao = 'A classificação separa tempo normal de processo (setup, limpeza) de perda real no indicador de disponibilidade.',
  motivos,
  ocupado = false,
  onEscolher,
  onCancelar,
}: {
  titulo?: string
  descricao?: string
  motivos: LinhaMotivo[]
  ocupado?: boolean
  onEscolher: (motivo: LinhaMotivo) => void
  onCancelar: () => void
}) {
  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4">
      {/* max-h + overflow: lista de motivos é cadastro, pode crescer;
          sem isto o botão Cancelar podia ficar cortado, sem rolagem */}
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-5 dark:bg-stone-900">
        <h3 className="text-base font-semibold">{titulo}</h3>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{descricao}</p>
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
                    onClick={() => onEscolher(m)}
                    className="rounded-md border border-stone-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-stone-700"
                  >
                    {m.descricao}
                  </button>
                ))}
            </div>
          </div>
        ))}
        <button onClick={onCancelar} className="mt-5 text-sm text-stone-500 underline">
          Cancelar
        </button>
      </div>
    </div>
  )
}
