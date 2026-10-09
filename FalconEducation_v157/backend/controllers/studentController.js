import db from '../config/db.js';
import bcrypt from 'bcrypt';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { sugerirProgressao, verificarCooldownRenovacao, calcularRondaRenovacao } from './renewalController.js';
import { criarNotificacao } from './notificationController.js';
import { resolverAnoLetivoPorData } from './academicYearController.js';
import { ensurePaymentColumnsExist } from './mensalidades.controller.js';
import { verificarJanelaRenovacaoAberta } from '../services/enrollmentStatusService.js';
import { gerarCobrancaRenovacao, gerarCobrancaInscricao } from '../services/financialStatusService.js';
import { registrarAuditoria } from '../services/auditService.js';
import { calcularFrequenciaAluno } from './attendanceController.js';
import { calcularMediaGeralAluno } from './perfilAlunoController.js';
import { getConfigAvaliacao } from './gradeController.js';
import { ensureTabelasHorario } from './horarioController.js';

import { notificarInscricaoAluno, notificarRenovacaoMatricula } from '../services/notificacaoRelatorioService.js';
import { ensureSecoesTableExists, ensureTurmaSecaoColumnExists, secaoEhObrigatoriaParaClasse, getSecaoSettings, sincronizarSecaoDoAluno, ensureStudentSecaoColumnExists } from './secaoController.js';

const queryAsync = (sql, params = []) => new Promise((resolve, reject) => {

  db.query(sql, params, (err, results) => {

    if (err) return reject(err);

    resolve(results);

  });

});



const columnExists = async (table, column) => {

  const result = await queryAsync(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);

  return result.length > 0;

};

// Cache simples em memória: cada "ensureXxx" migra a base de dados (CREATE
// TABLE IF NOT EXISTS / ALTER TABLE ADD COLUMN se faltar) — são operações
// idempotentes, mas não precisam de correr em CADA pedido. Com memoize(),
// corre uma vez (a primeira chamada depois de o servidor arrancar) e todas as
// chamadas seguintes ficam instantâneas, reduzindo uma ida à base de dados por
// pedido em todas as rotas que dependem destas tabelas.
const memoize = (fn) => {
  let done = false;
  let inflight = null;
  return async (...args) => {
    if (done) return;
    if (!inflight) inflight = fn(...args).then(() => { done = true; });
    return inflight;
  };
};




export const ensureStudentPasswordColumnExists = memoize(async () => {

  const exists = await columnExists('students', 'password');

  if (!exists) {

    await queryAsync('ALTER TABLE students ADD COLUMN password VARCHAR(255) NULL AFTER email');

  }

});



const gerarCodigoAluno = (studentId, schoolId) => {

  const hoje = new Date();

  const dia = String(hoje.getDate()).padStart(2, '0');

  const ano = String(hoje.getFullYear());

  return `${studentId}${schoolId}${dia}${ano}`;

};

// v82 — mesma garantia que já existe para o professor (gerarCodigoProfessorUnico
// em teacherController.js): o studentId é a chave primária AUTO_INCREMENT da
// tabela `students`, por isso já é matematicamente impossível dois alunos
// receberem o mesmo código — ainda assim confirmamos na base de dados por
// segurança extra, e caímos num sufixo numérico no caso impossível de
// colisão. Isto passou a importar mais desde a v82: o codigo_aluno é agora
// também a credencial de login da Área do Aluno.
const gerarCodigoAlunoUnico = async (studentId, schoolId) => {
  let candidato = gerarCodigoAluno(studentId, schoolId);
  let tentativa = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const existente = await queryAsync(`SELECT id FROM students WHERE codigo_aluno = ? AND id != ? LIMIT 1`, [candidato, studentId]);
    if (existente.length === 0) return candidato;
    tentativa += 1;
    candidato = `${gerarCodigoAluno(studentId, schoolId)}-${tentativa}`;
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// IMPORTAÇÃO DE ALUNOS EM MASSA (Excel/.xlsx/.csv) — usado pelo botão
// "Importar Excel" na aba Alunos. Guarda o ficheiro só em memória (não fica
// gravado em disco), lê a primeira folha e cria um aluno por linha.
// ═══════════════════════════════════════════════════════════════════════════
const uploadExcel = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
export const uploadExcelMiddleware = uploadExcel.single('arquivo');

const campo = (linha, ...nomes) => {
  for (const nome of nomes) {
    if (linha[nome] !== undefined && linha[nome] !== null && String(linha[nome]).trim() !== '') {
      return String(linha[nome]).trim();
    }
  }
  return '';
};

export const importarAlunosExcel = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const { turma_padrao_id: turmaPadraoId } = req.body;

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Envie um ficheiro Excel (.xlsx) ou CSV' });
    }

    let workbook;
    try {
      workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    } catch (erroLeitura) {
      return res.status(400).json({ success: false, message: 'Não foi possível ler o ficheiro. Confirme que é um .xlsx, .xls ou .csv válido.' });
    }

    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const linhas = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (linhas.length === 0) {
      return res.status(400).json({ success: false, message: 'A folha está vazia ou os cabeçalhos não foram reconhecidos na primeira linha.' });
    }
    if (linhas.length > 1000) {
      return res.status(400).json({ success: false, message: 'Máximo de 1000 alunos por importação. Divida o ficheiro em partes menores.' });
    }

    // Nomes de turma -> id (comparação sem maiúsculas/minúsculas e sem espaços a mais)
    const turmasEscola = await queryAsync(`SELECT id, nome FROM turmas WHERE school_id = ?`, [schoolId]);
    const turmaPorNome = new Map(turmasEscola.map((t) => [String(t.nome).trim().toLowerCase(), t.id]));

    let criados = 0;
    const erros = [];

    for (let i = 0; i < linhas.length; i++) {
      const linhaNum = i + 2; // +1 pelo cabeçalho, +1 porque a contagem começa em 0
      const linha = linhas[i];
      const nome = campo(linha, 'Nome', 'nome');

      if (!nome) {
        erros.push({ linha: linhaNum, motivo: 'Nome em falta' });
        continue;
      }

      let turmaId = null;
      const nomeTurma = campo(linha, 'Turma', 'turma');
      if (nomeTurma) {
        turmaId = turmaPorNome.get(nomeTurma.toLowerCase()) || null;
        if (!turmaId) {
          erros.push({ linha: linhaNum, motivo: `Turma "${nomeTurma}" não encontrada` });
          continue;
        }
      } else if (turmaPadraoId) {
        turmaId = turmaPadraoId;
      } else {
        erros.push({ linha: linhaNum, motivo: 'Sem turma na linha e sem turma padrão selecionada' });
        continue;
      }

      const email = campo(linha, 'Email', 'email') || null;
      const telefone = campo(linha, 'Telefone', 'telefone') || null;
      const genero = campo(linha, 'Genero', 'Gênero', 'genero') || null;
      const documento = campo(linha, 'Documento', 'documento') || null;
      const morada = campo(linha, 'Morada', 'morada') || null;

      let dataNascimento = linha['Data Nascimento'] ?? linha['Data de Nascimento'] ?? linha.data_nascimento ?? null;
      if (dataNascimento instanceof Date) {
        dataNascimento = dataNascimento.toISOString().split('T')[0];
      } else if (typeof dataNascimento === 'string' && dataNascimento.trim()) {
        dataNascimento = dataNascimento.trim();
      } else {
        dataNascimento = null;
      }

      try {
        const insertResult = await queryAsync(
          `
            INSERT INTO students (school_id, turma_id, nome, email, telefone, data_nascimento, genero, documento, morada, status, ativo, data_inscricao, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ativo', 1, NOW(), NOW(), NOW())
          `,
          [schoolId, turmaId, nome, email, telefone, dataNascimento, genero, documento, morada]
        );
        const studentId = insertResult.insertId;
        const codigoAluno = gerarCodigoAluno(studentId, schoolId);
        await queryAsync(`UPDATE students SET codigo_aluno = ? WHERE id = ? AND school_id = ?`, [codigoAluno, studentId, schoolId]);
        criados += 1;
      } catch (erroLinha) {
        erros.push({ linha: linhaNum, motivo: erroLinha.message });
      }
    }

    if (criados > 0) {
      await criarNotificacao(schoolId, 'novo_aluno', 'Alunos importados', `${criados} aluno(s) importado(s) via Excel.`);
    }

    res.json({ success: true, criados, erros, total_linhas: linhas.length });
  } catch (err) {
    console.error('[v0] Erro ao importar alunos via Excel:', err);
    res.status(500).json({ success: false, message: 'Erro ao importar alunos', error: err.message });
  }
};



// ── "DIAS PARA A PRÓXIMA MENSALIDADE" (usado na aba Alunos) ────────────────
// Regra fixa do sistema: a mensalidade vence SEMPRE no último dia de cada mês
// (ver gerarCobrancasDoMesParaEscola em mensalidades.controller.js). Esta
// função estima a próxima data de vencimento a partir de "hoje", para quando
// ainda não existe nenhuma cobrança pendente/atrasada lançada (ex.: a
// mensalidade do mês corrente já foi paga).
const calcularProximaDataMensalidade = (hoje = new Date()) => {
  const anoAtual = hoje.getFullYear();
  const mesAtual = hoje.getMonth(); // 0-indexed
  const hojeSemHora = new Date(anoAtual, mesAtual, hoje.getDate());

  const ultimoDiaEsteMes = new Date(anoAtual, mesAtual + 1, 0).getDate();
  let candidato = new Date(anoAtual, mesAtual, ultimoDiaEsteMes);

  // Se o fim deste mês já passou (não deveria acontecer, já que a cobrança do
  // mês é gerada diariamente — mas fica como salvaguarda), aponta para o fim
  // do mês seguinte.
  if (candidato < hojeSemHora) {
    const mesSeguinte = mesAtual + 1;
    const anoSeguinte = anoAtual + Math.floor(mesSeguinte / 12);
    const mesSeguinteNormalizado = mesSeguinte % 12;
    const ultimoDiaMesSeguinte = new Date(anoSeguinte, mesSeguinteNormalizado + 1, 0).getDate();
    candidato = new Date(anoSeguinte, mesSeguinteNormalizado, ultimoDiaMesSeguinte);
  }

  return { data: candidato, dias: Math.round((candidato - hojeSemHora) / 86400000) };
};

/**
 * Anota cada aluno da lista com { proxima_mensalidade_data, proxima_mensalidade_dias,
 * proxima_mensalidade_status }, usando a cobrança pendente/atrasada mais próxima
 * quando existir (fonte real: student_payments, já lançada pela rotina mensal) ou,
 * na sua ausência (mensalidade deste mês já paga), estimando o fim do mês corrente
 * — que é sempre a data de vencimento, por regra fixa do sistema.
 */
