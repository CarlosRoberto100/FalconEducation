/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * RENOVAÇÃO DE MATRÍCULA — camada HTTP fina
 * ─────────────────────────────────────────────────────────────────────────────
 * v55: a lógica de decisão (cooldown, ronda, elegibilidade, sugestão de
 * progressão) foi movida para services/enrollmentStatusService.js — o
 * "serviço central de situação de matrícula e renovação" pedido na auditoria.
 * Este ficheiro reexporta os helpers (para não quebrar studentController.js e
 * outros imports existentes) e mantém só os handlers Express + as tarefas
 * agendadas (cron).
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import db from '../config/db.js';
import { criarNotificacao } from './notificationController.js';
import {
  PERIODICIDADES_VALIDAS,
  POLITICAS_VAI_EXAME,
  ensureRenewalWindowColumnsExist,
  getRenewalSettings,
  saveVaiExamePolicy,
  verificarJanelaRenovacaoAberta,
  verificarCooldownRenovacao,
  calcularRondaRenovacao,
  getSituacaoMatriculaAluno,
  calcularElegibilidadeAluno,
  sugerirProgressao,
} from '../services/enrollmentStatusService.js';
import { getEnrollmentFeeConfig, saveEnrollmentFeeValor } from '../services/financialStatusService.js';

// Reexportados para compatibilidade com studentController.js e demais imports.
export { verificarCooldownRenovacao, calcularRondaRenovacao, calcularElegibilidadeAluno, sugerirProgressao };

const queryAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.query(sql, params, (err, results) => {
    if (err) return reject(err);
    resolve(results);
  });
});

const MESES_POR_PERIODICIDADE = { Trimestral: 3, Semestral: 6, Anual: 12 };

/**
 * GET: Configuração completa de renovação (periodicidade + taxa por classe + janela de datas)
 */
export const getRenewalConfig = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const janela = await verificarJanelaRenovacaoAberta(schoolId);

    // `janela_aberta` mantém o significado histórico (está dentro do período
    // exato configurado) — usado pelo frontend para o indicador visual. O
    // BLOQUEIO real no backend (ver studentController.performRenewEnrollment)
    // só acontece quando a janela ainda não abriu (`ainda_nao_abriu`); depois
    // do fim, a renovação continua possível, mas com multa (ver `ja_fechou`).
    const janelaAbertaExata = !janela.ainda_nao_abriu && !janela.ja_fechou;

    const taxas = await queryAsync(
      `
        SELECT c.id as classe_id, c.nome as classe_nome, COALESCE(rf.valor, 0) as valor
        FROM classes c
        LEFT JOIN renewal_fees rf ON rf.classe_id = c.id AND rf.school_id = ?
        WHERE c.school_id = ? AND c.ativa = TRUE
        ORDER BY c.nome ASC
      `,
      [schoolId, schoolId]
    );

    // `configurado` distingue "a escola já definiu isto explicitamente" de
    // "está a usar o padrão silencioso (Anual, sempre aberta)" — usado pelo
    // frontend para mostrar um aviso de configuração pendente em vez de
    // deixar o admin a pensar que já está tudo definido.
    const settingsRows = await queryAsync(`SELECT id, politica_vai_exame FROM renewal_settings WHERE school_id = ? LIMIT 1`, [schoolId]);
    const totalClassesSemTaxa = taxas.filter((t) => !t.valor || Number(t.valor) <= 0).length;

    // v77 — taxas de inscrição (cobrança de entrada, distinta da renovação),
    // devolvidas junto para o admin configurar as duas taxas no mesmo ecrã.
    const taxasInscricao = await getEnrollmentFeeConfig(schoolId);
    const totalClassesSemTaxaInscricao = taxasInscricao.filter((t) => !t.valor || Number(t.valor) <= 0).length;

    res.json({
      success: true,
      data: {
        periodicidade: janela.periodicidade,
        data_inicio: janela.data_inicio,
        data_fim: janela.data_fim,
        janela_aberta: janelaAbertaExata,
        ainda_nao_abriu: janela.ainda_nao_abriu,
        ja_fechou: janela.ja_fechou,
        renovacao_bloqueada: janela.ainda_nao_abriu,
        configurado: settingsRows.length > 0,
        classes_sem_taxa: totalClassesSemTaxa,
        taxas,
        politica_vai_exame: settingsRows.length > 0 ? (settingsRows[0].politica_vai_exame || 'repete') : 'repete',
        taxas_inscricao: taxasInscricao,
        classes_sem_taxa_inscricao: totalClassesSemTaxaInscricao,
      },
    });
  } catch (err) {
    console.error('[v0] Erro ao buscar configuração de renovação:', err);
    if (err.code === 'ER_NO_SUCH_TABLE') {
      return res.json({ success: true, data: { periodicidade: 'Anual', data_inicio: null, data_fim: null, janela_aberta: true, ainda_nao_abriu: false, ja_fechou: false, configurado: false, classes_sem_taxa: 0, taxas: [], politica_vai_exame: 'repete', taxas_inscricao: [], classes_sem_taxa_inscricao: 0 } });
    }
    res.status(500).json({ success: false, message: 'Erro ao buscar configuração de renovação', error: err.message });
  }
};

