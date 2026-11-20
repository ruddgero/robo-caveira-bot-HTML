// Testes das regras do relatório: node teste_relatorio.js
const assert = require('assert');
const R = require('./relatorio');

const RELATORIO_US = `RELATÓRIO DO TURNO - DIURNO
Data: 14/11/2026
1. EFETIVO CCOS
✓ S/A

2. VIATURA – VTR
Veículo: L200
Placa: TDG-8C89
KM inicial: 19.358
KM final: 19.365

3. SISTEMAS
CFTV
✓ Poste 38, Fixa Portão 04 da Filtragem.
CA - CONTROLE DE ACESSO
✓ S/A
OCR - RECONHECIMENTO DE PLACAS
Assertividade: 88,05%
Total de leituras: 188 veículos

4. ATIVIDADES REALIZADAS
✓ Realizadas atividades administrativas.
✓ Realizadas rondas no perímetro;
✓ MV - LILA PSARA – T-ORE. Embarque de 03 tripulantes sem registo de ocorrência;

6. MOVIMENTAÇÃO DE NAVIOS
T-ORE
MV - LILA PSARA: Atracado às 08:54.

T-OIL
AROSA: Atracado às 12:55.

7. OCORRÊNCIAS:
✓ S/A

8. PASSAGEM DE TURNO
EQUIPE SAINDO:
Wallace Ferroport e Equipe US
EQUIPE ASSUMINDO:
✓ Ruddgero Ribeiro, Lais Campos e Felipe Furtado`;

const MSG_FELIPE = `*ENTREGA DE PROVISÃO*

*Tipo:* RANCHO
*Terminal:* T.OIL
*Navio:* BARCELONA SPIRIT
*Navio:* NISSOS NIKOURIA
*Empresa:* MAPAMAR
*Motorista:* RAFAEL SILVA
*Ajudante:* VITOR DOS SANTOS
*Veículo:* CAMINHÃO
*Placa:*  RJG-9D19
*Saída na portaria:* 19:01H`;

// ---- Relatório da US
assert.ok(R.ehRelatorioDeTurno(RELATORIO_US));
assert.ok(!R.ehRelatorioDeTurno('Equipe, alguém viu o relatório do turno? VTR está na base'));
const lido = R.lerRelatorio(RELATORIO_US);
const d = lido.dados;
assert.strictEqual(d.turno, 'DIURNO');
assert.strictEqual(d.vtr.kmFinal, 19365);
assert.strictEqual(d.sistemas.ocrLeituras, '188');
assert.strictEqual(d.equipes.assumindo, 'Ruddgero Ribeiro, Lais Campos e Felipe Furtado', 'sem o ✓');
assert.strictEqual(d.navios.tore[0].navio, 'MV - LILA PSARA');
assert.deepStrictEqual(d.navios.tore[0].linhas, ['Atracado às 08:54.']);
assert.strictEqual(d.navios.toil[0].navio, 'AROSA');
assert.deepStrictEqual(lido.faltando, []);

// ---- Mensagem padrão do Felipe
const c = R.classificarMensagem(MSG_FELIPE, R.NAVIOS_PADRAO, '19:02');
assert.strictEqual(c.sugestao, 'OPERACAO', 'provisão com "Saída" não pode virar Saída/Atividade');
assert.ok(c.estruturada);
assert.strictEqual(c.rascunhos.length, 2, 'um rascunho por navio');
const [o1, o2] = c.rascunhos;
assert.strictEqual(o1.tipo, 'RANCHO');
assert.strictEqual(o1.navio, 'BARCELONA SPIRIT');
assert.strictEqual(o2.navio, 'NISSOS NIKOURIA');
assert.strictEqual(o1.terminal, 'T-OIL');
assert.strictEqual(o1.empresa, 'MAPAMAR');
assert.strictEqual(o1.responsavel, 'RAFAEL SILVA');
assert.strictEqual(o1.ajudante, 'VITOR DOS SANTOS');
assert.strictEqual(o1.placa, 'RJG-9D19');
assert.strictEqual(o1.horaFinal, '19:01');
// operação de bordo não vai para as Atividades (seção 4)
assert.strictEqual(c.atividade, '');
// seção 6: sucinta, sem horário, sem empresa/placa
assert.strictEqual(R.resumoNavio(o1), 'Entrega de rancho.');
assert.strictEqual(R.resumoNavio({ ...o1, horaFinal: '' }), 'Entrega de rancho. Em andamento.');

