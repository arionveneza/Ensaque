/**
 * Proxy do SAP Business One (Service Layer).
 *
 * Por que existe: as credenciais do SAP não podem viver no navegador. O
 * front-end chama esta função autenticado no Supabase; ela guarda usuário e
 * senha como secrets, faz o login no SAP, reaproveita a sessão e devolve
 * apenas os dados de que o app precisa.
 *
 * Duas superfícies:
 *
 *  - AÇÕES FIXAS (Items, lotes): parâmetros validados, sem OData livre do
 *    cliente. Repassar `$filter` permitiria montar consulta arbitrária no ERP.
 *
 *  - CONSULTAS SALVAS: o Gestor cadastra SQL em `tsi.consultas_sap`, manda
 *    registrar no Service Layer e executa por código. É poder de
 *    administrador — por isso o cadastro é restrito ao Gestor, o SQL é
 *    validado como SELECT único, e a autorização de tabelas do usuário do
 *    SAP continua sendo a última barreira.
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const SAP_URL = Deno.env.get('SAP_SL_URL') ?? ''
const SAP_DB = Deno.env.get('SAP_COMPANY_DB') ?? ''
const SAP_USER = Deno.env.get('SAP_USER') ?? ''
const SAP_PASSWORD = Deno.env.get('SAP_PASSWORD') ?? ''

/**
 * O supabase-js manda mais que Authorization: envia `apikey` e `x-client-info`
 * em toda chamada. Se qualquer um deles ficar de fora desta lista, o navegador
 * bloqueia a requisição no preflight e o erro que chega ao app é o genérico
 * "Failed to send a request to the Edge Function" — sem pista da causa.
 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, apikey, x-client-info, content-type, x-supabase-api-version',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
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
    body: JSON.stringify({ CompanyDB: SAP_DB, UserName: SAP_USER, Password: SAP_PASSWORD }),
  })

  if (!resp.ok) {
    const corpo = await resp.text()
    console.error(`SAP login falhou: HTTP ${resp.status}`)
    throw new Error(
      resp.status === 401
        ? 'SAP recusou as credenciais. Verifique os secrets SAP_USER e SAP_PASSWORD.'
        : `SAP indisponível no login (HTTP ${resp.status}).` +
          (corpo.trim() === '' ? ' Resposta vazia — provável falha de infraestrutura.' : ''),
    )
  }

  const cookies = resp.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
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

function motivoDoSap(status: number, corpo: string): string {
  try {
    const j = JSON.parse(corpo) as { error?: { message?: { value?: string } } }
    if (j.error?.message?.value) return j.error.message.value
  } catch { /* corpo não-JSON: fica o status */ }
  return `HTTP ${status}`
}

/** GET no Service Layer, com um relogin automático se a sessão tiver caído. */
async function sapGet(caminho: string): Promise<unknown> {
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const s = await sessaoValida()
    const resp = await fetch(`${SAP_URL}/${caminho}`, {
      headers: { Cookie: s.cookies, Prefer: 'odata.maxpagesize=500' },
    })
    if (resp.ok) return await resp.json()

    // 401/301 = sessão expirada ou perdida: derruba o cache e tenta de novo
    if ((resp.status === 401 || resp.status === 301) && tentativa === 0) {
      sessao = null
      continue
    }
    const corpo = await resp.text()
    console.error(`SAP GET ${caminho.split('?')[0]} → HTTP ${resp.status}`)
    throw new Error(`SAP recusou a consulta: ${motivoDoSap(resp.status, corpo)}`)
  }
  throw new Error('SAP: sessão não pôde ser renovada.')
}

async function sapEnviar(
  metodo: 'POST' | 'PATCH' | 'DELETE',
  caminho: string,
  corpo?: unknown,
): Promise<void> {
  const s = await sessaoValida()
  const resp = await fetch(`${SAP_URL}/${caminho}`, {
    method: metodo,
    headers: { Cookie: s.cookies, 'Content-Type': 'application/json' },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  })
  if (resp.ok) return
  const texto = await resp.text()
  console.error(`SAP ${metodo} ${caminho} → HTTP ${resp.status}`)
  throw new Error(`SAP recusou a gravação: ${motivoDoSap(resp.status, texto)}`)
}

