# Integração SAP Business One — Service Layer

> ## 🛑 SUSPENSA — o código saiu do app
>
> A integração foi **removida do aplicativo** (código, Edge Function e tabela de consultas).
> Este documento fica como registro do que foi descoberto, para quem retomar não repetir a
> investigação. O histórico do git tem o código, se for preciso ressuscitar.
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
| Endpoint | `https://sap-sementesveneza-sl.skyinone.net:50000/b1s/v1` |
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

Dois usos:
1. **Hoje**: rodar no Gerador de consultas do cliente B1 e exportar para Excel — alimenta a
   importação por planilha enquanto o SL não libera.
2. **Quando a autorização `-6006` sair** (§6.4): salvar como consulta do SL e executar por
   HTTP. **Sem o prefixo `"SBOVENPRD".`** nas tabelas ao salvar — a consulta roda no contexto
   da empresa logada, e com o prefixo fixo ela quebraria em homologação:
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
| Saldo por item (total) | `QuantityOnStock` em `Items` | ✔ funciona (55 insumos listados em 09/08); ❓ unidade — conferir `InventoryUOM` |
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
- **unidade** dos saldos (`QuantityOnStock` de 16.544 do CRUISER é litro? kg?) — conferir
  `InventoryUOM`;
- **saldo por lote**: resolvido no papel, bloqueado na prática. `BatchNumberDetails` foi
  testado no mesmo dia e comprovadamente **não tem campo de quantidade** (o `Format-List *`
  listou todos os campos do lote — é só cadastro, incluindo lotes velhos de safra 22/23). A
  coluna `Quantity` vive na **OBTQ**, e a consulta pronta (OBTN × OBTQ) está no §3.2 — falta
  só a autorização `-6006` para executá-la via SL; até lá, sai pelo cliente B1.

**Dado novo do mesmo dia:** existe integração interna (exemplo em Python de colega da Veneza)
usando o fluxo Login+sessão **apontando para produção**. Perguntar a ele se está rodando hoje
— se parou recentemente, isso data o início da quebra da sessão e fortalece o chamado.

## 7. Checklist de implantação

- [ ] Login de teste OK em `SBOVENHOM`
- [ ] JSON de `Items` e `Orders` inspecionado → mapeamento de campos fechado (§4)
- [ ] Conversão do SAP reproduzindo os números conhecidos: **1.018 bags aprovados** e
      **753 lotes / 16.865 bags** (comparar com a carga da SimpleAgro de 28/07/2026)
- [ ] Segredos em `.env.local` / Supabase Secrets — nada versionado
- [ ] Job agendado com log de execução e alerta em caso de falha
- [ ] Confirmado com a Agrotis: limite de sessões/licença e política de rate limit
- [ ] Certificado TLS válido (solicitado à Agrotis) ou exceção documentada