/**
 * POST/PUT: Salvar taxa de INSCRIÇÃO (cobrança de entrada, uma vez por
 * aluno) de uma classe específica — irmã de saveRenewalFee, mas para
 * enrollment_fees em vez de renewal_fees.
 */
export const saveEnrollmentFee = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const { classe_id, valor } = req.body;

    if (!classe_id) {
      return res.status(400).json({ success: false, message: 'Classe é obrigatória' });
    }
    const valorNumerico = parseFloat(valor);
    if (isNaN(valorNumerico) || valorNumerico < 0) {
      return res.status(400).json({ success: false, message: 'Valor da taxa inválido' });
    }

    const classeRows = await queryAsync(`SELECT id FROM classes WHERE id = ? AND school_id = ? LIMIT 1`, [classe_id, schoolId]);
    if (classeRows.length === 0) {
      return res.status(400).json({ success: false, message: 'Classe inválida para esta escola' });
    }

    await saveEnrollmentFeeValor(schoolId, classe_id, valorNumerico);

    res.json({ success: true, message: 'Taxa de inscrição atualizada com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao salvar taxa de inscrição:', err);
    res.status(500).json({ success: false, message: 'Erro ao salvar taxa de inscrição', error: err.message });
  }
};

/**
 * POST/PUT: Salvar a política de "Vai a Exame" na renovação final —
 * 'repete' (padrão, repete já a classe) ou 'pendente' (aguarda a nota do
 * exame, decisão fica manual até lá).
 */
export const saveRenewalVaiExamePolicy = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const { politica } = req.body;
    await saveVaiExamePolicy(schoolId, politica);
    res.json({ success: true, message: 'Política de "Vai a Exame" atualizada com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao salvar política de "Vai a Exame":', err);
    res.status(err.status || 500).json({ success: false, message: err.status ? err.message : 'Erro ao salvar política', error: err.message });
  }
};

/**
 * POST/PUT: Salvar periodicidade da renovação (Trimestral, Semestral ou Anual)
 */
