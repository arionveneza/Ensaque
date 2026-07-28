# Integração SAP Business One — Service Layer

> **Status:** acesso liberado pela Agrotis em 28/07/2026, porém **o ambiente está instável** —
> ver §7. Pendente: primeiro login estável e confirmação do mapeamento de campos (§4).
>
> ⚠️ **Lição já aprendida (vale para o job de produção):** o Service Layer roda atrás de um
> balanceador Apache que devolve **dois** cookies no login: `B1SESSION` **e** `ROUTEID`.
> O `ROUTEID` define qual nó guarda a sessão. Enviar apenas o `B1SESSION` causa
> `code 301 — "Invalid session or session already timeout"`. **O cliente HTTP precisa preservar
> todos os cookies** (em PowerShell: `-SessionVariable`/`-WebSession`; em Node: um cookie jar).

> ⚠️ **Segunda lição, do lado do Supabase:** o `supabase-js` envia `apikey` e `x-client-info`
> em toda chamada, além do `Authorization`. Se qualquer um deles ficar fora do
> `Access-Control-Allow-Headers` da Edge Function, o navegador bloqueia a requisição **no
> preflight** e o app recebe apenas `Failed to send a request to the Edge Function` — uma
> mensagem que não tem nenhuma relação aparente com a causa. Diagnostica-se com um
> `curl -X OPTIONS` mandando os mesmos `Access-Control-Request-Headers` do navegador.

## 1. Ambiente

| Item | Valor |
|---|---|
| Endpoint | `https://sap-sementesveneza-sl.skyinone.net:50000/b1s/v1` |
| Homologação | `SBOVENHOM2` ← **usar para desenvolver** |
| Produção | `SBOVENPRD` ← só o job final, **somente leitura** |
| Plataforma | SAP B1 sobre HANA (hospedado Agrotis/AutoSky) |
| TLS | certificado provavelmente autoassinado |

**Nunca** faça POST/PATCH/DELETE em `SBOVENPRD`. O app TSI só **lê** do SAP.

## 2. Teste de conexão (executar você mesmo, com suas credenciais)

**Windows PowerShell 5.1** (o padrão do Windows — `-SkipCertificateCheck` NÃO existe nele):
```powershell
add-type @"
using System.Net;using System.Security.Cryptography.X509Certificates;
public class TrustAll : ICertificatePolicy {
  public bool CheckValidationResult(ServicePoint s,X509Certificate c,WebRequest r,int p){return true;}
}
"@
[System.Net.ServicePointManager]::CertificatePolicy = New-Object TrustAll
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$body = '{"CompanyDB":"SBOVENHOM2","UserName":"USUARIO","Password":"SENHA"}'
Invoke-RestMethod -Method Post -Uri "https://sap-sementesveneza-sl.skyinone.net:50000/b1s/v1/Login" -Body $body -ContentType "application/json"
```

**PowerShell 7+**:
```powershell
$body = '{"CompanyDB":"SBOVENHOM2","UserName":"USUARIO","Password":"SENHA"}'
Invoke-RestMethod -Method Post -Uri "https://sap-sementesveneza-sl.skyinone.net:50000/b1s/v1/Login" `
  -Body $body -ContentType "application/json" -SkipCertificateCheck
```

> Armadilhas que já custaram tempo: **aspas** nos valores (`UserName=ven...` sem aspas faz o PowerShell
> tentar executar o valor como comando) e **quebra de linha** — cole o comando inteiro de uma vez,
> senão `-Body` vira um comando separado e o servidor responde `400 Solicitação Incorreta`.

curl:
```bash
curl -k -X POST https://sap-sementesveneza-sl.skyinone.net:50000/b1s/v1/Login \
  -H "Content-Type: application/json" \
  -d '{"CompanyDB":"SBOVENHOM2","UserName":"SEU_USUARIO","Password":"SUA_SENHA"}'
