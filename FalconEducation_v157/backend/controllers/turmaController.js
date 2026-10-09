import db from '../config/db.js';
import { ensureTabelasHorario } from './horarioController.js';
import { getAnoLetivoAtivo } from '../services/academicYearService.js';
import { ensureTurmaSecaoColumnExists, sincronizarSecaoDoAluno, ensureStudentSecaoColumnExists, getSecaoSettings } from './secaoController.js';
import { registrarAuditoria } from '../services/auditService.js';
import { getConfigAvaliacao } from './gradeController.js';
import { getConfiguracaoAcademicaEfetiva } from '../services/configuracaoAcademicaService.js';

const queryAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.query(sql, params, (err, results) => {
    if (err) return reject(err);
    resolve(results);
  });
});

// v55 — UNIFICAÇÃO classe/turma/ano letivo: `turmas` ganha uma coluna
// academic_year_id (nullable, migração idempotente) ligando cada turma ao ano
// letivo (services/academicYearService.js) em que foi criada. Isto resolve a
// ambiguidade de "1º A" ser a mesma turma eterna independentemente do ano —
// turmas criadas a partir de agora ficam marcadas com o ano letivo ATIVO no
// momento da criação; turmas já existentes (sem esta coluna preenchida) são
// tratadas como "sem ano letivo definido" e continuam a aparecer normalmente
// em todas as listagens (comportamento antigo preservado).
let turmasAnoLetivoColumnEnsured = false;
export const ensureTurmaAcademicYearColumn = async () => {
  if (turmasAnoLetivoColumnEnsured) return;
  const result = await queryAsync(`SHOW COLUMNS FROM turmas LIKE 'academic_year_id'`);
  if (result.length === 0) {
    await queryAsync(`ALTER TABLE turmas ADD COLUMN academic_year_id INT NULL AFTER class_id`);
  }
  turmasAnoLetivoColumnEnsured = true;
};

// NOVO — a coluna `professor_responsavel_id` já era LIDA em dois lugares
// (dashboardController.js, para o alerta "turmas sem professor responsável",
// e painelTurmaController.js, para mostrar o "Professor titular" no Painel
// da Turma), mas nunca tinha uma migração própria nem um endpoint para a
// escrever — ou seja, dava para ver que faltava atribuir, mas não dava para
// atribuir. Mesma convenção de ensure*ColumnExists já usada para
// academic_year_id/secao_id nesta turma.
let turmaProfessorResponsavelColumnEnsured = false;
export const ensureTurmaProfessorResponsavelColumn = async () => {
  if (turmaProfessorResponsavelColumnEnsured) return;
  const result = await queryAsync(`SHOW COLUMNS FROM turmas LIKE 'professor_responsavel_id'`);
  if (result.length === 0) {
    await queryAsync(`ALTER TABLE turmas ADD COLUMN professor_responsavel_id INT NULL AFTER turno_id`);
  }
  turmaProfessorResponsavelColumnEnsured = true;
};

// Mesma convenção de nome de classe usada em studentController.js
// (getClassIdForSchool) — reaproveitada aqui para que uma turma criada
// manualmente fique associada à MESMA linha de `classes` que o fluxo
// automático de matrícula usaria para essa classe, em vez de duplicar.
const getOrCreateClassId = async (schoolId, classNumber) => {
  const className = `${classNumber}ª Classe`;

  const existentes = await queryAsync(`SELECT id FROM classes WHERE school_id = ? AND nome = ? LIMIT 1`, [schoolId, className]);
  if (existentes.length > 0) return existentes[0].id;

  const inserida = await queryAsync(
    `INSERT INTO classes (school_id, nome, descricao, ativa, created_at, updated_at) VALUES (?, ?, ?, TRUE, NOW(), NOW())`,
    [schoolId, className, `Série automática para ${className}`]
  );
  return inserida.insertId;
};

