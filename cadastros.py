"""Cadastros do app, organizados por área.

Financeiro : contas bancárias, plano de contas (categoria > subcategoria, com grupo do fluxo
             de caixa e linha da DRE) e fornecedores/clientes.
Fechamento : formas de pagamento (com grupo de conferência) e equipe.
Nada é apagado: cadastro fora de uso é arquivado (ativo = false) e some das listas de escolha.
"""
import datetime as dt
import uuid
from decimal import Decimal
from typing import Literal

import psycopg
from fastapi import APIRouter, HTTPException, Query
from psycopg.rows import dict_row
from pydantic import BaseModel, Field, field_validator, model_validator

from fin import DSN, _rows, q

router = APIRouter(prefix="/api/cad")

PAPEIS_FIN = ("fornecedor", "cliente", "funcionario", "socio")
PAPEIS_EQUIPE = ("motoboy", "free_lance", "funcionario", "responsavel_caixa", "socio")
Papel = Literal["fornecedor", "cliente", "funcionario", "socio", "motoboy", "free_lance", "responsavel_caixa"]


def _limpa(v):
    return v.strip() if isinstance(v, str) and v.strip() else None


def _salvar(tabela: str, dados: dict, id_: uuid.UUID | None):
    """INSERT (id_ None) ou UPDATE de um cadastro; devolve a linha gravada."""
    cols = list(dados)
    with psycopg.connect(**DSN, row_factory=dict_row) as conn:
        if id_ is None:
            cur = conn.execute(f"insert into fin_app.{tabela} ({', '.join(cols)}) values "
                               f"({', '.join('%(' + c + ')s' for c in cols)}) returning *", dados)
        else:
            cur = conn.execute(f"update fin_app.{tabela} set {', '.join(f'{c} = %({c})s' for c in cols)} "
                               "where id = %(id)s returning *", dados | {"id": id_})
        rows = _rows(cur)
    if not rows:
        raise HTTPException(404, "Cadastro não encontrado")
    return rows[0]


# ------------------------------------------------------------------ resumo
@router.get("/resumo")
def resumo():
    return q("""select
        (select count(*) from fin_app.contas_bancarias where ativo) as contas,
        (select count(*) from fin_app.subcategorias s join fin_app.categorias k on k.id = s.categoria_id
          where s.ativo and k.ativo) as subcategorias,
        (select count(*) from fin_app.subcategorias s where s.ativo and s.dre_linha is null) as fora_dre,
        (select count(*) from fin_app.pessoas where ativo and papeis && %(fin)s) as pessoas,
        (select count(*) from fin_app.formas_pagamento where ativo) as formas,
        (select count(*) from fin_app.pessoas where ativo and papeis && %(eq)s) as equipe,
        (select count(*) from fin_app.pessoas where ativo and 'fornecedor' = any(papeis) and tipo_fornecedor = 'insumos') as forn_insumos,
        (select count(*) from fin_app.pessoas where ativo and 'fornecedor' = any(papeis)
                                                 and coalesce(tipo_fornecedor, 'servicos') = 'servicos') as prestadores,
        (select count(*) from fin_app.insumos where ativo and tipo = 'insumo') as insumos,
        (select count(*) from fin_app.insumos where ativo and tipo = 'manufaturado') as manufaturados,
        (select count(*) from fin_app.produtos where ativo) as produtos,
        (select count(*) from fin_app.estoque_centrais where ativo) as centrais""",
             {"fin": list(PAPEIS_FIN), "eq": list(PAPEIS_EQUIPE)})[0]


@router.post("/importar-nibo")
def importar_nibo():
    return q("select fin_app.importar_nibo() as r")[0]["r"]


