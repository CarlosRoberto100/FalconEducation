import db from '../config/db.js';
import bcrypt from 'bcrypt';
import { getOrCreateHorarioConfig, calcularSlotsDoDia } from './horarioController.js';
import { getSituacaoFinanceiraAluno } from '../services/financialStatusService.js';
import { aplicarMultasPorAtraso } from './mensalidades.controller.js';

const queryAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.query(sql, params, (err, results) => {
    if (err) return reject(err);
    resolve(results);
  });
});

const DIAS_SEMANA_PADRAO = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta'];

// ═══════════════════════════════════════════════════════════════════════════════
// ÁREA DO ALUNO — v82
// ─────────────────────────────────────────────────────────────────────────────
// Mesmo princípio da Área do Professor (v80/v81): todos os endpoints são
// "sobre mim", identificam sempre o aluno a partir de req.user.id (token),
// nunca de um :studentId na URL — impede, por construção, que um aluno
// consiga ver dados de outro.
//
// Boletim, faltas e biblioteca REAPROVEITAM os handlers já existentes do
// admin (getBoletimByStudent, getStudentAttendance, getMateriaisBiblioteca)
// em vez de duplicar a lógica — ver `comHandlerDeAdminAdaptado` abaixo. Esses
// handlers já leem só de req.params/req.query, não fazem nenhuma verificação
// de papel por conta própria (isso é feito pelo middleware da rota), por
// isso servem tal como estão desde que o adaptador force sempre os
// parâmetros certos a partir do token, nunca do que o cliente enviar.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Envolve um handler feito para o admin (que lê school_id/studentId de
 * req.params) e força esses parâmetros a virem sempre do token do aluno
 * autenticado — nunca de valores que o cliente possa enviar. Assim
 * reaproveitamos a lógica de negócio já testada sem abrir uma única fresta
 * de segurança.
 */
export const comHandlerDeAdminAdaptado = (handler) => (req, res) => {
  req.params.schoolId = String(req.user.school_id);
  req.params.studentId = String(req.user.id);
  return handler(req, res);
};