// Mensagem do print: prefixo MV, 2º ajudante na linha de baixo, autoridade preenchida
const prov = R.classificarMensagem('*ENTREGA DE PROVISÃO*\nTipo: Rancho\nTerminal: T-ore\nNavio: MV - Lila Psara\nEmpresa: Boa praça\nMotorista: Fernando Maforte\nAjudante: Valmir Felipe\nMarcos Bruno\nVeículo: Caminhão\nPlaca: GXM8B67\nEntrada: 10:48 horas', R.NAVIOS_PADRAO, '10:50');
const p0 = prov.rascunhos[0];
assert.strictEqual(prov.sugestao, 'OPERACAO');
assert.strictEqual(p0.navio, 'LILA PSARA', 'sem o prefixo MV');
assert.strictEqual(p0.ajudante, 'VALMIR FELIPE, MARCOS BRUNO');
assert.strictEqual(p0.responsavel, 'FERNANDO MAFORTE');
assert.strictEqual(p0.veiculo, 'CAMINHÃO');
assert.strictEqual(p0.autoridades, 'Receita Federal');
assert.strictEqual(p0.horaInicial, '10:48');
assert.strictEqual(p0.placa, 'GXM-8B67');
assert.strictEqual(R.acharNavio('NISSOS NIKURIA')?.nome, 'NISSOS NIKOURIA');
assert.strictEqual(R.acharNavio('M/V Barcelona spirit')?.nome, 'BARCELONA SPIRIT');
assert.strictEqual(R.acharNavio('NAVIO QUALQUER'), null);

const email = R.minutaEmail({ ...o1, data: '14/11/2026' });
console.log('\n--- E-MAIL ---\nAssunto:', email.assunto, '\n' + email.corpo + '\n--------------');
assert.strictEqual(email.assunto, 'FORNECIMENTO DE RANCHO - BARCELONA SPIRIT - T-OIL - 14-11-2026');
assert.ok(email.corpo.includes('Registro o fornecimento de bordo:'));
assert.ok(email.corpo.includes('Autorizado por (Autoridades): Receita Federal'));
assert.ok(/Autorizados por \(Terminal\): \n/.test(email.corpo), 'terminal em branco');
assert.ok(email.corpo.includes('conferência das Notas Fiscais'));

// ---- Tripulação
const trip = R.classificarMensagem('MV - LILA PSARA – T-ORE. Desembarque de 2 tripulantes, van placa XYZ9K76 agência OCEAN às 14h20', R.NAVIOS_PADRAO, '14:25');
assert.strictEqual(trip.sugestao, 'OPERACAO');
const t1 = trip.rascunhos[0];
assert.strictEqual(t1.tipo, 'TRIPULACAO');
assert.strictEqual(t1.movimento, 'Desembarque');
assert.strictEqual(t1.quantidade, '02');
assert.strictEqual(t1.terminal, 'T-ORE');
assert.strictEqual(R.resumoNavio(t1), 'Desembarque de 02 tripulantes. Em andamento.');
assert.strictEqual(R.resumoNavio({ ...t1, horaFinal: '15:00' }), 'Desembarque de 02 tripulantes.');
const et = R.minutaEmail({ ...t1, horaFinal: '15:00' });
assert.ok(et.corpo.includes('Autorizado por (Autoridades): Polícia Federal'));
assert.ok(et.assunto.startsWith('MOVIMENTAÇÃO DE TRIPULAÇÃO - LILA PSARA - T-ORE'));

