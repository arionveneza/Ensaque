# Integração SAP Business One — Service Layer

> ## 🟡 Laboratório no app; integração de produção ainda não
>
> Desde 09/08/2026 existe a aba **"SAP (teste)"** (Edge Function `sap-teste`), um laboratório
> de **leitura em homologação**, visível só para o Arion — para experimentar as consultas que
> virarão a integração. A integração de PRODUÇÃO (job que alimenta o app) **ainda não existe**;
> este documento é o registro do que já foi descoberto e o que falta.
>
> A integração antiga (código no app, função `sap`, tabela `consultas_sap`) foi removida em
> 28/07/2026 — o histórico do git tem o código.
>
> **O que funciona no Service Layer com o usuário de integração:**
> login, `Items`, `BatchNumberDetails`, `Orders` — tudo que é **objeto de negócio**,
> governado por autorização de módulo.
>
> **O que não funciona:** executar consulta salva (`SQLQueries('CODE')/List` → **403**) e
> criar consulta (`POST SQLQueries` → **403**). Testado também com usuário profissional, que
> cria consultas normalmente pelo cliente B1 — **também deu 403**. Isso indica trava de
> ambiente, não de usuário.
>
> **Detalhe que confunde:** *listar* as consultas funciona
> (`SQLQueries?$select=SqlCode,SqlName` devolveu as 6 existentes: `LotesSA`,
> `LotesSATratamentos`, `LotesSANome`, `LotesSAProduto`, `LotesSAOri`, `LotesAnaliseSA`).
> Ler que existem, sim; executar, não.
>
> **Se retomar, o pedido é um só — e ele tem endereço exato no cliente B1** (regra oficial,
> guia "Working with SAP Business One Service Layer" §4.11, confirmada em 09/08/2026):
> usuário comum não executa NENHUMA consulta salva por padrão — nem as criadas por outros.
> Um superusuário concede, em **Administração → Inicialização do Sistema → Autorizações →
> Autorizações Gerais**, assunto **"Service Layer SQL Query"**, "Autorização total" nas
> consultas específicas (`LotesSA`, `LotesSAProduto`, `LotesSASaldo`…) para o usuário do
> job. Criar consulta nova exige superusuário ou o assunto "Modify SQL Queries in Service
> Layer". Muda e vale em ~1 min (cache de permissão). `-6006` é SEMPRE autorização —
> parâmetro faltando dá `704`, tabela fora do allowlist dá `702`. O resto já funciona por
> OData + Basic Auth (§6.4).
>
> **Armadilha que custou tempo:** o código da consulta é **sensível a maiúsculas**
> (`LotesSA`, não `LOTESSA`), e o SAP responde **403** — não 404 — para consulta
> inexistente. Ou seja, "sem permissão" pode significar "não existe".

> **Status em 09/08/2026 (ver §6.2–§6.4): produção (`SBOVENPRD`) é USÁVEL via Basic Auth
> por requisição — contorno descoberto em §6.4, que dispensa Login e cookie.** O fluxo
> clássico Login+sessão continua quebrado (a sessão emitida não é reconhecida por nenhum dos
> 4 nós — §6.3), e homologação (`SBOVENHOM`) segue com `500` no próprio Login. O chamado à
> Agrotis continua valendo (sessão + homolog), mas o mapeamento de campos (§4) já pode
> avançar em produção, somente leitura — a primeira listagem real de itens (55 insumos com
> saldo) saiu em 09/08/2026 por esse caminho.
>
> ⚠️ **Lição já aprendida (vale para o job de produção):** o Service Layer roda atrás de um
> balanceador Apache que devolve **dois** cookies no login: `B1SESSION` **e** `ROUTEID`.
> O `ROUTEID` define qual nó guarda a sessão. Enviar apenas o `B1SESSION` causa
> `code 301 — "Invalid session or session already timeout"`. **O cliente HTTP precisa preservar
> todos os cookies** (em PowerShell: `-SessionVariable`/`-WebSession`; em Node: um cookie jar).
> **Atualização de 09/08/2026 (§6.3): preservar os cookies certos deixou de ser suficiente.**
> Em `SBOVENPRD`, com os dois cookies confirmadamente corretos, o mesmo `301` aconteceu de
> qualquer forma — hoje é bug do ambiente, não falta de cuidado do cliente. Não assumir que
> "seguir esta lição" resolve sem antes testar de novo.

> ⚠️ **Segunda lição, do lado do Supabase:** o `supabase-js` envia `apikey` e `x-client-info`
> em toda chamada, além do `Authorization`. Se qualquer um deles ficar fora do
> `Access-Control-Allow-Headers` da Edge Function, o navegador bloqueia a requisição **no
> preflight** e o app recebe apenas `Failed to send a request to the Edge Function` — uma
> mensagem que não tem nenhuma relação aparente com a causa. Diagnostica-se com um
> `curl -X OPTIONS` mandando os mesmos `Access-Control-Request-Headers` do navegador.

## 1. Ambiente