# ------------------------------------------------------------------ contas bancárias
class Conta(BaseModel):
    nome: str = Field(min_length=1, max_length=80)
    tipo: Literal["banco", "dinheiro", "investimento", "carteira"] = "banco"
    banco: str | None = Field(None, max_length=80)
    finalidade: str | None = Field(None, max_length=120)
    saldo_inicial: Decimal = Field(0, max_digits=14, decimal_places=2)
    data_saldo_inicial: dt.date | None = None
    ordem: int = 100
    ativo: bool = True

    @field_validator("banco", "finalidade", "data_saldo_inicial", mode="before")
    @classmethod
    def limpa_campos(cls, v):
        return _limpa(v) if isinstance(v, str) else v


@router.get("/contas")
def contas():
    return q("""select c.*, v.saldo_atual, v.saldo_nibo, v.ajuste_manual, v.ultima_mov
                from fin_app.contas_bancarias c left join fin_app.v_contas v on v.id = c.id
                order by not c.ativo, c.ordem, c.nome""")


@router.post("/contas")
def criar_conta(c: Conta):
    return _salvar("contas_bancarias", c.model_dump(), None)


@router.put("/contas/{cid}")
def editar_conta(cid: uuid.UUID, c: Conta):
    return _salvar("contas_bancarias", c.model_dump(), cid)


# ------------------------------------------------------------------ plano de contas
class Categoria(BaseModel):
    nome: str = Field(min_length=1, max_length=80)
    grupo_fluxo: Literal["operacional", "investimento", "financiamento"]
    ordem: int = 100
    ativo: bool = True


class Subcategoria(BaseModel):
    categoria_id: uuid.UUID
    nome: str = Field(min_length=1, max_length=100)
    tipo: Literal["pagar", "receber"]
    dre_linha: str | None = None
    codigo: str | None = Field(None, max_length=20)
    ativo: bool = True

    @field_validator("dre_linha", "codigo", mode="before")
    @classmethod
    def limpa_campos(cls, v):
        return _limpa(v) if isinstance(v, str) else v


@router.get("/plano")
def plano():
    cats = q("select * from fin_app.categorias order by ordem, nome")
    subs = q("""select s.*, coalesce(u.usos, 0) as usos
                from fin_app.subcategorias s
                left join (select categoria_id, count(*) as usos from fin_app.v_titulos group by 1) u
                       on u.categoria_id = s.id
                order by s.nome""")
    por_cat = {}
    for s in subs:
        por_cat.setdefault(s["categoria_id"], []).append(s)
    for c in cats:
        c["subcategorias"] = por_cat.get(c["id"], [])
    return {"categorias": cats, "dre_linhas": q("select * from fin_app.dre_linhas order by ordem")}


@router.post("/categorias")
def criar_categoria(c: Categoria):
    return _salvar("categorias", c.model_dump(), None)


@router.put("/categorias/{cid}")
def editar_categoria(cid: uuid.UUID, c: Categoria):
    return _salvar("categorias", c.model_dump(), cid)


@router.post("/subcategorias")
def criar_subcategoria(s: Subcategoria):
    return _salvar("subcategorias", s.model_dump(), None)


@router.put("/subcategorias/{sid}")
def editar_subcategoria(sid: uuid.UUID, s: Subcategoria):
    return _salvar("subcategorias", s.model_dump(), sid)


class DreEmLote(BaseModel):
    ids: list[uuid.UUID] = Field(min_length=1, max_length=200)
    dre_linha: str | None = None


@router.post("/subcategorias/dre")
def dre_em_lote(d: DreEmLote):
    with psycopg.connect(**DSN) as conn:
        cur = conn.execute("update fin_app.subcategorias set dre_linha = %s where id = any(%s)",
                           (_limpa(d.dre_linha), d.ids))
    return {"atualizadas": cur.rowcount}