// ---- Mensagens reais do grupo (19/11/2026): nada pode se perder
const NAVIOS_TURNO = [...R.NAVIOS_PADRAO, { nome: 'MARTHA OLDENDORFF', terminal: 'T-ORE' }, { nome: 'UBUNTU HUMANITY', terminal: 'T-ORE' }];
const embarque = 'Embarque Definitivo 01 tripulante\n\nMotorista: ROSSINE GUEDES \nEmpresa: LS LOCAÇÕES \nVeículo: CRONOS\nPlaca: SSA-0F86\nAgente: DIEGO ALVARADO \nEmpresa: LS LOCAÇÕES\nNavio: MARTHA OLDENDORFF\nTerminal: T.ORE\nEntrada  na portaria: 14:50Hs';
const em = R.classificarMensagem(embarque, NAVIOS_TURNO, '15:22').rascunhos[0];
assert.strictEqual(em.terminal, 'T-ORE');
assert.strictEqual(em.horaInicial, '14:50', 'horário da mensagem, não o da postagem');
assert.strictEqual(em.movimento, 'Embarque definitivo');
assert.strictEqual(em.quantidade, '01');
assert.strictEqual(em.responsavel, 'ROSSINE GUEDES');
assert.strictEqual(em.agente, 'DIEGO ALVARADO');
assert.strictEqual(em.empresa, 'LS LOCAÇÕES', 'empresa repetida igual não duplica');
assert.deepStrictEqual(em.conferir, []);
assert.strictEqual(R.resumoNavio(em), 'Embarque definitivo de 01 tripulante. Em andamento.');
const emEmail = R.minutaEmail({ ...em, data: '19/11/2026' }).corpo;
assert.ok(emEmail.includes('DIEGO ALVARADO (AGENTE) / ROSSINE GUEDES (MOTORISTA)'));
assert.ok(emEmail.includes('Embarque ou desembarque: Embarque definitivo'));

// a versão apagada dizia T.OIL: conflito com o navio atracado no T-ORE → a confirmar
const emErrado = R.classificarMensagem(embarque.replace('T.ORE', 'T.OIL'), NAVIOS_TURNO, '15:21').rascunhos[0];
assert.ok(emErrado.conferir.some(t => t.includes('T-OIL') && t.includes('T-ORE')), 'terminal divergente vai para "a confirmar"');

const rancho = '*ENTREGA DE PROVISÃO*\n*Tipo:* RANCHO\n*Terminal:* T.ORE\n*Navio:* UBUNTU HUMANITY\n*Empresa:* BOA PRAÇA\n*Motoristas:* FERNANDO\nQUEROZ / WALQUER CHAGAS\n*AJUDANTES :JOÃO EVERTON , GUSTAVO GOMES  *A BORDO*\nMYCAION REIS\n*Veículo:* CAMINHÃO /MOBI\n*Placa:* GXM- 8B67 / RBI- 458\n*Entrada Portaria:* 14:45H';
const ra = R.classificarMensagem(rancho, NAVIOS_TURNO, '15:23').rascunhos[0];
assert.strictEqual(ra.tipo, 'RANCHO');
assert.strictEqual(ra.terminal, 'T-ORE');
assert.strictEqual(ra.horaInicial, '14:45');
assert.strictEqual(ra.responsavel, 'FERNANDO QUEROZ / WALQUER CHAGAS', 'motoristas no plural e quebra de linha');
assert.strictEqual(ra.ajudante, 'JOÃO EVERTON, GUSTAVO GOMES');
assert.strictEqual(ra.aBordo, 'MYCAION REIS');
assert.strictEqual(ra.veiculo, 'CAMINHÃO / MOBI');
assert.strictEqual(ra.placa, 'GXM-8B67 / RBI-458', 'as duas placas, mesmo a incompleta');
assert.ok(ra.alertas.some(t => t.includes('RBI-458')), 'placa incompleta gera alerta');
assert.strictEqual(R.resumoNavio(ra), 'Entrega de rancho. Em andamento.');
const raEmail = R.minutaEmail({ ...ra, data: '19/11/2026' }).corpo;
console.log('\n--- E-MAIL RANCHO 19/11 ---\n' + raEmail + '\n--------------');
assert.ok(raEmail.includes('CAMINHÃO - Placa GXM-8B67 / MOBI - Placa RBI-458'));
assert.ok(raEmail.includes('A bordo: MYCAION REIS'));
assert.ok(raEmail.includes('FERNANDO QUEROZ / WALQUER CHAGAS / JOÃO EVERTON, GUSTAVO GOMES'));

