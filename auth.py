"""Login por CPF + senha, sessões e perfis (admin, responsável de caixa, funcionário).

- Senha: scrypt com sal aleatório; nunca é guardada nem registrada em log.
- Sessão: token aleatório num cookie HttpOnly/SameSite=Strict; no banco fica só o sha256 do token.
- Proteção: 5 senhas erradas bloqueiam o CPF por 15 min; limite de falhas por IP.
- Primeiro acesso: link com token de uso único (72 h) para o funcionário criar a senha.
- Configuração inicial: só funciona enquanto não existe nenhum usuário (cria o primeiro admin).
"""
import datetime as dt
import hashlib
import hmac
import os
import re
import secrets
import time
from collections import defaultdict, deque

import psycopg
from fastapi import APIRouter, HTTPException, Request, Response
from psycopg.rows import dict_row
from pydantic import BaseModel, Field, field_validator

from fin import DSN, _conv, q

router = APIRouter(prefix="/api/auth")
COOKIE = "cockpit_sessao"
SESSAO_DIAS = 7
MAX_FALHAS, BLOQUEIO_MIN = 5, 15
FALHAS_IP_MAX, FALHAS_IP_JANELA = 30, 15 * 60
CONVITE_HORAS = 72
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "0") == "1"   # liga quando estiver atrás de HTTPS (etapa 2)
_falhas_ip: dict[str, deque] = defaultdict(deque)


# ------------------------------------------------------------------ utilitários
def hash_senha(senha: str) -> str:
    sal = secrets.token_bytes(16)
    h = hashlib.scrypt(senha.encode(), salt=sal, n=2 ** 15, r=8, p=1, maxmem=64 * 1024 * 1024, dklen=32)
    return f"scrypt$32768$8$1${sal.hex()}${h.hex()}"


def confere_senha(senha: str, guardado: str | None) -> bool:
    if not guardado:
        # gasta o mesmo tempo para não revelar se o CPF existe
        hashlib.scrypt(senha.encode(), salt=b"x" * 16, n=2 ** 15, r=8, p=1, maxmem=64 * 1024 * 1024, dklen=32)
        return False
    try:
        _, n, r, p, sal, h = guardado.split("$")
    except ValueError:      # hash corrompido: trata como senha errada, nunca como erro 500
        return False
    calc = hashlib.scrypt(senha.encode(), salt=bytes.fromhex(sal), n=int(n), r=int(r), p=int(p),
                          maxmem=64 * 1024 * 1024, dklen=len(bytes.fromhex(h)))
    return hmac.compare_digest(calc.hex(), h)


def sha(t: str) -> str:
    return hashlib.sha256(t.encode()).hexdigest()


def so_digitos(cpf: str) -> str:
    return re.sub(r"\D", "", cpf or "")


def cpf_valido(cpf: str) -> bool:
    c = so_digitos(cpf)
    if len(c) != 11 or c == c[0] * 11:
        return False
    for i in (9, 10):
        soma = sum(int(c[j]) * ((i + 1) - j) for j in range(i))
        if (soma * 10 % 11) % 10 != int(c[i]):
            return False
    return True


COMUNS = {"senha123", "password", "12345678", "123456789", "qwerty123", "pepper123", "peppersally"}


def valida_senha(senha: str, cpf: str = "") -> str:
    if len(senha) < 8:
        raise HTTPException(422, "A senha precisa ter pelo menos 8 caracteres")
    if not re.search(r"[A-Za-zÀ-ÿ]", senha) or senha.isdigit():
        raise HTTPException(422, "Use letras e números na senha (só números não vale)")
    if len(set(senha)) < 4 or senha.lower() in COMUNS:
        raise HTTPException(422, "Senha muito fácil de adivinhar. Escolha outra.")
    if cpf and so_digitos(cpf) in re.sub(r"\D", "", senha):
        raise HTTPException(422, "Não use o seu CPF na senha")
    return senha


def _ip(req: Request) -> str:
    return (req.headers.get("x-forwarded-for", "").split(",")[0].strip()
            or (req.client.host if req.client else "?"))