# ------------------------------------------------------------------ pessoas
class Pessoa(BaseModel):
    nome: str = Field(min_length=1, max_length=120)
    papeis: list[Papel] = Field(min_length=1)
    tipo_pessoa: Literal["PF", "PJ"] | None = None
    documento: str | None = Field(None, max_length=20)
    telefone: str | None = Field(None, max_length=30)
    email: str | None = Field(None, max_length=120)
    chave_pix: str | None = Field(None, max_length=120)
    diaria_padrao: Decimal | None = Field(None, ge=0, max_digits=14, decimal_places=2)
    # fornecedor: 'insumos' (comida, bebida, embalagem) ou 'servicos' (prestador de serviço)
    tipo_fornecedor: Literal["insumos", "servicos"] | None = None
    free_lance_areas: list[Literal["cozinha", "salao"]] = []   # onde o free lance trabalha
    observacao: str | None = Field(None, max_length=500)
    ativo: bool = True

    @field_validator("documento", "telefone", "email", "chave_pix", "observacao", mode="before")
    @classmethod
    def limpa_campos(cls, v):
        return _limpa(v) if isinstance(v, str) else v

    @field_validator("papeis")
    @classmethod
    def _unicos(cls, v):
        return sorted(set(v))

    @model_validator(mode="after")
    def _grupo_fornecedor(self):
        if "fornecedor" not in self.papeis:
            self.tipo_fornecedor = None
        elif self.tipo_fornecedor is None:
            self.tipo_fornecedor = "servicos"
        self.free_lance_areas = sorted(set(self.free_lance_areas)) if "free_lance" in self.papeis else []
        return self


@router.get("/pessoas")
def pessoas(area: Literal["financeiro", "equipe", "forn_insumos", "prestadores"],
            busca: str = Query("", max_length=80), inativos: bool = False):
    """Lista de uma área de Cadastros › Pessoas (financeiro = todos os contatos dos lançamentos)."""
    papeis = {"financeiro": list(PAPEIS_FIN), "equipe": list(PAPEIS_EQUIPE)}.get(area, ["fornecedor"])
    grupo = {"forn_insumos": "insumos", "prestadores": "servicos"}.get(area)
    return q("""select * from fin_app.pessoas
                where papeis && %(p)s and (%(i)s or ativo) and mesclada_em is null
                  and (%(g)s::text is null or coalesce(tipo_fornecedor, 'servicos') = %(g)s)
                  and (%(b)s = '' or nome ilike '%%' || %(b)s || '%%' or documento ilike '%%' || %(b)s || '%%')
                order by not ativo, lower(nome) limit 1000""", {"p": papeis, "g": grupo, "i": inativos, "b": busca.strip()})


# ------------------------------------------------------------------ pessoas duplicadas
_NORM = """lower(translate(regexp_replace(trim(nome), '\\s+', ' ', 'g'),
             'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇáàâãäéèêëíìîïóòôõöúùûüç', 'AAAAAEEEEIIIIOOOOOUUUUCaaaaaeeeeiiiiooooouuuuc'))"""


@router.get("/pessoas/duplicados")
def duplicados():
    """Sugestões óbvias: mesmo nome (sem acento/maiúscula) ou mesmo CPF/CNPJ. O resto o usuário junta à mão."""
    return q(f"""with p as (select id, nome, papeis, documento, ativo, nibo_id is not null as nibo, {_NORM} as n,
                                   nullif(regexp_replace(coalesce(documento, ''), '\\D', '', 'g'), '') as doc
                            from fin_app.pessoas where mesclada_em is null),
                 g as (select n as chave, array_agg(id) as ids from p group by n having count(*) > 1
                       union select doc, array_agg(id) from p where doc is not null group by doc having count(*) > 1)
                 select distinct on (ids) ids, (select json_agg(json_build_object('id', p.id, 'nome', p.nome, 'papeis', p.papeis,
                          'documento', p.documento, 'ativo', p.ativo, 'nibo', p.nibo) order by p.ativo desc, p.nibo, p.nome)
                          from p where p.id = any(g.ids)) as pessoas
                 from g order by ids""")


class Unificar(BaseModel):
    principal_id: uuid.UUID
    outros: list[uuid.UUID] = Field(min_length=1, max_length=20)


