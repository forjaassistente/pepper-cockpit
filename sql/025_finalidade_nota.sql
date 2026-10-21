-- Nota que não é compra de mercadoria (finNFe 2..6: complementar, ajuste, devolução, crédito, débito de juros/multa).
-- Guarda o rótulo; null = compra normal. Esses itens não entram no estoque nem no preço dos insumos.
alter table fin_app.compras add column if not exists finalidade text;
GRANT UPDATE (finalidade) ON fin_app.compras TO fin_app_rw;
