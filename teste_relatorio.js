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
const ativ = R.atividadeDasOperacoes(c.rascunhos, '19:02');
console.log('Atividade gerada:', ativ);
assert.ok(ativ.includes('BARCELONA SPIRIT e NISSOS NIKOURIA') && ativ.includes('Saída às 19:01h.'));
assert.strictEqual(R.resumoNavio(o1), 'Fornecimento de Rancho.');

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
assert.strictEqual(R.resumoNavio(t1), 'Desembarque de 02 tripulantes.');
const et = R.minutaEmail({ ...t1, horaFinal: '15:00' });
assert.ok(et.corpo.includes('Autorizado por (Autoridades): Polícia Federal'));
assert.ok(et.assunto.startsWith('MOVIMENTAÇÃO DE TRIPULAÇÃO - MV - LILA PSARA - T-ORE'));

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
nova.atividades.push({ id: 'a', texto: ativ });
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

console.log('\n✅ Todos os testes passaram.');