// POST /schools/:schoolId/turmas — criação manual de turma (o sistema já
// cria turmas automaticamente ao matricular um aluno sem turma_id definido,
// via getOrCreateTurmaForClass em studentController.js; isto cobre o caso de
// o administrador querer preparar a turma ANTES de haver alunos).
export const createTurma = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const { classe, class_id, nome, descricao, capacidade_maxima, sala_id, turno_id, secao_id, professor_responsavel_id } = req.body;

    // Garante que a coluna turno_id existe em `turmas` antes de gravar nela —
    // mesma auto-migração usada em getTurmasBySchool, para este endpoint não
    // depender de a página de Horários já ter corrido primeiro.
    try {
      await ensureTabelasHorario();
    } catch (migrationErr) {
      console.error('[v0] Aviso: não foi possível garantir as tabelas de horário:', migrationErr.message);
    }
    await ensureTurmaAcademicYearColumn();
    await ensureTurmaSecaoColumnExists();
    await ensureTurmaProfessorResponsavelColumn();

    if (!classe && !class_id) {
      return res.status(400).json({ success: false, message: 'Classe é obrigatória para criar a turma' });
    }

    let classIdFinal = class_id || null;
    if (!classIdFinal) {
      const classNumber = parseInt(classe, 10);
      if (Number.isNaN(classNumber) || classNumber < 1) {
        return res.status(400).json({ success: false, message: 'Classe deve ser um número válido' });
      }
      classIdFinal = await getOrCreateClassId(schoolId, classNumber);
    } else {
      const classeExiste = await queryAsync(`SELECT id FROM classes WHERE id = ? AND school_id = ?`, [classIdFinal, schoolId]);
      if (classeExiste.length === 0) {
        return res.status(400).json({ success: false, message: 'Classe inválida para esta escola' });
      }
    }

    const capacidadeFinal = capacidade_maxima ? parseInt(capacidade_maxima, 10) : 30;
    if (Number.isNaN(capacidadeFinal) || capacidadeFinal < 1) {
      return res.status(400).json({ success: false, message: 'Capacidade máxima deve ser um número maior que zero' });
    }

    // Sugere "<classe>º <letra>" quando o nome não é indicado — mesmo padrão
    // usado no fluxo automático (A, B, C... conforme quantas turmas a classe
    // já tem).
    let nomeFinal = (nome || '').trim();
    if (!nomeFinal) {
      const [classeRow] = await queryAsync(`SELECT nome FROM classes WHERE id = ?`, [classIdFinal]);
      const numeroClasse = parseInt(classeRow?.nome, 10) || classe;
      const contagem = await queryAsync(`SELECT COUNT(*) as total FROM turmas WHERE school_id = ? AND class_id = ?`, [schoolId, classIdFinal]);
      const sufixo = String.fromCharCode(65 + ((contagem[0]?.total || 0) % 26));
      nomeFinal = `${numeroClasse}º ${sufixo}`;
    }

    const nomeDuplicado = await queryAsync(`SELECT id FROM turmas WHERE school_id = ? AND nome = ? LIMIT 1`, [schoolId, nomeFinal]);
    if (nomeDuplicado.length > 0) {
      return res.status(409).json({ success: false, message: `Já existe uma turma chamada "${nomeFinal}" nesta escola` });
    }

    if (sala_id) {
      const salaValida = await queryAsync(`SELECT id FROM salas WHERE id = ? AND school_id = ? AND ativa = TRUE`, [sala_id, schoolId]);
      if (salaValida.length === 0) {
        return res.status(400).json({ success: false, message: 'Sala inválida para esta escola' });
      }
    }

    if (turno_id) {
      const turnoValido = await queryAsync(`SELECT id FROM turnos WHERE id = ? AND school_id = ?`, [turno_id, schoolId]);
      if (turnoValido.length === 0) {
        return res.status(400).json({ success: false, message: 'Turno inválido para esta escola' });
      }
    }

    if (professor_responsavel_id) {
      const professorValido = await queryAsync(`SELECT id FROM teachers WHERE id = ? AND school_id = ?`, [professor_responsavel_id, schoolId]);
      if (professorValido.length === 0) {
        return res.status(400).json({ success: false, message: 'Professor responsável inválido para esta escola' });
      }
    }

    // v94 — se a classe usa secções (Ciências/Letras), a turma pode (deve)
    // pertencer a uma delas. secao_id = 0/omitido = "sem secção" — continua
    // a funcionar normalmente para classes que não usam esta funcionalidade.
    let secaoIdFinal = Number(secao_id) || 0;
    if (secaoIdFinal !== 0) {
      const secaoValida = await queryAsync(`SELECT id FROM secoes WHERE id = ? AND school_id = ? AND classe_id = ?`, [secaoIdFinal, schoolId, classIdFinal]);
      if (secaoValida.length === 0) {
        return res.status(400).json({ success: false, message: 'Secção inválida para a classe escolhida' });
      }
    }

    const anoLetivoAtivo = await getAnoLetivoAtivo(schoolId);

    const resultado = await queryAsync(
      `INSERT INTO turmas (school_id, class_id, secao_id, academic_year_id, sala_id, turno_id, professor_responsavel_id, nome, descricao, capacidade_maxima, ativa, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE, NOW(), NOW())`,
      [schoolId, classIdFinal, secaoIdFinal, anoLetivoAtivo.virtual ? null : anoLetivoAtivo.id, sala_id || null, turno_id || null, professor_responsavel_id || null, nomeFinal, descricao || null, capacidadeFinal]
    );

    res.status(201).json({
      success: true,
      message: 'Turma criada com sucesso',
      data: { id: resultado.insertId, nome: nomeFinal, class_id: classIdFinal, secao_id: secaoIdFinal, academic_year_id: anoLetivoAtivo.virtual ? null : anoLetivoAtivo.id, professor_responsavel_id: professor_responsavel_id || null, capacidade_maxima: capacidadeFinal },
    });
  } catch (err) {
    console.error('[v0] Erro ao criar turma:', err);
    res.status(500).json({ success: false, message: 'Erro ao criar turma', error: err.message });
  }
};

