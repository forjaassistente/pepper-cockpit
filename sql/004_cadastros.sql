-- Cadastros do app (fonte oficial a partir daqui). Idempotente; rodar como superusuário.
--   Financeiro : contas_bancarias, categorias > subcategorias (com grupo do fluxo e linha da DRE), pessoas
--   Fechamento : formas_pagamento (com grupo de conferência), pessoas com papel de equipe
-- Importação inicial do Nibo com o MESMO id (raw.nibo_*), então lançamentos e títulos do Nibo
-- continuam apontando para o cadastro certo. fin_app.importar_nibo() traz só o que for novo.

SET ROLE fin_app_owner;

-- ------------------------------------------------------------------ DRE (regime de competência)
CREATE TABLE IF NOT EXISTS fin_app.dre_linhas (
    codigo  text PRIMARY KEY,
    nome    text NOT NULL,
    ordem   int  NOT NULL,
    tipo    text NOT NULL CHECK (tipo IN ('linha', 'subtotal'))
);
INSERT INTO fin_app.dre_linhas (codigo, nome, ordem, tipo) VALUES
    ('receita_bruta',   'Receita bruta de vendas',                         10, 'linha'),
    ('deducoes',        '(−) Impostos e deduções sobre vendas',            20, 'linha'),
    ('taxas_venda',     '(−) Taxas de cartão e aplicativos',               30, 'linha'),
    ('receita_liquida', '= Receita líquida',                               40, 'subtotal'),
    ('cmv',             '(−) CMV: insumos e embalagens',                   50, 'linha'),
    ('lucro_bruto',     '= Lucro bruto',                                   60, 'subtotal'),
    ('pessoal',         '(−) Pessoal (salários, encargos, pró-labore, free lances)', 70, 'linha'),
    ('entrega',         '(−) Entregas (motoboys)',                         80, 'linha'),
    ('ocupacao',        '(−) Ocupação (aluguel, energia, água, gás)',      90, 'linha'),
    ('marketing',       '(−) Marketing',                                  100, 'linha'),
    ('administrativas', '(−) Administrativas e operacionais',             110, 'linha'),
    ('ebitda',          '= EBITDA',                                       120, 'subtotal'),
    ('financeiras',     '(±) Resultado financeiro',                       130, 'linha'),
    ('outras',          '(±) Outras receitas e despesas não operacionais', 140, 'linha'),
    ('resultado',       '= Resultado líquido',                            150, 'subtotal')
ON CONFLICT (codigo) DO NOTHING;