| Item | Valor |
|---|---|
| Endpoint (produção) | `https://sap-sementesveneza-sl.skyinone.net:50000/b1s/v1` |
| **Endpoint (homologação)** | `https://sap-sementesvenezahom-sl.skyinone.net:50000/b1s/v1` — **descoberto em 09/08/2026** (IP 134.65.233.39); o SL de produção NÃO atende a base de homolog, são HANAs separados (§6.5/§6.6) |
| Homologação | `SBOVENHOM` ← **usar para desenvolver** (sem "2" no final — corrigido 09/08/2026) |
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

$body = '{"CompanyDB":"SBOVENHOM","UserName":"USUARIO","Password":"SENHA"}'
Invoke-RestMethod -Method Post -Uri "https://sap-sementesveneza-sl.skyinone.net:50000/b1s/v1/Login" -Body $body -ContentType "application/json"
```

**PowerShell 7+**:
```powershell
$body = '{"CompanyDB":"SBOVENHOM","UserName":"USUARIO","Password":"SENHA"}'
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
  -d '{"CompanyDB":"SBOVENHOM","UserName":"SEU_USUARIO","Password":"SUA_SENHA"}'
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
Para lotes com PMS e saldo por lote (o que hoje vem da tela *Saldos*), a consulta é esta —
trazida pelo Arion em 09/08/2026 ("essa consulta traz tudo"), OBTN (cadastro do lote) ×
OBTQ (saldo por depósito):

```sql
SELECT
    Lote."ItemCode",
    Lote."DistNumber"            AS "Nº do Lote",
    Lote."itemName"              AS "Descrição do Item",  -- "itemName" minúsculo mesmo: peculiaridade da OBTN
    Lote."U_AGRT_ClassQualidade" AS "Classificação de Qualidade",
    Lote."U_AGRT_CategoriaLote"  AS "Categoria do Lote",
    Lote."U_AGRT_Peneira"        AS "Peneira",
    Lote."U_AGRT_PMS"            AS "PMS (g)",
    Lote."U_AGRT_PesoBruto"      AS "Peso Bruto",
    Lote."U_LoteTSI"             AS "Tratamento (TSI)",
    Lote."U_Destinacao"          AS "Destinação",
    Saldo."WhsCode"              AS "Depósito",
    Saldo."Quantity"             AS "Qtd em Estoque"
FROM "SBOVENPRD"."OBTN" Lote
INNER JOIN "SBOVENPRD"."OBTQ" Saldo
    ON  Saldo."ItemCode"  = Lote."ItemCode"
    AND Saldo."SysNumber" = Lote."SysNumber"
WHERE Saldo."Quantity" > 0
ORDER BY Lote."ItemCode", Lote."DistNumber", Saldo."WhsCode";
```

> Na versão oficial salva no SL (`TSI_SALDOS`, na homolog desde 09/08/2026) entrou também
> `Lote."U_AGRT_Safra" AS "Safra"`, e os apelidos são ASCII sem espaço (`NumLote`,
> `QtdEstoque`…) — viram nome de campo no JSON da API.

Dois usos:
1. **No cliente B1** (Gerador de consultas → exportar Excel): usar o prefixo do schema da
   empresa logada — `"SBOVENPRD"."OBTN"` em produção, `"SBOVENHOM"."OBTN"` na homolog.
2. **Salva no Service Layer** (`TSI_SALDOS`): **sem prefixo nenhum** (`FROM OBTN`) — a
   consulta roda no contexto da empresa logada, e a mesma definição serve para as duas bases:
```http
POST /b1s/v1/SQLQueries          # criar uma vez
{ "SqlCode":"TSI_SALDOS", "SqlName":"Saldos TSI por lote", "SqlText":"SELECT ... FROM OBTN ... INNER JOIN OBTQ ..." }

GET /b1s/v1/SQLQueries('TSI_SALDOS')/List   # executar (paginado — Prefer: odata.maxpagesize=100)
```

## 4. Mapeamento de campos — **A CONFIRMAR**

O app precisa de **cultivar + tratamento + embalagem + quantidade em bags**. Na SimpleAgro isso já
foi resolvido. No SAP, o padrão observado no cliente B1 é o mesmo:

