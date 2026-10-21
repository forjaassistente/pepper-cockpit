-- Anexos (boletos em PDF/foto) dos lançamentos manuais. Idempotente; rodar como superusuário.
-- O arquivo fica em disco no VPS (/opt/pepper-bi/anexos/<id>/); aqui ficam os metadados e a leitura.

SET ROLE fin_app_owner;

CREATE TABLE IF NOT EXISTS fin_app.anexos (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lancamento_id  uuid,                 -- preenchido ao salvar o lançamento (1ª ocorrência)
    grupo_id       uuid,                 -- série de parcelas/recorrência, se houver
    nome           text NOT NULL,        -- nome original do arquivo (só exibição)
    mime           text NOT NULL,
    tamanho        int  NOT NULL,
    sha256         text NOT NULL,
    paginas        int  NOT NULL,
    extracao       jsonb NOT NULL,       -- palavras com posição, linha digitável, sugestão da IA
    criado_em      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS anexos_lanc_idx ON fin_app.anexos (lancamento_id);
CREATE INDEX IF NOT EXISTS anexos_grupo_idx ON fin_app.anexos (grupo_id);

RESET ROLE;

GRANT SELECT, INSERT ON fin_app.anexos TO fin_app_rw;
GRANT UPDATE (lancamento_id, grupo_id) ON fin_app.anexos TO fin_app_rw;