@router.post("/pessoas/unificar")
def unificar(u: Unificar):
    """Junta as duplicadas na principal: tudo o que apontava para elas passa a apontar para a principal.
    As duplicadas ficam inativas com mesclada_em = principal (o Nibo não as recria, e os lançamentos do Nibo
    delas aparecem no nome da principal pela v_titulos)."""
    outros = [o for o in dict.fromkeys(u.outros) if o != u.principal_id]
    if not outros:
        raise HTTPException(422, "Escolha ao menos uma pessoa para juntar na principal")
    with psycopg.connect(**DSN, row_factory=dict_row) as conn, conn.transaction():
        cur = conn.cursor()
        todos = {r["id"]: r for r in cur.execute("select * from fin_app.pessoas where id = any(%s) for update",
                                                  ([u.principal_id, *outros],)).fetchall()}
        if len(todos) != len(outros) + 1:
            raise HTTPException(404, "Pessoa não encontrada")
        if any(r["mesclada_em"] for r in todos.values()):
            raise HTTPException(409, "Uma das pessoas já foi unificada em outra")
        pr = todos[u.principal_id]
        # login e ficha de RH: só pode haver um de cada
        for tabela, rot in (("usuarios", "login no app"), ("rh_funcionarios", "ficha de RH")):
            tem = [r["pessoa_id"] for r in cur.execute(f"select pessoa_id from fin_app.{tabela} where pessoa_id = any(%s)",
                                                       ([u.principal_id, *outros],)).fetchall()]
            if len(tem) > 1:
                nomes = ", ".join(todos[i]["nome"] for i in tem)
                raise HTTPException(409, f"Mais de uma tem {rot} ({nomes}). Deixe só uma com {rot} antes de unificar.")
            if tem and tem[0] != u.principal_id:
                cur.execute(f"update fin_app.{tabela} set pessoa_id = %s where pessoa_id = %s", (u.principal_id, tem[0]))
        for tabela, col in (("rh_ponto", "pessoa_id"), ("rh_lancamentos", "pessoa_id"), ("rh_documentos", "pessoa_id"),
                            ("compras", "pessoa_id"), ("insumos", "fornecedor_id")):
            cur.execute(f"update fin_app.{tabela} set {col} = %s where {col} = any(%s)", (u.principal_id, outros))
        for tabela in ("lancamentos", "caixa_fluxo"):
            cur.execute(f"update fin_app.{tabela} set contato_id = %s, contato = %s where contato_id = any(%s)",
                        (u.principal_id, pr["nome"], outros))
        # fechamentos de caixa guardam o nome: passam a usar o nome da principal
        velhos = [todos[o]["nome"] for o in outros]
        cur.execute("update fin_app.caixa_equipe set nome = %s where lower(trim(nome)) = any(%s)",
                    (pr["nome"], [n.strip().lower() for n in velhos]))
        cur.execute("update fin_app.caixa_canal set responsavel = %s where lower(trim(responsavel)) = any(%s)",
                    (pr["nome"], [n.strip().lower() for n in velhos]))
        # a principal herda papéis e o que ela não tinha preenchido
        papeis = sorted(set(pr["papeis"]).union(*(todos[o]["papeis"] for o in outros)))
        campos = {"papeis": papeis}
        for c in ("documento", "tipo_pessoa", "telefone", "email", "chave_pix", "diaria_padrao", "observacao", "tipo_fornecedor"):
            if pr.get(c) in (None, "") and c in pr:
                campos[c] = next((todos[o][c] for o in outros if todos[o].get(c) not in (None, "")), pr.get(c))
        if "free_lance_areas" in pr:
            campos["free_lance_areas"] = sorted(set(pr["free_lance_areas"] or []).union(*((todos[o]["free_lance_areas"] or []) for o in outros)))
        cur.execute(f"update fin_app.pessoas set {', '.join(f'{c} = %({c})s' for c in campos)}, ativo = true where id = %(id)s",
                    campos | {"id": u.principal_id})
        cur.execute("update fin_app.pessoas set mesclada_em = %s where mesclada_em = any(%s)", (u.principal_id, outros))
        cur.execute("update fin_app.pessoas set mesclada_em = %s, ativo = false where id = any(%s)", (u.principal_id, outros))
    return {"ok": True, "principal": pr["nome"], "unificadas": velhos}


