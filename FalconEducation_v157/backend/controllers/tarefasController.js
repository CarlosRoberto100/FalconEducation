import db from '../config/db.js';
import { confirmarProfessorLecionaTurma } from './professorPortalController.js';

const queryAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.query(sql, params, (err, results) => {
    if (err) return reject(err);
    resolve(results);
  });
});

const memoize = (fn) => {
  let done = false;
  let inflight = null;
  return async (...args) => {
    if (done) return;
    if (!inflight) inflight = fn(...args).then(() => { done = true; });
    return inflight;
  };
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TRABALHOS DE CASA / TAREFAS — v111
 * ─────────────────────────────────────────────────────────────────────────────
 * Pedido: "professor publica, aluno vê no portal e marca como entregue".
 *
 * Deliberadamente simples — não é um sistema de submissão de ficheiros, é um
 * quadro de tarefas: o professor publica título + descrição + prazo para uma
 * turma (opcionalmente ligada a uma disciplina que ele dá nela), e cada aluno
 * dessa turma marca "entregue" quando cumprir (um checkbox, não um upload).
 * Reaproveita `confirmarProfessorLecionaTurma` (já usado para notas/presença)
 * para o professor só conseguir publicar em turmas onde dá mesmo aula.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

export const ensureTabelas = memoize(async () => {
  await queryAsync(`
    CREATE TABLE IF NOT EXISTS tarefas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL,
      teacher_id INT NOT NULL,
      turma_id INT NOT NULL,
      disciplina_id INT NULL,
      titulo VARCHAR(200) NOT NULL,
      descricao TEXT NULL,
      data_entrega DATE NULL,
      ativa TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_school_turma (school_id, turma_id),
      KEY idx_teacher (teacher_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await queryAsync(`
    CREATE TABLE IF NOT EXISTS tarefas_entregas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tarefa_id INT NOT NULL,
      student_id INT NOT NULL,
      entregue_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_entrega (tarefa_id, student_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
});

// ─── LADO DO PROFESSOR ──────────────────────────────────────────────────────

// GET /api/professor/me/turmas-tarefas — turmas/disciplinas que este
// professor pode escolher ao publicar uma tarefa (deriva do horário, igual
// à mesma fonte de verdade usada para notas/presença).
export const getMinhasTurmasParaTarefas = async (req, res) => {
  try {
    const teacherId = req.user.id;
    const schoolId = req.user.school_id;

    const linhas = await queryAsync(
      `SELECT DISTINCT h.turma_id, t.nome as turma_nome, h.disciplina_id, d.nome as disciplina_nome
       FROM horarios h
       JOIN turmas t ON t.id = h.turma_id
       JOIN disciplinas d ON d.id = h.disciplina_id
       WHERE h.school_id = ? AND h.teacher_id = ? AND h.ativo = 1
       ORDER BY t.nome ASC, d.nome ASC`,
      [schoolId, teacherId]
    );

    const porTurma = {};
    linhas.forEach((l) => {
      if (!porTurma[l.turma_id]) porTurma[l.turma_id] = { turma_id: l.turma_id, turma_nome: l.turma_nome, disciplinas: [] };
      porTurma[l.turma_id].disciplinas.push({ id: l.disciplina_id, nome: l.disciplina_nome });
    });

    res.json({ success: true, data: Object.values(porTurma) });
  } catch (err) {
    console.error('[v0] Erro ao buscar turmas do professor para tarefas:', err);
    res.status(500).json({ success: false, message: 'Erro ao buscar turmas', error: err.message });
  }
};

// POST /api/professor/me/turmas/:turmaId/tarefas
export const criarTarefa = async (req, res) => {
  try {
    await ensureTabelas();
    const teacherId = req.user.id;
    const schoolId = req.user.school_id;
    const { turmaId } = req.params;
    const { disciplina_id, titulo, descricao, data_entrega } = req.body;

    if (!titulo?.trim()) {
      return res.status(400).json({ success: false, message: 'O título da tarefa é obrigatório' });
    }

    const lecionaTurma = await confirmarProfessorLecionaTurma(schoolId, teacherId, turmaId, disciplina_id || null);
    if (!lecionaTurma) {
      return res.status(403).json({ success: false, message: 'Não é professor desta turma/disciplina.' });
    }

    const inserida = await queryAsync(
      `INSERT INTO tarefas (school_id, teacher_id, turma_id, disciplina_id, titulo, descricao, data_entrega, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [schoolId, teacherId, turmaId, disciplina_id || null, titulo.trim(), descricao?.trim() || null, data_entrega || null]
    );
    res.status(201).json({ success: true, message: 'Tarefa publicada com sucesso', id: inserida.insertId });
  } catch (err) {
    console.error('[v0] Erro ao criar tarefa:', err);
    res.status(500).json({ success: false, message: 'Erro ao criar tarefa', error: err.message });
  }
};

// GET /api/professor/me/tarefas — todas as tarefas publicadas por este
// professor, com contagem de entregas por tarefa.
export const getMinhasTarefasProfessor = async (req, res) => {
  try {
    await ensureTabelas();
    const teacherId = req.user.id;
    const schoolId = req.user.school_id;

    const tarefas = await queryAsync(
      `SELECT tf.*, t.nome as turma_nome, d.nome as disciplina_nome,
              (SELECT COUNT(*) FROM students s WHERE s.school_id = tf.school_id AND s.turma_id = tf.turma_id AND s.ativo = 1) as total_alunos,
              (SELECT COUNT(*) FROM tarefas_entregas te WHERE te.tarefa_id = tf.id) as total_entregas
       FROM tarefas tf
       LEFT JOIN turmas t ON t.id = tf.turma_id
       LEFT JOIN disciplinas d ON d.id = tf.disciplina_id
       WHERE tf.school_id = ? AND tf.teacher_id = ? AND tf.ativa = 1
       ORDER BY tf.created_at DESC LIMIT 100`,
      [schoolId, teacherId]
    );

    res.json({ success: true, data: tarefas });
  } catch (err) {
    console.error('[v0] Erro ao listar tarefas do professor:', err);
    res.status(500).json({ success: false, message: 'Erro ao listar tarefas', error: err.message });
  }
};

// GET /api/professor/me/tarefas/:tarefaId/entregas — detalhe de quem já
// entregou (e quem falta) — só o professor dono da tarefa.
export const getEntregasTarefa = async (req, res) => {
  try {
    await ensureTabelas();
    const teacherId = req.user.id;
    const schoolId = req.user.school_id;
    const { tarefaId } = req.params;

    const [tarefa] = await queryAsync(`SELECT * FROM tarefas WHERE id = ? AND school_id = ? AND teacher_id = ?`, [tarefaId, schoolId, teacherId]);
    if (!tarefa) return res.status(404).json({ success: false, message: 'Tarefa não encontrada' });

    const alunos = await queryAsync(
      `SELECT s.id, s.nome, (te.id IS NOT NULL) as entregue, te.entregue_em
       FROM students s
       LEFT JOIN tarefas_entregas te ON te.tarefa_id = ? AND te.student_id = s.id
       WHERE s.school_id = ? AND s.turma_id = ? AND s.ativo = 1
       ORDER BY entregue ASC, s.nome ASC`,
      [tarefaId, schoolId, tarefa.turma_id]
    );

    res.json({ success: true, tarefa, alunos });
  } catch (err) {
    console.error('[v0] Erro ao buscar entregas da tarefa:', err);
    res.status(500).json({ success: false, message: 'Erro ao buscar entregas', error: err.message });
  }
};

// DELETE /api/professor/me/tarefas/:tarefaId
export const excluirTarefa = async (req, res) => {
  try {
    await ensureTabelas();
    const teacherId = req.user.id;
    const schoolId = req.user.school_id;
    const { tarefaId } = req.params;
    const resultado = await queryAsync(`UPDATE tarefas SET ativa = 0 WHERE id = ? AND school_id = ? AND teacher_id = ?`, [tarefaId, schoolId, teacherId]);
    if (resultado.affectedRows === 0) return res.status(404).json({ success: false, message: 'Tarefa não encontrada' });
    res.json({ success: true, message: 'Tarefa removida' });
  } catch (err) {
    console.error('[v0] Erro ao remover tarefa:', err);
    res.status(500).json({ success: false, message: 'Erro ao remover tarefa', error: err.message });
  }
};

// ─── LADO DO ALUNO ──────────────────────────────────────────────────────────

// GET /api/aluno/me/tarefas
export const getMinhasTarefasAluno = async (req, res) => {
  try {
    await ensureTabelas();
    const studentId = req.user.id;
    const schoolId = req.user.school_id;

    const [alunoRow] = await queryAsync(`SELECT turma_id FROM students WHERE id = ? AND school_id = ?`, [studentId, schoolId]);
    const turmaId = alunoRow?.turma_id || null;
    if (!turmaId) return res.json({ success: true, data: [] });

    const tarefas = await queryAsync(
      `SELECT tf.id, tf.titulo, tf.descricao, tf.data_entrega, tf.created_at,
              d.nome as disciplina_nome, (te.id IS NOT NULL) as entregue, te.entregue_em
       FROM tarefas tf
       LEFT JOIN disciplinas d ON d.id = tf.disciplina_id
       LEFT JOIN tarefas_entregas te ON te.tarefa_id = tf.id AND te.student_id = ?
       WHERE tf.school_id = ? AND tf.turma_id = ? AND tf.ativa = 1
       ORDER BY (tf.data_entrega IS NULL), tf.data_entrega ASC, tf.created_at DESC`,
      [studentId, schoolId, turmaId]
    );

    res.json({ success: true, data: tarefas, pendentes: tarefas.filter((t) => !t.entregue).length });
  } catch (err) {
    console.error('[v0] Erro ao buscar tarefas do aluno:', err);
    res.status(500).json({ success: false, message: 'Erro ao buscar tarefas', error: err.message });
  }
};

// PUT /api/aluno/me/tarefas/:tarefaId/entregar
export const marcarTarefaEntregue = async (req, res) => {
  try {
    await ensureTabelas();
    const studentId = req.user.id;
    const schoolId = req.user.school_id;
    const { tarefaId } = req.params;

    const [tarefa] = await queryAsync(
      `SELECT tf.id FROM tarefas tf JOIN students s ON s.turma_id = tf.turma_id
       WHERE tf.id = ? AND tf.school_id = ? AND s.id = ? AND s.school_id = ?`,
      [tarefaId, schoolId, studentId, schoolId]
    );
    if (!tarefa) return res.status(404).json({ success: false, message: 'Tarefa não encontrada para o seu aluno/turma.' });

    await queryAsync(
      `INSERT INTO tarefas_entregas (tarefa_id, student_id, entregue_em) VALUES (?, ?, NOW())
       ON DUPLICATE KEY UPDATE entregue_em = entregue_em`,
      [tarefaId, studentId]
    );
    res.json({ success: true, message: 'Tarefa marcada como entregue' });
  } catch (err) {
    console.error('[v0] Erro ao marcar tarefa como entregue:', err);
    res.status(500).json({ success: false, message: 'Erro ao marcar tarefa como entregue', error: err.message });
  }
};

// PUT /api/aluno/me/tarefas/:tarefaId/desfazer — corrige um clique acidental
export const desfazerEntregaTarefa = async (req, res) => {
  try {
    await ensureTabelas();
    const studentId = req.user.id;
    const { tarefaId } = req.params;
    await queryAsync(`DELETE FROM tarefas_entregas WHERE tarefa_id = ? AND student_id = ?`, [tarefaId, studentId]);
    res.json({ success: true });
  } catch (err) {
    console.error('[v0] Erro ao desfazer entrega da tarefa:', err);
    res.status(500).json({ success: false, message: 'Erro ao desfazer entrega', error: err.message });
  }
};
