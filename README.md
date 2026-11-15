# 💀 Caveira Bot · CCOS Porto do Açu — v3

Painel para montar o **Relatório do Turno** sem retrabalho:

1. O robô lê **só** o grupo de trabalho que você escolher (ex.: *EQUIPE AZUL - US FERROPORT*).
2. Quando a equipe anterior posta o **RELATÓRIO DO TURNO**, ele aparece na aba **Turno**. Com um toque você herda o KM da VTR, os sistemas, os navios e a equipe.
3. As mensagens operacionais do grupo caem na aba **Entrada**. Cada uma vai para o destino que você escolher: Atividade, Ocorrência, Aviso, Navios, Operação de bordo (gera e-mail) ou Saída de veículo.
4. Na aba **Relatório** você edita as 8 seções e publica no grupo **exatamente** o texto da Prévia, ou copia, baixa o .txt ou gera o PDF.

> O robô **nunca escreve no grupo sozinho**. Só publica quando você aperta "Publicar".

---

## 📁 O que tem no pacote

| Arquivo / pasta | Para que serve |
|---|---|
| `index.js` | Liga tudo (`npm start`) |
| `src/` | Servidor, leitor do WhatsApp e regras do relatório |
| `public/` | A tela do aplicativo (celular e computador) |
| `.env.example` | Modelo das configurações secretas |
| `Dockerfile` | Usado só se for rodar no Render |
| `test/` | Teste com o relatório real do Wallace (`npm test`) |

Os arquivos antigos (`bot_ccos.js`, `bot_ccos_whatsapp.js`, `app_caveira_bot.html`, `iniciar_robo.bat`, `ultimo_relatorio_us.json`, `manifest.json`/`sw.js` da raiz) **não são mais usados**. Pode apagar.

---

## ⚠️ Antes de começar (importante)

- **Use um chip só para o robô**, não o seu número pessoal. A biblioteca do WhatsApp usada não é oficial, e o WhatsApp pode bloquear números que usam esse tipo de conexão.
- **Alinhe com seu gestor / Segurança da Informação.** O robô guarda mensagens do grupo de trabalho.
- **Deixe o repositório do GitHub PRIVADO.** O projeto antigo estava público e expunha nomes, IDs, e-mails e quais câmeras estavam fora.

---

## 🖥️ Opção A — Rodar num computador (recomendado para começar)

Funciona enquanto o computador estiver ligado. Os dados ficam na pasta `dados`.

### 1. Instale o Node.js
Baixe a versão **LTS** em https://nodejs.org e instale (Avançar, Avançar, Concluir).

### 2. Prepare a pasta
1. Extraia o `.zip` numa pasta, por exemplo `C:\caveira-bot`.
2. Faça uma cópia do arquivo `.env.example` e renomeie a cópia para `.env`.
3. Abra o `.env` no Bloco de Notas e troque `APP_SENHA=troque-esta-senha` por uma senha sua (mínimo 8 caracteres). Salve.

> No Windows, se não aparecer a extensão dos arquivos: Explorador de Arquivos → Exibir → marque "Extensões de nomes de arquivos".

### 3. Instale e ligue
1. Abra a pasta, clique com o botão direito num espaço vazio → **Abrir no Terminal**.
2. Digite e aperte Enter (só na primeira vez, demora um pouco):
   ```
   npm install
   ```
3. Para ligar o robô:
   ```
   npm start
   ```
4. Vai aparecer `🌐 [PAINEL] Aberto em http://localhost:3000`. **Deixe essa janela aberta.**

### 4. Primeiro acesso
1. Abra no navegador: **http://localhost:3000** e entre com a senha do `.env`.
2. Toque em **⚙️ Configurações → WhatsApp**.
3. No celular **do robô**: WhatsApp → ⋮ → **Aparelhos conectados → Conectar um aparelho** e leia o QR Code. Se preferir, use **"Gerar código"** e digite o código em "Conectar com número de telefone".
4. Quando aparecer **● Conectado**, toque em **Escolher grupos**:
   - marque **EQUIPE AZUL - US FERROPORT** (e só os grupos de trabalho);
   - em **Publicar o relatório em**, escolha o grupo;
   - toque em **Salvar grupos**.
