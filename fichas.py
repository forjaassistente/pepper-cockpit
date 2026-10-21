"""Ficha técnica e CMV teórico.

- Produto final: insumos/manufaturados usados em 1 unidade vendida → custo, CMV % (custo ÷ preço) e margem.
- Manufaturado: receita + rendimento → custo por unidade = custo da receita ÷ rendimento.
  Manufaturado sem ficha usa o custo digitado no cadastro.
- Insumo é medido na ficha pela unidade de SAÍDA: igual à compra, kg cozido e limpo, porções (un) ou uma conversão
  de embalagem para qualquer unidade de compra (ex.: 1 cx rende 12 un, 1 fardo rende 12 l).
  Custo por unidade de saída = preço de compra × quantidade comprada ÷ quanto rende.
- Quantidade pode estar em g/ml com o insumo em kg/l (convertido). Perda % encarece a linha.
"""
import uuid
from decimal import Decimal
from typing import Literal

import psycopg
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from fin import DSN, q

router = APIRouter(prefix="/api/fichas")
FATOR = {("kg", "g"): 1000, ("l", "ml"): 1000, ("dz", "un"): 12}


def converter(qtd: float, de: str, para: str) -> float | None:
    """Converte qtd da unidade `de` para a unidade `para` (a do insumo). None se incompatível."""
    if de == para:
        return qtd
    if (para, de) in FATOR:            # ex.: 150 g → 0,150 kg
        return qtd / FATOR[(para, de)]
    if (de, para) in FATOR:            # ex.: 0,2 kg → 200 g
        return qtd * FATOR[(de, para)]
    return None


def unidade_saida(ins: dict) -> str:
    t = ins.get("saida_tipo") or "compra"
    return {"limpo": "kg", "porcoes": "un"}.get(t, ins["unidade"] if t == "compra" else t)   # demais: a própria unidade


def compativeis(unidade: str) -> list[str]:
    return [unidade] + [b if a == unidade else a for a, b in FATOR if unidade in (a, b)]


class Motor:
    """Carrega insumos e fichas uma vez e calcula custos (com memória e proteção contra ciclo)."""

    def __init__(self):
        self.insumos = {i["id"]: i for i in q("""select i.id, i.tipo, i.nome, i.unidade, i.custo_unitario, i.saida_tipo, i.saida_base, i.saida_rende, i.rendimento,
                                                         i.ativo, c.nome as categoria
                                                  from fin_app.insumos i left join fin_app.cat_itens c on c.id = i.categoria_id""")}
        for i in self.insumos.values():
            i["unidade_saida"] = unidade_saida(i)
        self.itens = q("select * from fin_app.ficha_itens order by ordem")
        self._cache, self._calculando = {}, set()

    def itens_de(self, dono: str, did: str):
        chave = "produto_id" if dono == "produto" else "manufaturado_id"
        return [i for i in self.itens if i[chave] == did]

    def linhas(self, dono: str, did: str):
        out = []
        for it in self.itens_de(dono, did):
            ins = self.insumos.get(it["insumo_id"])
            custo_un, alerta = self.custo_unitario(it["insumo_id"])
            qtd_conv = converter(float(it["quantidade"]), it["unidade"], ins["unidade_saida"]) if ins else None
            custo = None
            if qtd_conv is None and ins:
                alerta = f"unidade {it['unidade']} não converte para {ins['unidade_saida']}"
            elif custo_un is not None and qtd_conv is not None:
                custo = qtd_conv * custo_un * (1 + float(it["perda_pct"]) / 100)
            out.append({"id": it["id"], "insumo_id": it["insumo_id"], "nome": ins["nome"] if ins else "?",
                        "tipo": ins["tipo"] if ins else None, "unidade_insumo": ins["unidade_saida"] if ins else None,
                        "quantidade": float(it["quantidade"]), "unidade": it["unidade"], "perda_pct": float(it["perda_pct"]),
                        "custo_unitario": custo_un, "custo": custo, "alerta": alerta})
        return out

    def custo_unitario(self, iid: str):
        """(custo por unidade do insumo, alerta)."""
        if iid in self._cache:
            return self._cache[iid]
        ins = self.insumos.get(iid)
        if not ins:
            return None, "insumo não encontrado"
        fator = float(ins["saida_base"]) / float(ins["saida_rende"]) if ins["saida_tipo"] not in (None, "compra") else 1.0
        res = (float(ins["custo_unitario"]) * fator if ins["custo_unitario"] is not None else None,
               None if ins["custo_unitario"] is not None else "sem custo cadastrado")
        if ins["tipo"] == "manufaturado" and self.itens_de("manufaturado", iid):
            if iid in self._calculando:
                return None, "receita circular (um manufaturado usa o outro)"
            self._calculando.add(iid)
            ls = self.linhas("manufaturado", iid)
            self._calculando.discard(iid)
            total = sum(l["custo"] or 0 for l in ls)
            incompleto = any(l["custo"] is None for l in ls)
            rend = float(ins["rendimento"] or 0)
            if rend <= 0:
                res = (None, "informe o rendimento do manufaturado")
            else:
                res = (total / rend, "receita com itens sem custo" if incompleto else None)
        self._cache[iid] = res
        return res

    def resumo(self, dono: str, did: str, preco=None, porcoes=1):
        """Produto: custo de 1 porção = custo da receita ÷ porções (receita em lote)."""
        ls = self.linhas(dono, did)
        receita = sum(l["custo"] or 0 for l in ls)
        custo = round(receita / float(porcoes or 1), 2)
        incompleta = any(l["custo"] is None for l in ls)
        out = {"linhas": ls, "custo_receita": round(receita, 2), "custo_total": custo, "incompleta": incompleta, "itens": len(ls),
               "custo_exato": receita / float(porcoes or 1)}   # sem arredondar, para a precificação
        if dono == "produto" and preco:
            out["cmv_pct"] = round(custo / float(preco) * 100, 1)
            out["margem"] = round(float(preco) - custo, 2)
        return out


