require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const FormData = require('form-data'); // NOVO: necessário para o upload do áudio
const { google } = require('googleapis');
const app = express();
app.use(express.json());

// OPENAI_API_KEY: NOVA variável no .env para a transcrição
const { WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WEBHOOK_VERIFY_TOKEN, SHEET_ID, KNOWLEDGE_SHEET_ID, GEMINI_API_KEY, DR_WHATSAPP_NUMBER, EQUIPE_VIDEO_WHATSAPP_NUMBER, ADMIN_PASSWORD, PORT = 3000 } = process.env;
const GRAPH_API_URL = `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

// Credenciais do Google: aceita tanto o arquivo credentials.json local (dev)
// quanto uma variável de ambiente GOOGLE_CREDENTIALS_JSON (produção/Railway),
// pra nunca precisar commitar a chave sensível no repositório.
function carregarCredenciaisGoogle() {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    try {
      return JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    } catch (err) {
      console.error('GOOGLE_CREDENTIALS_JSON inválido (não é um JSON válido):', err.message);
      throw err;
    }
  }
  return undefined; // undefined faz o GoogleAuth cair pro keyFile abaixo
}
const credenciaisGoogle = carregarCredenciaisGoogle();
const auth = new google.auth.GoogleAuth({
  ...(credenciaisGoogle ? { credentials: credenciaisGoogle } : { keyFile: 'credentials.json' }),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets = google.sheets({ version: 'v4', auth });

// ===== 0) PERSISTÊNCIA EM DISCO (sobrevive a reinício/queda do processo) =====
// DATA_DIR configurável: em produção (Railway, etc.) aponte pro caminho do volume persistente
// (ex: DATA_DIR=/data). Localmente, sem essa variável, usa uma pasta 'data' dentro do projeto.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const ARQ_SESSOES = path.join(DATA_DIR, 'sessoes.json');
const ARQ_CONCLUIDOS = path.join(DATA_DIR, 'concluidos.json');
const ARQ_RESERVAS = path.join(DATA_DIR, 'reservas.json');
const ARQ_LEADS_FRIOS = path.join(DATA_DIR, 'leadsFrios.json');

function carregarJSON(arquivo, valorPadrao) {
  try {
    if (fs.existsSync(arquivo)) return JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  } catch (err) { console.error(`Erro ao ler ${arquivo}:`, err.message); }
  return valorPadrao;
}
function salvarJSON(arquivo, dados) {
  try {
    fs.writeFileSync(arquivo, JSON.stringify(dados, null, 2));
  } catch (err) { console.error(`Erro ao salvar ${arquivo}:`, err.message); }
}
function persistirTudo() {
  salvarJSON(ARQ_SESSOES, sessoes);
  salvarJSON(ARQ_CONCLUIDOS, concluidos);
  salvarJSON(ARQ_RESERVAS, reservasHorario);
  salvarJSON(ARQ_LEADS_FRIOS, leadsFrios);
}

// ===== 1) CRM =====
async function registrarConversa(nome, numero, mensagem) {
  const dataHora = new Date().toLocaleString('pt-BR');
  await sheets.spreadsheets.values.append({ spreadsheetId: SHEET_ID, range: 'A:D', valueInputOption: 'USER_ENTERED', resource: { values: [[dataHora, nome, numero, mensagem]] } });
  console.log('Registrado no Sheets:', nome, '-', mensagem);
}

// ===== 1b) ABA "agendamentos": rastreia cada agendamento até 30 dias pós-avaliação =====
// Colunas: A Data/Hora | B Nome | C Número | D Tratamento | E Situação | F Problema
//          G Status (a recepção preenche: Compareceu / Faltou / Avaliado)
//          H Data Avaliação (a Bia preenche sozinha, na 1ª vez que vê "Avaliado")
//          I Lembretes Enviados (sequência pós-avaliação, controlada pela Bia)
//          J Data Agendamento (ISO) (a Bia preenche sozinha, no momento do agendamento)
//          K Vídeos Enviados (funil de 7 vídeos pós-agendamento, controlado pela Bia)
const ABA_AGENDAMENTOS = 'agendamentos';

async function registrarAgendamentoPlanilha({ nome, numero, tratamento, situacao, problema }) {
  const agora = new Date();
  const dataHora = agora.toLocaleString('pt-BR');
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${ABA_AGENDAMENTOS}!A:K`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[dataHora, nome, numero, tratamento, situacao || '-', problema || '-', '', '', '', formatarDataISO(agora), '']] }
    });
  } catch (err) {
    console.error('Erro ao registrar em "agendamentos" (a aba existe na planilha?):', err.message);
  }
}

function formatarDataISO(data) {
  return data.toISOString().slice(0, 10); // YYYY-MM-DD
}
function diasEntre(dataISOAntiga, hoje) {
  const antiga = new Date(dataISOAntiga + 'T00:00:00');
  const diffMs = hoje.setHours(0, 0, 0, 0) - antiga.setHours(0, 0, 0, 0);
  return Math.round(diffMs / (24 * 60 * 60 * 1000));
}

const ESTAGIOS_AVALIADO = [
  { dia: 1, tipo: 'TEXTO', gerar: (nome, problema) => `Oi, ${nome}! Foi um prazer receber você aqui no consultório. Obrigado por confiar em mim para dar esse primeiro passo.\n\nFico muito feliz por ter podido te ouvir, entender sua história e começar a planejar algo que pode transformar seu sorriso — e sua vida.\n\nSei que decisões assim pedem um tempo, e tá tudo bem. Só quero que você saiba: quando estiver pronto(a), estarei aqui pra seguir com você.\n\nConte comigo no que precisar ✨` },
  { dia: 3, tipo: 'ÁUDIO', gerar: (nome) => `Sabe, ${nome}, muita gente que atendo me diz: 'Se eu soubesse que era assim, teria feito antes'. A verdade é que resolver isso muda a forma como a gente come, fala e até se olha no espelho. Eu fico animado por saber que podemos transformar isso juntos.` },
  { dia: 7, tipo: 'TEXTO', gerar: (nome, problema) => `Você comentou comigo sobre ${problema || 'o que te incomodava'} e isso ficou comigo. Já acompanhei muitos pacientes assim e vi o quanto o resultado transforma. Ainda está com vontade de cuidar disso?` },
  { dia: 14, tipo: 'ÁUDIO', gerar: (nome) => `Oi, ${nome}. Estou com alguns horários abrindo essa semana. Se quiser, posso reservar um pra você. A gente começa com calma, mas o importante é dar o primeiro passo. Você merece voltar a sorrir com segurança.` },
  { dia: 21, tipo: 'TEXTO', gerar: (nome) => `Tudo bem, ${nome}? Só passei pra saber como você está e reforçar que estou aqui se quiser conversar ou tirar dúvidas. Às vezes só falta um empurrãozinho pra gente se cuidar de verdade.` },
  { dia: 30, tipo: 'TEXTO', gerar: (nome) => `Fiquei na dúvida se você seguiu com outro profissional ou se ainda está pensando em voltar.\n\nMe avisa se quiser conversar de novo — sem compromisso. Tô por aqui.\n\nAproveitando, queria me despedir desse nosso ciclo dizendo que estarei aqui quando quiser retomar. A porta está aberta. 🙏` },
];