5. Preencha os **destinatários dos e-mails de bordo**, o **número para alerta de emergência** e as **atividades fixas** do turno. Toque em **Salvar configurações**.

### 5. Usar no celular (mesma rede Wi-Fi do computador)
No computador, descubra o IP: no Terminal digite `ipconfig` e procure "Endereço IPv4" (ex.: `192.168.0.15`).
No celular, abra `http://192.168.0.15:3000`. No menu do navegador use **"Adicionar à tela inicial"** para virar um app.

> Configure o computador para **não hibernar** (Configurações → Energia → Suspensão: Nunca).

---

## ☁️ Opção B — Rodar no Render (nuvem, acessa de qualquer lugar)

No plano gratuito do Render, o disco é apagado quando o serviço reinicia. Por isso **é obrigatório usar o Firebase**, que guarda a sessão do WhatsApp e os dados.

### 1. Firebase (gratuito)
1. https://console.firebase.google.com → seu projeto (ou crie um).
2. **Firestore Database → Criar banco de dados** (modo produção, região `southamerica-east1`).
3. ⚙️ **Configurações do projeto → Contas de serviço → Gerar nova chave privada**. Baixa um `.json`.
4. Abra o `.json` e deixe todo o conteúdo em **uma linha só** (pode usar https://jsonformatter.org/json-minify). Você vai colar isso no Render.

### 2. GitHub (privado)
1. Crie um repositório **Private** e envie os arquivos deste pacote. **Não envie o `.env` nem a pasta `dados`.**
2. No repositório antigo: **Settings → Pages → desative** e mude para **Private** (ou apague).

### 3. Render
1. https://render.com → **New → Web Service** → conecte o repositório.
2. **Runtime: Docker.**
3. Em **Environment**, adicione:
   - `APP_SENHA` = sua senha
   - `FIREBASE_CREDENTIALS` = o JSON em uma linha
4. **Create Web Service.** Quando terminar, abra o link `https://seu-servico.onrender.com` e siga o **Primeiro acesso** acima.
5. **Apague o serviço antigo** (`robo-caveira-bot-html`) no Render. A API dele está aberta, sem senha.

> O plano gratuito "dorme" sem acessos. O robô faz um ping a cada 10 minutos para evitar isso, mas o Render pode reiniciar o serviço. Para uso profissional contínuo, use um plano pago do Render ou a Opção A.

---

## 🔁 Rotina do turno

1. **Turno** → confira o relatório da equipe anterior (os itens com **?** não foram encontrados) → **Herdar e começar meu turno**.
2. **Entrada** → para cada mensagem, use o botão sugerido ou **Outro destino**. Ruído ("bom dia", "ok") já vem ignorado. Mensagens de emergência ficam no topo, em vermelho.
3. **Relatório** → ajuste o que precisar (salva sozinho) → **Prévia** → **Publicar**.
4. **Operações de bordo** → depois de registrar a saída do veículo, use **✉️ E-mail** para abrir a minuta no Outlook (Web ou aplicativo). Anexe as evidências e envie.

Se o relatório da US foi postado com o robô desligado: **Turno → Colar relatório**.

---

## 🛠️ Problemas comuns

| Sintoma | O que fazer |
|---|---|
| `Defina APP_SENHA no arquivo .env` | Crie o `.env` (passo 2) com uma senha de 8+ caracteres |
| `'npm' não é reconhecido` | Instale o Node.js e abra um Terminal novo |
| Pílula mostra **Offline** / **Conectar** | Configurações → WhatsApp → conecte de novo |
| Relatório da US não apareceu | Confira se o grupo está marcado em Configurações. Se foi postado antes de ligar, use **Colar relatório** |
| "Alterada em outro aparelho" | Outra pessoa editou ao mesmo tempo. A tela recarrega a versão atual |
| Quer conferir o leitor | `npm test` testa com o relatório real do Wallace |