@router.get("")
def visao_geral():
    m = Motor()
    produtos = q("""select p.id, p.nome, p.preco_venda, p.rendimento, p.ativo, c.nome as categoria, c.ordem
                    from fin_app.produtos p left join fin_app.cat_itens c on c.id = p.categoria_id
                    order by not p.ativo, c.ordem nulls last, c.nome, lower(p.nome)""")
    for p in produtos:
        r = m.resumo("produto", p["id"], p["preco_venda"], p["rendimento"])
        p.update({k: r.get(k) for k in ("custo_total", "cmv_pct", "margem", "itens", "incompleta")})
    manufs = [i for i in m.insumos.values() if i["tipo"] == "manufaturado"]
    for i in manufs:
        i["custo_calculado"], i["alerta"] = m.custo_unitario(i["id"])
        i["itens"] = len(m.itens_de("manufaturado", i["id"]))
    insumos = sorted(({"id": i["id"], "nome": i["nome"], "tipo": i["tipo"], "unidade": i["unidade_saida"], "categoria": i["categoria"],
                       "custo_unitario": m.custo_unitario(i["id"])[0], "compativeis": compativeis(i["unidade_saida"])}
                      for i in m.insumos.values() if i["ativo"]), key=lambda x: (x["tipo"] != "insumo", x["categoria"] or "", x["nome"].lower()))
    com_cmv = [p for p in produtos if p["ativo"] and p.get("cmv_pct") is not None]
    return {"produtos": produtos, "manufaturados": sorted(manufs, key=lambda x: x["nome"].lower()), "insumos": insumos,
            "cmv_medio": round(sum(p["cmv_pct"] for p in com_cmv) / len(com_cmv), 1) if com_cmv else None}


@router.get("/{dono}/{did}")
def ficha(dono: Literal["produto", "manufaturado"], did: uuid.UUID):
    m = Motor()
    if dono == "produto":
        p = q("select id, nome, preco_venda, rendimento, modo_preparo from fin_app.produtos where id = %s", (did,))
        if not p:
            raise HTTPException(404, "Produto não encontrado")
        return {"dono": p[0], **m.resumo("produto", str(did), p[0]["preco_venda"], p[0]["rendimento"])}
    ins = m.insumos.get(str(did))
    if not ins or ins["tipo"] != "manufaturado":
        raise HTTPException(404, "Manufaturado não encontrado")
    custo_un, alerta = m.custo_unitario(str(did))
    modo = q("select modo_preparo from fin_app.insumos where id = %s", (did,))[0]["modo_preparo"]
    return {"dono": {**ins, "modo_preparo": modo}, **m.resumo("manufaturado", str(did)), "custo_unitario": custo_un, "alerta": alerta}


