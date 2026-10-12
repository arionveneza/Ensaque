import { useMemo, useState } from 'react'
import {
  EMBALAGENS_LOTE_AVULSO, validarLoteAvulso, type LoteAvulsoGravavel,
} from '@/dominio/loteAvulso'
import { Botao, Tag, diaCurto } from '@/componentes/ui'

/**
 * Lote AVULSO (12/10/2026): lote de semente branca fora do SAP, criado no
 * formulário da ordem. Regras em src/dominio/loteAvulso.ts.
 */

/** Etiqueta do lote fora do SAP — a mesma em toda tela onde o lote aparece. */
export function TagLoteAvulso({ desde }: { desde?: string | null }) {
  return (
    <span
      title={`Lote avulso: fora do SAP, digitado no app${desde ? ` em ${diaCurto(desde.slice(0, 10))}` : ''}. Não entra no saldo do SAP nem na Expedição; se o SAP trouxer este número, vira lote do SAP.`}
    >
      <Tag cor="info">avulso</Tag>
    </span>
  )
}

const INPUT =
  'mt-1 w-full rounded-md border border-stone-300 px-2 py-1.5 text-sm normal-case dark:border-stone-700 dark:bg-stone-800'
const ROTULO = 'text-xs font-medium uppercase tracking-wide text-stone-500'

export function FormLoteAvulso({
  existentes, cultivaresConhecidos, onCriar, onCancelar,
}: {
  existentes: { id: string; origem_manual?: boolean }[]
  /** Nomes que o sistema já usa (lotes + pedidos) — sugestão e conferência de grafia. */
  cultivaresConhecidos: string[]
  onCriar: (lote: LoteAvulsoGravavel) => Promise<void>
  onCancelar: () => void
}) {
  const [d, setD] = useState({ id: '', cultivar: '', embalagem: 'BB5M', pms: '', pesoBag: '', bags: '' })
  const [gravando, setGravando] = useState(false)
  const v = useMemo(
    () => validarLoteAvulso(d, existentes, cultivaresConhecidos),
    [d, existentes, cultivaresConhecidos],
  )
  const comecou = d.id.trim() !== '' || d.cultivar.trim() !== '' || d.pms.trim() !== '' || d.bags.trim() !== ''
  const fator = EMBALAGENS_LOTE_AVULSO.find((e) => e.codigo === d.embalagem)?.fator ?? 5
  const pmsNum = Number(d.pms.replace(',', '.'))
  const pesoSugerido = d.pms.trim() && pmsNum > 0 ? Math.round(pmsNum * fator * 100) / 100 : null
  const definir = (campo: keyof typeof d, valor: string) => setD((x) => ({ ...x, [campo]: valor }))

  return (
    <div className="mt-4 rounded-md border border-sky-300 bg-sky-50/50 p-4 dark:border-sky-800 dark:bg-sky-950/20">
      <p className="text-sm font-semibold text-sky-900 dark:text-sky-200">Lote avulso · fora do SAP</p>
      <p className="mb-3 text-xs text-stone-600 dark:text-stone-400">
        Para semente branca que ainda não está no saldo do SAP. O lote fica marcado como{' '}
        <b>avulso</b> em todas as telas, não entra no saldo do SAP nem na Expedição, e o upload do
        SAP não o apaga. Se um dia o SAP trouxer este mesmo número, ele passa a ser lote do SAP.
      </p>
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <label className={ROTULO}>
          Nº do lote
          <input
            value={d.id}
            onChange={(e) => definir('id', e.target.value.toUpperCase())}
            placeholder="ex.: 26B65C0170"
            className={INPUT}
          />
        </label>
        <label className={ROTULO}>
          Cultivar
          <input
            value={d.cultivar}
            onChange={(e) => definir('cultivar', e.target.value.toUpperCase())}
            list="lote-avulso-cultivares"
            placeholder="ex.: NEO751 CE"
            className={INPUT}
          />
          <datalist id="lote-avulso-cultivares">
            {cultivaresConhecidos.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>
        <label className={ROTULO}>
          Embalagem do lote
          <select value={d.embalagem} onChange={(e) => definir('embalagem', e.target.value)} className={INPUT}>
            {EMBALAGENS_LOTE_AVULSO.map((e) => (
              <option key={e.codigo} value={e.codigo}>{e.rotulo}</option>
            ))}
          </select>
        </label>
        <label className={ROTULO}>
          PMS (g)
          <input
            value={d.pms}
            onChange={(e) => definir('pms', e.target.value)}
            inputMode="decimal"
            placeholder="ex.: 154"
            className={INPUT}
          />
        </label>
        <label className={ROTULO}>
          Peso do bag (kg)
          <input
            value={d.pesoBag}
            onChange={(e) => definir('pesoBag', e.target.value)}
            inputMode="decimal"
            placeholder={pesoSugerido != null ? `${String(pesoSugerido).replace('.', ',')} (PMS × ${String(fator).replace('.', ',')})` : 'ou digite o peso'}
            className={INPUT}
          />
        </label>
        <label className={ROTULO}>
          Bags no lote
          <input
            value={d.bags}
            onChange={(e) => definir('bags', e.target.value)}
            inputMode="decimal"
            placeholder="ex.: 4"
            className={INPUT}
          />
        </label>
      </div>

      {comecou && v.erros.length > 0 && (
        <p className="mt-2 text-xs font-medium text-red-600 dark:text-red-400">Falta: {v.erros.join(' · ')}.</p>
      )}
      {v.avisos.map((a) => (
        <p key={a} className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-400">Atenção: {a}.</p>
      ))}

      <div className="mt-3 flex flex-wrap gap-2">
        <Botao
          variante="primario"
          disabled={!v.lote || gravando}
          onClick={async () => {
            if (!v.lote) return
            setGravando(true)
            try {
              await onCriar(v.lote)
            } finally {
              setGravando(false)
            }
          }}
        >
          {gravando ? 'Criando…' : 'Criar lote avulso e usar nesta ordem'}
        </Botao>
        <Botao onClick={onCancelar}>Cancelar</Botao>
      </div>
    </div>
  )
}