// ---------------------------------------------------------------
// Ações fixas
// ---------------------------------------------------------------

/** Prefixos do cadastro de itens. Só sementes interessam ao TSI. */
const PREFIXO_SEMENTES = 'SOJ'

/** Um ItemCode válido é alfanumérico — barra injeção no caminho e no OData. */
const CODIGO_ITEM_VALIDO = /^[A-Za-z0-9._-]{1,50}$/

async function sementesComEstoque() {
  const filtro = `startswith(ItemCode,'${PREFIXO_SEMENTES}') and QuantityOnStock gt 0`
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

async function lotesDoItem(itemCode: string) {
  if (!CODIGO_ITEM_VALIDO.test(itemCode)) throw new Error('ItemCode inválido.')
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

// ---------------------------------------------------------------
// Consultas salvas
// ---------------------------------------------------------------

const CODIGO_CONSULTA_VALIDO = /^[A-Z][A-Z0-9_]{2,29}$/

/**
 * Aceita apenas UM comando SELECT.
 *
 * O SAP também barra pela autorização do usuário — foi o que aconteceu com
 * "Table 'OSLP' not accessible" — mas essa é a última linha de defesa, não a
 * primeira. Aqui recusamos antes de o texto sair daqui.
 */
function validaSelect(sql: string): void {
  const limpo = sql
    .replace(/--[^\n]*/g, ' ') // comentário de linha
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // comentário de bloco
    .trim()

  if (!/^select\s/i.test(limpo)) {
    throw new Error('A consulta precisa começar com SELECT.')
  }

  // ponto e vírgula no meio = mais de um comando
  if (/;\s*\S/.test(limpo)) {
    throw new Error('Apenas um comando por consulta: remova o ponto e vírgula do meio.')
  }

  const proibidas = [
    'insert', 'update', 'delete', 'merge', 'upsert', 'truncate', 'drop',
    'alter', 'create', 'grant', 'revoke', 'exec', 'execute', 'call',
  ]
  const achada = proibidas.find((p) => new RegExp(`\\b${p}\\b`, 'i').test(limpo))
  if (achada) {
    throw new Error(
      `A consulta contém "${achada.toUpperCase()}". Só leitura é permitida aqui.`,
    )
  }
}

interface ConsultaSalva {
  codigo: string
  nome: string
  sql: string
  registrada_em: string | null
}

async function buscaConsulta(sb: SupabaseClient, codigo: string): Promise<ConsultaSalva> {
  if (!CODIGO_CONSULTA_VALIDO.test(codigo)) throw new Error('Código de consulta inválido.')
  const { data, error } = await sb
    .from('consultas_sap')
    .select('codigo, nome, sql, registrada_em')
    .eq('codigo', codigo)
    .maybeSingle()
  if (error) throw new Error(`Consulta ${codigo}: ${error.message}`)
  if (!data) throw new Error(`Consulta ${codigo} não existe no cadastro.`)
  return data as ConsultaSalva
}

/**
 * Envia a consulta ao Service Layer. Tenta criar; se já existir, atualiza —
 * assim editar o SQL no app e mandar registrar de novo simplesmente funciona.
 */
async function registrarConsulta(sb: SupabaseClient, codigo: string) {
  const consulta = await buscaConsulta(sb, codigo)
  validaSelect(consulta.sql)

  const corpo = {
    SqlCode: consulta.codigo,
    SqlName: consulta.nome.slice(0, 100),
    SqlText: consulta.sql,
  }

  let atualizou = false
  try {
    await sapEnviar('POST', 'SQLQueries', corpo)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!/exist|duplicat|already/i.test(msg)) throw e
    // já existe: sobrescreve o texto
    await sapEnviar('PATCH', `SQLQueries('${consulta.codigo}')`, {
      SqlName: corpo.SqlName,
      SqlText: corpo.SqlText,
    })
    atualizou = true
  }

  const { error } = await sb
    .from('consultas_sap')
    .update({ registrada_em: new Date().toISOString() })
    .eq('codigo', codigo)
  if (error) console.error(`registrada_em não gravado: ${error.message}`)

  return { codigo, atualizou }
}

async function executarConsulta(sb: SupabaseClient, codigo: string) {
  const consulta = await buscaConsulta(sb, codigo)
  if (!consulta.registrada_em) {
    throw new Error(
      `A consulta ${codigo} ainda não foi registrada no SAP, ou o SQL mudou depois do último registro. Clique em Registrar.`,
    )
  }
  const dados = (await sapGet(`SQLQueries('${codigo}')/List`)) as {
    value?: Record<string, unknown>[]
  }
  return dados.value ?? []
}

async function removerConsulta(sb: SupabaseClient, codigo: string) {
  await buscaConsulta(sb, codigo)
  await sapEnviar('DELETE', `SQLQueries('${codigo}')`)
  const { error } = await sb
    .from('consultas_sap')
    .update({ registrada_em: null })
    .eq('codigo', codigo)
  if (error) console.error(`registrada_em não limpo: ${error.message}`)
  return { codigo, removida: true }
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
  const sb = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: auth } }, db: { schema: 'tsi' } },
  )

  const { data: userData, error: erroAuth } = await sb.auth.getUser()
  if (erroAuth || !userData?.user) return json({ erro: 'Não autenticado.' }, 401)

  const { data: perfil } = await sb
    .from('usuarios')
    .select('perfil, ativo')
    .eq('id', userData.user.id)
    .maybeSingle()

  if (!perfil || perfil.ativo !== true) {
    return json({ erro: 'Usuário sem cadastro ativo no TSI.' }, 403)
  }
  const ehGestor = perfil.perfil === 'Gestor'

  // ---- configuração (só depois de autenticado) ----
  const faltando = Object.entries({
    SAP_SL_URL: SAP_URL, SAP_COMPANY_DB: SAP_DB,
    SAP_USER: SAP_USER, SAP_PASSWORD: SAP_PASSWORD,
  }).filter(([, v]) => !v).map(([k]) => k)

  if (faltando.length > 0) {
    return json({ erro: `Secret não configurado no projeto: ${faltando.join(', ')}.` }, 500)
  }

  // ---- ação ----
  let corpo: { acao?: string; itemCode?: string; codigo?: string }
  try {
    corpo = await req.json()
  } catch {
    return json({ erro: 'Corpo inválido: esperado JSON.' }, 400)
  }

  const exigeGestor = () => {
    if (!ehGestor) throw new Error('Apenas o perfil Gestor administra consultas do SAP.')
  }
  const exigeCodigo = () => {
    if (!corpo.codigo) throw new Error('codigo é obrigatório.')
    return corpo.codigo
  }

  try {
    switch (corpo.acao) {
      case 'ping':
        await sessaoValida()
        return json({ dados: { sap: 'conectado', base: SAP_DB } })

      case 'sementesComEstoque':
        return json({ dados: await sementesComEstoque() })

      case 'lotesDoItem':
        if (!corpo.itemCode) return json({ erro: 'itemCode é obrigatório.' }, 400)
        return json({ dados: await lotesDoItem(corpo.itemCode) })

      // ---- consultas salvas ----
      case 'executarConsulta':
        return json({ dados: await executarConsulta(sb, exigeCodigo()) })

      case 'registrarConsulta':
        exigeGestor()
        return json({ dados: await registrarConsulta(sb, exigeCodigo()) })

      case 'removerConsulta':
        exigeGestor()
        return json({ dados: await removerConsulta(sb, exigeCodigo()) })

      /** O que está registrado no SAP hoje, independente do nosso cadastro. */
      case 'consultasNoSap': {
        exigeGestor()
        const r = (await sapGet('SQLQueries?$select=SqlCode,SqlName')) as {
          value?: Record<string, unknown>[]
        }
        return json({ dados: r.value ?? [] })
      }

      default:
        return json(
          {
            erro: 'Ação desconhecida.',
            permitidas: [
              'ping', 'sementesComEstoque', 'lotesDoItem',
              'executarConsulta', 'registrarConsulta', 'removerConsulta', 'consultasNoSap',
            ],
          },
          400,
        )
    }
  } catch (e) {
    const mensagem = e instanceof Error ? e.message : String(e)
    console.error(`Falha na ação ${corpo.acao}: ${mensagem}`)
    // 403 quando é barreira de perfil, 502 quando é o SAP que recusou
    const status = /perfil Gestor/.test(mensagem) ? 403 : 502
    return json({ erro: mensagem }, status)
  }
})
