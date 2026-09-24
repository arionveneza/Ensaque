# Planilhas de referência

Coloque aqui os arquivos reais exportados (ignorados pelo git — podem conter dados de clientes):

- `relatorio-pedidos-analitico-resumido.xlsx` — SimpleAgro → Vendas → Relatórios → Pedidos Analítico Resumido
- `saldos.xlsx` — SimpleAgro → Work → Saldos (escolher safra → Ir → Exportar)
- `montagem-carga-vs-lotes-2026-09-24.xlsx` — SimpleAgro → relatório montagem carga vs lotes (o A carregar do Estoque futuro; o teste `montagemCarga.test.ts` confere contra ele quando existe)

Números conferidos na carga de 28/07/2026, para validar a conversão:

| Arquivo | Resultado esperado |
|---|---|
| pedidos (1.196 linhas) | 247 combinações · **1.018 bags aprovados** · 4.674 aguardando · 22 códigos sem receita |
| saldos (844 linhas) | **753 lotes** · **16.865 bags** · 0 estoque PA tratado · 22 linhas de pré-lote excluídas · 4 saldos negativos |
| montagem carga vs lotes de 24/09/2026 (83 linhas) | **73 itens** · **707 bags** a carregar (a soma ingênua da Qtd Agendada dava 1.023) · 10 linhas eram só mais um lote de item já contado · 342 bags SEM TSI |
