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
- **Quais turnos cada dia roda é do calendário** (decisão de 06/08/2026): nem todo dia tem os
  dois, e importa saber **qual** — só 1º são 10 h (120 t), só 2º são 9h30 (114 t). A tabela
  `dias_producao` (`turno1`/`turno2` booleanos) guarda **só a exceção**: dia sem linha roda os
  dois (234 t). Nenhum dos dois = sem produção, e o dia não recebe programação. Sem isso um
  sábado de um turno só aparecia com metade da ocupação real e a programação automática
  enfiava ordem que não caberia. Editável na linha **Turnos** do plano semanal; o cadastro de
  máquinas mostra a capacidade de cada turno e a do dia.

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
- **A receita NÃO define o tanque** (decisão de 06/08/2026): ela é só **produto + dose**. A
  distribuição varia de ordem para ordem, então quem informa o destino de cada produto é o
  **operador**, ao preparar a ordem, antes dos pesos (tabela `ordem_produtos`).
- **Mistura em tanque**: só existem 5 tanques. Receita com mais de 5 produtos obriga o operador
  a juntar produtos num tanque. O planejado do tanque é a **soma** dos pesos dos produtos que
  ele colocou lá, e o Real vs Planejado compara contra essa soma.
- **Transferidor (destino 0)**: pó secante (grafite) nunca vai em tanque — o operador escolhe
  "Transferidor" em vez de T1–T5. Tem **pesagem (peso inicial/final) igual aos tanques**.
- **Reabastecimento durante a ordem** (decisão de 07/08/2026): o produto acaba no meio e o
  operador completa o tanque. O consumo real deixa de ser `inicial − final` e passa a ser
  **`inicial + Σ abastecimentos − final`** — 100 kg de início, mais 100 durante, 50 sobrando
  = 150 consumidos, não 50. Cada carga vira uma linha em `ordem_tanque_abastecimentos`, com
  hora e autor: o total é derivável, mas *quantas vezes precisou completar* não — e é isso
  que denuncia tanque pequeno demais para a receita. Só com a ordem `Em produção`/`Parada`.
- **Lote de químico está FORA do escopo** (decisão de 05/08/2026): não há cadastro de lote de
  químico, escolha na ordem nem trava no início. O cadastro de **produtos** químicos (com
  densidade) continua — é dele que sai o peso de balança.

### Peso de ensaque
`ensaque_por_bag = peso_do_bag_do_lote × 1,005 + (peso_químico_total_da_ordem ÷ bags_da_ordem)`

O ×1,005 é a **margem de meio por cento sobre o peso do bag** (decisão de 05/08/2026);
a margem não incide sobre a parcela de químico.

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

**Excluir exige ordem virgem** (decisão de 05/08/2026): além do status, o banco recusa excluir
ordem com **qualquer história** — evento de produção, parada, teste de qualidade ou conferência
(trigger `tg_ordem_sem_historia`). Sem isso, o Cancelar início "lavava" o status e uma ordem
com testes de qualidade voltava a ser excluível em cascata, sem rastro. Tanques montados/pesos
digitados sem confirmação **não** bloqueiam (preparação é descartável); auditoria também não.

**Chave anti-duplicidade da ordem:** `nº ordem + cultivar + tratamento + embalagem`.

### Fluxo de execução em duas etapas (crítico — não simplificar)
1. **Iniciar** apenas *abre* a ordem para preparação. **Não** inicia o cronômetro.
2. Operador escolhe o **tanque de cada produto** (T1–T5 ou Transferidor) e informa o **peso
   inicial de cada tanque** — ambos obrigatórios. O tanque só existe depois que algum produto
   é destinado a ele.
3. **Confirmar início** → grava o evento, define o turno, ocupa a máquina.
4. Durante a produção o **peso final está travado**.
5. **Finalizar** apenas *libera* a pesagem final. **Não** finaliza.
6. **Confirmar finalização** exige a **quantidade produzida (bags)** — campo em branco,
   sem pré-preenchimento (vai para `ordens.bags_produzidos`). Peso final é **opcional**
   aqui (decisão de 05/08/2026): o operador anota na **folha impressa da ordem** e o
   **PCP digita na tela AGROTIS** — o lançamento exige todos os pesos (trigger).

Fechar a janela em qualquer etapa **não** muda o estado. `Cancelar início` descarta apontamentos
(com auditoria) e libera a máquina — usado quando o operador inicia a ordem errada. Se a ordem
já tem **testes de qualidade em processo**, o aviso diz quantos e eles são **apagados junto**
(decisão de 05/08/2026) — teste órfão em ordem "nunca produzida" seria corrupção de dado.
`Voltar para produção` desfaz um Finalizar clicado por engano: fecha a pesagem final e
descarta os pesos finais já digitados — a produção continuou, então serão pesados de novo
(decisão de 05/08/2026 — antes a única saída era o Cancelar início).