async function verificarFollowupsAvaliados() {
  if (!DR_WHATSAPP_NUMBER) return;
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${ABA_AGENDAMENTOS}!A2:I1000` });
    const linhas = res.data.values || [];
    const hoje = new Date();
    for (let i = 0; i < linhas.length; i++) {
      const linha = linhas[i];
      const numeroLinha = i + 2; // planilha começa em 1, e a linha 1 é cabeçalho
      const [, nome, numero, , situacao, problema, status, dataAvaliacao, lembretesStr] = linha;
      if ((status || '').trim().toLowerCase() !== 'avaliado') continue;

      let dataAvaliacaoFinal = dataAvaliacao;
      if (!dataAvaliacaoFinal) {
        dataAvaliacaoFinal = formatarDataISO(hoje);
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID, range: `${ABA_AGENDAMENTOS}!H${numeroLinha}`, valueInputOption: 'USER_ENTERED', resource: { values: [[dataAvaliacaoFinal]] }
        });
      }

      const diasPassados = diasEntre(dataAvaliacaoFinal, new Date());
      const lembretesJaEnviados = (lembretesStr || '').split(',').map(s => s.trim()).filter(Boolean);
      const estagio = ESTAGIOS_AVALIADO.find(e => e.dia === diasPassados && !lembretesJaEnviados.includes(String(e.dia)));
      if (!estagio) continue;

      const mensagemSugerida = estagio.gerar(nome, problema);
      const aviso = `📋 *Lembrete de follow-up pós-avaliação*\n\n🗓️ Dia ${estagio.dia} — *${nome}* (${numero})\n📎 Tipo: ${estagio.tipo}\n\nMensagem sugerida:\n"${mensagemSugerida}"\n\n(Copie e envie manualmente pro paciente)`;
      try {
        await sendTextMessage(DR_WHATSAPP_NUMBER, aviso);
        lembretesJaEnviados.push(String(estagio.dia));
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID, range: `${ABA_AGENDAMENTOS}!I${numeroLinha}`, valueInputOption: 'USER_ENTERED', resource: { values: [[lembretesJaEnviados.join(',')]] }
        });
        console.log(`Lembrete dia ${estagio.dia} avisado pra equipe sobre ${nome}`);
      } catch (err) {
        console.error(`Falha ao avisar lembrete de ${nome}:`, err.response?.data || err.message);
      }
    }
  } catch (err) {
    console.error('Erro ao verificar follow-ups de avaliados (a aba "agendamentos" existe?):', err.message);
  }
}
setInterval(verificarFollowupsAvaliados, 3 * 60 * 60 * 1000); // checa a cada 3h (granularidade é por dia, então não precisa ser mais frequente)
verificarFollowupsAvaliados().catch(() => {}); // roda uma vez já na subida, pra erro aparecer no log sem esperar 3h

// ===== 1c) FUNIL DE 7 VÍDEOS PÓS-AGENDAMENTO (aviso interno, envio manual) =====
// Roda do dia 1 ao dia 7 após o agendamento. Para automaticamente assim que a coluna
// Status (G) for preenchida (Compareceu/Faltou/Avaliado) — não faz sentido continuar
// mandando vídeo de "ansiedade pré-consulta" depois que a consulta já aconteceu.
const VIDEOS_FUNIL = [
  { dia: 1, legenda: 'Olá, {nome}! Parabéns por dar esse primeiro passo. Preparei esse vídeo pra você assistir 🎥' },
  { dia: 2, legenda: 'Muita gente sente um friozinho na barriga... Por isso, gravei essa mensagem pra você ❤️' },
  { dia: 3, legenda: 'Você não está sozinho(a)! Olha só o que eu queria te contar...' },
  { dia: 4, legenda: 'Quero que você chegue tranquilo(a) na consulta. Assiste esse vídeo que gravei pra você ✨' },
  { dia: 5, legenda: 'Uma reflexão importante pra você que já deu o primeiro passo...' },
  { dia: 6, legenda: 'Você já está em movimento! Uma mensagem especial pra você antes da nossa consulta 🙌' },
  { dia: 7, legenda: 'Amanhã é o grande dia! Estou te esperando de coração aberto. Vai ser um prazer te receber!🙌🏽' },
];

async function verificarLembretesVideo() {
  if (!EQUIPE_VIDEO_WHATSAPP_NUMBER) return; // linha ainda não adquirida — fica inativo até configurar
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${ABA_AGENDAMENTOS}!A2:K1000` });
    const linhas = res.data.values || [];
    for (let i = 0; i < linhas.length; i++) {
      const linha = linhas[i];
      const numeroLinha = i + 2;
      const [, nome, numero, , , , status, , , dataAgendamentoISO, videosStr] = linha;
      if ((status || '').trim() !== '') continue; // já compareceu/faltou/foi avaliado — funil para aqui
      if (!dataAgendamentoISO) continue; // registro antigo sem essa coluna preenchida

      const dias = diasEntre(dataAgendamentoISO, new Date());
      const videosJaEnviados = (videosStr || '').split(',').map(s => s.trim()).filter(Boolean);
      const video = VIDEOS_FUNIL.find(v => v.dia === dias && !videosJaEnviados.includes(String(v.dia)));
      if (!video) continue;

      const aviso = `🎥 *Lembrete do funil de vídeos*\n\n🗓️ Dia ${video.dia}/7 — *${nome}* (${numero})\n\nLegenda sugerida:\n"${video.legenda.replace('{nome}', nome)}"\n\n(Envie o Vídeo ${video.dia} manualmente pro paciente com essa legenda)`;
      try {
        await sendTextMessage(EQUIPE_VIDEO_WHATSAPP_NUMBER, aviso);
        videosJaEnviados.push(String(video.dia));
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID, range: `${ABA_AGENDAMENTOS}!K${numeroLinha}`, valueInputOption: 'USER_ENTERED', resource: { values: [[videosJaEnviados.join(',')]] }
        });
        console.log(`Lembrete do vídeo ${video.dia} avisado pra equipe sobre ${nome}`);
      } catch (err) {
        console.error(`Falha ao avisar lembrete de vídeo de ${nome}:`, err.response?.data || err.message);
      }
    }
  } catch (err) {
    console.error('Erro ao verificar funil de vídeos:', err.message);
  }
}
setInterval(verificarLembretesVideo, 3 * 60 * 60 * 1000); // checa a cada 3h
verificarLembretesVideo().catch(() => {}); // roda uma vez já na subida, pra erro aparecer no log sem esperar 3h

// ===== 2) BASE DE CONHECIMENTO =====
let conhecimento = { servicos: [], faq: [], horarios: [] };
async function carregarConhecimento() {
  try {
    const res = await sheets.spreadsheets.values.batchGet({ spreadsheetId: KNOWLEDGE_SHEET_ID, ranges: ['servicos!A:E', 'faq!A:B', 'horarios_disponiveis_api!A:G'] });
    const v = res.data.valueRanges.map(r => r.values || []);
    conhecimento.servicos = v[0].slice(1).filter(l => l[1]).map(l => ({ titulo: l[1], valor: (l[3] || '').trim() }));
    conhecimento.faq = v[1].slice(1).filter(l => l[0]).map(l => ({ pergunta: l[0], resposta: (l[1] || '').trim() }));
    conhecimento.horarios = v[2].slice(1).filter(l => l[0]).map(l => ({ data: l[1] || '', dia: l[2] || '', horarios: (l[3] || '').trim(), local: l[6] || '' }));
    console.log('Base carregada:', conhecimento.servicos.length, 'servicos,', conhecimento.faq.length, 'perguntas,', conhecimento.horarios.length, 'agenda');
  } catch (err) { console.error('Erro ao carregar base:', err.message); }
}
carregarConhecimento();
setInterval(carregarConhecimento, 5 * 60 * 1000);

