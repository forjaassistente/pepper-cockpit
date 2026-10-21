-- Fator de correção no insumo (custo efetivo = preço de compra × fator, ex.: alface 300 g aproveitáveis por kg = 3,33),
-- rendimento em porções no produto (receita em lote, ex.: bolinho rende 9 porções) e unidade "m" (metro). Idempotente.

SET ROLE fin_app_owner;

ALTER TABLE fin_app.insumos  ADD COLUMN IF NOT EXISTS fator_correcao numeric(8,4) NOT NULL DEFAULT 1;
ALTER TABLE fin_app.produtos ADD COLUMN IF NOT EXISTS rendimento     numeric(10,3) NOT NULL DEFAULT 1;

DO $$
DECLARE r record;
BEGIN
  -- recria os checks de unidade incluindo 'm'
  FOR r IN SELECT conrelid::regclass AS tab, conname FROM pg_constraint
           WHERE conrelid IN ('fin_app.insumos'::regclass, 'fin_app.ficha_itens'::regclass)
             AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%unidade%' LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tab, r.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fator_positivo') THEN
    ALTER TABLE fin_app.insumos ADD CONSTRAINT fator_positivo CHECK (fator_correcao > 0);
    ALTER TABLE fin_app.produtos ADD CONSTRAINT rendimento_positivo CHECK (rendimento > 0);
  END IF;
END $$;
ALTER TABLE fin_app.insumos ADD CONSTRAINT insumos_unidade_check
  CHECK (unidade IN ('kg', 'g', 'l', 'ml', 'un', 'cx', 'pct', 'dz', 'fardo', 'm'));
ALTER TABLE fin_app.ficha_itens ADD CONSTRAINT ficha_itens_unidade_check
  CHECK (unidade IN ('kg', 'g', 'l', 'ml', 'un', 'cx', 'pct', 'dz', 'fardo', 'm'));

RESET ROLE;