class ItemFicha(BaseModel):
    insumo_id: uuid.UUID
    quantidade: Decimal = Field(gt=0, max_digits=14, decimal_places=4)
    unidade: Literal["kg", "g", "l", "ml", "un", "cx", "pct", "dz", "fardo", "m"]
    perda_pct: Decimal = Field(0, ge=0, lt=100, max_digits=5, decimal_places=2)


class Ficha(BaseModel):
    itens: list[ItemFicha] = Field(max_length=80)
    rendimento: Decimal | None = Field(None, gt=0, max_digits=14, decimal_places=3)   # manufaturado: na unidade; produto: porções
    modo_preparo: str | None = Field(None, max_length=8000)                             # None = não mexe


@router.put("/{dono}/{did}")
def salvar(dono: Literal["produto", "manufaturado"], did: uuid.UUID, f: Ficha):
    m = Motor()
    for it in f.itens:
        ins = m.insumos.get(str(it.insumo_id))
        if not ins:
            raise HTTPException(422, "Insumo não encontrado")
        if converter(1, it.unidade, ins["unidade_saida"]) is None:
            raise HTTPException(422, f"{ins['nome']}: use {', '.join(compativeis(ins['unidade_saida']))} (sai em {ins['unidade_saida']})")
        if dono == "manufaturado" and str(it.insumo_id) == str(did):
            raise HTTPException(422, "Um manufaturado não pode usar ele mesmo")
    col = "produto_id" if dono == "produto" else "manufaturado_id"
    with psycopg.connect(**DSN) as conn, conn.transaction():
        if dono == "manufaturado":
            ok = conn.execute("select 1 from fin_app.insumos where id = %s and tipo = 'manufaturado'", (did,)).fetchone()
            if f.rendimento is not None and ok:
                conn.execute("update fin_app.insumos set rendimento = %s where id = %s", (f.rendimento, did))
        else:
            ok = conn.execute("select 1 from fin_app.produtos where id = %s", (did,)).fetchone()
            if f.rendimento is not None and ok:
                conn.execute("update fin_app.produtos set rendimento = %s where id = %s", (f.rendimento, did))
        if not ok:
            raise HTTPException(404, "Não encontrado")
        if f.modo_preparo is not None:
            conn.execute(f"update fin_app.{'insumos' if dono == 'manufaturado' else 'produtos'} set modo_preparo = %s where id = %s",
                         (f.modo_preparo.strip() or None, did))
        conn.execute(f"delete from fin_app.ficha_itens where {col} = %s", (did,))
        for n, it in enumerate(f.itens):
            conn.execute(f"""insert into fin_app.ficha_itens ({col}, insumo_id, quantidade, unidade, perda_pct, ordem)
                             values (%s, %s, %s, %s, %s, %s)""", (did, it.insumo_id, it.quantidade, it.unidade, it.perda_pct, n))
    if dono == "manufaturado":   # detecta ciclo depois de gravar (A usa B que usa A)
        _, alerta = Motor().custo_unitario(str(did))
        if alerta and "circular" in alerta:
            return {"ok": True, "alerta": "Atenção: receita circular — um manufaturado usa outro que usa ele de volta."}
    return {"ok": True}


# ------------------------------------------------------------------ foto da ficha de produção
import io as _io
import os as _os

import boleto
from fastapi import File, UploadFile

FOTOS_DIR = _os.path.join(boleto.ANEXOS_DIR, "fichas")


def caminho_foto(did) -> str:
    return _os.path.join(FOTOS_DIR, f"{uuid.UUID(str(did))}.jpg")


