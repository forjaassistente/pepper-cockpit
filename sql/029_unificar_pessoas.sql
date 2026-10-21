-- Unificar pessoas duplicadas (ex.: o mesmo free lance criado no Nibo e no app com nomes diferentes).
-- A duplicada não é apagada (o Nibo a recriaria na sincronização): fica inativa e aponta para a principal.
alter table fin_app.pessoas add column if not exists mesclada_em uuid references fin_app.pessoas (id);
create index if not exists pessoas_mesclada_idx on fin_app.pessoas (mesclada_em) where mesclada_em is not null;
grant update (mesclada_em) on fin_app.pessoas to fin_app_rw;

-- Lançamentos do Nibo de uma pessoa mesclada aparecem com o nome e o id da principal.
create or replace view fin_app.v_titulos as
SELECT 'nibo'::text AS origem, s.schedule_id::text AS id,
       CASE s.type WHEN 'Credit' THEN 'receber' ELSE 'pagar' END AS tipo,
       s.due_date AS vencimento, s.accrual_date AS competencia, s.due_date AS previsto_para,
       coalesce(pp.nome, s.stakeholder_name) AS contato, s.category_id AS categoria_id, s.category_name AS categoria_nome,
       k.nome AS grupo, NULL::text AS subgrupo,
       NULL::uuid AS conta_id, NULL::text AS conta_nome, s.description AS descricao,
       s.value AS valor, s.open_value AS valor_em_aberto, abs(s.paid_value) AS valor_pago, p.data_pagamento,
       CASE WHEN s.is_paid THEN 'pago' ELSE 'aberto' END AS status,
       NULL::uuid AS grupo_id, NULL::int AS parcela, NULL::int AS total_parcelas,
       CASE WHEN s.has_recurrence THEN 'mensal' END AS recorrencia,
       coalesce(pm.mesclada_em, s.stakeholder_id) AS contato_id
FROM raw.nibo_schedules s
LEFT JOIN fin_app.subcategorias sc ON sc.id = s.category_id
LEFT JOIN fin_app.categorias k ON k.id = sc.categoria_id
LEFT JOIN (SELECT schedule_id, max(date) AS data_pagamento FROM raw.nibo_entries
           WHERE schedule_id IS NOT NULL GROUP BY schedule_id) p ON p.schedule_id = s.schedule_id
LEFT JOIN fin_app.pessoas pm ON pm.id = s.stakeholder_id
LEFT JOIN fin_app.pessoas pp ON pp.id = pm.mesclada_em
UNION ALL
SELECT 'manual'::text, l.id::text, l.tipo, l.vencimento, l.competencia, coalesce(l.previsto_para, l.vencimento),
       l.contato, l.categoria_id, l.categoria_nome, k.nome, NULL::text, l.conta_id, l.conta_nome, l.descricao, l.valor,
       CASE l.status WHEN 'aberto' THEN l.valor ELSE 0 END,
       CASE l.status WHEN 'pago' THEN l.valor_pago ELSE 0 END,
       l.data_pagamento, l.status, l.grupo_id, l.parcela, l.total_parcelas, l.recorrencia, l.contato_id
FROM fin_app.lancamentos l
LEFT JOIN fin_app.subcategorias sc ON sc.id = l.categoria_id
LEFT JOIN fin_app.categorias k ON k.id = sc.categoria_id
WHERE l.cancelado_em IS NULL;
