-- Contagem feita no último dia do mês = inventário (conciliação e CMV). Idempotente.
SET ROLE fin_app_owner;
ALTER TABLE fin_app.estoque_contagens ADD COLUMN IF NOT EXISTS inventario boolean NOT NULL DEFAULT false;
RESET ROLE;
