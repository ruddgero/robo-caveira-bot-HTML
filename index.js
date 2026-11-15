// =====================================================================
// CAVEIRA BOT CCOS — ponto de partida
//   npm start   → liga o painel web + o leitor do WhatsApp
// =====================================================================
try { require('dotenv').config(); } catch (_) { /* .env opcional quando as variáveis vêm do servidor */ }

const store = require('./src/store');
const nucleo = require('./src/nucleo');
const whatsapp = require('./src/whatsapp');
const servidor = require('./src/servidor');
const { agora } = require('./src/util');

async function principal() {
    console.log('💀 CAVEIRA BOT CCOS — iniciando...');

    if (!process.env.APP_SENHA || process.env.APP_SENHA.length < 8) {
        console.error('\n❌ Defina APP_SENHA no arquivo .env (mínimo 8 caracteres). É a senha para entrar no painel.\n');
        process.exit(1);
    }

    store.iniciar();
    await nucleo.carregar();

    // Alerta de emergência no privado (só quando você ativa nas Configurações)
    nucleo.aoAlerta(item => {
        const cfg = nucleo.estado.config;
        const texto = `🚨 *ALERTA CCOS — possível ocorrência no grupo*\n\n🕒 ${item.hora} • ${item.grupoNome}\n👤 ${item.autor}\n📄 "${item.texto}"\n\nAbra o painel para registrar.`;
        whatsapp.enviarTexto(`${cfg.alertaNumero}@s.whatsapp.net`, texto).catch(e => console.error('Falha no alerta:', e.message));
    });

    await servidor.iniciar(parseInt(process.env.PORT || '3000', 10));
    await whatsapp.iniciar({ mensagem: msg => nucleo.receberMensagem(msg) });

    // No Render gratuito o serviço dorme sem acessos; este "ping" o mantém acordado.
    if (process.env.RENDER_EXTERNAL_URL) {
        const https = require('https');
        setInterval(() => https.get(`${process.env.RENDER_EXTERNAL_URL}/ping`, () => {}).on('error', () => {}), 10 * 60 * 1000);
    }
    console.log(`✅ Pronto (${agora().data} ${agora().hora}).`);
}

process.on('unhandledRejection', e => console.error('⚠️  Erro não tratado:', e?.message || e));
principal().catch(e => { console.error('❌ Falha ao iniciar:', e); process.exit(1); });