// linha que o robô não conhece vai para Observações (não se perde)
const extra = R.classificarMensagem('*ENTREGA DE PROVISÃO*\nTipo: Rancho\nTerminal: T-ORE\nNavio: UBUNTU HUMANITY\nEmpresa: Boa Praça\nLacre: 123456\nPlaca: GXM8B67\nEntrada: 10:00', NAVIOS_TURNO).rascunhos[0];
assert.ok(extra.observacoes.includes('Lacre: 123456'));

// saída a passeio / retorno
const passeio = R.classificarMensagem('Saída a passeio de 5 Tripulantes\nNavio- Ubuntu Humanity\nTerminal: T-ORE\nEmpresa: LS LOCAÇÕES', NAVIOS_TURNO, '14:36').rascunhos[0];
assert.strictEqual(passeio.movimento, 'Saída a passeio');
assert.strictEqual(passeio.navio, 'UBUNTU HUMANITY');
assert.strictEqual(R.resumoNavio({ ...passeio, horaFinal: '14:40' }), 'Saída a passeio de 05 tripulantes. Não retornaram até o presente momento.');
assert.strictEqual(R.resumoNavio({ ...passeio, quantidade: '01' }), 'Saída a passeio de 01 tripulante. Não retornou até o presente momento.');
assert.strictEqual(R.resumoNavio({ ...passeio, horaRetorno: '18:00' }), 'Saída a passeio de 05 tripulantes. Retornaram ao terminal.');
assert.strictEqual(R.movimentoDoTexto('Retorno ao terminal dos 05 tripulantes do navio Ubuntu Humanity'), 'Retorno');

// nome do navio parecido (1 letra) → a confirmar
const parecido = R.classificarMensagem('*ENTREGA DE PROVISÃO*\nTipo: Rancho\nTerminal: T-OIL\nNavio: NISSOS NIKURIA\nEmpresa: X\nPlaca: ABC1D23\nEntrada: 10:00').rascunhos[0];
assert.strictEqual(parecido.navio, 'NISSOS NIKOURIA');
assert.ok(parecido.conferir.some(t => t.includes('parecido')));

// ---- Mensagem padrão: o robô lê 100% a mensagem que ele mesmo gera
for (const r of [em, ra]) {
    const volta = R.classificarMensagem(R.mensagemPadrao(r), NAVIOS_TURNO, '16:00').rascunhos[0];
    for (const k of ['tipo', 'navio', 'terminal', 'empresa', 'responsavel', 'agente', 'ajudante', 'aBordo', 'veiculo', 'placa', 'quantidade', 'movimento', 'horaInicial'])
        assert.strictEqual(volta[k] || '', r[k] || '', `mensagem padrão perdeu ${k}`);
}
assert.ok(R.mensagemPadrao(ra).startsWith('*ENTREGA DE PROVISÃO*\n*Tipo:* RANCHO\n*Terminal:* T.ORE'));

// ---- Embarque e desembarque na mesma mensagem: duas quantidades
const ed = R.classificarMensagem('AMETISTA BRASIL – T-OIL. Realizado embarque de 13 e desembarque de 14 tripulantes, van placa ABC1D23 às 15:00', NAVIOS_TURNO).rascunhos[0];
assert.strictEqual(ed.movimento, 'Embarque e Desembarque');
assert.strictEqual(ed.qtdEmbarque, '13'); assert.strictEqual(ed.qtdDesembarque, '14');
assert.strictEqual(R.resumoNavio(ed), 'Embarque de 13 e desembarque de 14 tripulantes. Em andamento.');