| Dado do app | Onde está no SAP | Status |
|---|---|---|
| Cultivar | `ItemName` — ex. `SS NEO680 IPRO BB5M` → trecho do meio | ✔ padrão igual à SimpleAgro |
| Embalagem | último token do `ItemName` (`BB5M`, `BMB`) | ✔ mesmo de-para: BB5M→BG5M, BMB→MEIOBAG |
| **PMS** | **`U_AGRT_PMS`** em `BatchNumberDetails` (string, ponto decimal: `176.40`) | ✔ **confirmado em 09/08/2026**: `U_AGRT_PesoBruto` = 882,0 = 176,40 × 5 — bate com a fórmula do peso do bag |
| Nº do lote | `Batch` em `BatchNumberDetails` (`SV0103652…`, mesmo formato do app) | ✔ confirmado 09/08/2026 |
| **Tratamento** | `U_LoteTSI` em `BatchNumberDetails` — vazio em semente branca; em lote tratado traz o código: `FORTENZA DUO 60`, `OFERTA VeP`, `OFERTA VeP + EI` | ✔ **confirmado 09/08/2026** — mas é texto livre (espaçamento varia: `+ EI` vs `+EI`); importar com `normaliza()` + de-para, como na SimpleAgro |
| Branca × tratada | item tratado tem `ItemName` com sufixo **`TSI`** (`SS NA7337 RR BB5M TSI`) | ✔ confirmado 09/08/2026 |
| Saldo por lote | coluna `Quantity` da **OBTQ** (join com OBTN por `ItemCode`+`SysNumber`) — **consulta pronta e validada no §3.2**; não existe em `BatchNumberDetails` (só cadastro) nem em entidade OData padrão | ❌ via SL depende da autorização `-6006` (§6.4); hoje sai pelo Gerador de consultas do cliente B1 |
| Saldo por item (total) | `QuantityOnStock` em `Items`; por depósito em `ItemWarehouseInfoCollection` (`WarehouseCode`, `InStock`, `Committed` — depósitos `VEN_GER` e `VEN_TER1`) | ✔ funciona; **unidade confirmada 09/08: litros** (`InventoryUOM = 'LT'` no CRUISER e FORTENZA) — dose ml/kg compara em volume direto, **sem precisar de densidade** |
| Lote de insumo/defensivo | **não existe**: `ManageBatchNumbers = tNO`, zero lotes no FORTENZA | ✔ confirmado 09/08 — saldo total por item é a única granularidade de insumo; lote só importa para SEMENTE |
| Aprovação financeira | ❓ existe status equivalente ao da SimpleAgro? | ❓ se não existir, manter pedidos vindo da SimpleAgro e só o estoque do SAP |

Bônus descobertos no cadastro do lote (dados que a SimpleAgro não entrega):
`U_AGRT_Germinacao`, `U_AGRT_Pureza`, `U_AGRT_CategoriaLote` (C2/S2…), `U_AGRT_Safra`
(`22/23`), `U_AGRT_Peneira` (`P 6.5 mm`), `U_AGRT_ClassQualidade` (`EM_ANALISE`),
`U_AGRT_PesoBruto`/`PesoLiquido`/`PesoEmb`. Atenção ao paginado: `BatchNumberDetails` devolve
o cadastro INTEIRO (inclusive lotes de safras velhas, 2023 etc.) em páginas de até 100 — para
"lotes atuais" é obrigatório cruzar com o saldo, que é justamente o que falta.

**Como resolver:** com a sessão aberta, rode `GET /Items('SOJ00002')` e
`GET /Orders?$top=1&$expand=DocumentLines` e olhe o JSON completo — os UDFs aparecem como
`U_XXX`. Traga o JSON e o mapeamento se resolve em minutos.

## 5. Job de sincronização (desenho — revisto em 09/08/2026 para Basic Auth)

> O desenho original usava `POST /Login` → `POST /Logout`, o fluxo de sessão que o §6.3
> provou quebrado. Reescrito para o contorno que funciona (§6.4).

```
[cron a cada 1h — Basic Auth por requisição, sem sessão]
  → GET  /Items   (saldo total por item, insumos)   → alerta de cobertura de químicos
  → GET  /SQLQueries('LotesSASaldo')/List?updatedate='<última carga>'   ← incremental!
        (exige a autorização por consulta — ver banner/§6.4)
  → GET  /BatchNumberDetails ($filter=ItemCode …)   → PMS, U_LoteTSI, validade, categoria
  → normaliza → upsert em lotes_semente / tabela de saldo de insumos
  → registra em cargas_demanda (origem='sap')
```

Antes de agendar frequência alta, confirmar com a Agrotis o custo do Basic Auth em
licença/sessão por requisição (§6.4) — e `Orders` (pedidos) segue **nunca testado** em
nenhum modo; o balanço de pedidos continua vindo da SimpleAgro até isso mudar.

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

> **Nota de 09/08/2026:** Arion corrigiu o nome da base de homologação — é `SBOVENHOM`, **sem
> o "2"** no final (§1 e exemplos já corrigidos). Isso deixa uma pergunta aberta sobre o
> registro acima: o erro `code 100000027` foi devolvido testando literalmente `SBOVENHOM2`, e
> esse código descreve o Service Layer **tentando conectar** num schema HANA específico
> (`SK1@saphasementesven`) — não o `-304 Invalid company db` que seria o esperado para um nome
> inexistente (ver §2). Não editei o registro histórico (é o que foi digitado naquele dia), mas
> não dá pra confiar de olhos fechados que "SBOVENHOM2" e "SBOVENHOM" tenham sido tratados como
> a mesma coisa nesses testes antigos. Ao reabrir o chamado com a Agrotis ou testar de novo,
> usar sempre `SBOVENHOM` (a forma corrigida) e não assumir que os resultados de 27–28/07
> valem exatamente igual para o nome certo.

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

### 6.2 Reteste — 09/08/2026, motivado pelo interesse em saldo de defensivos/insumos

