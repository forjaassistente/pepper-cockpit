-- Cadastros de cardápio e estoque: insumos (com categoria), insumos manufaturados (sem categoria)
-- e produtos finais (com categoria). Base para ficha técnica e CMV. Idempotente; rodar como superusuário.

SET ROLE fin_app_owner;

CREATE TABLE IF NOT EXISTS fin_app.cat_itens (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    grupo      text NOT NULL CHECK (grupo IN ('insumo', 'produto')),
    nome       text NOT NULL,
    ordem      int  NOT NULL DEFAULT 100,
    ativo      boolean NOT NULL DEFAULT true,
    criado_em  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (grupo, nome)
);

INSERT INTO fin_app.cat_itens (grupo, nome, ordem) VALUES
    ('insumo', 'Hortifruti', 10), ('insumo', 'Proteínas', 20), ('insumo', 'Laticínios', 30),
    ('insumo', 'Mercearia e secos', 40), ('insumo', 'Molhos e temperos', 50), ('insumo', 'Bebidas', 60),
    ('insumo', 'Embalagens', 70), ('insumo', 'Limpeza e descartáveis', 80),
    ('produto', 'Hambúrguer', 10), ('produto', 'Petiscos e porções', 20), ('produto', 'Bebidas', 30),
    ('produto', 'Sobremesas', 40)
ON CONFLICT (grupo, nome) DO NOTHING;

-- Insumos comprados e insumos manufaturados (produzidos na casa) na mesma tabela, separados por tipo.
CREATE TABLE IF NOT EXISTS fin_app.insumos (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tipo              text NOT NULL CHECK (tipo IN ('insumo', 'manufaturado')),
    nome              text NOT NULL,
    categoria_id      uuid REFERENCES fin_app.cat_itens (id),
    unidade           text NOT NULL DEFAULT 'kg' CHECK (unidade IN ('kg', 'g', 'l', 'ml', 'un', 'cx', 'pct', 'dz', 'fardo')),
    custo_unitario    numeric(14,4),
    rendimento        numeric(14,3),          -- manufaturado: quanto rende uma receita (na unidade acima)
    estoque_minimo    numeric(14,3),
    fornecedor_id     uuid REFERENCES fin_app.pessoas (id),
    codigo            text,
    observacao        text,
    ativo             boolean NOT NULL DEFAULT true,
    criado_em         timestamptz NOT NULL DEFAULT now(),
    atualizado_em     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT manufaturado_sem_categoria CHECK (tipo = 'insumo' OR categoria_id IS NULL),
    UNIQUE (tipo, nome)
);

CREATE TABLE IF NOT EXISTS fin_app.produtos (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    nome           text NOT NULL UNIQUE,
    categoria_id   uuid REFERENCES fin_app.cat_itens (id),
    preco_venda    numeric(14,2),
    codigo_pdv     text,
    canais         text[] NOT NULL DEFAULT ARRAY['Salão', 'Delivery'],
    descricao      text,
    ativo          boolean NOT NULL DEFAULT true,
    criado_em      timestamptz NOT NULL DEFAULT now(),
    atualizado_em  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT canais_validos CHECK (canais <@ ARRAY['Salão', 'Delivery']::text[])
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['insumos', 'produtos'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_atualizado_em ON fin_app.%I', t, t);
    EXECUTE format('CREATE TRIGGER %I_atualizado_em BEFORE UPDATE ON fin_app.%I
                    FOR EACH ROW EXECUTE FUNCTION fin_app.tg_atualizado_em_cad()', t, t);
  END LOOP;
END $$;

RESET ROLE;

GRANT SELECT, INSERT, UPDATE ON fin_app.cat_itens, fin_app.insumos, fin_app.produtos TO fin_app_rw;
