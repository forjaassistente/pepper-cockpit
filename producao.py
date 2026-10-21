"""Fichas de produção para a equipe (qualquer login: /api/portal/*).
Quantidades, rendimento e modo de preparo de manufaturados e produtos — sem custos nem preços."""
import uuid
from typing import Literal

import os

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from fin import q

router = APIRouter(prefix="/api/portal/fichas")


@router.get("")
def lista():
    manuf = q("""select s.id, s.nome, s.unidade, s.rendimento, 'Manufaturados' as categoria, 0 as cat_ordem, s.foto_em,
                        s.modo_preparo is not null as tem_preparo,
                        (select count(*) from fin_app.ficha_itens f where f.manufaturado_id = s.id) as itens
                 from fin_app.insumos s where s.ativo and s.tipo = 'manufaturado'
                   and exists (select 1 from fin_app.ficha_itens f where f.manufaturado_id = s.id)
                 order by lower(s.nome)""")
    prod = q("""select p.id, p.nome, 'porção' as unidade, p.rendimento, coalesce(c.nome, 'Sem categoria') as categoria, p.foto_em,
                       coalesce(c.ordem, 999) as cat_ordem, p.modo_preparo is not null as tem_preparo,
                       (select count(*) from fin_app.ficha_itens f where f.produto_id = p.id) as itens
                from fin_app.produtos p left join fin_app.cat_itens c on c.id = p.categoria_id
                where p.ativo and exists (select 1 from fin_app.ficha_itens f where f.produto_id = p.id)
                order by cat_ordem, categoria, lower(p.nome)""")
    return {"manufaturados": manuf, "produtos": prod}


@router.get("/{dono}/{did}")
def ficha(dono: Literal["produto", "manufaturado"], did: uuid.UUID):
    if dono == "produto":
        d = q("""select p.id, p.nome, 'porção' as unidade, p.rendimento, p.modo_preparo, p.descricao, p.foto_em,
                        coalesce(c.nome, 'Sem categoria') as categoria
                 from fin_app.produtos p left join fin_app.cat_itens c on c.id = p.categoria_id where p.id = %s""", (did,))
    else:
        d = q("""select id, nome, unidade, rendimento, modo_preparo, observacao as descricao, foto_em, 'Manufaturados' as categoria
                 from fin_app.insumos where id = %s and tipo = 'manufaturado'""", (did,))
    if not d:
        raise HTTPException(404, "Ficha não encontrada")
    col = "produto_id" if dono == "produto" else "manufaturado_id"
    itens = q(f"""select s.id, s.nome, s.tipo, f.quantidade, f.unidade, f.perda_pct
                  from fin_app.ficha_itens f join fin_app.insumos s on s.id = f.insumo_id
                  where f.{col} = %s order by f.ordem, lower(s.nome)""", (did,))
    return {"dono": dono, **d[0], "itens": itens}


@router.get("/{dono}/{did}/foto")
def foto(dono: Literal["produto", "manufaturado"], did: uuid.UUID):
    import fichas
    caminho = fichas.caminho_foto(did)
    if not os.path.isfile(caminho):
        raise HTTPException(404, "Sem foto")
    return FileResponse(caminho, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})
