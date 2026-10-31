@echo off
rem Runs the tracker in Docker (Docker Desktop) instead of Node on this PC: see "Docker" in README.md
cd /d "%~dp0"
where docker >nul 2>nul || (echo Docker Desktop is required: https://www.docker.com/products/docker-desktop/ & pause & exit /b 1)
if not exist .env (
  copy .env.example .env >nul
  echo Set TARKOV_DIR in .env to your Escape from Tarkov folder, save it, then run this again.
  notepad .env
  exit /b 1
)
docker compose up -d --build || (pause & exit /b 1)
start "" http://localhost:4747