// ===== Utilidades =====
const normalizar = t => (t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const primeiroNome = nome => (nome || '').split(' ')[0] || '';
const TEM = (t, palavras) => palavras.some(p => t.includes(normalizar(p)));
function passouData(dataStr) {
  const [d, m, a] = (dataStr || '').split('/').map(Number);
  if (!d || !m || !a) return true;
  return new Date(a, m - 1, d) < new Date(new Date().toDateString());
}
function ecoar(texto) {
  let frase = (texto || '').trim().replace(/\s+/g, ' ');
  if (frase.length > 90) frase = frase.slice(0, 90) + '...';
  return `"${frase}"`;
}
function ecoValido(texto) {
  const t = normalizar(texto || '');
  return t.length > 10 && !/^(sim|nao|n|ok|otimo)$/i.test(t);
}
const PALAVRAS_IGNORAR = ['meu','nome','e','eh','sou','o','a','os','as','do','da','de','queria','quero','gostaria','sim','não','nao','oi','olá','ola','bom dia','boa tarde','boa noite','pode','ser','com','me','mim','eu','doutor','dr','opa'];
function capitalizar(palavra) {
  if (!palavra) return '';
  return palavra.charAt(0).toUpperCase() + palavra.slice(1).toLowerCase();
}
function extrairNome(texto) {
  const t = normalizar(texto);
  const padroes = [
    /meu nome e\s+([a-zà-ú]+)/, /me chamo\s+([a-zà-ú]+)/, /\bsou o\s+([a-zà-ú]+)/, /\bsou a\s+([a-zà-ú]+)/,
    /\baqui e o\s+([a-zà-ú]+)/, /\baqui e a\s+([a-zà-ú]+)/, /\baqui e\s+([a-zà-ú]+)/, /\bau sou o\s+([a-zà-ú]+)/, /\bau sou a\s+([a-zà-ú]+)/,
  ];
  for (const p of padroes) {
    const m = t.match(p);
    if (m && m[1] && !PALAVRAS_IGNORAR.includes(m[1])) return capitalizar(m[1]);
  }
  const palavras = t.split(/\s+/).filter(Boolean);
  const uteis = palavras.filter(p => !PALAVRAS_IGNORAR.includes(p) && p.length > 1);
  if (palavras.length <= 3 && uteis.length > 0) return capitalizar(uteis[0]);
  return null;
}
const PALAVRAS_URGENCIA = ['dor de dente', 'estou com dor', 'quebrei', 'quebrou', 'inchaço', 'urgente'];
const PALAVRAS_GRATUIDADE = ['de graça', 'gratis', 'grátis', 'de gratis', 'sem pagar', 'nao vou pagar', 'de brinde', 'desconto', 'mais barato'];
function responderGratuidade(nome) {
  const comNome = nome ? ', ' + nome : '';
  return `Entendo o interesse${comNome} 😊 Hoje não trabalhamos com tratamento gratuito, mas a *avaliação não tem nenhum custo nem compromisso* — você conhece o plano, os valores certinhos pro seu caso e decide com calma depois.\nE pra fechar, temos Pix, cartão ou 40% de entrada + até 10x sem juros, que costuma caber bem no orçamento 💳\nQuer que eu já reserve sua avaliação?`;
}

const FAQ_DIRETAS = [
  { palavras: ['doi', 'machuc', 'anestesi'], indice: 0 },
  { palavras: ['rejeit', 'titanio'], indice: 4 },
  { palavras: ['diabet', 'hiperten'], indice: 9 },
  { palavras: ['tomograf', 'radiograf', 'exame'], indice: 3 },
  { palavras: ['provisori', 'cicatriz'], indice: 6 },
  { palavras: ['pos operat', 'pos-operat', 'recuperac'], indice: 8 },
  { palavras: ['artificial', 'natural'], indice: 7 },
  { palavras: ['demora', 'duracao'], indice: 5 },
  { palavras: ['protocolo'], indice: 10 },
];

// ===== NOVO 3) TRANSCRIÇÃO DE ÁUDIO (Whisper) =====
async function baixarMedia(mediaId) {
  // Passo 1: pedir a URL do arquivo ao WhatsApp (a URL dura poucos minutos)
  const meta = await axios.get(`https://graph.facebook.com/v21.0/${mediaId}`, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  const url = meta.data.url;
  const mime = meta.data.mime_type || 'audio/ogg';
  const ext = mime.includes('mpeg') ? 'mp3' : mime.includes('mp4') ? 'mp4' : mime.includes('amr') ? 'amr' : 'ogg';
  // Passo 2: baixar o arquivo (também precisa do token)
  const resp = await axios.get(url, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }, responseType: 'arraybuffer' });
  return { buffer: Buffer.from(resp.data), ext, mime };
}

// ===== TRANSCRIÇÃO DE ÁUDIO (Gemini) =====
const esperar = ms => new Promise(r => setTimeout(r, ms));

async function transcreverAudio(mediaId, mimeType) {
  // Passo 1: pedir a URL do áudio pro WhatsApp
  const meta = await axios.get(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
  });
  if (!meta.data.url) throw new Error('Sem URL de mídia');

  // Passo 2: baixar o arquivo
  const audio = await axios.get(meta.data.url, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    responseType: 'arraybuffer'
  });
  const base64 = Buffer.from(audio.data).toString('base64');

  // Passo 3: mandar pro Gemini "escutar" — com retry pra erros transitórios (503/429)
  const MAX_TENTATIVAS = 3;
  let ultimoErro;
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
          contents: [{
            parts: [
              { text: 'Transcreva este áudio em português brasileiro. Responda APENAS com o texto falado, sem comentários, sem aspas, sem introdução.' },
              { inline_data: { mime_type: mimeType || 'audio/ogg', data: base64 } }
            ]
          }]
        },
        { headers: { 'Content-Type': 'application/json' } }
      );
      const texto = res.data.candidates?.[0]?.content?.parts?.map(p => p.text).join('').trim();
      return texto || null;
    } catch (err) {
      ultimoErro = err;
      const status = err.response?.status;
      const transitorio = status === 503 || status === 429;
      if (transitorio && tentativa < MAX_TENTATIVAS) {
        console.log(`Gemini instável (${status}), tentativa ${tentativa}/${MAX_TENTATIVAS} — nova tentativa em breve...`);
        await esperar(tentativa * 1500); // 1.5s, depois 3s
        continue;
      }
      throw ultimoErro;
    }
  }
}

// ===== 4) FUNIL (SPIN + Disney) =====
const ESPECIALIDADES = {
  implante: {
    rotulo: 'Implante',
    q3: 'Perfeito, {nome}! Me conta: como está sua mastigação hoje? Tem algum dente que você sente falta?',
    q4: 'E o que mais te incomoda ao comer ou sorrir por causa desse dente? 💭',
    implicacao: 'Entendo, {nome}... e vale saber: quando um dente se perde, os vizinhos tendem a se mover e a mastigação piora com o tempo. Cuidar agora evita que o problema cresça — e deixa o tratamento mais simples. 💙',
    necessidade: 'A boa notícia: o Dr. Bruno é especialista em implantes com planejamento digital, e o procedimento é praticamente sem dor. Imagine voltar a mastigar e sorrir com um dente fixo e natural que ninguém percebe...\nO próximo passo é a avaliação com ele — é lá que sai seu plano personalizado, sem surpresas.\nOs horários de sexta (14h às 21h) costumam preencher rápido ⏰\nQuer que eu já reserve o seu? (responde *sim* ou *não* 😊)'
  },
  protese: {
    rotulo: 'Prótese/Protocolo',
    q3: 'Entendi, {nome}! Você usa alguma prótese hoje? Como está o encaixe e o conforto?',
    q4: 'E o que mais te incomoda nela — mobilidade, estética, desconforto pra comer?',
    implicacao: 'Faz todo sentido, {nome}... uma prótese mal encaixada pode machucar a gengiva e fazer a gente evitar situações sociais. Você já deixou de sorrir ou comer fora de casa por causa dela? 💙',
    necessidade: 'O Dr. Bruno trabalha com prótese fixa sobre implante (protocolo): estável, confortável e com cara de dente natural. Imagine comer e sorrir sem pensar nisso...\nO próximo passo é a avaliação — é lá que ele desenha seu plano, sem surpresas.\nOs horários de sexta (14h às 21h) costumam preencher rápido ⏰\nQuer que eu já reserve o seu? (responde *sim* ou *não* 😊)'
  },
  lentes: {
    rotulo: 'Lentes 3D em resina',
    q3: 'Adoro esse objetivo, {nome}! Me conta: o que você gostaria de melhorar no seu sorriso?',
    q4: 'E o que mais te incomoda hoje — a cor, o formato ou o alinhamento dos dentes?',
    implicacao: 'Totalmente compreensível, {nome}... um sorriso que incomoda mexe com a autoestima: nas fotos, no trabalho, nas relações. Quanto tempo mais você quer conviver com isso? 💙',
    necessidade: 'As Lentes 3D em resina do Dr. Bruno são planejadas digitalmente: você visualiza o resultado ANTES de começar, com acabamento natural.\nO próximo passo é a avaliação — é lá que ele desenha o seu sorriso, sem surpresas.\nOs horários de sexta (14h às 21h) costumam preencher rápido ⏰\nQuer que eu já reserve o seu? (responde *sim* ou *não* 😊)'
  },
  alinhadores: {
    rotulo: 'Alinhadores',
    q3: 'Ótimo, {nome}! Seus dentes hoje estão tortos ou desalinhados? Você já usou aparelho alguma vez?',
    q4: 'E o que mais te incomoda — o alinhamento, a mastigação, ou esconder o sorriso nas fotos?',
    implicacao: 'Entendo, {nome}... dentes desalinhados não são só questão de estética: ficam mais difíceis de limpar, o desgaste é maior e o problema tende a aumentar com o tempo. Quanto tempo mais você quer conviver com isso? 💙',
    necessidade: 'Os alinhadores transparentes são discretos e removíveis — ninguém percebe que você está em tratamento. Com planejamento digital, você já vê o resultado final antes de começar.\nO próximo passo é a avaliação com o Dr. Bruno — é lá que sai seu plano, sem surpresas.\nOs horários de sexta (14h às 21h) costumam preencher rápido ⏰\nQuer que eu já reserve o seu? (responde *sim* ou *não* 😊)'
  },
  harmonizacao: {
    rotulo: 'Harmonização Facial',
    q3: 'Perfeito, {nome}! Qual área da Harmonização você gostaria de cudar em primeiro lugar — Botox, Preenchedores (Contorno, olheiras, bigode chinês, lábios), Bio estimulador ou Fios de PDO?',
    q4: 'E o que mais te incomoda quando você se olha no espelho? 💭',
    implicacao: 'Essa insatisfação acompanha a gente, {nome}... em cada foto, cada reunião, cada momento de se olhar. Como isso tem pesado na sua autoestima ao longo do tempo? 💙',
    necessidade: 'O Dr. Bruno trabalha a harmonização de forma natural e segura, respeitando a beleza do seu rosto — nada de exageros, só equilíbrio.\nO próximo passo é a avaliação — é lá que ele entende exatamente o que você busca.\nOs horários de sexta (14h às 21h) costumam preencher rápido ⏰\nQuer que eu já reserve o seu? (responde *sim* ou *não* 😊)'
  },
  outro: {
    rotulo: 'Outro assunto',
    q3: 'Fico feliz que tenha chegado até aqui! Me conta um pouquinho: o que te trouxe até a gente hoje?',
    q4: 'E isso hoje, o quanto tem te incomodado no dia a dia?',
    implicacao: 'Entendo bem, {nome}... continuar como está tem um custo: o problema tende a piorar com o tempo, e agir agora deixa tudo mais simples. 💙',
    necessidade: 'Na avaliação, o Dr. Bruno vai mapear exatamente o seu caso — com tecnologia de ponta e atendimento sem dor.\nOs horários de sexta (14h às 21h) costumam preencher rápido ⏰\nQuer que eu já reserve o seu? (responde *sim* ou *não* 😊)'
  }
};
const RESUMOS = {
  implante: 'O implante é um pequeno pino de titânio que substitui a raiz do dente perdido; sobre ele fixamos a coroa — fica fixo, natural e você mastiga normal. A cirurgia leva em média 1h, com planejamento digital.',
  protese: 'A prótese fixa sobre implante (protocolo) substitui a dentadura: fica presa nos implantes, não sai da boca e devolve segurança pra mastigar e sorrir.',
  lentes: 'As Lentes 3D em resina são finas lâminas planejadas digitalmente que corrigem cor, formato e alinhamento — e você visualiza o resultado antes de começar.',
  alinhadores: 'Os alinhadores são placas transparentes e removíveis que movimentam os dentes de forma discreta, com o resultado final planejado digitalmente.',
  harmonizacao: 'A harmonização facial equilibra lábios, contorno e olhar com técnicas seguras e resultado natural — sempre respeitando a beleza do seu rosto.',
  outro: 'Na avaliação, o Dr. Bruno analisa seu caso com calma, tira todas as dúvidas e desenha o plano ideal pra você.'
};