const anotarDiasParaProximaMensalidade = async (schoolId, alunos) => {
  const mensalidadesAtivas = await queryAsync(
    `SELECT turma_id, classe_nome FROM mensalidades WHERE school_id = ? AND ativa = TRUE AND tipo = 'Mensalidade'`,
    [schoolId]
  );
  const turmasComMensalidade = new Set();
  const classesComMensalidade = new Set();
  mensalidadesAtivas.forEach((m) => {
    if (m.turma_id) turmasComMensalidade.add(m.turma_id);
    else if (m.classe_nome) classesComMensalidade.add(m.classe_nome);
  });

  const hoje = new Date();

  return alunos.map((aluno) => {
    if (aluno.proxima_mensalidade_vencimento) {
      const dataVenc = new Date(String(aluno.proxima_mensalidade_vencimento).split('T')[0] + 'T00:00:00');
      const hojeSemHora = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
      const dias = Math.round((dataVenc - hojeSemHora) / 86400000);
      return {
        ...aluno,
        proxima_mensalidade_data: String(aluno.proxima_mensalidade_vencimento).split('T')[0],
        proxima_mensalidade_dias: dias,
        proxima_mensalidade_status: dias < 0 ? 'atrasado' : dias === 0 ? 'vence_hoje' : 'a_vencer',
      };
    }

    const temMensalidade = (aluno.turma_id && turmasComMensalidade.has(aluno.turma_id)) || classesComMensalidade.has(aluno.classe_nome);
    if (!temMensalidade || !aluno.turma_id) {
      return { ...aluno, proxima_mensalidade_data: null, proxima_mensalidade_dias: null, proxima_mensalidade_status: 'sem_mensalidade' };
    }

    const { data, dias } = calcularProximaDataMensalidade(hoje);
    return {
      ...aluno,
      proxima_mensalidade_data: data.toISOString().split('T')[0],
      proxima_mensalidade_dias: dias,
      proxima_mensalidade_status: 'em_dia', // mensalidade do mês corrente já paga
    };
  });
};

const getClassIdForSchool = async (schoolId, classNumber) => {

  const className = `${classNumber}ª Classe`;

  const result = await queryAsync(

    `SELECT id FROM classes WHERE school_id = ? AND nome = ? LIMIT 1`,

    [schoolId, className]

  );



  if (result.length > 0) {

    return result[0].id;

  }



  const insertResult = await queryAsync(

    `INSERT INTO classes (school_id, nome, descricao, ativa, created_at, updated_at) VALUES (?, ?, ?, TRUE, NOW(), NOW())`,

    [schoolId, className, `Série automática para ${className}`]

  );



  return insertResult.insertId;

};



// v100 — extraído de getOrCreateTurmaForClass para poder ser reutilizado a
// partir de um classe_id já conhecido (ex.: migração em massa de secção),
// sem ter de voltar a resolver o classe_id a partir do número da classe.
// `numeroClasseParaNome` é só cosmético (nome da turma automática, ex.
// "11º A"); quando omitido, é lido da própria classe.
const getOrCreateTurmaForClasseId = async (schoolId, classeId, secaoId = 0, numeroClasseParaNome = null) => {

  const secaoIdNormalizado = secaoId || 0;

  const availableTurmas = await queryAsync(

    `

      SELECT t.id, COALESCE(COUNT(s.id), 0) as aluno_count

      FROM turmas t

      LEFT JOIN students s ON s.turma_id = t.id AND s.school_id = ? AND s.ativo = 1

      WHERE t.school_id = ? AND t.class_id = ? AND t.secao_id = ?

      GROUP BY t.id, t.nome, t.capacidade_maxima

      HAVING aluno_count < t.capacidade_maxima

      ORDER BY t.nome ASC

      LIMIT 1

    `,

    [schoolId, schoolId, classeId, secaoIdNormalizado]

  );



  if (availableTurmas.length > 0) {

    return availableTurmas[0].id;

  }



  const classTurmaCount = await queryAsync(

    `SELECT COUNT(*) as count FROM turmas WHERE school_id = ? AND class_id = ?`,

    [schoolId, classeId]

  );

  const existingCount = classTurmaCount[0]?.count || 0;

  const suffix = String.fromCharCode(65 + (existingCount % 26));

  let numeroClasse = numeroClasseParaNome;

  if (numeroClasse === null || numeroClasse === undefined) {

    const classeRows = await queryAsync(`SELECT nome FROM classes WHERE id = ? AND school_id = ?`, [classeId, schoolId]);

    numeroClasse = parseInt(String(classeRows[0]?.nome || '').replace(/\D/g, ''), 10) || '';

  }

  const nomeTurma = `${numeroClasse}º ${suffix}`;



  const createResult = await queryAsync(

    `INSERT INTO turmas (school_id, class_id, secao_id, nome, descricao, capacidade_maxima, ativa, created_at, updated_at)

      VALUES (?, ?, ?, ?, ?, 30, TRUE, NOW(), NOW())`,

    [schoolId, classeId, secaoIdNormalizado, nomeTurma, `Turma automática ${nomeTurma} da ${numeroClasse}ª Classe`]

  );



  return createResult.insertId;

};



export const getOrCreateTurmaForClass = async (schoolId, classNumber, secaoId = 0) => {

  const classId = await getClassIdForSchool(schoolId, classNumber);

  return getOrCreateTurmaForClasseId(schoolId, classId, secaoId, classNumber);

};

/**

 * ═══════════════════════════════════════════════════════════════

 * CONTROLLER DE ALUNOS - GERENCIAR STUDENTS

 * ═══════════════════════════════════════════════════════════════

 */



/**

 * GET: Listar todos os alunos da escola

 */

export const getAllStudents = async (req, res) => {

  try {

    const { schoolId } = req.params;

    const { status, turmaId, genero, search, page = 1, limit = 10, arquivados, sortBy, sortDir, ids } = req.query;

    // v97 — filtro opcional por lista de ids (usado pela Central de Alertas
    // do Dashboard: "N aluno(s) com documentação incompleta" etc. leva o
    // admin diretamente a ESTES alunos, não à lista inteira).
    const idsFiltro = ids
      ? String(ids).split(',').map((x) => parseInt(x, 10)).filter((x) => !Number.isNaN(x))
      : [];

    const mostrarArquivados = arquivados === 'true' || arquivados === '1';

    // Garante que `turnos` existe antes do JOIN abaixo — sem isto, uma escola
    // que nunca abriu a área de Horários (onde a tabela é criada) receberia
    // erro 500 ao listar alunos, em vez de simplesmente turno_nome = null.
    try {
      await ensureTabelasHorario();
    } catch (e) {
      console.error('[v0] Aviso: não foi possível garantir a tabela turnos antes de listar alunos:', e.message);
    }

    // Colunas permitidas para ordenação (evita SQL injection via sortBy)
    const colunasOrdenacao = {
      nome: 's.nome',
      codigo_aluno: 's.codigo_aluno',
      turma_nome: 'turma_nome',
      status: 's.status',
      data_inscricao: 's.data_inscricao',
      data_nascimento: 's.data_nascimento',
      total_atrasado: 'total_atrasado',
    };
    const colunaOrdenacao = colunasOrdenacao[sortBy] || 's.nome';
    const direcaoOrdenacao = String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';

    let query = `

      SELECT 

        s.id,

        s.nome,

        s.email,

        s.telefone,

        s.data_nascimento,

        s.genero,

        s.codigo_aluno,

        s.morada,

        s.documento,

        s.status,

        s.data_inscricao,

        s.ativo,

        s.turma_id,

        t.nome as turma_nome,

        c.nome as classe_nome,

        sec.nome as secao_nome,

        tn.nome as turno_nome,

        s.school_id,

        s.created_at,

        s.updated_at,

        COALESCE(fin.total_atrasado, 0) as total_atrasado,

        COALESCE(fin.total_pendente, 0) as total_pendente,

        fin.proxima_mensalidade_vencimento

      FROM students s

      LEFT JOIN turmas t ON s.turma_id = t.id

      LEFT JOIN classes c ON c.id = t.class_id

      -- v143 — a secção mostrada na listagem passa a vir de students.secao_id
      -- (a fonte única, válida em modo turma-por-secção OU turma-mista — ver
      -- secaoController.sincronizarSecaoDoAluno), em vez de turmas.secao_id.
      -- Em modo turma-mista, turmas.secao_id é sempre 0 (a turma é partilhada
      -- por várias secções), por isso o JOIN antigo mostrava sempre "sem
      -- secção" para estes alunos mesmo já tendo uma escolhida.
      LEFT JOIN secoes sec ON sec.id = s.secao_id

      LEFT JOIN turnos tn ON tn.id = t.turno_id

      LEFT JOIN (

        SELECT

          sp.student_id,

          SUM(CASE WHEN sp.status = 'atrasado' OR (sp.status = 'pendente' AND sp.data_vencimento < CURDATE()) THEN sp.valor_original + COALESCE(sp.multa, 0) ELSE 0 END) as total_atrasado,

          SUM(CASE WHEN sp.status = 'pendente' AND sp.data_vencimento >= CURDATE() THEN sp.valor_original + COALESCE(sp.multa, 0) ELSE 0 END) as total_pendente,

          MIN(CASE WHEN sp.status IN ('pendente', 'atrasado') AND m.tipo = 'Mensalidade' THEN sp.data_vencimento END) as proxima_mensalidade_vencimento

        FROM student_payments sp

        LEFT JOIN mensalidades m ON m.id = sp.mensalidade_id

        WHERE sp.school_id = ?

        GROUP BY sp.student_id

      ) fin ON fin.student_id = s.id

      WHERE s.school_id = ? AND s.ativo = ?

    `;



    const params = [schoolId, schoolId, mostrarArquivados ? 0 : 1];



    // Filtros opcionais

    if (status) {

      query += ` AND s.status = ?`;

      params.push(status);

    }



    if (turmaId) {

      query += ` AND s.turma_id = ?`;

      params.push(turmaId);

    }



    if (genero) {

      query += ` AND s.genero = ?`;

      params.push(genero);

    }



    if (search) {

      query += ` AND (s.nome LIKE ? OR s.codigo_aluno LIKE ? OR s.email LIKE ? OR s.telefone LIKE ?)`;

      const termo = `%${search}%`;

      params.push(termo, termo, termo, termo);

    }

    if (idsFiltro.length > 0) {
      query += ` AND s.id IN (${idsFiltro.map(() => '?').join(',')})`;
      params.push(...idsFiltro);
    }



    // Paginação

    const offset = (parseInt(page) - 1) * parseInt(limit);

    query += ` ORDER BY ${colunaOrdenacao} ${direcaoOrdenacao} LIMIT ? OFFSET ?`;

    params.push(parseInt(limit), offset);



    db.query(query, params, async (err, results) => {

      if (err) {

        console.error('[v0] Erro ao listar alunos:', err);

        return res.status(500).json({ 

          success: false, 

          message: 'Erro ao listar alunos',

          error: err.message 

        });

      }



      let alunosAnotados = results;
      try {
        alunosAnotados = await anotarDiasParaProximaMensalidade(schoolId, results);
      } catch (erroAnotacao) {
        console.error('[v0] Aviso: não foi possível calcular dias para a próxima mensalidade:', erroAnotacao.message);
      }

      // ── FREQUÊNCIA + MÉDIA por aluno (colunas "Freq." e "Média" da lista) ──
      // Reaproveita exatamente as mesmas funções usadas no Perfil 360°, para a
      // lista nunca mostrar um número diferente do que aparece no perfil do
      // aluno. Como a lista já vem paginada (10-50 linhas), calcular isto por
      // aluno aqui é barato e evita duplicar a lógica de cálculo em SQL puro.
      try {
        const configAvaliacao = await getConfigAvaliacao(schoolId);
        alunosAnotados = await Promise.all(
          alunosAnotados.map(async (aluno) => {
            let frequencia = null;
            let media = null;
            try {
              const { stats } = await calcularFrequenciaAluno(schoolId, aluno.id);
              frequencia = stats.percentualFrequencia;
            } catch (e) { /* tabela presencas pode ainda não ter registos para este aluno */ }
            try {
              media = await calcularMediaGeralAluno(schoolId, aluno.id, configAvaliacao);
            } catch (e) { /* aluno pode ainda não ter notas lançadas */ }
            return { ...aluno, frequencia, media };
          })
        );
      } catch (erroFrequenciaMedia) {
        console.error('[v0] Aviso: não foi possível calcular frequência/média da lista de alunos:', erroFrequenciaMedia.message);
      }



      // Contar total de registros para paginação (usando os MESMOS filtros)

      let countQuery = `SELECT COUNT(*) as total FROM students s WHERE s.school_id = ? AND s.ativo = ?`;

      const countParams = [schoolId, mostrarArquivados ? 0 : 1];



      if (status) {

        countQuery += ` AND s.status = ?`;

        countParams.push(status);

      }



      if (turmaId) {

        countQuery += ` AND s.turma_id = ?`;

        countParams.push(turmaId);

      }



      if (genero) {

        countQuery += ` AND s.genero = ?`;

        countParams.push(genero);

      }



      if (search) {

        countQuery += ` AND (s.nome LIKE ? OR s.codigo_aluno LIKE ? OR s.email LIKE ? OR s.telefone LIKE ?)`;

        const termo = `%${search}%`;

        countParams.push(termo, termo, termo, termo);

      }

      if (idsFiltro.length > 0) {
        countQuery += ` AND s.id IN (${idsFiltro.map(() => '?').join(',')})`;
        countParams.push(...idsFiltro);
      }



      db.query(countQuery, countParams, (err, countResults) => {

        if (err) {

          return res.status(500).json({ 

            success: false, 

            message: 'Erro ao contar alunos' 

          });

        }



        res.json({

          success: true,

          data: alunosAnotados,

          pagination: {

            total: countResults[0].total,

            page: parseInt(page),

            limit: parseInt(limit),

            pages: Math.max(1, Math.ceil(countResults[0].total / parseInt(limit)))

          }

        });

      });

    });

  } catch (error) {

    console.error('[v0] Erro no getAllStudents:', error);

    res.status(500).json({ 

      success: false, 

      message: 'Erro interno do servidor',

      error: error.message 

    });

  }

};



