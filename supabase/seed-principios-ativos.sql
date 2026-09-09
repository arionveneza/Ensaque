-- ============================================================
-- Princípios ativos dos produtos químicos — carga inicial (12/09/2026)
-- Idempotente (ON CONFLICT na unique produto_id + nome). Rodado pelo
-- Claude direto no banco, com a tabela revisada pelo Arion antes.
-- ============================================================
--
-- Fonte: aba "Descrição" da planilha de tratamentos da Veneza, cruzada
-- com os 24 produtos do app pelo código. Onde a planilha estava errada
-- ou incompleta, o valor veio do RÓTULO oficial (marcado "rótulo") e o
-- Arion confere no Cadastros ▸ Produtos químicos:
--   AVICTA  → Abamectina 500 g/L (a planilha trazia linha trocada)
--   ILEVO   → Fluopiram 600 g/L (não estava na planilha)
--   RANCONA → Ipconazol 45 g/L (planilha dizia 45 %)
--   VOTIVO PRIME → Bacillus firmus, sem titulação (não sei com segurança)
--   ARVATICO / LUMITREO → composição do rótulo enviada pelo Arion
-- "Outros Ingredientes" (parte inerte) nunca entra. UFC/mL não cabe em
-- g/L, g/kg ou % — vai no nome, concentração nula.
--
-- Ficam SEM princípio, por decisão do Arion (a ficha avisa ao imprimir):
-- GRAFITE, FLUIDUS F047 PO SECANTE, KELMAX RN BR, DISCO BLACK.
-- ============================================================

set search_path = tsi, public;

do $$
declare
  v_apagados integer;
  v_gravados integer;
begin
  -- os 8 "TESTE" eram experimento da tela — substituídos pelos reais
  delete from produto_principios where nome = 'TESTE';
  get diagnostics v_apagados = row_count;

  insert into produto_principios (produto_id, nome, concentracao, unidade_conc, classe)
  select p.id, v.nome, v.conc, v.un, v.classe
    from (values
      -- Inseticidas
      ('INS00014', 'Tiametoxam',                        600::numeric,  'g/L', 'Inseticida'),
      ('INS00013', 'Ciantraniliprole',                   60::numeric,  '%',   'Inseticida'),
      ('INS00009', 'Fipronil',                           25::numeric,  '%',   'Inseticida'),
      ('INS00001', 'Clorantraniliprole',               62.5::numeric,  '%',   'Inseticida'),
      ('INS00007', 'Imidacloprido',                     600::numeric,  'g/L', 'Inseticida'),
      ('INS22228', 'Fipronil',                          250::numeric,  'g/L', 'Inseticida'),
      -- Fungicidas
      ('INS22228', 'Piraclostrobina',                    25::numeric,  'g/L', 'Fungicida'),
      ('INS22228', 'Tiofanato-metílico',                225::numeric,  'g/L', 'Fungicida'),
      ('INS00003', 'Azoxistrobina',                      15::numeric,  'g/L', 'Fungicida'),
      ('INS00003', 'Tiabendazol',                       300::numeric,  'g/L', 'Fungicida'),
      ('INS00003', 'Fludioxonil',                      37.5::numeric,  'g/L', 'Fungicida'),
      ('INS00003', 'Metalaxil-M',                        30::numeric,  'g/L', 'Fungicida'),
      ('INS00038', 'Tiofanato-metílico',                350::numeric,  'g/L', 'Fungicida'),
      ('INS00038', 'Fluazinam',                        52.5::numeric,  'g/L', 'Fungicida'),
      ('INS00029', 'Ipconazol',                          45::numeric,  'g/L', 'Fungicida'),  -- rótulo
      ('INS22222', 'Bacillus velezensis (CNPSo 3602)',  150::numeric,  'g/L', 'Fungicida'),  -- rótulo
      ('INS00002', 'Oxatiapiprolina',                   230::numeric,  'g/L', 'Fungicida'),  -- rótulo
      ('INS00002', 'Picoxistrobina',                     76::numeric,  'g/L', 'Fungicida'),  -- rótulo
      ('INS00002', 'Ipconazol',                          76::numeric,  'g/L', 'Fungicida'),  -- rótulo
      -- Nematicidas
      ('INS22226', 'Bacillus amyloliquefaciens',        270::numeric,  'g/L', 'Nematicida'),
      ('INS00000', 'Ciclobutrifluram',                  500::numeric,  'g/L', 'Nematicida'),
      ('INS00008', 'Abamectina',                        500::numeric,  'g/L', 'Nematicida'), -- rótulo
      ('INS22224', 'Fluopiram',                         600::numeric,  'g/L', 'Nematicida'), -- rótulo
      ('INS22223', 'Bacillus firmus',                  null::numeric,  'g/L', 'Nematicida'), -- rótulo
      -- Inoculante (marca BIOLÓGICOS: SIM na ficha)
      ('INS00005', 'Bradyrhizobium 7×10⁹ UFC/mL',      null::numeric,  'g/L', 'Inoculante'),
      -- Outros (enraizadores e coadjuvantes — não há classe própria)
      ('INS00006', 'PREMAX® 7×10⁹ UFC/mL',             null::numeric,  'g/L', 'Outros'),
      ('INS11111', 'Nitrogênio',                          3::numeric,  '%',   'Outros'),
      ('INS11111', 'Óxido de potássio',                   8::numeric,  '%',   'Outros'),
      ('INS11111', 'Carbono',                            10::numeric,  '%',   'Outros'),
      ('INS00040', 'Carbono orgânico',                   10::numeric,  '%',   'Outros'),
      ('INS00040', 'Zinco',                             0.1::numeric,  '%',   'Outros'),
      ('INS00040', 'Molibdênio',                        0.1::numeric,  '%',   'Outros'),
      ('INS00040', 'Cobalto',                           0.1::numeric,  '%',   'Outros')
    ) as v(codigo, nome, conc, un, classe)
    join produtos_quimicos p on p.codigo = v.codigo
  on conflict (produto_id, nome) do update
     set concentracao = excluded.concentracao,
         unidade_conc = excluded.unidade_conc,
         classe       = excluded.classe;
  get diagnostics v_gravados = row_count;

  raise notice 'TESTE apagados: %, princípios gravados: %', v_apagados, v_gravados;
end $$;

-- ============================================================
-- Conferência
-- ============================================================
-- select p.nome, count(pp.id) from produtos_quimicos p
--   left join produto_principios pp on pp.produto_id = p.id
--  group by p.nome order by p.nome;
--   -- 33 princípios em 20 produtos; GRAFITE, FLUIDUS F047, KELMAX, DISCO BLACK com 0
-- select count(*) from produto_principios where nome = 'TESTE';  -- 0