Arion rodou o teste de login manualmente duas vezes (PowerShell, usuário `ven040`): primeiro
com `SBOVENHOM2` (nome que se descobriu errado na hora — a base correta é `SBOVENHOM`, sem o
"2"), depois repetindo com `SBOVENHOM` já corrigido. As duas vezes, **mesmo resultado** —
`Invoke-RestMethod` devolveu `(500) Erro Interno do Servidor` no próprio `POST /Login`, antes
de chegar a validar usuário/senha. Isso descarta o nome errado como causa: o problema é o
mesmo de 28/07, persistindo onze dias depois, e não tem relação com qual `CompanyDB` foi
enviado.

**Conclusão (parcial, corrigida logo abaixo pelo §6.3): homologação continua fora do ar.**
Não é problema do nome da base (testado com os dois nomes) — a camada de aplicação do
Service Layer para `SBOVENHOM` segue estourando antes de validar credencial, igual a 28/07.

### 6.3 Mesmo dia — login em SBOVENPRD funcionou

Com homologação de novo em `500`, testamos produção (`SBOVENPRD`) com o mesmo usuário —
**logou normalmente**, `SessionId` retornado. Isso reduz o diagnóstico: **não é o ambiente
inteiro fora do ar, é especificamente a base de homologação.** Produção está de pé.

**Conclusão prática, revisada:**
- **Homologação (`SBOVENHOM`) — abrir chamado com a Agrotis.** É onde o app deveria
  desenvolver (regra do CLAUDE.md §"Ambiente"), e está fora do ar desde 28/07, sem relação
  com nome de base ou credencial.
- **Produção (`SBOVENPRD`) — dá pra explorar agora, com cuidado.** Só leitura (`GET`), nunca
  `POST`/`PATCH`/`DELETE` em objeto de negócio, e sempre `POST /Logout` ao final (sessão aberta
  consome licença). Serve exatamente para o que falta no §4 — abrir `GET /Items('CODIGO')` e
  `GET /BatchNumberDetails?$filter=ItemCode eq 'CODIGO'` de um defensivo/insumo real e ver se o
  saldo por lote aparece pronto, sem precisar da `SQLQueries` que está travada (§3.2/banner).
- Não vale esperar o chamado da Agrotis pra isso — o mapeamento de campos (§4) pode avançar
  direto em produção, só de leitura, enquanto homologação não volta.

**Mas o mapeamento travou em outro lugar:** com a sessão de `SBOVENPRD` aberta (login OK),
`GET /Items('INS00015')` e `GET /BatchNumberDetails?$filter=ItemCode eq 'INS00015'` devolveram
**HTTP 401**. Capturando o corpo real do erro (`try/catch` + `GetResponseStream()`, porque
`Invoke-RestMethod` no Windows PowerShell 5.1 só mostra o status genérico por padrão), o SAP
respondeu:
```json
{ "error": { "code": 301, "message": { "lang": "en-us", "value": "Invalid session or session already timeout." } } }
```
**Não é autorização.** Primeira hipótese foi a pegadinha do `ROUTEID` já registrada no topo
deste documento — mas foi **descartada com teste**, não só por suposição:
1. Com `-SessionVariable`/`-WebSession` (a lição recomendada ali): `301`.
2. Extraindo `B1SESSION`/`ROUTEID` manualmente do `Set-Cookie` do login (via
   `Invoke-WebRequest`) e montando o header `Cookie:` à mão em cada chamada: **mesmo `301`**.
3. Conferido que os valores extraídos eram válidos — `B1SESSION` um GUID normal
   (`113b7d44-9406-...`), `ROUTEID=.node1` no formato esperado, nada truncado, enviados a
   menos de 1 segundo do login.
4. **Teste final, o mais revelador:** com um `B1SESSION` recém-emitido, a mesma consulta
   forçando o `ROUTEID` em **cada um dos 4 nós** (`.node1` a `.node4`) — **os quatro
   devolveram `401`**, inclusive o `.node1` que tinha acabado de emitir a sessão. Detalhe:
   neste dia o login atribuiu `ROUTEID=.node1`, enquanto em 28/07 era sempre `.node3` — o
   cluster mudou de configuração entre as duas datas.

**Conclusão: não é o cliente, e não há contorno.** Cookies automáticos, cookies manuais e
fixação de nó falharam identicamente, com cookies comprovadamente corretos. Nenhum nó do
cluster reconhece a sessão que o próprio cluster emitiu — o armazenamento/validação de sessão
do Service Layer está quebrado como um todo. Bug do ambiente hospedado (Agrotis/AutoSky);
nada a fazer do lado do app. Reportar à Agrotis com esta sequência exata (é uma reprodução
bem mais específica que o "500 antes da senha" de 28/07): login em `SBOVENPRD` funciona e
devolve `SessionId`; a chamada imediatamente seguinte, com os dois cookies corretos, recebe
`code 301 — Invalid session or session already timeout`, qualquer que seja o nó.

**Nota de segurança:** a senha do usuário `ven040` apareceu em texto puro no chat **três
vezes** neste dia (duas em homologação, uma em produção) — prints/mensagens de terminal não
são o lugar pra isso, regra já registrada no CLAUDE.md §4.1. Recomendo trocar essa senha com
a Agrotis assim que possível — é o mesmo usuário/senha usado nas duas bases, então uma senha
exposta vale para as duas. Testes futuros: usar `Read-Host -AsSecureString` pra digitar a
senha sem ela aparecer na tela (comando pronto na próxima mensagem), em vez de colar num
`$body` de texto puro.

