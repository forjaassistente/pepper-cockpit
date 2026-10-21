"""Cadastro do restaurante: nome que aparece no app (barra lateral, login, título, mensagens), dados fiscais,
contato, endereço e logo. O nome e o logo são públicos (aparecem na tela de login); o resto é só para o admin."""
import io
import os
import re

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from PIL import Image, ImageOps
from pydantic import BaseModel, Field, field_validator

import boleto
from fin import q

router = APIRouter(prefix="/api/empresa")
DIR = os.path.join(boleto.ANEXOS_DIR, "empresa")
UFS = {"AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN",
       "RS", "RO", "RR", "SC", "SP", "SE", "TO"}
SEGMENTOS = ["Hamburgueria", "Hamburgueria e petiscaria", "Pizzaria", "Restaurante", "Bar", "Lanchonete", "Padaria",
             "Pastelaria", "Cafeteria", "Sorveteria", "Food truck", "Outro"]


def nome() -> str:
    """Nome do restaurante para textos (mensagens, prompts da IA)."""
    r = q("select nome_fantasia from fin_app.empresa where id = 1")
    return r[0]["nome_fantasia"] if r else "o restaurante"


@router.get("/publico")
def publico():
    r = q("select nome_fantasia, logo is not null as tem_logo, atualizado_em from fin_app.empresa where id = 1")
    return r[0] if r else {"nome_fantasia": "Cockpit", "tem_logo": False}


@router.get("/publico/logo")
def logo():
    r = q("select logo from fin_app.empresa where id = 1 and logo is not null")
    if not r or not os.path.isfile(os.path.join(DIR, r[0]["logo"])):
        raise HTTPException(404, "Sem logo")
    return FileResponse(os.path.join(DIR, r[0]["logo"]), media_type="image/png", headers={"Cache-Control": "no-cache"})


@router.get("")
def dados():
    return q("select * from fin_app.empresa where id = 1")[0] | {"segmentos": SEGMENTOS}


class Empresa(BaseModel):
    nome_fantasia: str = Field(min_length=1, max_length=80)
    razao_social: str | None = Field(None, max_length=150)
    cnpj: str | None = Field(None, max_length=20)
    inscricao_estadual: str | None = Field(None, max_length=20)
    segmento: str | None = Field(None, max_length=60)
    telefone: str | None = Field(None, max_length=20)
    whatsapp: str | None = Field(None, max_length=20)
    email: str | None = Field(None, max_length=120)
    instagram: str | None = Field(None, max_length=60)
    site: str | None = Field(None, max_length=120)
    cep: str | None = Field(None, max_length=9)
    logradouro: str | None = Field(None, max_length=120)
    numero: str | None = Field(None, max_length=20)
    complemento: str | None = Field(None, max_length=60)
    bairro: str | None = Field(None, max_length=60)
    cidade: str | None = Field(None, max_length=60)
    uf: str | None = Field(None, max_length=2)

    @field_validator("*", mode="before")
    @classmethod
    def _limpa(cls, v):
        return (v.strip() or None) if isinstance(v, str) else v

    @field_validator("cnpj", "telefone", "whatsapp", "cep")
    @classmethod
    def _digitos(cls, v):
        return re.sub(r"\D", "", v) or None if v else None

    @field_validator("uf")
    @classmethod
    def _uf(cls, v):
        if v and v.upper() not in UFS:
            raise ValueError("UF inválida (use a sigla do estado, ex.: SC)")
        return v.upper() if v else None

    @field_validator("instagram")
    @classmethod
    def _insta(cls, v):
        return re.sub(r"^(https?://)?(www\.)?instagram\.com/|^@", "", v).strip("/") or None if v else None


@router.put("")
def salvar(e: Empresa):
    d = e.model_dump()
    q(f"update fin_app.empresa set {', '.join(f'{k} = %({k})s' for k in d)}, atualizado_em = now() where id = 1 returning id", d)
    return dados()


def _abrir(conteudo: bytes) -> Image.Image:
    if not conteudo or len(conteudo) > 5 * 1024 * 1024:
        raise HTTPException(422, "Imagem vazia ou maior que 5 MB")
    try:
        return ImageOps.exif_transpose(Image.open(io.BytesIO(conteudo))).convert("RGBA")
    except Exception:
        raise HTTPException(415, "Envie uma imagem (PNG, JPG ou WebP)")


@router.post("/logo")
def enviar_logo(arquivo: UploadFile = File(...), original: UploadFile | None = File(None)):
    """Logo recortado no editor (PNG até 5 MB) → PNG quadrado de até 256 px. A imagem original vem junto e fica
    guardada para reajustar depois sem perder qualidade."""
    img = _abrir(arquivo.file.read(5 * 1024 * 1024 + 1))
    if original is not None:
        orig = _abrir(original.file.read(5 * 1024 * 1024 + 1))
        orig.thumbnail((1600, 1600))
        os.makedirs(DIR, exist_ok=True)
        orig.save(os.path.join(DIR, "logo_original.png"), optimize=True)
    lado = max(img.size)                     # centraliza num quadrado transparente para caber no círculo
    quadro = Image.new("RGBA", (lado, lado), (0, 0, 0, 0))
    quadro.paste(img, ((lado - img.width) // 2, (lado - img.height) // 2))
    quadro.thumbnail((256, 256))
    os.makedirs(DIR, exist_ok=True)
    quadro.save(os.path.join(DIR, "logo.png"), optimize=True)
    q("update fin_app.empresa set logo = 'logo.png', atualizado_em = now() where id = 1 returning id")
    return {"ok": True}


@router.get("/logo/original")
def logo_original():
    """Imagem enviada antes do recorte (para o admin reajustar); sem ela, o logo atual."""
    for nome_arq in ("logo_original.png", "logo.png"):
        caminho = os.path.join(DIR, nome_arq)
        if os.path.isfile(caminho):
            return FileResponse(caminho, media_type="image/png", headers={"Cache-Control": "no-store"})
    raise HTTPException(404, "Sem logo")


@router.delete("/logo")
def remover_logo():
    q("update fin_app.empresa set logo = null, atualizado_em = now() where id = 1 returning id")
    for nome_arq in ("logo.png", "logo_original.png"):
        try:
            os.remove(os.path.join(DIR, nome_arq))
        except FileNotFoundError:
            pass
    return {"ok": True}
