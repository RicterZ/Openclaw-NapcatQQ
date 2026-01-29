# syntax=docker/dockerfile:1

FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY pyproject.toml poetry.lock /app/
RUN pip install --no-cache-dir .
COPY src /app/src
COPY env.example /app/.env

# Default Napcat URL; override via environment
ENV NAPCAT_URL=ws://192.168.13.100:3001

# Default command: watch QQ messages (stdout JSON)
CMD ["nap-msg", "watch"]