### 6.4 Contorno encontrado — Basic Auth por requisição FUNCIONA (09/08/2026)

O Service Layer aceita **autenticação Basic em cada requisição**, sem `POST /Login` e sem
cookie nenhum. O formato do usuário é o JSON da empresa+usuário, e a senha vai junto:

```powershell
$parUsuario = '{"CompanyDB":"SBOVENPRD","UserName":"' + $usuario + '"}'
$basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($parUsuario + ":" + $senha))
# header: Authorization: Basic $basic   (+ Prefer: odata.maxpagesize=100 para paginação)
```

Testado em produção no mesmo dia em que o fluxo de sessão estava quebrado:
- `GET /Items('INS00015')?$select=ItemCode,ItemName,QuantityOnStock` → **OK**
- `GET /Items?$filter=startswith(ItemCode,'INS')&$select=…&$orderby=ItemCode` → **55 itens de
  insumo/defensivo com saldo**, numa página (com `Prefer: odata.maxpagesize=100`). São os
  químicos do TSI: FORTENZA, CRUISER 600 FS, STANDAK TOP, DERMACOR, GRAFITE, POLIMERO, pós
  secantes FLUIDUS etc.

Isso confirma que o defeito de §6.3 está isolado na camada de sessão — o Basic Auth não passa
por ela. **É o caminho para o job de importação de saldo de insumos**, enquanto (e talvez
mesmo depois que) a sessão não volta.

Custos e limites do contorno:
- a credencial viaja em toda chamada → job só com usuário **somente leitura**, segredo em
  Supabase Secrets, nunca no repositório (§4.1 do CLAUDE.md);
- cada requisição Basic pode abrir/fechar sessão por dentro no servidor → confirmar com a
  Agrotis impacto de licença e rate limit antes de agendar cron frequente;
- `SQLQueries` sob Basic Auth: **executar continua bloqueado, mas o erro mudou de cara** —
  em vez do `403` vazio e ambíguo do fluxo com sessão, veio
  `code -6006 — "You are not permitted to perform this action"`. Isso reclassifica o
  bloqueio: é **autorização do usuário no B1** (concedível pelo admin no cadastro de
  autorizações do `ven040`, sem chamado de infraestrutura), não trava de ambiente como se
  supunha no banner. Pedir a liberação junto do resto.

**Confirmado via `$metadata` (09/08/2026):** das **652 entidades** expostas nesta versão do
SL, **nenhuma** entrega saldo por lote — `BatchNumberDetails`/`SerialNumberDetails` são só
cadastro, os `Inventory*`/`StockTransfers` são documentos. O `sml.svc` (camada semântica do
HANA) não responde. Não existe alternativa OData: `SQLQueries` é o único caminho de leitura
da OBTQ. Nuance do `-6006` ainda aberta: pela regra da SAP, **criar** consulta exige
superusuário, **executar** não — e o SAP devolve "sem permissão" também para consulta
inexistente (armadilha já documentada no topo). Testado na sequência (mesmo dia):
**criar a `TSI_SALDOS` também deu `-6006`** → o `ven040` não tem o flag de superusuário
(autorização total nas telas do B1 não é a mesma coisa que o checkbox de superusuário no
cadastro de usuários). O executar em seguida falhou igual, mas é inconclusivo — a consulta
nem chegou a ser criada. Fechado na sequência com os testes que faltavam:
- **Listar funciona**: 10 consultas salvas (eram 6 em 28/07). As 4 novas — `LotesSASaldo`,
  `LotesSASaldoNum`, `LotesSATransacoes`, `LotesSATransacoesIBT1` — mostram que a integração
  interna da Veneza (o exemplo em Python do colega) **já sincroniza saldo por lote**.
- **Ler a definição funciona**: `LotesSASaldo` =
  `SELECT "ItemCode","BatchNum","WhsCode",…,"Quantity",… FROM "OIBT" WHERE "UpdateDate" > :updatedate`
  — saldo por lote **incremental** (parâmetro `:updatedate`, passado na execução como
  `/List?updatedate='2026-01-01'`). Exatamente o dado de que o TSI precisa.
- **Executar consulta EXISTENTE também dá `-6006`** — neste ambiente a execução é restrita
  mesmo para consulta criada por outro; a regra usual da SAP ("usuário comum executa") não
  vale aqui. Não há mais o que testar com o `ven040`.

**Fechamento (auditoria de 09/08, com o guia oficial da SAP §4.9–4.12):** todo o
comportamento observado é o padrão de fábrica documentado —
- usuário comum **lê e lista** definições (concedido por padrão) ✔ observado;
- usuário comum **não executa nenhuma consulta salva** sem "Autorização total" naquela
  consulta específica (assunto **"Service Layer SQL Query"** das Autorizações Gerais; cada
  consulta salva vira um item da árvore, nascendo como "Sem autorização") ✔ observado;
