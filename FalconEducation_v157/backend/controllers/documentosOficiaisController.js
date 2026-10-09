import db from '../config/db.js';
import PDFDocument from 'pdfkit';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { registrarAuditoria } from '../services/auditService.js';
import { montarBoletimAluno, ESCALA_QUALITATIVA } from './gradeController.js';
import { getAnoLetivoAtivo } from '../services/academicYearService.js';

const queryAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.query(sql, params, (err, results) => {
    if (err) return reject(err);
    resolve(results);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DOCUMENTOS OFICIAIS DO ALUNO — Declaração e Certificado (v141)
// ─────────────────────────────────────────────────────────────────────────────
// Duas novas abas do Perfil 360° do Aluno, distintas do módulo "Documentos"
// (que arquiva ficheiros digitalizados como BI/Certidão/Foto — ver
// alunoDocumentosController.js): aqui a escola EMITE, a partir dos dados já
// existentes no sistema, dois tipos de documento oficial:
//
//   1. DECLARAÇÃO — carta institucional (matrícula, frequência, conclusão,
//      transferência ou comportamento) escrita em linguagem formal usada em
//      Moçambique ("Para os devidos efeitos se declara que...").
//   2. CERTIFICADO DE APROVEITAMENTO ESCOLAR — só pode ser emitido para um
//      ano letivo em que a situação_geral calculada pelo motor de notas
//      (gradeController.montarBoletimAluno) seja uma situação de aprovação
//      — "Aprovado" (classes com exame) ou "Transita" (classes sem exame,
//      ver configuracaoAcademicaService.js/SITUACOES_APROVACAO abaixo). Não
//      existe forma de contornar esta verificação a partir do frontend — é
//      sempre recalculada aqui no servidor a partir das notas reais, na
//      mesma lógica (Regulamento Geral de Avaliação / Diploma Ministerial
//      n.º 59/2015) usada no boletim e na pauta oficial. Isto segue a mesma
//      filosofia de "nunca fabricar dados" já aplicada no resto do sistema
//      (resilientQuery.js, bloqueio de Aprovado/Reprovado com avaliação
//      incompleta, etc.) — o FalconEducation nunca deve emitir um
//      certificado de aproveitamento para quem não tenha, de facto,
//      aprovado.
//
// Cada emissão fica registada em `documentos_emitidos` (número de registo
// sequencial, tipo, quem assinou, para que efeito) — o mesmo espírito do
// `escola_audit_logs`, mas pensado para a escola poder mostrar, se alguma
// vez for preciso, "quando e para quê foi emitida esta declaração". O PDF
// gerado também fica guardado em disco (uploads/documentos-oficiais/), para
// a escola conseguir obter uma segunda via EXATAMENTE igual à emitida da
// primeira vez — sem depender de as notas não terem mudado entretanto.
// ═══════════════════════════════════════════════════════════════════════════════

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PASTA_UPLOADS = path.join(__dirname, '..', 'uploads', 'documentos-oficiais');
if (!fs.existsSync(PASTA_UPLOADS)) {
  fs.mkdirSync(PASTA_UPLOADS, { recursive: true });
}

const memoize = (fn) => {
  let done = false;
  let inflight = null;
  return async (...args) => {
    if (done) return;
    if (!inflight) inflight = fn(...args).then(() => { done = true; });
    return inflight;
  };
};

export const ensureTabelaExists = memoize(async () => {
  await queryAsync(`
    CREATE TABLE IF NOT EXISTS documentos_emitidos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL,
      student_id INT NOT NULL,
      tipo VARCHAR(20) NOT NULL,
      subtipo VARCHAR(30) NULL,
      numero_registo VARCHAR(30) NOT NULL DEFAULT '',
      ano_letivo VARCHAR(20) NULL,
      classe_nome VARCHAR(60) NULL,
      finalidade TEXT NULL,
      assinante VARCHAR(150) NULL,
      cargo_assinante VARCHAR(80) NULL,
      arquivo_nome VARCHAR(255) NULL,
      emitido_por VARCHAR(150) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_school_student (school_id, student_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
});

// ── TIPOS DE DECLARAÇÃO SUPORTADOS ──────────────────────────────────────────
const TIPOS_DECLARACAO = {
  matricula: 'Declaração de Matrícula',
  frequencia: 'Declaração de Frequência',
  conclusao: 'Declaração de Conclusão',
  transferencia: 'Declaração para Efeitos de Transferência',
  comportamento: 'Declaração de Comportamento',
  outro: 'Declaração',
};
const TIPOS_DECLARACAO_VALIDOS = Object.keys(TIPOS_DECLARACAO);

// ── GERAÇÃO DE PDF EM MEMÓRIA (mesmo padrão de services/pdfReceiptService.js) ─
const gerarBuffer = (montarConteudo) => new Promise((resolve, reject) => {
  try {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const pedacos = [];
    doc.on('data', (pedaco) => pedacos.push(pedaco));
    doc.on('end', () => resolve(Buffer.concat(pedacos)));
    doc.on('error', reject);
    montarConteudo(doc);
    doc.end();
  } catch (err) {
    reject(err);
  }
});

const desenharCabecalhoEscola = (doc, escola) => {
  doc.fontSize(16).font('Helvetica-Bold').fillColor('#000000').text(escola.nome || 'Escola', { align: 'center' });
  if (escola.endereco) doc.fontSize(9.5).font('Helvetica').fillColor('#475569').text(escola.endereco, { align: 'center' });
  const contactos = [escola.telefone ? `Tel: ${escola.telefone}` : null, escola.nuit ? `NUIT: ${escola.nuit}` : null].filter(Boolean).join('   ·   ');
  if (contactos) doc.fontSize(9.5).font('Helvetica').fillColor('#475569').text(contactos, { align: 'center' });
  doc.moveDown(1);
  doc.strokeColor('#cbd5e1').moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(1);
};

const desenharNumeroRegisto = (doc, numero) => {
  doc.fontSize(9).font('Helvetica').fillColor('#64748b').text(`Nº de registo: ${numero}`, { align: 'right' });
  doc.moveDown(0.6);
};

const MESES_PT = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const formatarDataExtenso = (d) => `aos ${d.getDate()} de ${MESES_PT[d.getMonth()]} de ${d.getFullYear()}`;

const desenharAssinatura = (doc, { assinante, cargo, provincia }) => {
  doc.moveDown(2.5);
  const local = (provincia || 'Maputo').replace(' Província', '').replace(' Cidade', '');
  doc.fontSize(10.5).font('Helvetica').fillColor('#334155').text(`${local}, ${formatarDataExtenso(new Date())}`, { align: 'right' });
  doc.moveDown(2.2);
  doc.fontSize(10.5).text('_____________________________________', { align: 'center' });
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').fillColor('#1e293b').text(assinante || 'A Direção da Escola', { align: 'center' });
  doc.font('Helvetica').fontSize(9.5).fillColor('#64748b').text(cargo || 'Diretor(a) da Escola', { align: 'center' });
};

// ── ABREVIATURAS DE DISCIPLINAS (v145) ──────────────────────────────────────
// Mapa manual para as disciplinas do catálogo padrão moçambicano
// (disciplinaController.js:DISCIPLINAS_PADRAO), no mesmo estilo abreviado
// usado nas pautas físicas moçambicanas (Port, Mat, Ing, ...). Disciplinas
// criadas pela escola com nomes fora deste mapa caem no algoritmo de
// abreviação automática logo a seguir, nunca ficam sem abreviar.
const ABREVIATURAS_DISCIPLINAS = {
  'Português': 'Port',
  'Inglês': 'Ing',
  'Matemática': 'Mat',
  'Ciências Naturais': 'C. Nat.',
  'Estudo do Meio': 'E. Meio',
  'História e Geografia': 'Hist/Geog',
  'Educação Visual': 'E. Visual',
  'Educação Física': 'E. Física',
  'Moral e Cívica': 'M. Cívica',
  'Educação Musical': 'E. Musical',
  'Educação Tecnológica': 'E. Tecnol.',
  'Desenho': 'Desenho',
  'Trabalhos Manuais': 'Tr. Manuais',
  'Francês': 'Francês',
  'Biologia': 'Biologia',
  'Física': 'Física',
  'Química': 'Química',
  'Educação Cívica': 'E. Cívica',
  'Tecnologias de Informação': 'TIC',
  'Artística': 'Artística',
  'Contabilidade': 'Contab.',
  'Economia': 'Economia',
  'Direito': 'Direito',
  'Agronomia': 'Agronomia',
  'Desenho Técnico': 'D. Técnico',
  'Literatura': 'Literatura',
  'Filosofia': 'Filosofia',
  'Psicologia': 'Psicologia',
  'Estatística': 'Estatística',
  'Sociologia': 'Sociologia',
  'Natação': 'Natação',
  'Educação Desportiva': 'E. Desport.',
  'Xadrez': 'Xadrez',
  'Ginástica': 'Ginástica',
  'Dança': 'Dança',
  'Teatro': 'Teatro',
  'Artes Plásticas': 'A. Plásticas',
  'Música Instrumental': 'M. Instrum.',
  'Educação Ambiental': 'E. Ambiental',
  'Saúde Pública': 'S. Pública',
  'Segurança e Higiene': 'Seg. Higiene',
  'Noções de Direito': 'N. Direito',
  'Empreendedorismo': 'Empreend.',
  'Informática Básica': 'Informática',
};
const PALAVRAS_IGNORAR_ABREVIATURA = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'a', 'o', 'em']);

// Abrevia qualquer disciplina não coberta pelo mapa acima, para disciplinas
// personalizadas que a escola tenha criado com nome próprio.
const abreviarDisciplina = (nome) => {
  if (!nome) return '—';
  if (ABREVIATURAS_DISCIPLINAS[nome]) return ABREVIATURAS_DISCIPLINAS[nome];
  const palavras = nome.trim().split(/\s+/).filter(Boolean);
  const significativas = palavras.filter((p) => !PALAVRAS_IGNORAR_ABREVIATURA.has(p.toLowerCase()));
  const base = significativas.length ? significativas : palavras;
  if (base.length === 1) {
    const p = base[0];
    return p.length <= 7 ? p : `${p.slice(0, 6)}.`;
  }
  const primeira = base[0].length <= 5 ? base[0] : `${base[0].slice(0, 4)}.`;
  const resto = base.slice(1, 3).map((p) => `${p.charAt(0).toUpperCase()}.`).join('');
  return `${primeira} ${resto}`.trim();
};

// ── TABELA DE NOTAS (v145) ───────────────────────────────────────────────────
// Grelha visual usada no Certificado e na Declaração de Conclusão: cabeçalho
// roxo (mesma cor da caixa de secção da v144), linhas alternadas, classificação
// colorida por faixa (mesmas faixas de ESCALA_QUALITATIVA/classificarQualitativamente
// de gradeController.js — a cor é só apresentação, o valor vem sempre do motor
// de notas real). Paginação simples: se a tabela não couber, abre nova página.
const CORES_CLASSIFICACAO = {
  'Excelente': '#15803d',
  'Muito Bom': '#16a34a',
  'Bom': '#2563eb',
  'Satisfatório': '#ca8a04',
  'Não Satisfatório': '#dc2626',
};

const desenharTabelaNotas = (doc, disciplinas, { mediaGeral, classificacaoGeral, situacaoGeral } = {}) => {
  const xInicio = 50;
  const larguraTotal = 495;
  const colDisciplina = 220;
  const colMedia = 85;
  const colClassificacao = larguraTotal - colDisciplina - colMedia;
  const alturaCabecalho = 24;
  const alturaLinha = 22;
  const margemInferior = 90; // espaço reservado para assinatura + rodapé

  const desenharCabecalhoTabela = (y) => {
    doc.rect(xInicio, y, larguraTotal, alturaCabecalho).fillAndStroke('#4c1d95', '#4c1d95');
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9.5);
    doc.text('DISCIPLINA', xInicio + 10, y + 7, { width: colDisciplina - 10 });
    doc.text('MÉDIA', xInicio + colDisciplina, y + 7, { width: colMedia, align: 'center' });
    doc.text('CLASSIFICAÇÃO', xInicio + colDisciplina + colMedia, y + 7, { width: colClassificacao - 10, align: 'center' });
    return y + alturaCabecalho;
  };

  let y = doc.y + 4;
  y = desenharCabecalhoTabela(y);
  doc.lineWidth(0.5);

  disciplinas.forEach((d, i) => {
    if (y + alturaLinha > doc.page.height - margemInferior) {
      doc.addPage();
      y = 50;
      y = desenharCabecalhoTabela(y);
    }
    const corFundo = i % 2 === 0 ? '#ffffff' : '#f8fafc';
    doc.rect(xInicio, y, larguraTotal, alturaLinha).fillAndStroke(corFundo, '#e2e8f0');

    doc.fillColor('#1e293b').font('Helvetica').fontSize(9.5);
    doc.text(abreviarDisciplina(d.disciplina_nome), xInicio + 10, y + 6, { width: colDisciplina - 10 });
    doc.text(d.media != null ? d.media.toFixed(1) : '—', xInicio + colDisciplina, y + 6, { width: colMedia, align: 'center' });

    const corClassificacao = CORES_CLASSIFICACAO[d.classificacao] || '#334155';
    doc.fillColor(corClassificacao).font('Helvetica-Bold');
    doc.text(d.classificacao || '—', xInicio + colDisciplina + colMedia, y + 6, { width: colClassificacao - 10, align: 'center' });

    y += alturaLinha;
  });

  if (mediaGeral !== undefined) {
    doc.rect(xInicio, y, larguraTotal, 28).fillAndStroke('#ede9fe', '#ddd6fe');
    doc.fillColor('#4c1d95').font('Helvetica-Bold').fontSize(10.5);
    const situacaoTexto = situacaoGeral ? `   ·   Situação: ${situacaoGeral}` : '';
    doc.text(
      `Média Geral: ${mediaGeral != null ? mediaGeral.toFixed(1) : '—'}  (${classificacaoGeral || '—'})${situacaoTexto}`,
      xInicio, y + 8, { width: larguraTotal, align: 'center' }
    );
    y += 28;
  }

  doc.fillColor('#000000').font('Helvetica').fontSize(11.5);
  doc.y = y + 12;
  doc.x = 50;
};

const desenharRodape = (doc) => {
  doc.moveDown(2);
  doc.fontSize(8).font('Helvetica').fillColor('#94a3b8').text(
    `Documento emitido pelo FalconEducation em ${new Date().toLocaleString('pt-PT')}. A autenticidade deste documento pode ser confirmada junto da secretaria da escola.`,
    { align: 'center' }
  );
};

// ── DADOS DO ALUNO + ESCOLA (mesmo JOIN usado em pdfReceiptService.js) ──────
const buscarDadosAluno = async (schoolId, studentId) => {
  const linhas = await queryAsync(
    `
      SELECT s.id, s.nome, s.codigo_aluno, s.data_nascimento, s.genero, s.documento, s.morada,
             t.nome as turma_nome, c.nome as classe_nome,
             sc.name as escola_nome, sc.address as escola_endereco, sc.phone as escola_telefone,
             sc.nuit as escola_nuit, sc.provincia as escola_provincia
      FROM students s
      LEFT JOIN turmas t ON t.id = s.turma_id
      LEFT JOIN classes c ON c.id = t.class_id
      LEFT JOIN schools sc ON sc.id = s.school_id
      WHERE s.id = ? AND s.school_id = ?
      LIMIT 1
    `,
    [studentId, schoolId]
  );
  return linhas[0] || null;
};

// ── TEXTO DA DECLARAÇÃO, por tipo ────────────────────────────────────────────
const montarCorpoDeclaracao = (tipo, { aluno, anoLetivoNome, corpoPersonalizado }) => {
  const nascimento = aluno.data_nascimento ? new Date(aluno.data_nascimento).toLocaleDateString('pt-PT') : null;
  const identificacao = [
    aluno.documento ? `portador(a) do documento de identificação n.º ${aluno.documento}` : null,
    nascimento ? `nascido(a) a ${nascimento}` : null,
  ].filter(Boolean).join(', ');
  const abertura = `Para os devidos efeitos se declara que ${aluno.nome}${identificacao ? `, ${identificacao},` : ','}`;
  const classeNome = aluno.classe_nome || 'classe não identificada';
  const turmaNome = aluno.turma_nome || '—';

  switch (tipo) {
    case 'matricula':
      return `${abertura} se encontra devidamente matriculado(a) nesta instituição de ensino, na ${classeNome}, turma ${turmaNome}, no ano letivo de ${anoLetivoNome}.`;
    case 'frequencia':
      return `${abertura} é aluno(a) desta instituição de ensino, encontrando-se a frequentar com assiduidade a ${classeNome}, turma ${turmaNome}, no ano letivo de ${anoLetivoNome}.`;
    case 'conclusao':
      return `${abertura} concluiu, nesta instituição de ensino, a ${classeNome} no ano letivo de ${anoLetivoNome}, encontrando-se o respetivo certificado de aproveitamento escolar em fase de emissão.`;
    case 'transferencia':
      return `${abertura} foi aluno(a) desta instituição de ensino, tendo estado matriculado(a) na ${classeNome}, turma ${turmaNome}, até à presente data, não havendo, da parte desta instituição, qualquer objeção à sua transferência para outro estabelecimento de ensino.`;
    case 'comportamento':
      return `${abertura} frequenta esta instituição de ensino, não havendo, até à presente data, registo de ocorrências disciplinares que mereçam menção nesta declaração.`;
    case 'outro':
      return `${abertura} é aluno(a) desta instituição de ensino, ${corpoPersonalizado}`;
    default:
      return null;
  }
};

// GET /schools/:schoolId/students/:studentId/declaracao/pdf
// Query: tipo, finalidade, corpo_personalizado (só para tipo=outro), ano_letivo,
// assinante, cargo_assinante, ciente_ocorrencias (1|true — para tipo=comportamento
// quando há ocorrências disciplinares e o admin confirma que quer emitir mesmo assim)
export const gerarDeclaracaoPDF = async (req, res) => {
  try {
    await ensureTabelaExists();
    const { schoolId, studentId } = req.params;
    const tipo = String(req.query.tipo || '').toLowerCase().trim();
    const finalidade = String(req.query.finalidade || '').trim();
    const corpoPersonalizado = String(req.query.corpo_personalizado || '').trim();
    const assinante = String(req.query.assinante || '').trim() || null;
    const cargoAssinante = String(req.query.cargo_assinante || '').trim() || 'Diretor(a) da Escola';
    const anoLetivoQuery = String(req.query.ano_letivo || '').trim();
    const cienteOcorrencias = req.query.ciente_ocorrencias === '1' || req.query.ciente_ocorrencias === 'true';

    if (!TIPOS_DECLARACAO_VALIDOS.includes(tipo)) {
      return res.status(400).json({ success: false, message: 'Tipo de declaração inválido.' });
    }
    if (tipo === 'outro' && !corpoPersonalizado) {
      return res.status(400).json({ success: false, message: 'Para o tipo "Outro", escreva o texto da declaração.' });
    }

    const aluno = await buscarDadosAluno(schoolId, studentId);
    if (!aluno) return res.status(404).json({ success: false, message: 'Aluno não encontrado.' });

    // ── Coerência de dados: não emitir "Declaração de Comportamento" sem
    // avisar quando há ocorrências disciplinares registadas — a escola
    // decide conscientemente se ainda assim quer emitir (ex.: ocorrência
    // já resolvida/prescrita), mas nunca por omissão silenciosa. ─────────
    if (tipo === 'comportamento' && !cienteOcorrencias) {
      const contagem = await queryAsync(
        `SELECT COUNT(*) as qtd FROM ocorrencias_disciplinares WHERE school_id = ? AND student_id = ?`,
        [schoolId, studentId]
      ).catch(() => [{ qtd: 0 }]);
      const qtd = contagem[0]?.qtd || 0;
      if (qtd > 0) {
        return res.status(409).json({
          success: false,
          requer_confirmacao: true,
          ocorrencias_qtd: qtd,
          message: `Este aluno tem ${qtd} ocorrência(s) disciplinar(es) registada(s) no sistema. Confirme que pretende emitir mesmo assim a declaração de comportamento.`,
        });
      }
    }

    const anoAtivo = await getAnoLetivoAtivo(schoolId);
    const anoLetivoNome = anoLetivoQuery || anoAtivo.nome;

    // Para "Declaração de Conclusão", busca as notas reais do ano letivo em
    // causa para desenhar a tabela de disciplinas/médias no PDF — mesma fonte
    // (montarBoletimAluno) usada no Certificado, boletim e pauta oficial.
    // Se o ano não tiver notas lançadas, a declaração sai sem tabela (nunca
    // inventa dados), só com o texto.
    let anoParaTabela = null;
    if (tipo === 'conclusao') {
      const boletim = await montarBoletimAluno(schoolId, studentId);
      anoParaTabela = boletim.anos.find((a) => String(a.ano_letivo) === String(parseInt(anoLetivoNome, 10))) || null;
    }

    const corpo = montarCorpoDeclaracao(tipo, { aluno, anoLetivoNome, corpoPersonalizado });
    if (!corpo) return res.status(400).json({ success: false, message: 'Não foi possível montar o texto da declaração.' });

    const fechamento = finalidade
      ? `A presente declaração é emitida a pedido do(a) interessado(a), para efeitos de ${finalidade}.`
      : 'A presente declaração é emitida a pedido do(a) interessado(a), para os fins que se mostrarem necessários.';

    // Regista a emissão primeiro para obter o `id` — usado como base do
    // número de registo (mesmo padrão REC-/MAT- de pdfReceiptService.js),
    // evitando condições de corrida de um contador manual por ano/escola.
    const inserido = await queryAsync(
      `INSERT INTO documentos_emitidos
         (school_id, student_id, tipo, subtipo, numero_registo, ano_letivo, classe_nome, finalidade, assinante, cargo_assinante, emitido_por, created_at)
       VALUES (?, ?, 'declaracao', ?, '', ?, ?, ?, ?, ?, ?, NOW())`,
      [schoolId, studentId, tipo, anoLetivoNome, aluno.classe_nome || null, finalidade || null, assinante, cargoAssinante, req.user?.nome || req.user?.email || null]
    );
    const numeroRegisto = `DECL-${new Date().getFullYear()}-${String(inserido.insertId).padStart(5, '0')}`;

    const buffer = await gerarBuffer((doc) => {
      desenharCabecalhoEscola(doc, { nome: aluno.escola_nome, endereco: aluno.escola_endereco, telefone: aluno.escola_telefone, nuit: aluno.escola_nuit });
      desenharNumeroRegisto(doc, numeroRegisto);
      doc.fontSize(15).font('Helvetica-Bold').fillColor('#000000').text((TIPOS_DECLARACAO[tipo] || 'Declaração').toUpperCase(), { align: 'center' });
      doc.moveDown(2);
      doc.fontSize(11.5).font('Helvetica').fillColor('#1e293b').text(corpo, { align: 'justify', lineGap: 4 });

      if (anoParaTabela && anoParaTabela.disciplinas.length > 0) {
        doc.moveDown(0.8);
        desenharTabelaNotas(doc, anoParaTabela.disciplinas, {
          mediaGeral: anoParaTabela.media_geral,
          classificacaoGeral: anoParaTabela.classificacao_geral,
          situacaoGeral: anoParaTabela.situacao_geral,
        });
      } else {
        doc.moveDown(1);
      }

      doc.fontSize(11.5).font('Helvetica').fillColor('#1e293b').text(fechamento, { align: 'justify', lineGap: 4 });
      desenharAssinatura(doc, { assinante, cargo: cargoAssinante, provincia: aluno.escola_provincia });
      desenharRodape(doc);
    });

    const nomeArquivo = `declaracao-${tipo}-${inserido.insertId}.pdf`;
    fs.writeFile(path.join(PASTA_UPLOADS, nomeArquivo), buffer, (err) => {
      if (err) console.error('[v0] Erro ao guardar cópia da declaração em disco:', err.message);
    });
    await queryAsync(`UPDATE documentos_emitidos SET numero_registo = ?, arquivo_nome = ? WHERE id = ?`, [numeroRegisto, nomeArquivo, inserido.insertId]);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${nomeArquivo}"`);
    res.send(buffer);

    registrarAuditoria(req, {
      acao: 'declaracao_emitida', entidadeTipo: 'documento_oficial', entidadeId: inserido.insertId,
      dadosNovos: { student_id: studentId, tipo, ano_letivo: anoLetivoNome, numero_registo: numeroRegisto },
    });
  } catch (err) {
    console.error('[v0] Erro ao gerar declaração em PDF:', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Erro ao gerar declaração em PDF', error: err.message });
  }
};

// v153 — "Aprovado" (classes com exame) e "Transita" (classes sem exame, ver
// configuracaoAcademicaService.js) são o MESMO resultado positivo — só muda
// a terminologia conforme o Diploma Ministerial de 2022 (mozaEvaluationRules.js).
// Antes desta correção, esta verificação só aceitava "Aprovado" literal, o
// que tornava o Certificado impossível de emitir para qualquer aluno de uma
// classe sem exame (a maioria das classes) desde que o boletim (v147) passou
// a devolver "Transita" para elas — desalinhamento real, não só estético.
const SITUACOES_APROVACAO = new Set(['Aprovado', 'Transita']);

// GET /schools/:schoolId/students/:studentId/certificado/elegibilidade
// Lista os anos letivos em que o aluno foi aprovado (situação geral
// recalculada a partir das notas reais — "Aprovado" ou "Transita", conforme
// a classe tenha ou não exame) — só esses podem gerar certificado.
export const getElegibilidadeCertificado = async (req, res) => {
  try {
    const { schoolId, studentId } = req.params;
    const boletim = await montarBoletimAluno(schoolId, studentId);
    const elegiveis = boletim.anos
      .filter((a) => SITUACOES_APROVACAO.has(a.situacao_geral))
      .map((a) => ({ ano_letivo: a.ano_letivo, classe_nome: a.classe_nome, media_geral: a.media_geral, situacao_geral: a.situacao_geral }));
    const naoElegiveis = boletim.anos
      .filter((a) => !SITUACOES_APROVACAO.has(a.situacao_geral))
      .map((a) => ({ ano_letivo: a.ano_letivo, classe_nome: a.classe_nome, situacao_geral: a.situacao_geral }));
    res.json({ success: true, elegiveis, nao_elegiveis: naoElegiveis, total_anos_com_notas: boletim.anos.length });
  } catch (err) {
    console.error('[v0] Erro ao verificar elegibilidade para certificado:', err);
    res.status(500).json({ success: false, message: 'Erro ao verificar elegibilidade para certificado', error: err.message });
  }
};

// GET /schools/:schoolId/students/:studentId/certificado/pdf?ano_letivo=2025
export const gerarCertificadoPDF = async (req, res) => {
  try {
    await ensureTabelaExists();
    const { schoolId, studentId } = req.params;
    const anoLetivoPedido = parseInt(req.query.ano_letivo, 10);
    const assinante = String(req.query.assinante || '').trim() || null;
    const cargoAssinante = String(req.query.cargo_assinante || '').trim() || 'Diretor(a) da Escola';

    if (!anoLetivoPedido) return res.status(400).json({ success: false, message: 'Indique o ano letivo do certificado.' });

    const aluno = await buscarDadosAluno(schoolId, studentId);
    if (!aluno) return res.status(404).json({ success: false, message: 'Aluno não encontrado.' });

    // A elegibilidade é SEMPRE recalculada aqui, a partir das notas reais —
    // nunca confiamos num valor vindo do frontend. Um certificado só sai se
    // situacao_geral for "Aprovado" (classe com exame) ou "Transita" (classe
    // sem exame) para o ano pedido — ver SITUACOES_APROVACAO acima.
    const boletim = await montarBoletimAluno(schoolId, studentId);
    const anoAlvo = boletim.anos.find((a) => a.ano_letivo === anoLetivoPedido);
    if (!anoAlvo) {
      return res.status(404).json({ success: false, message: `Não há notas lançadas para o ano letivo ${anoLetivoPedido}.` });
    }
    if (!SITUACOES_APROVACAO.has(anoAlvo.situacao_geral)) {
      return res.status(409).json({
        success: false,
        message: `Não é possível emitir o certificado: a situação geral deste aluno no ano letivo ${anoLetivoPedido} é "${anoAlvo.situacao_geral}", e não uma situação de aprovação. O FalconEducation só emite certificados de aproveitamento para anos letivos com aprovação confirmada nas notas.`,
      });
    }

    const inserido = await queryAsync(
      `INSERT INTO documentos_emitidos
         (school_id, student_id, tipo, subtipo, numero_registo, ano_letivo, classe_nome, finalidade, assinante, cargo_assinante, emitido_por, created_at)
       VALUES (?, ?, 'certificado', 'aproveitamento', '', ?, ?, NULL, ?, ?, ?, NOW())`,
      [schoolId, studentId, String(anoLetivoPedido), anoAlvo.classe_nome || null, assinante, cargoAssinante, req.user?.nome || req.user?.email || null]
    );
    const numeroRegisto = `CERT-${new Date().getFullYear()}-${String(inserido.insertId).padStart(5, '0')}`;

    const buffer = await gerarBuffer((doc) => {
      desenharCabecalhoEscola(doc, { nome: aluno.escola_nome, endereco: aluno.escola_endereco, telefone: aluno.escola_telefone, nuit: aluno.escola_nuit });
      desenharNumeroRegisto(doc, numeroRegisto);
      doc.fontSize(15).font('Helvetica-Bold').fillColor('#000000').text('CERTIFICADO DE APROVEITAMENTO ESCOLAR', { align: 'center' });
      doc.moveDown(1.6);

      const nascimento = aluno.data_nascimento ? new Date(aluno.data_nascimento).toLocaleDateString('pt-PT') : null;
      const identificacao = [
        aluno.documento ? `portador(a) do documento de identificação n.º ${aluno.documento}` : null,
        nascimento ? `nascido(a) a ${nascimento}` : null,
      ].filter(Boolean).join(', ');
      const corpo = `Para os devidos efeitos se certifica que ${aluno.nome}${identificacao ? `, ${identificacao},` : ','} concluiu com aproveitamento a ${anoAlvo.classe_nome || 'classe não identificada'}, no ano letivo de ${anoLetivoPedido}, nesta instituição de ensino, tendo obtido os seguintes resultados finais:`;
      doc.fontSize(11.5).font('Helvetica').fillColor('#1e293b').text(corpo, { align: 'justify', lineGap: 4 });
      doc.moveDown(0.8);

      if (anoAlvo.disciplinas.length === 0) {
        doc.fontSize(10).font('Helvetica').fillColor('#94a3b8').text('Sem disciplinas lançadas neste ano letivo.');
        doc.moveDown(0.8);
      } else {
        desenharTabelaNotas(doc, anoAlvo.disciplinas, {
          mediaGeral: anoAlvo.media_geral,
          classificacaoGeral: anoAlvo.classificacao_geral,
          situacaoGeral: anoAlvo.situacao_geral,
        });
      }

      doc.fontSize(9).font('Helvetica').fillColor('#94a3b8').text(
        `Classificação qualitativa (Artigo 31.º do Regulamento Geral de Avaliação): ${ESCALA_QUALITATIVA.slice().reverse().map((f) => `${f.min}–${f.max} ${f.label}`).join(' · ')}.`
      );

      desenharAssinatura(doc, { assinante, cargo: cargoAssinante, provincia: aluno.escola_provincia });
      desenharRodape(doc);
    });

    const nomeArquivo = `certificado-${anoLetivoPedido}-${inserido.insertId}.pdf`;
    fs.writeFile(path.join(PASTA_UPLOADS, nomeArquivo), buffer, (err) => {
      if (err) console.error('[v0] Erro ao guardar cópia do certificado em disco:', err.message);
    });
    await queryAsync(`UPDATE documentos_emitidos SET numero_registo = ?, arquivo_nome = ? WHERE id = ?`, [numeroRegisto, nomeArquivo, inserido.insertId]);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${nomeArquivo}"`);
    res.send(buffer);

    registrarAuditoria(req, {
      acao: 'certificado_emitido', entidadeTipo: 'documento_oficial', entidadeId: inserido.insertId,
      dadosNovos: { student_id: studentId, ano_letivo: anoLetivoPedido, classe_nome: anoAlvo.classe_nome, media_geral: anoAlvo.media_geral, numero_registo: numeroRegisto },
    });
  } catch (err) {
    console.error('[v0] Erro ao gerar certificado em PDF:', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Erro ao gerar certificado em PDF', error: err.message });
  }
};

// GET /schools/:schoolId/students/:studentId/documentos-oficiais
// Histórico de declarações/certificados já emitidos (para as abas mostrarem
// "emitido em X, por Y, para efeitos de Z" e permitirem obter uma segunda via).
export const getHistoricoDocumentosOficiais = async (req, res) => {
  try {
    await ensureTabelaExists();
    const { schoolId, studentId } = req.params;
    const historico = await queryAsync(
      `SELECT id, tipo, subtipo, numero_registo, ano_letivo, classe_nome, finalidade, assinante, cargo_assinante, arquivo_nome, emitido_por, created_at
       FROM documentos_emitidos WHERE school_id = ? AND student_id = ? ORDER BY created_at DESC LIMIT 100`,
      [schoolId, studentId]
    );
    res.json({ success: true, data: historico });
  } catch (err) {
    console.error('[v0] Erro ao listar histórico de documentos oficiais:', err);
    res.status(500).json({ success: false, message: 'Erro ao listar histórico de documentos oficiais', error: err.message });
  }
};
