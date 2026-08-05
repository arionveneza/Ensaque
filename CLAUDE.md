# TSI — Sistema de Controle de Tratamento Industrial de Sementes

> **Contexto para o Claude Code.** Este projeto substitui a planilha `TSI 2025` (75 abas) por uma
> aplicação web multiusuário. Todas as regras abaixo foram validadas com a operação da Sementes Veneza
> e existem implementadas em `docs/prototipo-referencia.html` — um protótipo funcional em HTML/JS puro
> com 82 testes passando. **Use o protótipo como especificação executável**: quando houver dúvida de
> comportamento, abra-o e verifique.

## Stack alvo

- **Front-end**: React + TypeScript + Vite, Tailwind CSS, shadcn/ui, Recharts (gráficos), Framer Motion (transições leves)
- **Back-end**: Supabase (PostgreSQL + Auth + RLS + Realtime)
- **Deploy**: Vercel (front) + Supabase Cloud
- **Uso**: tablets no chão de fábrica (operação) e desktop (PCP/gestão). Layout responsivo obrigatório.

## Domínio em uma frase

Duas máquinas (TSI 1 e TSI 2) tratam sementes de soja com receitas químicas. O PCP programa ordens por
dia e máquina; a logística baixa os lotes de semente; a produção aponta início/paradas/fim e os pesos de
balança dos tanques; a qualidade avalia; o PCP encerra lançando no AGROTIS.

---

## 1. Entidades e regras de negócio

### Máquinas e capacidade
- 2 máquinas: **TSI 1** e **TSI 2**. Cada uma com **5 tanques fixos**.
- Capacidade **12 t/h por máquina** (configurável).
- **Recurso único**: uma máquina roda **uma ordem por vez**. Ordem `Parada` também ocupa a máquina.

### Turnos (2) — NÃO são programados
- Turno 1: 07:30–17:30 (10h) · Turno 2: 17:30–03:00 (9h30).
- **O turno não entra na programação.** É *derivado* do horário real do apontamento de início:
  início até 17:30 → T1; depois → T2.
- **Dia de produção** = 07:30 até 03:00 do dia seguinte. O turno 2 cruza a meia-noite e pertence
  ao dia que começou.
- Capacidade/dia por máquina = 12 t/h × 19,5 h = **234 t**.

### Embalagens
| Código app | Código comercial (SimpleAgro) | Sementes | Fator peso |
|---|---|---|---|
| BG5M | BB5M | 5.000.000 | PMS × 5 |
| MEIOBAG | BMB | 2.500.000 | PMS × 2,5 |

### Lotes de semente
- Vêm da planilha de **Saldos** da SimpleAgro (upload) — ver §4.
- **Peso do bag = PMS × 5** (BB5M) ou **PMS × 2,5** (BMB). Ex.: PMS 171 → 855 kg/bag.
- Status: `Em estoque` → `Baixado` (logística) → volta a `Em estoque` só por estorno.
- A **baixa é do lote**, não da ordem: baixar um lote libera **todas** as ordens que dependem dele.

### Produtos químicos e receitas
- Cada químico tem **unidade de dose** (`ml/kg` ou `g/kg`) e **densidade em g/ml** (só para ml/kg).
- **A receita é definida por dose. A balança confere por peso.**
  - `ml/kg` → peso de balança (kg) = dose × peso_semente_kg × densidade / 1000
  - `g/kg`  → peso de balança (kg) = dose × peso_semente_kg / 1000
  - volume (L) = dose × peso_semente_kg / 1000 (informativo, só ml/kg)
- Nome da receita = **código do comercial** (FTZ60, V&P, DER + LMT, FTZ ELITE…) — língua única
  entre comercial e produção, sem tabela de-para.
- **Mistura em tanque**: só existem 5 tanques. Receita com mais de 5 produtos agrupa produtos no
  mesmo tanque. O planejado do tanque é a **soma** dos pesos dos produtos daquele tanque, e o
  Real vs Planejado compara contra essa soma.
- **Transferidor (destino 0)**: pó secante (grafite) nunca vai em tanque — na receita ele é
  dosado no transferidor. Tem **pesagem (peso inicial/final) igual aos tanques**
  (decisão de 05/08/2026); só o nome muda na tela.
- **Lote de químico está FORA do escopo** (decisão de 05/08/2026): não há cadastro de lote de
  químico, escolha na ordem nem trava no início. O cadastro de **produtos** químicos (com
  densidade) continua — é dele que sai o peso de balança.

### Peso de ensaque
`ensaque_por_bag = peso_do_bag_do_lote + (peso_químico_total_da_ordem ÷ bags_da_ordem)`

---

## 2. Ciclo de vida da ordem (matriz de permissões)

