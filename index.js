// ==========================================
// CCOS CAVEIRA BOT - MASTER PROCESS LAUNCHER
// Executa o Telegram Bot, WhatsApp Monitor e API Web
// ==========================================
require('dotenv').config();

console.log('💀 [CAVEIRA BOT MASTER] Iniciando subsistemas operacionais do CCOS...');

// 1. Inicia o Bot do Telegram ERP (se houver TELEGRAM_BOT_TOKEN)
try {
    if (process.env.TELEGRAM_BOT_TOKEN) {
        console.log('🤖 [TELEGRAM] Inicializando módulo Telegram...');
        require('./bot_ccos.js');
    } else {
        console.log('⚠️ [TELEGRAM] TELEGRAM_BOT_TOKEN não informado no .env. Pulando módulo Telegram.');
    }
} catch (err) {
    console.error('❌ [TELEGRAM ERROR]:', err.message);
}

// 2. Inicia o Monitor de WhatsApp e API Express para o App Web
try {
    console.log('📲 [WHATSAPP & API] Inicializando módulo WhatsApp e API Web...');
    require('./bot_ccos_whatsapp.js');
} catch (err) {
    console.error('❌ [WHATSAPP ERROR]:', err.message);
}
