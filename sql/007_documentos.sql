-- Caixa de entrada: documentos recebidos (upload, e depois Drive/WhatsApp/e-mail) e
-- compras lidas de NF-e (cabeçalho + itens), base do CMV. Idempotente; rodar como superusuário.

SET ROLE fin_app_owner;

CREATE TABLE IF NOT EXISTS fin_app.documentos (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    origem          text NOT NULL DEFAULT 'upload' CHECK (origem IN ('upload', 'drive', 'whatsapp', 'email')),
    origem_ref      text,                 -- id do arquivo/mensagem no canal de origem
    nome            text NOT NULL,
    mime            text NOT NULL,
    tamanho         int  NOT NULL,
    sha256          text NOT NULL UNIQUE, -- o mesmo arquivo não entra duas vezes
    tipo            text CHECK (tipo IN ('boleto', 'nota_fiscal', 'relatorio_vendas', 'outro')),
    subtipo         text,                 -- nfe_xml, nfe_pdf, anota_ai, sischef, aiqfome...
    status          text NOT NULL DEFAULT 'novo' CHECK (status IN ('novo', 'processado', 'arquivado')),
    resumo          text,                 -- uma linha para a lista (ex.: "NF 123 · FORNECEDOR · R$ 1.234,56")
    dados           jsonb NOT NULL DEFAULT '{}',
    lancamento_ids  uuid[] NOT NULL DEFAULT '{}',
    recebido_em     timestamptz NOT NULL DEFAULT now(),
    processado_em   timestamptz,
    UNIQUE (origem, origem_ref)
);
CREATE INDEX IF NOT EXISTS documentos_status_idx ON fin_app.documentos (status, recebido_em DESC);

CREATE TABLE IF NOT EXISTS fin_app.compras (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    documento_id    uuid REFERENCES fin_app.documentos (id),
    chave           text UNIQUE,          -- chave de acesso da NF-e (44 dígitos)
    numero          text,
    serie           text,
    emissao         date,
    emitente_cnpj   text,
    emitente_nome   text,
    pessoa_id       uuid REFERENCES fin_app.pessoas (id),
    valor_produtos  numeric(14,2),
    valor_frete     numeric(14,2),
    valor_desconto  numeric(14,2),
    valor_total     numeric(14,2),
    criado_em       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fin_app.compras_itens (
    compra_id       uuid NOT NULL REFERENCES fin_app.compras (id) ON DELETE CASCADE,
    n               int  NOT NULL,
    codigo          text,
    ean             text,
    descricao       text NOT NULL,
    ncm             text,
    cfop            text,
    unidade         text,
    quantidade      numeric(15,4),
    valor_unitario  numeric(18,6),
    valor_total     numeric(14,2),
    PRIMARY KEY (compra_id, n)
);

ALTER TABLE fin_app.anexos ADD COLUMN IF NOT EXISTS documento_id uuid REFERENCES fin_app.documentos (id);

RESET ROLE;

GRANT SELECT, INSERT ON fin_app.documentos, fin_app.compras, fin_app.compras_itens TO fin_app_rw;
GRANT UPDATE (tipo, subtipo, status, resumo, dados, lancamento_ids, processado_em) ON fin_app.documentos TO fin_app_rw;
GRANT UPDATE (pessoa_id) ON fin_app.compras TO fin_app_rw;
