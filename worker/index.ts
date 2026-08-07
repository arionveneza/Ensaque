/**
 * Entrada do Worker. Faz uma coisa só: mandar quem chegou por um endereço
 * antigo para o definitivo. Todo o resto é servido pelo binding de assets,
 * exatamente como antes deste arquivo existir.
 *
 * Por que existe: `tsi.veneza.app.br` e `ensaque.<conta>.workers.dev` servem
 * o MESMO Worker, então os dois sempre mostram a versão atual — não há risco
 * de alguém trabalhar num sistema velho, como houve com o GitHub Pages. O
 * problema é outro: dois links circulando pela empresa é confusão garantida,
 * e o endereço feio é o que já está nos favoritos dos tablets.
 *
 * O redirecionamento é 301 (permanente) para o navegador atualizar o favorito
 * sozinho, e preserva caminho e query — hoje o app não usa rotas, mas se um
 * dia usar, o link continua chegando ao lugar certo.
 */

const DEFINITIVO = 'tsi.veneza.app.br'

export default {
  async fetch(request: Request, env: { ASSETS: Fetcher }): Promise<Response> {
    const url = new URL(request.url)
    if (url.hostname.endsWith('.workers.dev')) {
      url.hostname = DEFINITIVO
      url.port = ''
      return Response.redirect(url.toString(), 301)
    }
    return env.ASSETS.fetch(request)
  },
}
