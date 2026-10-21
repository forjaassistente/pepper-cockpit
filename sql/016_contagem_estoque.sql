-- Contagem de estoque (etapa 1): habilitação de estoque por setor no login, frequência/setor/local da contagem
-- em cada insumo, e as contagens (cegas) feitas pelo portal. Idempotente.

SET ROLE fin_app_owner;

-- quem pode contar: setores habilitados no login (independe do perfil, que controla o fechamento de caixa)
ALTER TABLE fin_app.usuarios ADD COLUMN IF NOT EXISTS estoque_setores text[] NOT NULL DEFAULT '{}';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'estoque_setores_validos') THEN
    ALTER TABLE fin_app.usuarios ADD CONSTRAINT estoque_setores_validos CHECK (estoque_setores <@ ARRAY['salao', 'cozinha']::text[]);
  END IF;
END $$;

-- o que contar e quando
ALTER TABLE fin_app.insumos ADD COLUMN IF NOT EXISTS contagem_freq  text;   -- null = não conta
ALTER TABLE fin_app.insumos ADD COLUMN IF NOT EXISTS contagem_setor text;
ALTER TABLE fin_app.insumos ADD COLUMN IF NOT EXISTS contagem_local text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contagem_valida') THEN
    ALTER TABLE fin_app.insumos ADD CONSTRAINT contagem_valida CHECK (
      (contagem_freq IS NULL OR contagem_freq IN ('2x_semana', 'semanal', 'quinzenal', 'mensal'))
      AND (contagem_setor IS NULL OR contagem_setor IN ('salao', 'cozinha'))
      AND (contagem_freq IS NULL OR contagem_setor IS NOT NULL));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS fin_app.estoque_contagens (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    setor          text NOT NULL CHECK (setor IN ('salao', 'cozinha')),
    status         text NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta', 'finalizada')),
    iniciada_em    timestamptz NOT NULL DEFAULT now(),
    finalizada_em  timestamptz,
    usuario_id     uuid REFERENCES fin_app.usuarios (id),
    usuario_nome   text,
    observacao     text
);
-- uma contagem aberta por setor de cada vez
CREATE UNIQUE INDEX IF NOT EXISTS estoque_contagem_aberta_idx ON fin_app.estoque_contagens (setor) WHERE status = 'aberta';

-- itens da contagem: entram com quantidade nula (lista do dia) e são preenchidos item a item
CREATE TABLE IF NOT EXISTS fin_app.estoque_contagem_itens (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    contagem_id  uuid NOT NULL REFERENCES fin_app.estoque_contagens (id) ON DELETE CASCADE,
    insumo_id    uuid NOT NULL REFERENCES fin_app.insumos (id),
    previsto     boolean NOT NULL DEFAULT true,     -- false = item acrescentado fora da lista do dia
    quantidade   numeric(14,3) CHECK (quantidade >= 0),
    unidade      text NOT NULL,
    contado_em   timestamptz,
    contado_por  uuid REFERENCES fin_app.usuarios (id),
    UNIQUE (contagem_id, insumo_id)
);
CREATE INDEX IF NOT EXISTS estoque_itens_insumo_idx ON fin_app.estoque_contagem_itens (insumo_id);

RESET ROLE;

GRANT SELECT, INSERT, UPDATE, DELETE ON fin_app.estoque_contagens, fin_app.estoque_contagem_itens TO fin_app_rw;
