# VieNeu-TTS v3 Turbo model service (ADR 0008). NOT built or run by the project's QA yet: see docs/upgrade/09-AI-ENGINE-CAPACITY.md.
FROM python:3.12-slim-bookworm AS base
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 HF_HOME=/models
RUN apt-get update && apt-get install -y --no-install-recommends libsndfile1 espeak-ng tini \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 vieneu
WORKDIR /app
COPY services/vieneu/requirements.txt .
RUN pip install -r requirements.txt
# Download the weights at BUILD time (this step needs internet) so the running container needs none and can sit
# on an internal-only network. The weights are the model's own Apache-2.0 artifacts, kept inside this image only.
RUN python -c "from vieneu import Vieneu; Vieneu()" && chown -R vieneu /models
COPY services/vieneu/server.py .
USER vieneu
ENV HF_HUB_OFFLINE=1 VIENEU_HOST=0.0.0.0 VIENEU_PORT=8765
EXPOSE 8765
HEALTHCHECK --interval=15s --timeout=5s --retries=10 CMD python -c "import urllib.request,sys;sys.exit(0 if b'\"ready\":true' in urllib.request.urlopen('http://127.0.0.1:8765/v1/health').read() else 1)"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python", "server.py"]
