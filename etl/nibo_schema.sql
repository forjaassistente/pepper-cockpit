-- Pepper BI · Nibo
-- raw.*  = cópia fiel da API (escrita só pelo bi_etl)
-- bi.*   = views prontas para o Metabase (lidas pelo bi_reader)
-- Idempotente: roda no início de cada carga.

CREATE TABLE IF NOT EXISTS raw.etl_runs (
    id          bigserial PRIMARY KEY,
    source      text        NOT NULL,
    started_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    status      text        NOT NULL DEFAULT 'running',
    row_counts  jsonb,
    error       text
);

CREATE TABLE IF NOT EXISTS raw.nibo_accounts (
    id           uuid PRIMARY KEY,
    name         text,
    type         text,
    bank_name    text,
    open_balance numeric(14,2),
    open_balance_date date,
    is_archived  boolean,
    raw          jsonb NOT NULL,
    loaded_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS raw.nibo_categories (
    id             uuid PRIMARY KEY,
    name           text,
    reference_code text,
    type           text,          -- in / out
    group_id       uuid,
    group_name     text,
    group_ref      text,
    subgroup_name  text,
    raw            jsonb NOT NULL,
    loaded_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS raw.nibo_stakeholders (
    id          uuid PRIMARY KEY,
    name        text,
    type        text,             -- Customer / Supplier / Employee ...
    is_deleted  boolean,
    is_archived boolean,
    raw         jsonb NOT NULL,
    loaded_at   timestamptz NOT NULL DEFAULT now()
);

-- Movimentações realizadas (receipts = entradas, payments = saídas)
CREATE TABLE IF NOT EXISTS raw.nibo_entries (
    entry_id         uuid PRIMARY KEY,
    kind             text NOT NULL,   -- receipt / payment
    date             date,
    accrual_date     date,
    value            numeric(14,2),
    account_id       uuid,
    account_name     text,
    is_transfer      boolean,
    is_reconciliated boolean,
    is_virtual       boolean,
    schedule_id      uuid,
    stakeholder_id   uuid,
    stakeholder_name text,
    category_id      uuid,
    category_name    text,
    description      text,
    identifier       text,
    reference        text,
    raw              jsonb NOT NULL,
    loaded_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nibo_entries_date_idx ON raw.nibo_entries (date);

-- Rateio por categoria de cada movimentação
CREATE TABLE IF NOT EXISTS raw.nibo_entry_categories (
    entry_id      uuid NOT NULL,
    kind          text NOT NULL,
    category_id   uuid,
    category_name text,
    parent_name   text,
    value         numeric(14,2)
);
CREATE INDEX IF NOT EXISTS nibo_entry_categories_entry_idx ON raw.nibo_entry_categories (entry_id);

-- Agendamentos (contas a receber / a pagar, inclusive previsões recorrentes)
CREATE TABLE IF NOT EXISTS raw.nibo_schedules (
    schedule_id      uuid PRIMARY KEY,
    type             text NOT NULL,   -- Credit / Debit
    due_date         date,
    accrual_date     date,
    schedule_date    date,
    value            numeric(14,2),
    paid_value       numeric(14,2),
    open_value       numeric(14,2),
    is_paid          boolean,
    is_dued          boolean,
    has_recurrence   boolean,
    stakeholder_id   uuid,
    stakeholder_name text,
    category_id      uuid,
    category_name    text,
    description      text,
    raw              jsonb NOT NULL,
    loaded_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nibo_schedules_due_idx ON raw.nibo_schedules (due_date);

-- ---------------------------------------------------------------- views bi
-- Recriadas a cada carga (dentro da transação). Sem CASCADE: se alguém criar
-- uma view própria em cima destas, a carga falha em vez de apagá-la.
DROP VIEW IF EXISTS bi.nibo_fluxo_diario, bi.nibo_movimentacoes, bi.nibo_transferencias,
    bi.nibo_agendamentos, bi.nibo_contas;

-- Uma linha por movimentação x categoria (rateio). Transferências entre contas ficam de fora.
CREATE OR REPLACE VIEW bi.nibo_movimentacoes AS
SELECT
    e.entry_id                                           AS id_movimentacao,
    e.date                                               AS data,
    e.accrual_date                                       AS data_competencia,
    CASE e.kind WHEN 'receipt' THEN 'Entrada' ELSE 'Saída' END AS tipo,
    r.valor,
    CASE e.kind WHEN 'receipt' THEN 1 ELSE -1 END * r.valor AS valor_com_sinal,
    COALESCE(ec.category_name, e.category_name)          AS categoria,
    COALESCE(c.group_name, ec.parent_name)               AS grupo_categoria,
    c.subgroup_name                                      AS subgrupo_categoria,
    c.reference_code                                     AS codigo_categoria,
    e.account_name                                       AS conta,
    e.stakeholder_name                                   AS cliente_fornecedor,
    e.description                                        AS descricao,
    e.is_reconciliated                                   AS conciliado
FROM raw.nibo_entries e
LEFT JOIN (
    SELECT x.*,
           sum(value) OVER (PARTITION BY entry_id) AS soma,
           count(*)   OVER (PARTITION BY entry_id) AS n
    FROM raw.nibo_entry_categories x
) ec ON ec.entry_id = e.entry_id
-- Em pagamentos parciais o rateio do Nibo traz o valor cheio do agendamento:
-- distribui o valor efetivamente pago proporcionalmente ao rateio.
CROSS JOIN LATERAL (SELECT round(CASE
        WHEN ec.entry_id IS NULL THEN e.value
        WHEN ec.soma <> 0        THEN e.value * ec.value / ec.soma
        ELSE e.value / ec.n END, 2) AS valor) r
LEFT JOIN raw.nibo_categories c ON c.id = COALESCE(ec.category_id, e.category_id)
WHERE NOT e.is_transfer;

CREATE OR REPLACE VIEW bi.nibo_transferencias AS
SELECT entry_id AS id_movimentacao, date AS data,
       CASE kind WHEN 'receipt' THEN 'Entrada' ELSE 'Saída' END AS tipo,
       value AS valor, account_name AS conta, identifier AS descricao
FROM raw.nibo_entries
WHERE is_transfer;

-- Contas a receber / a pagar (inclui previsões recorrentes futuras)
CREATE OR REPLACE VIEW bi.nibo_agendamentos AS
SELECT
    s.schedule_id                                        AS id_agendamento,
    CASE s.type WHEN 'Credit' THEN 'A receber' ELSE 'A pagar' END AS tipo,
    s.due_date                                           AS vencimento,
    s.accrual_date                                       AS data_competencia,
    s.value                                              AS valor,
    s.paid_value                                         AS valor_pago,
    s.open_value                                         AS valor_em_aberto,
    s.is_paid                                            AS pago,
    (NOT s.is_paid AND s.due_date < current_date)        AS atrasado,
    s.has_recurrence                                     AS recorrente,
    s.category_name                                      AS categoria,
    c.group_name                                         AS grupo_categoria,
    s.stakeholder_name                                   AS cliente_fornecedor,
    s.description                                        AS descricao
FROM raw.nibo_schedules s
LEFT JOIN raw.nibo_categories c ON c.id = s.category_id;

-- Fluxo de caixa realizado por dia
CREATE OR REPLACE VIEW bi.nibo_fluxo_diario AS
SELECT data,
       sum(valor) FILTER (WHERE tipo = 'Entrada') AS entradas,
       sum(valor) FILTER (WHERE tipo = 'Saída')   AS saidas,
       sum(valor_com_sinal)                       AS saldo_do_dia
FROM bi.nibo_movimentacoes
GROUP BY data;

CREATE OR REPLACE VIEW bi.nibo_contas AS
SELECT name AS conta, type AS tipo, bank_name AS banco,
       open_balance AS saldo_inicial, open_balance_date AS data_saldo_inicial,
       is_archived AS arquivada
FROM raw.nibo_accounts;

CREATE OR REPLACE VIEW bi.etl_status AS
SELECT DISTINCT ON (source) source AS fonte, started_at AS inicio, finished_at AS fim,
       status, row_counts AS linhas, error AS erro
FROM raw.etl_runs
ORDER BY source, started_at DESC;