- **criar** exige superusuário ou o assunto "Modify SQL Queries in Service Layer" ✔ observado
  ("autorização total nas telas" não cobre nada disso — são assuntos próprios);
- `-6006` é **exclusivamente autorização**: parâmetro faltando dá `400/704 "Parameter
  error"`, tabela fora do allowlist (`b1s_sqltable.conf`) dá `702`, sintaxe dá `701`. Os
  testes do dia mediram a coisa certa. (O sufixo "- Business Partner Master Data" visto na
  `LotesSASaldo` aparece em checagens de autorização/allowlist sobre tabelas referenciadas
  no SqlText — relato igual na SAP Community.)
- Sintaxe de parâmetro confirmada: `GET .../List?updatedate='2020-01-01'` (sem os dois
  pontos) ou `POST .../List` com corpo `{"ParamList": "updatedate='2020-01-01'"}`.

**Desbloqueio, portanto:** um superusuário do B1 concede "Autorização total" nas `LotesSA*`
(e/ou no "Modify SQL Queries..." para criar a `TSI_SALDOS`) para o usuário do job — 2
minutos no cliente, vale em ~1 min. Perguntas ao colega da integração: *quem é superusuário
aí?* e *a integração Python (Login+sessão) está rodando hoje?* — a segunda data a quebra da
sessão para o chamado. Com a autorização dada, `LotesSASaldo` (incremental por
`:updatedate`) + `BatchNumberDetails` via OData cobrem o dado completo de lotes.

Pendências de mapeamento abertas por este teste:
- ~~unidade dos saldos~~ **resolvida na bateria de testes (§6.5): litros (`LT`)**;
- **saldo por lote**: resolvido no papel, bloqueado na prática. `BatchNumberDetails` foi
  testado no mesmo dia e comprovadamente **não tem campo de quantidade** (o `Format-List *`
  listou todos os campos do lote — é só cadastro, incluindo lotes velhos de safra 22/23). A
  coluna `Quantity` vive na **OBTQ**, e a consulta pronta (OBTN × OBTQ) está no §3.2 — falta
  só a autorização `-6006` para executá-la via SL; até lá, sai pelo cliente B1.

**Dado novo do mesmo dia:** existe integração interna (exemplo em Python de colega da Veneza)
usando o fluxo Login+sessão **apontando para produção**. Perguntar a ele se está rodando hoje
— se parou recentemente, isso data o início da quebra da sessão e fortalece o chamado.

### 6.5 Bateria final — 09/08/2026, os buracos que a auditoria apontou

Todos via Basic Auth em `SBOVENPRD` (leitura):

| Teste | Resultado |
|---|---|
| `Orders` (nunca testado antes) | ✔ **funciona** — pedido veio com `DocumentLines` inline, `RemainingOpenQuantity` (= "Saldo a Faturar") e `LineStatus`. Candidatos ao status financeiro: `NTSApproved`, `U_AGRT_SitVenda`, `U_AGRT_StatusPedFat`, `U_AGRT_DtLibCom`, `Document_ApprovalRequests` — identificar comparando valores com o relatório da SimpleAgro (os `U_AGRT_*` são da Agrotis, mesma origem) |
| Unidade dos saldos de insumo | ✔ **litros** (`InventoryUOM='LT'`, CRUISER e FORTENZA). Dose ml/kg → consumo em L, comparação em volume **sem densidade**. Densidade continua necessária só para o peso de balança (feature existente) |
| Saldo por depósito | ✔ `ItemWarehouseInfoCollection` traz `VEN_GER` e `VEN_TER1` com `InStock` e `Committed`. Decisão de desenho pendente: quais depósitos contam e se desconta o comprometido |
| Lote de insumo/defensivo | **não existe** (`ManageBatchNumbers=tNO`, 0 lotes no FORTENZA). A pergunta "saldo do lote de defensivo" se dissolve — total por item é toda a granularidade. `SQLQueries` importa só para lotes de SEMENTE |
| Paginação (`odata.nextLink`) | ✔ funciona — página 2 seguida com sucesso (100+100 lotes do SOJ00002) |
| `sml.svc` | ❌ **404** com Basic Auth — camada semântica não está implantada neste servidor. Descartada com evidência (antes era só "não responde") |

E o teste da homologação (com a autorização total que o `ven040` tem LÁ):
`Items` e `SQLQueries` na `SBOVENHOM` devolvem `code 100000027 — Error while connecting to
database server SK1@saphasementesven:30013` também via Basic Auth — enquanto o cliente B1
do Arion estava logado nessa mesma homologação, funcionando, na mesma hora.

**Causa raiz encontrada (print da tela "Selecionar a empresa" do cliente, 09/08/2026):**
a homologação vive em **OUTRO servidor HANA** — o cliente conecta em
`SK1@saphasementesvenhom:30013` (com **"hom"** no hostname), e o Service Layer tenta
`SK1@saphasementesven:30013` (o HANA de **produção**, sem o "hom"). Ou seja: o SL público
(`sap-sementesveneza-sl.skyinone.net:50000`) só atende o HANA de produção; a base
`SBOVENHOM` (e a `SBOFVENHOM5`, da Fazenda, no mesmo servidor de homolog) está fora do
alcance dele **por desenho**, não por defeito. Explica o `500` no Login (o SL nem alcança a
base para validar credencial) e todos os `100000027`.

