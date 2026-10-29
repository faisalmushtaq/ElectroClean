# The ElectroTag server in a container (optional: real studies run on Firebase, docs/web/firebase.md).
#
#   docker build -t electrotag-web .
#   docker run -p 8000:8000 -e ELECTROTAG_DEMO=1 electrotag-web                     the demonstration
#   docker run -p 8000:8000 -v /srv/study:/data/study electrotag-web                   a study folder
#
# The study folder is /data/study (ELECTROTAG_STUDY_DIR); keep it on a persistent volume.
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    MNE_DONTWRITE_HOME=true \
    MPLBACKEND=Agg \
    ELECTROTAG_STUDY_DIR=/data/study \
    ELECTROTAG_DEMO_DIR=/data/demo \
    HOST=0.0.0.0 \
    PORT=8000

WORKDIR /app
COPY requirements.txt ./
RUN python -m pip install -r requirements.txt
COPY pyproject.toml README.md LICENSE.md THIRD_PARTY_NOTICES.md ./
COPY electrotag ./electrotag
RUN python -m pip install --no-deps . && useradd --create-home electrotag && mkdir -p /data \
    && chown electrotag /data
USER electrotag
VOLUME ["/data"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/api/v1/health' % os.environ.get('PORT', '8000'))"
CMD ["sh", "-c", "if [ \"$ELECTROTAG_DEMO\" = 1 ]; then exec electrotag-web demo; else exec electrotag-web serve; fi"]
