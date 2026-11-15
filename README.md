# 💀 Caveira Bot · CCOS Porto do Açu — v4

Central do plantão do CCOS:

- **Login por pessoa.** O e-mail é obrigatório, e há três perfis: Administrador, Líder e Operador.
- **Assumir plantão.** O relatório sai pelo WhatsApp de quem está de plantão, e os e-mails de bordo chegam no e-mail dessa pessoa.
- **Relatório anterior automático.** O robô pega o "RELATÓRIO DO TURNO" no grupo e prepara o seu turno sozinho. Os últimos 10 ficam guardados para você escolher.
- **Central de pendências.** Avisos, pendências da Digital, operações e e-mails aparecem por assunto. Cada um tem histórico, atualização e **conclusão com tratativa**.
- **Mensagens no formato padrão** (`*Tipo:*`, `*Navio:*`, `*Placa:*`…) são lidas sozinhas e viram **uma operação e um e-mail para cada navio**.
- **E-mails de bordo nos modelos do CCOS.** Tripulantes são autorizados pela Polícia Federal e fornecimentos pela Receita Federal. O campo "Autorizados por (Terminal)" fica em branco.
- **Passagem da escala.** O robô coleta tudo desde o primeiro dia, e no fim você edita e publica.

---

## 📁 Arquivos (todos na raiz do repositório)

`index.js` · `servidor.js` · `nucleo.js` · `relatorio.js` · `usuarios.js` · `whatsapp.js` · `email.js` · `store.js` · `util.js` · `sessaoFirestore.js` · `index.html` · `app.js` · `style.css` · `sw.js` · `manifest.json` · `icon.svg` · `package.json` · `teste_relatorio.js` · `Dockerfile` · `.env.example` · `.gitignore` · `README.md`

---

## 🚀 Atualizar o que já está no Render

### 1. GitHub
1. No repositório `robo-caveira-bot-HTML`, clique em **Add file → Upload files**.
2. Arraste **todos os arquivos do zip**. Os que têm o mesmo nome são substituídos, e `usuarios.js` e `email.js` são novos.
3. Clique em **Commit changes**.
4. Apague o que não é mais usado, se ainda estiver lá: `download`, `download (1)`, `env.example` (sem ponto), `bot_ccos.js`, `bot_ccos_whatsapp.js`, `app_caveira_bot.html`, `iniciar_robo.bat`.
5. Em **Settings → General → Change visibility**, deixe o repositório **Private**. Se o deploy der "repository not found", libere o acesso em Render → Account Settings → GitHub.

### 2. Render → Environment
| Variável | Valor |
|---|---|
| `APP_SENHA` | **Mantenha a atual.** No primeiro start, ela vira a senha do administrador |
| `FIREBASE_CREDENTIALS` | Mantenha |
| `NODE_VERSION` | `22` |
| `GMAIL_USUARIO` | E-mail do robô (veja abaixo) |
| `GMAIL_SENHA_APP` | Senha de app do Google (veja abaixo) |

Depois clique em **Save Changes → Manual Deploy → Clear build cache & deploy**.

### 3. Conferir o log
```
👤 [USUÁRIOS] Administrador criado: ruddgero.ribeiro@ferroport.com.br (senha = APP_SENHA).
🔄 [MIGRAÇÃO] Dados da versão anterior convertidos (avisos → pendências, navios e operações).
✉️  [E-MAIL] Envio automático ativo pela conta ...
🌐 [PAINEL] Aberto em ...
✅ Pronto
```
O administrador só é criado no primeiro start, e a migração só acontece uma vez. Os avisos que já existiam viram pendências.

---

## ✉️ Criar o e-mail do robô (Gmail)
1. Crie uma conta Gmail só para o robô (ex.: `ccos.caveirabot@gmail.com`).
2. Em **myaccount.google.com → Segurança**, ative a **Verificação em duas etapas**.
3. Abra **myaccount.google.com/apppasswords**, crie uma senha com o nome "Caveira Bot" e copie os 16 caracteres.
4. No Render, preencha `GMAIL_USUARIO` (o e-mail) e `GMAIL_SENHA_APP` (os 16 caracteres) e faça o deploy de novo.

Sem essas variáveis, tudo funciona, mas o e-mail não sai sozinho. Use **Copiar**, **Outlook Web** ou **App de e-mail** na tela do e-mail.

---

## 👤 Primeiro acesso (administrador)
1. Abra o link do Render e entre com **ruddgero.ribeiro@ferroport.com.br** e a **APP_SENHA**.
2. Em **☰ → Meu perfil → Conectar meu WhatsApp**, leia o QR com o seu celular e toque em **Escolher grupos**. Marque **EQUIPE AZUL - US FERROPORT**.
3. Em **☰ → Configurações**:
   - escolha o **grupo de publicação**;
   - preencha **Encaminhar para** (a lista oficial dos e-mails de bordo);
   - confira o **número do alerta** e os **navios conhecidos**;
   - toque em **Salvar configurações**.
4. Em **☰ → Usuários**:
   - Lais Campos e Felipe Furtado já estão cadastrados como **Operador**;
   - toque em **Criar senha provisória** e envie a senha para cada um. No primeiro login, a pessoa cria a própria senha;
   - quem for **Líder** precisa ter o perfil trocado para "Líder" e conectar o próprio WhatsApp em Meu perfil.
5. Na **Central**, toque em **Assumir plantão** e depois em **Iniciar nova escala**.

---

## 🔁 Rotina do plantão
1. **Central:** o líder toca em **Assumir plantão**. O relatório anterior já vem herdado. Se aparecer "Chegou um relatório novo", escolha herdar ou manter o turno.
2. **Pendências:** toque em cada uma para atualizar ou **Concluir com tratativa**. Avisos abertos passam para o próximo turno.
3. **Entrada:** mensagens no formato padrão são registradas sozinhas e vão para "Tratadas". As demais vão para o destino que você escolher.
4. **E-mails:** chegam no e-mail do líder. Confira, anexe as evidências, encaminhe e toque em **✓ Encaminhado**.
5. **Relatório:** confira as 8 seções, abra a **Prévia** e toque em **Publicar**. O relatório sai pelo WhatsApp do líder de plantão.
6. **Fim da escala:** abra **📦 Passagem da escala**, revise, edite e publique.

---

## 🛠️ Problemas comuns
| Sintoma | O que fazer |
|---|---|
| "Primeiro acesso: defina APP_SENHA" | Crie `APP_SENHA` no Render, com 8 ou mais caracteres |
| Não consigo publicar | Assuma o plantão e conecte o seu WhatsApp em Meu perfil |
| WhatsApp "Pausado" | Normal: no plano grátis ficam ligados só o líder de plantão e um reserva. Ele religa ao assumir |
| E-mail "não configurado" | Preencha `GMAIL_USUARIO` e `GMAIL_SENHA_APP` |
| Esqueci a senha | O administrador gera uma senha provisória em Usuários |
| Conferir o leitor de relatórios | `npm test` |