**Pedido pronto para TI/Agrotis:** *"O Service Layer público atende só o HANA de produção
(`saphasementesven`). Nossa homologação (`SBOVENHOM`) está no HANA `saphasementesvenhom`.
Existe um endpoint de Service Layer para o ambiente de homologação? Se não, é possível
habilitar/expor um (ou incluir o servidor de homolog no SL existente)?"* — sem isso não há
como desenvolver contra homologação via API, e os testes continuarão em produção
somente-leitura.

**Autorização é por empresa** — a "Autorização total" no "Service Layer SQL Query" que o
`ven040` tem está na HOMOLOGAÇÃO (onde o SL não alcança o banco); na PRODUÇÃO (onde o SL
funciona) ela não existe — por isso todos os `-6006`. O desbloqueio dos lotes de semente é
conceder a mesma autorização na `SBOVENPRD`.

### 6.6 Homologação encontrada — pipeline completo validado (09/08/2026)

O endpoint do SL de homologação **existia**, num hostname que ninguém tinha anotado — achado
por tentativa de DNS: **`sap-sementesvenezahom-sl.skyinone.net`** (IP `134.65.233.39`;
produção é `134.65.247.214`). Com ele, a escada inteira rodou de ponta a ponta via Basic
Auth com o `ven040`, que tem autorização total na homolog:

1. `Items` → OK;
2. `POST /SQLQueries` → **criou** a `TSI_SALDOS` (OBTN × OBTQ: nº do lote, PMS,
   tratamento, categoria, safra, depósito, quantidade);
3. `GET /SQLQueries('TSI_SALDOS')/List` → **executou**, devolvendo saldo por lote real:
   lotes de semente safra 25/26, PMS, categoria C2, bags por depósito — **paridade completa
   com a tela Saldos da SimpleAgro**.

A `TSI_SALDOS` fica salva na homolog como consulta oficial da integração. Consequências:
- **Ambiente de desenvolvimento completo funcionando** — vale a regra do projeto:
  desenvolver contra a homolog.
