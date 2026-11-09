@echo off
rem Windows launcher for the loopback embedding gateway.
rem The API key is read from the environment and is never stored in this file.
rem
rem   set DOCUMIND_API_KEY=<your-key>
rem   tools\embed-gateway\start.cmd
setlocal
if "%EMBED_UPSTREAM_BASE%"=="" set "EMBED_UPSTREAM_BASE=https://llms.documind.bosch-app.com/v1"
if "%EMBED_UPSTREAM_MODEL%"=="" set "EMBED_UPSTREAM_MODEL=qwen3.7-text-embedding"
if "%EMBED_PORT%"=="" set "EMBED_PORT=8790"
if "%EMBED_HOST%"=="" set "EMBED_HOST=127.0.0.1"

if "%DOCUMIND_API_KEY%"=="" (
  echo embed-gateway: DOCUMIND_API_KEY is not set; upstream calls will be unauthenticated.
)

node "%~dp0shim.mjs"
endlocal
