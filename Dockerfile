FROM python:3.12-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-por \
 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir fastapi==0.115.6 "uvicorn==0.32.1" "psycopg[binary]==3.2.3" \
    python-multipart==0.0.20 pdfplumber==0.11.4 pytesseract==0.3.13 pillow-heif==0.21.0 anthropic==1.15.0 \
    defusedxml==0.7.1 openpyxl==3.1.5 xlrd==2.0.1
WORKDIR /app
COPY main.py auth.py fin.py boleto.py caixa.py caixa_fluxo.py conferencia_nf.py producao.py cadastros.py extrato.py fichas.py afazeres.py cardapio.py checklists.py compras.py empresa.py estoque.py inbox.py rh.py portal.py /app/
COPY static /app/static
ENV PYTHONUNBUFFERED=1 TZ=America/Sao_Paulo ANEXOS_DIR=/data/anexos
USER nobody
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