- **O pedido ao TI encolheu para uma linha:** replicar em `SBOVENPRD` a autorização que o
  usuário já tem na homolog (assuntos "Service Layer SQL Query" e "Modify SQL Queries in
  Service Layer" das Autorizações Gerais) — e criar lá a mesma `TSI_SALDOS`.
- Cuidado: na homolog o CRUISER apareceu **com** lote (`001-CRUISER`), enquanto produção diz
  `ManageBatchNumbers=tNO` — dados/config de teste divergem. Homolog valida a **mecânica**,
  não o comportamento exato dos dados de produção.

### 6.7 Aba "SAP (teste)" no app — o laboratório (09/08/2026)

Tudo que acima foi feito no PowerShell agora tem uma tela no app, para experimentar sem
terminal. Arquivos: `src/telas/SapTeste.tsx` (UI), `src/lib/sapTeste.ts` (+ testes) e a
Edge Function `supabase/functions/sap-teste/index.ts` (proxy).

- **Visível só para o Arion**: gate por e-mail em `src/App.tsx` (lista `USUARIOS_SAP_TESTE`
  em `src/lib/sapTeste.ts`) **e** de novo dentro da Edge Function — a lista do front é
  conveniência; a barreira que vale é a do servidor. Não é regido pela matriz de permissões
  (é por usuário, não por perfil), igual à exceção da Administração.
- **Só leitura, sempre — em qualquer base**: a função repassa apenas `GET`, nunca
  POST/PATCH/DELETE (§6.8 estendeu para também alcançar produção, mas a trava de método é a
  mesma, incondicional). Valida que o caminho resolvido não escapa do `/b1s/v1` (bloqueia
  `..`/`%2e%2e`/`\`), segue `odata.nextLink` até 10 páginas, e responde sempre HTTP 200 com
  `{ ok, erro?, dados? }` (o `invoke` do supabase-js esconde corpo de resposta não-2xx).
- **Presets** na tela: ping, pedidos de venda abertos, insumos com estoque, saldo por lote
  (`TSI_SALDOS`), consultas salvas, item completo e lotes do item. Mais um campo de caminho
  OData livre.

**Deploy da Edge Function** (não passa pelo GitHub/Cloudflare — é no Supabase):
```
supabase functions deploy sap-teste --no-verify-jwt
```
`--no-verify-jwt` porque a chave anônima é um JWT válido e não protegeria nada (o código faz
a autenticação real). Secrets necessários no projeto: `SAP_USER`, `SAP_PASSWORD` (mesma
credencial serve as duas bases) e, opcionais, `SAP_HOM_URL`/`SAP_HOM_DB`/`SAP_PROD_URL`/
`SAP_PROD_DB` — todos têm fallback embutido (§1). **Enquanto a função não for publicada, a
aba mostra "Failed to send a request to the Edge Function"** — é o esperado, não bug do front.

### 6.8 Laboratório ganha produção (12/08/2026)

Arion confirmou acesso liberado em `SBOVENPRD` (a autorização de `SQLQueries` pendente desde
§6.6/§6.7) e pediu para testar direto na base real. Em vez de rodar PowerShell de novo, o
laboratório do app foi estendido: agora tem um seletor **Homologação / Produção** no topo da
tela — homolog continua o padrão ao abrir a aba (nunca produção por acidente), e escolher
produção pinta a tela em vermelho e mostra "dados reais da empresa — só leitura" antes de
qualquer clique.

- **Trava dura preservada**: o `fetch` na Edge Function agora passa `method: 'GET'`
  explicitamente (antes era o padrão implícito) — comentário no código deixa claro que isso
  vale para as duas bases, sem exceção.
- **Sem secret novo obrigatório**: o endpoint/base de produção (§1) não é segredo — só
  usuário/senha são (`SAP_USER`/`SAP_PASSWORD`, os mesmos das duas bases). `SAP_PROD_URL`/
  `SAP_PROD_DB` existem como override opcional, com fallback para os valores documentados.
- **O que NÃO foi feito**: criar a `TSI_SALDOS` em produção (se ainda não existir lá) exige
  `POST /SQLQueries` — uma escrita, mesmo sendo só metadado de consulta, não dado de negócio.
  Fora do que este laboratório faz de propósito (só GET, sem excecão, nem para o Arion) e da
  regra "sempre leitura em produção" do CLAUDE.md §4. Se precisar criar lá, é uma ação
  específica, deliberada, fora deste caminho — não algo que o laboratório faz sozinho.
- **Testado e confirmado em 12/08/2026, via PowerShell (Basic Auth, mesmo padrão do §6.4) em
  `SBOVENPRD` real** — a autorização está liberada de ponta a ponta:
  1. `GET /SQLQueries?$select=SqlCode,SqlName` → **OK**, 10 consultas salvas (`LotesSA`,
     `LotesSAProduto`, `LotesSANome`, `LotesSATratamentos`, `LotesSAOri`, `LotesSASaldo`,
     `LotesSASaldoNum`, `LotesSATransacoes`, `LotesSATransacoesIBT1`, `LotesAnaliseSA`) — a
     `TSI_SALDOS` **não está entre elas**, só existe na homolog (§6.6).
  2. `GET /SQLQueries('TSI_SALDOS')/List` → `404`, `code -2028 "No matching records found"` —
     diferente do `-6006` de autorização; é exatamente o erro de "não existe", confirmando que
     a chamada passou pela checagem de permissão e só não achou a consulta.
  3. **Teste decisivo**, com uma consulta que EXISTE (`LotesSASaldo`, saldo por lote
     incremental — `SELECT ... FROM OIBT WHERE UpdateDate > :updatedate`):
     `GET /SQLQueries('LotesSASaldo')/List?updatedate='2020-01-01'` → **FUNCIONOU**, 100
     linhas reais de movimento de lote (`BatchNum`, `CardCode`, `CardName`, datas de 2023 a
     12/08/2026). Sem `-6006`. **A autorização de `SQLQueries` está confirmada em produção.**
  - Falta só decidir se cria a `TSI_SALDOS` (a consulta OBTN×OBTQ do §3.2, com PMS/tratamento/
    safra que `LotesSASaldo` não tem) em `SBOVENPRD` — é um `POST`, decisão separada e
    deliberada, não parte deste teste de leitura.

## 7. Checklist de implantação

- [x] Acesso a `SBOVENHOM` OK — 09/08/2026, via Basic Auth no **endpoint próprio de homolog** (§6.6)
- [x] JSON de `Items`, `Orders` e `BatchNumberDetails` inspecionado → mapeamento fechado (§4/§6.5)
- [x] Saldo por lote executado de ponta a ponta na homolog (`TSI_SALDOS`, §6.6)
- [x] Autorização de `SQLQueries` replicada em `SBOVENPRD` — confirmado em 12/08/2026 via
      PowerShell (§6.8): `LotesSASaldo` executou de verdade em produção, sem `-6006`.
      `TSI_SALDOS` em si ainda não existe lá (só na homolog) — criar é `POST`, decisão
      separada
- [ ] Senha do `ven040` trocada (exposta em 09/08) e/ou usuário de integração dedicado, somente leitura
- [ ] Campo do status financeiro dos pedidos identificado (candidatos no §6.5)
- [ ] Conversão do SAP reproduzindo os números conhecidos: **1.018 bags aprovados** e
      **753 lotes / 16.865 bags** (comparar com a carga da SimpleAgro de 28/07/2026)
- [ ] Segredos em `.env.local` / Supabase Secrets — nada versionado; limpar os antigos, que
      podem guardar a senha **pessoal** do Arion (PENDENCIAS §2)
- [ ] Job agendado com log de execução e alerta em caso de falha
- [ ] Confirmado com a Agrotis: limite de sessões/licença e rate limit do Basic Auth
- [ ] Certificado TLS válido (solicitado à Agrotis) ou exceção documentada