@router.get("/pessoas/{pid}/historico")
def historico_pessoa(pid: uuid.UUID):
    pessoa = q("select * from fin_app.pessoas where id = %s", (pid,))
    if not pessoa:
        raise HTTPException(404, "Cadastro não encontrado")
    p = {"id": pid}
    resumo = q("""select
          coalesce(sum(valor_pago) filter (where tipo = 'pagar'), 0) as total_pago,
          coalesce(sum(valor_pago) filter (where tipo = 'receber'), 0) as total_recebido,
          coalesce(sum(valor_pago) filter (where tipo = 'pagar' and data_pagamento > current_date - 365), 0) as pago_12m,
          coalesce(sum(valor_em_aberto) filter (where status = 'aberto'), 0) as em_aberto,
          coalesce(sum(valor_em_aberto) filter (where status = 'aberto' and vencimento < current_date), 0) as vencido,
          count(*) filter (where status = 'pago') as qtd_pagos,
          min(data_pagamento) as primeiro_pagamento, max(data_pagamento) as ultimo_pagamento
        from fin_app.v_titulos where contato_id = %(id)s""", p)[0]
    meses = q("""select to_char(date_trunc('month', data_pagamento), 'YYYY-MM') as mes, sum(valor_pago) as valor
                 from fin_app.v_titulos
                 where contato_id = %(id)s and status = 'pago' and data_pagamento >= date_trunc('month', current_date) - interval '11 months'
                 group by 1 order by 1""", p)
    titulos = q("""select origem, id, tipo, vencimento, data_pagamento, descricao, categoria_nome, valor,
                          valor_pago, valor_em_aberto, status, (status = 'aberto' and vencimento < current_date) as vencido
                   from fin_app.v_titulos where contato_id = %(id)s
                   order by coalesce(data_pagamento, vencimento) desc limit 500""", p)
    return {"pessoa": pessoa[0], "resumo": resumo, "meses": meses, "titulos": titulos}


@router.post("/pessoas")
def criar_pessoa(p: Pessoa):
    return _salvar("pessoas", p.model_dump(), None)


@router.put("/pessoas/{pid}")
def editar_pessoa(pid: uuid.UUID, p: Pessoa):
    return _salvar("pessoas", p.model_dump(), pid)


USOS_PESSOA = [   # (tabela.coluna, como mostrar) — onde um cadastro pode estar sendo usado
    ("lancamentos.contato_id", "lançamento(s) no financeiro"), ("compras.pessoa_id", "compra(s)"),
    ("usuarios.pessoa_id", "login no app"), ("rh_funcionarios.pessoa_id", "ficha no RH"),
    ("rh_ponto.pessoa_id", "batida(s) de ponto"), ("rh_lancamentos.pessoa_id", "vale(s)/consumo(s)"),
    ("rh_documentos.pessoa_id", "documento(s) do RH"), ("insumos.fornecedor_id", "insumo(s) com este fornecedor padrão"),
]


@router.delete("/pessoas/{pid}")
def excluir_pessoa(pid: uuid.UUID):
    """Exclui de vez um cadastro que não é usado em lugar nenhum (ex.: duplicado). Se for usado, explica onde
    e sugere arquivar. Quem veio do Nibo entra na lista de excluídos para não voltar na próxima importação."""
    with psycopg.connect(**DSN, row_factory=dict_row) as conn, conn.transaction():
        p = conn.execute("select id, nome, nibo_id from fin_app.pessoas where id = %s for update", (pid,)).fetchone()
        if not p:
            raise HTTPException(404, "Cadastro não encontrado")
        usos = []
        for col, rot in USOS_PESSOA:
            tab, c = col.split(".")
            n = conn.execute(f"select count(*) as n from fin_app.{tab} where {c} = %s", (pid,)).fetchone()["n"]
            if n:
                usos.append(f"{n} {rot}" if not rot.startswith("login") else rot)
        if p["nibo_id"]:
            n = conn.execute("select count(*) as n from fin_app.v_titulos where origem = 'nibo' and contato_id = %s",
                             (p["nibo_id"],)).fetchone()["n"]
            if n:
                usos.append(f"{n} lançamento(s) no Nibo")
        if usos:
            raise HTTPException(409, f"{p['nome']} não pode ser excluído porque tem {', '.join(usos)}. "
                                     "Se for duplicado, exclua o outro cadastro; senão, arquive.")
        if p["nibo_id"]:
            conn.execute("""insert into fin_app.pessoas_excluidas (nibo_id, nome) values (%s, %s)
                            on conflict (nibo_id) do nothing""", (p["nibo_id"], p["nome"]))
        conn.execute("delete from fin_app.pessoas where id = %s", (pid,))
    return {"ok": True, "nome": p["nome"]}