export const saveRenewalPeriodicidade = async (req, res) => {
  try {
    await ensureRenewalWindowColumnsExist();
    const { schoolId } = req.params;
    const { periodicidade } = req.body;

    if (!PERIODICIDADES_VALIDAS.includes(periodicidade)) {
      return res.status(400).json({ success: false, message: `Periodicidade inválida. Use: ${PERIODICIDADES_VALIDAS.join(', ')}` });
    }

    await queryAsync(
      `
        INSERT INTO renewal_settings (school_id, periodicidade, created_at, updated_at)
        VALUES (?, ?, NOW(), NOW())
        ON DUPLICATE KEY UPDATE periodicidade = VALUES(periodicidade), updated_at = NOW()
      `,
      [schoolId, periodicidade]
    );

    res.json({ success: true, message: 'Periodicidade de renovação atualizada com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao salvar periodicidade de renovação:', err);
    res.status(500).json({ success: false, message: 'Erro ao salvar periodicidade', error: err.message });
  }
};

/**
 * PUT: Salvar a janela (período) em que a renovação de matrícula fica aberta.
 * Body: { data_inicio: 'YYYY-MM-DD', data_fim: 'YYYY-MM-DD' } — ambos vazios/nulos = sempre aberta
 */
export const saveRenewalWindow = async (req, res) => {
  try {
    await ensureRenewalWindowColumnsExist();
    const { schoolId } = req.params;
    let { data_inicio, data_fim } = req.body;

    data_inicio = data_inicio || null;
    data_fim = data_fim || null;

    if (data_inicio && data_fim && new Date(data_inicio) > new Date(data_fim)) {
      return res.status(400).json({ success: false, message: 'A data de início não pode ser depois da data de fim' });
    }

    await queryAsync(
      `
        INSERT INTO renewal_settings (school_id, periodicidade, data_inicio, data_fim, created_at, updated_at)
        VALUES (?, 'Anual', ?, ?, NOW(), NOW())
        ON DUPLICATE KEY UPDATE data_inicio = VALUES(data_inicio), data_fim = VALUES(data_fim), updated_at = NOW()
      `,
      [schoolId, data_inicio, data_fim]
    );

    res.json({ success: true, message: 'Período de renovação atualizado com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao salvar período de renovação:', err);
    res.status(500).json({ success: false, message: 'Erro ao salvar período de renovação', error: err.message });
  }
};

/**
 * POST/PUT: Salvar taxa de renovação de uma classe específica
 */
export const saveRenewalFee = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const { classe_id, valor } = req.body;

    if (!classe_id) {
      return res.status(400).json({ success: false, message: 'Classe é obrigatória' });
    }
    const valorNumerico = parseFloat(valor);
    if (isNaN(valorNumerico) || valorNumerico < 0) {
      return res.status(400).json({ success: false, message: 'Valor da taxa inválido' });
    }

    const classeRows = await queryAsync(`SELECT id FROM classes WHERE id = ? AND school_id = ? LIMIT 1`, [classe_id, schoolId]);
    if (classeRows.length === 0) {
      return res.status(400).json({ success: false, message: 'Classe inválida para esta escola' });
    }

    await queryAsync(
      `
        INSERT INTO renewal_fees (school_id, classe_id, valor, created_at, updated_at)
        VALUES (?, ?, ?, NOW(), NOW())
        ON DUPLICATE KEY UPDATE valor = VALUES(valor), updated_at = NOW()
      `,
      [schoolId, classe_id, valorNumerico]
    );

    res.json({ success: true, message: 'Taxa de renovação atualizada com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao salvar taxa de renovação:', err);
    res.status(500).json({ success: false, message: 'Erro ao salvar taxa de renovação', error: err.message });
  }
};

/**
 * GET /schools/:schoolId/students/:studentId/renewal-suggestion
 */
export const getRenewalSuggestion = async (req, res) => {
  try {
    const { schoolId, studentId } = req.params;
    const alunoRows = await queryAsync(`SELECT id FROM students WHERE id = ? AND school_id = ? LIMIT 1`, [studentId, schoolId]);
    if (alunoRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Aluno não encontrado' });
    }
    const sugestao = await sugerirProgressao(schoolId, studentId);
    res.json({ success: true, data: sugestao });
  } catch (err) {
    console.error('[v0] Erro ao sugerir progressão de classe:', err);
    res.status(err.status || 500).json({ success: false, message: err.status ? err.message : 'Erro ao sugerir progressão de classe', error: err.message });
  }
};

/**
 * GET /schools/:schoolId/students/:studentId/renewal-eligibility
 */
export const getRenewalEligibility = async (req, res) => {
  try {
    const { schoolId, studentId } = req.params;
    const alunoRows = await queryAsync(`SELECT id FROM students WHERE id = ? AND school_id = ? LIMIT 1`, [studentId, schoolId]);
    if (alunoRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Aluno não encontrado' });
    }
    const elegibilidade = await getSituacaoMatriculaAluno(schoolId, studentId);
    res.json({ success: true, data: elegibilidade });
  } catch (err) {
    console.error('[v0] Erro ao calcular elegibilidade de renovação:', err);
    res.status(500).json({ success: false, message: 'Erro ao calcular elegibilidade de renovação', error: err.message });
  }
};

/**
 * GET /schools/:schoolId/renewal-progress
 * Painel gerencial: para cada turma, quantos alunos já renovaram a matrícula
 * dentro da janela de renovação atual e quantos ainda faltam.
 */
export const getRenewalProgress = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const { periodicidade, data_inicio: dataInicio, data_fim: dataFim } = await getRenewalSettings(schoolId);
    const meses = MESES_POR_PERIODICIDADE[periodicidade] || 12;

    const turmasProgresso = await queryAsync(
      `
        SELECT
          t.id as turma_id, t.nome as turma_nome, c.nome as classe_nome,
          COUNT(s.id) as total_alunos,
          SUM(CASE WHEN COALESCE(eh.ultima_renovacao, s.data_inscricao) >= DATE_SUB(CURDATE(), INTERVAL ? MONTH) THEN 1 ELSE 0 END) as renovados
        FROM turmas t
        LEFT JOIN classes c ON c.id = t.class_id
        LEFT JOIN students s ON s.turma_id = t.id AND s.ativo = 1
        LEFT JOIN (
          SELECT student_id, MAX(created_at) as ultima_renovacao
          FROM enrollment_history WHERE school_id = ?
          GROUP BY student_id
        ) eh ON eh.student_id = s.id
        WHERE t.school_id = ?
        GROUP BY t.id, t.nome, c.nome
        ORDER BY c.nome ASC, t.nome ASC
      `,
      [meses, schoolId, schoolId]
    );

    const data = turmasProgresso.map((t) => {
      const total = Number(t.total_alunos) || 0;
      const renovados = Number(t.renovados) || 0;
      return {
        turma_id: t.turma_id,
        turma_nome: t.turma_nome,
        classe_nome: t.classe_nome,
        total_alunos: total,
        renovados,
        pendentes: Math.max(total - renovados, 0),
        percentual: total > 0 ? Math.round((renovados / total) * 100) : 0,
      };
    });

    const totais = data.reduce(
      (acc, t) => ({ total_alunos: acc.total_alunos + t.total_alunos, renovados: acc.renovados + t.renovados }),
      { total_alunos: 0, renovados: 0 }
    );

    res.json({
      success: true,
      data: {
        janela: { data_inicio: dataInicio, data_fim: dataFim, periodicidade, meses },
        totais: {
          ...totais,
          pendentes: Math.max(totais.total_alunos - totais.renovados, 0),
          percentual: totais.total_alunos > 0 ? Math.round((totais.renovados / totais.total_alunos) * 100) : 0,
        },
        turmas: data,
      },
    });
  } catch (err) {
    console.error('[v0] Erro ao calcular progresso de renovação:', err);
    res.status(500).json({ success: false, message: 'Erro ao calcular progresso de renovação', error: err.message });
  }
};

