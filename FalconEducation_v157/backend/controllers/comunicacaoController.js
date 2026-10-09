import db from '../config/db.js';
import { enviarTextoWhatsapp, whatsappConfigurado, normalizarTelefoneMz } from '../services/whatsappService.js';
import { getFaltasMaxPPF } from './gradeController.js';
import { aplicarMultasPorAtraso } from './mensalidades.controller.js';

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
 * CENTRAL DE COMUNICAÇÃO — v109
 * ─────────────────────────────────────────────────────────────────────────────
 * Pedido: "começar a comunicação com os alunos/encarregados, colocar uma área
 * de comunicação na área do administrador com várias funcionalidades".
 *
 * Reaproveita a integração WhatsApp Business Cloud API já existente
 * (services/whatsappService.js, usada até agora só para enviar os PDFs
 * automáticos de matrícula/renovação/pagamento — ver
 * notificacaoRelatorioService.js) para permitir ao admin enviar mensagens de
 * texto livres, em massa ou individuais, a segmentos de alunos/encarregados:
 *
 *   - Toda a escola
 *   - Uma turma específica
 *   - Alunos devedores (mensalidade/taxa em atraso)
 *   - Alunos em risco de exclusão por faltas (PPF)
 *   - Alunos escolhidos manualmente (individual)
 *
 * Funcionalidades:
 *   - Modelos de mensagem reutilizáveis (mensagens_modelos)
 *   - Placeholders {aluno}, {turma}, {escola} substituídos por aluno
 *   - Pré-visualização de destinatários antes de enviar (nunca envia às
 *     escuras)
 *   - Histórico de comunicados enviados, com detalhe por destinatário
 *     (comunicados_massa + reaproveita whatsapp_notificacoes_log, tipo
 *     'comunicado', para aparecer também no mesmo local que already lista os
 *     envios automáticos, em Configurações)
 *   - Cada envio também fica registado em student_comunicacoes (Perfil 360 do
 *     aluno, aba Comunicação), para ficar visível também ali — v107 (perfil
 *     360) e este envio em massa passam a partilhar o mesmo histórico.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

const SEGMENTOS_VALIDOS = ['toda_escola', 'turma', 'devedores', 'faltas_risco', 'individual'];
const PAPEIS_VALIDOS = ['financeiro', 'principal', 'todos'];

