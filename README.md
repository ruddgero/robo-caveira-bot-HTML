# 💀 CAVEIRA BOT ERP - SISTEMA OPERACIONAL CCOS

Sistema Integrado de Gestão Operacional e Monitoramento Portuário (T-ORE & T-OIL - Porto do Açu), desenvolvido para o Líder Ruddgero Ribeiro.

---

## 🚀 Como Colocar no GitHub & GitHub Pages (Passo a Passo)

### 1. Criar o Repositório no GitHub
1. Acesse [github.com](https://github.com) e entre na sua conta.
2. Clique no botão verde **New** para criar um novo repositório.
3. Nomeie o repositório como `caveira-bot` (ou `ccos-app`).
4. Deixe como **Public** e clique em **Create repository**.

### 2. Subir os Arquivos
1. Na tela do repositório, clique em **uploading an existing file** (fazer upload).
2. Arraste os arquivos da sua pasta para o GitHub, em especial:
   - `index.html` (O App Web completo)
   - `README.md`
   - `package.json`
   - `bot_ccos_whatsapp.js`
   - `bot_ccos.js`
   - `index.js`
3. Clique em **Commit changes**.

### 3. Ativar o GitHub Pages (Para rodar no celular/navegador)
1. No repositório, clique na aba **Settings** (Configurações).
2. Na barra lateral esquerda, clique em **Pages**.
3. Em **Branch**, selecione `main` (ou `master`) e `/ (root)`, depois clique em **Save**.
4. Em menos de 2 minutos, o GitHub vai gerar o link público seguro (com HTTPS):
   👉 `https://seu-usuario.github.io/caveira-bot/`
5. Abra esse link no celular e clique em **"Adicionar à tela de início"** para virar um App com ícone.

---

## 📲 Como Espelhar o WhatsApp no Robô

O robô utiliza o motor Baileys Multi-Device (funciona exatamente igual ao WhatsApp Web):

1. No computador ou servidor (Render):
   ```bash
   node bot_ccos_whatsapp.js
   ```
2. Um QR Code será exibido no terminal.
3. No seu celular (com a sua conta de WhatsApp):
   - Vá em **Configurações > Aparelhos Conectados > Conectar um Aparelho**.
   - Aponte a câmera para o QR Code.
4. **Pronto!** O robô agora está conectado à sua conta e começará a monitorar os grupos silenciosamente.

---

## 🔒 Regras de Segurança e Silêncio nos Grupos

- **Silêncio Absoluto:** O robô nunca envia mensagens, confirmações ou emojis dentro dos grupos monitorados.
- **Filtro Anti-Spam:** Saudações como "bom dia", risos e agradecimentos são descartados para não poluir o relatório.
- **Alerta S.O.S no Privado:** Se for detectada palavra crítica (*acidente, incêndio, ferido, ambulância*), um alerta é enviado imediatamente para o privado do Líder Ruddgero.
- **Amarração de Veículos:** Ao detectar a mensagem de saída na portaria com a placa do veículo, o robô busca a entrada correspondente e anexa `Saída às XX:XXh.`

---

## ✉️ Módulo de E-mails Operacionais (Rancho, Tripulantes e Resíduos)

- **Regra Operacional:** Os e-mails só são liberados para disparo após a conclusão e confirmação de saída do veículo (Horário Inicial + Horário Final cravados).
- **Envio com 1 Clique:**
  - **Outlook Web (Office 365):** Abre a página corporativa com destinatários, assunto e minuta oficial preenchidos.
  - **App do Outlook:** Abre o cliente local instalado.
  - **SMTP Automático:** Se configuradas as variáveis de SMTP no `.env`, o robô dispara o e-mail em segundo plano de forma 100% autônoma.

---

## 🏁 Assistente de Fechamento de Plantão (8 Seções)

O botão **"Concluir Turno & Fechar Plantão"** executa o Wizard de 8 etapas:
1. **Efetivo CCOS**
2. **Viatura VTR L200** (Herda automaticamente o KM final do plantão anterior para o inicial deste plantão)
3. **Sistemas CFTV, CA e OCR**
4. **Atividades Realizadas** (Base padrão mantida fixa: Administrativas e Ronda)
5. **Avisos e Ações de Acompanhamento**
6. **Movimentação de Navios (T-ORE e T-OIL)**
7. **Ocorrências**
8. **Passagem de Turno de Equipes**

Ao finalizar, você tem os botões de **Copiar**, **Baixar arquivo .TXT oficial** e **Disparar nos Grupos**.