export const getTurmasBySchool = async (req, res) => {
  const { schoolId } = req.params;
  const { academic_year_id: academicYearIdFiltro, apenas_ano_ativo: apenasAnoAtivo } = req.query;

  try {
    await ensureTabelasHorario();
  } catch (migrationErr) {
    console.error('[v0] Aviso: não foi possível garantir as tabelas de horário:', migrationErr.message);
  }
  try {
    await ensureTurmaAcademicYearColumn();
  } catch (migrationErr) {
    console.error('[v0] Aviso: não foi possível garantir a coluna academic_year_id em turmas:', migrationErr.message);
  }
  try {
    await ensureTurmaProfessorResponsavelColumn();
  } catch (migrationErr) {
    console.error('[v0] Aviso: não foi possível garantir a coluna professor_responsavel_id em turmas:', migrationErr.message);
  }

  // Filtro opcional por ano letivo. Turmas antigas (academic_year_id NULL,
  // criadas antes desta versão) continuam sempre visíveis — nunca ficam
  // "escondidas" por uma migração retroativa.
  let filtroAnoLetivoId = academicYearIdFiltro || null;
  if (!filtroAnoLetivoId && apenasAnoAtivo === 'true') {
    const anoLetivoAtivo = await getAnoLetivoAtivo(schoolId);
    filtroAnoLetivoId = anoLetivoAtivo.virtual ? null : anoLetivoAtivo.id;
  }

  const query = `
    SELECT
      t.id,
      t.school_id,
      t.class_id,
      t.secao_id,
      sec.nome as secao_nome,
      t.academic_year_id,
      ay.nome as ano_letivo_nome,
      t.sala_id,
      t.turno_id,
      tn.nome as turno_nome,
      t.professor_responsavel_id,
      te.nome as professor_titular_nome,
      t.nome,
      t.descricao,
      t.capacidade_maxima,
      t.ativa,
      c.nome as classe,
      sl.numero as sala_numero,
      sl.capacidade as sala_capacidade,
      COALESCE(COUNT(s.id), 0) as aluno_count
    FROM turmas t
    LEFT JOIN classes c ON t.class_id = c.id
    LEFT JOIN secoes sec ON sec.id = t.secao_id
    LEFT JOIN salas sl ON t.sala_id = sl.id
    LEFT JOIN turnos tn ON t.turno_id = tn.id
    LEFT JOIN academic_years ay ON ay.id = t.academic_year_id
    LEFT JOIN teachers te ON te.id = t.professor_responsavel_id
    LEFT JOIN students s ON s.turma_id = t.id AND s.school_id = ?
    WHERE t.school_id = ? ${filtroAnoLetivoId ? 'AND (t.academic_year_id = ? OR t.academic_year_id IS NULL)' : ''}
    GROUP BY t.id, t.school_id, t.class_id, t.secao_id, sec.nome, t.academic_year_id, ay.nome, t.sala_id, t.turno_id, tn.nome,
             t.professor_responsavel_id, te.nome, t.nome, t.descricao,
             t.capacidade_maxima, t.ativa, c.nome, sl.numero, sl.capacidade
    ORDER BY t.nome ASC
  `;
  const params = filtroAnoLetivoId ? [schoolId, schoolId, filtroAnoLetivoId] : [schoolId, schoolId];

  try {
    const results = await queryAsync(query, params);

    // v152 — cada turma passa a trazer `possui_exame` (configuração
    // académica efetiva da sua classe, ver configuracaoAcademicaService.js)
    // para a Gestão de Turmas poder mostrar "Pauta de Exame (Júris)" só nas
    // turmas cuja classe tem exame, e não em todas indiscriminadamente.
    const configEscola = await getConfigAvaliacao(schoolId);
    const configPorClasse = new Map();
    const turmasComConfigExame = await Promise.all(results.map(async (turma) => {
      if (!turma.class_id) return { ...turma, possui_exame: !!configEscola?.usa_exame };
      if (!configPorClasse.has(turma.class_id)) {
        configPorClasse.set(turma.class_id, getConfiguracaoAcademicaEfetiva(schoolId, turma.class_id, turma.classe, configEscola));
      }
      const configAcademica = await configPorClasse.get(turma.class_id);
      return { ...turma, possui_exame: !!configAcademica.possui_exame };
    }));

    res.json({ success: true, data: turmasComConfigExame });
  } catch (err) {
    console.error('[v0] Erro ao listar turmas:', err);
    if (err.code === 'ER_NO_SUCH_TABLE') {
      return res.json({ success: true, data: [] });
    }
    return res.status(500).json({ success: false, message: 'Erro ao listar turmas', error: err.message });
  }
};

