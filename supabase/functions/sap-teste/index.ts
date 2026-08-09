/**
 * Laboratório do SAP em HOMOLOGAÇÃO — proxy da aba "SAP (teste)".
 *
 * Por que existe: o navegador não fala direto com o Service Layer (sem CORS
 * lá, certificado próprio), e a credencial do SAP não pode viver no bundle.
 * O front chama esta função autenticado no Supabase; ela guarda usuário e
 * senha como secrets e repassa APENAS GETs para a homologação.
 *
 * Diferenças da antiga função `sap` (código removido em 28/07/2026, ver histórico):
 *  - Basic Auth POR REQUISIÇÃO, sem Login/cookie — a sessão do Service Layer
 *    está quebrada no ambiente hospedado (docs/integracao-sap.md §6.3) e o
 *    Basic Auth é o contorno validado (§6.4).
 *  - Aponta para o endpoint PRÓPRIO da homologação, descoberto em 09/08/2026
 *    (§6.6) — o SL de produção não atende a base de homolog.
 *  - Caminho OData livre, porque isto é um laboratório: quem explora decide
 *    a consulta. Em troca, o acesso é restrito a UM usuário (lista abaixo),
 *    só leitura, e a autorização do usuário do SAP é a última barreira.
 *
 * Deploy com "Enforce JWT verification" DESLIGADO: a chave anônima é um JWT
 * válido, então essa trava não barra ninguém (lição registrada no
 * PENDENCIAS.md) — quem autentica de verdade é o código abaixo.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2'

const SAP_URL =
  Deno.env.get('SAP_HOM_URL') ??
  'https://sap-sementesvenezahom-sl.skyinone.net:50000/b1s/v1'
const SAP_DB = Deno.env.get('SAP_HOM_DB') ?? 'SBOVENHOM'
const SAP_USER = Deno.env.get('SAP_USER') ?? ''
const SAP_PASSWORD = Deno.env.get('SAP_PASSWORD') ?? ''

/** Só estes logins veem/usam o laboratório. A aba no front usa a mesma lista. */
const USUARIOS_PERMITIDOS = ['arion.pereira@sementesveneza.com.br']

/**
 * O supabase-js manda `apikey` e `x-client-info` além do Authorization. Se
 * qualquer um ficar fora desta lista o navegador bloqueia no preflight e o
 * app só vê "Failed to send a request to the Edge Function".
 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, apikey, x-client-info, content-type, x-supabase-api-version',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
}

// resposta sempre 200: o invoke do supabase-js esconde o corpo de respostas
// não-2xx, e num laboratório a mensagem de erro É o resultado do experimento
const json = (corpo: unknown) =>
  new Response(JSON.stringify(corpo), {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

const recusa = (erro: string, sap?: unknown) => json({ ok: false, erro, sap })

/**
 * Monta a URL final e recusa se ela escapar do service root. Validar o texto
 * cru não basta: o parser de URL colapsa `%2e%2e` e `\` em `..`, então
 * `Items/%2e%2e/%2e%2e/Login` passaria por um `includes('..')` e sairia para
 * fora do /b1s/v1. A regra que vale é a URL RESOLVIDA continuar sob SAP_URL.
 * Devolve { url } ou { erro }.
 */
