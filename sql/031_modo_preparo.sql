-- Modo de preparo da ficha técnica (manufaturado e produto), para a ficha de produção da equipe.
alter table fin_app.insumos add column if not exists modo_preparo text;
alter table fin_app.produtos add column if not exists modo_preparo text;
grant update (modo_preparo) on fin_app.insumos, fin_app.produtos to fin_app_rw;