// GET /api/aluno/me/perfil
export const getMeuPerfil = async (req, res) => {
  try {
    const studentId = req.user.id;
    const schoolId = req.user.school_id;

    const rows = await queryAsync(
      `
        SELECT s.id, s.nome, s.email, s.telefone, s.genero, s.data_nascimento, s.codigo_aluno,
               s.morada, s.data_inscricao, s.ativo, s.turma_id,
               t.nome as turma_nome, c.nome as classe_nome
        FROM students s
        LEFT JOIN turmas t ON t.id = s.turma_id
        LEFT JOIN classes c ON c.id = t.class_id
        WHERE s.id = ? AND s.school_id = ? LIMIT 1
      `,
      [studentId, schoolId]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Aluno não encontrado' });
    const aluno = rows[0];

    let encarregados = [];
    try {
      encarregados = await queryAsync(
        `SELECT nome, parentesco, telefone, email FROM guardians WHERE student_id = ? ORDER BY principal DESC, nome ASC`,
        [studentId]
      );
    } catch (e) {
      // tabela pode não existir em instalações muito antigas — isso é um "0"
      // legítimo; qualquer outro erro sobe para o catch geral (500), em vez
      // de o aluno ver a lista de encarregados simplesmente vazia.
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
    }

    res.json({ success: true, data: { ...aluno, encarregados } });
  } catch (err) {
    console.error('[v0] Erro ao buscar perfil do aluno (portal):', err);
    res.status(500).json({ success: false, message: 'Erro ao buscar perfil', error: err.message });
  }
};

// GET /api/aluno/me/horario
// Ao contrário do professor (que dá aulas em várias turmas), o aluno só tem
// UMA turma — por isso aqui é o horário completo dessa turma, não um
// agregado de várias.
export const getMeuHorario = async (req, res) => {
  try {
    const studentId = req.user.id;
    const schoolId = req.user.school_id;

    const alunoRows = await queryAsync(`SELECT turma_id FROM students WHERE id = ? AND school_id = ? LIMIT 1`, [studentId, schoolId]);
    const turmaId = alunoRows[0]?.turma_id;
    if (!turmaId) {
      return res.json({ success: true, dias: DIAS_SEMANA_PADRAO, horario: {}, total_aulas: 0, aviso: 'Ainda não está atribuído a nenhuma turma.' });
    }

    const aulas = await queryAsync(
      `
        SELECT h.dia_semana, h.ordem, d.nome as disciplina_nome, tc.nome as professor_nome,
               tn.hora_inicio as turno_hora_inicio, tn.hora_fim as turno_hora_fim
        FROM horarios h
        JOIN disciplinas d ON d.id = h.disciplina_id
        LEFT JOIN teachers tc ON tc.id = h.teacher_id
        JOIN turmas t ON t.id = h.turma_id
        LEFT JOIN turnos tn ON tn.id = t.turno_id
        WHERE h.school_id = ? AND h.turma_id = ? AND h.ativo = 1
        ORDER BY h.dia_semana ASC, h.ordem ASC
      `,
      [schoolId, turmaId]
    );

    const config = await getOrCreateHorarioConfig(schoolId);
    const slotsPorTurno = new Map();
    const aulasComHorario = aulas.map((aula) => {
      const chaveTurno = `${aula.turno_hora_inicio}-${aula.turno_hora_fim}`;
      if (!slotsPorTurno.has(chaveTurno) && aula.turno_hora_inicio) {
        slotsPorTurno.set(chaveTurno, calcularSlotsDoDia(aula.turno_hora_inicio, aula.turno_hora_fim, config));
      }
      const slots = slotsPorTurno.get(chaveTurno) || [];
      const slot = slots[aula.ordem - 1];
      return {
        dia_semana: aula.dia_semana,
        disciplina: aula.disciplina_nome,
        professor: aula.professor_nome,
        hora_inicio: slot?.hora_inicio || null,
        hora_fim: slot?.hora_fim || null,
      };
    });

    const porDia = {};
    DIAS_SEMANA_PADRAO.forEach((dia) => { porDia[dia] = []; });
    aulasComHorario.forEach((aula) => {
      if (!porDia[aula.dia_semana]) porDia[aula.dia_semana] = [];
      porDia[aula.dia_semana].push(aula);
    });
    Object.keys(porDia).forEach((dia) => porDia[dia].sort((a, b) => (a.hora_inicio || '').localeCompare(b.hora_inicio || '')));

    res.json({ success: true, dias: DIAS_SEMANA_PADRAO, horario: porDia, total_aulas: aulasComHorario.length });
  } catch (err) {
    console.error('[v0] Erro ao buscar horário do aluno (portal):', err);
    res.status(500).json({ success: false, message: 'Erro ao buscar horário', error: err.message });
  }
};

// GET /api/aluno/me/mensalidades
// Resumo simplificado (não financeiro-administrativo) das cobranças do
// aluno: o que está pendente/vencido e o histórico de pagos. Deliberadamente
// não usa o financialStatusService completo (que é feito para a visão do
// admin, com estornos, multas detalhadas etc.) — aqui é só "o que devo, o
// que já paguei".
export const getMinhasMensalidades = async (req, res) => {
  try {
    const studentId = req.user.id;
    const schoolId = req.user.school_id;

    const cobrancas = await queryAsync(
      `
        SELECT sp.id, sp.valor_original, sp.multa, sp.valor_pago, sp.data_vencimento, sp.status,
               m.tipo, m.classe_nome
        FROM student_payments sp
        LEFT JOIN mensalidades m ON m.id = sp.mensalidade_id
        WHERE sp.school_id = ? AND sp.student_id = ? AND sp.estornado_em IS NULL
        ORDER BY sp.data_vencimento DESC
        LIMIT 100
      `,
      [schoolId, studentId]
    );

    const pendentes = cobrancas.filter((c) => c.status === 'pendente');
    const hoje = new Date().toISOString().split('T')[0];
    const vencidas = pendentes.filter((c) => c.data_vencimento && String(c.data_vencimento).split('T')[0] < hoje);

    res.json({
      success: true,
      data: cobrancas,
      resumo: {
        total_pendentes: pendentes.length,
        total_vencidas: vencidas.length,
        valor_pendente: pendentes.reduce((s, c) => s + parseFloat(c.valor_original || 0) + parseFloat(c.multa || 0), 0),
      },
    });
  } catch (err) {
    console.error('[v0] Erro ao buscar mensalidades do aluno (portal):', err);
    res.status(500).json({ success: false, message: 'Erro ao buscar mensalidades', error: err.message });
  }
};

/**
 * GET /api/aluno/me/boletim — v106
 * ─────────────────────────────────────────────────────────────────────────
 * Antes de mostrar as notas ao próprio aluno, verifica a situação financeira
 * (usando o MESMO serviço central que o admin usa — financialStatusService).
 * Aluno com mensalidades em atraso (não simplesmente pendente/a vencer, mas
 * realmente vencida e não paga) fica com o boletim bloqueado até regularizar
 * a situação na secretaria. Isto é deliberadamente restrito a este endpoint:
 * não afeta faltas, horário, biblioteca nem o próprio resumo de mensalidades
 * (o aluno continua a poder ver — e precisa de ver — o que deve).
 */
export const getMeuBoletimComVerificacaoFinanceira = (getBoletimByStudentHandler) => async (req, res) => {
  try {
    const studentId = req.user.id;
    const schoolId = req.user.school_id;

    // v131 — garante que a verificação abaixo já reflete uma cobrança que
    // tenha acabado de passar a estar em atraso hoje (mesmo antes do cron
    // diário correr) — ver aplicarMultasPorAtraso() em mensalidades.controller.js.
    try {
      await aplicarMultasPorAtraso(schoolId, studentId);
    } catch (erroMultas) {
      console.error('[v0] Aviso: falha ao garantir multas em atraso antes da verificação do boletim:', erroMultas.message);
    }

    const situacaoFinanceira = await getSituacaoFinanceiraAluno(schoolId, studentId);
    if (situacaoFinanceira.situacao === 'em_atraso') {
      return res.status(403).json({
        success: false,
        bloqueado_financeiro: true,
        message: 'As suas notas ficam indisponíveis enquanto houver mensalidades em atraso. Regularize a situação financeira na secretaria para voltar a consultar o boletim.',
        situacao_financeira: {
          situacao: situacaoFinanceira.situacao,
          total_atrasado: situacaoFinanceira.totalAtrasado,
          total_pendente: situacaoFinanceira.totalPendente,
          cobrancas_pendentes_ou_atrasadas: situacaoFinanceira.cobrancasPendentesOuAtrasadas,
        },
      });
    }

    req.params.schoolId = String(schoolId);
    req.params.studentId = String(studentId);
    return getBoletimByStudentHandler(req, res);
  } catch (err) {
    console.error('[v0] Erro ao verificar situação financeira antes do boletim (portal do aluno):', err);
    res.status(500).json({ success: false, message: 'Erro ao carregar boletim', error: err.message });
  }
};

// PUT /api/aluno/me/senha
export const alterarMinhaSenha = async (req, res) => {
  try {
    const studentId = req.user.id;
    const schoolId = req.user.school_id;
    const { senhaAtual, novaSenha } = req.body;

    if (!senhaAtual || !novaSenha) {
      return res.status(400).json({ success: false, message: 'Informe a senha atual e a nova senha' });
    }
    if (String(novaSenha).length < 6) {
      return res.status(400).json({ success: false, message: 'A nova senha deve ter no mínimo 6 caracteres' });
    }

    const rows = await queryAsync(`SELECT password FROM students WHERE id = ? AND school_id = ? LIMIT 1`, [studentId, schoolId]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Aluno não encontrado' });

    const senhaValida = await bcrypt.compare(senhaAtual, rows[0].password);
    if (!senhaValida) return res.status(401).json({ success: false, message: 'A senha atual está incorreta' });

    const novaHash = await bcrypt.hash(novaSenha, 10);
    await queryAsync(`UPDATE students SET password = ?, updated_at = NOW() WHERE id = ?`, [novaHash, studentId]);

    res.json({ success: true, message: 'Senha alterada com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao alterar senha (portal do aluno):', err);
    res.status(500).json({ success: false, message: 'Erro ao alterar senha', error: err.message });
  }
};

/**
 * GET /api/aluno/me/biblioteca
 * Reaproveita getMateriaisBiblioteca (bibliotecaController.js) filtrando
 * sempre pela classe atual do PRÓPRIO aluno — resolve a mesma coisa que o
 * cabeçalho da Biblioteca já dizia desde sempre ("materiais publicados para
 * os alunos") mas que, antes da v82, nenhum aluno conseguia mesmo ver.
 * Não é um simples `comHandlerDeAdminAdaptado` porque precisa de um passo
 * assíncrono extra (descobrir a classe do aluno) antes de delegar.
 */
export const getMinhaBiblioteca = (getMateriaisBibliotecaHandler) => async (req, res) => {
  try {
    const studentId = req.user.id;
    const schoolId = req.user.school_id;

    const rows = await queryAsync(
      `SELECT t.class_id FROM students s LEFT JOIN turmas t ON t.id = s.turma_id WHERE s.id = ? AND s.school_id = ? LIMIT 1`,
      [studentId, schoolId]
    );
    const classeId = rows[0]?.class_id || null;

    req.params.schoolId = String(schoolId);
    req.query.classe_id = classeId ? String(classeId) : undefined;

    return getMateriaisBibliotecaHandler(req, res);
  } catch (err) {
    console.error('[v0] Erro ao buscar biblioteca do aluno (portal):', err);
    res.status(500).json({ success: false, message: 'Erro ao buscar materiais da biblioteca', error: err.message });
  }
};

/**
 * GET /api/aluno/me/calendario — v111
 * Reaproveita getEventos (dashboardController.js), o mesmo motor que já
 * alimenta o Calendário Escolar do admin, filtrando sempre pela classe do
 * PRÓPRIO aluno (eventos gerais da escola — classe_id NULL — entram sempre;
 * eventos específicos de outra classe nunca aparecem). Mesmo padrão de
 * adaptador que getMinhaBiblioteca já usa.
 */
export const getMeuCalendario = (getEventosHandler) => async (req, res) => {
  try {
    const studentId = req.user.id;
    const schoolId = req.user.school_id;

    const rows = await queryAsync(
      `SELECT t.class_id FROM students s LEFT JOIN turmas t ON t.id = s.turma_id WHERE s.id = ? AND s.school_id = ? LIMIT 1`,
      [studentId, schoolId]
    );
    const classeId = rows[0]?.class_id || null;

    req.params.schoolId = String(schoolId);
    if (classeId) req.query.classe_id = String(classeId);

    return getEventosHandler(req, res);
  } catch (err) {
    console.error('[v0] Erro ao buscar calendário do aluno (portal):', err);
    res.status(500).json({ success: false, message: 'Erro ao buscar calendário', error: err.message });
  }
};