function resolveCaminho(caminho: string): { url?: string; erro?: string } {
  const c = caminho.trim()
  if (!c) return { erro: 'Informe o caminho OData.' }
  if (c.includes('://')) return { erro: 'Só caminho relativo — sem http(s)://.' }
  if (c.startsWith('/')) return { erro: 'Sem a barra inicial — ex.: Items?$top=1' }
  if (!/^[A-Za-z$]/.test(c)) return { erro: 'O caminho começa com letra (ou $).' }
  let url: URL
  try {
    url = new URL(`${SAP_URL}/${c}`)
  } catch {
    return { erro: 'Caminho inválido.' }
  }
  const raiz = new URL(SAP_URL + '/')
  if (url.origin !== raiz.origin || !url.pathname.startsWith(raiz.pathname)) {
    return { erro: 'Caminho sai do /b1s/v1 — recusado.' }
  }
  return { url: url.toString() }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return recusa('Use POST.')

  // ---- quem chama? (antes de qualquer detalhe de configuração) ----
  const auth = req.headers.get('Authorization') ?? ''
  const sb = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: auth } }, db: { schema: 'tsi' } },
  )
  const { data: userData, error: erroAuth } = await sb.auth.getUser()
  if (erroAuth || !userData?.user) {
    // recusa sempre responde 200 (o invoke esconde corpo de não-2xx), então
    // sem este log um abuso do proxy some do painel de métricas do Supabase
    console.warn('sap-teste: recusa — não autenticado')
    return recusa('Não autenticado.')
  }

  const email = (userData.user.email ?? '').toLowerCase()
  if (!USUARIOS_PERMITIDOS.includes(email)) {
    console.warn(`sap-teste: recusa — usuário fora da lista: ${email}`)
    return recusa('Este laboratório é restrito.')
  }
  const { data: cadastro } = await sb
    .from('usuarios')
    .select('ativo')
    .eq('id', userData.user.id)
    .maybeSingle()
  if (!cadastro || cadastro.ativo !== true) {
    console.warn(`sap-teste: recusa — sem cadastro ativo: ${email}`)
    return recusa('Usuário sem cadastro ativo no TSI.')
  }

  if (!SAP_USER || !SAP_PASSWORD) {
    return recusa('Secrets SAP_USER / SAP_PASSWORD não configurados no projeto.')
  }

  // ---- o pedido ----
  let corpo: { caminho?: string; paginas?: number }
  try {
    corpo = await req.json()
  } catch {
    return recusa('Corpo inválido: esperado JSON { caminho, paginas? }.')
  }
  const primeira = resolveCaminho(corpo.caminho ?? '')
  if (primeira.erro) return recusa(primeira.erro)
  // segue odata.nextLink até este limite — evita varrer o cadastro inteiro
  const paginas = Math.min(Math.max(Math.trunc(corpo.paginas ?? 1), 1), 10)

  try {
    // Basic Auth por requisição (contorno da sessão quebrada, §6.4).
    // TextEncoder (UTF-8), não btoa: btoa é Latin-1 e uma senha com acento
    // (ç/ã, comuns em pt-BR) sairia com bytes errados → 401 sem pista; e
    // caractere fora de Latin-1 lançaria exceção. Fica dentro do try para a
    // resposta de erro sair com CORS.
    const cred = new TextEncoder().encode(
      JSON.stringify({ CompanyDB: SAP_DB, UserName: SAP_USER }) + ':' + SAP_PASSWORD,
    )
    let bin = ''
    cred.forEach((b) => (bin += String.fromCharCode(b)))
    const cabecalhos = {
      Authorization: `Basic ${btoa(bin)}`,
      Prefer: 'odata.maxpagesize=100',
    }

    let proximaUrl: string | null = primeira.url as string
    let dados: Record<string, unknown> | null = null
    let acumulado: unknown[] = []
    let lidas = 0

    while (proximaUrl && lidas < paginas) {
      const resp = await fetch(proximaUrl, { headers: cabecalhos })
      const texto = await resp.text()
      let pagina: Record<string, unknown>
      try {
        pagina = JSON.parse(texto) as Record<string, unknown>
      } catch {
        pagina = { resposta: texto }
      }
      if (!resp.ok) {
        return recusa(`SAP recusou (HTTP ${resp.status}).`, pagina)
      }
      lidas++
      dados = pagina
      if (Array.isArray(pagina.value)) {
        acumulado = acumulado.concat(pagina.value)
        // o nextLink vem do SAP (input semi-confiável): revalida que ainda
        // aponta para dentro do service root antes de refazer o fetch
        const link = pagina['odata.nextLink']
        if (typeof link === 'string') {
          const prox = resolveCaminho(link.replace(/^\//, ''))
          proximaUrl = prox.url ?? null
        } else {
          proximaUrl = null
        }
      } else {
        proximaUrl = null
      }
    }

    if (dados && Array.isArray(dados.value)) dados.value = acumulado
    return json({
      ok: true,
      base: SAP_DB,
      dados,
      paginasLidas: lidas,
      // ainda havia nextLink quando o limite de páginas foi atingido
      temMais: proximaUrl !== null,
    })
  } catch (e) {
    // fetch que nem chegou a responder: DNS, TLS, timeout…
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`sap-teste: ${msg}`)
    return recusa(`Falha de rede ao falar com o SAP: ${msg}`)
  }
})
