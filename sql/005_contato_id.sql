-- Lançamento ligado à pessoa do cadastro (fornecedor/cliente), sem nome livre. Idempotente; rodar como superusuário.
-- v_titulos ganha contato_id (Nibo: stakeholder_id, que é o mesmo id do cadastro importado) para o histórico.

SET ROLE fin_app_owner;

ALTER TABLE fin_app.lancamentos ADD COLUMN IF NOT EXISTS contato_id uuid REFERENCES fin_app.pessoas (id);
CREATE INDEX IF NOT EXISTS lancamentos_contato_idx ON fin_app.lancamentos (contato_id);

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
       CASE WHEN s.has_recurrence THEN 'mensal' END AS recorrencia,
       s.stakeholder_id AS contato_id
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
       l.data_pagamento, l.status, l.grupo_id, l.parcela, l.total_parcelas, l.recorrencia,
       l.contato_id
FROM fin_app.lancamentos l
LEFT JOIN fin_app.subcategorias sc ON sc.id = l.categoria_id
LEFT JOIN fin_app.categorias k ON k.id = sc.categoria_id
WHERE l.cancelado_em IS NULL;

RESET ROLE;