# ------------------------------------------------------------------ formas de pagamento
class Forma(BaseModel):
    nome: str = Field(min_length=1, max_length=60)
    conferencia: str = Field(min_length=1, max_length=60)
    canais: list[Literal["Salão", "Delivery"]] = Field(min_length=1)
    taxa_percentual: Decimal | None = Field(None, ge=0, le=100, max_digits=6, decimal_places=3)
    prazo_recebimento: int | None = Field(None, ge=0, le=120)
    ordem: int = 100
    conferir_no_caixa: bool = True
    # lançamento no fluxo de caixa ao fechar o caixa (caixa_fluxo.py)
    conta_id: uuid.UUID | None = None
    categoria_id: uuid.UUID | None = None
    descricao_lanc: str | None = Field(None, max_length=120)
    ativo: bool = True

    @field_validator("conferencia")
    @classmethod
    def _conf(cls, v):
        v = v.strip()
        return "gaveta" if v.lower() in ("gaveta", "dinheiro na gaveta") else v


@router.get("/formas")
def formas():
    return q("""select f.*, coalesce(u.usos, 0) as usos, k.conta as conta_nome, c.categoria as categoria_nome
                from fin_app.formas_pagamento f
                left join fin_app.v_contas k on k.id = f.conta_id
                left join fin_app.v_categorias c on c.id = f.categoria_id
                left join (select forma, count(*) as usos from fin_app.caixa_formas where valor > 0 group by 1) u
                       on u.forma = f.nome
                order by not f.ativo, f.ordem, f.nome""")


@router.post("/formas")
def criar_forma(f: Forma):
    return _salvar("formas_pagamento", f.model_dump(), None)


@router.put("/formas/{fid}")
def editar_forma(fid: uuid.UUID, f: Forma):
    return _salvar("formas_pagamento", f.model_dump(), fid)


# ------------------------------------------------------------------ cardápio e estoque
UNIDADES = Literal["kg", "g", "l", "ml", "un", "cx", "pct", "dz", "fardo", "m"]


class CategoriaItem(BaseModel):
    grupo: Literal["insumo", "produto"]
    nome: str = Field(min_length=1, max_length=60)
    ordem: int = 100
    ativo: bool = True


