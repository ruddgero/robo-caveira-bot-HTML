// =====================================================================
// CAVEIRA BOT CCOS — ponto de partida (npm start)
// =====================================================================
try { require('dotenv').config(); } catch (_) { /* variáveis vêm do servidor (Render) */ }

const store = require('./store');
const usuarios = require('./usuarios');
const nucleo = require('./nucleo');
const whatsapp = require('./whatsapp');
const email = require('./email');
const servidor = require('./servidor');
const { agora } = require('./util');

async function principal() {
    console.log('💀 CAVEIRA BOT CCOS v4 — iniciando...');
    store.iniciar();
    try { await usuarios.carregar(); }
    catch (e) { console.error('\n❌ ' + e.message + '\n'); process.exit(1); }
    await nucleo.carregar();
    email.iniciar();

    // Alerta de emergência: mensagem no privado, enviada pelo WhatsApp do líder de plantão
    nucleo.aoAlerta(item => {
        const lider = nucleo.liderDePlantao();
        const numero = nucleo.estado.config.alertaNumero;
        if (!lider || !numero) return;
        const texto = `🚨 *ALERTA CCOS — possível ocorrência no grupo*\n\n🕒 ${item.hora} • ${item.grupoNome}\n👤 ${item.autor}\n📄 "${item.texto}"\n\nAbra o painel para registrar.`;
        whatsapp.enviarTexto(lider.id, `${numero}@s.whatsapp.net`, texto).catch(e => console.error('Falha no alerta:', e.message));
    });

    // E-mail não saiu (sem conta ou erro): manda a minuta no WhatsApp do próprio líder, pronta para copiar
    nucleo.aoPrecisarMinutaWhatsapp(async ({ assunto, corpo, op }) => {
        const lider = nucleo.liderDePlantao() || usuarios.admin();
        if (!lider) return false;
        const st = whatsapp.status(lider.id);
        if (st.estado !== 'CONECTADO' || !st.numero) return false;
        const jid = `${st.numero}@s.whatsapp.net`;
        await whatsapp.enviarTexto(lider.id, jid, `✉️ *E-mail de bordo pronto para enviar*\n${op.navio || ''} · ${op.terminal || ''}\n\nAbaixo: 1) assunto  2) texto. Copie e cole no Outlook.`);
        await whatsapp.enviarTexto(lider.id, jid, assunto);
        await whatsapp.enviarTexto(lider.id, jid, corpo);
        return true;
    });

    // Quem assume o plantão tem o WhatsApp religado (se já tinha conectado antes)
    nucleo.aoMudarPlantao(uid => {
        const u = usuarios.porId(uid);
        if (u?.whatsapp?.pareado) whatsapp.ativar(uid).catch(() => {});
    });

    await servidor.iniciar(parseInt(process.env.PORT || '3000', 10));

    // Liga primeiro o líder de plantão, depois o reserva (último a usar)
    const liderId = nucleo.estado.plantao.liderId;
    const pareados = usuarios.todos()
        .filter(u => u.ativo && u.whatsapp?.pareado && usuarios.podeLiderar(u))
        .sort((a, b) => (b.id === liderId) - (a.id === liderId) || String(b.whatsapp.ultimoUso || '').localeCompare(String(a.whatsapp.ultimoUso || '')))
        .map(u => u.id);

    await whatsapp.iniciar({
        mensagem: msg => nucleo.receberMensagem(msg),
        gruposDe: uid => usuarios.porId(uid)?.whatsapp?.grupos || [],
        nomeSessao: uid => usuarios.porId(uid)?.whatsapp?.sessao || `whatsapp_sessao_${uid}`,
        liderPlantao: () => nucleo.estado.plantao.liderId || null,
        pareado: (uid, numero) => usuarios.atualizarWhatsapp(uid, numero
            ? { pareado: true, numero, ultimoUso: new Date().toISOString() }
            : { pareado: false, numero: null }).catch(() => {})
    }, pareados);

    // No Render gratuito o serviço dorme sem acessos; este "ping" o mantém acordado.
    if (process.env.RENDER_EXTERNAL_URL) {
        const https = require('https');
        setInterval(() => https.get(`${process.env.RENDER_EXTERNAL_URL}/ping`, () => {}).on('error', () => {}), 10 * 60 * 1000);
    }
    const t = agora();
    console.log(`✅ Pronto (${t.data} ${t.hora}).`);
}

process.on('unhandledRejection', e => console.error('⚠️  Erro não tratado:', e?.message || e));
principal().catch(e => { console.error('❌ Falha ao iniciar:', e); process.exit(1); });