```

**Resposta esperada:**
```json
{ "odata.metadata":"...", "SessionId":"xxxxxxxx-...", "Version":"1000xxx", "SessionTimeout":30 }
```

Guarde o cookie `B1SESSION=<SessionId>` — ele autentica as chamadas seguintes e expira em
~30 min de inatividade. Sempre faça `POST /Logout` ao terminar (sessão aberta consome licença).

Erros comuns: `-304 Invalid company db` (base errada) · `-1116 Invalid user/password` ·
`301 Unauthorized` (licença não atribuída ao usuário) · erro de TLS (use `-k` / `-SkipCertificateCheck`).

## 3. Consultas

### 3.1 Pedidos de venda (substitui o relatório da SimpleAgro)
```http
GET /b1s/v1/Orders?$select=DocEntry,DocNum,DocDate,DocDueDate,CardCode,CardName,DocumentStatus&
$expand=DocumentLines($select=LineNum,ItemCode,ItemDescription,Quantity,RemainingOpenQuantity,LineStatus)&
$filter=DocumentStatus eq 'bost_Open' and DocDate ge 2026-01-01
```
- `RemainingOpenQuantity` é o equivalente ao **Saldo a Faturar** (col. BW) do relatório atual.
- Filtrar também `LineStatus eq 'bost_Open'` no processamento das linhas.
- Paginação: o SL devolve 20 registros por página; siga `odata.nextLink` ou use
  `Prefer: odata.maxpagesize=100`.

### 3.2 Estoque de produto acabado e lotes
```http
GET /b1s/v1/Items?$select=ItemCode,ItemName,QuantityOnStock,ItemsGroupCode&
$expand=ItemWarehouseInfoCollection($select=WarehouseCode,InStock,Committed)&
$filter=ItemsGroupCode eq <grupo de sementes> and QuantityOnStock gt 0
```
Para lotes com PMS e saldo por lote (o que hoje vem da tela *Saldos*), o caminho mais direto é uma
**query SQL** publicada no SL — mesma consulta que o cliente B1 já usa ("Auditoria de Estoques
(itens com lote)"):
```http
POST /b1s/v1/SQLQueries          # criar uma vez
{ "SqlCode":"TSI_SALDOS", "SqlName":"Saldos TSI", "SqlText":"SELECT ..." }

GET /b1s/v1/SQLQueries('TSI_SALDOS')/List   # executar
```

## 4. Mapeamento de campos — **A CONFIRMAR**

O app precisa de **cultivar + tratamento + embalagem + quantidade em bags**. Na SimpleAgro isso já
foi resolvido. No SAP, o padrão observado no cliente B1 é o mesmo:

| Dado do app | Onde parece estar no SAP | Confirmar |
|---|---|---|
| Cultivar | `ItemName` — ex. `SS NEO680 IPRO BB5M` → trecho do meio | ✔ padrão igual à SimpleAgro |
| Embalagem | último token do `ItemName` (`BB5M`, `BMB`) | ✔ mesmo de-para: BB5M→BG5M, BMB→MEIOBAG |
| **Tratamento** | coluna "Lote TSI" na consulta de estoque; em pedidos, ? | ❓ **onde vive o código do tratamento (FTZ60, V&P…)?** UDF no item? no pedido? |
| PMS | campo do lote (na consulta aparece como `Lote Pme`) | ❓ nome real do campo/UDF |
| Quantidade | `RemainingOpenQuantity` (pedidos) · `InStock` (estoque) | ❓ unidade: bags ou kg? |
| Aprovação financeira | ❓ existe status equivalente ao da SimpleAgro? | ❓ se não existir, manter pedidos vindo da SimpleAgro e só o estoque do SAP |

**Como resolver:** com a sessão aberta, rode `GET /Items('SOJ00002')` e
`GET /Orders?$top=1&$expand=DocumentLines` e olhe o JSON completo — os UDFs aparecem como
`U_XXX`. Traga o JSON e o mapeamento se resolve em minutos.

## 5. Job de sincronização (desenho)

```
[cron a cada 1h]
  → POST /Login (SBOVENPRD, usuário somente leitura)
  → GET  /Orders  (pedidos abertos)      → normaliza → upsert em pedidos_venda (nova carga)
  → GET  /Items   (estoque + lotes)      → normaliza → upsert em estoque_pa + lotes_semente
  → POST /Logout
  → registra em cargas_demanda (origem='sap')
