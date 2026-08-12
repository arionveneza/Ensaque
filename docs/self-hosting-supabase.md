# Levar o banco para um servidor interno — Supabase self-hosted

> **Por que existe este documento:** decisão de 12/08/2026, motivada por política de dados —
> a empresa quer os dados dentro de casa, não na nuvem da Supabase. Acesso de fora da rede já
> tem solução (VPN existente), e há alguém de TI/infra que vai manter o servidor. Este
> documento é o roteiro para isso, escrito para quem toca Docker/Linux mas não conhece o
> Supabase por dentro.

## O que NÃO fazer: trocar Postgres por SQLite

O app depende de recursos que só existem no Postgres — RLS (a trava de permissão por perfil,
hoje toda no banco), Realtime (as telas atualizam sozinhas quando alguém aponta em outro
tablet) e as funções/gatilhos em PL/pgSQL (`tem_acao`, `fn_ordem_imutavel`, etc.). Trocar para
SQLite não seria "mudar de servidor" — seria reescrever a metade de trás do sistema.

## O caminho: Supabase self-hosted

A **mesma stack** (Postgres + Auth + Realtime + Storage), rodando via Docker no servidor da
empresa em vez da nuvem da Supabase. Todo o SQL deste repositório (`supabase/*.sql`) continua
valendo sem mudar uma linha — só troca o endereço para onde o front aponta.

Guia oficial da Supabase (mantido por eles, sempre atual):
- <https://supabase.com/docs/guides/self-hosting/docker>
- <https://github.com/supabase/supabase/tree/master/docker>

**O front-end NÃO precisa se mudar.** `tsi.veneza.app.br` continua na Cloudflare — é só HTML/JS
estático, não guarda dado nenhum. "Dados em casa" é sobre o BANCO, não sobre onde o site é
servido. O navegador do usuário (já na VPN) fala direto com o Postgres novo; a Cloudflare só
entrega os arquivos da tela.

---

## Fase 0 — Antes de começar

- **Servidor**: Linux, Docker + Docker Compose. Para o tamanho de uso de hoje (poucos usuários
  simultâneos, tablets no chão de fábrica), 4 vCPU / 8 GB RAM já roda; 8 vCPU / 16 GB dá
  folga. Disco: cresce com o histórico de ordens e as fotos da Qualidade (bucket
  `qualidade`) — calcular alguns GB de sobra e revisar depois de alguns meses de uso real.
- **Rede**: já resolvido pela VPN existente — o servidor só precisa ser alcançável por quem
  está na VPN, sem abrir porta para a internet pública. Mais simples e mais "em casa" do que
  expor publicamente.
- **Nome/endereço interno**: decidir um hostname (ex.: `tsi-db.interno.sementesveneza`) que
  resolva pela VPN, ou usar o IP interno direto. Vale ter certificado (mesmo autoassinado ou
  de uma CA interna) — o Auth troca token por HTTPS, e navegador reclama sem isso.
- **Backup de segurança antes de tocar em nada**: `pg_dump` completo do projeto atual na nuvem
  da Supabase (Settings → Database → Connection string, usar com `pg_dump`). Guardar à parte —
  é o seguro contra qualquer coisa dar errado na migração.

## Fase 1 — Levantar o Supabase self-hosted

Seguir o guia oficial (link acima): clonar o repositório da Supabase, usar o `docker-compose.yml`
da pasta `docker/`, preencher o `.env` deles com:
- Senha do Postgres.
- **JWT secret novo** (gerar um — não é o mesmo da nuvem; token de um projeto não vale no outro).
- Chaves `anon`/`service_role` geradas a partir do JWT secret novo (o próprio guia explica como).
- Credenciais do Studio (painel administrativo local, equivalente ao dashboard da Supabase).

Subir com `docker compose up -d`, confirmar que o Studio abre e o Postgres responde antes de
seguir.

## Fase 2 — Migrar o schema e os dados

**Recomendado: `pg_dump` do projeto atual, não replay manual dos ~20 arquivos em
`supabase/*.sql`.** Esses arquivos são o *histórico* de como o banco chegou aonde está — vários
foram superados por migrações posteriores (ex.: `estornar_lote` existiu, foi substituída por
`estornar_liberacao`) — replay-los em ordem, hoje, arrisca reconstruir um estado que não é
exatamente o atual. O banco de produção na nuvem É a fonte da verdade agora.

