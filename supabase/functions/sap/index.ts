/**
 * Proxy de leitura do SAP Business One (Service Layer).
 *
 * Por que existe: as credenciais do SAP não podem viver no navegador. O
 * front-end chama esta função autenticado no Supabase; ela guarda usuário e
 * senha como secrets, faz o login no SAP, reaproveita a sessão e devolve
 * apenas os dados de que o app precisa.
 *
 * Superfície fechada: em vez de repassar OData livre, expõe AÇÕES nomeadas com
 * parâmetros validados. Repassar `$filter` do cliente permitiria montar
 * consulta arbitrária no ERP — inclusive fora de Items.
 *
 * Somente leitura. Nada aqui escreve no SAP.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2'

const SAP_URL = Deno.env.get('SAP_SL_URL') ?? ''
const SAP_DB = Deno.env.get('SAP_COMPANY_DB') ?? ''
const SAP_USER = Deno.env.get('SAP_USER') ?? ''
const SAP_PASSWORD = Deno.env.get('SAP_PASSWORD') ?? ''

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

// ---------------------------------------------------------------
// Sessão do SAP
// ---------------------------------------------------------------

interface Sessao {
  /** Cookies completos. O balanceador devolve B1SESSION **e** ROUTEID: o
   *  ROUTEID diz qual nó guarda a sessão. Mandar só o B1SESSION resulta em
   *  "Invalid session or session already timeout". */
  cookies: string
  expiraEm: number
}

// cache no escopo do módulo: a instância costuma sobreviver entre chamadas
let sessao: Sessao | null = null

/** O SAP encerra a sessão com 30 min de inatividade; renovamos antes disso. */
const MARGEM_MS = 5 * 60 * 1000