// ===== FAIXAS DE PREÇO (edite aqui os valores que a Bia pode dizer) =====
const FAIXAS_PRECO = [
  { chave: 'implante', rotulo: 'Implante unitário + coroa', faixa: 'R$ 2.500 a R$ 3.500' },
  { chave: 'protese', rotulo: 'Protocolo (superior ou inferior)', faixa: 'R$ 12.000 a R$ 15.000' },
  { chave: 'lentes', rotulo: 'Lentes de contato dental', faixa: 'R$ 1.200 a R$ 1.800 por dente' },
  { chave: 'clareamento', rotulo: 'Clareamento de consultório', faixa: 'R$ 800 a R$ 1.200' },
];

function responderPreco(nome1, texto = '') {
  const t = normalizar(texto);
  const alvo = FAIXAS_PRECO.find(f => TEM(t, [f.chave]) || TEM(t, f.rotulo.split(' ')));
  if (alvo) {
    return `Boa pergunta${nome1 ? ', ' + nome1 : ''}! 😊\n\n*${alvo.rotulo}* costuma ficar na faixa de *${alvo.faixa}*\n\nO valor exato depende do seu caso — sai na avaliação com o Dr. Bruno, sem surpresas.\nPix, cartão ou 40% de entrada + saldo em até 10x sem juros 💳`;
  }
  const lista = FAIXAS_PRECO.map(x => `• ${x.rotulo}: ${x.faixa}`).join('\n');
  return `Claro${nome1 ? ', ' + nome1 : ''}! 😊\n\nNossos valores costumam ficar nestas faixas:\n\n${lista}\n\nO valor exato depende do seu caso — sai na avaliação com o Dr. Bruno, sem surpresas.\nPix, cartão ou 40% de entrada + saldo em até 10x sem juros 💳`;
}

function responder(texto, nome) {
  const t = normalizar(texto);
  const nome1 = primeiroNome(nome);
  const comNome = nome1 ? ', ' + nome1 : '';
  if (TEM(t, ['plano', 'convênio', 'unimed', 'amil', 'bradesco'])) {
    return `No momento não atendemos por planos de saúde${comNome} 😕\nMas o Dr. Bruno tem condições especiais: Pix, cartão ou 40% de entrada + 10x sem juros.\nQuer saber o valor de algum tratamento? 😊`;
  }
  if (TEM(t, ['endereço', 'onde fica', 'localização', 'como chego'])) {
    const local = conhecimento.horarios.find(h => h.local)?.local || 'Rua Dr. Carlos Chagas, 93, sala 07, Santo Amaro, Recife/PE';
    return `Estamos na ${local} 😊\nAtendimento às sextas, das 14h às 21h. Quer que eu verifique um horário pra você?`;
  }
  const direta = FAQ_DIRETAS.find(f => TEM(t, f.palavras));
  if (direta && conhecimento.faq[direta.indice]) return conhecimento.faq[direta.indice].resposta;
  if (TEM(t, ['mais inform', 'informações', 'informacoes'])) return infoEspecialidade('outro', nome1);
  if (TEM(t, ['preço', 'valor', 'custa', 'orçamento'])) return responderPreco(nome1);
  if (TEM(t, ['agendar', 'marcar', 'consulta', 'horário', 'disponível'])) {
    return `Que alegria${comNome}! 😊 O Dr. Bruno atende às sextas, das 14h às 21h.${horariosLivres()}\n\nMe diz o melhor dia e horário que eu já reservo! 🗓️`;
  }
  const tokens = t.split(/\s+/).filter(w => w.length > 3);
  let melhor = null, score = 0;
  for (const item of conhecimento.faq) {
    const qTokens = normalizar(item.pergunta).replace(/\d+\./g, ' ').split(/\s+/).filter(w => w.length > 3);
    const comum = tokens.filter(w => qTokens.includes(w)).length;
    if (comum > score) { score = comum; melhor = item; }
  }
  if (score >= 2 && melhor) return melhor.resposta;
  if (t.length <= 30 && TEM(t, ['ola', 'oi', 'bom dia', 'boa tarde', 'boa noite'])) {
    return `Olá${comNome}! 😊 Eu sou a Bia, consultora da clínica do Dr. Bruno Freitas.\nPosso te ajudar com:\n\n🦷 Agendar uma avaliação\n💰 Valores dos tratamentos\n⚡ Urgências\n❓ Dúvidas sobre implantes\n\nO que você procura hoje?`;
  }
  return `Eu sou a Bia, consultora da clínica do Dr. Bruno Freitas 😊\nPosso te ajudar com:\n\n🦷 Agendar avaliação\n💰 Valores\n⚡ Urgências\n❓ Dúvidas sobre implantes\n\nO que você procura hoje?`;
}

const sessoes = carregarJSON(ARQ_SESSOES, {});
const concluidos = carregarJSON(ARQ_CONCLUIDOS, {});
let reservasHorario = carregarJSON(ARQ_RESERVAS, []); // [{ texto, textoNormalizado, nome, numero, ts }]
// leadsFrios: quem não virou agendamento (recusou ou abandonou), aguardando follow-up automático
// { [numero]: { nome, numero, tratamento, motivo, esfriouEm, enviados: { '24h': bool, '48h': bool, '72h': bool } } }
let leadsFrios = carregarJSON(ARQ_LEADS_FRIOS, {});

