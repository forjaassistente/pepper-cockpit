-- Extrato por conta (Nibo + pagamentos do app + transferências do app) e transferências entre contas.
-- Idempotente; rodar como superusuário. O saldo das contas (v_contas) passa a sair do mesmo extrato,
-- então saldo e extrato sempre batem.

SET ROLE fin_app_owner;

CREATE TABLE IF NOT EXISTS fin_app.transferencias (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    data              date NOT NULL,
    conta_origem_id   uuid NOT NULL REFERENCES fin_app.contas_bancarias (id),
    conta_destino_id  uuid NOT NULL REFERENCES fin_app.contas_bancarias (id),
    valor             numeric(14,2) NOT NULL CHECK (valor > 0),
    descricao         text,
    cancelado_em      timestamptz,
    criado_em         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT contas_diferentes CHECK (conta_origem_id <> conta_destino_id)
);
CREATE INDEX IF NOT EXISTS transferencias_data_idx ON fin_app.transferencias (data);

-- Uma linha por movimento realizado, com sinal (+ entrada, − saída).
CREATE OR REPLACE VIEW fin_app.v_extrato AS
SELECT 'nibo'::text AS origem, e.entry_id::text AS id, e.account_id AS conta_id, e.date AS data,
       CASE WHEN e.is_transfer THEN NULL ELSE e.stakeholder_name END AS nome,
       coalesce(nullif(e.description, ''), e.identifier) AS descricao,
       e.category_name AS categoria,
       CASE e.kind WHEN 'receipt' THEN e.value ELSE -e.value END AS valor,
       e.is_transfer AS transferencia, NULL::uuid AS lancamento_id, NULL::uuid AS transferencia_id
FROM raw.nibo_entries e
UNION ALL
SELECT 'manual', l.id::text, l.conta_id, l.data_pagamento, l.contato, l.descricao, l.categoria_nome,
       CASE l.tipo WHEN 'receber' THEN l.valor_pago ELSE -l.valor_pago END,
       false, l.id, NULL
FROM fin_app.lancamentos l
WHERE l.status = 'pago' AND l.cancelado_em IS NULL AND l.conta_id IS NOT NULL
UNION ALL
SELECT 'transferencia', t.id::text || ':s', t.conta_origem_id, t.data, NULL,
       coalesce(t.descricao, 'Transferência de ' || o.nome || ' para ' || d.nome), NULL, -t.valor, true, NULL, t.id
FROM fin_app.transferencias t
JOIN fin_app.contas_bancarias o ON o.id = t.conta_origem_id JOIN fin_app.contas_bancarias d ON d.id = t.conta_destino_id
WHERE t.cancelado_em IS NULL
UNION ALL
SELECT 'transferencia', t.id::text || ':e', t.conta_destino_id, t.data, NULL,
       coalesce(t.descricao, 'Transferência de ' || o.nome || ' para ' || d.nome), NULL, t.valor, true, NULL, t.id
FROM fin_app.transferencias t
JOIN fin_app.contas_bancarias o ON o.id = t.conta_origem_id JOIN fin_app.contas_bancarias d ON d.id = t.conta_destino_id
WHERE t.cancelado_em IS NULL;

CREATE OR REPLACE VIEW fin_app.v_contas AS
SELECT a.id, a.nome AS conta, a.tipo, a.banco,
       a.saldo_inicial, a.data_saldo_inicial,
       COALESCE(x.nibo, 0)::numeric AS movimentacoes_nibo,
       (a.saldo_inicial + COALESCE(x.nibo, 0))::numeric AS saldo_nibo,
       COALESCE(x.app, 0)::numeric AS ajuste_manual,
       (a.saldo_inicial + COALESCE(x.nibo, 0) + COALESCE(x.app, 0))::numeric AS saldo_atual,
       x.ultima_mov,
       a.ativo, a.finalidade, a.nibo_id, a.ordem
FROM fin_app.contas_bancarias a
LEFT JOIN (
    SELECT conta_id,
           sum(valor) FILTER (WHERE origem = 'nibo') AS nibo,
           sum(valor) FILTER (WHERE origem <> 'nibo') AS app,
           max(data) AS ultima_mov
    FROM fin_app.v_extrato GROUP BY conta_id
) x ON x.conta_id = a.id
WHERE a.ativo;

RESET ROLE;

GRANT SELECT, INSERT ON fin_app.transferencias TO fin_app_rw;
GRANT UPDATE (cancelado_em) ON fin_app.transferencias TO fin_app_rw;
GRANT SELECT ON fin_app.v_extrato TO fin_app_rw;