Status: `Não programada` → `Programada` → `Aguardando lote` → `Pronto para produzir` →
`Em produção` ⇄ `Parada` → `Finalizada` → `Qualidade apontada` → `Apontada`

`Aguardando lote` e `Pronto para produzir` são **derivados**: se o lote está `Em estoque` →
aguardando; se `Baixado` → pronto.

| Status | Editar | Excluir | Iniciar | Priorizar | Qualidade | Estorno do lote |
|---|---|---|---|---|---|---|
| Não programada / Programada / Aguardando lote | ✔ | ✔ | — | ✔ | — | ✔ |
| Pronto para produzir | ✔ | ✔ | ✔ | ✔ | — | ✔ |
| Em produção / Parada | ✖ | ✖ | ✖ | ✖ | ✖ | **✖** |
| Finalizada / Qualidade apontada | ✖ | ✖ | ✖ | ✖ | ✔ | **✖** |
| Apontada | ✖ | ✖ | ✖ | ✖ | ✖ | **✖** |

**Regra de ouro:** antes de iniciar, tudo é editável; depois que a produção toca a ordem, ela é
registro histórico. Estorno de lote é bloqueado se **qualquer** ordem daquele lote já foi iniciada.

**Chave anti-duplicidade da ordem:** `nº ordem + cultivar + tratamento + embalagem`.

### Fluxo de execução em duas etapas (crítico — não simplificar)
1. **Iniciar** apenas *prepara*: monta os tanques da receita e abre a ordem. **Não** inicia o cronômetro.
2. Operador informa o **peso inicial de cada tanque** (obrigatório).
3. **Confirmar início** → grava o evento, define o turno, ocupa a máquina.
4. Durante a produção o **peso final está travado**.
5. **Finalizar** apenas *libera* a pesagem final. **Não** finaliza.
6. Operador informa pesos finais → **Confirmar finalização** → grava o fim.

Fechar a janela em qualquer etapa **não** muda o estado. `Cancelar início` descarta apontamentos
(com auditoria) e libera a máquina — usado quando o operador inicia a ordem errada.
`Voltar para produção` desfaz um Finalizar clicado por engano: fecha só a pesagem final,
sem descartar nada (decisão de 05/08/2026 — antes a única saída era o Cancelar início).

### Qualidade em 2 etapas + conferência (decisão de 05/08/2026)
O **checklist substituiu** o Aprovado/Reprovado + amostra. Campos, iguais nas duas etapas:
**qualidade geral do tratamento** (nota 1–5; a coluna no banco chama `recobrimento`, nome
histórico) · umidade do tratamento (OK/Fora do padrão) · desprendimento de pó (OK/Fora do
padrão) · observação. Em processo tem ainda a **origem da amostra (BOWL/BAG)**.
**Apenas informativos — nunca bloqueiam.**
- **Em processo**: com a ordem `Em produção`/`Parada`. Vários registros por ordem, com hora
  (histórico). Não muda status.
- **Final**: com a ordem `Finalizada`. Um registro por ordem → status `Qualidade apontada`.
- **Conferência de estoque (Logística)**: para ordens finalizadas, registra os **bags contados**
  fisicamente (compara com o esperado). **É pré-requisito do AGROTIS** (trigger no banco).
- **Visão geral (tela Etapas)**: régua por ordem — Produção → Q. processo → Q. final →
  Conferência → AGROTIS.

### Encerramento (AGROTIS — tela própria)
Após a **qualidade final** e a **conferência de estoque**, o **PCP** lança a ordem no AGROTIS e
registra o **nº do lançamento** (obrigatório) → status `Apontada`, registro definitivo. Gancho
natural para integração futura.

---

## 3. Cálculos

### Tempos (por ordem)
```
bruto      = fim − início
paradas    = Σ (fim − início) de cada parada
líquido    = bruto − paradas
lead time  = fim − liberação/programação
disp. bruta        = líquido ÷ bruto                        (toda parada é perda)
disp. operacional  = líquido ÷ (bruto − paradas planejadas) (só perda real)
rendimento = toneladas ÷ líquido
planejado  = peso_t ÷ capacidade_th × 3600 (segundos)
```

**Motivos de parada têm tipo `Planejada` ou `Não planejada`.** Setup/troca de receita, limpeza,
refeição e manutenção preventiva são planejadas; quebra, falta de lote/químico/embalagem,
entupimento e queda de energia são não planejadas. Sem essa classificação o setup penalizaria a
disponibilidade como se fosse falha.

### Ocupação
```
capacidade_dia_máquina = 12 t/h × 19,5 h = 234 t
ocupação = Σ peso das ordens da máquina no dia ÷ capacidade_dia
```
Alerta >85% (âmbar) e >100% (vermelho, com opção de rebalancear).

