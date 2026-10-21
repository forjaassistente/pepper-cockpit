-- Centrais de estoque (cadastro de cada empresa: Estoque Grande, Bar, Câmara fria...). Um item pode ficar em várias
-- centrais; na contagem ele é contado em cada uma e o estoque do item é a soma. Substitui insumos.contagem_local. Idempotente.

SET ROLE fin_app_owner;

CREATE TABLE IF NOT EXISTS fin_app.estoque_centrais (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    nome       text NOT NULL UNIQUE,
    ordem      int  NOT NULL DEFAULT 100,
    ativo      boolean NOT NULL DEFAULT true,
    criado_em  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fin_app.insumo_centrais (
    insumo_id   uuid NOT NULL REFERENCES fin_app.insumos (id) ON DELETE CASCADE,
    central_id  uuid NOT NULL REFERENCES fin_app.estoque_centrais (id) ON DELETE CASCADE,
    PRIMARY KEY (insumo_id, central_id)
);

-- migra o local de texto para o cadastro de centrais
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'fin_app' AND table_name = 'insumos' AND column_name = 'contagem_local') THEN
    INSERT INTO fin_app.estoque_centrais (nome, ordem)
      SELECT l, CASE l WHEN 'Estoque Grande' THEN 10 WHEN 'Estoque Pequeno' THEN 20 WHEN 'Cozinha' THEN 30 WHEN 'Bar' THEN 40 ELSE 100 END
      FROM (SELECT DISTINCT trim(contagem_local) AS l FROM fin_app.insumos WHERE nullif(trim(contagem_local), '') IS NOT NULL) x
      ON CONFLICT (nome) DO NOTHING;
    INSERT INTO fin_app.insumo_centrais (insumo_id, central_id)
      SELECT s.id, c.id FROM fin_app.insumos s JOIN fin_app.estoque_centrais c ON c.nome = trim(s.contagem_local)
      ON CONFLICT DO NOTHING;
    ALTER TABLE fin_app.insumos DROP COLUMN contagem_local;
  END IF;
END $$;

-- contagem: uma linha por item e central
ALTER TABLE fin_app.estoque_contagem_itens ADD COLUMN IF NOT EXISTS central_id uuid REFERENCES fin_app.estoque_centrais (id);
ALTER TABLE fin_app.estoque_contagem_itens DROP CONSTRAINT IF EXISTS estoque_contagem_itens_contagem_id_insumo_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS contagem_item_central_idx ON fin_app.estoque_contagem_itens
  (contagem_id, insumo_id, coalesce(central_id, '00000000-0000-0000-0000-000000000000'::uuid));

RESET ROLE;

GRANT SELECT, INSERT, UPDATE ON fin_app.estoque_centrais TO fin_app_rw;
GRANT SELECT, INSERT, DELETE ON fin_app.insumo_centrais TO fin_app_rw;