@router.post("/{dono}/{did}/foto")
def enviar_foto(dono: Literal["produto", "manufaturado"], did: uuid.UUID, arquivo: UploadFile = File(...)):
    """Foto de como o prato/preparo fica pronto. Guardada em JPEG de até 1400 px (foto do celular, inclusive HEIC)."""
    from PIL import Image, ImageOps
    try:
        import pillow_heif
        pillow_heif.register_heif_opener()
    except Exception:
        pass
    conteudo = arquivo.file.read(15 * 1024 * 1024 + 1)
    if not conteudo or len(conteudo) > 15 * 1024 * 1024:
        raise HTTPException(422, "Foto vazia ou maior que 15 MB")
    try:
        img = ImageOps.exif_transpose(Image.open(_io.BytesIO(conteudo))).convert("RGB")
    except Exception:
        raise HTTPException(415, "Envie uma foto (JPG, PNG, WebP ou HEIC)")
    img.thumbnail((1400, 1400))
    tabela, filtro = ("produtos", "") if dono == "produto" else ("insumos", " and tipo = 'manufaturado'")
    if not q(f"select 1 from fin_app.{tabela} where id = %s{filtro}", (did,)):
        raise HTTPException(404, "Ficha não encontrada")
    _os.makedirs(FOTOS_DIR, exist_ok=True)
    img.save(caminho_foto(did), "JPEG", quality=85, optimize=True)
    with psycopg.connect(**DSN) as conn:
        conn.execute(f"update fin_app.{tabela} set foto_em = now() where id = %s", (did,))
    return {"ok": True}


@router.delete("/{dono}/{did}/foto")
def remover_foto(dono: Literal["produto", "manufaturado"], did: uuid.UUID):
    tabela = "produtos" if dono == "produto" else "insumos"
    with psycopg.connect(**DSN) as conn:
        conn.execute(f"update fin_app.{tabela} set foto_em = null where id = %s", (did,))
    try:
        _os.remove(caminho_foto(did))
    except FileNotFoundError:
        pass
    return {"ok": True}


class Preparo(BaseModel):
    modo_preparo: str = Field("", max_length=8000)


@router.put("/{dono}/{did}/preparo")
def salvar_preparo(dono: Literal["produto", "manufaturado"], did: uuid.UUID, b: Preparo):
    """Só o modo de preparo (editado na ficha de produção, sem mexer nos ingredientes)."""
    tabela, filtro = ("produtos", "") if dono == "produto" else ("insumos", " and tipo = 'manufaturado'")
    with psycopg.connect(**DSN) as conn:
        cur = conn.execute(f"update fin_app.{tabela} set modo_preparo = %s where id = %s{filtro}", (b.modo_preparo.strip() or None, did))
        if cur.rowcount != 1:
            raise HTTPException(404, "Ficha não encontrada")
    return {"ok": True}


@router.get("/catalogo")
def catalogo():
    """Tudo que a tela de Cardápio e estoque precisa numa chamada: itens completos, custos calculados,
    CMV dos produtos e onde cada insumo é usado."""
    m = Motor()
    produtos = q("""select p.*, c.nome as categoria from fin_app.produtos p
                    left join fin_app.cat_itens c on c.id = p.categoria_id
                    order by c.ordem nulls last, c.nome, lower(p.nome)""")
    nomes = {p["id"]: ("produto", p["nome"]) for p in produtos}
    insumos = q("""select i.*, c.nome as categoria, f.nome as fornecedor from fin_app.insumos i
                   left join fin_app.cat_itens c on c.id = i.categoria_id
                   left join fin_app.pessoas f on f.id = i.fornecedor_id
                   order by c.ordem nulls last, c.nome, lower(i.nome)""")
    nomes |= {i["id"]: ("manufaturado", i["nome"]) for i in insumos if i["tipo"] == "manufaturado"}
    usos = {}
    for it in m.itens:
        dono = it["produto_id"] or it["manufaturado_id"]
        tipo, nome = nomes.get(dono, ("?", "?"))
        usos.setdefault(it["insumo_id"], []).append({"tipo": tipo, "id": dono, "nome": nome})
    for p in produtos:
        r = m.resumo("produto", p["id"], p["preco_venda"], p["rendimento"])
        p.update({k: r.get(k) for k in ("custo_total", "cmv_pct", "margem", "itens", "incompleta")})
    for i in insumos:
        i["custo_efetivo"], i["alerta"] = m.custo_unitario(i["id"])
        i["itens"] = len(m.itens_de("manufaturado", i["id"])) if i["tipo"] == "manufaturado" else 0
        i["usado_em"] = sorted(usos.get(i["id"], []), key=lambda u: u["nome"].lower())
        i["unidade_saida"] = m.insumos[i["id"]]["unidade_saida"]
        i["compativeis"] = compativeis(i["unidade_saida"])
    cats = q("select id, grupo, nome, ordem from fin_app.cat_itens where ativo order by grupo, ordem, nome")
    return {"produtos": produtos, "insumos": insumos, "categorias": cats}