function registrarLeadFrio(numero, { nome, tratamento, motivo }) {
  leadsFrios[numero] = {
    nome: nome || 'Paciente',
    numero,
    tratamento: tratamento || 'nosso atendimento',
    motivo, // 'recusa' | 'abandono'
    esfriouEm: Date.now(),
    enviados: { '3h': false, '8h': false, '20h': false }
  };
}

// ===== FOLLOW-UP AUTOMÁTICO DENTRO DA JANELA DE 24H (texto livre, sem template) =====
// Só funciona enquanto durar a janela de atendimento do WhatsApp (24h desde a última
// mensagem do paciente). Depois disso, só reengaja com template aprovado pela Meta.
function textoFollowup3h(nome, tratamento) {
  return `Oi ${nome}! Vi que você ficou com uma dúvida sobre *${tratamento}* 😊 Ainda quer que eu te ajude a marcar a avaliação? Estou por aqui!`;
}
function textoFollowup8h(nome, tratamento) {
  return `Oi ${nome}! Só passando pra saber se você ainda tem interesse em cuidar do(a) *${tratamento}* 💙 A avaliação com o Dr. Bruno não tem custo nem compromisso — quer que eu reserve um horário pra você?`;
}
function textoFollowup20h(nome, tratamento) {
  return `Oi ${nome}! Essa é a última vez que te chamo por hoje 😊 Se ainda quiser saber mais sobre *${tratamento}* ou marcar sua avaliação sem compromisso, é só responder por aqui.`;
}

async function verificarFollowups() {
  const agora = Date.now();
  const HORA = 60 * 60 * 1000;
  for (const numero of Object.keys(leadsFrios)) {
    const lead = leadsFrios[numero];
    const horasPassadas = (agora - lead.esfriouEm) / HORA;
    try {
      if (horasPassadas >= 3 && !lead.enviados['3h']) {
        await sendTextMessage(numero, textoFollowup3h(lead.nome, lead.tratamento));
        lead.enviados['3h'] = true;
        console.log(`Follow-up 3h enviado pra ${lead.nome} (${numero})`);
        continue; // no máximo 1 envio por lead a cada checagem, evita rajada se o servidor ficou fora do ar
      }
      if (horasPassadas >= 8 && !lead.enviados['8h']) {
        await sendTextMessage(numero, textoFollowup8h(lead.nome, lead.tratamento));
        lead.enviados['8h'] = true;
        console.log(`Follow-up 8h enviado pra ${lead.nome} (${numero})`);
        continue;
      }
      if (horasPassadas >= 20 && !lead.enviados['20h']) {
        await sendTextMessage(numero, textoFollowup20h(lead.nome, lead.tratamento));
        lead.enviados['20h'] = true;
        console.log(`Follow-up 20h enviado pra ${lead.nome} (${numero})`);
      }
      // Depois de 24h sem nenhuma resposta, para de tentar (a janela de texto livre já fechou;
      // reengajar depois disso exigiria um template aprovado pela Meta — não implementado ainda).
      if (horasPassadas >= 24) delete leadsFrios[numero];
    } catch (err) {
      console.error(`Falha ao enviar follow-up pra ${numero}:`, err.response?.data || err.message);
    }
  }
  persistirTudo();
}
setInterval(verificarFollowups, 15 * 60 * 1000); // checa a cada 15min

// ===== TIMEOUT DE SESSÃO / ABANDONO =====
const TIMEOUT_ABANDONO_MS = 3 * 60 * 60 * 1000; // 3h sem responder = considera abandonado
function verificarAbandonos() {
  const agora = Date.now();
  for (const from of Object.keys(sessoes)) {
    const s = sessoes[from];
    if (!s.ultimaInteracao || agora - s.ultimaInteracao < TIMEOUT_ABANDONO_MS) continue;
    const espec = ESPECIALIDADES[s.espec] || ESPECIALIDADES.outro;
    registrarConversa(s.nome || 'Sem nome', from, `[BIA-ABANDONO] parou em "${s.step}" | interesse: ${espec.rotulo} | situacao: ${s.respostas?.situacao || '-'} | problema: ${s.respostas?.problema || '-'}`).catch(() => {});
    registrarLeadFrio(from, { nome: s.nome, tratamento: espec.rotulo, motivo: 'abandono' });
    delete sessoes[from];
  }
  persistirTudo();
}
setInterval(verificarAbandonos, 30 * 60 * 1000); // roda a cada 30min

function iniciarFunil(numero, textoInicial, nomePerfil) {
  const especPrimeira = textoInicial ? identificarEspecialidade(textoInicial) : 'outro';
  const urgencia = textoInicial ? TEM(normalizar(textoInicial), PALAVRAS_URGENCIA) : false;
  const nomeReserva = primeiroNome(nomePerfil || '');
  const nomeInicial = nomeReserva && nomeReserva !== 'Sem' ? nomeReserva : null;
  sessoes[numero] = { step: 'nome', nome: nomeInicial, respostas: {}, especPrevia: especPrimeira !== 'outro' ? especPrimeira : null, urgencia, ultimaInteracao: Date.now(), criadaEm: Date.now() };
  if (urgencia) {
    // Se o nome já veio do perfil do WhatsApp, pula direto pra etapa 'urgencia' — senão a
    // PRÓXIMA mensagem (que é a resposta real sobre a dor) cai na etapa 'nome' de novo e a
    // pergunta se repete, descartando o que a pessoa realmente disse.
    if (nomeInicial) {
      sessoes[numero].step = 'urgencia';
      return `Olá, ${nomeInicial}! Que alegria receber seu contato 😊! Eu sou a *Bia*, consultora da clínica do Dr. Bruno Freitas.\nSinto muito que esteja com dor 😟 — vamos resolver isso com prioridade!\nMe conta rapidinho o que está sentindo (desde quando dói, o que piora)? 🙏`;
    }
    return 'Olá! Que alegria receber seu contato 😊! Eu sou a *Bia*, consultora da clínica do Dr. Bruno Freitas.\nSinto muito que esteja com dor 😟 — vamos resolver isso com prioridade!\nMe diz seu nome, por favor? 😊';
  }
  return 'Olá! Que alegria receber seu contato 😊! Eu sou a *Bia*, consultora da clínica do Dr. Bruno Freitas.\nQual seu nome? E me conta: você gostaria de transformar o seu sorriso ou cuidar do seu rosto?';
}
function menuEspecialidade(nome) {
  return `Muito prazer, ${nome}! 😊\n\nPra eu te orientar da melhor forma, me diz qual é o seu caso:\n\n1️⃣ Implante (dente fixo)\n2️⃣ Prótese / Protocolo\n3️⃣ Lentes 3D em resina\n4️⃣ Alinhadores\n5️⃣ Harmonização Facial\n\nÉ só responder o número ou escrever 😉`;
}
function identificarEspecialidade(texto) {
  const t = normalizar(texto);
  if (t.includes('1') || t.includes('implant') || t.includes('faltando') || t.includes('faltam') || t.includes('perdi') || t.includes('perdeu') || t.includes('arrancad') || t.includes('extrai')) return 'implante';
  if (t.includes('2') || t.includes('protese') || t.includes('protocolo') || t.includes('dentadura') || t.includes('peca') || t.includes('caindo')) return 'protese';
  if (t.includes('3') || t.includes('lente')) return 'lentes';
  if (t.includes('4') || t.includes('alinhad') || t.includes('aparelho') || t.includes('dente torto')) return 'alinhadores';
  if (t.includes('5') || t.includes('harmoniz') || t.includes('rosto') || t.includes('labios') || t.includes('botox') || t.includes('preenchimento')) return 'harmonizacao';
  return 'outro';
}
function horariosLivres() {
  const livres = conhecimento.horarios.filter(h => h.horarios && !passouData(h.data)).slice(0, 2);
  return livres.length ? '\n\nHorários que já estão livres:\n' + livres.map(h => `📅 ${h.dia} (${h.data}): ${h.horarios}`).join('\n') : '\n\nMe diz o dia e horário que ficam melhores pra você, que eu já anoto! 🗓️';
}
// Bloco de horários SEM pedir o horário (pra compor mensagens sem redundância)
function blocoHorarios() {
  const livres = conhecimento.horarios.filter(h => h.horarios && !passouData(h.data)).slice(0, 2);
  return livres.length ? 'Horários que já estão livres:\n' + livres.map(h => `📅 ${h.dia} (${h.data}): ${h.horarios}`).join('\n') : '';
}
function infoEspecialidade(especKey, nome) {
  const e = ESPECIALIDADES[especKey] || ESPECIALIDADES.outro;
  const resumo = RESUMOS[especKey] || RESUMOS.outro;
  const alvo = FAIXAS_PRECO.find(f => f.chave === especKey);
  const lista = alvo ? `• ${alvo.rotulo}: ${alvo.faixa}` : 'os valores saem na avaliação, personalizados pro seu caso';
  return `Claro${nome ? ', ' + nome : ''}! Vou te contar mais 😊\n\n*${e.rotulo}* — ${resumo}\n\n💰 Alguns dos nossos valores:\n${lista}\n\nO valor exato do seu caso sai na avaliação com o Dr. Bruno — sem surpresas.\nPix, cartão ou 40% de entrada + saldo em até 10x sem juros 💳`;
}
function retomar(s) {
  if (s.urgencia) return s.nome ? 'Sobre a sua dor: me conta rapidinho o que está sentindo? 🙏' : 'Me diz seu nome rapidinho que eu já priorizo sua urgência 😊';
  switch (s.step) {
    case 'nome': return s.nome ? menuEspecialidade(s.nome) : 'Antes, me diz: com quem tenho o prazer de falar? 😊';
    case 'especialidade': return menuEspecialidade(s.nome);
    case 'fechamento': return `E aí, ${s.nome}: quer que eu já reserve sua avaliação? (responde *sim* ou *não* 😊)`;
    case 'agenda': return 'Me diz o dia e horário que ficam melhores pra você, que eu já anoto! 🗓️';
    default: return s.perguntaAtual || '';
  }
}
const REACOES_CLINICAS = [
  {
    quando: ['labio', 'mordendo', 'mordida'],
    titulo: 'Mordendo o lábio',
    texto: 'Isso é importantíssimo, {nome}! Morder o lábio é um sinal clássico de que a mordida está pedindo atenção — e o tratamento reposiciona os dentes até que o lábio pare de "pegar". Muitos pacientes contam que param de morder quase sem perceber, conforme o alinhamento avança.'
  },
  {
    quando: ['vergonha', 'envergonha'],
    titulo: 'Vergonha',
    texto: '{nome}, essa vergonha a gente vai deixar pra trás 💙 E saiba que você não está sozinho — a maioria dos nossos pacientes chegou aqui justamente por isso.'
  },
  {
    quando: ['foto', 'fotos'],
    titulo: 'Fotos',
    texto: 'Entendi, {nome}! Evitar fotos é mais comum do que parece — e é exatamente o tipo de coisa que desaparece quando o sorriso volta a agradar. 💙'
  },
];
function explicarAvaliacao(nome) {
  return `Ótima pergunta, ${nome}! 😊\n\nNa avaliação, o Dr. Bruno:\n🔍 Examina seus dentes e gengiva com calma\n📷 Faz imagens e registros do seu caso\n💬 Explica quais são as opções de tratamento\n💰 Apresenta o plano com valores claros, sem compromisso\n\nVocê sai de lá sabendo exatamente o que precisa — a decisão é sempre sua 💙\nQuer que eu reserve? (responde *sim* ou *não* 😊)`;
}