def log(evento: str, usuario_id=None, cpf=None, ip=None):
    q("insert into fin_app.acessos_log (usuario_id, cpf, evento, ip) values (%s, %s, %s, %s) returning id",
      (usuario_id, cpf, evento, ip))


def criar_sessao(resp: Response, usuario_id, req: Request):
    token = secrets.token_urlsafe(32)
    q("""insert into fin_app.sessoes (token_hash, usuario_id, expira_em, ip, agente)
         values (%s, %s, now() + make_interval(days => %s), %s, %s) returning token_hash""",
      (sha(token), usuario_id, SESSAO_DIAS, _ip(req), (req.headers.get("user-agent") or "")[:200]))
    resp.set_cookie(COOKIE, token, max_age=SESSAO_DIAS * 86400, httponly=True, samesite="strict",
                    secure=COOKIE_SECURE, path="/")


def usuario_por_token(token: str | None) -> dict | None:
    """Usado pelo middleware em toda requisição /api."""
    if not token:
        return None
    r = q("""select u.id, u.nome, u.cpf, u.perfil, u.pessoa_id, u.estoque_setores
             from fin_app.sessoes s join fin_app.usuarios u on u.id = s.usuario_id
             where s.token_hash = %s and s.expira_em > now() and u.ativo""", (sha(token),))
    return r[0] if r else None


def novo_convite(cur, usuario_id) -> str:
    token = secrets.token_urlsafe(24)
    cur.execute("""update fin_app.usuarios set convite_hash = %s, convite_expira = now() + make_interval(hours => %s),
                     atualizado_em = now() where id = %s""", (sha(token), CONVITE_HORAS, usuario_id))
    return token


# ------------------------------------------------------------------ endpoints
class Login(BaseModel):
    cpf: str = Field(max_length=20)
    senha: str = Field(max_length=200)


class Configurar(BaseModel):
    nome: str = Field(min_length=2, max_length=120)
    cpf: str = Field(max_length=20)
    senha: str = Field(max_length=200)

    @field_validator("cpf")
    @classmethod
    def _cpf(cls, v):
        if not cpf_valido(v):
            raise ValueError("CPF inválido")
        return so_digitos(v)


class DefinirSenha(BaseModel):
    token: str = Field(max_length=100)
    senha: str = Field(max_length=200)


@router.get("/estado")
def estado():
    return {"configurado": bool(q("select 1 from fin_app.usuarios where perfil = 'admin' and ativo limit 1"))}


@router.post("/configurar")
def configurar(c: Configurar, req: Request, resp: Response):
    valida_senha(c.senha, c.cpf)
    with psycopg.connect(**DSN, row_factory=dict_row) as conn, conn.transaction():
        conn.execute("lock table fin_app.usuarios in exclusive mode")
        if conn.execute("select 1 from fin_app.usuarios where perfil = 'admin' and ativo limit 1").fetchone():
            raise HTTPException(409, "O sistema já foi configurado. Entre com seu CPF e senha.")
        pessoa = conn.execute("""select id from fin_app.pessoas
                                 where regexp_replace(coalesce(documento, ''), '\\D', '', 'g') = %s limit 1""",
                              (c.cpf,)).fetchone()
        uid = conn.execute("""insert into fin_app.usuarios (nome, cpf, perfil, senha_hash, pessoa_id)
                              values (%s, %s, 'admin', %s, %s) returning id""",
                           (c.nome.strip(), c.cpf, hash_senha(c.senha), pessoa["id"] if pessoa else None)).fetchone()["id"]
    log("configuracao_inicial", uid, c.cpf, _ip(req))
    criar_sessao(resp, uid, req)
    return {"ok": True}