// ---- Manobras do grupo → linha padronizada
assert.strictEqual(R.manobraDoTexto('Martha Oldendorff atracado às 10:42 T-ORE').linha, 'Atracado às 10:42.');
assert.strictEqual(R.manobraDoTexto('Previsão de desatracação do Ametista Brasil às 20:00').navio, 'AMETISTA BRASIL');
assert.strictEqual(R.manobraDoTexto('Previsão de desatracação do Ametista Brasil às 20:00').tipo, 'PREV_DESATRACACAO');
assert.strictEqual(R.manobraDoTexto('Bom dia a todos'), null);

// ---- Planilha de navios
const NV = require('./navios');
assert.deepStrictEqual(NV.lerManobra('Atracado às 01:15.', { turno: 'NOTURNO', data: '19/11/2026' }), { tipo: 'ATRACACAO', data: '20/11/2026', hora: '01:15' });
assert.strictEqual(NV.lerManobra('Previsão de desatracação em 19/11 às 20:00.', {}), null);
assert.strictEqual(NV.contribuicao({ tipo: 'DTA' }).peca, 1, 'DTA entra como Peça');
assert.deepStrictEqual(NV.contribuicao({ tipo: 'MERGULHO', berco: 'OESTE', bordo: 'B' }).caixa, { LE: 0, LB: 0, OE: 0, OB: 1 });
const estadias = [];
const fichaT = { turno: 'DIURNO', data: '19/11/2026', navios: { tore: [{ navio: 'MARTHA OLDENDORFF', linhas: ['Atracado às 10:42.'] }], toil: [{ navio: 'PORTO', linhas: ['Previsão de desatracação em 19/11 às 11:30; desatracado às 12:25.'] }] } };
const lin = NV.atualizarEstadias(estadias, fichaT, [{ id: 'x1', ...em, data: '19/11/2026' }, { id: 'x2', ...ed, navio: 'PORTO', terminal: 'T-OIL' }]);
const martha = lin.find(l => l.valores.navio === 'MARTHA OLDENDORFF');
assert.ok(martha.nova && martha.valores.atracHora === '10:42' && martha.valores.embarque === 1);
const porto = lin.find(l => l.valores.navio === 'PORTO');
assert.ok(porto.valores.desatracHora === '12:25' && porto.valores.embarque === 13 && porto.valores.desembarque === 14 && porto.parcial);
assert.strictEqual(NV.atualizarEstadias(estadias, fichaT, [{ id: 'x1', ...em, data: '19/11/2026' }]).length, 0, 'o mesmo turno de novo não soma duas vezes');

// ---- Pendências: título curto, descrição com o resto
const NU = require('./nucleo');
assert.deepStrictEqual(NU.separarTitulo('DOCK STATION: Consultar o e-mail encaminhado', ''), { titulo: 'DOCK STATION', texto: 'Consultar o e-mail encaminhado' });
assert.deepStrictEqual(NU.separarTitulo('DOCK STATION:', ''), { titulo: 'DOCK STATION', texto: '' });
assert.strictEqual(NU.separarTitulo('CÂMERA DA FILTRAGEM: A PTA SERÁ DA EMPRESA RIP E O TIME DA DIGITAL ACOMPANHA', '').texto, 'A PTA será da empresa RIP e o time da digital acompanha');
// padrão de escrita: título em caixa alta, demais textos com a primeira letra de cada frase/linha em maiúscula
assert.strictEqual(NU.maiusculaInicial('contatar o Alex. aguardando a TI\nsegunda linha'), 'Contatar o Alex. Aguardando a TI\nSegunda linha');
assert.deepStrictEqual(NU.separarTitulo('dock station', 'consultar o e-mail'), { titulo: 'DOCK STATION', texto: 'Consultar o e-mail' });

