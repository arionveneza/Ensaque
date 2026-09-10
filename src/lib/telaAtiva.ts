/**
 * Qual tela o app abre — e como ela sobrevive a uma recarga.
 *
 * Até 12/09/2026 a tela ativa vivia só em `useState`: F5, tablet que descartou a
 * aba, atalho da tela inicial ou chunk velho depois de um deploy voltavam sempre
 * pra Execução ("as telas ficam atualizando e abrem em outra página"). Agora a
 * vista vai pro hash da URL (`#expedicao`) E pro localStorage:
 *  - o hash é o que a recarga da MESMA aba devolve (e permite abrir
 *    `tsi.veneza.app.br/#mapa` direto);
 *  - o storage cobre a aba nova sem hash — o atalho na tela inicial do tablet
 *    abre a URL limpa, e ainda assim tem que cair na tela em que o posto vive.
 *
 * O supabase-js usa o MESMO hash pro link de recuperação de senha
 * (`#access_token=…&type=recovery`) e o limpa na inicialização; por isso só um
 * id de vista conhecido é aceito, e quem grava a vista é só a ação do usuário
 * (clique no menu), nunca a montagem — senão disputaria o fragmento com ele.
 */

const CHAVE = 'tsi.tela'

/** `#expedicao` → `expedicao`; `#` ou vazio → ''. */
export const vistaDoHash = (hash: string): string =>
  hash.startsWith('#') ? hash.slice(1) : hash

/**
 * Decide a vista inicial: hash válido vence; senão a salva, se válida; senão
 * null (quem chama aplica o padrão). Pura, pra testar sem navegador.
 */
export function resolverVistaInicial(
  hash: string,
  salva: string | null,
  validas: readonly string[],
): string | null {
  const doHash = vistaDoHash(hash)
  if (doHash && validas.includes(doHash)) return doHash
  if (salva && validas.includes(salva)) return salva
  return null
}

export function lerVistaInicial(validas: readonly string[]): string | null {
  let salva: string | null = null
  try {
    salva = localStorage.getItem(CHAVE)
  } catch {
    // storage desabilitado: só o hash decide
  }
  return resolverVistaInicial(window.location.hash, salva, validas)
}

/**
 * Grava a vista escolhida pelo usuário. `replaceState`, não `pushState`: o
 * botão Voltar continua saindo do app como antes — a URL só serve de memória.
 */
export function gravarVista(id: string): void {
  try {
    history.replaceState(null, '', '#' + id)
  } catch {
    // ambiente sem history (teste, iframe restrito): fica só o storage
  }
  try {
    localStorage.setItem(CHAVE, id)
  } catch {
    // sem storage a aba nova abre no padrão; a recarga da mesma aba ainda tem o hash
  }
}
