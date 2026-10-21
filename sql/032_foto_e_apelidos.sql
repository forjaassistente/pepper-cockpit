-- Foto da ficha de produção (o arquivo fica em ANEXOS_DIR/fichas/<id>.jpg; foto_em também serve de versão para o cache).
alter table fin_app.produtos add column if not exists foto_em timestamptz;
alter table fin_app.insumos add column if not exists foto_em timestamptz;
grant update (foto_em) on fin_app.produtos, fin_app.insumos to fin_app_rw;

-- Nomes dos relatórios de venda que não batem com o cadastro: o que cada um é (produto) ou "não é do cardápio" (ignorar).
create table if not exists fin_app.vendas_apelidos (
  nome_norm   text primary key,                 -- nome normalizado (sem acento, minúsculo)
  nome        text not null,                    -- como veio no relatório
  produto_id  uuid references fin_app.produtos (id) on delete cascade,
  ignorar     boolean not null default false,   -- ex.: "Ponto do hambúrguer", adicionais, taxa de entrega
  criado_em   timestamptz not null default now(),
  check (ignorar or produto_id is not null)
);
grant select, insert, update, delete on fin_app.vendas_apelidos to fin_app_rw;