class Insumo(BaseModel):
    tipo: Literal["insumo", "manufaturado"]
    nome: str = Field(min_length=1, max_length=120)
    categoria_id: uuid.UUID | None = None
    unidade: UNIDADES = "kg"
    custo_unitario: Decimal | None = Field(None, ge=0, max_digits=14, decimal_places=4)
    # unidade de saída (como é medido na ficha): igual à compra, kg cozido e limpo, porções, ou qualquer unidade de compra.
    # comprar saida_base (na unidade de compra) rende saida_rende na unidade de saída (ex.: 1 cx rende 12 un)
    saida_tipo: Literal["compra", "limpo", "porcoes", "kg", "g", "l", "ml", "un", "cx", "pct", "dz", "fardo", "m"] = "compra"
    saida_base: Decimal | None = Field(None, gt=0, max_digits=14, decimal_places=4)
    saida_rende: Decimal | None = Field(None, gt=0, max_digits=14, decimal_places=4)
    rendimento: Decimal | None = Field(None, ge=0, max_digits=14, decimal_places=3)
    estoque_minimo: Decimal | None = Field(None, ge=0, max_digits=14, decimal_places=3)
    fornecedor_id: uuid.UUID | None = None
    codigo: str | None = Field(None, max_length=40)
    observacao: str | None = Field(None, max_length=500)
    ativo: bool = True

    @field_validator("categoria_id", "fornecedor_id", "codigo", "observacao", mode="before")
    @classmethod
    def limpa_campos(cls, v):
        return _limpa(v) if isinstance(v, str) else v

    @model_validator(mode="after")
    def _saida(self):
        if self.tipo == "manufaturado" or self.saida_tipo == "compra":
            self.saida_tipo, self.saida_base, self.saida_rende = "compra", None, None
        elif not (self.saida_base and self.saida_rende):
            raise ValueError("Informe quanto foi comprado e quanto rende na unidade de saída")
        return self

    @field_validator("categoria_id")
    @classmethod
    def _manufaturado(cls, v, info):
        if info.data.get("tipo") == "manufaturado":
            return None      # manufaturados não têm categoria
        return v


class Produto(BaseModel):
    nome: str = Field(min_length=1, max_length=120)
    categoria_id: uuid.UUID | None = None
    preco_venda: Decimal | None = Field(None, ge=0, max_digits=14, decimal_places=2)
    preco_app: Decimal | None = Field(None, ge=0, max_digits=14, decimal_places=2)
    codigo_pdv: str | None = Field(None, max_length=40)
    canais: list[Literal["Salão", "Delivery"]] = ["Salão", "Delivery"]
    descricao: str | None = Field(None, max_length=500)
    ativo: bool = True

    @field_validator("categoria_id", "codigo_pdv", "descricao", mode="before")
    @classmethod
    def limpa_campos(cls, v):
        return _limpa(v) if isinstance(v, str) else v


@router.get("/categorias-itens")
def categorias_itens(grupo: Literal["insumo", "produto"]):
    return q("""select c.*, (select count(*) from fin_app.insumos i where i.categoria_id = c.id)
                          + (select count(*) from fin_app.produtos p where p.categoria_id = c.id) as itens
                from fin_app.cat_itens c where grupo = %s order by not ativo, ordem, nome""", (grupo,))


@router.post("/categorias-itens")
def criar_categoria_item(c: CategoriaItem):
    return _salvar("cat_itens", c.model_dump(), None)


@router.put("/categorias-itens/{cid}")
def editar_categoria_item(cid: uuid.UUID, c: CategoriaItem):
    return _salvar("cat_itens", c.model_dump(), cid)


@router.get("/insumos")
def insumos(tipo: Literal["insumo", "manufaturado"], inativos: bool = False):
    return q("""select i.*, c.nome as categoria, p.nome as fornecedor
                from fin_app.insumos i left join fin_app.cat_itens c on c.id = i.categoria_id
                left join fin_app.pessoas p on p.id = i.fornecedor_id
                where i.tipo = %s and (%s or i.ativo)
                order by not i.ativo, c.ordem nulls last, c.nome, lower(i.nome)""", (tipo, inativos))


@router.post("/insumos")
def criar_insumo(i: Insumo):
    return _salvar("insumos", i.model_dump(), None)


@router.put("/insumos/{iid}")
def editar_insumo(iid: uuid.UUID, i: Insumo):
    return _salvar("insumos", i.model_dump(), iid)


@router.get("/produtos")
def produtos(inativos: bool = False):
    return q("""select p.*, c.nome as categoria from fin_app.produtos p
                left join fin_app.cat_itens c on c.id = p.categoria_id
                where %s or p.ativo order by not p.ativo, c.ordem nulls last, c.nome, lower(p.nome)""", (inativos,))


@router.post("/produtos")
def criar_produto(p: Produto):
    return _salvar("produtos", p.model_dump(), None)


@router.put("/produtos/{pid}")
def editar_produto(pid: uuid.UUID, p: Produto):
    return _salvar("produtos", p.model_dump(), pid)