export const ensureTabelas = memoize(async () => {
  await queryAsync(`
    CREATE TABLE IF NOT EXISTS mensagens_modelos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL,
      nome VARCHAR(100) NOT NULL,
      corpo TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_school (school_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await queryAsync(`
    CREATE TABLE IF NOT EXISTS comunicados_massa (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL,
      segmento VARCHAR(20) NOT NULL,
      turma_id INT NULL,
      papel_destinatario VARCHAR(20) NOT NULL DEFAULT 'todos',
      mensagem TEXT NOT NULL,
      total_alunos INT NOT NULL DEFAULT 0,
      total_destinatarios INT NOT NULL DEFAULT 0,
      total_enviados INT NOT NULL DEFAULT 0,
      total_falhas INT NOT NULL DEFAULT 0,
      total_ignorados INT NOT NULL DEFAULT 0,
      enviado_por VARCHAR(150) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_school_created (school_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Tabela de log já criada por notificacaoRelatorioService.js — mas este
  // controller pode ser o primeiro a correr numa instalação nova (se o admin
  // for direto à Comunicação sem nunca ter registado um pagamento), por isso
  // garante-a aqui também, de forma idempotente.
  await queryAsync(`
    CREATE TABLE IF NOT EXISTS whatsapp_notificacoes_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL,
      student_id INT NOT NULL,
      guardian_id INT NULL,
      guardian_nome VARCHAR(150) NULL,
      telefone VARCHAR(30) NULL,
      tipo VARCHAR(20) NOT NULL,
      referencia_id INT NULL,
      numero_documento VARCHAR(30) NULL,
      status VARCHAR(20) NOT NULL,
      motivo VARCHAR(255) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_school_student (school_id, student_id),
      KEY idx_school_created (school_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Idem para student_comunicacoes (normalmente criada por
  // alunoComunicacaoController.js).
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

  const colunasGuardians = ['principal', 'responsavel_financeiro'];
  for (const coluna of colunasGuardians) {
    if (!(await columnExists('guardians', coluna))) {
      await queryAsync(`ALTER TABLE guardians ADD COLUMN ${coluna} TINYINT(1) NOT NULL DEFAULT 0`);
    }
  }
});

// ─── MODELOS DE MENSAGEM ─────────────────────────────────────────────────

export const listarModelosMensagem = async (req, res) => {
  try {
    await ensureTabelas();
    const { schoolId } = req.params;
    const modelos = await queryAsync(`SELECT * FROM mensagens_modelos WHERE school_id = ? ORDER BY nome ASC`, [schoolId]);
    res.json({ success: true, data: modelos });
  } catch (err) {
    console.error('[v0] Erro ao listar modelos de mensagem:', err);
    res.status(500).json({ success: false, message: 'Erro ao listar modelos de mensagem', error: err.message });
  }
};

export const criarModeloMensagem = async (req, res) => {
  try {
    await ensureTabelas();
    const { schoolId } = req.params;
    const { nome, corpo } = req.body;
    if (!nome?.trim() || !corpo?.trim()) {
      return res.status(400).json({ success: false, message: 'Nome e corpo da mensagem são obrigatórios' });
    }
    const inserido = await queryAsync(
      `INSERT INTO mensagens_modelos (school_id, nome, corpo, created_at) VALUES (?, ?, ?, NOW())`,
      [schoolId, nome.trim(), corpo.trim()]
    );
    res.status(201).json({ success: true, message: 'Modelo guardado com sucesso', id: inserido.insertId });
  } catch (err) {
    console.error('[v0] Erro ao criar modelo de mensagem:', err);
    res.status(500).json({ success: false, message: 'Erro ao criar modelo de mensagem', error: err.message });
  }
};

export const excluirModeloMensagem = async (req, res) => {
  try {
    await ensureTabelas();
    const { schoolId, modeloId } = req.params;
    const resultado = await queryAsync(`DELETE FROM mensagens_modelos WHERE id = ? AND school_id = ?`, [modeloId, schoolId]);
    if (resultado.affectedRows === 0) return res.status(404).json({ success: false, message: 'Modelo não encontrado' });
    res.json({ success: true, message: 'Modelo removido com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao remover modelo de mensagem:', err);
    res.status(500).json({ success: false, message: 'Erro ao remover modelo de mensagem', error: err.message });
  }
};

// ─── RESOLUÇÃO DE SEGMENTOS (alunos-alvo de um envio) ─────────────────────

/**
 * Devolve a lista de alunos (id, nome, turma_nome) para o segmento pedido.
 * Nunca inclui alunos inativos.
 */
const resolverAlunosDoSegmento = async (schoolId, segmento, { turmaId, studentIds } = {}) => {
  if (segmento === 'toda_escola') {
    return queryAsync(
      `SELECT s.id, s.nome, t.nome AS turma_nome FROM students s
       LEFT JOIN turmas t ON s.turma_id = t.id
       WHERE s.school_id = ? AND s.ativo = 1 ORDER BY s.nome ASC`,
      [schoolId]
    );
  }

  if (segmento === 'turma') {
    if (!turmaId) return [];
    return queryAsync(
      `SELECT s.id, s.nome, t.nome AS turma_nome FROM students s
       LEFT JOIN turmas t ON s.turma_id = t.id
       WHERE s.school_id = ? AND s.turma_id = ? AND s.ativo = 1 ORDER BY s.nome ASC`,
      [schoolId, turmaId]
    );
  }

  if (segmento === 'devedores') {
    // v132 — este segmento é apresentado ao admin como "Alunos com
    // mensalidade/taxa em atraso" (ver SEGMENTOS_UI no frontend), mas a
    // query somava também status = 'pendente' — ou seja, incluía alunos que
    // simplesmente ainda não pagaram a mensalidade deste mês MESMO ANTES do
    // vencimento, que não estão atrasados. Enviar "está atrasado" a quem
    // ainda nem venceu é a própria falha que este pedido veio corrigir.
    // aplicarMultasPorAtraso() primeiro garante que o `status` já reflete
    // qualquer cobrança que tenha acabado de vencer hoje (mesmo antes do
    // cron diário correr — ver v131), para a lista abaixo não ficar
    // desatualizada por um problema de sincronização diferente.
    try {
      await aplicarMultasPorAtraso(schoolId);
    } catch (erroMultas) {
      console.error('[v0] Aviso: falha ao garantir multas em atraso antes do segmento de devedores:', erroMultas.message);
    }
    return queryAsync(
      `SELECT s.id, s.nome, t.nome AS turma_nome
       FROM students s
       LEFT JOIN turmas t ON s.turma_id = t.id
       LEFT JOIN student_payments sp ON s.id = sp.student_id AND s.school_id = sp.school_id
       WHERE s.school_id = ? AND s.ativo = 1
       GROUP BY s.id, s.nome, t.nome
       HAVING COALESCE(SUM(CASE WHEN sp.status = 'atrasado' THEN sp.valor_original + sp.multa ELSE 0 END), 0) > 0
       ORDER BY s.nome ASC`,
      [schoolId]
    );
  }

  if (segmento === 'faltas_risco') {
    const faltasMaxPPF = await getFaltasMaxPPF(schoolId);
    const limiarAlerta = Math.ceil(faltasMaxPPF * 0.8);
    const alunos = await queryAsync(
      `SELECT s.id, s.nome, t.nome AS turma_nome,
              COALESCE(SUM(CASE WHEN p.status = 'falta' THEN 1 ELSE 0 END), 0) AS total_faltas
       FROM students s
       LEFT JOIN turmas t ON s.turma_id = t.id
       LEFT JOIN presencas p ON p.student_id = s.id AND p.school_id = s.school_id
       WHERE s.school_id = ? AND s.ativo = 1
       GROUP BY s.id, s.nome, t.nome
       HAVING total_faltas >= ?
       ORDER BY total_faltas DESC`,
      [schoolId, limiarAlerta]
    );
    return alunos;
  }

  if (segmento === 'individual') {
    if (!Array.isArray(studentIds) || studentIds.length === 0) return [];
    return queryAsync(
      `SELECT s.id, s.nome, t.nome AS turma_nome FROM students s
       LEFT JOIN turmas t ON s.turma_id = t.id
       WHERE s.school_id = ? AND s.ativo = 1 AND s.id IN (?) ORDER BY s.nome ASC`,
      [schoolId, studentIds]
    );
  }

  return [];
};

/**
 * Escolhe os encarregados de um aluno a notificar, conforme o papel pedido:
 *  - 'financeiro' → só responsáveis financeiros com telefone
 *  - 'principal'  → só o(s) encarregado(s) principal(is) com telefone
 *  - 'todos'      → todos os encarregados com telefone (padrão, recomendado
 *    para comunicados gerais — diferente do envio de recibos, que prefere o
 *    responsável financeiro)
 * Se o papel escolhido não tiver ninguém com telefone, cai para "todos com
 * telefone" — nunca deixa de notificar por falta de papéis configurados.
 */
const escolherDestinatariosComunicado = (encarregados, papel) => {
  const comTelefone = encarregados.filter((e) => e.telefone);
  if (comTelefone.length === 0) return [];
  if (papel === 'financeiro') {
    const financeiros = comTelefone.filter((e) => e.responsavel_financeiro);
    if (financeiros.length > 0) return financeiros;
  }
  if (papel === 'principal') {
    const principais = comTelefone.filter((e) => e.principal);
    if (principais.length > 0) return principais;
  }
  return comTelefone;
};

const substituirPlaceholders = (mensagem, { alunoNome, turmaNome, escolaNome }) =>
  mensagem
    .replaceAll('{aluno}', alunoNome || '')
    .replaceAll('{turma}', turmaNome || '')
    .replaceAll('{escola}', escolaNome || '');

// POST /schools/:schoolId/comunicacao/preview
// Devolve quantos alunos/destinatários um segmento atinge, SEM enviar nada —
// para o admin confirmar antes de disparar um envio em massa.
export const previewDestinatariosComunicado = async (req, res) => {
  try {
    await ensureTabelas();
    const { schoolId } = req.params;
    const { segmento, turma_id, student_ids, papel_destinatario } = req.body;

    if (!SEGMENTOS_VALIDOS.includes(segmento)) {
      return res.status(400).json({ success: false, message: 'Segmento inválido' });
    }
    const papel = PAPEIS_VALIDOS.includes(papel_destinatario) ? papel_destinatario : 'todos';

    const alunos = await resolverAlunosDoSegmento(schoolId, segmento, { turmaId: turma_id, studentIds: student_ids });
    if (alunos.length === 0) {
      return res.json({ success: true, total_alunos: 0, total_destinatarios: 0, exemplos: [] });
    }

    const ids = alunos.map((a) => a.id);
    const encarregadosPorAluno = await queryAsync(
      `SELECT student_id, id, nome, telefone, principal, responsavel_financeiro FROM guardians WHERE student_id IN (?)`,
      [ids]
    );

    let totalDestinatarios = 0;
    let totalSemContacto = 0;
    const exemplos = [];
    for (const aluno of alunos) {
      const encarregados = encarregadosPorAluno.filter((e) => e.student_id === aluno.id);
      const destinatarios = escolherDestinatariosComunicado(encarregados, papel);
      totalDestinatarios += destinatarios.length;
      if (destinatarios.length === 0) totalSemContacto += 1;
      if (exemplos.length < 5 && destinatarios.length > 0) {
        exemplos.push({ aluno: aluno.nome, turma: aluno.turma_nome, encarregados: destinatarios.map((d) => d.nome) });
      }
    }

    res.json({
      success: true,
      total_alunos: alunos.length,
      total_destinatarios: totalDestinatarios,
      total_sem_contacto: totalSemContacto,
      exemplos,
      whatsapp_configurado: whatsappConfigurado(),
    });
  } catch (err) {
    console.error('[v0] Erro ao pré-visualizar destinatários:', err);
    res.status(500).json({ success: false, message: 'Erro ao pré-visualizar destinatários', error: err.message });
  }
};

// POST /schools/:schoolId/comunicacao/enviar
export const enviarComunicado = async (req, res) => {
  try {
    await ensureTabelas();
    const { schoolId } = req.params;
    const { segmento, turma_id, student_ids, papel_destinatario, mensagem } = req.body;

    if (!SEGMENTOS_VALIDOS.includes(segmento)) {
      return res.status(400).json({ success: false, message: 'Segmento inválido' });
    }
    if (!mensagem?.trim()) {
      return res.status(400).json({ success: false, message: 'A mensagem não pode estar vazia' });
    }
    if (segmento === 'turma' && !turma_id) {
      return res.status(400).json({ success: false, message: 'Escolha uma turma' });
    }
    if (segmento === 'individual' && (!Array.isArray(student_ids) || student_ids.length === 0)) {
      return res.status(400).json({ success: false, message: 'Escolha pelo menos um aluno' });
    }

    const papel = PAPEIS_VALIDOS.includes(papel_destinatario) ? papel_destinatario : 'todos';

    const [escola] = await queryAsync(`SELECT name FROM schools WHERE id = ?`, [schoolId]);
    const escolaNome = escola?.name || '';

    const alunos = await resolverAlunosDoSegmento(schoolId, segmento, { turmaId: turma_id, studentIds: student_ids });

    const comunicadoInserido = await queryAsync(
      `INSERT INTO comunicados_massa (school_id, segmento, turma_id, papel_destinatario, mensagem, total_alunos, enviado_por, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [schoolId, segmento, segmento === 'turma' ? turma_id : null, papel, mensagem.trim(), alunos.length, req.user?.nome || req.user?.email || null]
    );
    const comunicadoId = comunicadoInserido.insertId;

    if (alunos.length === 0) {
      await queryAsync(`UPDATE comunicados_massa SET total_destinatarios = 0 WHERE id = ?`, [comunicadoId]);
      return res.json({ success: true, id: comunicadoId, total_alunos: 0, total_destinatarios: 0, total_enviados: 0, total_falhas: 0, total_ignorados: 0, whatsapp_configurado: whatsappConfigurado() });
    }

    const ids = alunos.map((a) => a.id);
    const encarregadosPorAluno = await queryAsync(
      `SELECT student_id, id, nome, telefone, principal, responsavel_financeiro FROM guardians WHERE student_id IN (?)`,
      [ids]
    );

    let totalDestinatarios = 0, totalEnviados = 0, totalFalhas = 0, totalIgnorados = 0;
    const configurado = whatsappConfigurado();

    for (const aluno of alunos) {
      const encarregados = encarregadosPorAluno.filter((e) => e.student_id === aluno.id);
      const destinatarios = escolherDestinatariosComunicado(encarregados, papel);
      const textoFinal = substituirPlaceholders(mensagem.trim(), { alunoNome: aluno.nome, turmaNome: aluno.turma_nome, escolaNome });

      if (destinatarios.length === 0) continue;

      for (const encarregado of destinatarios) {
        totalDestinatarios += 1;
        let status, motivo = null;
        if (!configurado) {
          status = 'ignorado';
          motivo = 'WhatsApp não configurado';
          totalIgnorados += 1;
        } else {
          const resultado = await enviarTextoWhatsapp({ telefone: encarregado.telefone, texto: textoFinal });
          status = resultado.success ? 'enviado' : 'falhou';
          motivo = resultado.success ? null : resultado.motivo;
          if (resultado.success) totalEnviados += 1; else totalFalhas += 1;
        }

        await queryAsync(
          `INSERT INTO whatsapp_notificacoes_log
             (school_id, student_id, guardian_id, guardian_nome, telefone, tipo, referencia_id, status, motivo, created_at)
           VALUES (?, ?, ?, ?, ?, 'comunicado', ?, ?, ?, NOW())`,
          [schoolId, aluno.id, encarregado.id, encarregado.nome, encarregado.telefone, comunicadoId, status, motivo]
        ).catch((e) => console.error('[v0] Aviso: falha ao registar log do comunicado:', e.message));
      }

      // Também fica visível no histórico de comunicação do próprio aluno
      // (Perfil 360 → aba Comunicação), com uma única entrada por aluno
      // (não uma por encarregado) para não poluir esse histórico.
      await queryAsync(
        `INSERT INTO student_comunicacoes (school_id, student_id, tipo, titulo, mensagem, destinatario, enviado_por, created_at)
         VALUES (?, ?, 'whatsapp', ?, ?, ?, ?, NOW())`,
        [
          schoolId, aluno.id, 'Comunicado enviado por WhatsApp', textoFinal,
          destinatarios.map((d) => d.nome).join(', '),
          req.user?.nome || req.user?.email || null,
        ]
      ).catch((e) => console.error('[v0] Aviso: falha ao registar comunicação do aluno:', e.message));
    }

    await queryAsync(
      `UPDATE comunicados_massa SET total_destinatarios = ?, total_enviados = ?, total_falhas = ?, total_ignorados = ? WHERE id = ?`,
      [totalDestinatarios, totalEnviados, totalFalhas, totalIgnorados, comunicadoId]
    );

    res.json({
      success: true,
      id: comunicadoId,
      total_alunos: alunos.length,
      total_destinatarios: totalDestinatarios,
      total_enviados: totalEnviados,
      total_falhas: totalFalhas,
      total_ignorados: totalIgnorados,
      whatsapp_configurado: configurado,
    });
  } catch (err) {
    console.error('[v0] Erro ao enviar comunicado:', err);
    res.status(500).json({ success: false, message: 'Erro ao enviar comunicado', error: err.message });
  }
};

// GET /schools/:schoolId/comunicacao/enviados
export const listarComunicadosEnviados = async (req, res) => {
  try {
    await ensureTabelas();
    const { schoolId } = req.params;
    const limite = Math.min(parseInt(req.query.limite, 10) || 30, 100);
    const comunicados = await queryAsync(
      `SELECT c.*, t.nome AS turma_nome FROM comunicados_massa c
       LEFT JOIN turmas t ON c.turma_id = t.id
       WHERE c.school_id = ? ORDER BY c.id DESC LIMIT ?`,
      [schoolId, limite]
    );
    res.json({ success: true, data: comunicados });
  } catch (err) {
    console.error('[v0] Erro ao listar comunicados enviados:', err);
    res.status(500).json({ success: false, message: 'Erro ao listar comunicados enviados', error: err.message });
  }
};

// GET /schools/:schoolId/comunicacao/enviados/:comunicadoId
export const getDetalheComunicado = async (req, res) => {
  try {
    await ensureTabelas();
    const { schoolId, comunicadoId } = req.params;
    const [comunicado] = await queryAsync(
      `SELECT c.*, t.nome AS turma_nome FROM comunicados_massa c
       LEFT JOIN turmas t ON c.turma_id = t.id
       WHERE c.id = ? AND c.school_id = ?`,
      [comunicadoId, schoolId]
    );
    if (!comunicado) return res.status(404).json({ success: false, message: 'Comunicado não encontrado' });

    const destinatarios = await queryAsync(
      `SELECT l.*, s.nome AS aluno_nome FROM whatsapp_notificacoes_log l
       LEFT JOIN students s ON s.id = l.student_id
       WHERE l.school_id = ? AND l.tipo = 'comunicado' AND l.referencia_id = ?
       ORDER BY l.id ASC`,
      [schoolId, comunicadoId]
    );

    res.json({ success: true, comunicado, destinatarios });
  } catch (err) {
    console.error('[v0] Erro ao obter detalhe do comunicado:', err);
    res.status(500).json({ success: false, message: 'Erro ao obter detalhe do comunicado', error: err.message });
  }
};

// GET /schools/:schoolId/comunicacao/status — reaproveita o mesmo status
// já usado por notificacaoRelatorioService.js (configurado ou não).
export const getStatusComunicacao = (req, res) => {
  res.json({ success: true, configurado: whatsappConfigurado() });
};
