FROM python:3.12-slim
RUN pip install --no-cache-dir requests==2.32.3 "psycopg[binary]==3.2.3" google-auth==2.35.0
WORKDIR /app
COPY *.py *.sql /app/
ENV PYTHONUNBUFFERED=1 TZ=America/Sao_Paulo
ENTRYPOINT ["python", "-I"]
