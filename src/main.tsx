import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

/**
 * Depois de um deploy o hash dos chunks muda; a aba que ficou aberta com o app
 * velho falha ao carregar uma tela sob demanda (`lazy`) e, sem ErrorBoundary,
 * virava tela branca até alguém dar F5 — e o F5 caía em Execução. Recarregar
 * aqui traz o app novo na MESMA tela (o hash da URL guarda a vista —
 * src/lib/telaAtiva.ts). Guarda de 30 s contra laço: se o chunk continuar
 * falhando (rede fora), o erro segue o caminho normal. Sem sessionStorage não
 * há como contar, então não recarrega.
 */
window.addEventListener('vite:preloadError', (evento) => {
  const CHAVE = 'tsi.recarregou'
  let ultima: number | null = null
  try {
    ultima = Number(sessionStorage.getItem(CHAVE) ?? 0)
    sessionStorage.setItem(CHAVE, String(Date.now()))
  } catch {
    ultima = null
  }
  if (ultima === null || Date.now() - ultima < 30_000) return
  evento.preventDefault()
  window.location.reload()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
