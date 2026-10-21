"""RH (somente admin): ficha do funcionário, acesso ao portal, ponto (controle interno),
vales/consumos e holerites. espelho() e os arquivos também são usados pelo portal do funcionário."""
import calendar
import datetime as dt
import hashlib
import os
import uuid
from decimal import Decimal
from typing import Literal

import psycopg
from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from psycopg.rows import dict_row
from pydantic import BaseModel, Field, field_validator

import auth
import boleto
from fin import DSN, q

router = APIRouter(prefix="/api/rh")
RH_DIR = os.path.join(boleto.ANEXOS_DIR, "rh")
PONTO_DIR = os.path.join(boleto.ANEXOS_DIR, "ponto")
TZ = "America/Sao_Paulo"


def _mes(m: str | None) -> tuple[dt.date, dt.date]:
    hoje = dt.date.today()
    a, mm = map(int, m.split("-")) if m else (hoje.year, hoje.month)
    ini = dt.date(a, mm, 1)
    return ini, ini.replace(day=calendar.monthrange(a, mm)[1])


def _uid(req: Request):
    return req.state.usuario["id"]


# ------------------------------------------------------------------ espelho de ponto (compartilhado)
def espelho(pessoa_id, mes: str | None) -> dict:
    ini, fim = _mes(mes)
    batidas = q(f"""select id, (momento at time zone '{TZ}') as local, tipo, origem, motivo, lat, lng, precisao_m,
                           foto is not null as tem_foto
                    from fin_app.rh_ponto
                    where pessoa_id = %s and cancelado_em is null
                      and (momento at time zone '{TZ}')::date between %s and %s
                    order by momento""", (pessoa_id, ini, fim))
    dias = {}
    for b in batidas:
        dias.setdefault(b["local"][:10], []).append(b)
    linhas, total_min = [], 0
    for dia in sorted(dias):
        bs, aberto, minutos, alerta = dias[dia], None, 0, None
        for b in bs:
            t = dt.datetime.fromisoformat(b["local"])
            if b["tipo"] == "entrada":
                if aberto:
                    alerta = "Entrada sem saída anterior"
                aberto = t
            elif aberto:
                minutos += int((t - aberto).total_seconds() // 60)
                aberto = None
            else:
                alerta = "Saída sem entrada"
        if aberto and dia < dt.date.today().isoformat():
            alerta = "Faltou registrar a saída"
        total_min += minutos
        linhas.append({"data": dia, "batidas": bs, "minutos": minutos, "alerta": alerta})
    return {"ini": ini.isoformat(), "fim": fim.isoformat(), "dias": linhas, "total_minutos": total_min,
            "dias_trabalhados": sum(1 for l in linhas if l["minutos"] > 0)}


# ------------------------------------------------------------------ funcionários
class Funcionario(BaseModel):
    pessoa_id: uuid.UUID | None = None          # pessoa já cadastrada (senão cria)
    nome: str | None = Field(None, max_length=120)
    cpf: str | None = Field(None, max_length=20)
    telefone: str | None = Field(None, max_length=30)
    cargo: str | None = Field(None, max_length=80)
    vinculo: Literal["clt", "free_lance", "estagio", "socio", "outro"] = "clt"
    admissao: dt.date | None = None
    desligamento: dt.date | None = None
    salario: Decimal | None = Field(None, ge=0, max_digits=14, decimal_places=2)
    jornada_semanal: Decimal | None = Field(44, ge=0, le=80)
    observacao: str | None = Field(None, max_length=500)

    @field_validator("cpf", mode="before")
    @classmethod
    def _cpf(cls, v):
        if v in (None, ""):
            return None
        if not auth.cpf_valido(v):
            raise ValueError("CPF inválido")
        return auth.so_digitos(v)

    @field_validator("admissao", "desligamento", mode="before")
    @classmethod
    def _vazio(cls, v):
        return v or None


@router.get("/funcionarios")
def funcionarios(inativos: bool = False):
    return q("""select f.*, p.nome, p.telefone, p.papeis, p.ativo as pessoa_ativa,
                       u.perfil, u.ativo as acesso_ativo, u.senha_hash is not null as tem_senha, u.estoque_setores,
                       u.convite_expira > now() as convite_pendente, u.ultimo_login,
                       (select max(momento) from fin_app.rh_ponto r where r.pessoa_id = f.pessoa_id and r.cancelado_em is null) as ultima_batida
                from fin_app.rh_funcionarios f join fin_app.pessoas p on p.id = f.pessoa_id
                left join fin_app.usuarios u on u.pessoa_id = f.pessoa_id
                where %s or f.desligamento is null or f.desligamento >= current_date
                order by lower(p.nome)""", (inativos,))


@router.get("/candidatos")
def candidatos():
    """Pessoas já cadastradas (equipe/funcionários) que ainda não têm ficha de RH."""
    return q("""select id, nome, papeis, telefone from fin_app.pessoas p
                where ativo and papeis && array['funcionario','free_lance','motoboy','responsavel_caixa']
                  and not exists (select 1 from fin_app.rh_funcionarios f where f.pessoa_id = p.id)
                order by lower(nome)""")


def _salvar_ficha(cur, pid, f: Funcionario):
    cur.execute("""insert into fin_app.rh_funcionarios (pessoa_id, cpf, cargo, vinculo, admissao, desligamento, salario,
                       jornada_semanal, observacao)
                   values (%(p)s, %(cpf)s, %(cargo)s, %(vinculo)s, %(admissao)s, %(desligamento)s, %(salario)s,
                       %(jornada)s, %(obs)s)
                   on conflict (pessoa_id) do update set cpf = excluded.cpf, cargo = excluded.cargo,
                       vinculo = excluded.vinculo, admissao = excluded.admissao, desligamento = excluded.desligamento,
                       salario = excluded.salario, jornada_semanal = excluded.jornada_semanal,
                       observacao = excluded.observacao, atualizado_em = now()""",
                {"p": pid, "cpf": f.cpf, "cargo": f.cargo, "vinculo": f.vinculo, "admissao": f.admissao,
                 "desligamento": f.desligamento, "salario": f.salario, "jornada": f.jornada_semanal, "obs": f.observacao})
    papel = "free_lance" if f.vinculo == "free_lance" else "funcionario"
    cur.execute("""update fin_app.pessoas set papeis = (select array_agg(distinct x) from unnest(papeis || %s::text) x),
                     telefone = coalesce(%s, telefone), documento = coalesce(documento, %s), tipo_pessoa = coalesce(tipo_pessoa, 'PF')
                   where id = %s""", (papel, f.telefone, f.cpf, pid))
    if f.cpf:   # mantém o CPF do login igual ao da ficha
        cur.execute("update fin_app.usuarios set cpf = %s, atualizado_em = now() where pessoa_id = %s and cpf <> %s",
                    (f.cpf, pid, f.cpf))


@router.post("/funcionarios")
def criar_funcionario(f: Funcionario):
    with psycopg.connect(**DSN, row_factory=dict_row) as conn, conn.transaction():
        cur = conn.cursor()
        pid = f.pessoa_id
        if not pid:
            if not (f.nome or "").strip():
                raise HTTPException(422, "Informe o nome ou escolha alguém já cadastrado")
            pid = cur.execute("insert into fin_app.pessoas (nome, papeis, tipo_pessoa) values (%s, '{}', 'PF') returning id",
                              (f.nome.strip(),)).fetchone()["id"]
        elif cur.execute("select 1 from fin_app.rh_funcionarios where pessoa_id = %s", (pid,)).fetchone():
            raise HTTPException(409, "Esta pessoa já tem ficha no RH")
        _salvar_ficha(cur, pid, f)
    return {"pessoa_id": str(pid)}


@router.put("/funcionarios/{pid}")
def editar_funcionario(pid: uuid.UUID, f: Funcionario):
    with psycopg.connect(**DSN, row_factory=dict_row) as conn, conn.transaction():
        cur = conn.cursor()
        if not cur.execute("select 1 from fin_app.rh_funcionarios where pessoa_id = %s", (pid,)).fetchone():
            raise HTTPException(404, "Funcionário não encontrado")
        if f.nome and f.nome.strip():
            cur.execute("update fin_app.pessoas set nome = %s where id = %s", (f.nome.strip(), pid))
        _salvar_ficha(cur, pid, f)
        if f.desligamento and f.desligamento <= dt.date.today():   # desligado: perde o acesso
            cur.execute("update fin_app.usuarios set ativo = false where pessoa_id = %s", (pid,))
            cur.execute("delete from fin_app.sessoes where usuario_id in (select id from fin_app.usuarios where pessoa_id = %s)", (pid,))
    return {"ok": True}


class Acesso(BaseModel):
    perfil: Literal["funcionario", "responsavel_caixa", "nenhum"]


@router.post("/funcionarios/{pid}/acesso")
def definir_acesso(pid: uuid.UUID, a: Acesso, req: Request):
    """Cria/atualiza o login do funcionário e devolve o link de primeiro acesso (válido por 72 h)."""
    with psycopg.connect(**DSN, row_factory=dict_row) as conn, conn.transaction():
        cur = conn.cursor()
        f = cur.execute("""select f.cpf, p.nome from fin_app.rh_funcionarios f join fin_app.pessoas p on p.id = f.pessoa_id
                           where f.pessoa_id = %s""", (pid,)).fetchone()
        if not f:
            raise HTTPException(404, "Funcionário não encontrado")
        u = cur.execute("select id, perfil from fin_app.usuarios where pessoa_id = %s", (pid,)).fetchone()
        if a.perfil == "nenhum":
            if u:
                if u["perfil"] == "admin":
                    raise HTTPException(422, "Não dá para tirar o acesso de um administrador por aqui")
                cur.execute("update fin_app.usuarios set ativo = false, convite_hash = null where id = %s", (u["id"],))
                cur.execute("delete from fin_app.sessoes where usuario_id = %s", (u["id"],))
            return {"ok": True}
        if not f["cpf"]:
            raise HTTPException(422, "Cadastre o CPF na ficha antes de liberar o acesso")
        if u and u["perfil"] == "admin":
            raise HTTPException(422, "Esta pessoa já é administradora")
        if u:
            cur.execute("update fin_app.usuarios set perfil = %s, ativo = true, cpf = %s, atualizado_em = now() where id = %s",
                        (a.perfil, f["cpf"], u["id"]))
            uid = u["id"]
        else:
            if cur.execute("select 1 from fin_app.usuarios where cpf = %s", (f["cpf"],)).fetchone():
                raise HTTPException(409, "Já existe um login com este CPF")
            uid = cur.execute("""insert into fin_app.usuarios (pessoa_id, cpf, nome, perfil) values (%s, %s, %s, %s)
                                 returning id""", (pid, f["cpf"], f["nome"], a.perfil)).fetchone()["id"]
        # responsável de caixa aparece na lista do fechamento
        papel_op = "array_append" if a.perfil == "responsavel_caixa" else "array_remove"
        cur.execute(f"""update fin_app.pessoas set papeis = coalesce((select array_agg(distinct x) from unnest(
                          {papel_op}(array_remove(papeis, 'responsavel_caixa'), 'responsavel_caixa')) x), '{{}}') where id = %s""", (pid,))
        token = auth.novo_convite(cur, uid) if a.perfil else None
    auth.log("convite", uid, f["cpf"], auth._ip(req))
    return {"link": f"/#/primeiro-acesso?t={token}", "validade_horas": auth.CONVITE_HORAS}


class HabEstoque(BaseModel):
    setores: list[Literal["salao", "cozinha"]] = []


@router.put("/funcionarios/{pid}/estoque")
def habilitar_estoque(pid: uuid.UUID, h: HabEstoque):
    """Habilitação de contagem de estoque (salão/cozinha), independente do perfil do caixa. Não mexe em senha."""
    r = q("""update fin_app.usuarios set estoque_setores = %s, atualizado_em = now()
             where pessoa_id = %s and perfil <> 'admin' returning id""", (sorted(set(h.setores)), pid))
    if not r:
        raise HTTPException(409, "Libere o acesso ao portal antes de habilitar a contagem de estoque")
    return {"ok": True}


# ------------------------------------------------------------------ ponto
@router.get("/ponto")
def ponto(pessoa_id: uuid.UUID, mes: str | None = None):
    return espelho(pessoa_id, mes)


@router.get("/ponto/resumo")
def ponto_resumo(mes: str | None = None):
    ini, fim = _mes(mes)
    return q(f"""select f.pessoa_id, p.nome, count(r.*) as batidas,
                        count(distinct (r.momento at time zone '{TZ}')::date) as dias
                 from fin_app.rh_funcionarios f join fin_app.pessoas p on p.id = f.pessoa_id
                 left join fin_app.rh_ponto r on r.pessoa_id = f.pessoa_id and r.cancelado_em is null
                      and (r.momento at time zone '{TZ}')::date between %s and %s
                 where f.desligamento is null or f.desligamento >= %s
                 group by 1, 2 order by lower(p.nome)""", (ini, fim, ini))


class Ajuste(BaseModel):
    pessoa_id: uuid.UUID
    momento: dt.datetime                       # data e hora locais
    tipo: Literal["entrada", "saida"]
    motivo: str = Field(min_length=3, max_length=200)


@router.post("/ponto")
def ajustar_ponto(a: Ajuste, req: Request):
    q(f"""insert into fin_app.rh_ponto (pessoa_id, momento, tipo, origem, motivo, registrado_por)
          values (%s, (%s::timestamp at time zone '{TZ}'), %s, 'ajuste', %s, %s) returning id""",
      (a.pessoa_id, a.momento.replace(tzinfo=None), a.tipo, a.motivo.strip(), _uid(req)))
    return {"ok": True}


@router.post("/ponto/{bid}/cancelar")
def cancelar_batida(bid: uuid.UUID, req: Request):
    r = q("""update fin_app.rh_ponto set cancelado_em = now(), cancelado_por = %s
             where id = %s and cancelado_em is null returning id""", (_uid(req), bid))
    if not r:
        raise HTTPException(404, "Batida não encontrada")
    return {"ok": True}


@router.get("/ponto/{bid}/foto")
def foto_batida(bid: uuid.UUID):
    r = q("select foto from fin_app.rh_ponto where id = %s", (bid,))
    if not r or not r[0]["foto"]:
        raise HTTPException(404, "Sem foto")
    return FileResponse(os.path.join(PONTO_DIR, r[0]["foto"]), media_type="image/jpeg")


# ------------------------------------------------------------------ vales e consumos
class LancRH(BaseModel):
    pessoa_id: uuid.UUID
    tipo: Literal["vale", "consumo", "adiantamento", "desconto", "bonus"]
    data: dt.date
    competencia: dt.date | None = None
    valor: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    descricao: str | None = Field(None, max_length=200)


@router.get("/lancamentos")
def lancamentos(mes: str | None = None, pessoa_id: uuid.UUID | None = None):
    ini, _ = _mes(mes)
    return q("""select l.*, p.nome from fin_app.rh_lancamentos l join fin_app.pessoas p on p.id = l.pessoa_id
                where l.cancelado_em is null and l.competencia = %s and (%s::uuid is null or l.pessoa_id = %s::uuid)
                order by lower(p.nome), l.data""", (ini, pessoa_id, pessoa_id))


@router.post("/lancamentos")
def criar_lanc(l: LancRH, req: Request):
    comp = (l.competencia or l.data).replace(day=1)
    q("""insert into fin_app.rh_lancamentos (pessoa_id, tipo, data, competencia, valor, descricao, criado_por)
         values (%s, %s, %s, %s, %s, %s, %s) returning id""",
      (l.pessoa_id, l.tipo, l.data, comp, l.valor, (l.descricao or "").strip() or None, _uid(req)))
    return {"ok": True}


class StatusLanc(BaseModel):
    status: Literal["pendente", "descontado", "cancelado"]


@router.post("/lancamentos/{lid}/status")
def status_lanc(lid: uuid.UUID, s: StatusLanc):
    sql = ("update fin_app.rh_lancamentos set cancelado_em = now() where id = %s returning id" if s.status == "cancelado"
           else "update fin_app.rh_lancamentos set status = %s where id = %s returning id")
    r = q(sql, (lid,) if s.status == "cancelado" else (s.status, lid))
    if not r:
        raise HTTPException(404, "Lançamento não encontrado")
    return {"ok": True}


# ------------------------------------------------------------------ holerites e documentos
@router.get("/documentos")
def documentos(pessoa_id: uuid.UUID | None = None, mes: str | None = None):
    ini = _mes(mes)[0] if mes else None
    return q("""select d.id, d.pessoa_id, p.nome as pessoa, d.tipo, d.competencia, d.nome, d.visto_em, d.criado_em
                from fin_app.rh_documentos d join fin_app.pessoas p on p.id = d.pessoa_id
                where d.cancelado_em is null and (%s::uuid is null or d.pessoa_id = %s::uuid)
                  and (%s::date is null or d.competencia = %s::date)
                order by d.competencia desc nulls last, lower(p.nome)""", (pessoa_id, pessoa_id, ini, ini))


@router.post("/documentos")
def enviar_documento(req: Request, pessoa_id: uuid.UUID = Form(...), tipo: str = Form("holerite"),
                     competencia: str = Form(""), arquivo: UploadFile = File(...)):
    if tipo not in ("holerite", "ferias", "decimo_terceiro", "contrato", "outro"):
        raise HTTPException(422, "Tipo de documento inválido")
    conteudo = arquivo.file.read(15 * 1024 * 1024 + 1)
    if not conteudo or len(conteudo) > 15 * 1024 * 1024:
        raise HTTPException(422, "Arquivo vazio ou maior que 15 MB")
    if conteudo[:5] != b"%PDF-":
        raise HTTPException(415, "Envie o holerite em PDF")
    comp = dt.date.fromisoformat(competencia + "-01") if competencia else None
    did = uuid.uuid4()
    rel = f"{pessoa_id}/{did}.pdf"
    os.makedirs(os.path.join(RH_DIR, str(pessoa_id)), exist_ok=True)
    with open(os.path.join(RH_DIR, rel), "wb") as f:
        f.write(conteudo)
    q("""insert into fin_app.rh_documentos (id, pessoa_id, tipo, competencia, nome, arquivo, sha256, enviado_por)
         values (%s, %s, %s, %s, %s, %s, %s, %s) returning id""",
      (did, pessoa_id, tipo, comp, (arquivo.filename or "documento.pdf")[:200], rel,
       hashlib.sha256(conteudo).hexdigest(), _uid(req)))
    return {"id": str(did)}


def arquivo_documento(did, pessoa_id=None):
    r = q("""select arquivo, nome, pessoa_id from fin_app.rh_documentos where id = %s and cancelado_em is null
             and (%s::uuid is null or pessoa_id = %s::uuid)""", (did, pessoa_id, pessoa_id))
    if not r:
        raise HTTPException(404, "Documento não encontrado")
    return FileResponse(os.path.join(RH_DIR, r[0]["arquivo"]), media_type="application/pdf", filename=r[0]["nome"],
                        content_disposition_type="inline")


@router.get("/documentos/{did}/arquivo")
def baixar_documento(did: uuid.UUID):
    return arquivo_documento(did)


@router.post("/documentos/{did}/cancelar")
def cancelar_documento(did: uuid.UUID):
    r = q("update fin_app.rh_documentos set cancelado_em = now() where id = %s and cancelado_em is null returning id", (did,))
    if not r:
        raise HTTPException(404, "Documento não encontrado")
    return {"ok": True}


# ------------------------------------------------------------------ banco de candidatos (processos seletivos)
CAND_DIR = os.path.join(RH_DIR, "candidatos")
AREAS_CAND = Literal["cozinha", "salao", "bar", "caixa", "delivery", "limpeza", "administrativo"]
# tipos aceitos para currículo, reconhecidos pelos primeiros bytes do arquivo
TIPOS_CV = [(b"%PDF-", "pdf", "application/pdf"), (b"\xff\xd8\xff", "jpg", "image/jpeg"), (b"\x89PNG", "png", "image/png"),
            (b"PK\x03\x04", "docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
            (b"\xd0\xcf\x11\xe0", "doc", "application/msword")]


class Candidato(BaseModel):
    nome: str = Field(min_length=1, max_length=120)
    telefone: str | None = Field(None, max_length=30)
    email: str | None = Field(None, max_length=120)
    cidade: str | None = Field(None, max_length=80)
    areas: list[AREAS_CAND] = []
    disponibilidade: str | None = Field(None, max_length=200)
    pretensao: Decimal | None = Field(None, ge=0, max_digits=14, decimal_places=2)
    origem: str | None = Field(None, max_length=80)
    ultimo_contato: dt.date | None = None
    status: Literal["disponivel", "contratado", "sem_interesse", "nao_recomendado"] = "disponivel"
    avaliacao: int | None = Field(None, ge=1, le=5)
    observacao: str | None = Field(None, max_length=2000)

    @field_validator("telefone", "email", "cidade", "disponibilidade", "origem", "observacao", "ultimo_contato", mode="before")
    @classmethod
    def _vazio(cls, v):
        return (v.strip() or None) if isinstance(v, str) else v

    @field_validator("areas")
    @classmethod
    def _unicas(cls, v):
        return sorted(set(v))


@router.get("/selecao")
def listar_candidatos():
    return q("""select id, nome, telefone, email, cidade, areas, disponibilidade, pretensao, origem, ultimo_contato,
                       status, avaliacao, observacao, curriculo is not null as tem_curriculo, curriculo_nome, criado_em
                from fin_app.rh_candidatos
                order by status <> 'disponivel', avaliacao desc nulls last, lower(nome)""")


@router.post("/selecao")
def criar_candidato(c: Candidato):
    return q("""insert into fin_app.rh_candidatos (nome, telefone, email, cidade, areas, disponibilidade, pretensao, origem,
                    ultimo_contato, status, avaliacao, observacao)
                values (%(nome)s, %(telefone)s, %(email)s, %(cidade)s, %(areas)s, %(disponibilidade)s, %(pretensao)s,
                        %(origem)s, %(ultimo_contato)s, %(status)s, %(avaliacao)s, %(observacao)s)
                returning id, nome""", c.model_dump())[0]


@router.put("/selecao/{cid}")
def editar_candidato(cid: uuid.UUID, c: Candidato):
    r = q("""update fin_app.rh_candidatos set nome = %(nome)s, telefone = %(telefone)s, email = %(email)s, cidade = %(cidade)s,
                    areas = %(areas)s, disponibilidade = %(disponibilidade)s, pretensao = %(pretensao)s, origem = %(origem)s,
                    ultimo_contato = %(ultimo_contato)s, status = %(status)s, avaliacao = %(avaliacao)s,
                    observacao = %(observacao)s, atualizado_em = now()
             where id = %(id)s returning id, nome""", c.model_dump() | {"id": cid})
    if not r:
        raise HTTPException(404, "Candidato não encontrado")
    return r[0]


@router.delete("/selecao/{cid}")
def excluir_candidato(cid: uuid.UUID):
    r = q("delete from fin_app.rh_candidatos where id = %s returning nome, curriculo", (cid,))
    if not r:
        raise HTTPException(404, "Candidato não encontrado")
    if r[0]["curriculo"]:
        try:
            os.remove(os.path.join(CAND_DIR, r[0]["curriculo"]))
        except FileNotFoundError:
            pass
    return {"ok": True, "nome": r[0]["nome"]}


def _gravar_curriculo(cid, conteudo: bytes, nome: str | None):
    if not conteudo or len(conteudo) > 15 * 1024 * 1024:
        raise HTTPException(422, "Arquivo vazio ou maior que 15 MB")
    tipo = next((t for t in TIPOS_CV if conteudo.startswith(t[0])), None)
    if not tipo:
        raise HTTPException(415, "Envie o currículo em PDF, foto (JPG/PNG) ou Word")
    antigo = q("select curriculo from fin_app.rh_candidatos where id = %s", (cid,))
    if not antigo:
        raise HTTPException(404, "Candidato não encontrado")
    os.makedirs(CAND_DIR, exist_ok=True)
    rel = f"{cid}-{uuid.uuid4().hex[:8]}.{tipo[1]}"
    with open(os.path.join(CAND_DIR, rel), "wb") as f:
        f.write(conteudo)
    q("""update fin_app.rh_candidatos set curriculo = %s, curriculo_nome = %s, curriculo_tipo = %s, atualizado_em = now()
         where id = %s returning id""", (rel, (nome or f"curriculo.{tipo[1]}")[:200], tipo[2], cid))
    if antigo[0]["curriculo"]:
        try:
            os.remove(os.path.join(CAND_DIR, antigo[0]["curriculo"]))
        except FileNotFoundError:
            pass


@router.post("/selecao/{cid}/curriculo")
def enviar_curriculo(cid: uuid.UUID, arquivo: UploadFile = File(...)):
    """Anexa (ou substitui) o currículo: PDF, foto (JPG/PNG) ou Word, até 15 MB."""
    _gravar_curriculo(cid, arquivo.file.read(15 * 1024 * 1024 + 1), arquivo.filename)
    return {"ok": True}


@router.post("/selecao/{cid}/curriculo-do-documento/{did}")
def curriculo_da_caixa(cid: uuid.UUID, did: uuid.UUID):
    """Currículo que chegou pela Caixa de entrada: copia o arquivo para o candidato e tira o documento da caixa."""
    import inbox
    with open(inbox._arquivo(did), "rb") as f:
        conteudo = f.read(15 * 1024 * 1024 + 1)
    doc = q("select nome from fin_app.documentos where id = %s", (did,))
    _gravar_curriculo(cid, conteudo, doc[0]["nome"] if doc else None)
    nome = q("select nome from fin_app.rh_candidatos where id = %s", (cid,))[0]["nome"]
    q("""update fin_app.documentos set status = 'processado', processado_em = now(), resumo = %s
         where id = %s returning id""", (f"Currículo de {nome} (RH › Candidatos)"[:300], did))
    return {"ok": True}


@router.get("/selecao/{cid}/curriculo")
def baixar_curriculo(cid: uuid.UUID):
    r = q("select curriculo, curriculo_nome, curriculo_tipo from fin_app.rh_candidatos where id = %s and curriculo is not null", (cid,))
    if not r:
        raise HTTPException(404, "Currículo não encontrado")
    return FileResponse(os.path.join(CAND_DIR, r[0]["curriculo"]), media_type=r[0]["curriculo_tipo"],
                        filename=r[0]["curriculo_nome"], content_disposition_type="inline")
