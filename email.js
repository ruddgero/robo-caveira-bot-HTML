// =====================================================================
// ENVIO DE E-MAIL (conta do robô)
// Gmail: GMAIL_USUARIO + GMAIL_SENHA_APP (senha de app do Google)
// Outro servidor: SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS
// =====================================================================
let transporte = null;
let remetente = '';
let motivo = 'E-mail do robô não configurado (GMAIL_USUARIO / GMAIL_SENHA_APP).';

function iniciar() {
    const usuario = process.env.GMAIL_USUARIO || process.env.SMTP_USER;
    const senha = (process.env.GMAIL_SENHA_APP || process.env.SMTP_PASS || '').replace(/\s+/g, '');
    if (!usuario || !senha) { console.log('ℹ️  [E-MAIL] ' + motivo); return; }
    try {
        const nodemailer = require('nodemailer');
        transporte = process.env.SMTP_HOST
            ? nodemailer.createTransport({
                host: process.env.SMTP_HOST,
                port: parseInt(process.env.SMTP_PORT || '587', 10),
                secure: process.env.SMTP_SECURE === 'true',
                auth: { user: usuario, pass: senha }
            })
            : nodemailer.createTransport({ service: 'gmail', auth: { user: usuario, pass: senha } });
        remetente = process.env.EMAIL_REMETENTE || `Caveira Bot CCOS <${usuario}>`;
        motivo = '';
        console.log(`✉️  [E-MAIL] Envio automático ativo pela conta ${usuario}.`);
    } catch (e) {
        motivo = 'Biblioteca de e-mail não instalada (rode npm install).';
        console.error('⚠️  [E-MAIL] ' + motivo);
    }
}

function configurado() { return !!transporte; }
function motivoIndisponivel() { return motivo; }

async function enviar({ para, assunto, corpo, responderPara }) {
    if (!transporte) throw new Error(motivo);
    if (!para) throw new Error('Sem destinatário (líder de plantão sem e-mail).');
    await transporte.sendMail({ from: remetente, to: para, replyTo: responderPara || undefined, subject: assunto, text: corpo });
}

module.exports = { iniciar, configurado, motivoIndisponivel, enviar };
