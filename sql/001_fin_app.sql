-- Módulo financeiro do cockpit: lançamentos manuais (escrita) + leitura do Nibo.
-- Idempotente. Rodar como superusuário no banco pepper_bi.
-- Regras:
--   * Nada em raw/bi é alterado. As views daqui leem SÓ tabelas raw.nibo_*,
--     que o ETL esvazia e recarrega (DELETE) mas nunca derruba. Não dependemos
--     das views bi.nibo_*, que o ETL faz DROP a cada carga.
--   * fin_app_owner (sem login) é dono de tudo; fin_app_rw (login do app) só
--     lê as views e faz INSERT/UPDATE em fin_app.lancamentos.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fin_app_owner') THEN
    CREATE ROLE fin_app_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fin_app_rw') THEN
    CREATE ROLE fin_app_rw LOGIN;   -- senha definida à parte (ALTER ROLE ... PASSWORD)
  END IF;
END $$;

-- Leitura do Nibo, só nas tabelas necessárias.
GRANT USAGE ON SCHEMA raw TO fin_app_owner;
GRANT SELECT ON raw.nibo_accounts, raw.nibo_categories, raw.nibo_schedules,
                raw.nibo_stakeholders, raw.nibo_entries TO fin_app_owner;

CREATE SCHEMA IF NOT EXISTS fin_app AUTHORIZATION fin_app_owner;

SET ROLE fin_app_owner;