// ===== CLASSIFICAÇÃO DO LEAD (pra priorizar quem chamar primeiro) =====
// Classifica a resposta à pergunta de Implicação do SPIN ("quanto tempo mais você quer
// conviver com isso?") — o sinal de qualificação mais forte do funil, porque mede disposição
// real de agir agora, não só interesse no assunto.
const SINAIS_URGENCIA_ALTA = ['hoje', 'agora', 'urgente', 'nao aguento mais', 'quanto antes', 'ja', 'imediato', 'anos', 'muito tempo', 'cansei'];
const SINAIS_URGENCIA_BAIXA = ['sei la', 'nao sei', 'sem pressa', 'tanto faz', 'talvez', 'mais pra frente', 'nao tenho pressa', 'sem prioridade', 'depois'];
function classificarUrgenciaPercebida(textoNormalizado) {
  if (TEM(textoNormalizado, SINAIS_URGENCIA_ALTA)) return 'QUENTE';
  if (TEM(textoNormalizado, SINAIS_URGENCIA_BAIXA)) return 'FRIO';
  return 'MORNO';
}

function classificarLead(s) {
  if (s.urgencia) return 'QUENTE (urgência)';
  if (s.temperaturaLead) return `${s.temperaturaLead} (reação à pergunta de implicação: "${s.respostas?.urgenciaPercebida || '-'}")`;
  if (s.step === 'agenda' && s.orcamentoOk === true) return 'QUENTE';
  if (s.step === 'agenda' && s.orcamentoOk === false) return 'MORNO (agendou, mas achou o valor apertado)';
  if (s.step === 'agenda') return 'QUENTE';
  if (s.respostas?.problema) return 'MORNO';
  if (s.respostas?.situacao) return 'FRIO (engajou pouco)';
  return 'FRIO (não qualificado)';
}