-- ------------------------------------------------------------------ contas bancárias
CREATE TABLE IF NOT EXISTS fin_app.contas_bancarias (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    nome                text NOT NULL UNIQUE,
    tipo                text NOT NULL DEFAULT 'banco' CHECK (tipo IN ('banco', 'dinheiro', 'investimento', 'carteira')),
    banco               text,
    finalidade          text,
    saldo_inicial       numeric(14,2) NOT NULL DEFAULT 0,
    data_saldo_inicial  date,
    ordem               int NOT NULL DEFAULT 100,
    ativo               boolean NOT NULL DEFAULT true,
    nibo_id             uuid UNIQUE,
    criado_em           timestamptz NOT NULL DEFAULT now(),
    atualizado_em       timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ plano de contas
CREATE TABLE IF NOT EXISTS fin_app.categorias (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    nome           text NOT NULL UNIQUE,
    grupo_fluxo    text NOT NULL CHECK (grupo_fluxo IN ('operacional', 'investimento', 'financiamento')),
    ordem          int NOT NULL DEFAULT 100,
    ativo          boolean NOT NULL DEFAULT true,
    nibo_ref       text UNIQUE,                 -- "grupo|subgrupo" do Nibo
    criado_em      timestamptz NOT NULL DEFAULT now(),
    atualizado_em  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fin_app.subcategorias (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    categoria_id   uuid NOT NULL REFERENCES fin_app.categorias (id),
    nome           text NOT NULL,
    tipo           text NOT NULL CHECK (tipo IN ('pagar', 'receber')),
    dre_linha      text REFERENCES fin_app.dre_linhas (codigo),   -- NULL = fora da DRE
    codigo         text,
    ativo          boolean NOT NULL DEFAULT true,
    nibo_id        uuid UNIQUE,
    criado_em      timestamptz NOT NULL DEFAULT now(),
    atualizado_em  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (categoria_id, nome)
);

-- ------------------------------------------------------------------ pessoas
CREATE TABLE IF NOT EXISTS fin_app.pessoas (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    nome           text NOT NULL,
    papeis         text[] NOT NULL DEFAULT '{}',
    tipo_pessoa    text CHECK (tipo_pessoa IN ('PF', 'PJ')),
    documento      text,
    telefone       text,
    email          text,
    chave_pix      text,
    diaria_padrao  numeric(14,2),
    observacao     text,
    ativo          boolean NOT NULL DEFAULT true,
    nibo_id        uuid UNIQUE,
    criado_em      timestamptz NOT NULL DEFAULT now(),
    atualizado_em  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT papeis_validos CHECK (papeis <@ ARRAY['fornecedor', 'cliente', 'funcionario', 'socio',
                                                     'motoboy', 'free_lance', 'responsavel_caixa']::text[])
);
CREATE INDEX IF NOT EXISTS pessoas_papeis_idx ON fin_app.pessoas USING gin (papeis);

-- ------------------------------------------------------------------ formas de pagamento (fechamento)
CREATE TABLE IF NOT EXISTS fin_app.formas_pagamento (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    nome               text NOT NULL UNIQUE,
    conferencia        text NOT NULL,           -- 'gaveta' (dinheiro do canal) ou nome do grupo conferido
    canais             text[] NOT NULL DEFAULT ARRAY['Salão', 'Delivery'],
    taxa_percentual    numeric(6,3),
    prazo_recebimento  int,
    ordem              int NOT NULL DEFAULT 100,
    ativo              boolean NOT NULL DEFAULT true,
    criado_em          timestamptz NOT NULL DEFAULT now(),
    atualizado_em      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT canais_validos CHECK (canais <@ ARRAY['Salão', 'Delivery']::text[] AND cardinality(canais) > 0)
);
INSERT INTO fin_app.formas_pagamento (nome, conferencia, ordem) VALUES
    ('Dinheiro', 'gaveta', 10), ('Débito', 'Máquina cartão', 20), ('Crédito', 'Máquina cartão', 30),
    ('Pix Máquina Cartão', 'Máquina cartão', 40), ('Pix Direto', 'Pix direto', 50),
    ('Aiqfome', 'Aiqfome', 60), ('Anota Aí', 'Anota Aí', 70)
ON CONFLICT (nome) DO NOTHING;

CREATE OR REPLACE FUNCTION fin_app.tg_atualizado_em_cad() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.atualizado_em := now(); RETURN NEW; END $$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contas_bancarias', 'categorias', 'subcategorias', 'pessoas', 'formas_pagamento'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_atualizado_em ON fin_app.%I', t, t);
    EXECUTE format('CREATE TRIGGER %I_atualizado_em BEFORE UPDATE ON fin_app.%I
                    FOR EACH ROW EXECUTE FUNCTION fin_app.tg_atualizado_em_cad()', t, t);
  END LOOP;
END $$;

-- Fechamento: forma de pagamento passa a vir do cadastro (renomear propaga para o histórico).
ALTER TABLE fin_app.caixa_formas DROP CONSTRAINT IF EXISTS caixa_formas_forma_check;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'caixa_formas_forma_fk') THEN
    ALTER TABLE fin_app.caixa_formas ADD CONSTRAINT caixa_formas_forma_fk
      FOREIGN KEY (forma) REFERENCES fin_app.formas_pagamento (nome) ON UPDATE CASCADE;
  END IF;
END $$;

-- ------------------------------------------------------------------ importação do Nibo
CREATE OR REPLACE FUNCTION fin_app._titulo(s text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN s = upper(s) THEN upper(left(lower(s), 1)) || substr(lower(s), 2) ELSE s END
$$;

-- Traz do Nibo o que ainda não existe no cadastro (não altera o que você já editou).
CREATE OR REPLACE FUNCTION fin_app.importar_nibo() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = fin_app, pg_temp AS $$
DECLARE n_contas int; n_cat int; n_sub int; n_pes int;
BEGIN
  INSERT INTO fin_app.contas_bancarias (id, nome, tipo, banco, saldo_inicial, data_saldo_inicial, ativo, nibo_id)
  SELECT a.id, a.name, CASE a.type WHEN 'CashAccount' THEN 'dinheiro' ELSE 'banco' END, a.bank_name,
         coalesce(a.open_balance, 0), a.open_balance_date, NOT coalesce(a.is_archived, false), a.id
  FROM raw.nibo_accounts a
  WHERE NOT EXISTS (SELECT 1 FROM fin_app.contas_bancarias c WHERE c.nibo_id = a.id OR c.nome = a.name);
  GET DIAGNOSTICS n_contas = ROW_COUNT;

  INSERT INTO fin_app.categorias (nome, grupo_fluxo, nibo_ref, ordem)
  SELECT DISTINCT ON (ref) nome, fluxo, ref, ordem FROM (
    SELECT c.group_name || '|' || coalesce(nullif(c.subgroup_name, ''), '') AS ref,
           CASE WHEN nullif(c.subgroup_name, '') IS NOT NULL THEN fin_app._titulo(c.subgroup_name)
                ELSE CASE c.group_name
                       WHEN 'Atividades de financiamento' THEN 'Financiamento e capital'
                       WHEN 'Atividades de investimento' THEN 'Investimentos diversos'
                       WHEN 'Custos operacionais' THEN 'Custos operacionais diversos'
                       WHEN 'Receitas operacionais' THEN 'Outras receitas operacionais'
                       ELSE 'Despesas diversas' END END AS nome,
           CASE WHEN c.group_name ILIKE '%investimento%' THEN 'investimento'
                WHEN c.group_name ILIKE '%financiamento%' THEN 'financiamento' ELSE 'operacional' END AS fluxo,
           CASE WHEN c.group_name ILIKE 'Receitas%' THEN 10 WHEN c.group_name ILIKE 'Custos%' THEN 20
                WHEN c.group_name ILIKE 'Despesas%' THEN 30 WHEN c.group_name ILIKE '%investimento%' THEN 40
                ELSE 50 END AS ordem
    FROM raw.nibo_categories c) x
  WHERE NOT EXISTS (SELECT 1 FROM fin_app.categorias k WHERE k.nibo_ref = x.ref OR k.nome = x.nome)
  ORDER BY ref;
  GET DIAGNOSTICS n_cat = ROW_COUNT;

  INSERT INTO fin_app.subcategorias (id, categoria_id, nome, tipo, codigo, nibo_id)
  SELECT c.id, k.id, c.name, CASE c.type WHEN 'in' THEN 'receber' ELSE 'pagar' END, nullif(c.reference_code, ''), c.id
  FROM raw.nibo_categories c
  JOIN fin_app.categorias k ON k.nibo_ref = c.group_name || '|' || coalesce(nullif(c.subgroup_name, ''), '')
  WHERE NOT EXISTS (SELECT 1 FROM fin_app.subcategorias s WHERE s.nibo_id = c.id)
  ON CONFLICT (categoria_id, nome) DO NOTHING;
  GET DIAGNOSTICS n_sub = ROW_COUNT;

  INSERT INTO fin_app.pessoas (id, nome, papeis, tipo_pessoa, documento, telefone, email, ativo, nibo_id)
  SELECT s.id, s.name,
         ARRAY[CASE s.type WHEN 'Supplier' THEN 'fornecedor' WHEN 'Customer' THEN 'cliente'
                           WHEN 'Employee' THEN 'funcionario' ELSE 'socio' END],
         CASE WHEN s.raw->'document'->>'type' = 'Cnpj' THEN 'PJ' WHEN s.raw->'document'->>'type' = 'Cpf' THEN 'PF' END,
         s.raw->'document'->>'number',
         coalesce(s.raw->'communication'->>'cellPhone', s.raw->'communication'->>'phone'),
         s.raw->'communication'->>'email',
         NOT (coalesce(s.is_deleted, false) OR coalesce(s.is_archived, false)), s.id
  FROM raw.nibo_stakeholders s
  WHERE s.name IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fin_app.pessoas p WHERE p.nibo_id = s.id);
  GET DIAGNOSTICS n_pes = ROW_COUNT;

  RETURN jsonb_build_object('contas', n_contas, 'categorias', n_cat, 'subcategorias', n_sub, 'pessoas', n_pes);
END $$;

RESET ROLE;
GRANT USAGE ON SCHEMA raw TO fin_app_owner;
GRANT SELECT ON raw.nibo_stakeholders, raw.nibo_categories, raw.nibo_accounts TO fin_app_owner;
SET ROLE fin_app_owner;

SELECT fin_app.importar_nibo() AS importado;

-- Classificação inicial da DRE (sugestão; revisável na tela). Só preenche quem ainda não foi revisado.
UPDATE fin_app.subcategorias s SET dre_linha = m.linha
FROM (VALUES
  -- receita
  ('Receita por dinheiro em espécie','receita_bruta'), ('Receita por máquina de cartão','receita_bruta'),
  ('Receita por pagamento on-line aplicativos','receita_bruta'), ('Receita por pix direto','receita_bruta'),
  ('Receita por consumo dos colaboradores','receita_bruta'), ('Receita por consumo dos prestadores de serviço','receita_bruta'),
  ('Receita por consumo permutado','receita_bruta'), ('Receita em eventos','receita_bruta'),
  ('Receita em venda de produtos','receita_bruta'),
  -- deduções e taxas
  ('Simples Nacional','deducoes'), ('DARF','deducoes'), ('Descontos Concedidos','deducoes'), ('Devoluções cliente','deducoes'),
  ('COFINS Retido sobre a Receita','deducoes'), ('CSLL Retido sobre a Receita','deducoes'), ('INSS Retido sobre a Receita','deducoes'),
  ('IRPJ Retido sobre a Receita','deducoes'), ('ISS Retido sobre a Receita','deducoes'), ('Outras Retenções sobre a Receita','deducoes'),
  ('PIS Retido sobre a Receita','deducoes'),
  ('Taxas de cartão','taxas_venda'), ('Taxa de aplicativo','taxas_venda'), ('Aquisição / Aluguel máquinas de cartão','taxas_venda'),
  -- CMV
  ('Fornecedores de insumos para cozinha','cmv'), ('Fornecedores de insumos para bar','cmv'),
  ('Fornecedores de embalagens','cmv'), ('Materiais de produção','cmv'), ('Devolução de mercadoria','cmv'),
  -- pessoal
  ('Pro-Labore','pessoal'), ('Salários de colaboradores','pessoal'), ('Vale colaboradores','pessoal'), ('FGTS','pessoal'),
  ('GPS - Guia Previdência Social','pessoal'), ('13° / Férias','pessoal'), ('Free Lances','pessoal'), ('Rescisões','pessoal'),
  ('Sindicato / INSS / IR / Federação','pessoal'), ('Taxa de serviço','pessoal'), ('Metas alcançadas colaboradores','pessoal'),
  ('Bonificação Colaboradores','pessoal'), ('Profissional de limpeza','pessoal'), ('Exames ocupacionais','pessoal'),
  ('Presentes para colaboradores','pessoal'),
  ('Pagamento motoboys','entrega'),
  -- ocupação
  ('Aluguel, condomínio e IPTU','ocupacao'), ('Energia elétrica','ocupacao'), ('Água','ocupacao'), ('Gás para cozinha','ocupacao'),
  ('Seguro Imóvel','ocupacao'), ('Alarme monitoramento / Segurança','ocupacao'), ('Dedetização','ocupacao'),
  ('Manutenção do imóvel','ocupacao'),
  -- marketing
  ('Agência Marketing','marketing'), ('Influencers fixos','marketing'), ('Influencers variáveis','marketing'),
  ('Mídias / Propagandas / Patrocinados','marketing'), ('Papelaria (folders, cartões, etc)','marketing'),
  ('Designer gráfico','marketing'), ('Realização de eventos','marketing'), ('Patrocínios','marketing'),
  -- administrativas e operacionais
  ('Contabilidade','administrativas'), ('Certificado Digital','administrativas'), ('Laudos periódicos','administrativas'),
  ('Mensalidade de associações','administrativas'), ('Mensalidade de softwares e sistemas','administrativas'),
  ('Telefone e internet','administrativas'), ('Tecnologo de alimentos','administrativas'), ('Taxas e Alvarás','administrativas'),
  ('Compra de material ou utensílio para casa','administrativas'), ('Frete de produtos','administrativas'),
  ('Implantação de sistemas / softwares','administrativas'), ('Material de escritório','administrativas'),
  ('Material de limpeza','administrativas'), ('Manutenção máquinas e equipamentos','administrativas'),
  ('Aluguel de equipamentos / materiais','administrativas'), ('Farmácia','administrativas'), ('Lavação carro','administrativas'),
  ('Pedágio','administrativas'), ('Gasolina / Combustível','administrativas'), ('IPVA / Licenciamento / Despachante','administrativas'),
  ('Manutenção de veículos','administrativas'), ('Seguro veículos','administrativas'), ('Estacionamento / Pedágio','administrativas'),
  ('Músicos','administrativas'), ('Registro de marca','administrativas'), ('Consultorias','administrativas'),
  ('Cursos','administrativas'), ('Livros','administrativas'), ('Palestras','administrativas'), ('Treinamentos','administrativas'),
  ('Visitas / Feiras / Workshops','administrativas'),
  -- financeiras
  ('Juros Pagos','financeiras'), ('Tarifas bancárias','financeiras'), ('Juros Recebidos','financeiras'),
  ('Multas Recebidas','financeiras'), ('Descontos Recebidos','financeiras'),
  -- não operacionais
  ('Doações e caridades','outras'), ('Dízimo / Igreja','outras'), ('Processos judiciais','outras'), ('Acerto de caixa','outras'),
  ('Multas Pagas','outras'), ('Multa de veículos','outras'), ('Receitas Processos Jurídicos','outras'),
  ('EXTORNO CARTÃO DE CRÉDITO','outras'), ('Extorno Simples','outras'), ('Comissão Restituição Imposto','outras'),
  ('Outras receitas','outras')
  -- Fora da DRE (ficam NULL): aportes, empréstimos, retiradas, dívidas passadas, obras/reformas,
  -- compra de equipamentos/veículos (investimento), venda de ativos e impostos retidos de terceiros.
) AS m(nome, linha)
WHERE s.nome = m.nome AND s.dre_linha IS NULL AND s.nibo_id IS NOT NULL
  AND s.atualizado_em = s.criado_em;   -- não sobrescreve o que você já ajustou

-- Equipe e responsáveis do fechamento, a partir da planilha (últimos 120 dias, nomes recorrentes).
-- Mesma pessoa com/sem acento (Léo/Leo, João/Joao) vira um cadastro só, com a grafia mais usada.
WITH eq AS (
  SELECT nome, canal, count(*) AS n, translate(lower(nome), 'áéíóúãõâêôç', 'aeiouaoaeoc') AS chave
  FROM raw.caixa_pagamentos_equipe
  WHERE data > current_date - 120 AND nome IS NOT NULL
    AND nome !~* '^(diária|diaria|cozinha|free lance|reserva|joao teste)'
  GROUP BY nome, canal
), eq1 AS (
  SELECT DISTINCT ON (chave) nome, CASE WHEN canal = 'Delivery' THEN 'motoboy' ELSE 'free_lance' END AS papel,
         sum(n) OVER (PARTITION BY chave) AS total
  FROM eq ORDER BY chave, n DESC
), resp AS (
  SELECT responsavel AS nome, count(*) AS n, translate(lower(responsavel), 'áéíóúãõâêôç', 'aeiouaoaeoc') AS chave
  FROM raw.caixa_dia WHERE data > current_date - 120 AND responsavel IS NOT NULL GROUP BY responsavel
), resp1 AS (
  SELECT DISTINCT ON (chave) nome, 'responsavel_caixa'::text AS papel, sum(n) OVER (PARTITION BY chave) AS total
  FROM resp ORDER BY chave, n DESC
), novos AS (
  SELECT nome, papel FROM eq1 WHERE total >= 2
  UNION ALL
  SELECT nome, papel FROM resp1 WHERE total >= 5
)
INSERT INTO fin_app.pessoas (nome, papeis)
SELECT nome, ARRAY[papel] FROM novos e
WHERE NOT EXISTS (SELECT 1 FROM fin_app.pessoas p WHERE p.nibo_id IS NULL AND lower(p.nome) = lower(e.nome)
                    AND p.papeis && ARRAY['motoboy', 'free_lance', 'responsavel_caixa']);

-- ------------------------------------------------------------------ views passam a ler o cadastro
CREATE OR REPLACE VIEW fin_app.v_contas AS
SELECT a.id, a.nome AS conta, a.tipo, a.banco,
       a.saldo_inicial, a.data_saldo_inicial,
       COALESCE(e.mov, 0)::numeric AS movimentacoes_nibo,
       (a.saldo_inicial + COALESCE(e.mov, 0))::numeric AS saldo_nibo,
       COALESCE(m.ajuste, 0)::numeric AS ajuste_manual,
       (a.saldo_inicial + COALESCE(e.mov, 0) + COALESCE(m.ajuste, 0))::numeric AS saldo_atual,
       e.ultima_mov,
       a.ativo, a.finalidade, a.nibo_id, a.ordem
FROM fin_app.contas_bancarias a
LEFT JOIN (
    SELECT account_id, sum(CASE kind WHEN 'receipt' THEN value ELSE -value END) AS mov, max(date) AS ultima_mov
    FROM raw.nibo_entries GROUP BY account_id
) e ON e.account_id = a.nibo_id
LEFT JOIN (
    SELECT conta_id, sum(CASE tipo WHEN 'receber' THEN valor_pago ELSE -valor_pago END) AS ajuste
    FROM fin_app.lancamentos WHERE status = 'pago' AND cancelado_em IS NULL GROUP BY conta_id
) m ON m.conta_id = a.id
WHERE a.ativo;

CREATE OR REPLACE VIEW fin_app.v_categorias AS
SELECT s.id, s.nome AS categoria, s.codigo, s.tipo, k.nome AS grupo, NULL::text AS subgrupo,
       k.id AS categoria_id, k.grupo_fluxo, s.dre_linha, (s.ativo AND k.ativo) AS ativo, k.ordem
FROM fin_app.subcategorias s JOIN fin_app.categorias k ON k.id = s.categoria_id;

CREATE OR REPLACE VIEW fin_app.v_contatos AS
SELECT DISTINCT nome AS contato FROM fin_app.pessoas
WHERE ativo AND papeis && ARRAY['fornecedor', 'cliente', 'funcionario', 'socio'];

CREATE OR REPLACE VIEW fin_app.v_titulos AS
SELECT 'nibo'::text AS origem, s.schedule_id::text AS id,
       CASE s.type WHEN 'Credit' THEN 'receber' ELSE 'pagar' END AS tipo,
       s.due_date AS vencimento, s.accrual_date AS competencia, s.due_date AS previsto_para,
       s.stakeholder_name AS contato, s.category_id AS categoria_id, s.category_name AS categoria_nome,
       k.nome AS grupo, NULL::text AS subgrupo,
       NULL::uuid AS conta_id, NULL::text AS conta_nome, s.description AS descricao,
       -- No Nibo o paid_value de contas a pagar (Debit) vem negativo.
       s.value AS valor, s.open_value AS valor_em_aberto, abs(s.paid_value) AS valor_pago,
       p.data_pagamento,
       CASE WHEN s.is_paid THEN 'pago' ELSE 'aberto' END AS status,
       NULL::uuid AS grupo_id, NULL::int AS parcela, NULL::int AS total_parcelas,
       CASE WHEN s.has_recurrence THEN 'mensal' END AS recorrencia
FROM raw.nibo_schedules s
LEFT JOIN fin_app.subcategorias sc ON sc.id = s.category_id
LEFT JOIN fin_app.categorias k ON k.id = sc.categoria_id
LEFT JOIN (SELECT schedule_id, max(date) AS data_pagamento
           FROM raw.nibo_entries WHERE schedule_id IS NOT NULL GROUP BY schedule_id) p
       ON p.schedule_id = s.schedule_id
UNION ALL
SELECT 'manual', l.id::text, l.tipo, l.vencimento, l.competencia,
       COALESCE(l.previsto_para, l.vencimento), l.contato, l.categoria_id, l.categoria_nome,
       k.nome, NULL::text, l.conta_id, l.conta_nome, l.descricao,
       l.valor, CASE l.status WHEN 'aberto' THEN l.valor ELSE 0 END,
       CASE l.status WHEN 'pago' THEN l.valor_pago ELSE 0 END,
       l.data_pagamento, l.status, l.grupo_id, l.parcela, l.total_parcelas, l.recorrencia
FROM fin_app.lancamentos l
LEFT JOIN fin_app.subcategorias sc ON sc.id = l.categoria_id
LEFT JOIN fin_app.categorias k ON k.id = sc.categoria_id
WHERE l.cancelado_em IS NULL;

RESET ROLE;

GRANT SELECT ON fin_app.dre_linhas TO fin_app_rw;
GRANT SELECT, INSERT, UPDATE ON fin_app.contas_bancarias, fin_app.categorias, fin_app.subcategorias,
                                fin_app.pessoas, fin_app.formas_pagamento TO fin_app_rw;
GRANT EXECUTE ON FUNCTION fin_app.importar_nibo() TO fin_app_rw;
REVOKE EXECUTE ON FUNCTION fin_app.importar_nibo() FROM PUBLIC;
