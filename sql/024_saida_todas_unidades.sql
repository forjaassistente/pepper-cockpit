-- Unidade de saída do insumo: qualquer unidade de compra (kg, g, l, ml, un, cx, pct, dz, fardo, m),
-- além de "kg cozido e limpo" e "porções". Idempotente.
SET ROLE fin_app_owner;
ALTER TABLE fin_app.insumos DROP CONSTRAINT IF EXISTS saida_valida;
ALTER TABLE fin_app.insumos ADD CONSTRAINT saida_valida CHECK (
  (saida_tipo = 'compra' AND saida_base IS NULL AND saida_rende IS NULL)
  OR (saida_tipo IN ('limpo', 'porcoes', 'kg', 'g', 'l', 'ml', 'un', 'cx', 'pct', 'dz', 'fardo', 'm')
      AND tipo = 'insumo' AND saida_base > 0 AND saida_rende > 0));
RESET ROLE;
