-- (1) Unidades de saída do insumo além de "kg cozido e limpo" e "porções": kg, unidade e litro (ex.: 1 cx rende 12 un).
-- (2) Fechamento de caixa: forma de pagamento de cada pessoa da equipe (dinheiro da gaveta, PIX a fazer, pagar outro dia)
--     e quando foi pago. Só "dinheiro" sai da gaveta. Idempotente.
SET ROLE fin_app_owner;

ALTER TABLE fin_app.insumos DROP CONSTRAINT IF EXISTS saida_valida;
ALTER TABLE fin_app.insumos ADD CONSTRAINT saida_valida CHECK (
  (saida_tipo = 'compra' AND saida_base IS NULL AND saida_rende IS NULL)
  OR (saida_tipo IN ('limpo', 'porcoes', 'kg', 'un', 'l') AND tipo = 'insumo' AND saida_base > 0 AND saida_rende > 0));

ALTER TABLE fin_app.caixa_equipe ADD COLUMN IF NOT EXISTS forma text NOT NULL DEFAULT 'dinheiro';
ALTER TABLE fin_app.caixa_equipe ADD COLUMN IF NOT EXISTS pago_em timestamptz;
ALTER TABLE fin_app.caixa_equipe ADD COLUMN IF NOT EXISTS pago_por_nome text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'caixa_equipe_forma_valida') THEN
    ALTER TABLE fin_app.caixa_equipe ADD CONSTRAINT caixa_equipe_forma_valida CHECK (forma IN ('dinheiro', 'pix', 'pendente'));
  END IF;
END $$;

RESET ROLE;