/**
 * POST /schools/:schoolId/students/bulk/renew-enrollment/preview
 * Pré-visualização da renovação em massa: para cada aluno selecionado, mostra
 * a situação académica, a elegibilidade e a turma de destino (fixa ou sugerida
 * automaticamente), SEM efetuar nenhuma alteração. O admin revê e só depois confirma.
 */
export const getBulkRenewalPreview = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const { studentIds, turmaIdNova } = req.body;

    if (!Array.isArray(studentIds) || studentIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Selecione pelo menos um aluno' });
    }

    let turmaFixa = null;
    if (turmaIdNova) {
      const turmaRows = await queryAsync(`SELECT id, nome FROM turmas WHERE id = ? AND school_id = ? LIMIT 1`, [turmaIdNova, schoolId]);
      if (turmaRows.length === 0) {
        return res.status(400).json({ success: false, message: 'Turma de destino inválida' });
      }
      turmaFixa = turmaRows[0];
    }

    const preview = [];
    for (const studentId of studentIds) {
      try {
        const alunoRows = await queryAsync(
          `SELECT s.id, s.nome, s.codigo_aluno, t.nome as turma_atual_nome FROM students s LEFT JOIN turmas t ON t.id = s.turma_id WHERE s.id = ? AND s.school_id = ? LIMIT 1`,
          [studentId, schoolId]
        );
        if (alunoRows.length === 0) {
          preview.push({ student_id: studentId, nome: `Aluno #${studentId}`, bloqueado: true, motivo_bloqueio: 'Aluno não encontrado' });
          continue;
        }
        const aluno = alunoRows[0];
        const elegibilidade = await getSituacaoMatriculaAluno(schoolId, studentId);

        // Sugestão calculada SEMPRE (mesmo com turma fixa) — só assim dá para
        // comparar a turma fixa com o que a regra de progressão diria para
        // este aluno em concreto, e sinalizar a divergência ANTES de confirmar.
        const sugestao = await sugerirProgressao(schoolId, studentId);

        let turmaDestino = turmaFixa;
        let motivoBloqueio = null;
        let divergeDaRegra = false;
        if (!turmaFixa) {
          turmaDestino = sugestao.turma_sugerida ? { id: sugestao.turma_sugerida.id, nome: sugestao.turma_sugerida.nome } : null;
          if (!turmaDestino) motivoBloqueio = sugestao.motivo;
        } else if (sugestao.decisao_automatica && sugestao.classe_sugerida) {
          // v77 — RENOVAÇÃO EM MASSA COM TURMA FIXA: antes, o backend só
          // detetava a divergência (e bloqueava) na hora de CONFIRMAR — o
          // admin só descobria depois de já ter tentado. Agora a pré-
          // visualização já mostra, aluno a aluno, quando a turma fixa
          // escolhida contraria a regra de progressão desse aluno.
          const turmaFixaRows = await queryAsync(`SELECT class_id FROM turmas WHERE id = ? AND school_id = ?`, [turmaFixa.id, schoolId]);
          divergeDaRegra = turmaFixaRows.length > 0 && Number(turmaFixaRows[0].class_id) !== Number(sugestao.classe_sugerida.id);
        }

        const bloqueadoPorJanela = !elegibilidade.janela?.aberta;
        const bloqueadoPorCooldown = elegibilidade.cooldown?.bloqueado;
        const bloqueadoPorRondasCompletas = elegibilidade.ronda?.ja_completou_rondas_do_ano;
        preview.push({
          student_id: aluno.id,
          nome: aluno.nome,
          codigo_aluno: aluno.codigo_aluno,
          turma_atual: aluno.turma_atual_nome,
          situacao_academica: elegibilidade.situacao_academica,
          elegibilidade_nivel: elegibilidade.nivel,
          motivos: elegibilidade.motivos,
          turma_destino: turmaDestino,
          turma_sugerida_pela_regra: sugestao.classe_sugerida ? { classe: sugestao.classe_sugerida.nome, repete: !!sugestao.repete_classe } : null,
          diverge_da_regra: divergeDaRegra,
          ronda: elegibilidade.ronda,
          bloqueado: !turmaDestino || !!bloqueadoPorJanela || !!bloqueadoPorCooldown || !!bloqueadoPorRondasCompletas || divergeDaRegra,
          motivo_bloqueio: bloqueadoPorJanela
            ? `A janela de renovação ainda não abriu (abre em ${elegibilidade.janela.data_inicio})`
            : bloqueadoPorRondasCompletas
              ? `Já completou as ${elegibilidade.ronda.rondas_por_ano} renovação(ões) previstas para o ano letivo de ${elegibilidade.ronda.ano_letivo}`
              : bloqueadoPorCooldown
                ? `Fora do prazo de renovação (poderá renovar a partir de ${elegibilidade.cooldown.proxima_data_permitida})`
                : divergeDaRegra
                  ? `A turma fixa escolhida para o lote contraria a regra de progressão deste aluno — deveria ${sugestao.repete_classe ? 'repetir' : 'progredir para'} "${sugestao.classe_sugerida.nome}". Desmarque-o do lote e renove-o individualmente (aí é possível forçar exceção com justificação).`
                  : motivoBloqueio,
        });
      } catch (erroIndividual) {
        preview.push({ student_id: studentId, nome: `Aluno #${studentId}`, bloqueado: true, motivo_bloqueio: erroIndividual.message });
      }
    }

    res.json({ success: true, data: preview });
  } catch (err) {
    console.error('[v0] Erro ao pré-visualizar renovação em massa:', err);
    res.status(500).json({ success: false, message: 'Erro ao pré-visualizar renovação em massa', error: err.message });
  }
};

