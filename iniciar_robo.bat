@echo off
title CAVEIRA BOT - CCOS WHATSAPP MONITOR
color 0A
echo ========================================================
echo       CAVEIRA BOT - CCOS PORTO DO ACU
echo   MONITOR SILENCIOSO DE WHATSAPP + DISPARO DE E-MAILS
echo ========================================================
echo.
echo [1/2] Verificando dependencias necessarias...
call npm install --silent
echo.
echo [2/2] Iniciando o motor do WhatsApp...
echo Aguarde o QR Code oficial aparecer na tela abaixo!
echo.
echo Quando o QR Code aparecer:
echo 1. Abra o WhatsApp no seu celular
echo 2. Toque em 'Aparelhos Conectados' > 'Conectar um Aparelho'
echo 3. Aponte a camera para o QR Code abaixo:
echo ========================================================
echo.
node index.js
pause

