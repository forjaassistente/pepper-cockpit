-- Grupo do fornecedor: 'insumos' (comida, bebida, embalagem — entra na ficha técnica e na lista de compras)
-- ou 'servicos' (prestadores de serviço: sistemas, contador, aluguel, energia...). Idempotente.
-- Classificação inicial pelo histórico do Nibo: insumos quando a maior parte do que o fornecedor recebeu
-- caiu em "Fornecedores de insumos para cozinha/bar" ou "Fornecedores de embalagens".

SET ROLE fin_app_owner;

ALTER TABLE fin_app.pessoas ADD COLUMN IF NOT EXISTS tipo_fornecedor text CHECK (tipo_fornecedor IN ('insumos', 'servicos'));

RESET ROLE;   -- a classificação lê raw.* (Nibo), só leitura

WITH pag AS (
  SELECT e.stakeholder_id::text AS sid, coalesce(c.category_name, e.category_name) AS cat, abs(coalesce(c.value, e.value)) AS v
  FROM raw.nibo_entries e LEFT JOIN raw.nibo_entry_categories c ON c.entry_id = e.entry_id
  WHERE e.kind = 'payment'),
cls AS (
  SELECT p.id,
         sum(v) FILTER (WHERE cat IN ('Fornecedores de insumos para cozinha', 'Fornecedores de insumos para bar',
                                      'Fornecedores de embalagens')) AS ins,
         sum(v) AS tot
  FROM fin_app.pessoas p LEFT JOIN pag ON pag.sid = p.nibo_id::text
  WHERE 'fornecedor' = ANY (p.papeis) AND p.tipo_fornecedor IS NULL
  GROUP BY p.id)
UPDATE fin_app.pessoas p
   SET tipo_fornecedor = CASE WHEN coalesce(cls.ins, 0) > coalesce(cls.tot, 0) / 2 AND cls.ins > 0 THEN 'insumos' ELSE 'servicos' END
  FROM cls WHERE cls.id = p.id;