### Qualidade em 2 etapas + conferência (decisão de 05/08/2026)
O **checklist substituiu** o Aprovado/Reprovado + amostra. Campos, iguais nas duas etapas:
**qualidade geral do tratamento** (nota 1–5; a coluna no banco chama `recobrimento`, nome
histórico) · umidade do tratamento (OK/Fora do padrão) · desprendimento de pó (OK/Fora do
padrão) · observação. Em processo tem ainda a **origem da amostra (BOWL/BAG)**.
**Apenas informativos — nunca bloqueiam.**
- **Em processo**: com a ordem `Em produção`/`Parada`. Vários registros por ordem, com hora
  (histórico). Não muda status.
- **Final**: com a ordem `Finalizada`. Um registro por ordem → status `Qualidade apontada`.
  Aceita **até 3 fotos** (decisão de 07/08/2026), guardadas no bucket privado `qualidade` do
  Storage — a linha do teste só guarda o caminho. As imagens são reduzidas a 1600 px no
  navegador antes de subir: foto de tablet tem vários MB e travaria o envio na rede do galpão.
- **Ver os testes de uma ordem concluída**: a linha da tela Qualidade expande e mostra os
  testes em processo, o final e as fotos. Antes só o relatório `.xlsx` mostrava isso, e
  conferir uma reclamação exigia baixar a planilha inteira.
- **Conferência de estoque (Logística)**: para ordens finalizadas, a logística informa a
  **quantidade produzida que contou** — campo em branco, obrigatório, sem pré-preenchimento
  (contagem cega, decisão de 05/08/2026). A divergência compara com o **produzido** declarado
  pela produção (fallback: esperado). **É pré-requisito do AGROTIS** (trigger no banco).
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
horas_do_dia           = Σ das horas dos turnos que o dia roda (2 → 19,5 · 1 → 10 · 0 → 0)
capacidade_dia_máquina = 12 t/h × horas_do_dia          (234 t no dia cheio)
ocupação = Σ peso das ordens da máquina no dia ÷ capacidade_dia
```
Alerta >85% (âmbar) e >100% (vermelho, com opção de rebalancear). Dia de 0 turnos com ordem
programada é **bloqueio** no checklist.

### Reprogramação em cascata
Empurra para a frente o que não foi feito, a partir de um dia escolhido. Duas regras valem mais
que compactar bem (decisão de 06/08/2026):
- **Nada anda para trás** — uma ordem só entra na fila no dia dela ou depois; a cascata nunca
  puxa ordem da semana que vem para amanhã só porque sobrou espaço.
- **A fila não fura** — quando uma ordem não cabe no dia, as seguintes esperam junto; não se
  procura uma menor para preencher o buraco. Sequência é compromisso, não jogo de encaixe.

Ordem já iniciada não se move e continua ocupando capacidade e numeração do dia dela; dia sem
turno não recebe nada e devolve o que tinha para a fila. Ordem maior que um dia inteiro é
alocada mesmo assim, sinalizada — senão travaria a cascata para sempre. **Sempre com prévia
antes de gravar**: mexe em dezenas de ordens de uma vez.

### Histórico de reprogramação
Mudar o dia de uma ordem **não apaga de onde ela veio** (decisão de 06/08/2026 — antes
apagava). `ordens.data_prog_original` guarda o primeiro dia programado e nunca muda;
`reprogramacoes` conta quantas vezes o dia mudou; a tabela `ordem_reprogramacoes` registra
cada movimento (de/para dia, de/para máquina, quem e quando), inclusive as mudanças que são só
de máquina. Tudo por gatilho no banco — não dá para reprogramar por fora e escapar do
registro. Aparece no relatório de ordens (colunas *Dia original* e *Reprogramada*) e na marca
`↷n` ao lado do número da ordem.

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

### SAP Business One — Service Layer: **fora do app, caminho técnico destravado** 🟡
A integração continua **fora do app** (código removido em 28/07/2026) e os dados seguem
vindo do upload das planilhas da SimpleAgro. Mas o diagnóstico de 09/08/2026 mudou o quadro:

- **Basic Auth por requisição funciona** em produção (`SBOVENPRD`) — dispensa o fluxo
  Login+sessão, que está quebrado no ambiente hospedado (a sessão emitida não é reconhecida
  por nenhum nó). Se reimplementar, usar Basic Auth, não Login+sessão.
- **Mapeamento de campos confirmado com dado real**: PMS em `U_AGRT_PMS` (×5 = peso do bag,
  confirmado 176,40 × 5 = 882), tratamento em `U_LoteTSI` (texto livre — normalizar),
  item tratado tem sufixo `TSI` no `ItemName`, saldo total por item em
  `Items.QuantityOnStock` (55 insumos/defensivos listados).
- **Homologação tem endpoint próprio de Service Layer** (descoberto 09/08/2026):
  `https://sap-sementesvenezahom-sl.skyinone.net:50000/b1s/v1` — o SL de produção não a
  atende (HANAs separados). Lá o pipeline completo foi validado: criar e executar a
  consulta `TSI_SALDOS` devolveu **saldo por lote real** (PMS, tratamento, safra, bags por
  depósito). **Desenvolver sempre contra a homolog.**