### Balanço de demanda (por cultivar + tratamento + embalagem)
```
saldo = pedidos_APROVADOS − estoque_PA − ordens_abertas
```
- `ordens_abertas` = todas com status ≠ `Apontada` (ordem apontada sai do balanço e reaparece
  no estoque do próximo upload).
- Avisos **fortes, nunca bloqueantes** (decisão do PCP): sem pedido de venda · estoque já cobre ·
  já planejado · excede o saldo · **estoque parado** (mesmo cultivar+tratamento em embalagem sem pedido).
- Pedido de venda com código de tratamento **sem receita cadastrada** entra no balanço (a demanda
  existe), mas **não permite criar ordem** — a combinação é marcada "receita não cadastrada".

---

## 4. Integrações (hoje upload, amanhã API)

### Pedidos de venda — SimpleAgro, relatório "Pedidos Analítico Resumido"
`https://sementesveneza.painel.simpleagro.com.br:3333/sales/relatorios/pedidos-analitico-resumido`

Regras de conversão (validadas contra arquivo real de 1.196 linhas):
- **Coluna `Status Pedido`** (E no arquivo de referência; a letra varia por export, o importador
  acha pelo nome): só pedido firme — `Aprovado` ou `Integrado` (aprovado já sincronizado no ERP).
  Decisão do PCP em 05/08/2026; no arquivo de referência só existe `Integrado`.
- **Coluna H `Status Financeiro`**: `Aprovado` entra no balanço; `Não Aprovado` é importado como
  *aguardando aprovação* (visível, fora do cálculo).
- **Coluna BW `Saldo a Faturar`** = quantidade em bags (já líquida do faturado).
- **Coluna AT `Tratamento`** = código da receita. `SEM TSI` → **excluir** (não gera trabalho de TSI).
- **Coluna AU `Embalagem`**: BB5M→BG5M, BMB→MEIOBAG.
- **Coluna AL `Produto`** vem duplicado ("761 I2X - 761 I2X") → usar o trecho antes do " - ".
- Saldo ≤ 0 → excluir. Agregar por combinação somando BW.
- **Resultado esperado do arquivo de referência**: 1.018 bags aprovados, 4.674 aguardando,
  247 combinações, 22 códigos sem receita cadastrada.

### Estoque e lotes — SimpleAgro, tela "Saldos"
`https://sementesveneza.painel.simpleagro.com.br:3333/work/saldos` (escolher safra → Ir → Exportar)

Colunas: C cultivar · F lote · G lote tratamento · H PMS · K saldo (bags) · A nome do produto (embalagem no fim).
- **Cultivar truncado na origem**: em alguns produtos a coluna CULTIVAR perde o começo do nome
  (`O700 I2X` quando o nome do produto diz `SS NEO700 I2X BB5M`) — e os pedidos usam o nome
  completo, então o balanço nunca casaria. Regra validada na carga de 28/07 (126 linhas, 2
  cultivares, 0 falso positivo): quando o miolo do nome do produto TERMINA com a coluna, o
  miolo vence. A prévia mostra cada correção.
**Um arquivo, dois destinos:**
- linhas **com embalagem** + tratamento `SEM TSI` → **lotes de semente** (peso/bag = PMS × fator),
  agregando o mesmo lote em vários endereços;
- linhas **com embalagem** + tratamento real → **estoque PA** (para o balanço);
- **PRE-LOTE / granel (sem embalagem)** → ignorar (matéria-prima em kg).
- Saldo negativo → ignorar e **reportar** (o arquivo de referência tem 4 casos, −27 bags).
- **Resultado esperado**: 753 lotes · 16.865 bags · 0 estoque PA tratado.

### SAP Business One — Service Layer **SUSPENSO** 🛑
A integração foi **retirada do app**. O acesso externo existe e o login funciona, mas a
execução de consultas via Service Layer é recusada com `403` mesmo para usuário
profissional — trava de ambiente. Os dados do TSI seguem vindo do **upload das planilhas
da SimpleAgro**, que está validado.

Ver `docs/integracao-sap.md` para o diagnóstico completo e o que pedir à Agrotis caso se
retome. **Não reimplementar sem antes confirmar que o `403` foi resolvido.**

Ambiente **B1 sobre HANA**, hospedado pela Agrotis/AutoSky:

| Item | Valor |
|---|---|
| Endpoint | `https://sap-sementesveneza-sl.skyinone.net:50000/b1s/v1` |
| Base de **homologação** | `SBOVENHOM2` |
| Base de **produção** | `SBOVENPRD` |
| Credenciais | usuário/senha fornecidos por e-mail — **nunca comitar** (ver §4.1) |
| Certificado | provavelmente autoassinado (navegador exige "Avançado → Continuar") |