/**

 * PUT: Restaurar aluno arquivado (reverte o soft delete)

 */

export const restoreStudent = (req, res) => {

  try {

    const { schoolId, studentId } = req.params;



    const checkQuery = `SELECT id FROM students WHERE id = ? AND school_id = ? AND ativo = 0`;



    db.query(checkQuery, [studentId, schoolId], (err, results) => {

      if (err) {

        console.error('[v0] Erro ao verificar aluno arquivado:', err);

        return res.status(500).json({ success: false, message: 'Erro ao verificar aluno', error: err.message });

      }



      if (results.length === 0) {

        return res.status(404).json({ success: false, message: 'Aluno arquivado não encontrado' });

      }



      const restoreQuery = `UPDATE students SET ativo = 1, status = 'ativo', updated_at = NOW() WHERE id = ? AND school_id = ?`;



      db.query(restoreQuery, [studentId, schoolId], (err) => {

        if (err) {

          console.error('[v0] Erro ao restaurar aluno:', err);

          return res.status(500).json({ success: false, message: 'Erro ao restaurar aluno', error: err.message });

        }



        res.json({ success: true, message: 'Aluno restaurado com sucesso' });

      });

    });

  } catch (error) {

    console.error('[v0] Erro no restoreStudent:', error);

    res.status(500).json({ success: false, message: 'Erro interno do servidor', error: error.message });

  }

};



/**

 * GET: Estatísticas de alunos (para os cards no topo da aba Alunos)

 */

export const getStudentStats = (req, res) => {

  const { schoolId } = req.params;



  const query = `

    SELECT

      COUNT(*) as total,

      SUM(CASE WHEN status = 'ativo' THEN 1 ELSE 0 END) as ativos,

      SUM(CASE WHEN status = 'inativo' THEN 1 ELSE 0 END) as inativos,

      SUM(CASE WHEN status = 'evadido' THEN 1 ELSE 0 END) as evadidos,

      SUM(CASE WHEN status = 'suspenso' THEN 1 ELSE 0 END) as suspensos,

      SUM(CASE WHEN genero = 'Masculino' THEN 1 ELSE 0 END) as masculinos,

      SUM(CASE WHEN genero = 'Feminino' THEN 1 ELSE 0 END) as femininos

    FROM students

    WHERE school_id = ? AND ativo = 1

  `;



  db.query(query, [schoolId], (err, results) => {

    if (err) {

      console.error('[v0] Erro ao calcular estatísticas de alunos:', err);

      if (err.code === 'ER_NO_SUCH_TABLE') {

        return res.json({ success: true, data: { total: 0, ativos: 0, inativos: 0, evadidos: 0, suspensos: 0, masculinos: 0, femininos: 0, arquivados: 0, emAtraso: 0 } });

      }

      return res.status(500).json({ success: false, message: 'Erro ao calcular estatísticas', error: err.message });

    }



    const row = results[0] || {};



    // Total de alunos arquivados (ativo = 0)

    const arquivadosQuery = `SELECT COUNT(*) as arquivados FROM students WHERE school_id = ? AND ativo = 0`;



    db.query(arquivadosQuery, [schoolId], (errArq, resultsArq) => {

      const arquivados = errArq ? 0 : (resultsArq[0]?.arquivados || 0);



      // Quantidade de alunos ativos com mensalidades vencidas e não pagas

      const emAtrasoQuery = `

        SELECT COUNT(DISTINCT sp.student_id) as emAtraso

        FROM student_payments sp

        INNER JOIN students s ON s.id = sp.student_id

        WHERE sp.school_id = ? AND s.ativo = 1 AND sp.status = 'pendente' AND sp.data_vencimento < CURDATE()

      `;



      db.query(emAtrasoQuery, [schoolId], (errAtr, resultsAtr) => {

        const emAtraso = errAtr ? 0 : (resultsAtr[0]?.emAtraso || 0);



        res.json({

          success: true,

          data: {

            total: row.total || 0,

            ativos: row.ativos || 0,

            inativos: row.inativos || 0,

            evadidos: row.evadidos || 0,

            suspensos: row.suspensos || 0,

            masculinos: row.masculinos || 0,

            femininos: row.femininos || 0,

            arquivados,

            emAtraso,

          },

        });

      });

    });

  });

};



/**

 * GET: Buscar aluno por ID

 */

export const getStudentById = (req, res) => {

  try {

    const { schoolId, studentId } = req.params;



    const query = `

      SELECT s.id, s.school_id, s.turma_id, s.nome, s.email, s.telefone, s.data_nascimento, s.genero, s.codigo_aluno, s.morada, s.documento, s.status, s.data_inscricao, s.ativo, s.created_at, s.updated_at,
        t.nome as turma_nome, c.nome as classe_nome, sec.nome as secao_nome
      FROM students s
      LEFT JOIN turmas t ON t.id = s.turma_id
      LEFT JOIN classes c ON c.id = t.class_id
      -- v143 — secção via students.secao_id (ver nota equivalente em getAllStudents)
      LEFT JOIN secoes sec ON sec.id = s.secao_id

      WHERE s.id = ? AND s.school_id = ?

    `;



    db.query(query, [studentId, schoolId], (err, results) => {

      if (err) {

        console.error('[v0] Erro ao buscar aluno:', err);

        return res.status(500).json({ 

          success: false, 

          message: 'Erro ao buscar aluno',

          error: err.message 

        });

      }



      if (results.length === 0) {

        return res.status(404).json({ 

          success: false, 

          message: 'Aluno não encontrado' 

        });

      }



      res.json({

        success: true,

        data: results[0]

      });

    });

  } catch (error) {

    console.error('[v0] Erro no getStudentById:', error);

    res.status(500).json({ 

      success: false, 

      message: 'Erro interno do servidor',

      error: error.message 

    });

  }

};



/**

 * GET: Buscar alunos por classe

 */

export const getStudentsByClass = (req, res) => {

  try {

    const { schoolId, classeId } = req.params;



    const query = `

      SELECT s.id, s.school_id, s.turma_id, s.nome, s.email, s.telefone, s.data_nascimento, s.genero, s.codigo_aluno, s.morada, s.documento, s.status, s.data_inscricao, s.ativo, s.created_at, s.updated_at,
        t.nome as turma_nome, c.nome as classe_nome
      FROM students s
      LEFT JOIN turmas t ON t.id = s.turma_id
      LEFT JOIN classes c ON c.id = t.class_id

      WHERE s.school_id = ? AND s.turma_id = ? AND s.ativo = 1

      ORDER BY s.nome ASC

    `;



    db.query(query, [schoolId, classeId], (err, results) => {

      if (err) {

        console.error('[v0] Erro ao buscar alunos por classe:', err);

        return res.status(500).json({ 

          success: false, 

          message: 'Erro ao buscar alunos por classe',

          error: err.message 

        });

      }



      res.json({

        success: true,

        data: results,

        count: results.length

      });

    });

  } catch (error) {

    console.error('[v0] Erro no getStudentsByClass:', error);

    res.status(500).json({ 

      success: false, 

      message: 'Erro interno do servidor',

      error: error.message 

    });

  }

};



/**

 * GET: Pesquisar alunos por nome, email, telefone ou código

 */

export const searchStudents = (req, res) => {

  try {

    const { schoolId, query: searchQuery } = req.params;



    const query = `

      SELECT s.id, s.school_id, s.turma_id, s.nome, s.email, s.telefone, s.data_nascimento, s.genero, s.codigo_aluno, s.morada, s.documento, s.status, s.data_inscricao, s.ativo, s.created_at, s.updated_at,
        t.nome as turma_nome, c.nome as classe_nome
      FROM students s
      LEFT JOIN turmas t ON t.id = s.turma_id
      LEFT JOIN classes c ON c.id = t.class_id

      WHERE s.school_id = ? AND s.ativo = 1 AND (
        s.nome LIKE ? OR

        s.email LIKE ? OR

        s.telefone LIKE ? OR

        s.codigo_aluno LIKE ?

      )

      ORDER BY s.nome ASC

      LIMIT 50

    `;



    const searchTerm = `%${searchQuery}%`;

    const params = [schoolId, searchTerm, searchTerm, searchTerm, searchTerm];



    db.query(query, params, (err, results) => {

      if (err) {

        console.error('[v0] Erro ao pesquisar alunos:', err);

        return res.status(500).json({ 

          success: false, 

          message: 'Erro ao pesquisar alunos',

          error: err.message 

        });

      }



      res.json({

        success: true,

        data: results,

        count: results.length

      });

    });

  } catch (error) {

    console.error('[v0] Erro no searchStudents:', error);

    res.status(500).json({ 

      success: false, 

      message: 'Erro interno do servidor',

      error: error.message 

    });

  }

};



/**

 * POST: Criar novo aluno

 */