const DIAS_SEMANA = ['segunda', 'terca', 'terça', 'quarta', 'quinta', 'sexta', 'sabado', 'sábado', 'domingo'];
const MESES = ['janeiro', 'fevereiro', 'marco', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
function pareceHorarioValido(texto) {
  const t = normalizar(texto);
  const temNumero = /\d/.test(t);
  const temPalavraDeData = DIAS_SEMANA.some(d => t.includes(normalizar(d))) || MESES.some(m => t.includes(normalizar(m))) || t.includes('amanha') || t.includes('hoje') || /\bh\b|\d+h\b|:\d{2}/.test(t);
  return temNumero || temPalavraDeData;
}
async function flowFunil(from, texto, enviar, nomePerfil) {
  const s = sessoes[from];
  s.ultimaInteracao = Date.now();
  const t = normalizar(texto);

  // Captura o nome ANTES de qualquer interceptação (urgência/preço/informações podem vir junto)
  if (s.step === 'nome' && !s.nome) {
    const tentativaNome = extrairNome(texto);
    if (tentativaNome) s.nome = tentativaNome;
  }

  const espec = ESPECIALIDADES[s.espec] || ESPECIALIDADES.outro;
  const nomeAtual = s.nome || primeiroNome(nomePerfil);
  const especNaMsg = identificarEspecialidade(texto);

  // "mais informações" funciona em QUALQUER etapa (desde que não cite outra especialidade)
  if (especNaMsg === 'outro' && TEM(t, ['informações', 'informacoes', 'mais inform', 'quero saber mais', 'explica', 'como funciona', 'detalhe'])) {
    await enviar(infoEspecialidade(s.espec || s.especPrevia || 'outro', nomeAtual));
    return enviar(retomar(s));
  }
  // Pergunta "o que ele vai ver na avaliação?"
  if (s.step === 'fechamento' && TEM(t, ['vai ver', 'ele ve', 'ele vê', 'avalia', 'o que acontece', 'como e a', 'o que faz'])) {
    return enviar(explicarAvaliacao(s.nome));
  }
  if (TEM(t, ['preço', 'valor', 'custa', 'orçamento'])) {
    await enviar(responderPreco(nomeAtual));
    return enviar(retomar(s));
  }
  if (TEM(t, PALAVRAS_GRATUIDADE)) {
    await enviar(responderGratuidade(nomeAtual));
    return enviar(retomar(s));
  }
  if (TEM(t, PALAVRAS_URGENCIA)) {
    s.urgencia = true; // guarda o contexto da dor na sessão
    await enviar(`Poxa, sinto muito que esteja passando por isso, ${nomeAtual} 😟\nO Dr. Bruno reserva horários para urgências e vai te priorizar.`);
    if (!s.nome) return enviar('Me diz seu nome rapidinho que eu já anoto seu caso como prioridade 🙏');
    return enviar('Me conta rapidinho o que está sentindo? Assim eu já passo tudo pro Dr. Bruno 🙏');
  }

  switch (s.step) {
    case 'nome': {
      if (!s.nome) {
        const nomeExtraido = extrairNome(texto);
        if (nomeExtraido) s.nome = nomeExtraido;
      }
      if (!s.nome) return enviar(s.urgencia ? 'Me diz seu nome rapidinho que eu já priorizo sua urgência 😊' : 'Antes, me diz: com quem tenho o prazer de falar? 😊');
      // SESSÃO DE URGÊNCIA: com nome em mãos, retoma a DOR (não vai pro menu)
      if (s.urgencia) {
        s.step = 'urgencia';
        s.perguntaAtual = `Muito prazer, ${s.nome}! Sobre a sua dor: me conta rapidinho o que está sentindo (desde quando dói, o que piora)?\nAssim eu já registro seu caso como *prioridade* e reservo um horário pro Dr. Bruno te atender o quanto antes 🙏`;
        return enviar(s.perguntaAtual);
      }
      let especDetectada = s.especPrevia || null;
      if (!especDetectada) {
        const tentativa = identificarEspecialidade(texto);
        if (tentativa !== 'outro') especDetectada = tentativa;
      }
      if (especDetectada) {
        s.espec = especDetectada;
        s.step = 'q3';
        s.perguntaAtual = ESPECIALIDADES[especDetectada].q3.replace('{nome}', s.nome);
        return enviar(s.perguntaAtual);
      }
      s.step = 'especialidade';
      return enviar(menuEspecialidade(s.nome));
    }
    case 'urgencia': {
      // Paciente descreveu a dor → eco + registra + UM ÚNICO pedido de horário
      s.respostas.situacao = texto;
      s.step = 'agenda';
      const ecoUrg = ecoValido(texto) ? `${ecoar(texto)} — anotado com carinho. ` : '';
      const bh = blocoHorarios();
      s.perguntaAtual = `Entendi, ${s.nome} 😟 Obrigada por confiar em mim com isso.\n${ecoUrg}Já registrei seu caso como *prioridade*.\n\n${bh ? bh + '\n\n' : ''}Me diz o dia e horário que fica melhor pra você, que eu já reservo 🙏`;
      return enviar(s.perguntaAtual);
    }
    case 'especialidade': {
      s.espec = identificarEspecialidade(texto);
      s.step = 'q3';
      s.perguntaAtual = ESPECIALIDADES[s.espec].q3.replace('{nome}', s.nome);
      return enviar(s.perguntaAtual);
    }
    case 'q3': {
      s.respostas.situacao = texto;
      s.step = 'q4';
      const eco = ecoValido(texto) ? `${ecoar(texto)} — isso é um detalhe importante. ` : '';
      s.perguntaAtual = `${eco}${espec.q4.replace('{nome}', s.nome)}`;
      return enviar(s.perguntaAtual);
    }
    case 'q4': {
      s.respostas.problema = texto;
      s.step = 'implicacao';
      const reacao = REACOES_CLINICAS.find(r => TEM(t, r.quando));
      const cadImplicacao = reacao ? `${reacao.titulo}: ${reacao.texto.replace('{nome}', s.nome)}\n${espec.implicacao.replace('{nome}', s.nome)}` : espec.implicacao.replace('{nome}', s.nome);
      s.perguntaAtual = cadImplicacao;
      return enviar(cadImplicacao);
    }
    case 'implicacao': {
      // Resposta à pergunta de urgência ("quanto tempo mais quer conviver com isso?") —
      // esse é o sinal de qualificação mais forte do funil: mede disposição real, não só interesse.
      s.respostas.urgenciaPercebida = texto;
      s.temperaturaLead = classificarUrgenciaPercebida(t);
      s.step = 'fechamento';
      return enviar(espec.necessidade.replace('{nome}', s.nome));
    }
    case 'fechamento': {
      const recusa = /^(nao|n)\b/.test(t) || TEM(t, ['agora nao', 'depois', 'outro dia', 'por enquanto']);
      if (!recusa && TEM(t, ['sim', 'quero', 'pode', 'claro', 'bora', 'vamos'])) {
        s.step = 'orcamento';
        s.perguntaAtual = `Perfeito, ${s.nome}! Só uma coisinha antes de eu reservar: o investimento que te passei encaixa no seu planejamento agora, ou prefere que eu te explique as condições de pagamento primeiro? 😊`;
        return enviar(s.perguntaAtual);
      }
      if (recusa) {
        await enviar(`Tranquilo, ${s.nome}! 😊 Vou anotar seu interesse em *${espec.rotulo}* — quando quiser retomar, é só me chamar aqui.\nE qualquer dúvida que surgir, pode me perguntar 💙`);
        registrarConversa(s.nome, from, `[BIA-CAPTACAO] [${classificarLead(s)}] ${espec.rotulo} | situacao: ${s.respostas.situacao || '-'} | problema: ${s.respostas.problema || '-'}`).catch(() => {});
        registrarLeadFrio(from, { nome: s.nome, tratamento: espec.rotulo, motivo: 'recusa' });
        delete sessoes[from];
        concluidos[from] = Date.now();
        return;
      }
      await enviar(`Entendi, ${s.nome} 😊 Se quiser, te explico mais sobre *${espec.rotulo}* — é só pedir *mais informações*.\nE me diz: quer que eu reserve sua avaliação? (*sim*, *não* ou *mais informações*)`);
      return;
    }
    case 'orcamento': {
      const naoEncaixa = TEM(t, ['nao', 'apertado', 'caro', 'dificil', 'complicado', 'nao consigo', 'nao da']) && !TEM(t, ['sim']);
      s.orcamentoOk = !naoEncaixa;
      s.step = 'agenda';
      if (naoEncaixa) {
        await enviar(`Sem problema, ${s.nome}! 😊 A gente trabalha com Pix, cartão ou 40% de entrada + saldo em até 10x sem juros — isso costuma ajudar bastante.\nMesmo assim, vamos seguir com a avaliação? Lá o Dr. Bruno também pode montar um plano que caiba melhor no seu momento.`);
        return enviar(retomar(s));
      }
      return enviar(`Ótimo, ${s.nome}! 🎉${horariosLivres()}`);
    }
    case 'agenda': {
      if (!pareceHorarioValido(texto)) {
        return enviar(`Não entendi direito, ${s.nome} 😅 Me diz um dia e horário (ex: "sexta às 15h" ou "25/09 às 14h") que eu já anoto pra você! 🗓️`);
      }
      const textoNormalizado = normalizar(texto).trim();
      const conflito = reservasHorario.find(r => r.textoNormalizado === textoNormalizado);
      await enviar(`📅 Anotado, ${s.nome}! Registrei: *${texto}*.\nA equipe vai confirmar seu horário com você por aqui. Qualquer dúvida, estou por aqui! 😊💙`);
      registrarConversa(s.nome, from, `[BIA-QUALIFICADO] [${classificarLead(s)}] ${espec.rotulo} | horario: ${texto} | situacao: ${s.respostas.situacao || '-'} | problema: ${s.respostas.problema || '-'}${conflito ? ' | ⚠️ POSSÍVEL CONFLITO DE HORÁRIO' : ''}`).catch(() => {});
      reservasHorario.push({ texto, textoNormalizado, nome: s.nome, numero: from, ts: Date.now() });
      notificarAgendamento({ nome: s.nome, numero: from, tratamento: espec.rotulo, horario: texto, conflito: !!conflito }).catch(() => {});
      registrarAgendamentoPlanilha({ nome: s.nome, numero: from, tratamento: espec.rotulo, situacao: s.respostas.situacao, problema: s.respostas.problema }).catch(() => {});
      delete sessoes[from];
      concluidos[from] = Date.now();
      return;
    }
  }
}

// ===== 6) WEBHOOKS =====
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ===== 8) PAINEL DE CONVERSAS (visualização simples, protegida por senha) =====
// Acesse: https://SEU-DOMINIO.up.railway.app/conversas?senha=SUA_SENHA
// A senha vem da variável de ambiente ADMIN_PASSWORD (configure no Railway).
function escaparHTML(texto) {
  return (texto || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function jsonSeguroParaScript(dados) {
  // Evita que "</script>" dentro de uma mensagem do paciente quebre a página
  return JSON.stringify(dados).replace(/</g, '\\u003c');
}

app.get('/conversas', async (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(500).send('Configure a variável ADMIN_PASSWORD no Railway pra habilitar essa página.');
  if (req.query.senha !== ADMIN_PASSWORD) return res.status(401).send('Acesso negado. Use a URL com ?senha=SUA_SENHA no final.');

  try {
    const respSheet = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'A:D' });
    const linhas = (respSheet.data.values || []).filter(l => l[2] && /^\d+$/.test(String(l[2]).trim()));

    const conversas = {};
    for (const linha of linhas) {
      const [dataHora, nome, numero, mensagem] = linha;
      if (!conversas[numero]) conversas[numero] = { nome: nome || numero, mensagens: [] };
      if (nome) conversas[numero].nome = nome;
      conversas[numero].mensagens.push({ dataHora: dataHora || '', mensagem: mensagem || '' });
    }

    const listaConversas = Object.entries(conversas)
      .map(([numero, dados]) => ({ numero, ...dados }))
      .sort((a, b) => (b.mensagens.length ? b.mensagens[b.mensagens.length - 1].dataHora : '').localeCompare(a.mensagens.length ? a.mensagens[a.mensagens.length - 1].dataHora : ''));

    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Conversas — Bia</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, sans-serif; background:#e5ddd5; margin:0; padding:0; display:flex; height:100vh; }
  #lista { width:320px; min-width:320px; overflow-y:auto; background:#fff; border-right:1px solid #ddd; }
  #lista .item { padding:12px 16px; border-bottom:1px solid #eee; cursor:pointer; }
  #lista .item:hover { background:#f5f5f5; }
  #lista .item.ativo { background:#e8f5e9; }
  #lista .nome { font-weight:600; color:#111; }
  #lista .numero { font-size:12px; color:#888; }
  #chat { flex:1; overflow-y:auto; padding:20px; }
  .bubble { max-width:60%; margin:6px 0; padding:8px 12px; border-radius:8px; background:#fff; box-shadow:0 1px 1px rgba(0,0,0,0.1); white-space:pre-wrap; word-break:break-word; }
  .hora { font-size:10px; color:#999; margin-top:4px; }
  h2 { padding:16px; margin:0; background:#075e54; color:#fff; font-size:16px; position:sticky; top:0; }
  @media (max-width: 700px) { body { flex-direction:column; } #lista { width:100%; max-height:40vh; } }
</style>
</head>
<body>
<div id="lista">
  <h2>Conversas (${listaConversas.length})</h2>
  ${listaConversas.map((c, i) => `
    <div class="item" onclick="mostrar(${i})" id="item-${i}">
      <div class="nome">${escaparHTML(c.nome)}</div>
      <div class="numero">${escaparHTML(c.numero)} · ${c.mensagens.length} msgs</div>
    </div>
  `).join('')}
</div>
<div id="chat"><p style="color:#999; text-align:center; margin-top:40px;">Selecione uma conversa à esquerda</p></div>
<script>
  const dados = ${jsonSeguroParaScript(listaConversas)};
  function escapar(t) { const d = document.createElement('div'); d.innerText = t; return d.innerHTML; }
  function mostrar(i) {
    document.querySelectorAll('#lista .item').forEach(el => el.classList.remove('ativo'));
    document.getElementById('item-' + i).classList.add('ativo');
    const c = dados[i];
    const chat = document.getElementById('chat');
    chat.innerHTML = c.mensagens.map(m =>
      '<div class="bubble">' + escapar(m.mensagem) + '<div class="hora">' + escapar(m.dataHora) + '</div></div>'
    ).join('');
    chat.scrollTop = chat.scrollHeight;
  }
</script>
</body>
</html>`;
    res.send(html);
  } catch (err) {
    console.error('Erro ao gerar painel de conversas:', err.message);
    res.status(500).send('Erro ao carregar conversas: ' + err.message);
  }
});

// Funil ou assistente — roteia um TEXTO (digitado ou transcrito de áudio)
async function processarTexto(from, texto, nome) {
  // Se a pessoa respondeu, ela "esquentou" de novo — sai da fila de follow-up automático
  if (leadsFrios[from]) delete leadsFrios[from];
  // Envio de mensagem NUNCA deve derrubar o registro/CRM/notificação — só loga se falhar
  const enviar = async corpo => {
    try { await sendTextMessage(from, corpo); }
    catch (err) { console.error('Falha ao enviar mensagem pro paciente:', err.response?.data || err.message); }
  };
  if (sessoes[from] && !sessoes[from].nome && primeiroNome(nome) && primeiroNome(nome) !== 'Sem') {
    sessoes[from].nome = primeiroNome(nome);
  }
  try {
    if (sessoes[from]) {
      await flowFunil(from, texto, enviar, nome);
    } else {
      const jaPassouFunil = concluidos[from] && (Date.now() - concluidos[from] < 24 * 60 * 60 * 1000);
      if (jaPassouFunil) {
        await enviar(responder(texto, nome));
      } else {
        await enviar(iniciarFunil(from, texto, nome));
      }
    }
  } finally {
    persistirTudo(); // garante que nada se perde mesmo se o processo cair logo em seguida
  }
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message) return;

    // --- TEXTO ---
    if (message.type === 'text') {
      const from = message.from;
      const texto = message.text?.body;
      const nome = value.contacts?.[0]?.profile?.name || 'Sem nome';
      console.log('Mensagem de', nome, `(${from}):`, texto);
      registrarConversa(nome, from, texto).catch(err => console.error('Falha no Sheets:', err.message));
      await processarTexto(from, texto, nome);
      return;
    }

    // --- ÁUDIO: baixa, transcreve com Gemini e trata como texto ---
    if (message.type === 'audio' || message.type === 'voice') {
      const from = message.from;
      const nome = value.contacts?.[0]?.profile?.name || 'Sem nome';
      const mediaId = message.audio?.id || message.voice?.id;
      const mimeType = (message.audio?.mime_type || message.voice?.mime_type || 'audio/ogg').split(';')[0];
      console.log('Audio de', nome, `(${from}) — transcrevendo...`);
      registrarConversa(nome, from, '[Audio recebido]').catch(() => {});

      if (!sessoes[from]) iniciarFunil(from, '', nome);

      let transcricao = null;
      try {
        transcricao = await transcreverAudio(mediaId, mimeType);
        console.log('Transcrição:', transcricao);
      } catch (err) {
        console.error('=== ERRO COMPLETO NA TRANSCRIÇÃO ===');
        console.error(JSON.stringify(err.response?.data || err.message, null, 2));
      }

      if (transcricao) {
        registrarConversa(nome, from, `[Audio transcrito] ${transcricao}`).catch(() => {});
        await processarTexto(from, transcricao, nome);
      } else {
        const s = sessoes[from];
        const extra = s ? '\n\n' + retomar(s) : '';
        await sendTextMessage(from, `Recebi seu áudio, ${primeiroNome(nome)} 😊\nNão consegui ouvir agora — consegue me escrever? Assim não perco nenhum detalhe!${extra}`);
        persistirTudo();
      }
      return;
    }
  } catch (err) {
    console.error('Erro no webhook:', err.response?.data || err.message);
  }
});
async function sendTextMessage(to, body) {
  await axios.post(GRAPH_API_URL, { messaging_product: 'whatsapp', to, type: 'text', text: { body } }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
}

// ===== 7) NOTIFICAÇÃO PRO DR. BRUNO QUANDO ALGUÉM AGENDA =====
async function notificarAgendamento({ nome, numero, tratamento, horario, conflito }) {
  if (!DR_WHATSAPP_NUMBER) return; // variável não configurada, não tenta enviar
  const numeroFormatado = numero.startsWith('55') ? `+${numero}` : numero;
  const avisoConflito = conflito ? '\n\n⚠️ *Atenção:* já existe outro agendamento com o mesmo horário digitado — confira antes de confirmar.' : '';
  const corpo = `🔔 *Novo agendamento pela Bia!*\n\n👤 Paciente: ${nome}\n📱 WhatsApp: ${numeroFormatado}\n🦷 Interesse: ${tratamento}\n🗓️ Horário informado: ${horario}${avisoConflito}\n\nManda uma mensagem de agradecimento pra ele(a) 😊`;
  try {
    await sendTextMessage(DR_WHATSAPP_NUMBER, corpo);
  } catch (err) {
    console.error('Falha ao notificar Dr. Bruno:', err.response?.data || err.message);
  }
}

app.listen(PORT, () => console.log('Bia no ar na porta', PORT));
