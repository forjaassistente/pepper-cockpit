-- Ficha técnica: quanto de cada insumo (ou manufaturado) vai em 1 unidade de um produto final,
-- ou na receita de um insumo manufaturado (que rende fin_app.insumos.rendimento). Idempotente.

SET ROLE fin_app_owner;

CREATE TABLE IF NOT EXISTS fin_app.ficha_itens (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    produto_id       uuid REFERENCES fin_app.produtos (id) ON DELETE CASCADE,
    manufaturado_id  uuid REFERENCES fin_app.insumos (id) ON DELETE CASCADE,
    insumo_id        uuid NOT NULL REFERENCES fin_app.insumos (id),
    quantidade       numeric(14,4) NOT NULL CHECK (quantidade > 0),
    unidade          text NOT NULL CHECK (unidade IN ('kg', 'g', 'l', 'ml', 'un', 'cx', 'pct', 'dz', 'fardo')),
    perda_pct        numeric(5,2) NOT NULL DEFAULT 0 CHECK (perda_pct >= 0 AND perda_pct < 100),
    ordem            int NOT NULL DEFAULT 0,
    CONSTRAINT um_dono CHECK ((produto_id IS NULL) <> (manufaturado_id IS NULL)),
    CONSTRAINT nao_usa_a_si_mesmo CHECK (manufaturado_id IS NULL OR manufaturado_id <> insumo_id)
);
CREATE INDEX IF NOT EXISTS ficha_produto_idx ON fin_app.ficha_itens (produto_id);
CREATE INDEX IF NOT EXISTS ficha_manuf_idx ON fin_app.ficha_itens (manufaturado_id);

RESET ROLE;

GRANT SELECT, INSERT, UPDATE, DELETE ON fin_app.ficha_itens TO fin_app_rw;