/**
 * Tarefa agendada (cron, ver app.js): para cada escola, conta quantos alunos
 * ativos ainda NÃO renovaram a matrícula dentro do prazo estipulado pela
 * periodicidade configurada e, se houver algum, cria uma notificação com a
 * contagem — no máximo uma por dia por escola.
 */
export const notificarRenovacoesPendentes = async () => {
  try {
    await ensureRenewalWindowColumnsExist();
    const escolas = await queryAsync(`SELECT id FROM schools WHERE status = 'ativa' OR status IS NULL`);

    for (const escola of escolas) {
      const schoolId = escola.id;
      try {
        const { periodicidade } = await getRenewalSettings(schoolId);
        const meses = MESES_POR_PERIODICIDADE[periodicidade] || 12;

        const pendentesRows = await queryAsync(
          `
            SELECT COUNT(*) as total
            FROM students s
            LEFT JOIN (
              SELECT student_id, MAX(created_at) as ultima_renovacao
              FROM enrollment_history WHERE school_id = ?
              GROUP BY student_id
            ) eh ON eh.student_id = s.id
            WHERE s.school_id = ? AND s.ativo = 1
              AND COALESCE(eh.ultima_renovacao, s.data_inscricao) < DATE_SUB(CURDATE(), INTERVAL ? MONTH)
          `,
          [schoolId, schoolId, meses]
        );
        const totalPendentes = pendentesRows[0]?.total || 0;
        if (totalPendentes === 0) continue;

        let jaNotificadoHoje = [];
        try {
          jaNotificadoHoje = await queryAsync(
            `SELECT id FROM notifications WHERE school_id = ? AND type = 'renewal_pending_count' AND DATE(created_at) = CURDATE() LIMIT 1`,
            [schoolId]
          );
        } catch (e) {
          jaNotificadoHoje = [];
        }

        if (jaNotificadoHoje.length === 0) {
          await criarNotificacao(
            schoolId,
            'renewal_pending_count',
            'Alunos com matrícula por renovar',
            `${totalPendentes} aluno(s) ainda não renovaram a matrícula (periodicidade configurada: ${periodicidade}).`
          );
        }
      } catch (erroEscola) {
        console.error(`[v0] Erro ao contar renovações pendentes da escola ${schoolId}:`, erroEscola.message);
      }
    }
  } catch (err) {
    console.error('[v0] Erro ao notificar renovações pendentes:', err);
  }
};

