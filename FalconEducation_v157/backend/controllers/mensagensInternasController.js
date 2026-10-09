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

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * MENSAGENS INTERNAS DO SISTEMA — v110
 * ─────────────────────────────────────────────────────────────────────────────
 * Pedido: "o sistema deve permitir ao administrador enviar mensagens gerais
 * para todos alunos, professores, mensagens individuais tudo dentro do
 * sistema".
 *
 * Diferente da Central de Comunicação por WhatsApp (v109, aos encarregados,
 * saindo da plataforma) — isto é um canal interno: a mensagem fica guardada
 * e aparece dentro do próprio sistema, na Área do Aluno e na Área do
 * Professor (uma caixa de entrada simples, com lido/não-lido), sem depender
 * de nenhuma integração externa.
 *
 * Destinatários possíveis:
 *   - 'todos_alunos'   → todos os alunos ativos da escola
 *   - 'turma'          → alunos de uma turma específica
 *   - 'alunos_especificos' → um ou mais alunos escolhidos manualmente
 *   - 'todos_professores' → todos os professores ativos da escola
 *   - 'professores_especificos' → um ou mais professores escolhidos manualmente
 *
 * Modelo de dados: uma mensagem "em massa" (todos_alunos/turma/
 * todos_professores) fica numa única linha (o destinatário é resolvido
 * dinamicamente sempre que um aluno/professor consulta a sua caixa de
 * entrada). Uma mensagem "individual" gera uma linha por destinatário
 * escolhido — assim cada aluno/professor só vê o que lhe diz respeito, sem
 * ter de filtrar nada. `lote_id` agrupa todas as linhas de um mesmo envio,
 * para o histórico do admin mostrar "1 envio" mesmo quando isso gerou várias
 * linhas (ex.: 5 alunos escolhidos manualmente).
 * ═══════════════════════════════════════════════════════════════════════════════
 */

const TIPOS_DESTINATARIO_ENVIO = ['todos_alunos', 'turma', 'alunos_especificos', 'todos_professores', 'professores_especificos'];

