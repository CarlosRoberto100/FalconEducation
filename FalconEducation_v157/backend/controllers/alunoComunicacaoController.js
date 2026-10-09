import db from '../config/db.js';

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

// ═══════════════════════════════════════════════════════════════════════════════
// COMUNICAÇÃO COM O ALUNO/ENCARREGADO
// ─────────────────────────────────────────────────────────────────────────────
// Regista o histórico de contactos feitos com a família de um aluno (SMS,
// e-mail, chamada, reunião presencial, aviso escrito). Por agora é um registo
// manual feito pela secretaria/direção (não dispara SMS/e-mail reais) — serve
// como memória institucional de "o que já foi falado com esta família", e é a
// base pronta para, mais tarde, ligar a um envio automático (portal do
// encarregado, notificações por e-mail, etc.).
// ═══════════════════════════════════════════════════════════════════════════════
const TIPOS_VALIDOS = ['sms', 'email', 'chamada', 'reuniao', 'aviso', 'whatsapp', 'outro'];

export const ensureTabelaExists = memoize(async () => {
  await queryAsync(`
    CREATE TABLE IF NOT EXISTS student_comunicacoes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL,
      student_id INT NOT NULL,
      tipo VARCHAR(20) NOT NULL DEFAULT 'outro',
      titulo VARCHAR(150) NOT NULL,
      mensagem TEXT NULL,
      destinatario VARCHAR(150) NULL,
      enviado_por VARCHAR(150) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_school_student (school_id, student_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
});

// GET /schools/:schoolId/students/:studentId/comunicacoes
export const getComunicacoesAluno = async (req, res) => {
  try {
    await ensureTabelaExists();
    const { schoolId, studentId } = req.params;
    const comunicacoes = await queryAsync(
      `SELECT * FROM student_comunicacoes WHERE school_id = ? AND student_id = ? ORDER BY created_at DESC`,
      [schoolId, studentId]
    );
    res.json({ success: true, data: comunicacoes });
  } catch (err) {
    console.error('[v0] Erro ao listar comunicações do aluno:', err);
    res.status(500).json({ success: false, message: 'Erro ao listar comunicações do aluno', error: err.message });
  }
};

// POST /schools/:schoolId/students/:studentId/comunicacoes
export const registarComunicacaoAluno = async (req, res) => {
  try {
    await ensureTabelaExists();
    const { schoolId, studentId } = req.params;
    const { tipo, titulo, mensagem, destinatario } = req.body;

    if (!titulo?.trim()) return res.status(400).json({ success: false, message: 'O título/assunto é obrigatório' });
    const tipoFinal = TIPOS_VALIDOS.includes(tipo) ? tipo : 'outro';

    const inserida = await queryAsync(
      `INSERT INTO student_comunicacoes (school_id, student_id, tipo, titulo, mensagem, destinatario, enviado_por, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [schoolId, studentId, tipoFinal, titulo.trim(), mensagem || null, destinatario || null, req.user?.nome || req.user?.email || null]
    );
    res.status(201).json({ success: true, message: 'Comunicação registada com sucesso', id: inserida.insertId });
  } catch (err) {
    console.error('[v0] Erro ao registar comunicação do aluno:', err);
    res.status(500).json({ success: false, message: 'Erro ao registar comunicação do aluno', error: err.message });
  }
};

// DELETE /schools/:schoolId/comunicacoes/:comunicacaoId
export const deleteComunicacaoAluno = async (req, res) => {
  try {
    await ensureTabelaExists();
    const { schoolId, comunicacaoId } = req.params;
    const resultado = await queryAsync(`DELETE FROM student_comunicacoes WHERE id = ? AND school_id = ?`, [comunicacaoId, schoolId]);
    if (resultado.affectedRows === 0) return res.status(404).json({ success: false, message: 'Comunicação não encontrada' });
    res.json({ success: true, message: 'Comunicação removida com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao remover comunicação do aluno:', err);
    res.status(500).json({ success: false, message: 'Erro ao remover comunicação do aluno', error: err.message });
  }
};