/**
 * Tarefa agendada (cron, ver app.js): verifica, para cada escola com uma janela
 * de renovação configurada, se o prazo está a terminar (0 a 7 dias restantes) e,
 * nesse caso, cria uma notificação de lembrete — no máximo uma por dia por escola.
 */
export const checkRenewalReminders = async () => {
  try {
    await ensureRenewalWindowColumnsExist();
    const escolas = await queryAsync(`SELECT school_id, data_fim FROM renewal_settings WHERE data_fim IS NOT NULL`);

    for (const escola of escolas) {
      const dataFim = new Date(escola.data_fim);
      const hoje = new Date();
      const diasRestantes = Math.ceil((dataFim.setHours(0, 0, 0, 0) - hoje.setHours(0, 0, 0, 0)) / (1000 * 60 * 60 * 24));

      if (diasRestantes >= 0 && diasRestantes <= 7) {
        let jaNotificadoHoje = [];
        try {
          jaNotificadoHoje = await queryAsync(
            `SELECT id FROM notifications WHERE school_id = ? AND type = 'renewal_reminder' AND DATE(created_at) = CURDATE() LIMIT 1`,
            [escola.school_id]
          );
        } catch (e) {
          jaNotificadoHoje = [];
        }
        if (jaNotificadoHoje.length === 0) {
          await criarNotificacao(
            escola.school_id,
            'renewal_reminder',
            'Prazo de renovação de matrículas terminando',
            diasRestantes === 0
              ? 'O período de renovação de matrículas termina hoje.'
              : `Faltam ${diasRestantes} dia(s) para o fim do período de renovação de matrículas.`
          );
        }
      }
    }
  } catch (err) {
    console.error('[v0] Erro ao verificar lembretes de renovação:', err);
  }
};