@router.post("/login")
def login(l: Login, req: Request, resp: Response):
    ip = _ip(req)
    agora = time.time()
    fila = _falhas_ip[ip]
    while fila and fila[0] < agora - FALHAS_IP_JANELA:
        fila.popleft()
    if len(fila) >= FALHAS_IP_MAX:
        raise HTTPException(429, "Muitas tentativas. Aguarde alguns minutos.")
    cpf = so_digitos(l.cpf)
    u = q("select * from fin_app.usuarios where cpf = %s and ativo", (cpf,)) if len(cpf) == 11 else []
    u = u[0] if u else None
    if u and u["bloqueado_ate"] and dt.datetime.fromisoformat(u["bloqueado_ate"]) > dt.datetime.now(dt.timezone.utc):
        raise HTTPException(429, f"Acesso bloqueado por segurança. Tente de novo em {BLOQUEIO_MIN} minutos.")
    if not confere_senha(l.senha, u["senha_hash"] if u else None):
        fila.append(agora)
        if u:
            falhas = u["falhas"] + 1
            q("""update fin_app.usuarios set falhas = %s,
                   bloqueado_ate = case when %s >= %s then now() + make_interval(mins => %s) end
                 where id = %s returning id""", (falhas, falhas, MAX_FALHAS, BLOQUEIO_MIN, u["id"]))
            log("bloqueio" if falhas >= MAX_FALHAS else "login_falha", u["id"], cpf, ip)
        else:
            log("login_falha", None, cpf or None, ip)
        raise HTTPException(401, "CPF ou senha incorretos")
    q("update fin_app.usuarios set falhas = 0, bloqueado_ate = null, ultimo_login = now() where id = %s returning id",
      (u["id"],))
    log("login_ok", u["id"], cpf, ip)
    criar_sessao(resp, u["id"], req)
    return {"ok": True, "perfil": u["perfil"]}


@router.post("/logout")
def logout(req: Request, resp: Response):
    token = req.cookies.get(COOKIE)
    if token:
        u = usuario_por_token(token)
        q("delete from fin_app.sessoes where token_hash = %s returning token_hash", (sha(token),))
        if u:
            log("logout", u["id"], u["cpf"], _ip(req))
    resp.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@router.get("/eu")
def eu(req: Request):
    u = usuario_por_token(req.cookies.get(COOKIE))
    if not u:
        raise HTTPException(401, "Não autenticado")
    return {k: _conv(v) for k, v in u.items() if k != "cpf"} | {"cpf_final": u["cpf"][-3:]}


@router.get("/convite")
def ver_convite(t: str):
    r = q("""select nome from fin_app.usuarios where convite_hash = %s and convite_expira > now() and ativo""", (sha(t),))
    if not r:
        raise HTTPException(404, "Link inválido ou vencido. Peça um novo ao administrador.")
    return {"nome": r[0]["nome"].split(" ")[0]}


@router.post("/definir-senha")
def definir_senha(d: DefinirSenha, req: Request, resp: Response):
    with psycopg.connect(**DSN, row_factory=dict_row) as conn, conn.transaction():
        u = conn.execute("""select id, cpf from fin_app.usuarios
                            where convite_hash = %s and convite_expira > now() and ativo for update""",
                         (sha(d.token),)).fetchone()
        if not u:
            raise HTTPException(404, "Link inválido ou vencido. Peça um novo ao administrador.")
        valida_senha(d.senha, u["cpf"])
        conn.execute("""update fin_app.usuarios set senha_hash = %s, convite_hash = null, convite_expira = null,
                          falhas = 0, bloqueado_ate = null, atualizado_em = now() where id = %s""",
                     (hash_senha(d.senha), u["id"]))
        conn.execute("delete from fin_app.sessoes where usuario_id = %s", (u["id"],))   # derruba sessões antigas
    log("senha_definida", u["id"], u["cpf"], _ip(req))
    criar_sessao(resp, u["id"], req)
    return {"ok": True}


# ------------------------------------------------------------------ autorização (usada no middleware)
ROTAS_PUBLICAS = ("/api/health", "/api/auth/", "/api/empresa/publico")   # nome e logo aparecem no login


def permitido(perfil: str, metodo: str, caminho: str) -> bool:
    if caminho.startswith("/api/portal/"):
        return True                                   # cada um só vê o próprio (portal.py usa a sessão)
    if caminho.startswith("/api/fin/caixa/"):
        if perfil == "admin":
            return True
        return perfil == "responsavel_caixa" and not caminho.endswith(("/reabrir", "/conferir", "/pago"))   # só admin
    return perfil == "admin"                          # todo o resto: só admin
