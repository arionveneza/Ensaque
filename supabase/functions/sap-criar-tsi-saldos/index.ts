/**
 * Ação ÚNICA e deliberada: cria a consulta salva TSI_SALDOS em produção
 * (SBOVENPRD), a mesma já validada na homologação em 09/08/2026
 * (docs/integracao-sap.md §6.6) — join OBTN×OBTQ com o saldo real por lote
 * (PMS, tratamento, depósito, quantidade), muito mais completa que a
 * composição LotesSASaldo+BatchNumberDetails usada como contorno até aqui.
 *
 * Por que uma função SEPARADA da `sap-teste`: aquele laboratório é
 * deliberadamente só-leitura, SEMPRE GET, em qualquer ambiente — é a
 * garantia de segurança dele. Esta função faz exatamente UM POST, com
 * corpo FIXO (não aceita nenhum parâmetro do chamador) — não é um proxy
 * genérico de escrita, é uma ação de configuração única. Mesma trava de
 * acesso da `sap-teste` (usuário autenticado + allowlist).
 *
 * Depois de criada, a consulta fica disponível em produção pra sempre —
 * não precisa rodar esta função de novo (isso é o que faz LotesSASaldo já
 * funcionar hoje: foi criada uma vez, executada quantas vezes precisar).
 */

import { createClient } from 'jsr:@supabase/supabase-js@2'

const SAP_URL = Deno.env.get('SAP_PROD_URL') ?? 'https://sap-sementesveneza-sl.skyinone.net:50000/b1s/v1'
const SAP_DB = Deno.env.get('SAP_PROD_DB') ?? 'SBOVENPRD'
const SAP_USER = Deno.env.get('SAP_USER') ?? ''
const SAP_PASSWORD = Deno.env.get('SAP_PASSWORD') ?? ''

/** Mesma lista da `sap-teste` — é ação sobre produção do SAP, mesma cautela. */
const USUARIOS_PERMITIDOS = ['arion.pereira@sementesveneza.com.br']

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, apikey, x-client-info, content-type, x-supabase-api-version',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
}

const json = (corpo: unknown) =>
  new Response(JSON.stringify(corpo), {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

const recusa = (erro: string, sap?: unknown) => json({ ok: false, erro, sap })

/** Mesma consulta validada na homologação (docs/integracao-sap.md §3.2), SEM
 *  prefixo de schema (roda no contexto da empresa autenticada) e com aliases
 *  100% ASCII: o primeiro clique (13/08/2026) gravou a versão com "Nº do
 *  Lote" e o `º` se corrompeu no caminho até o HANA — a consulta salvou,
 *  mas executava com `257 sql syntax error: unterminated quoted identifier:
 *  line 3 col 26`, exatamente a coluna do `º`. Acento/símbolo em alias não
 *  sobrevive a este transporte; os nomes legíveis ficam por conta da tela. */
const SQL_TEXT = `SELECT
    Lote."ItemCode",
    Lote."DistNumber" AS "NumLote",
    Lote."itemName" AS "DescricaoItem",
    Lote."U_AGRT_ClassQualidade" AS "ClassQualidade",
    Lote."U_AGRT_CategoriaLote" AS "CategoriaLote",
    Lote."U_AGRT_Peneira" AS "Peneira",
    Lote."U_AGRT_PMS" AS "PMS",
    Lote."U_AGRT_PesoBruto" AS "PesoBruto",
    Lote."U_LoteTSI" AS "TratamentoTSI",
    Lote."U_Destinacao" AS "Destinacao",
    Saldo."WhsCode" AS "Deposito",
    Saldo."Quantity" AS "QtdEstoque"
FROM OBTN Lote
INNER JOIN OBTQ Saldo
    ON Saldo."ItemCode" = Lote."ItemCode"
    AND Saldo."SysNumber" = Lote."SysNumber"
WHERE Saldo."Quantity" > 0
ORDER BY Lote."ItemCode", Lote."DistNumber", Saldo."WhsCode"`

function basicAuthHeader(): string {
  const cred = new TextEncoder().encode(
    JSON.stringify({ CompanyDB: SAP_DB, UserName: SAP_USER }) + ':' + SAP_PASSWORD,
  )
  let bin = ''
  cred.forEach((b) => (bin += String.fromCharCode(b)))
  return `Basic ${btoa(bin)}`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return recusa('Use POST.')

  const auth = req.headers.get('Authorization') ?? ''
  const sb = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: auth } }, db: { schema: 'tsi' } },
  )
  const { data: userData, error: erroAuth } = await sb.auth.getUser()
  if (erroAuth || !userData?.user) return recusa('Não autenticado.')

  const email = (userData.user.email ?? '').toLowerCase()
  if (!USUARIOS_PERMITIDOS.includes(email)) return recusa('Ação restrita.')

  if (!SAP_USER || !SAP_PASSWORD) {
    return recusa('Secrets SAP_USER / SAP_PASSWORD não configurados no projeto.')
  }

  const cabecalhos = {
    Authorization: basicAuthHeader(),
    'Content-Type': 'application/json',
  }

  try {
    const criar = await fetch(`${SAP_URL}/SQLQueries`, {
      method: 'POST',
      headers: cabecalhos,
      body: JSON.stringify({
        SqlCode: 'TSI_SALDOS',
        SqlName: 'Saldos TSI por lote',
        SqlText: SQL_TEXT,
      }),
    })
    const textoCriar = await criar.text()
    let corpoCriar: unknown
    try {
      corpoCriar = JSON.parse(textoCriar)
    } catch {
      corpoCriar = { resposta: textoCriar }
    }
    let acao = 'criada'
    if (!criar.ok) {
      // consulta já existe (ex.: o primeiro clique gravou a versão com alias
      // quebrado) → regrava o SqlText por cima. Mesmo alvo, mesma natureza
      // de metadado — o conserto autorizado junto com a criação.
      const atualizar = await fetch(`${SAP_URL}/SQLQueries('TSI_SALDOS')`, {
        method: 'PATCH',
        headers: cabecalhos,
        body: JSON.stringify({ SqlText: SQL_TEXT }),
      })
      if (!atualizar.ok && atualizar.status !== 204) {
        const textoAtualizar = await atualizar.text()
        let corpoAtualizar: unknown
        try {
          corpoAtualizar = JSON.parse(textoAtualizar)
        } catch {
          corpoAtualizar = { resposta: textoAtualizar }
        }
        return recusa(
          `SAP recusou criar (HTTP ${criar.status}) e também atualizar (HTTP ${atualizar.status}).`,
          { criar: corpoCriar, atualizar: corpoAtualizar },
        )
      }
      acao = 'atualizada'
      corpoCriar = { atualizada: true }
    }

    // já executa uma vez, pra confirmar que funciona sem precisar de um segundo clique
    const executar = await fetch(`${SAP_URL}/SQLQueries('TSI_SALDOS')/List`, {
      method: 'GET',
      headers: { Authorization: cabecalhos.Authorization, Prefer: 'odata.maxpagesize=100' },
    })
    const textoExecutar = await executar.text()
    let corpoExecutar: unknown
    try {
      corpoExecutar = JSON.parse(textoExecutar)
    } catch {
      corpoExecutar = { resposta: textoExecutar }
    }

    return json({
      ok: true,
      acao,
      criada: corpoCriar,
      execucao: {
        ok: executar.ok,
        status: executar.status,
        dados: corpoExecutar,
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`sap-criar-tsi-saldos: ${msg}`)
    return recusa(`Falha de rede ao falar com o SAP: ${msg}`)
  }
})
