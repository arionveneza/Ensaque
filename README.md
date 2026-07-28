# TSI — Controle de Tratamento Industrial de Sementes

Aplicação de execução de produção (MES enxuto) para o tratamento industrial de sementes da
**Sementes Veneza**. Substitui a planilha `TSI 2025`.

## Como começar (passo a passo)

### 1. Criar o repositório no GitHub
```bash
cd tsi-app
git init
git add .
git commit -m "Especificacao, schema do Supabase e prototipo de referencia"
gh repo create sementes-veneza/tsi-app --private --source=. --push
# (ou crie o repo pela interface do GitHub e faça git remote add origin ... && git push -u origin main)
```

### 2. Criar o projeto no Supabase
1. https://supabase.com → **New project** (região: São Paulo)
2. **SQL Editor** → cole e execute `supabase/schema.sql`
3. **Project Settings → API**: copie `Project URL` e `anon public key`
4. **Authentication → Users**: crie os usuários e depois insira o perfil de cada um:
```sql
insert into usuarios (id, nome, perfil) values
  ('<uuid-do-auth-user>', 'Nome da Pessoa', 'PCP');   -- PCP|Logistica|Producao|Qualidade|Gestor
```

### 3. Abrir o Claude Code na pasta
```bash
cd tsi-app
claude
```
O Claude Code lê o `CLAUDE.md` automaticamente. Primeiro pedido sugerido:

> Leia o CLAUDE.md e o docs/prototipo-referencia.html. Crie o projeto React + TypeScript + Vite
> com Tailwind e shadcn/ui, configure o cliente do Supabase por variáveis de ambiente e implemente
> a primeira tela: **Execução** (cards por máquina + grade agrupada por dia/máquina + fluxo de
> apontamento em duas etapas). Siga as regras do CLAUDE.md à risca — em especial a matriz de
> permissões por status e o fluxo Iniciar → pesos → Confirmar início.

### 4. Variáveis de ambiente
Crie `.env.local` (nunca comite):
```
VITE_SUPABASE_URL=https://xxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

## Ordem sugerida de implementação

1. **Execução** — é o coração e o mais usado no chão de fábrica
2. **Programação & Ocupação** — quadro do dia, drag-and-drop, auto-programar
3. **Lotes a baixar** — fluxo da logística
4. **Ordens** — digitação, importação de Excel, painel de demanda
5. **Qualidade** e **encerramento AGROTIS**
6. **Indicadores** e exportações
7. **Cadastros** e tela de administração de permissões

## Estrutura

```
tsi-app/
├── CLAUDE.md                        # especificação completa (o Claude Code lê sozinho)
├── README.md
├── .gitignore
├── docs/
│   ├── prototipo-referencia.html    # protótipo funcional — especificação executável
│   └── dados-exemplo/               # planilhas reais de referência (colocar aqui)
└── supabase/
    └── schema.sql                   # tabelas, views, triggers, RLS e seed
```

## Fontes de dados (hoje upload, amanhã API)

| Dado | Origem | Situação |
|---|---|---|
| Pedidos de venda | SimpleAgro → relatório *Pedidos Analítico Resumido* | upload .xlsx (conversão validada) |
| Estoque PA + lotes de semente | SimpleAgro → tela *Saldos* | upload .xlsx (conversão validada) |
| Ordens de produção | outro sistema | digitação ou importação |
| Futuro | SAP B1 Service Layer (HANA, hospedado Agrotis) | **pendente**: chamado para exposição externa + usuário somente leitura |

## Verificação

O protótipo tem 82 verificações automatizadas cobrindo capacidade, densidade/ensaque,
auto-programação, fluxo de execução em duas etapas, recurso único, matriz de status, estorno,
mistura em tanque, balanço de demanda e as conversões dos dois relatórios da SimpleAgro
(inclusive os números conferidos: **1.018 bags aprovados** e **753 lotes / 16.865 bags**).
Ao reimplementar em React, **porte esses casos para testes** (Vitest) — eles são o contrato do domínio.