```

**Onde rodar:** duas opções, ambas viáveis agora que o endpoint é público.
1. **Supabase Edge Function** com `pg_cron`/Scheduled Function — mais simples, nada de servidor.
2. Script Node/Python **dentro da rede da Veneza** empurrando para o Supabase — melhor se a Agrotis
   restringir o acesso por IP.

O upload manual de planilhas **permanece** como contingência (queda de rede, SAP indisponível).

## 6. Diagnóstico do ambiente — 28/07/2026

Executado com `Downloads\diag-sap.ps1` (log em `diag-sap.txt`). Camada por camada:

| Camada | Resultado |
|---|---|
| DNS | ✔ `sap-sementesveneza-sl.skyinone.net` → `134.65.247.214` |
| TCP porta 50000 | ✔ aberta |
| HTTPS / balanceador | ✔ `Apache/2.4.54`, atribui `ROUTEID=.node3` |
| Nó do Service Layer | ✖ **HTTP 500 com corpo vazio** em todas as requisições |
| Autenticação | ✖ não avaliada — o 500 ocorre **antes** da validação da credencial |

**Prova de que não é credencial:** um `POST /Login` com **senha deliberadamente errada** também
retornou `HTTP 500` (o esperado seria `code -1116`). O nó estoura antes de avaliar a senha.

Histórico do dia: login funcionou 2× de manhã (provável roteamento a outro nó) · `SBOVENHOM2`
retornou `code 100000027 — Error while connecting to database server SK1@saphasementesven:30013`
(Service Layer sem acesso ao HANA dessa base) · 27/07 o endpoint retornou `503 Service Unavailable`.

**Conclusão:** falha de infraestrutura no ambiente hospedado (Agrotis/AutoSky) — nó `node3`
defeituoso e base de homologação sem conexão com o banco. Chamado aberto.

### 6.1 Reteste — mesma data, após a orientação da Agrotis

A Agrotis confirmou por mensagem que o endpoint é **um só** e que a escolha entre produção e
homologação é feita no `CompanyDB` do payload de login — exatamente o que já estava documentado
aqui. Isso **não** altera o quadro: o reteste mostra que o problema continua e é anterior à
escolha de base.

| Verificação | Resultado |
|---|---|
| DNS | ✔ `134.65.247.214` |
| TCP 50000 | ✔ aberta |
| Balanceador | ✔ vivo — `Apache/2.4.54`, responde `401` na raiz |
| `POST /Login` com `SBOVENPRD` | ✖ **HTTP 500, corpo vazio** |
| `POST /Login` com `SBOVENHOM2` | ✖ **HTTP 500, corpo vazio** |
| Forçando `ROUTEID` em `.node1`, `.node2`, `.node3`, `.node4` | ✖ **500 em todos** |

**Duas evidências para o chamado:**

1. O login foi feito com senha **deliberadamente inválida**. O esperado seria `-1116 Invalid
   user/password`. Vir `500` significa que o nó estoura **antes** de avaliar a credencial — logo,
   não é problema de usuário, senha ou permissão.
2. O balanceador responde normalmente e sempre atribui `ROUTEID=.node3`, mas forçar os outros nós
   dá o mesmo `500`. Portanto **não é um nó isolado**: a camada de aplicação do Service Layer está
   fora como um todo, enquanto o Apache à frente dela segue no ar.

**Impacto no projeto: continua nenhum.** O app está completo e operando pelo upload de planilhas,
com as conversões validadas contra os arquivos reais. A integração com o SAP é otimização.

**Impacto no projeto: nenhum bloqueio.** O fluxo de upload de planilhas está pronto e validado
(1.018 bags aprovados · 753 lotes / 16.865 bags). A integração SAP é otimização, não pré-requisito.

## 7. Checklist de implantação

- [ ] Login de teste OK em `SBOVENHOM2`
- [ ] JSON de `Items` e `Orders` inspecionado → mapeamento de campos fechado (§4)
- [ ] Conversão do SAP reproduzindo os números conhecidos: **1.018 bags aprovados** e
      **753 lotes / 16.865 bags** (comparar com a carga da SimpleAgro de 28/07/2026)
- [ ] Segredos em `.env.local` / Supabase Secrets — nada versionado
- [ ] Job agendado com log de execução e alerta em caso de falha
- [ ] Confirmado com a Agrotis: limite de sessões/licença e política de rate limit
- [ ] Certificado TLS válido (solicitado à Agrotis) ou exceção documentada
