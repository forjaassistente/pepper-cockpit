-- Engenharia de cardápio e precificação: parâmetros de custo (% sobre a venda), preço no app e lucro desejado
-- por produto, e vendas mensais por produto (popularidade). Idempotente; rodar como superusuário.

SET ROLE fin_app_owner;

CREATE TABLE IF NOT EXISTS fin_app.cardapio_param (
    id                 int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    cartao_pct         numeric(5,2) NOT NULL DEFAULT 3    CHECK (cartao_pct BETWEEN 0 AND 100),
    imposto_pct        numeric(5,2) NOT NULL DEFAULT 8    CHECK (imposto_pct BETWEEN 0 AND 100),
    custo_fixo_pct     numeric(5,2) NOT NULL DEFAULT 40.9 CHECK (custo_fixo_pct BETWEEN 0 AND 100),
    lucro_desejado_pct numeric(5,2) NOT NULL DEFAULT 20   CHECK (lucro_desejado_pct BETWEEN 0 AND 100),
    taxa_app_pct       numeric(5,2) NOT NULL DEFAULT 12   CHECK (taxa_app_pct BETWEEN 0 AND 100),
    atualizado_em      timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fin_app.cardapio_param (id) VALUES (1) ON CONFLICT DO NOTHING;

ALTER TABLE fin_app.produtos ADD COLUMN IF NOT EXISTS preco_app numeric(14,2) CHECK (preco_app >= 0);
ALTER TABLE fin_app.produtos ADD COLUMN IF NOT EXISTS lucro_desejado_pct numeric(5,2) CHECK (lucro_desejado_pct BETWEEN 0 AND 100);

CREATE TABLE IF NOT EXISTS fin_app.vendas_produtos (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    produto_id     uuid NOT NULL REFERENCES fin_app.produtos (id) ON DELETE CASCADE,
    mes            date NOT NULL CHECK (extract(day from mes) = 1),
    quantidade     numeric(12,2) NOT NULL CHECK (quantidade >= 0),
    origem         text NOT NULL DEFAULT 'manual',
    atualizado_em  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (produto_id, mes)
);
CREATE INDEX IF NOT EXISTS vendas_produtos_mes_idx ON fin_app.vendas_produtos (mes);

RESET ROLE;

GRANT SELECT, UPDATE ON fin_app.cardapio_param TO fin_app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON fin_app.vendas_produtos TO fin_app_rw;