-- ------------------------------------------------------------- tabelas
CREATE TABLE IF NOT EXISTS fin_app.lancamentos (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tipo            text NOT NULL CHECK (tipo IN ('pagar', 'receber')),
    vencimento      date NOT NULL,
    competencia     date,
    previsto_para   date,
    contato         text,
    categoria_id    uuid,            -- raw.nibo_categories.id (sem FK: o ETL recarrega o raw)
    categoria_nome  text,
    conta_id        uuid,            -- raw.nibo_accounts.id
    conta_nome      text,
    descricao       text,
    valor           numeric(14,2) NOT NULL CHECK (valor > 0),
    status          text NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto', 'pago')),
    valor_pago      numeric(14,2) CHECK (valor_pago >= 0),
    data_pagamento  date,
    grupo_id        uuid,            -- liga parcelas / repetições mensais
    parcela         int,
    total_parcelas  int,
    recorrencia     text CHECK (recorrencia IN ('mensal', 'parcelado')),
    cancelado_em    timestamptz,
    criado_em       timestamptz NOT NULL DEFAULT now(),
    atualizado_em   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pago_tem_data_valor CHECK (
        status = 'aberto' OR (valor_pago IS NOT NULL AND data_pagamento IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS lancamentos_venc_idx ON fin_app.lancamentos (vencimento);
CREATE INDEX IF NOT EXISTS lancamentos_grupo_idx ON fin_app.lancamentos (grupo_id, parcela);

CREATE TABLE IF NOT EXISTS fin_app.historico (
    id             bigserial PRIMARY KEY,
    lancamento_id  uuid NOT NULL,
    acao           text NOT NULL,
    antes          jsonb,
    depois         jsonb,
    em             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS historico_lanc_idx ON fin_app.historico (lancamento_id, em);

CREATE OR REPLACE FUNCTION fin_app.tg_atualizado_em() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.atualizado_em := now();
  RETURN NEW;
END $$;

-- SECURITY DEFINER: o app não precisa (nem tem) permissão de escrita no histórico.
CREATE OR REPLACE FUNCTION fin_app.tg_historico() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = fin_app, pg_temp AS $$
BEGIN
  INSERT INTO fin_app.historico (lancamento_id, acao, antes, depois)
  VALUES (NEW.id, lower(TG_OP),
          CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END, to_jsonb(NEW));
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS lancamentos_atualizado_em ON fin_app.lancamentos;
CREATE TRIGGER lancamentos_atualizado_em BEFORE UPDATE ON fin_app.lancamentos
    FOR EACH ROW EXECUTE FUNCTION fin_app.tg_atualizado_em();
DROP TRIGGER IF EXISTS lancamentos_historico ON fin_app.lancamentos;
CREATE TRIGGER lancamentos_historico AFTER INSERT OR UPDATE ON fin_app.lancamentos
    FOR EACH ROW EXECUTE FUNCTION fin_app.tg_historico();

-- ------------------------------------------------------------- views
-- Contas do Nibo com saldo atual.
--   saldo_nibo    = saldo inicial + todas as movimentações (inclui transferências entre contas)
--   ajuste_manual = lançamentos manuais pagos nesta conta (o Nibo não os conhece)
CREATE OR REPLACE VIEW fin_app.v_contas AS
SELECT a.id, a.name AS conta, a.type AS tipo, a.bank_name AS banco,
       a.open_balance AS saldo_inicial, a.open_balance_date AS data_saldo_inicial,
       COALESCE(e.mov, 0) AS movimentacoes_nibo,
       a.open_balance + COALESCE(e.mov, 0) AS saldo_nibo,
       COALESCE(m.ajuste, 0) AS ajuste_manual,
       a.open_balance + COALESCE(e.mov, 0) + COALESCE(m.ajuste, 0) AS saldo_atual,
       e.ultima_mov
FROM raw.nibo_accounts a
LEFT JOIN (
    SELECT account_id,
           sum(CASE kind WHEN 'receipt' THEN value ELSE -value END) AS mov,
           max(date) AS ultima_mov
    FROM raw.nibo_entries GROUP BY account_id
) e ON e.account_id = a.id
LEFT JOIN (
    SELECT conta_id,
           sum(CASE tipo WHEN 'receber' THEN valor_pago ELSE -valor_pago END) AS ajuste
    FROM fin_app.lancamentos
    WHERE status = 'pago' AND cancelado_em IS NULL
    GROUP BY conta_id
) m ON m.conta_id = a.id
WHERE NOT COALESCE(a.is_archived, false);

-- Árvore de categorias (grupo > subgrupo > categoria). in = receber, out = pagar.
CREATE OR REPLACE VIEW fin_app.v_categorias AS
SELECT id, name AS categoria, reference_code AS codigo,
       CASE type WHEN 'in' THEN 'receber' ELSE 'pagar' END AS tipo,
       group_name AS grupo, NULLIF(subgroup_name, '') AS subgrupo
FROM raw.nibo_categories;

CREATE OR REPLACE VIEW fin_app.v_contatos AS
SELECT DISTINCT name AS contato
FROM raw.nibo_stakeholders
WHERE NOT COALESCE(is_deleted, false) AND NOT COALESCE(is_archived, false) AND name IS NOT NULL;

-- Títulos a pagar/receber: Nibo (só leitura) + manuais, no mesmo formato.
CREATE OR REPLACE VIEW fin_app.v_titulos AS
SELECT 'nibo'::text AS origem, s.schedule_id::text AS id,
       CASE s.type WHEN 'Credit' THEN 'receber' ELSE 'pagar' END AS tipo,
       s.due_date AS vencimento, s.accrual_date AS competencia, s.due_date AS previsto_para,
       s.stakeholder_name AS contato, s.category_id AS categoria_id, s.category_name AS categoria_nome,
       c.group_name AS grupo, NULLIF(c.subgroup_name, '') AS subgrupo,
       NULL::uuid AS conta_id, NULL::text AS conta_nome, s.description AS descricao,
       -- No Nibo o paid_value de contas a pagar (Debit) vem negativo.
       s.value AS valor, s.open_value AS valor_em_aberto, abs(s.paid_value) AS valor_pago,
       p.data_pagamento,
       CASE WHEN s.is_paid THEN 'pago' ELSE 'aberto' END AS status,
       NULL::uuid AS grupo_id, NULL::int AS parcela, NULL::int AS total_parcelas,
       CASE WHEN s.has_recurrence THEN 'mensal' END AS recorrencia
FROM raw.nibo_schedules s
LEFT JOIN raw.nibo_categories c ON c.id = s.category_id
LEFT JOIN (SELECT schedule_id, max(date) AS data_pagamento
           FROM raw.nibo_entries WHERE schedule_id IS NOT NULL GROUP BY schedule_id) p
       ON p.schedule_id = s.schedule_id
UNION ALL
SELECT 'manual', l.id::text, l.tipo, l.vencimento, l.competencia,
       COALESCE(l.previsto_para, l.vencimento), l.contato, l.categoria_id, l.categoria_nome,
       c.group_name, NULLIF(c.subgroup_name, ''), l.conta_id, l.conta_nome, l.descricao,
       l.valor, CASE l.status WHEN 'aberto' THEN l.valor ELSE 0 END,
       CASE l.status WHEN 'pago' THEN l.valor_pago ELSE 0 END,
       l.data_pagamento, l.status, l.grupo_id, l.parcela, l.total_parcelas, l.recorrencia
FROM fin_app.lancamentos l
LEFT JOIN raw.nibo_categories c ON c.id = l.categoria_id
WHERE l.cancelado_em IS NULL;

-- Base da projeção: títulos em aberto por dia previsto. Vencidos entram em "hoje".
CREATE OR REPLACE VIEW fin_app.v_projecao_diaria AS
SELECT GREATEST(previsto_para, current_date) AS data, origem,
       previsto_para < current_date AS vencido,
       COALESCE(sum(valor_em_aberto) FILTER (WHERE tipo = 'receber'), 0) AS entradas,
       COALESCE(sum(valor_em_aberto) FILTER (WHERE tipo = 'pagar'), 0) AS saidas
FROM fin_app.v_titulos
WHERE status = 'aberto' AND valor_em_aberto > 0
GROUP BY 1, 2, 3;

RESET ROLE;

-- ------------------------------------------------------------- permissões do app
GRANT CONNECT ON DATABASE pepper_bi TO fin_app_rw;
GRANT USAGE ON SCHEMA fin_app TO fin_app_rw;
GRANT SELECT ON fin_app.v_contas, fin_app.v_categorias, fin_app.v_contatos,
                fin_app.v_titulos, fin_app.v_projecao_diaria, fin_app.historico TO fin_app_rw;
GRANT SELECT, INSERT, UPDATE ON fin_app.lancamentos TO fin_app_rw;
REVOKE DELETE, TRUNCATE ON fin_app.lancamentos FROM fin_app_rw;
-- Leitura das views bi.* do cockpit continua pelo bi_reader; fin_app_rw não recebe nada em raw/bi.