- **Em produção só falta** replicar a autorização de `SQLQueries` (`code -6006`, assunto
  "Service Layer SQL Query" das Autorizações Gerais — mesma config que a homolog já tem)
  para liberar o saldo por lote de semente lá.

Ver `docs/integracao-sap.md` para o histórico completo. Reimplementar no app só com pedido
explícito do Arion — e sempre somente leitura em produção.

Ambiente **B1 sobre HANA**, hospedado pela Agrotis/AutoSky:

| Item | Valor |
|---|---|
| Endpoint | `https://sap-sementesveneza-sl.skyinone.net:50000/b1s/v1` |
| Base de **homologação** | `SBOVENHOM` |
| Base de **produção** | `SBOVENPRD` |
| Credenciais | usuário/senha fornecidos por e-mail — **nunca comitar** (ver §4.1) |
| Certificado | provavelmente autoassinado (navegador exige "Avançado → Continuar") |

**Regra de trabalho, se um dia voltar:** desenvolver e testar **sempre contra `SBOVENHOM`**.
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
SAP_COMPANY_DB=SBOVENHOM
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
2. **Programação & Ocupação** — plano semanal navegável (máquina × dia, % ocupação, linha de
   **turnos do dia**), quadro do dia com 1 célula por máquina, arrastar-e-soltar (sobre outra
   ordem para posicionar na sequência; sobre uma célula da semana para trocar de dia/máquina;
   sobre o pool para desprogramar), botão **mover** com selects para tablet — arrastar não
   funciona em tela de toque —, ▲▼, **Programar automaticamente** (urgentes → lote baixado →
   agrupa cultivar+tratamento), **Encaixar**, **Rebalancear**, **Otimizar sequência**,
   **Reprogramar cascata**, **Checklist do dia**.
   A fila é exibida **só pela sequência gravada** — urgência é etiqueta, não reordena sozinha,
   senão arrastar uma ordem normal para o topo parecia não funcionar.
3. **Lotes a baixar** — cards por lote com bags a baixar, lotes críticos (travam ordem urgente),
   mini-tabela de ordens dependentes, seção "baixados sem ordem — devolver", relatório de baixas
   (dia/semana/mês) com export.
4. **Execução** — cards por máquina (ordem atual, tempo planejado, decorrido, paradas, parada atual),
   grade completa agrupada por dia→máquina, botões de apontamento, coluna Lote sempre visível.
5. **Qualidade** — visual (Aprovado / Aprovado com observação / Reprovado) + retirada de amostra (S/N).
6. **Indicadores** — produção por máquina e turno, relatório por ordem (planejado vs realizado bruto e
   líquido), produção por período (dia/semana/mês/geral) com tempo parado, Pareto de paradas
   separando planejada de não planejada, export .xlsx.
6b. **Expedição** (07/08/2026) — upload do relatório **montagem de carga** da SimpleAgro
   (substituição total; colunas achadas pelo nome). Carregamentos agendados com filtros por
   período/status/cultivar/tratamento/embalagem e busca por cliente; **saldo dinâmico** por
   combinação contra o período filtrado: `SEM TSI` cruza com os **lotes** por cultivar (semente
   branca; o cultivar vira **uma linha só** somando as embalagens — o pool de lotes é um, e
   duas linhas o contariam duas vezes), tratamento real cruza com **estoque PA + TODAS as
   ordens abertas** — a data programada **não corta a conta**, porque produção se adianta
   (decisão do PCP, 07/08/2026). O aviso vem da **linha do tempo**: caminhão a caminhão, em
   ordem de data, a demanda acumulada é comparada com o garantido até aquele dia — estoque,
   ordens **já iniciadas** (inclusive a adiantada com data futura) e ordens programadas até a
   data; promessa vencida (`data_prog` no passado sem iniciar) e ordem sem dia não garantem.
   O pior buraco vira o âmbar **"adiantar ≥ X bg"** — o gancho para marcar a ordem urgente.
   Vermelho "faltam X" é falta mesmo adiantando. **"Atende" é reservado a estoque físico**:
   coberta só por produção futura, a linha fica em **"aguardando produção"** (azul) — bag
   programado não é bag no galpão (pedido do PCP, 07/08/2026). Embalagem sem de-para não vira
   falta falsa: ganha etiqueta própria. "Finalizado" começa fora do filtro — o caminhão
   já saiu e o upload seguinte de saldos já desconta; contar de novo dobraria a falta. Também
   lista os **pedidos de venda** (agregados por combinação — cliente não é guardado no upload)
   com filtro de liberação financeira. Recurso `expedicao` (ver/importar): PCP e Logística
   importam, Direção vê.
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