**Regra de trabalho, se um dia voltar:** desenvolver e testar **sempre contra `SBOVENHOM2`**.
`SBOVENPRD` só no job final e **somente leitura** — nenhum POST/PATCH/DELETE em produção.

---

### 4.1 Segredos — regra dura
Credenciais **nunca** entram no repositório, no CLAUDE.md, em prints ou em chat. Sempre:
- desenvolvimento local → `.env.local` (já no `.gitignore`)
- job de sincronização → **Supabase Secrets** / variáveis de ambiente do servidor
- rotação: se um segredo aparecer em qualquer lugar versionado, trocar imediatamente com a Agrotis.

```
# .env.local (exemplo — preencher com os valores reais)
SAP_SL_URL=https://sap-sementesveneza-sl.skyinone.net:50000/b1s/v1
SAP_COMPANY_DB=SBOVENHOM2
SAP_USER=
SAP_PASSWORD=
```

## 5. Perfis e permissões

| Perfil | Telas | Ações exclusivas |
|---|---|---|
| **PCP** | Ordens, Programação, Lotes, Execução, Qualidade, Indicadores, Cadastros | criar/editar/excluir ordem, priorizar, programar, apontar AGROTIS |
| **Logística** | Programação, Lotes, Indicadores | baixar/estornar lote |
| **Produção** | Programação, Execução, Indicadores | iniciar/parar/retomar/finalizar, pesos de tanque |
| **Qualidade** | Execução, Qualidade, Indicadores | apontar qualidade visual e amostra |
| **Gestor** | todas | todas |

No protótipo os perfis são fixos no código. **No sistema real**: Supabase Auth com usuários
nominais (apontamento registra a pessoa, não o perfil) e uma **tela de administração** onde o gestor
define quais telas/ações cada perfil acessa. RLS no banco espelhando a matriz.

---

## 6. Telas (ver protótipo)

1. **Ordens** — inclusão por digitação e importação (Excel), filtros (busca livre, dia, status, máquina,
   cultivar, tratamento, lote), agrupamento dia→máquina com subtotais, coluna Seq, painel
   Demanda × Estoque × Planejado, upload diário, atalhos para a SimpleAgro, impressão e export .xlsx.
2. **Programação & Ocupação** — plano semanal navegável (máquina × dia, % ocupação), quadro do dia
   com 1 célula por máquina, arrastar-e-soltar (inclusive sobre outra ordem para posicionar na
   sequência), ▲▼, **Programar automaticamente** (urgentes → lote baixado → agrupa cultivar+tratamento),
   **Encaixar**, **Rebalancear**, **Otimizar sequência**, **Checklist do dia**.
3. **Lotes a baixar** — cards por lote com bags a baixar, lotes críticos (travam ordem urgente),
   mini-tabela de ordens dependentes, seção "baixados sem ordem — devolver", relatório de baixas
   (dia/semana/mês) com export.
4. **Execução** — cards por máquina (ordem atual, tempo planejado, decorrido, paradas, parada atual),
   grade completa agrupada por dia→máquina, botões de apontamento, coluna Lote sempre visível.
5. **Qualidade** — visual (Aprovado / Aprovado com observação / Reprovado) + retirada de amostra (S/N).
6. **Indicadores** — produção por máquina e turno, relatório por ordem (planejado vs realizado bruto e
   líquido), produção por período (dia/semana/mês/geral) com tempo parado, Pareto de paradas
   separando planejada de não planejada, export .xlsx.
7. **Cadastros** — máquinas, turnos, embalagens, químicos (com densidade), receitas (dose · densidade ·
   volume · peso de balança), motivos de parada, lotes.

---

## 7. Pendências de especificação (decidir com o cliente)

- **Qualidade reprovada**: hoje é só um carimbo. Retrabalho? Bloqueio do lote? Nova ordem?
- **Estoque de químicos**: o app aponta consumo real mas não sabe o saldo de insumo — falta alertar
  "o Fortenza não cobre a programação da semana".
- **Etiquetas**: a planilha antiga tinha ~15 abas de etiquetas; ficaram fora do escopo.
- **Capacidade variável**: 12 t/h é global. Pode variar por receita/embalagem?
- **Horário previsto por ordem** (cascata a partir da sequência) e **painel modo TV** — sugeridos, não feitos.

## 8. Dados de exemplo do protótipo (substituir na carga real)

Produtos, doses e **densidades** dos químicos são **fictícios plausíveis** — trocar pelas fichas
técnicas (FISPQ) reais. Densidade errada desloca todo o planejado de balança.