```bash
# 1. Schema completo do schema tsi (estrutura: tabelas, views, funções, triggers, policies)
pg_dump "postgresql://postgres:[SENHA]@[HOST-DA-NUVEM]:5432/postgres" \
  --schema=tsi --schema-only --no-owner --no-privileges \
  -f schema-tsi.sql

# 2. Dados (só depois do schema estar restaurado no servidor novo)
pg_dump "postgresql://postgres:[SENHA]@[HOST-DA-NUVEM]:5432/postgres" \
  --schema=tsi --data-only --no-owner \
  -f dados-tsi.sql

# 3. Restaurar os dois, na ordem, no Postgres novo (self-hosted)
psql "postgresql://postgres:[SENHA]@[SERVIDOR-NOVO]:5432/postgres" -f schema-tsi.sql
psql "postgresql://postgres:[SENHA]@[SERVIDOR-NOVO]:5432/postgres" -f dados-tsi.sql
```

Depois de restaurar, conferir com uma bateria rápida (mesmo espírito das conferências que
acompanham cada `supabase/*.sql` deste repositório):
- `select count(*) from tsi.ordens;` bate com o que a nuvem tinha?
- As 6 views (`v_ordens` e as 5 dependentes) existem e têm `security_invoker = true`?
  (`select viewname from pg_views where schemaname='tsi';` /
  `select relname from pg_class where relrowsecurity;` para RLS nas tabelas.)
- `tem_acao()`, `meu_perfil()`, `pode_baixar_lote()` continuam com
  `security_invoker`/permissões certas para `anon` (ver `supabase/auditoria-rpc.sql`, que já
  existe neste repo pronto pra rodar de novo aqui).

## Fase 3 — Usuários (Auth)

Usuário da Supabase Auth **não é uma linha de tabela comum** — não migra com `pg_dump` do
schema `tsi` (o Auth vive no schema `auth`, gerenciado pela própria plataforma). Caminho mais
simples, dado que são poucos usuários conhecidos (hoje: 6 Produção, 1 Logística, 2 PCP e
outros perfis, criados por script — ver §"Usuários da operação" em `PENDENCIAS.md`):
recriar cada um no servidor novo (painel Studio → Authentication, ou a Admin API do GoTrue)
com senha temporária, e cada pessoa troca no primeiro acesso. Recriar também a linha
correspondente em `tsi.usuarios` (perfil, nome) ligando pelo novo `id` do Auth.

## Fase 4 — Storage (fotos da Qualidade)

Criar o bucket `qualidade` no servidor novo, **privado**, igual ao atual. Copiar os arquivos
existentes: baixar da nuvem (API de Storage ou painel) e subir no servidor novo — não tem
atalho de "clonar bucket" automático entre projetos diferentes.

## Fase 5 — Front-end: só trocar o endereço

```bash
# .env.local (dev) e a variável de ambiente do build de produção
VITE_SUPABASE_URL=https://[endereço interno, via VPN]
VITE_SUPABASE_ANON_KEY=[a chave anon NOVA, gerada na Fase 1]
```

Rebuildar (`npm run build`) e publicar — continua saindo pela Cloudflare, sem mudar o resto do
pipeline (`wrangler.jsonc`, o push no GitHub, etc.). Quem acessar de fora da rede da empresa
precisa estar na VPN para as chamadas ao Supabase funcionarem (a página em si carrega de
qualquer lugar; é a API que exige VPN).

## Fase 6 — Cutover

- Testar tudo contra o servidor novo **antes** de trocar de vez — idealmente alguns dias com
  os dois no ar, comparando.
- Combinar uma janela de corte: parar de escrever na nuvem, fazer um `pg_dump` final de dados
  (só o que mudou desde a Fase 2), aplicar no servidor novo, trocar o `.env`, publicar.
- Só depois de confirmar que o servidor novo está estável, cancelar/pausar o projeto na nuvem
  da Supabase.

## Manutenção contínua (para quem toca o servidor)

- **Backup**: `pg_dump` agendado (cron) ou snapshot do volume Docker do Postgres — sem isso,
  autogerenciar o banco é mais arriscado do que a nuvem, que já faz backup automático.
  **Testar a restauração**, não só gerar o backup.
- **Atualizações**: a Supabase publica novas versões das imagens Docker; atualizar de tempos
  em tempos (patches de segurança do Postgres/GoTrue/etc.).
- **Monitorar disco**: Storage (fotos) e o histórico de ordens só crescem.
- **Certificado**: renovar antes de expirar, mesmo sendo interno/VPN-only.

## O que NÃO muda

Todo o SQL em `supabase/*.sql`, o front-end em `src/`, o `wrangler.jsonc`, o pipeline de
publicação — nada disso depende de a Supabase estar na nuvem ou em casa. É por isso que essa
migração é viável sem reescrever o sistema: a arquitetura já era "Postgres com RLS/Realtime",
só troca o endereço.