// ---- Escala 4×4 (Amarela → Azul → Verde → Branca) e substituições
const ORG = require('./organograma');
assert.strictEqual(ORG.equipeDoTurno('DIURNO', '19/11/2026'), 'AZUL');
assert.strictEqual(ORG.equipeDoTurno('NOTURNO', '19/11/2026'), 'AMARELA');
assert.strictEqual(ORG.equipeDoTurno('DIURNO', '20/11/2026'), 'AZUL');
assert.strictEqual(ORG.equipeDoTurno('DIURNO', '21/11/2026'), 'VERDE');
assert.strictEqual(ORG.equipeDoTurno('NOTURNO', '21/11/2026'), 'AZUL');
assert.strictEqual(ORG.equipeDoTurno('DIURNO', '23/11/2026'), 'BRANCA');
assert.strictEqual(ORG.equipeDoTurno('DIURNO', '27/11/2026'), 'AZUL');
const org = { equipes: ORG.quadroInicial(), substituicoes: [] };
const felipe = ORG.pessoaPorNome(org, 'Felipe Furtado'), marcos = ORG.pessoaPorNome(org, 'Marcos Duarte'), wallace = ORG.pessoaPorNome(org, 'Wallace Chagas');
assert.throws(() => ORG.novaSubstituicao(org, { titularId: felipe.id, substitutoId: wallace.id, de: '01/12/2026', ate: '15/12/2026' }), /operador cobre só operador/);
ORG.novaSubstituicao(org, { titularId: felipe.id, substitutoId: marcos.id, de: '01/12/2026', ate: '15/12/2026', motivo: 'Férias' });
assert.deepStrictEqual(ORG.equipeEfetiva(org, 'AZUL', '05/12/2026').nomes, ['Ruddgero Ribeiro', 'Marcos Duarte', 'Laís Campos']);
assert.deepStrictEqual(ORG.equipeEfetiva(org, 'AZUL', '16/12/2026').nomes, ['Ruddgero Ribeiro', 'Felipe Furtado', 'Laís Campos']);
const ops = ORG.opcoesSubstituto(org, 'Ewerton Brito', '05/12/2026').opcoes;
assert.ok(ops.every(o => o.cargo === 'OPERADOR') && !ops.some(o => o.nome === 'Mariana Freitas' || o.nome === 'Felipe Furtado'));

// ---- Outras classificações
const s = m => R.classificarMensagem(m).sugestao;
assert.strictEqual(s('bom dia a todos'), 'IGNORAR');
assert.strictEqual(s('Saída do caminhão ABC1D23 às 16:40'), 'SAIDA');
assert.strictEqual(s('Câmera do poste 12 oscilando, chamado aberto com a Digital'), 'DIGITAL');
assert.strictEqual(s('Princípio de incêndio na subestação 2'), 'OCORRENCIA');
assert.strictEqual(s('AROSA desatracado às 22:10'), 'NAVIO');
assert.strictEqual(s('Realizada ronda no Gate 3 sem alteração'), 'ATIVIDADE');

// ---- Herança e texto
const nova = R.fichaHerdada({ ...lido, autor: 'Wallace' }, null, { atividadesBase: ['Realizadas atividades administrativas.'] });
assert.strictEqual(nova.turno, 'NOTURNO');
assert.strictEqual(nova.equipes.saindo, 'Ruddgero Ribeiro, Lais Campos e Felipe Furtado');
R.adicionarLinhaNavio(nova, 'T-OIL', 'BARCELONA SPIRIT', 'Fornecimento de Rancho.');
R.adicionarLinhaNavio(nova, 'T-ORE', 'LILA PSARA', 'Desembarque de 02 tripulantes.');
assert.strictEqual(nova.navios.tore.length, 1, 'LILA PSARA = MV - LILA PSARA (não duplica)');
nova.vtr.kmFinal = 19372;
nova.atividades.push({ id: 'a', texto: 'Realizada ronda no perímetro.' });
const avisos = [{ titulo: 'URNAS DA CIPA', texto: 'Verificar status das chaves.', historico: [{ tipo: 'ATUALIZACAO', data: '14/11', hora: '21:10', texto: 'Chaves com o vigilante.' }] }];
const texto = R.formatarRelatorio(nova, avisos);
console.log('\n--- RELATÓRIO ---\n' + texto + '\n-----------------');
const relido = R.lerRelatorio(texto);
assert.ok(R.ehRelatorioDeTurno(texto));
assert.strictEqual(relido.dados.vtr.kmFinal, 19372);
assert.strictEqual(relido.dados.avisos[0].titulo, 'URNAS DA CIPA');
assert.strictEqual(relido.dados.navios.toil.find(n => n.navio === 'BARCELONA SPIRIT').linhas[0], 'Fornecimento de Rancho.');
assert.ok(texto.includes('Assertividade: 88,05%;') && texto.includes('Total de leituras: 188 veículos.'));