// NOVO (v94): associar (ou remover) a secção de uma turma
export const updateTurmaSecao = async (req, res) => {
  try {
    const { schoolId, turmaId } = req.params;
    const { secao_id } = req.body; // pode ser null/0 para "sem secção"
    await ensureTurmaSecaoColumnExists();

    const turmaRows = await queryAsync(`SELECT id, class_id FROM turmas WHERE id = ? AND school_id = ?`, [turmaId, schoolId]);
    if (turmaRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Turma não encontrada' });
    }

    const secaoIdFinal = Number(secao_id) || 0;
    if (secaoIdFinal !== 0) {
      const secaoValida = await queryAsync(`SELECT id FROM secoes WHERE id = ? AND school_id = ? AND classe_id = ?`, [secaoIdFinal, schoolId, turmaRows[0].class_id]);
      if (secaoValida.length === 0) {
        return res.status(400).json({ success: false, message: 'Secção inválida para a classe desta turma' });
      }
    }

    await queryAsync(`UPDATE turmas SET secao_id = ?, updated_at = NOW() WHERE id = ? AND school_id = ?`, [secaoIdFinal, turmaId, schoolId]);

    // v143 — CASCATA PARA OS ALUNOS JÁ NA TURMA. Antes, reatribuir a secção
    // de uma turma (ex.: uma turma criada "sem secção" passa a pertencer a
    // "Ciências") não tocava em `students.secao_id` dos alunos já lá
    // matriculados — eles continuavam a aparecer como "sem secção" na
    // listagem/boletim/comprovativos (que agora leem de students.secao_id,
    // não de turmas.secao_id — ver studentController.getAllStudents) até à
    // próxima renovação. Em modo turma-mista isto não se aplica: a turma
    // fica sempre "sem secção" (secaoIdFinal normalmente 0) e a secção de
    // cada aluno é individual, não da turma.
    try {
      await ensureStudentSecaoColumnExists();
      const { turma_unica_mista: turmaMista } = await getSecaoSettings(schoolId);
      if (!turmaMista) {
        const alunosDaTurma = await queryAsync(`SELECT id FROM students WHERE turma_id = ? AND school_id = ? AND ativo = 1`, [turmaId, schoolId]);
        for (const aluno of alunosDaTurma) {
          await sincronizarSecaoDoAluno(schoolId, aluno.id, turmaId, secaoIdFinal || null);
        }
      }
    } catch (erroCascata) {
      console.error('[v0] Aviso: não foi possível propagar a secção da turma aos alunos já matriculados:', erroCascata.message);
    }

    await registrarAuditoria(req, {
      acao: 'turma_secao_alterada', entidadeTipo: 'turma', entidadeId: turmaId,
      dadosAntigos: { class_id: turmaRows[0].class_id }, dadosNovos: { secao_id: secaoIdFinal },
    });
    res.json({ success: true, message: 'Secção da turma atualizada com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao associar secção à turma:', err);
    res.status(500).json({ success: false, message: 'Erro ao associar secção', error: err.message });
  }
};

// NOVO: associar (ou remover) o professor responsável ("titular") de uma
// turma — a peça que faltava: o dado já era lido no Painel da Turma e no
// alerta "turmas sem professor responsável" do Dashboard, mas não existia
// nenhum caminho para o gravar.
export const updateTurmaProfessorResponsavel = async (req, res) => {
  try {
    const { schoolId, turmaId } = req.params;
    const { professor_responsavel_id } = req.body; // pode ser null/vazio para "sem professor titular"
    await ensureTurmaProfessorResponsavelColumn();

    const turmaRows = await queryAsync(`SELECT id, professor_responsavel_id FROM turmas WHERE id = ? AND school_id = ?`, [turmaId, schoolId]);
    if (turmaRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Turma não encontrada' });
    }

    let professorIdFinal = null;
    if (professor_responsavel_id) {
      const professorValido = await queryAsync(`SELECT id FROM teachers WHERE id = ? AND school_id = ?`, [professor_responsavel_id, schoolId]);
      if (professorValido.length === 0) {
        return res.status(400).json({ success: false, message: 'Professor inválido para esta escola' });
      }
      professorIdFinal = professorValido[0].id;
    }

    await queryAsync(`UPDATE turmas SET professor_responsavel_id = ?, updated_at = NOW() WHERE id = ? AND school_id = ?`, [professorIdFinal, turmaId, schoolId]);
    await registrarAuditoria(req, {
      acao: 'turma_professor_responsavel_alterado', entidadeTipo: 'turma', entidadeId: turmaId,
      dadosAntigos: { professor_responsavel_id: turmaRows[0].professor_responsavel_id },
      dadosNovos: { professor_responsavel_id: professorIdFinal },
    });

    res.json({ success: true, message: 'Professor responsável da turma atualizado com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao associar professor responsável à turma:', err);
    res.status(500).json({ success: false, message: 'Erro ao associar professor responsável', error: err.message });
  }
};

export const updateTurmaCapacity = (req, res) => {
  const { schoolId, turmaId } = req.params;
  const { capacidade_maxima } = req.body;

  if (!capacidade_maxima || parseInt(capacidade_maxima) <= 0) {
    return res.status(400).json({ success: false, message: 'Capacidade máxima deve ser um número maior que zero' });
  }

  const query = `
    UPDATE turmas
    SET capacidade_maxima = ?, updated_at = NOW()
    WHERE id = ? AND school_id = ?
  `;

  db.query(query, [parseInt(capacidade_maxima), turmaId, schoolId], (err, result) => {
    if (err) {
      console.error('[v0] Erro ao atualizar capacidade da turma:', err);
      return res.status(500).json({ success: false, message: 'Erro ao atualizar turma', error: err.message });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Turma não encontrada' });
    }

    registrarAuditoria(req, {
      acao: 'turma_capacidade_alterada', entidadeTipo: 'turma', entidadeId: turmaId,
      dadosNovos: { capacidade_maxima: parseInt(capacidade_maxima) },
    });

    res.json({ success: true, message: 'Capacidade da turma atualizada com sucesso' });
  });
};

// NOVO: associar (ou remover) a sala de uma turma
export const updateTurmaSala = (req, res) => {
  const { schoolId, turmaId } = req.params;
  const { sala_id } = req.body; // pode ser null para "desassociar"

  const aplicarUpdate = () => {
    const query = `
      UPDATE turmas
      SET sala_id = ?, updated_at = NOW()
      WHERE id = ? AND school_id = ?
    `;

    db.query(query, [sala_id || null, turmaId, schoolId], (err, result) => {
      if (err) {
        console.error('[v0] Erro ao associar sala à turma:', err);
        return res.status(500).json({ success: false, message: 'Erro ao associar sala', error: err.message });
      }

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, message: 'Turma não encontrada' });
      }

      registrarAuditoria(req, {
        acao: 'turma_sala_alterada', entidadeTipo: 'turma', entidadeId: turmaId,
        dadosNovos: { sala_id: sala_id || null },
      });

      res.json({ success: true, message: 'Sala associada à turma com sucesso' });
    });
  };

  if (!sala_id) {
    // desassociando: não precisa validar
    return aplicarUpdate();
  }

  // valida se a sala pertence à mesma escola antes de associar
  db.query('SELECT id FROM salas WHERE id = ? AND school_id = ? AND ativa = TRUE', [sala_id, schoolId], (err, rows) => {
    if (err) {
      console.error('[v0] Erro ao validar sala:', err);
      return res.status(500).json({ success: false, message: 'Erro ao validar sala', error: err.message });
    }
    if (rows.length === 0) {
      return res.status(400).json({ success: false, message: 'Sala inválida para esta escola' });
    }
    aplicarUpdate();
  });
};