-- Cadastro do restaurante (uma linha): nome que aparece no app, dados fiscais, contato, endereço e logo. Idempotente.
SET ROLE fin_app_owner;

CREATE TABLE IF NOT EXISTS fin_app.empresa (
    id                  int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    nome_fantasia       text NOT NULL,
    razao_social        text,
    cnpj                text,
    inscricao_estadual  text,
    segmento            text,
    telefone            text,
    whatsapp            text,
    email               text,
    instagram           text,
    site                text,
    cep                 text,
    logradouro          text,
    numero              text,
    complemento         text,
    bairro              text,
    cidade              text,
    uf                  text CHECK (uf IS NULL OR uf ~ '^[A-Z]{2}$'),
    logo                text,           -- arquivo em ANEXOS_DIR/empresa
    atualizado_em       timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fin_app.empresa (nome_fantasia, segmento, telefone, whatsapp, cidade, uf)
VALUES ('Pepper Sally', 'Hamburgueria e petiscaria', '49999667096', '49999667096', 'Joaçaba', 'SC')
ON CONFLICT (id) DO NOTHING;

RESET ROLE;
GRANT SELECT, UPDATE ON fin_app.empresa TO fin_app_rw;
