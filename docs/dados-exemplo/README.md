# Planilhas de referência

Coloque aqui os arquivos reais exportados (ignorados pelo git — podem conter dados de clientes):

- `relatorio-pedidos-analitico-resumido.xlsx` — SimpleAgro → Vendas → Relatórios → Pedidos Analítico Resumido
- `saldos.xlsx` — SimpleAgro → Work → Saldos (escolher safra → Ir → Exportar)

Números conferidos na carga de 28/07/2026, para validar a conversão:

| Arquivo | Resultado esperado |
|---|---|
| pedidos (1.196 linhas) | 247 combinações · **1.018 bags aprovados** · 4.674 aguardando · 22 códigos sem receita |
| saldos (844 linhas) | **753 lotes** · **16.865 bags** · 0 estoque PA tratado · 22 linhas de pré-lote excluídas · 4 saldos negativos |