export const ensureTabelas = memoize(async () => {
  await queryAsync(`
    CREATE TABLE IF NOT EXISTS mensagens_internas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL,
      lote_id BIGINT NOT NULL,
      destinatario_tipo VARCHAR(20) NOT NULL,
      turma_id INT NULL,
      destinatario_id INT NULL,
      total_alvo INT NULL,
      titulo VARCHAR(150) NOT NULL,
      mensagem TEXT NOT NULL,
      enviado_por VARCHAR(150) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_school_lote (school_id, lote_id),
      KEY idx_school_tipo_turma (school_id, destinatario_tipo, turma_id),
      KEY idx_school_tipo_destinatario (school_id, destinatario_tipo, destinatario_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await queryAsync(`
    CREATE TABLE IF NOT EXISTS mensagens_internas_lidas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      mensagem_id INT NOT NULL,
      tipo_leitor VARCHAR(20) NOT NULL,
      leitor_id INT NOT NULL,
      lida_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_leitura (mensagem_id, tipo_leitor, leitor_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
});

// ─── LADO DO ADMINISTRADOR ─────────────────────────────────────────────────

// POST /schools/:schoolId/comunicacao/mensagens-internas/enviar
export const enviarMensagemInterna = async (req, res) => {
  try {
    await ensureTabelas();
    const { schoolId } = req.params;
    const { destinatario_tipo, turma_id, aluno_ids, professor_ids, titulo, mensagem } = req.body;

    if (!TIPOS_DESTINATARIO_ENVIO.includes(destinatario_tipo)) {
      return res.status(400).json({ success: false, message: 'Tipo de destinatário inválido' });
    }
    if (!titulo?.trim() || !mensagem?.trim()) {
      return res.status(400).json({ success: false, message: 'Título e mensagem são obrigatórios' });
    }

    const enviadoPor = req.user?.nome || req.user?.email || null;
    const loteId = Date.now();

    if (destinatario_tipo === 'turma' && !turma_id) {
      return res.status(400).json({ success: false, message: 'Escolha uma turma' });
    }
    if (destinatario_tipo === 'alunos_especificos' && (!Array.isArray(aluno_ids) || aluno_ids.length === 0)) {
      return res.status(400).json({ success: false, message: 'Escolha pelo menos um aluno' });
    }
    if (destinatario_tipo === 'professores_especificos' && (!Array.isArray(professor_ids) || professor_ids.length === 0)) {
      return res.status(400).json({ success: false, message: 'Escolha pelo menos um professor' });
    }

    // Destinatários "em massa" (uma única linha; resolvida dinamicamente)
    if (['todos_alunos', 'turma', 'todos_professores'].includes(destinatario_tipo)) {
      let totalAlvo = 0;
      if (destinatario_tipo === 'todos_alunos') {
        const [r] = await queryAsync(`SELECT COUNT(*) as total FROM students WHERE school_id = ? AND ativo = 1`, [schoolId]);
        totalAlvo = r?.total || 0;
      } else if (destinatario_tipo === 'turma') {
        const [r] = await queryAsync(`SELECT COUNT(*) as total FROM students WHERE school_id = ? AND turma_id = ? AND ativo = 1`, [schoolId, turma_id]);
        totalAlvo = r?.total || 0;
      } else if (destinatario_tipo === 'todos_professores') {
        const [r] = await queryAsync(`SELECT COUNT(*) as total FROM teachers WHERE school_id = ? AND ativo = 1`, [schoolId]);
        totalAlvo = r?.total || 0;
      }

      const inserida = await queryAsync(
        `INSERT INTO mensagens_internas (school_id, lote_id, destinatario_tipo, turma_id, total_alvo, titulo, mensagem, enviado_por, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [schoolId, loteId, destinatario_tipo, destinatario_tipo === 'turma' ? turma_id : null, totalAlvo, titulo.trim(), mensagem.trim(), enviadoPor]
      );
      return res.status(201).json({ success: true, lote_id: loteId, id: inserida.insertId, total_destinatarios: totalAlvo });
    }

    // Destinatários individuais (uma linha por aluno/professor escolhido)
    const ehAluno = destinatario_tipo === 'alunos_especificos';
    const ids = ehAluno ? aluno_ids : professor_ids;
    const tipoLinha = ehAluno ? 'aluno' : 'professor';

    for (const id of ids) {
      await queryAsync(
        `INSERT INTO mensagens_internas (school_id, lote_id, destinatario_tipo, destinatario_id, titulo, mensagem, enviado_por, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
        [schoolId, loteId, tipoLinha, id, titulo.trim(), mensagem.trim(), enviadoPor]
      );
    }

    res.status(201).json({ success: true, lote_id: loteId, total_destinatarios: ids.length });
  } catch (err) {
    console.error('[v0] Erro ao enviar mensagem interna:', err);
    res.status(500).json({ success: false, message: 'Erro ao enviar mensagem interna', error: err.message });
  }
};

// GET /schools/:schoolId/comunicacao/mensagens-internas
export const listarMensagensInternasEnviadas = async (req, res) => {
  try {
    await ensureTabelas();
    const { schoolId } = req.params;
    const limite = Math.min(parseInt(req.query.limite, 10) || 30, 100);

    const lotes = await queryAsync(
      `SELECT lote_id, destinatario_tipo, turma_id, titulo, mensagem, enviado_por,
              MIN(created_at) as created_at, COUNT(*) as total_linhas, MAX(total_alvo) as total_alvo,
              GROUP_CONCAT(id) as ids
       FROM mensagens_internas WHERE school_id = ? GROUP BY lote_id ORDER BY MIN(created_at) DESC LIMIT ?`,
      [schoolId, limite]
    );

    const turmaIds = [...new Set(lotes.filter((l) => l.turma_id).map((l) => l.turma_id))];
    const turmasNomes = turmaIds.length > 0
      ? await queryAsync(`SELECT id, nome FROM turmas WHERE id IN (?)`, [turmaIds])
      : [];
    const nomeTurma = Object.fromEntries(turmasNomes.map((t) => [t.id, t.nome]));

    const data = await Promise.all(lotes.map(async (l) => {
      const ids = l.ids.split(',').map(Number);
      const [{ total: totalLidas } = { total: 0 }] = await queryAsync(
        `SELECT COUNT(*) as total FROM mensagens_internas_lidas WHERE mensagem_id IN (?)`,
        [ids]
      );
      const totalDestinatarios = ['aluno', 'professor'].includes(l.destinatario_tipo) ? l.total_linhas : (l.total_alvo || 0);
      return {
        lote_id: l.lote_id,
        destinatario_tipo: l.destinatario_tipo,
        turma_id: l.turma_id,
        turma_nome: l.turma_id ? nomeTurma[l.turma_id] : null,
        titulo: l.titulo,
        mensagem: l.mensagem,
        enviado_por: l.enviado_por,
        created_at: l.created_at,
        total_destinatarios: totalDestinatarios,
        total_lidas: totalLidas,
      };
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error('[v0] Erro ao listar mensagens internas enviadas:', err);
    res.status(500).json({ success: false, message: 'Erro ao listar mensagens internas enviadas', error: err.message });
  }
};

// ─── LADO DO ALUNO (Área do Aluno) ─────────────────────────────────────────

// GET /api/aluno/me/mensagens
export const getMinhasMensagensAluno = async (req, res) => {
  try {
    await ensureTabelas();
    const studentId = req.user.id;
    const schoolId = req.user.school_id;

    const [alunoRow] = await queryAsync(`SELECT turma_id FROM students WHERE id = ? AND school_id = ?`, [studentId, schoolId]);
    const turmaId = alunoRow?.turma_id || null;

    const mensagens = await queryAsync(
      `SELECT m.*, (l.id IS NOT NULL) as lida FROM mensagens_internas m
       LEFT JOIN mensagens_internas_lidas l ON l.mensagem_id = m.id AND l.tipo_leitor = 'aluno' AND l.leitor_id = ?
       WHERE m.school_id = ? AND (
         m.destinatario_tipo = 'todos_alunos'
         OR (m.destinatario_tipo = 'turma' AND m.turma_id = ?)
         OR (m.destinatario_tipo = 'aluno' AND m.destinatario_id = ?)
       )
       ORDER BY m.created_at DESC LIMIT 100`,
      [studentId, schoolId, turmaId, studentId]
    );

    res.json({ success: true, data: mensagens, nao_lidas: mensagens.filter((m) => !m.lida).length });
  } catch (err) {
    console.error('[v0] Erro ao carregar mensagens do aluno:', err);
    res.status(500).json({ success: false, message: 'Erro ao carregar mensagens', error: err.message });
  }
};

// PUT /api/aluno/me/mensagens/:mensagemId/lida
export const marcarMensagemLidaAluno = async (req, res) => {
  try {
    await ensureTabelas();
    const studentId = req.user.id;
    const { mensagemId } = req.params;
    await queryAsync(
      `INSERT INTO mensagens_internas_lidas (mensagem_id, tipo_leitor, leitor_id, lida_em) VALUES (?, 'aluno', ?, NOW())
       ON DUPLICATE KEY UPDATE lida_em = lida_em`,
      [mensagemId, studentId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[v0] Erro ao marcar mensagem como lida:', err);
    res.status(500).json({ success: false, message: 'Erro ao marcar mensagem como lida', error: err.message });
  }
};

// ─── LADO DO PROFESSOR (Área do Professor) ─────────────────────────────────

// GET /api/professor/me/mensagens
export const getMinhasMensagensProfessor = async (req, res) => {
  try {
    await ensureTabelas();
    const teacherId = req.user.id;
    const schoolId = req.user.school_id;

    const mensagens = await queryAsync(
      `SELECT m.*, (l.id IS NOT NULL) as lida FROM mensagens_internas m
       LEFT JOIN mensagens_internas_lidas l ON l.mensagem_id = m.id AND l.tipo_leitor = 'professor' AND l.leitor_id = ?
       WHERE m.school_id = ? AND (
         m.destinatario_tipo = 'todos_professores'
         OR (m.destinatario_tipo = 'professor' AND m.destinatario_id = ?)
       )
       ORDER BY m.created_at DESC LIMIT 100`,
      [teacherId, schoolId, teacherId]
    );

    res.json({ success: true, data: mensagens, nao_lidas: mensagens.filter((m) => !m.lida).length });
  } catch (err) {
    console.error('[v0] Erro ao carregar mensagens do professor:', err);
    res.status(500).json({ success: false, message: 'Erro ao carregar mensagens', error: err.message });
  }
};

// PUT /api/professor/me/mensagens/:mensagemId/lida
export const marcarMensagemLidaProfessor = async (req, res) => {
  try {
    await ensureTabelas();
    const teacherId = req.user.id;
    const { mensagemId } = req.params;
    await queryAsync(
      `INSERT INTO mensagens_internas_lidas (mensagem_id, tipo_leitor, leitor_id, lida_em) VALUES (?, 'professor', ?, NOW())
       ON DUPLICATE KEY UPDATE lida_em = lida_em`,
      [mensagemId, teacherId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[v0] Erro ao marcar mensagem como lida:', err);
    res.status(500).json({ success: false, message: 'Erro ao marcar mensagem como lida', error: err.message });
  }
};
