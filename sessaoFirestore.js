// Guarda a sessão COMPLETA do WhatsApp (credenciais + chaves) no Firestore,
// para o robô continuar conectado mesmo quando o servidor reinicia (Render).
module.exports = async function usarSessaoFirestore(db, baileys, nomeColecao = 'whatsapp_sessao') {
    const { initAuthCreds, BufferJSON, proto } = baileys;
    const col = db.collection(nomeColecao);
    const idDoc = id => String(id).replace(/\//g, '__');

    const escrever = (dados, id) => col.doc(idDoc(id)).set({ v: JSON.stringify(dados, BufferJSON.replacer) });
    const ler = async id => {
        const doc = await col.doc(idDoc(id)).get();
        return doc.exists ? JSON.parse(doc.data().v, BufferJSON.reviver) : null;
    };
    const apagar = id => col.doc(idDoc(id)).delete();

    const creds = (await ler('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (tipo, ids) => {
                    const dados = {};
                    await Promise.all(ids.map(async id => {
                        let valor = await ler(`${tipo}-${id}`);
                        if (tipo === 'app-state-sync-key' && valor) valor = proto.Message.AppStateSyncKeyData.fromObject(valor);
                        dados[id] = valor;
                    }));
                    return dados;
                },
                set: async dados => {
                    const tarefas = [];
                    for (const categoria in dados) {
                        for (const id in dados[categoria]) {
                            const valor = dados[categoria][id];
                            const chave = `${categoria}-${id}`;
                            tarefas.push(valor ? escrever(valor, chave) : apagar(chave));
                        }
                    }
                    await Promise.all(tarefas);
                }
            }
        },
        saveCreds: () => escrever(creds, 'creds'),
        limpar: async () => {
            const snap = await col.get();
            let lote = db.batch(); let n = 0;
            for (const d of snap.docs) {
                lote.delete(d.ref);
                if (++n % 400 === 0) { await lote.commit(); lote = db.batch(); }
            }
            await lote.commit();
        }
    };
};
