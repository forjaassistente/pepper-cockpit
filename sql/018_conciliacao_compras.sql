-- Conciliação de notas (etapa 2): itens da compra ligados a insumos, vínculos aprendidos por fornecedor,
-- entradas de estoque e histórico de preços (o insumo guarda o último preço pago). Idempotente.

SET ROLE fin_app_owner;

ALTER TABLE fin_app.compras ADD COLUMN IF NOT EXISTS origem text NOT NULL DEFAULT 'nfe_xml';   -- nfe_xml | foto | manual
ALTER TABLE fin_app.compras ADD COLUMN IF NOT EXISTS conciliada_em timestamptz;

ALTER TABLE fin_app.compras_itens ADD COLUMN IF NOT EXISTS insumo_id uuid REFERENCES fin_app.insumos (id);
ALTER TABLE fin_app.compras_itens ADD COLUMN IF NOT EXISTS fator numeric(14,6) CHECK (fator > 0);      -- unid. de compra do insumo por 1 unid. da nota
ALTER TABLE fin_app.compras_itens ADD COLUMN IF NOT EXISTS ignorado boolean NOT NULL DEFAULT false;   -- não é insumo (frete, uso e consumo...)

-- o que o sistema aprendeu: este produto deste fornecedor é este insumo, com esta conversão
CREATE TABLE IF NOT EXISTS fin_app.insumo_vinculos (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    emitente_cnpj   text,
    codigo          text,          -- código do produto no fornecedor (cProd)
    ean             text,          -- código de barras
    descricao_norm  text,          -- descrição normalizada (para notas sem código)
    unidade_nota    text,
    insumo_id       uuid REFERENCES fin_app.insumos (id) ON DELETE CASCADE,
    fator           numeric(14,6) CHECK (fator > 0),
    ignorar         boolean NOT NULL DEFAULT false,
    usos            int NOT NULL DEFAULT 1,
    criado_em       timestamptz NOT NULL DEFAULT now(),
    atualizado_em   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT vinculo_destino CHECK (ignorar OR (insumo_id IS NOT NULL AND fator IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS vinculo_cod_idx  ON fin_app.insumo_vinculos (emitente_cnpj, codigo) WHERE codigo IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS vinculo_desc_idx ON fin_app.insumo_vinculos (emitente_cnpj, descricao_norm) WHERE codigo IS NULL;
CREATE INDEX IF NOT EXISTS vinculo_ean_idx ON fin_app.insumo_vinculos (ean) WHERE ean IS NOT NULL;

-- entradas de estoque (na unidade de compra do insumo, a mesma da contagem)
CREATE TABLE IF NOT EXISTS fin_app.estoque_entradas (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    insumo_id       uuid NOT NULL REFERENCES fin_app.insumos (id) ON DELETE CASCADE,
    data            date NOT NULL,
    quantidade      numeric(14,3) NOT NULL CHECK (quantidade > 0),
    custo_unitario  numeric(14,4),
    compra_id       uuid NOT NULL REFERENCES fin_app.compras (id) ON DELETE CASCADE,
    compra_n        int NOT NULL,
    criado_em       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (compra_id, compra_n)
);
CREATE INDEX IF NOT EXISTS entradas_insumo_idx ON fin_app.estoque_entradas (insumo_id, data);

-- histórico de preços pagos (por unidade de compra do insumo)
CREATE TABLE IF NOT EXISTS fin_app.insumo_precos (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    insumo_id       uuid NOT NULL REFERENCES fin_app.insumos (id) ON DELETE CASCADE,
    data            date NOT NULL,
    preco           numeric(14,4) NOT NULL CHECK (preco >= 0),
    fornecedor      text,
    compra_id       uuid NOT NULL REFERENCES fin_app.compras (id) ON DELETE CASCADE,
    compra_n        int NOT NULL,
    criado_em       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (compra_id, compra_n)
);
CREATE INDEX IF NOT EXISTS precos_insumo_idx ON fin_app.insumo_precos (insumo_id, data DESC, criado_em DESC);

RESET ROLE;

GRANT UPDATE (pessoa_id, origem, conciliada_em, chave, numero, serie, emissao, emitente_cnpj, emitente_nome,
              valor_produtos, valor_frete, valor_desconto, valor_total) ON fin_app.compras TO fin_app_rw;
GRANT UPDATE (insumo_id, fator, ignorado, descricao, quantidade, unidade, valor_unitario, valor_total, codigo) ON fin_app.compras_itens TO fin_app_rw;
GRANT DELETE ON fin_app.compras_itens TO fin_app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON fin_app.insumo_vinculos, fin_app.estoque_entradas, fin_app.insumo_precos TO fin_app_rw;
