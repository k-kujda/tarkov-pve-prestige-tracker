# Two images from one file (docker-compose.yml picks the target):
#   tracker - the zero-dependency Node server
#   navmesh - Python (UnityPy) + Node (Recast) for tools/build_all.sh, so nothing is installed on the PC
ARG NODE_IMAGE=node:24.19.0-bookworm-slim
ARG PYTHON_IMAGE=python:3.13.3-slim-bookworm

FROM ${NODE_IMAGE} AS node

# ---------- tracker ----------
FROM node AS tracker
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4747 TARKOV_LOGS=/tarkov/Logs
WORKDIR /app
COPY --chown=node:node server.js gamelogs.js gunsmith.js nav.js nav-worker.js index.html ./
COPY --chown=node:node data ./data
# cache/ is a volume and navmesh/ a bind mount of the built meshes (docker-compose.yml)
RUN mkdir -p cache navmesh && chown node:node cache navmesh
USER node
EXPOSE 4747
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:4747/').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "server.js"]

# ---------- navmesh builder ----------
FROM node AS recast
WORKDIR /opt/recast
COPY docker/navmesh/package.json docker/navmesh/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM ${PYTHON_IMAGE} AS navmesh
ENV PYTHONUNBUFFERED=1 PYTHONIOENCODING=utf-8 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PY=python RECAST_DIR=/opt/recast
COPY docker/navmesh/requirements.txt /tmp/requirements.txt
RUN pip install -r /tmp/requirements.txt && rm /tmp/requirements.txt
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=recast /opt/recast /opt/recast
RUN useradd --create-home --uid 1000 builder
USER builder
# The repo is bind-mounted here so the meshes land in navmesh/ and data/ on the host
WORKDIR /app
ENTRYPOINT ["bash", "tools/build_all.sh", "/game"]