export const createStudent = async (req, res) => {

  try {

    const { schoolId } = req.params;

    const {

      nomeCompleto,

      email,

      telefone,

      data_nascimento,

      genero,

      turma_id,

      classe,

      morada,

      documento,

      codigo_aluno,

      password,

      status = 'ativo',

      encarregados = [],

      // v77 — permite ao admin marcar o aluno como isento da taxa de
      // inscrição no próprio ato de matrícula (ex.: bolsa, protocolo com a
      // família), sem precisar de estornar a cobrança depois.
      gerarTaxaInscricao = true,

      // v99 — secção escolhida no ato da inscrição (ex.: 11ª Ciências vs.
      // 11ª Letras), quando a classe já tem secções configuradas. Só é
      // usada quando `turma_id` não é passado diretamente (ou seja, quando
      // a turma vai ser auto-atribuída/criada a partir de `classe`).
      secaoId = null

    } = req.body;



    const nome = nomeCompleto || req.body.nome || '';

    const hashedPassword = password ? await bcrypt.hash(password, 10) : null;



    if (!nome) {

      return res.status(400).json({

        success: false,

        message: 'Nome do aluno é obrigatório'

      });

    }



    if (!turma_id && !classe) {

      return res.status(400).json({

        success: false,

        message: 'Classe ou turma é obrigatória para cadastrar o aluno'

      });

    }



    if (password && password.length < 6) {

      return res.status(400).json({

        success: false,

        message: 'Senha deve ter no mínimo 6 caracteres'

      });

    }



    let assignedTurmaId = turma_id || null;



    if (!assignedTurmaId && classe) {

      const classNumber = parseInt(classe, 10);

      if (isNaN(classNumber)) {

        return res.status(400).json({

          success: false,

          message: 'Classe deve ser um número válido'

        });

      }

      // v99 — se a classe já tem secções configuradas (ex.: Ciências vs.
      // Letras) e a escola exige a escolha nesta classe (ver
      // secaoController.secaoEhObrigatoriaParaClasse), a inscrição só
      // avança com uma secção explícita — devolve a lista para o
      // formulário mostrar o seletor, tal como já acontece na renovação.
      const classIdParaSecoes = await getClassIdForSchool(schoolId, classNumber);
      await ensureSecoesTableExists();
      await ensureTurmaSecaoColumnExists();
      const secoesDaClasseDestino = await queryAsync(
        `SELECT id, nome FROM secoes WHERE school_id = ? AND classe_id = ? AND ativa = TRUE ORDER BY nome ASC`,
        [schoolId, classIdParaSecoes]
      );
      if (secoesDaClasseDestino.length > 0 && !secaoId) {
        const obrigatorio = await secaoEhObrigatoriaParaClasse(schoolId, classNumber);
        if (obrigatorio) {
          return res.status(400).json({
            success: false,
            precisa_escolher_secao: true,
            message: `A ${classNumber}ª Classe tem secções configuradas (${secoesDaClasseDestino.map((s) => s.nome).join(', ')}) — escolha em qual o aluno vai ficar antes de concluir a inscrição.`,
            secoes_disponiveis: secoesDaClasseDestino,
          });
        }
      }

      // v100 — TURMA MISTA: quando a escola liga este modo (Configurações →
      // Secções), a turma física deixa de ser dividida por secção — todos
      // os alunos da classe partilham a mesma turma, e é `students.secao_id`
      // (gravado a seguir, ver sincronizarSecaoDoAluno) que passa a
      // identificar a secção real de cada aluno. Sem o modo ligado, mantém-se
      // o comportamento histórico: uma turma por secção.
      const { turma_unica_mista: turmaMista } = await getSecaoSettings(schoolId);
      assignedTurmaId = await getOrCreateTurmaForClass(schoolId, classNumber, turmaMista ? 0 : (secaoId || 0));

    }



    const columns = [

      'school_id',

      'turma_id',

      'nome',

      'email'

    ];

    const values = [

      schoolId,

      assignedTurmaId,

      nome,

      email || null

    ];



    if (hashedPassword) {

      await ensureStudentPasswordColumnExists();

      columns.push('password');

      values.push(hashedPassword);

    }



    columns.push(

      'telefone',

      'data_nascimento',

      'genero',

      'codigo_aluno',

      'morada',

      'documento',

      'status',

      'ativo'

    );

    values.push(

      telefone || null,

      data_nascimento || null,

      genero || null,

      null,

      morada || null,

      documento || null,

      status,

      1

    );



    const insertQuery = `

      INSERT INTO students (${columns.join(', ')}, data_inscricao, created_at, updated_at)

      VALUES (${values.map(() => '?').join(', ')}, NOW(), NOW(), NOW())

    `;



    const result = await queryAsync(insertQuery, values);

    const studentId = result.insertId;

    // v100 — grava a secção efetiva do aluno em `students.secao_id`,
    // independentemente do modo turma-por-secção ou turma-mista (ver
    // secaoController.sincronizarSecaoDoAluno). Sem custo para escolas que
    // não usam secções: fica sempre 0.
    let secaoEfetivaInscricao = 0;
    if (assignedTurmaId) {
      secaoEfetivaInscricao = await sincronizarSecaoDoAluno(schoolId, studentId, assignedTurmaId, secaoId || null);
    }

    // v82 — código do aluno SEMPRE gerado pelo sistema, nunca aceite do
    // cliente. Passou a ser também a credencial de login da Área do Aluno,
    // por isso a mesma garantia de unicidade do professor (gerarCodigoProfessorUnico)
    // se aplica aqui: verificado na base de dados, nunca repetido.
    const codigoAluno = await gerarCodigoAlunoUnico(studentId, schoolId);

    await queryAsync(

      `UPDATE students SET codigo_aluno = ? WHERE id = ? AND school_id = ?`,

      [codigoAluno, studentId, schoolId]

    );



    if (Array.isArray(encarregados) && encarregados.length > 0) {

      // Mesma paridade de campos/papéis usada em saveStudentGuardians (edição
      // posterior do aluno): parentesco, profissão, e os papéis do encarregado
      // (principal, responsável financeiro/académico, autoriza saída, contacto
      // de emergência). Antes, o cadastro inicial só gravava nome+telefone,
      // obrigando o admin a voltar depois à aba "Encarregados" para completar.
      await ensureGuardiansColumnsExist();

      const validos = encarregados.filter((e) => e && e.nome && e.telefone);
      let indicePrincipal = validos.findIndex((e) => !!e.principal);
      if (indicePrincipal === -1 && validos.length > 0) indicePrincipal = 0;

      for (let i = 0; i < validos.length; i++) {

        const encarregado = validos[i];

        await queryAsync(

          `INSERT INTO guardians
             (student_id, nome, telefone, parentesco, profissao, email, telefone_secundario, morada,
              principal, responsavel_financeiro, responsavel_academico, autoriza_saida, contacto_emergencia,
              created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,

          [
            studentId,
            encarregado.nome,
            encarregado.telefone,
            encarregado.parentesco || null,
            encarregado.profissao || null,
            encarregado.email || null,
            encarregado.telefone_secundario || null,
            encarregado.morada || null,
            i === indicePrincipal ? 1 : 0,
            encarregado.responsavel_financeiro ? 1 : 0,
            encarregado.responsavel_academico ? 1 : 0,
            encarregado.autoriza_saida === false ? 0 : 1,
            encarregado.contacto_emergencia ? 1 : 0,
          ]

        );

      }

    }



    // ── TAXA DE INSCRIÇÃO — v77 ──────────────────────────────────────────────
    // Cobrança de entrada, gerada UMA VEZ, distinta da mensalidade e da taxa
    // de renovação (essas duas só entram em jogo mais tarde). Só é gerada se
    // a classe atribuída tiver um valor configurado (Renovação → Configurar
    // → Taxa de Inscrição) e o admin não a tiver marcado como isenta.
    let cobrancaInscricao = null;
    if (gerarTaxaInscricao !== false && assignedTurmaId) {
      const turmaCriadaRows = await queryAsync(`SELECT class_id FROM turmas WHERE id = ? AND school_id = ?`, [assignedTurmaId, schoolId]);
      if (turmaCriadaRows.length > 0 && turmaCriadaRows[0].class_id) {
        cobrancaInscricao = await gerarCobrancaInscricao(schoolId, studentId, { classId: turmaCriadaRows[0].class_id });
      }
    }

    await criarNotificacao(schoolId, 'novo_aluno', 'Novo aluno matriculado', `${nome} foi matriculado(a) com o código ${codigoAluno}.${cobrancaInscricao ? ` Taxa de inscrição de ${cobrancaInscricao.valor_total} MZN gerada.` : ''}`);

    // v96 — gera o comprovativo de matrícula em PDF e envia automaticamente
    // por WhatsApp ao(s) encarregado(s) do aluno. Disparado SEM `await`
    // bloqueante: a resposta ao admin não espera pelo envio (que depende de
    // uma API externa), e qualquer falha fica só registada no log — nunca
    // impede a matrícula de ser concluída (ver notificacaoRelatorioService.js).
    notificarInscricaoAluno(schoolId, studentId);

    return res.status(201).json({

      success: true,

      message: `Aluno criado com sucesso${cobrancaInscricao ? ` — taxa de inscrição de ${cobrancaInscricao.valor_total} MZN gerada (vencimento ${cobrancaInscricao.data_vencimento})` : ''}`,

      data: {

        id: studentId,

        nome,

        email,

        turma_id: assignedTurmaId,

        // v143 — devolve a secção efetivamente gravada (0 = sem secção),
        // para o formulário poder confirmar ao admin em qual secção o
        // aluno ficou, tal como já mostra a turma atribuída.
        secao_id: secaoEfetivaInscricao || 0,

        cobrancaInscricao,

        codigo_aluno: codigoAluno

      }

    });

  } catch (error) {

    console.error('[v0] Erro no createStudent:', error);

    res.status(500).json({

      success: false,

      message: 'Erro interno do servidor',

      error: error.message

    });

  }

};



/**

 * PUT: Atualizar dados do aluno

 */

export const updateStudent = async (req, res) => {

  try {

    const { schoolId, studentId } = req.params;

    const {

      nome,

      email,

      telefone,

      data_nascimento,

      genero,

      codigo_aluno,

      morada,

      documento,

      turma_id,

      status,

      ativo,

      password

    } = req.body;



    // Verificar se aluno existe

    const checkQuery = `

      SELECT id FROM students 

      WHERE id = ? AND school_id = ?

    `;



    db.query(checkQuery, [studentId, schoolId], async (err, results) => {
      if (err) {

        console.error('[v0] Erro ao verificar aluno:', err);

        return res.status(500).json({ 

          success: false, 

          message: 'Erro ao verificar aluno',

          error: err.message 

        });

      }



      if (results.length === 0) {

        return res.status(404).json({ 

          success: false, 

          message: 'Aluno não encontrado' 

        });

      }



      // Verificar se novo código já existe (se foi alterado)

      if (codigo_aluno) {

        const checkCodeQuery = `

          SELECT id FROM students 

          WHERE codigo_aluno = ? AND school_id = ? AND id != ?

        `;



        db.query(checkCodeQuery, [codigo_aluno, schoolId, studentId], async (err, codeResults) => {

          if (err) {

            console.error('[v0] Erro ao verificar código:', err);

            return res.status(500).json({ 

              success: false, 

              message: 'Erro ao verificar código',

              error: err.message 

            });

          }



          if (codeResults.length > 0) {

            return res.status(400).json({ 

              success: false, 

              message: 'Código do aluno já existe' 

            });

          }



          await performUpdate();

        });

      } else {

        await performUpdate();

      }



      async function performUpdate() {

        let hashedPassword = null;



        if (password) {

          if (password.length < 6) {

            return res.status(400).json({

              success: false,

              message: 'Senha deve ter no mínimo 6 caracteres'

            });

          }

          await ensureStudentPasswordColumnExists();

          hashedPassword = await bcrypt.hash(password, 10);

        }



        const updateQuery = `

          UPDATE students 

          SET 

            ${nome ? 'nome = ?,' : ''}

            ${email ? 'email = ?,' : ''}

            ${telefone ? 'telefone = ?,' : ''}

            ${data_nascimento ? 'data_nascimento = ?,' : ''}

            ${genero ? 'genero = ?,' : ''}

            ${codigo_aluno ? 'codigo_aluno = ?,' : ''}

            ${morada ? 'morada = ?,' : ''}

            ${documento ? 'documento = ?,' : ''}

            ${turma_id ? 'turma_id = ?,' : ''}

            ${status !== undefined ? 'status = ?,' : ''}

            ${ativo !== undefined ? 'ativo = ?,' : ''}

            ${hashedPassword ? 'password = ?,' : ''}

            updated_at = NOW()

          WHERE id = ? AND school_id = ?

        `.replace(/,\s*WHERE/, ' WHERE');



        const params = [];

        if (nome) params.push(nome);

        if (email) params.push(email);

        if (telefone) params.push(telefone);

        if (data_nascimento) params.push(data_nascimento);

        if (genero) params.push(genero);

        if (codigo_aluno) params.push(codigo_aluno);

        if (morada) params.push(morada);

        if (documento) params.push(documento);

        if (turma_id) params.push(turma_id);

        if (status !== undefined) params.push(status);

        if (ativo !== undefined) params.push(ativo);

        if (hashedPassword) params.push(hashedPassword);

        params.push(studentId, schoolId);



        db.query(updateQuery, params, async (err) => {

          if (err) {

            console.error('[v0] Erro ao atualizar aluno:', err);

            return res.status(500).json({ 

              success: false, 

              message: 'Erro ao atualizar aluno',

              error: err.message 

            });

          }



          // v143 — quando a turma é alterada por aqui (edição manual do
          // aluno, fora do fluxo de renovação), `students.secao_id` também
          // precisa de ser atualizado — senão o aluno fica a "arrastar" a
          // secção da turma anterior, mesmo depois de mudar de turma/secção.
          // Sem escolha explícita de secção nesta tela, usa-se a secção da
          // PRÓPRIA turma de destino (comportamento correto tanto em turma-
          // por-secção como em turma-mista, onde a turma de destino não tem
          // secção própria e o aluno fica sem secção até uma atribuição
          // explícita — ver secaoController.atribuirSecaoEmMassa).
          if (turma_id) {
            try {
              await sincronizarSecaoDoAluno(schoolId, studentId, turma_id, null);
            } catch (erroSecao) {
              console.error('[v0] Aviso: não foi possível sincronizar a secção do aluno após mudança de turma:', erroSecao.message);
            }
          }



          res.json({

            success: true,

            message: 'Aluno atualizado com sucesso'

          });

        });

      }

    });

  } catch (error) {

    console.error('[v0] Erro no updateStudent:', error);

    res.status(500).json({ 

      success: false, 

      message: 'Erro interno do servidor',

      error: error.message 

    });

  }

};



/**

 * DELETE: Deletar aluno

 */

export const deleteStudent = (req, res) => {

  try {

    const { schoolId, studentId } = req.params;



    // Verificar se aluno existe

    const checkQuery = `

      SELECT id, nome, codigo_aluno, turma_id, status FROM students 

      WHERE id = ? AND school_id = ?

    `;



    db.query(checkQuery, [studentId, schoolId], (err, results) => {

      if (err) {

        console.error('[v0] Erro ao verificar aluno:', err);

        return res.status(500).json({ 

          success: false, 

          message: 'Erro ao verificar aluno',

          error: err.message 

        });

      }



      if (results.length === 0) {

        return res.status(404).json({ 

          success: false, 

          message: 'Aluno não encontrado' 

        });

      }



      // Soft delete: marcar como inativo

      const deleteQuery = `

        UPDATE students 

        SET ativo = 0, status = 'inativo', updated_at = NOW()

        WHERE id = ? AND school_id = ?

      `;



      db.query(deleteQuery, [studentId, schoolId], (err) => {

        if (err) {

          console.error('[v0] Erro ao deletar aluno:', err);

          return res.status(500).json({ 

            success: false, 

            message: 'Erro ao deletar aluno',

            error: err.message 

          });

        }



        registrarAuditoria(req, {
          acao: 'aluno_removido', entidadeTipo: 'student', entidadeId: studentId,
          dadosAntigos: results[0],
        });

        res.json({

          success: true,

          message: 'Aluno deletado com sucesso'

        });

      });

    });

  } catch (error) {

    console.error('[v0] Erro no deleteStudent:', error);

    res.status(500).json({ 

      success: false, 

      message: 'Erro interno do servidor',

      error: error.message 

    });

  }

};



/**

 * POST: Renovar matrícula do aluno

 */

export const ensureEnrollmentHistoryTableExists = memoize(async () => {
  await queryAsync(`
    CREATE TABLE IF NOT EXISTS enrollment_history (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL,
      student_id INT NOT NULL,
      turma_id_anterior INT NULL,
      turma_nome_anterior VARCHAR(100) NULL,
      turma_id_nova INT NULL,
      turma_nome_nova VARCHAR(100) NULL,
      situacao_academica VARCHAR(30) NULL,
      taxa_cobrada DECIMAL(10,2) NULL,
      origem VARCHAR(20) NOT NULL DEFAULT 'manual',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_school_student (school_id, student_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Colunas usadas para distinguir renovações intermédias (ex.: trimestrais, que
  // apenas mantêm o aluno matriculado) da renovação final do ano letivo (a única
  // que decide progressão/repetição de classe) — ver calcularRondaRenovacao.
  if (!(await columnExists('enrollment_history', 'ronda'))) {
    await queryAsync(`ALTER TABLE enrollment_history ADD COLUMN ronda INT NULL AFTER situacao_academica`);
  }
  if (!(await columnExists('enrollment_history', 'tipo_renovacao'))) {
    await queryAsync(`ALTER TABLE enrollment_history ADD COLUMN tipo_renovacao VARCHAR(20) NULL AFTER ronda`);
  }
  // Ano letivo (ver academicYearController.js) em que a renovação ocorreu —
  // resolvido a partir da data do registo, para permitir consultar o
  // histórico de matrícula de um aluno separado por ano letivo real.
  if (!(await columnExists('enrollment_history', 'academic_year_id'))) {
    await queryAsync(`ALTER TABLE enrollment_history ADD COLUMN academic_year_id INT NULL AFTER tipo_renovacao`);
  }
  // v77 — AUDITORIA DE DECISÕES MANUAIS/EXCEÇÕES.
  // `decisao_manual`: verdadeiro sempre que a turma final não veio da sugestão
  // automática (inclui os casos já "normais" de decisão manual — Sem notas,
  // Excluído, Vai a Exame pendente, sem vagas — e também exceções forçadas).
  // `motivo_excecao`: só preenchido quando o admin FORÇOU uma turma que
  // contraria a regra de progressão automática (ex.: aprovar por decisão de
  // conselho pedagógico um aluno que a regra marcaria como repetente) — nesse
  // caso a justificação é obrigatória, para o histórico do aluno ficar claro
  // sobre o porquê de ter fugido à regra padrão.
  if (!(await columnExists('enrollment_history', 'decisao_manual'))) {
    await queryAsync(`ALTER TABLE enrollment_history ADD COLUMN decisao_manual BOOLEAN NOT NULL DEFAULT FALSE AFTER academic_year_id`);
  }
  if (!(await columnExists('enrollment_history', 'motivo_excecao'))) {
    await queryAsync(`ALTER TABLE enrollment_history ADD COLUMN motivo_excecao TEXT NULL AFTER decisao_manual`);
  }
});

/**
 * Lógica central de renovação de matrícula, reutilizada pela renovação
 * individual (renewEnrollment) e pela renovação em massa (bulkRenewEnrollment).
 * Lança erro com .status quando a operação não pode ser concluída.
 *
 * Se `turmaIdNova` não for informado, tenta usar a sugestão automática de
 * progressão de classe (aprovado → próxima classe; reprovado/vai a exame →
 * mesma classe; excluído → exige escolha manual).
 */
const performRenewEnrollment = async (schoolId, studentId, turmaIdNova, novaDataInscricao, origem = 'manual', { gerarCobranca = true, forcarExcecao = false, motivoExcecao = null, secaoId = null } = {}) => {
  await ensureEnrollmentHistoryTableExists();

  // Verificar se aluno existe (e capturar a turma atual, para o histórico)
  const alunoRows = await queryAsync(
    `SELECT s.id, s.nome, s.turma_id, t.nome as turma_nome_atual FROM students s LEFT JOIN turmas t ON t.id = s.turma_id WHERE s.id = ? AND s.school_id = ?`,
    [studentId, schoolId]
  );
  if (alunoRows.length === 0) {
    const erro = new Error('Aluno não encontrado');
    erro.status = 404;
    throw erro;
  }
  const turmaIdAnterior = alunoRows[0].turma_id;
  const turmaNomeAnterior = alunoRows[0].turma_nome_atual;
  const alunoNome = alunoRows[0].nome;

  // ── JANELA DE RENOVAÇÃO (CORRIGIDO na v55) ───────────────────────────────
  // Antes desta versão, a janela configurada em Renovações → Período nunca era
  // realmente aplicada aqui — só influenciava se uma multa era cobrada. Agora,
  // se a janela ainda não abriu, a renovação é BLOQUEADA (tanto individual como
  // em massa passam por esta mesma função). Depois do fim da janela, continua
  // permitido renovar, mas com multa — ver services/financialStatusService.js.
  const janela = await verificarJanelaRenovacaoAberta(schoolId);
  if (janela.ainda_nao_abriu) {
    const erro = new Error(
      `A janela de renovação de matrículas ainda não abriu. Abre em ${janela.data_inicio}.`
    );
    erro.status = 400;
    throw erro;
  }

  // ── COOLDOWN DE RENOVAÇÃO ────────────────────────────────────────────────
  // Se o aluno já renovou a matrícula antes, só pode renovar de novo depois
  // do prazo estipulado pela periodicidade configurada (Trimestral = 3 meses,
  // Semestral = 6 meses, Anual = 12 meses). Alunos que nunca renovaram (esta
  // seria a primeira renovação) não são bloqueados por esta regra.
  const cooldown = await verificarCooldownRenovacao(schoolId, studentId);
  if (cooldown.bloqueado) {
    const erro = new Error(
      `${alunoNome} já renovou a matrícula em ${cooldown.ultima_renovacao}. De acordo com a periodicidade configurada (${cooldown.periodicidade}), só poderá renovar novamente a partir de ${cooldown.proxima_data_permitida}.`
    );
    erro.status = 400;
    throw erro;
  }

  // ── RONDA DE RENOVAÇÃO DO ANO LETIVO ─────────────────────────────────────
  // Não confunde renovações intermédias (ex.: trimestrais) com a renovação
  // anual: se o aluno já fez todas as renovações previstas para este ano
  // letivo pela periodicidade configurada, a próxima só é permitida no ano
  // letivo seguinte.
  const ronda = await calcularRondaRenovacao(schoolId, studentId);
  if (ronda.ja_completou_rondas_do_ano) {
    const erro = new Error(
      `${alunoNome} já completou as ${ronda.rondas_por_ano} renovação(ões) previstas para o ano letivo de ${ronda.ano_letivo} (periodicidade "${ronda.periodicidade}"). A próxima renovação só pode ser feita no ano letivo seguinte.`
    );
    erro.status = 400;
    throw erro;
  }

  let situacaoAcademica = null;

  // ── FÓRMULA DE PROGRESSÃO/REPETIÇÃO DE CLASSE (renovação anual) ─────────────
  // A renovação de matrícula decide a classe do aluno para o novo ano letivo,
  // com base no resultado académico acumulado dos 3 trimestres do ano corrente:
  //   • reprovou (ou ficou pendente de exame) em alguma disciplina → REPETE a
  //     mesma classe;
  //   • foi aprovado/dispensado em TODAS as disciplinas → PROGRIDE para a
  //     classe seguinte.
  // Esta regra é sempre validada — quer a turma de destino seja escolhida
  // automaticamente (turmaIdNova não informado) quer escolhida manualmente —
  // exceto quando a decisão tem mesmo de ser manual (aluno excluído por faltas
  // ou ainda sem notas lançadas no ano), casos em que qualquer turma é aceite.
  const sugestao = await sugerirProgressao(schoolId, studentId);
  situacaoAcademica = sugestao.situacao_academica;

  // v77 — rasto de auditoria: true sempre que a turma final não resulta
  // diretamente da sugestão automática (inclui os casos normais de decisão
  // manual — Sem notas, Excluído, sem vagas, Vai a Exame pendente — e também
  // exceções forçadas contra a regra de progressão).
  let decisaoManual = false;
  let motivoExcecaoFinal = null;

  if (!turmaIdNova) {
    if (!sugestao.turma_sugerida) {
      const erro = new Error(sugestao.motivo || 'Não foi possível sugerir uma turma automaticamente. Escolha manualmente.');
      erro.status = 400;
      throw erro;
    }
    turmaIdNova = sugestao.turma_sugerida.id;
  } else if (sugestao.decisao_automatica && sugestao.classe_sugerida) {
    const turmaEscolhidaRows = await queryAsync(
      `SELECT class_id FROM turmas WHERE id = ? AND school_id = ?`,
      [turmaIdNova, schoolId]
    );
    const contrariaRegra = turmaEscolhidaRows.length > 0 &&
      Number(turmaEscolhidaRows[0].class_id) !== Number(sugestao.classe_sugerida.id);

    if (contrariaRegra) {
      // Renovações INTERMÉDIAS nunca podem ser forçadas — mudar de classe a
      // meio do ano não é uma "exceção académica", é estrutural (a decisão
      // só existe na renovação final). Só a regra de progressão da renovação
      // FINAL pode ser forçada, e só com justificação.
      const podeForcar = forcarExcecao && sugestao.ronda?.e_final && motivoExcecao && String(motivoExcecao).trim().length >= 10;

      if (!podeForcar) {
        const erro = new Error(
          sugestao.ronda && !sugestao.ronda.e_final
            ? `Esta é uma renovação INTERMÉDIA (ronda ${sugestao.ronda.ronda_atual} de ${sugestao.ronda.rondas_por_ano} do ano letivo de ${sugestao.ronda.ano_letivo}) — ${alunoNome} deve manter-se na turma atual ("${sugestao.classe_sugerida.nome}"). A mudança de classe só é decidida na renovação final do ano.`
            : forcarExcecao
              ? `Para forçar esta exceção contra a regra de progressão de "${alunoNome}", é obrigatório indicar uma justificação com pelo menos 10 caracteres.`
              : `${alunoNome} tem situação académica "${situacaoAcademica}" nesta renovação final do ano — de acordo com a regra de progressão, deve ${sugestao.repete_classe ? 'repetir a classe atual' : 'progredir para a classe seguinte'} ("${sugestao.classe_sugerida.nome}"), e não a turma selecionada. Escolha uma turma dentro de "${sugestao.classe_sugerida.nome}", ou force a exceção com uma justificação.`
        );
        erro.status = 400;
        // Sinaliza ao frontend que este erro especificamente pode ser
        // ultrapassado com forcarExcecao+motivoExcecao — só quando é mesmo a
        // renovação final (nunca em rondas intermédias, que são estruturais).
        erro.precisaExcecao = !!(sugestao.ronda && sugestao.ronda.e_final);
        throw erro;
      }

      decisaoManual = true;
      motivoExcecaoFinal = String(motivoExcecao).trim();
    }
  } else {
    // sugestao.decisao_automatica === false → já é um dos casos normais de
    // decisão manual (Sem notas, Excluído, sem vagas, Vai a Exame pendente).
    decisaoManual = true;
    if (motivoExcecao && String(motivoExcecao).trim()) motivoExcecaoFinal = String(motivoExcecao).trim();
  }

  // Verificar se a nova turma existe e pegar a classe dela
  const turmaRows = await queryAsync(
    `SELECT t.id, t.nome, t.class_id, t.secao_id, t.capacidade_maxima, c.nome as classe_nome FROM turmas t LEFT JOIN classes c ON c.id = t.class_id WHERE t.id = ? AND t.school_id = ?`,
    [turmaIdNova, schoolId]
  );
  if (turmaRows.length === 0) {
    const erro = new Error('Turma inválida para esta escola');
    erro.status = 400;
    throw erro;
  }
  const turma = turmaRows[0];

  // v143 — GUARDA DE INTEGRIDADE SECÇÃO↔TURMA. Em modo turma-por-secção
  // (histórico, omissão), cada turma pertence a UMA secção — se o admin
  // escolheu explicitamente uma secção (`secaoId`, vindo do seletor de
  // secção na renovação) mas a turma escolhida a seguir pertence a OUTRA
  // secção da mesma classe, isto é uma inconsistência: sem esta guarda,
  // `students.secao_id` ficaria com a secção escolhida enquanto o aluno
  // fisicamente fica noutra turma/secção — exatamente o cenário que não
  // pode acontecer ("alunos de secções diferentes em turmas diferentes").
  // Em modo turma-mista isto não se aplica: a turma é partilhada por todas
  // as secções (turmas.secao_id fica sempre 0), por isso não há turma
  // "certa" para comparar.
  if (secaoId) {
    const { turma_unica_mista: turmaMistaParaGuarda } = await getSecaoSettings(schoolId);
    if (!turmaMistaParaGuarda && Number(turma.secao_id || 0) !== Number(secaoId)) {
      const erro = new Error(
        `A turma "${turma.nome}" não pertence à secção escolhida — escolha uma turma que pertença mesmo a essa secção, ou crie uma turma nova nela na aba Turmas.`
      );
      erro.status = 400;
      throw erro;
    }
  }

  // v77 — GUARDA FINAL DE VAGAS. `sugerirProgressao` já evita sugerir uma
  // turma cheia, mas isto cobre a escolha MANUAL de turma (individual ou em
  // massa) e a janela de tempo entre a pré-visualização e a confirmação, onde
  // a turma podia ter enchido entretanto. Só se aplica quando o aluno está
  // mesmo a MUDAR de turma (mover-se para dentro de uma turma já cheia é
  // diferente de simplesmente continuar nela). Pode ser ultrapassada com
  // `forcarExcecao` + justificação, para casos deliberados da escola.
  if (
    Number(turmaIdNova) !== Number(turmaIdAnterior) &&
    turma.capacidade_maxima != null &&
    !(forcarExcecao && motivoExcecaoFinal)
  ) {
    const ocupacaoRows = await queryAsync(
      `SELECT COUNT(*) as ocupacao FROM students WHERE turma_id = ? AND ativo = 1 AND school_id = ?`,
      [turmaIdNova, schoolId]
    );
    const ocupacaoAtual = ocupacaoRows[0]?.ocupacao || 0;
    if (ocupacaoAtual >= turma.capacidade_maxima) {
      const erro = new Error(
        `A turma "${turma.nome}" já está na capacidade máxima (${ocupacaoAtual}/${turma.capacidade_maxima}). Escolha outra turma, aumente a capacidade, ou force a exceção com uma justificação.`
      );
      erro.status = 400;
      throw erro;
    }
  }

  // Renovar matrícula (muda turma, reativa o aluno, atualiza data de inscrição)
  const dataInscricao = novaDataInscricao || new Date().toISOString().split('T')[0];
  await queryAsync(
    `UPDATE students SET turma_id = ?, status = 'ativo', ativo = 1, data_inscricao = ?, updated_at = NOW() WHERE id = ? AND school_id = ?`,
    [turmaIdNova, dataInscricao, studentId, schoolId]
  );

  // v100 — mantém `students.secao_id` sincronizado com a secção efetiva
  // desta renovação: prioridade para uma escolha explícita (`secaoId`,
  // essencial em turma mista, onde a turma por si só já não identifica a
  // secção), depois para a sugestão da própria progressão (continuidade da
  // secção atual quando a escolha deixou de ser obrigatória — ver
  // enrollmentStatusService.sugerirProgressao), e por fim para a secção da
  // turma escolhida (comportamento histórico de turma-por-secção).
  await sincronizarSecaoDoAluno(schoolId, studentId, turmaIdNova, secaoId ?? sugestao.secao_sugerida?.id ?? null);

  // ── COBRANÇA DA TAXA DE RENOVAÇÃO — SEPARADA DA DECISÃO DE RENOVAR (v55) ──
  // A partir desta versão, a renovação da matrícula (mudança de turma, registo
  // no histórico) e a geração da cobrança são dois passos distintos, feitos
  // por serviços diferentes: services/enrollmentStatusService.js decide A
  // MATRÍCULA; services/financialStatusService.js#gerarCobrancaRenovacao trata
  // SÓ da parte financeira. Isto permite renovar sem cobrar (`gerarCobranca:
  // false` — ex.: renovação isenta/bolsa) sem tocar na lógica de progressão.
  let cobranca = null;
  if (gerarCobranca && turma.class_id) {
    const { periodicidade, data_fim: dataFimJanela } = await (async () => {
      const settingsRows = await queryAsync(`SELECT periodicidade, data_fim FROM renewal_settings WHERE school_id = ? LIMIT 1`, [schoolId]);
      return {
        periodicidade: settingsRows.length > 0 ? settingsRows[0].periodicidade : 'Anual',
        data_fim: settingsRows.length > 0 ? settingsRows[0].data_fim : null,
      };
    })();

    cobranca = await gerarCobrancaRenovacao(schoolId, studentId, {
      classId: turma.class_id,
      turmaId: turmaIdNova,
      turmaNome: turma.nome,
      classeNome: turma.classe_nome,
      periodicidade,
      dataFimJanela,
    });
  }

  // Regista a renovação no histórico/auditoria, independentemente de ter gerado taxa
  const anoLetivoRenovacao = await resolverAnoLetivoPorData(schoolId, new Date().toISOString().split('T')[0]);
  const historicoInserido = await queryAsync(
    `
      INSERT INTO enrollment_history
        (school_id, student_id, turma_id_anterior, turma_nome_anterior, turma_id_nova, turma_nome_nova, situacao_academica, ronda, tipo_renovacao, taxa_cobrada, academic_year_id, decisao_manual, motivo_excecao, origem, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
    `,
    [schoolId, studentId, turmaIdAnterior, turmaNomeAnterior, turmaIdNova, turma.nome, situacaoAcademica, ronda.ronda_atual, ronda.e_final ? 'final' : 'intermedia', cobranca?.valor_total ?? cobranca?.valor ?? null, anoLetivoRenovacao.virtual ? null : anoLetivoRenovacao.id, decisaoManual, motivoExcecaoFinal, origem]
  );

  // Notificação individual apenas para renovações manuais (a renovação em massa
  // gera uma única notificação-resumo, para não inundar o painel de alertas)
  if (origem === 'manual') {
    await criarNotificacao(
      schoolId,
      'renewal_completed',
      'Matrícula renovada',
      `${alunoNome} foi renovado(a) para a turma ${turma.nome}${cobranca ? ` — taxa de ${cobranca.valor_total ?? cobranca.valor} MZN gerada` : ''}.`
    );
  }

  // v96 — gera o comprovativo de renovação em PDF e envia automaticamente por
  // WhatsApp ao(s) encarregado(s), tanto para renovação manual como em massa
  // (as duas passam por esta mesma função). Sem `await` bloqueante — ver
  // nota equivalente em createStudent, acima.
  notificarRenovacaoMatricula(schoolId, studentId, historicoInserido.insertId);

  return { cobranca, historyId: historicoInserido.insertId, situacaoAcademica, repeteClasse: !!sugestao.repete_classe, classeNova: turma.classe_nome, ronda };
};

export const renewEnrollment = async (req, res) => {
  try {
    const { schoolId, studentId } = req.params;
    const { turmaIdNova, novaDataInscricao, gerarCobranca, forcarExcecao, motivoExcecao, secaoId } = req.body;

    const { cobranca, historyId, situacaoAcademica, repeteClasse, classeNova, ronda } = await performRenewEnrollment(
      schoolId, studentId, turmaIdNova, novaDataInscricao, 'manual',
      { gerarCobranca: gerarCobranca !== false, forcarExcecao: !!forcarExcecao, motivoExcecao, secaoId: secaoId || null }
    );

    const progressaoMsg = !ronda.e_final
      ? ` Renovação intermédia (ronda ${ronda.ronda_atual} de ${ronda.rondas_por_ano} do ano letivo de ${ronda.ano_letivo}) — o aluno manteve-se na turma atual; a progressão/repetição de classe só será decidida na renovação final do ano.`
      : situacaoAcademica && situacaoAcademica !== 'Sem notas' && situacaoAcademica !== 'Excluído'
        ? ` Renovação FINAL do ano letivo de ${ronda.ano_letivo}. Situação académica: "${situacaoAcademica}" — ${repeteClasse ? `repetiu a classe "${classeNova}"` : `progrediu para a classe "${classeNova}"`}.`
        : '';

    res.json({
      success: true,
      message: (cobranca
        ? cobranca.fora_do_prazo
          ? `Matrícula renovada com sucesso. Como foi fora do prazo, foi aplicada uma multa: taxa de ${cobranca.valor} MZN + multa de ${cobranca.multa} MZN = ${cobranca.valor_total} MZN (vencimento ${cobranca.data_vencimento}).`
          : `Matrícula renovada com sucesso. Taxa de renovação de ${cobranca.valor} MZN gerada (vencimento ${cobranca.data_vencimento}).`
        : 'Matrícula renovada com sucesso') + progressaoMsg,
      cobranca,
      historyId,
      situacaoAcademica,
      repeteClasse,
      ronda,
    });
  } catch (error) {
    console.error('[v0] Erro no renewEnrollment:', error);
    res.status(error.status || 500).json({ success: false, message: error.status ? error.message : 'Erro interno do servidor', error: error.message, precisaExcecao: !!error.precisaExcecao });
  }
};

/**
 * POST /schools/:schoolId/students/:studentId/renewal-fee
 * Gera (ou gera de novo) SÓ a cobrança da taxa de renovação, sem repetir a
 * decisão de matrícula — útil quando a renovação já foi feita sem cobrança
 * (ex.: `gerarCobranca:false`) e o admin decide cobrar depois, ou quando quer
 * emitir uma segunda via da cobrança manualmente.
 */
export const chargeRenewalFee = async (req, res) => {
  try {
    const { schoolId, studentId } = req.params;

    const alunoRows = await queryAsync(
      `SELECT s.id, s.turma_id, t.nome as turma_nome, t.class_id, c.nome as classe_nome
       FROM students s LEFT JOIN turmas t ON t.id = s.turma_id LEFT JOIN classes c ON c.id = t.class_id
       WHERE s.id = ? AND s.school_id = ? LIMIT 1`,
      [studentId, schoolId]
    );
    if (alunoRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Aluno não encontrado' });
    }
    const aluno = alunoRows[0];
    if (!aluno.turma_id || !aluno.class_id) {
      return res.status(400).json({ success: false, message: 'Aluno não está associado a nenhuma turma/classe atualmente' });
    }

    const settingsRows = await queryAsync(`SELECT periodicidade, data_fim FROM renewal_settings WHERE school_id = ? LIMIT 1`, [schoolId]);
    const periodicidade = settingsRows.length > 0 ? settingsRows[0].periodicidade : 'Anual';
    const dataFimJanela = settingsRows.length > 0 ? settingsRows[0].data_fim : null;

    const cobranca = await gerarCobrancaRenovacao(schoolId, studentId, {
      classId: aluno.class_id,
      turmaId: aluno.turma_id,
      turmaNome: aluno.turma_nome,
      classeNome: aluno.classe_nome,
      periodicidade,
      dataFimJanela,
    });

    if (!cobranca) {
      return res.status(400).json({ success: false, message: 'Não há taxa de renovação configurada para a classe deste aluno.' });
    }

    res.json({ success: true, message: `Cobrança gerada: taxa de ${cobranca.valor} MZN (vencimento ${cobranca.data_vencimento}).`, data: cobranca });
  } catch (error) {
    console.error('[v0] Erro ao gerar cobrança de renovação:', error);
    res.status(error.status || 500).json({ success: false, message: error.status ? error.message : 'Erro ao gerar cobrança de renovação', error: error.message });
  }
};

/**
 * GET: Histórico/auditoria de renovações de matrícula de um aluno
 * (quem renovou, de qual turma para qual, quando, e a situação académica na altura)
 */
export const getStudentEnrollmentHistory = async (req, res) => {
  try {
    await ensureEnrollmentHistoryTableExists();
    const { schoolId, studentId } = req.params;
    const { academic_year_id } = req.query;

    const alunoRows = await queryAsync(`SELECT id FROM students WHERE id = ? AND school_id = ?`, [studentId, schoolId]);
    if (alunoRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Aluno não encontrado' });
    }

    const historico = await queryAsync(
      `SELECT id, turma_nome_anterior, turma_nome_nova, situacao_academica, taxa_cobrada, origem, academic_year_id, decisao_manual, motivo_excecao, created_at
       FROM enrollment_history WHERE school_id = ? AND student_id = ? ${academic_year_id ? 'AND academic_year_id = ?' : ''} ORDER BY created_at DESC`,
      academic_year_id ? [schoolId, studentId, academic_year_id] : [schoolId, studentId]
    );

    res.json({ success: true, data: historico });
  } catch (error) {
    console.error('[v0] Erro ao buscar histórico de renovações:', error);
    res.status(500).json({ success: false, message: 'Erro ao buscar histórico de renovações', error: error.message });
  }
};

/**
 * ═══════════════════════════════════════════════════════════════════════
 * ENCARREGADOS DE EDUCAÇÃO (GUARDIANS)
 * ═══════════════════════════════════════════════════════════════════════
 */

// ── MÓDULO "ENCARREGADOS DE EDUCAÇÃO" AMPLIADO ─────────────────────────────
// Colunas novas, adicionadas via ALTER idempotente (mesmo padrão usado no
// resto do ficheiro, ex.: ensureEnrollmentHistoryTableExists):
//   profissao                 — texto livre
//   principal                 — encarregado principal (o contacto de referência)
//   responsavel_financeiro    — recebe cobranças/avisos de mensalidade
//   responsavel_academico     — recebe boletins/comunicações académicas
//   autoriza_saida            — pode retirar o aluno da escola
//   contacto_emergencia       — contacto a acionar em emergências
export const ensureGuardiansColumnsExist = memoize(async () => {
  const colunas = [
    ['profissao', `ALTER TABLE guardians ADD COLUMN profissao VARCHAR(150) NULL AFTER parentesco`],
    ['principal', `ALTER TABLE guardians ADD COLUMN principal TINYINT(1) NOT NULL DEFAULT 0 AFTER profissao`],
    ['responsavel_financeiro', `ALTER TABLE guardians ADD COLUMN responsavel_financeiro TINYINT(1) NOT NULL DEFAULT 0 AFTER principal`],
    ['responsavel_academico', `ALTER TABLE guardians ADD COLUMN responsavel_academico TINYINT(1) NOT NULL DEFAULT 0 AFTER responsavel_financeiro`],
    ['autoriza_saida', `ALTER TABLE guardians ADD COLUMN autoriza_saida TINYINT(1) NOT NULL DEFAULT 1 AFTER responsavel_academico`],
    ['contacto_emergencia', `ALTER TABLE guardians ADD COLUMN contacto_emergencia TINYINT(1) NOT NULL DEFAULT 0 AFTER autoriza_saida`],
  ];
  for (const [coluna, sql] of colunas) {
    if (!(await columnExists('guardians', coluna))) {
      await queryAsync(sql);
    }
  }
});

const CAMPOS_GUARDIAN = `id, student_id, nome, parentesco, profissao, email, telefone, telefone_secundario, morada,
   principal, responsavel_financeiro, responsavel_academico, autoriza_saida, contacto_emergencia, created_at, updated_at`;

/**
 * GET: Listar encarregados de um aluno
 */
export const getStudentGuardians = async (req, res) => {
  try {
    await ensureGuardiansColumnsExist();
    const { schoolId, studentId } = req.params;

    const alunoRows = await queryAsync(`SELECT id FROM students WHERE id = ? AND school_id = ?`, [studentId, schoolId]);
    if (alunoRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Aluno não encontrado' });
    }

    const guardians = await queryAsync(
      `SELECT ${CAMPOS_GUARDIAN} FROM guardians WHERE student_id = ? ORDER BY principal DESC, id ASC`,
      [studentId]
    );

    res.json({ success: true, data: guardians });
  } catch (error) {
    console.error('[v0] Erro ao listar encarregados:', error);
    res.status(500).json({ success: false, message: 'Erro ao listar encarregados', error: error.message });
  }
};

/**
 * PUT: Substituir a lista completa de encarregados de um aluno
 * Body: { encarregados: [{ id?, nome, telefone, parentesco?, profissao?, email?,
 *   telefone_secundario?, morada?, principal?, responsavel_financeiro?,
 *   responsavel_academico?, autoriza_saida?, contacto_emergencia? }] }
 *
 * Regra de negócio: só pode haver UM encarregado principal por aluno. Se
 * vier mais que um marcado, mantém-se o primeiro da lista e os restantes são
 * despromovidos automaticamente. Se nenhum vier marcado, o primeiro
 * encarregado da lista é promovido a principal — um aluno com encarregado(s)
 * cadastrado(s) nunca fica sem um contacto de referência.
 */
export const saveStudentGuardians = async (req, res) => {
  try {
    await ensureGuardiansColumnsExist();
    const { schoolId, studentId } = req.params;
    const { encarregados = [] } = req.body;

    const alunoRows = await queryAsync(`SELECT id FROM students WHERE id = ? AND school_id = ?`, [studentId, schoolId]);
    if (alunoRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Aluno não encontrado' });
    }

    if (!Array.isArray(encarregados)) {
      return res.status(400).json({ success: false, message: 'Lista de encarregados inválida' });
    }

    const validos = encarregados.filter((e) => e && e.nome && e.telefone);
    if (encarregados.length > 0 && validos.length === 0) {
      return res.status(400).json({ success: false, message: 'Informe pelo menos nome e telefone do encarregado' });
    }

    // Normaliza a flag "principal": garante exatamente um (ou zero, se a
    // lista ficar vazia) — nunca dois encarregados principais em simultâneo.
    let indicePrincipal = validos.findIndex((e) => !!e.principal);
    if (indicePrincipal === -1 && validos.length > 0) indicePrincipal = 0;

    // Substitui todos os encarregados do aluno pela lista enviada
    await queryAsync(`DELETE FROM guardians WHERE student_id = ?`, [studentId]);

    for (let i = 0; i < validos.length; i++) {
      const encarregado = validos[i];
      await queryAsync(
        `INSERT INTO guardians
           (student_id, nome, telefone, parentesco, profissao, email, telefone_secundario, morada,
            principal, responsavel_financeiro, responsavel_academico, autoriza_saida, contacto_emergencia,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          studentId,
          encarregado.nome.trim(),
          encarregado.telefone.trim(),
          encarregado.parentesco || null,
          encarregado.profissao || null,
          encarregado.email || null,
          encarregado.telefone_secundario || null,
          encarregado.morada || null,
          i === indicePrincipal ? 1 : 0,
          encarregado.responsavel_financeiro ? 1 : 0,
          encarregado.responsavel_academico ? 1 : 0,
          // autoriza_saida vem marcado por omissão (a maioria dos encarregados
          // pode retirar o aluno); só fica 0 se o admin desmarcar explicitamente.
          encarregado.autoriza_saida === false ? 0 : 1,
          encarregado.contacto_emergencia ? 1 : 0,
        ]
      );
    }

    const guardians = await queryAsync(
      `SELECT ${CAMPOS_GUARDIAN} FROM guardians WHERE student_id = ? ORDER BY principal DESC, id ASC`,
      [studentId]
    );

    res.json({ success: true, message: 'Encarregados atualizados com sucesso', data: guardians });
  } catch (error) {
    console.error('[v0] Erro ao salvar encarregados:', error);
    res.status(500).json({ success: false, message: 'Erro ao salvar encarregados', error: error.message });
  }
};

/**
 * ═══════════════════════════════════════════════════════════════════════
 * AÇÕES EM MASSA (BULK)
 * ═══════════════════════════════════════════════════════════════════════
 */

const validarIdsAlunos = (studentIds) => Array.isArray(studentIds) && studentIds.length > 0 && studentIds.every((id) => Number.isFinite(Number(id)));

/**
 * POST: Alterar status de vários alunos de uma vez
 * Body: { studentIds: [], status: 'ativo'|'inativo'|'suspenso'|'evadido' }
 */
export const bulkUpdateStatus = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const { studentIds, status } = req.body;

    const statusValidos = ['ativo', 'inativo', 'suspenso', 'evadido'];
    if (!validarIdsAlunos(studentIds)) {
      return res.status(400).json({ success: false, message: 'Selecione ao menos um aluno' });
    }
    if (!statusValidos.includes(status)) {
      return res.status(400).json({ success: false, message: 'Status inválido' });
    }

    const ativo = status === 'ativo' ? 1 : undefined;
    const placeholders = studentIds.map(() => '?').join(',');
    const params = [status];
    let setAtivo = '';
    if (ativo !== undefined) {
      setAtivo = ', ativo = 1';
    }
    const query = `UPDATE students SET status = ?${setAtivo}, updated_at = NOW() WHERE school_id = ? AND id IN (${placeholders})`;
    params.push(schoolId, ...studentIds);

    const resultado = await queryAsync(query, params);

    res.json({ success: true, message: `${resultado.affectedRows} aluno(s) atualizado(s) com sucesso` });
  } catch (error) {
    console.error('[v0] Erro no bulkUpdateStatus:', error);
    res.status(500).json({ success: false, message: 'Erro ao atualizar status em massa', error: error.message });
  }
};

/**
 * POST: Mover vários alunos para outra turma
 * Body: { studentIds: [], turma_id }
 */
export const bulkUpdateTurma = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const { studentIds, turma_id } = req.body;

    if (!validarIdsAlunos(studentIds)) {
      return res.status(400).json({ success: false, message: 'Selecione ao menos um aluno' });
    }
    if (!turma_id) {
      return res.status(400).json({ success: false, message: 'Turma de destino é obrigatória' });
    }

    const turmaRows = await queryAsync(`SELECT id FROM turmas WHERE id = ? AND school_id = ?`, [turma_id, schoolId]);
    if (turmaRows.length === 0) {
      return res.status(400).json({ success: false, message: 'Turma inválida para esta escola' });
    }

    const placeholders = studentIds.map(() => '?').join(',');
    const query = `UPDATE students SET turma_id = ?, updated_at = NOW() WHERE school_id = ? AND id IN (${placeholders})`;
    const resultado = await queryAsync(query, [turma_id, schoolId, ...studentIds]);

    // v143 — a mesma lacuna corrigida em updateStudent: mover alunos em
    // massa para outra turma sem re-sincronizar `students.secao_id` deixava
    // o aluno "preso" à secção da turma antiga, quebrando a listagem, o
    // boletim e os comprovativos (todos passaram a ler a secção a partir
    // daqui, ver studentController.getAllStudents). Sem escolha explícita de
    // secção neste fluxo (mudança de turma em massa, não é a tela de
    // renovação), usa-se a secção da própria turma de destino.
    for (const studentId of studentIds) {
      try {
        await sincronizarSecaoDoAluno(schoolId, studentId, turma_id, null);
      } catch (erroSecao) {
        console.error(`[v0] Aviso: não foi possível sincronizar a secção do aluno #${studentId} após mudança de turma em massa:`, erroSecao.message);
      }
    }

    res.json({ success: true, message: `${resultado.affectedRows} aluno(s) movido(s) de turma com sucesso` });
  } catch (error) {
    console.error('[v0] Erro no bulkUpdateTurma:', error);
    res.status(500).json({ success: false, message: 'Erro ao mover alunos em massa', error: error.message });
  }
};

/**
 * POST: Arquivar (soft delete) vários alunos de uma vez
 * Body: { studentIds: [] }
 */
export const bulkArchiveStudents = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const { studentIds } = req.body;

    if (!validarIdsAlunos(studentIds)) {
      return res.status(400).json({ success: false, message: 'Selecione ao menos um aluno' });
    }

    const placeholders = studentIds.map(() => '?').join(',');
    const query = `UPDATE students SET ativo = 0, status = 'inativo', updated_at = NOW() WHERE school_id = ? AND id IN (${placeholders})`;
    const resultado = await queryAsync(query, [schoolId, ...studentIds]);

    res.json({ success: true, message: `${resultado.affectedRows} aluno(s) arquivado(s) com sucesso` });
  } catch (error) {
    console.error('[v0] Erro no bulkArchiveStudents:', error);
    res.status(500).json({ success: false, message: 'Erro ao arquivar alunos em massa', error: error.message });
  }
};

/**
 * POST: Renovar matrícula de vários alunos de uma vez, para a mesma turma de destino
 * Body: { studentIds: [], turmaIdNova, novaDataInscricao? }
 */
export const bulkRenewEnrollment = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const { studentIds, turmaIdNova, novaDataInscricao, gerarCobranca, forcarExcecao, motivoExcecao, secaoId } = req.body;

    if (!validarIdsAlunos(studentIds)) {
      return res.status(400).json({ success: false, message: 'Selecione ao menos um aluno' });
    }
    // v77 — se `forcarExcecao` vier ligado no lote, aplica a MESMA justificação
    // a todos os alunos deste lote que precisem de forçar exceção contra a
    // regra de progressão (ex.: turma fixa escolhida a dedo que contraria a
    // sugestão de alguns alunos selecionados). Quem não precisar de forçar
    // nada simplesmente ignora estes parâmetros.
    // turmaIdNova agora é opcional: se não for informado, cada aluno recebe a
    // sugestão automática de progressão de classe (aprovado → próxima classe,
    // reprovado/vai a exame → mesma classe, excluído → falha e exige decisão manual)
    const sucesso = [];
    const falhas = [];

    for (const studentId of studentIds) {
      try {
        await performRenewEnrollment(schoolId, studentId, turmaIdNova || null, novaDataInscricao, 'massa', {
          gerarCobranca: gerarCobranca !== false, forcarExcecao: !!forcarExcecao, motivoExcecao,
          // secaoId só faz sentido aplicar em massa quando é a MESMA turma
          // fixa para todos (escolha manual); com sugestão automática por
          // aluno, cada um segue a sua própria continuidade de secção.
          secaoId: turmaIdNova ? (secaoId || null) : null,
        });
        sucesso.push(studentId);
      } catch (erroIndividual) {
        falhas.push({ studentId, motivo: erroIndividual.message, precisaExcecao: !!erroIndividual.precisaExcecao });
      }
    }

    if (sucesso.length > 0) {
      await criarNotificacao(
        schoolId,
        'renewal_completed',
        'Renovação em massa concluída',
        `${sucesso.length} matrícula(s) renovada(s) em massa${falhas.length > 0 ? `, ${falhas.length} falharam` : ''}.`
      );
    }

    res.json({
      success: true,
      message: `${sucesso.length} matrícula(s) renovada(s) com sucesso${falhas.length > 0 ? `, ${falhas.length} falharam` : ''}.`,
      sucesso,
      falhas,
    });
  } catch (error) {
    console.error('[v0] Erro no bulkRenewEnrollment:', error);
    res.status(500).json({ success: false, message: 'Erro ao renovar matrículas em massa', error: error.message });
  }
};

/**
 * POST: Atribuir secção em massa a alunos que já estão matriculados sem
 * secção definida — v100. Resolve a lacuna deixada quando a escola liga a
 * obrigatoriedade de secção numa classe que já tem alunos ativos: em vez de
 * cada um só ficar em dia na próxima renovação, o admin resolve tudo de
 * uma vez aqui (ver também secaoController.getAlunosPendentesDeSecao, que
 * alimenta a lista usada pelo frontend para montar este pedido).
 * Body: { alunoIds: [], secaoId }
 */
export const atribuirSecaoEmMassa = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const { alunoIds = [], secaoId } = req.body;

    if (!Array.isArray(alunoIds) || alunoIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Selecione pelo menos um aluno' });
    }
    if (!secaoId) {
      return res.status(400).json({ success: false, message: 'Escolha a secção a atribuir' });
    }

    await ensureSecoesTableExists();
    await ensureTurmaSecaoColumnExists();
    await ensureStudentSecaoColumnExists();

    const secaoRows = await queryAsync(`SELECT id, classe_id, nome FROM secoes WHERE id = ? AND school_id = ?`, [secaoId, schoolId]);
    if (secaoRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Secção não encontrada' });
    }
    const secao = secaoRows[0];
    const classeRows = await queryAsync(`SELECT nome FROM classes WHERE id = ? AND school_id = ?`, [secao.classe_id, schoolId]);
    const classeNome = classeRows[0]?.nome || `classe #${secao.classe_id}`;

    const { turma_unica_mista: turmaMista } = await getSecaoSettings(schoolId);

    const placeholders = alunoIds.map(() => '?').join(',');
    const alunos = await queryAsync(
      `SELECT s.id, s.turma_id, t.class_id FROM students s LEFT JOIN turmas t ON t.id = s.turma_id
       WHERE s.school_id = ? AND s.ativo = 1 AND s.id IN (${placeholders})`,
      [schoolId, ...alunoIds]
    );

    let movidos = 0;
    const ignorados = [];

    for (const aluno of alunos) {
      if (Number(aluno.class_id) !== Number(secao.classe_id)) {
        ignorados.push(`Aluno #${aluno.id} não está numa turma de "${classeNome}" — ignorado`);
        continue;
      }
      let turmaDestino = aluno.turma_id;
      // Em modo turma-por-secção (histórico), a atribuição em massa também
      // move o aluno para a turma certa da secção — assim o currículo
      // (class_disciplinas por secção) e o horário passam a refletir a
      // secção de imediato. Em turma mista isso não é necessário: a turma
      // já é partilhada, só a secção do aluno muda.
      if (!turmaMista) {
        turmaDestino = await getOrCreateTurmaForClasseId(schoolId, aluno.class_id, secaoId);
        if (Number(turmaDestino) !== Number(aluno.turma_id)) {
          await queryAsync(`UPDATE students SET turma_id = ?, updated_at = NOW() WHERE id = ? AND school_id = ?`, [turmaDestino, aluno.id, schoolId]);
        }
      }
      await sincronizarSecaoDoAluno(schoolId, aluno.id, turmaDestino, secaoId);
      movidos++;
    }

    res.json({
      success: true,
      message: `${movidos} aluno(s) atribuído(s) à secção "${secao.nome}"${ignorados.length > 0 ? ` — ${ignorados.length} ignorado(s)` : ''}`,
      data: { movidos, ignorados },
    });
  } catch (error) {
    console.error('[v0] Erro ao atribuir secção em massa:', error);
    res.status(500).json({ success: false, message: 'Erro ao atribuir secção em massa', error: error.message });
  }
};
