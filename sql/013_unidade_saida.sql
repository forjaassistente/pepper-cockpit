-- Unidade de saída do insumo (como ele é medido na ficha técnica), no lugar do fator de correção:
--   compra  : igual à unidade de compra
--   limpo   : kg cozido e limpo — comprar saida_base (na unidade de compra) rende saida_rende kg limpos/cozidos
--   porcoes : porções em unidade — comprar saida_base rende saida_rende porções
-- Custo por unidade de saída = preço de compra × saida_base ÷ saida_rende. Idempotente.

SET ROLE fin_app_owner;

ALTER TABLE fin_app.insumos ADD COLUMN IF NOT EXISTS saida_tipo  text NOT NULL DEFAULT 'compra';
ALTER TABLE fin_app.insumos ADD COLUMN IF NOT EXISTS saida_base  numeric(14,4);
ALTER TABLE fin_app.insumos ADD COLUMN IF NOT EXISTS saida_rende numeric(14,4);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'saida_valida') THEN
    ALTER TABLE fin_app.insumos ADD CONSTRAINT saida_valida CHECK (
      (saida_tipo = 'compra' AND saida_base IS NULL AND saida_rende IS NULL)
      OR (saida_tipo IN ('limpo', 'porcoes') AND tipo = 'insumo' AND saida_base > 0 AND saida_rende > 0));
  END IF;
  -- migra o fator de correção (só roda enquanto a coluna existir)
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'fin_app' AND table_name = 'insumos' AND column_name = 'fator_correcao') THEN
    -- comprados por unidade/pacote: o preço é do pé/pacote e o "fator" era o peso aproveitável dele
    UPDATE fin_app.insumos SET unidade = CASE WHEN observacao ILIKE '%pacote%' THEN 'pct' ELSE 'un' END,
           saida_tipo = 'limpo', saida_base = 1, saida_rende = round(1 / fator_correcao, 4)
     WHERE tipo = 'insumo' AND fator_correcao <> 1 AND unidade = 'kg'
       AND (observacao ILIKE '%/ unidade%' OR observacao ILIKE '%g unidade%' OR observacao ILIKE '%pacote%');
    -- perda na limpeza/cozimento: 1 kg comprado rende (1 ÷ fator) kg limpo
    UPDATE fin_app.insumos SET saida_tipo = 'limpo', saida_base = 1, saida_rende = round(1 / fator_correcao, 4)
     WHERE tipo = 'insumo' AND fator_correcao <> 1 AND saida_tipo = 'compra';
    ALTER TABLE fin_app.insumos DROP CONSTRAINT IF EXISTS fator_positivo;
    ALTER TABLE fin_app.insumos DROP COLUMN fator_correcao;
  END IF;
END $$;

RESET ROLE;
