"""Portal do funcionário: cada pessoa só vê e registra o que é dela.
A pessoa vem SEMPRE da sessão (request.state.usuario), nunca de parâmetro da requisição."""
import datetime as dt
import io
import os
import uuid

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from PIL import Image, ImageOps

import rh
from fin import q

router = APIRouter(prefix="/api/portal")
INTERVALO_MIN_SEG = 60           # evita batida dupla sem querer


def _pessoa(req: Request):
    pid = req.state.usuario.get("pessoa_id")
    if not pid:
        raise HTTPException(409, "Seu login ainda não está ligado a uma ficha de funcionário. Fale com o administrador.")
    return pid


def _proxima(pid) -> str:
    ult = q(f"""select tipo from fin_app.rh_ponto
                where pessoa_id = %s and cancelado_em is null
                  and (momento at time zone '{rh.TZ}')::date = (now() at time zone '{rh.TZ}')::date
                order by momento desc limit 1""", (pid,))
    return "saida" if ult and ult[0]["tipo"] == "entrada" else "entrada"


@router.get("/eu")
def eu(req: Request):
    u = req.state.usuario
    out = {"nome": u["nome"], "perfil": u["perfil"], "ficha": None}
    if u.get("pessoa_id"):
        f = q("""select f.cargo, f.vinculo, f.admissao, p.nome from fin_app.rh_funcionarios f
                 join fin_app.pessoas p on p.id = f.pessoa_id where f.pessoa_id = %s""", (u["pessoa_id"],))
        out["ficha"] = f[0] if f else None
        out["proxima_batida"] = _proxima(u["pessoa_id"])
        out["hoje"] = q(f"""select tipo, to_char(momento at time zone '{rh.TZ}', 'HH24:MI') as hora, origem
                            from fin_app.rh_ponto where pessoa_id = %s and cancelado_em is null
                              and (momento at time zone '{rh.TZ}')::date = (now() at time zone '{rh.TZ}')::date
                            order by momento""", (u["pessoa_id"],))
    return out


@router.post("/ponto")
def bater_ponto(req: Request, foto: UploadFile = File(...), lat: str = Form(""), lng: str = Form(""),
                precisao: str = Form("")):
    pid = _pessoa(req)
    recente = q("select 1 from fin_app.rh_ponto where pessoa_id = %s and cancelado_em is null "
                "and momento > now() - make_interval(secs => %s)", (pid, INTERVALO_MIN_SEG))
    if recente:
        raise HTTPException(429, "Você acabou de registrar. Espere um minuto para registrar de novo.")
    bruto = foto.file.read(12 * 1024 * 1024 + 1)
    if not bruto or len(bruto) > 12 * 1024 * 1024:
        raise HTTPException(422, "A foto é obrigatória (até 12 MB)")
    try:   # recomprime: tira metadados e reduz o tamanho
        img = ImageOps.exif_transpose(Image.open(io.BytesIO(bruto))).convert("RGB")
        img.thumbnail((900, 900))
    except Exception:
        raise HTTPException(415, "Não consegui ler a foto")
    bid = uuid.uuid4()
    rel = f"{pid}/{bid}.jpg"
    os.makedirs(os.path.join(rh.PONTO_DIR, str(pid)), exist_ok=True)
    img.save(os.path.join(rh.PONTO_DIR, rel), "JPEG", quality=80)

    def num(v, lim):
        try:
            x = float(v)
            return x if abs(x) <= lim else None
        except ValueError:
            return None
    tipo = _proxima(pid)
    r = q(f"""insert into fin_app.rh_ponto (id, pessoa_id, tipo, lat, lng, precisao_m, foto, origem, registrado_por)
              values (%s, %s, %s, %s, %s, %s, %s, 'portal', %s)
              returning tipo, to_char(momento at time zone '{rh.TZ}', 'HH24:MI') as hora""",
          (bid, pid, tipo, num(lat, 90), num(lng, 180), num(precisao, 100000), rel, req.state.usuario["id"]))
    return r[0]


@router.get("/ponto")
def meu_ponto(req: Request, mes: str | None = None):
    return rh.espelho(_pessoa(req), mes)


@router.get("/resumo")
def resumo(req: Request, mes: str | None = None):
    pid = _pessoa(req)
    ini, fim = rh._mes(mes)
    return {
        "mes": ini.isoformat()[:7],
        "lancamentos": q("""select tipo, data, valor, descricao, status from fin_app.rh_lancamentos
                            where pessoa_id = %s and competencia = %s and cancelado_em is null order by data""", (pid, ini)),
        # pagamentos que o restaurante fez para esta pessoa (salário, vale, free lance…), pelo financeiro
        "pagamentos": q("""select data_pagamento, descricao, categoria_nome, valor_pago from fin_app.v_titulos
                           where contato_id = %s and tipo = 'pagar' and status = 'pago'
                             and data_pagamento between %s and %s order by data_pagamento""", (pid, ini, fim)),
        "documentos": q("""select id, tipo, competencia, nome, visto_em from fin_app.rh_documentos
                           where pessoa_id = %s and cancelado_em is null order by competencia desc nulls last, criado_em desc
                           limit 24""", (pid,)),
    }


@router.get("/documentos/{did}/arquivo")
def meu_documento(did: uuid.UUID, req: Request):
    pid = _pessoa(req)
    resp = rh.arquivo_documento(did, pessoa_id=pid)          # 404 se não for desta pessoa
    q("update fin_app.rh_documentos set visto_em = coalesce(visto_em, now()) where id = %s returning id", (did,))
    return resp