async function login(): Promise<Sessao> {
  const resp = await fetch(`${SAP_URL}/Login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      CompanyDB: SAP_DB,
      UserName: SAP_USER,
      Password: SAP_PASSWORD,
    }),
  })

  if (!resp.ok) {
    const corpo = await resp.text()
    // nunca ecoar o corpo cru: pode conter detalhe de ambiente
    console.error(`SAP login falhou: HTTP ${resp.status}`)
    throw new Error(
      resp.status === 401
        ? 'SAP recusou as credenciais. Verifique os secrets SAP_USER e SAP_PASSWORD.'
        : `SAP indisponível no login (HTTP ${resp.status}).` +
          (corpo.trim() === '' ? ' Resposta vazia — provável falha de infraestrutura.' : ''),
    )
  }

  // getSetCookie preserva TODOS os cookies; juntar num header único
  const cookies = resp.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')

  if (!cookies.includes('B1SESSION')) {
    throw new Error('SAP respondeu ao login sem cookie de sessão.')
  }

  const dados = (await resp.json()) as { SessionTimeout?: number }
  const minutos = dados.SessionTimeout ?? 30
  return { cookies, expiraEm: Date.now() + minutos * 60_000 - MARGEM_MS }
}

async function sessaoValida(): Promise<Sessao> {
  if (sessao && sessao.expiraEm > Date.now()) return sessao
  sessao = await login()
  return sessao
}

/** GET no Service Layer, com um relogin automático se a sessão tiver caído. */
async function sapGet(caminho: string): Promise<unknown> {
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const s = await sessaoValida()
    const resp = await fetch(`${SAP_URL}/${caminho}`, {
      headers: { Cookie: s.cookies, Prefer: 'odata.maxpagesize=200' },
    })

    if (resp.ok) return await resp.json()

    // 401/301 = sessão expirada ou perdida: derruba o cache e tenta de novo
    if ((resp.status === 401 || resp.status === 301) && tentativa === 0) {
      sessao = null
      continue
    }

    console.error(`SAP GET ${caminho.split('?')[0]} → HTTP ${resp.status}`)
    throw new Error(`SAP recusou a consulta (HTTP ${resp.status}).`)
  }
  throw new Error('SAP: sessão não pôde ser renovada.')
}

// ---------------------------------------------------------------
// Ações permitidas
// ---------------------------------------------------------------

/** Prefixos do cadastro de itens. Só sementes interessam ao TSI. */
const PREFIXOS = { sementes: 'SOJ', insumos: 'INS', consumo: 'CUS', patrimonio: 'PAT' }

/** Um ItemCode válido é alfanumérico — barra injeção no caminho e no OData. */
const CODIGO_VALIDO = /^[A-Za-z0-9._-]{1,50}$/

interface Semente {
  itemCode: string
  nome: string
  estoque: number
  grupo: number | null
}

interface Lote {
  numero: string
  itemCode: string
  quantidade: number
  validade: string | null
  fabricacao: string | null
}

async function sementesComEstoque(): Promise<Semente[]> {
  const filtro = `startswith(ItemCode,'${PREFIXOS.sementes}') and QuantityOnStock gt 0`
  const dados = (await sapGet(
    `Items?$select=ItemCode,ItemName,QuantityOnStock,ItemsGroupCode&$filter=${encodeURIComponent(filtro)}`,
  )) as { value?: Record<string, unknown>[] }

  return (dados.value ?? []).map((i) => ({
    itemCode: String(i.ItemCode ?? ''),
    nome: String(i.ItemName ?? ''),
    estoque: Number(i.QuantityOnStock ?? 0),
    grupo: i.ItemsGroupCode == null ? null : Number(i.ItemsGroupCode),
  }))
}

async function lotesDoItem(itemCode: string): Promise<Lote[]> {
  if (!CODIGO_VALIDO.test(itemCode)) {
    throw new Error('ItemCode inválido.')
  }
  const filtro = `ItemCode eq '${itemCode}'`
  const dados = (await sapGet(
    `BatchNumberDetails?$select=Batch,ItemCode,Quantity,ExpirationDate,ManufacturingDate&$filter=${encodeURIComponent(filtro)}`,
  )) as { value?: Record<string, unknown>[] }

  return (dados.value ?? []).map((b) => ({
    numero: String(b.Batch ?? ''),
    itemCode: String(b.ItemCode ?? ''),
    quantidade: Number(b.Quantity ?? 0),
    validade: b.ExpirationDate ? String(b.ExpirationDate) : null,
    fabricacao: b.ManufacturingDate ? String(b.ManufacturingDate) : null,
  }))
}

async function itemPorCodigo(itemCode: string) {
  if (!CODIGO_VALIDO.test(itemCode)) throw new Error('ItemCode inválido.')
  return await sapGet(
    `Items('${itemCode}')?$select=ItemCode,ItemName,QuantityOnStock,ItemsGroupCode`,
  )
}

// ---------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ erro: 'Use POST.' }, 405)

  // ---- quem está chamando? ----
  // A autenticação vem ANTES de qualquer checagem de configuração: o estado
  // dos secrets é informação de servidor e não deve vazar para quem não
  // provou ser usuário.
  //
  // A chave anônima é pública e é, ela própria, um JWT válido — então
  // verify_jwt sozinho não protege nada. Exigimos um usuário de verdade e
  // com cadastro em tsi.usuarios, o mesmo critério do RLS.
  const auth = req.headers.get('Authorization') ?? ''
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: auth } }, db: { schema: 'tsi' } },
  )

  const { data: userData, error: erroAuth } = await supabase.auth.getUser()
  if (erroAuth || !userData?.user) {
    return json({ erro: 'Não autenticado.' }, 401)
  }

  const { data: perfil } = await supabase
    .from('usuarios')
    .select('perfil, ativo')
    .eq('id', userData.user.id)
    .maybeSingle()

  if (!perfil || perfil.ativo !== true) {
    return json({ erro: 'Usuário sem cadastro ativo no TSI.' }, 403)
  }

  // ---- configuração (só depois de autenticado) ----
  const faltando = Object.entries({
    SAP_SL_URL: SAP_URL,
    SAP_COMPANY_DB: SAP_DB,
    SAP_USER: SAP_USER,
    SAP_PASSWORD: SAP_PASSWORD,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k)

  if (faltando.length > 0) {
    return json(
      { erro: `Secret não configurado no projeto: ${faltando.join(', ')}.` },
      500,
    )
  }

  // ---- ação ----
  let corpo: { acao?: string; itemCode?: string }
  try {
    corpo = await req.json()
  } catch {
    return json({ erro: 'Corpo inválido: esperado JSON.' }, 400)
  }

  try {
    switch (corpo.acao) {
      case 'sementesComEstoque':
        return json({ dados: await sementesComEstoque() })

      case 'lotesDoItem':
        if (!corpo.itemCode) return json({ erro: 'itemCode é obrigatório.' }, 400)
        return json({ dados: await lotesDoItem(corpo.itemCode) })

      case 'itemPorCodigo':
        if (!corpo.itemCode) return json({ erro: 'itemCode é obrigatório.' }, 400)
        return json({ dados: await itemPorCodigo(corpo.itemCode) })

      case 'ping':
        // confirma que o login no SAP funciona, sem trazer dado nenhum
        await sessaoValida()
        return json({ dados: { sap: 'conectado', base: SAP_DB } })

      default:
        return json(
          {
            erro: 'Ação desconhecida.',
            permitidas: ['sementesComEstoque', 'lotesDoItem', 'itemPorCodigo', 'ping'],
          },
          400,
        )
    }
  } catch (e) {
    const mensagem = e instanceof Error ? e.message : String(e)
    console.error(`Falha na ação ${corpo.acao}: ${mensagem}`)
    return json({ erro: mensagem }, 502)
  }
})