// ---- Relatório no formato do robô antigo (5.1. AVISO)
const antigo = `*RELATÓRIO DO TURNO - NOTURNO*\nData: 13/11/2026\n\n*1. EFETIVO CCOS*\n✓ S/A\n\n*2. VIATURA – VTR*\nKM inicial: 19.228\nKM final: 19.235\n\n*3. SISTEMAS*\n*CFTV*\n✓ S/A\n\n*4. ATIVIDADES REALIZADAS*\n✓ X\n\n*5. AVISOS E AÇÕES DE ACOMPANHAMENTO*\n\n*5.1. AVISO*\nBagagens na Receita Federal (T-OIL): Acompanhar liberação.\n\n*6. MOVIMENTAÇÃO DE NAVIOS*\n\n*T-ORE*\n\n*MARAN COURAGE*\n✓ Fornecimento de Rancho.\n\n*T-OIL*\n\n✓ S/A\n\n*7. OCORRÊNCIAS:*\n✓ S/A\n\n*8. PASSAGEM DE TURNO*\n\n*EQUIPE SAINDO:*\nConforme escala\n\n*EQUIPE ASSUMINDO:*\nConforme escala`;
const la = R.lerRelatorio(antigo).dados;
assert.strictEqual(la.avisos[0].titulo, 'BAGAGENS NA RECEITA FEDERAL (T-OIL)');
assert.strictEqual(la.navios.tore[0].navio, 'MARAN COURAGE');
assert.deepStrictEqual(la.navios.toil, []);

// ---- Passagem da escala
const pe = R.formatarPassagemEscala('11/11/2026 a 14/11/2026', { digital: [{ texto: 'Câmeras ausentes: Poste 38.' }], avisos: [], ocorrencias: [], atividades: [{ texto: 'Ronda.' }] });
assert.ok(pe.includes('*1. PENDÊNCIAS DA DIGITAL (CFTV E INFRAESTRUTURA)*\n✓ Câmeras ausentes: Poste 38.'));
assert.ok(pe.includes('*2. AVISOS E AÇÕES DE ACOMPANHAMENTO*\n✓ S/A'));

// Seção 8: nomes e pipe
assert.deepStrictEqual(R.separarNomes('Wallace Ferroport e Equipe US'), ['Wallace Ferroport', 'Equipe US']);
assert.strictEqual(R.juntarNomes(['Gustavo Ramos', 'Ítalo']), 'Gustavo Ramos e Ítalo');
assert.throws(() => R.lerEquipesComPipe('Gustavo e Ítalo'));
assert.strictEqual(R.lerEquipesComPipe('Gustavo Ramos e Ítalo | Renan Neves e Ewerton').assumindo, 'Renan Neves e Ewerton');
assert.ok(R.formatarRelatorio(R.fichaVazia(), []).includes('*8. PASSAGEM DE TURNO*\n\n*EQUIPE SAINDO:*\nConforme escala\n\n*EQUIPE ASSUMINDO:*\nConforme escala'));
console.log('\n✅ Todos os testes passaram.');
