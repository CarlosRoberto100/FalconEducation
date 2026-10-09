import db from "../config/db.js";
import { criarNotificacao } from './notificationController.js';
import { resolverAnoLetivoPorData } from '../services/academicYearService.js';
import {
  getSituacaoFinanceiraAluno,
  calcularResumoFinanceiroAluno,
  ensurePaymentColumnsExist,
  estornarPagamento,
} from '../services/financialStatusService.js';
import { notificarPagamentoMensalidade } from '../services/notificacaoRelatorioService.js';
import { registrarAuditoria } from '../services/auditService.js';

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
const queryAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.query(sql, params, (err, results) => {
    if (err) return reject(err);
    resolve(results);
  });
});

// A lógica de "situação financeira do aluno" agora vive no serviço central
// services/financialStatusService.js — reexportada aqui para não quebrar
// nenhum import existente (perfilAlunoController, situacaoEscolarController,
// e as rotas deste próprio controller).
export { calcularResumoFinanceiroAluno, ensurePaymentColumnsExist };

/**
 * Aplica a multa configurada (multas_config, tipo='mensalidade') e marca como
 * 'atrasado' qualquer cobrança 'pendente' cujo prazo (vencimento + dias de
 * tolerância) já tenha passado — para a escola inteira, ou só para um aluno
 * específico quando `studentId` é passado.
 *
 * v131 — extraído de dentro de executarRotinaFinanceiraDiaria (que só corria
 * uma vez por dia, às 6h) para poder ser chamado também, com `studentId`, no
 * exato momento de registerPayment(). Sem isto, uma cobrança que passasse a
 * estar em atraso HOJE (ou cujo atraso ainda não tivesse sido processado
 * pelo cron desse dia) era paga sem multa nenhuma se o pagamento fosse
 * registado antes do cron correr — a multa "existia" nas regras da escola,
 * mas nunca chegava a ser cobrada nesse caso.
 */
export const aplicarMultasPorAtraso = async (schoolId, studentId = null) => {
  await ensureMultasConfigColumnsExist();
  const configRows = await queryAsync(
    `SELECT percentual, valor_fixo, aplicar_tipo, dias_tolerancia FROM multas_config WHERE school_id = ? AND tipo = 'mensalidade' LIMIT 1`,
    [schoolId]
  );
  const config = configRows[0] || { percentual: 0, valor_fixo: 0, aplicar_tipo: 'percentual', dias_tolerancia: 0 };
  const diasTolerancia = config.dias_tolerancia ?? 0;

  const atrasados = await queryAsync(
    `SELECT id, valor_original FROM student_payments
     WHERE school_id = ? AND status = 'pendente' AND DATE_ADD(data_vencimento, INTERVAL ? DAY) < CURDATE()
       ${studentId ? 'AND student_id = ?' : ''}`,
    studentId ? [schoolId, diasTolerancia, studentId] : [schoolId, diasTolerancia]
  );

  for (const pagamento of atrasados) {
    const multaValor = config.aplicar_tipo === 'fixo'
      ? parseFloat(config.valor_fixo || 0)
      : parseFloat((parseFloat(pagamento.valor_original) * (parseFloat(config.percentual || 0) / 100)).toFixed(2));

    await queryAsync(
      `UPDATE student_payments SET status = 'atrasado', multa = ?, updated_at = NOW() WHERE id = ?`,
      [multaValor, pagamento.id]
    );
  }

  return atrasados.length;
};

export const getStudentFinancialSummary = async (req, res) => {
  try {
    const { schoolId, studentId } = req.params;
    const { academic_year_id } = req.query;
    // v131 — mesma garantia do registerPayment: sem isto, este resumo podia
    // mostrar "devido: valor_original" (sem multa) para uma cobrança já em
    // atraso que o cron ainda não tivesse processado hoje, e o operador
    // cobraria esse valor ao encarregado de educação — só para o pagamento
    // ser depois rejeitado por "valor insuficiente" (porque registerPayment,
    // ao correr a mesma verificação, já teria adicionado a multa entretanto).
    try {
      await aplicarMultasPorAtraso(schoolId, studentId);
    } catch (erroMultas) {
      console.error('[v0] Aviso: falha ao garantir multas em atraso antes do resumo financeiro:', erroMultas.message);
    }
    const resumo = await getSituacaoFinanceiraAluno(schoolId, studentId, { academicYearId: academic_year_id });
    res.json({ success: true, data: resumo });
  } catch (err) {
    console.error('[v0] Erro ao buscar situação financeira do aluno:', err);
    res.status(500).json({ success: false, message: 'Erro ao buscar situação financeira', error: err.message });
  }
};

/**
 * POST /schools/:schoolId/student-payments/:paymentId/estornar
 * Única forma permitida de "desfazer" uma cobrança já paga — ver
 * services/financialStatusService.js#estornarPagamento. Preserva o registo
 * original intacto (imutabilidade do histórico financeiro).
 */
export const estornarPagamentoAluno = async (req, res) => {
  try {
    const { schoolId, paymentId } = req.params;
    const { motivo, criarNovaCobrancaPendente } = req.body || {};
    const resultado = await estornarPagamento(schoolId, paymentId, {
      motivo,
      criarNovaCobrancaPendente: criarNovaCobrancaPendente !== false,
    });
    await registrarAuditoria(req, {
      acao: 'pagamento_estornado', entidadeTipo: 'payment', entidadeId: paymentId,
      dadosNovos: { motivo: motivo || 'Estorno sem motivo especificado', nova_cobranca_id: resultado.novaCobrancaId },
    });
    res.json({ success: true, message: 'Pagamento estornado com sucesso. O registo original foi preservado no histórico.', data: resultado });
  } catch (err) {
    console.error('[v0] Erro ao estornar pagamento:', err);
    res.status(err.status || 500).json({ success: false, message: err.status ? err.message : 'Erro ao estornar pagamento', error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// 1. GET - Obter mensalidades por escola
// ═══════════════════════════════════════════════════════════════════════════════
export const getMensalidadesBySchool = (req, res) => {
  const { schoolId } = req.params;
  // Filtra explicitamente tipo = 'Mensalidade': a tabela também guarda a "Taxa de
  // Renovação" (criada durante a renovação de matrícula, ver renewalController.js),
  // que é um valor DIFERENTE e configurado num sítio DIFERENTE (aba Renovações).
  // Sem este filtro, os dois valores ficariam misturados nesta lista.
  const query = `
    SELECT 
      id,
      school_id,
      turma_id,
      classe_numero,
      classe_nome,
      valor,
      frequencia,
      vencimento_dia,
      tipo,
      ativa,
      created_at,
      updated_at
    FROM mensalidades 
    WHERE school_id = ? AND tipo = 'Mensalidade'
    ORDER BY classe_numero ASC
  `;

  db.query(query, [schoolId], (error, results) => {
    if (error) {
      console.error('[v0] Erro GET Mensalidades:', error);
      return res.status(500).json({ message: 'Erro ao buscar mensalidades', error: error.message });
    }
    console.log(`[v0] ✅ Retornadas ${results.length} mensalidades da escola ${schoolId}`);
    res.status(200).json(results);
  });
};

// ═══════════════════════════════════════════════════════════════════════════════
// 2. POST - Criar/Atualizar mensalidade de uma turma ou classe
//    Casa preferencialmente por classe_nome (funciona com qualquer nome de classe,
//    não só "1ª Classe"), e por turma_id quando uma turma específica é informada.
// ═══════════════════════════════════════════════════════════════════════════════
export const saveMensalidade = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const { turmaId = null, classe, valor, frequencia = 'Mensal' } = req.body;
    // O dia de vencimento é uma regra FIXA do sistema — vence sempre no último
    // dia do mês (ver gerarCobrancasDoMesParaEscola) — por isso não é mais lido
    // do corpo do pedido. A coluna vencimento_dia é mantida só por compatibilidade
    // com o esquema da base de dados; gravamos 31 como valor convencional que
    // representa "fim do mês" para qualquer código legado que ainda a leia.
    const vencimentoDia = 31;

    if (!valor || valor <= 0) {
      return res.status(400).json({ message: 'Valor é obrigatório e deve ser maior que 0' });
    }
    if (!classe && !turmaId) {
      return res.status(400).json({ message: 'Classe ou Turma são obrigatórios' });
    }

    const classeNumero = classe ? (parseInt(classe.replace(/\D/g, ''), 10) || null) : null;
    const classeNome = classe || null;

    // IMPORTANTE: sempre filtrar por tipo = 'Mensalidade'. A mesma tabela também
    // guarda a "Taxa de Renovação" (criada pela aba Renovações, ver
    // renewalController.js/renewal_fees) — são valores diferentes, configurados em
    // sítios diferentes, e este filtro garante que nunca se misturam ou se sobrescrevem.
    let updateResult;
    if (turmaId) {
      updateResult = await queryAsync(
        `UPDATE mensalidades SET valor = ?, vencimento_dia = ?, frequencia = ?, classe_nome = ?, updated_at = NOW()
         WHERE school_id = ? AND turma_id = ? AND tipo = 'Mensalidade'`,
        [valor, vencimentoDia, frequencia, classeNome, schoolId, turmaId]
      );
    } else {
      updateResult = await queryAsync(
        `UPDATE mensalidades SET valor = ?, vencimento_dia = ?, frequencia = ?, classe_numero = ?, updated_at = NOW()
         WHERE school_id = ? AND turma_id IS NULL AND classe_nome = ? AND tipo = 'Mensalidade'`,
        [valor, vencimentoDia, frequencia, classeNumero, schoolId, classeNome]
      );
    }

    if (updateResult.affectedRows === 0) {
      const inserida = await queryAsync(
        `INSERT INTO mensalidades (school_id, turma_id, classe_numero, classe_nome, valor, vencimento_dia, frequencia, tipo, ativa, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'Mensalidade', TRUE, NOW(), NOW())`,
        [schoolId, turmaId || null, classeNumero, classeNome, valor, vencimentoDia, frequencia]
      );
      return res.status(201).json({
        message: 'Mensalidade criada com sucesso',
        id: inserida.insertId,
        data: { schoolId, turmaId, classe_numero: classeNumero, classe_nome: classeNome, valor, frequencia, vencimento_dia: vencimentoDia, tipo: 'Mensalidade', ativa: true },
      });
    }

    res.status(200).json({
      message: 'Mensalidade atualizada com sucesso',
      data: { schoolId, turmaId, classe_numero: classeNumero, classe_nome: classeNome, valor, frequencia, vencimento_dia: vencimentoDia, tipo: 'Mensalidade' },
    });
  } catch (error) {
    console.error('[v0] Erro ao salvar mensalidade:', error);
    res.status(500).json({ message: 'Erro ao salvar mensalidade', error: error.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// 3. GET - Obter configuração de multas (percentual/fixo + dias de tolerância)
// ═══════════════════════════════════════════════════════════════════════════════
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

export const ensureMultasConfigColumnsExist = memoize(async () => {
  const columnExists = async (column) => {
    const result = await queryAsync(`SHOW COLUMNS FROM multas_config LIKE ?`, [column]);
    return result.length > 0;
  };

  if (!(await columnExists('dias_tolerancia'))) {
    await queryAsync(`ALTER TABLE multas_config ADD COLUMN dias_tolerancia INT NOT NULL DEFAULT 0 AFTER aplicar_tipo`);
  }
});

// `ensurePaymentColumnsExist` (migração de student_payments) agora vive em
// services/financialStatusService.js e é reexportada no topo deste ficheiro.

export const getPenaltiesConfig = async (req, res) => {
  try {
    await ensureMultasConfigColumnsExist();
    const { schoolId } = req.params;
    const rows = await queryAsync(
      `SELECT * FROM multas_config WHERE school_id = ? AND tipo = 'mensalidade' LIMIT 1`,
      [schoolId]
    );
    const config = rows[0] || {};
    res.status(200).json({
      percentual: parseFloat(config.percentual || 0),
      valor_fixo: parseFloat(config.valor_fixo || 0),
      aplicar_tipo: config.aplicar_tipo || 'percentual',
      dias_tolerancia: config.dias_tolerancia ?? 0,
    });
  } catch (error) {
    console.error('[v0] Erro ao buscar configuração de multas:', error);
    res.status(500).json({ message: 'Erro ao buscar configuração de multas', error: error.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// 4. POST - Salvar configuração de multas
//    O administrador define: o tipo de cobrança (percentual do valor devido, ou
//    um valor fixo em MZN) e quantos dias de tolerância existem após o vencimento
//    antes de a multa ser aplicada automaticamente (0 = aplica no dia seguinte).
// ═══════════════════════════════════════════════════════════════════════════════
export const savePenaltyConfig = async (req, res) => {
  try {
    await ensureMultasConfigColumnsExist();
    const { schoolId } = req.params;
    const { percentual = 0, valor_fixo = 0, aplicar_tipo = 'percentual', dias_tolerancia = 0, tipo = 'mensalidade' } = req.body;

    const percentualNum = parseFloat(percentual) || 0;
    const valorFixoNum = parseFloat(valor_fixo) || 0;
    const diasToleranciaNum = parseInt(dias_tolerancia, 10) || 0;

    if (percentualNum < 0 || percentualNum > 100) {
      return res.status(400).json({ message: 'Percentual deve estar entre 0 e 100' });
    }
    if (valorFixoNum < 0) {
      return res.status(400).json({ message: 'Valor fixo inválido' });
    }
    if (diasToleranciaNum < 0 || diasToleranciaNum > 90) {
      return res.status(400).json({ message: 'Dias de tolerância devem estar entre 0 e 90' });
    }
    if (!['percentual', 'fixo'].includes(aplicar_tipo)) {
      return res.status(400).json({ message: 'Tipo de aplicação inválido (use "percentual" ou "fixo")' });
    }

    const resultado = await queryAsync(
      `UPDATE multas_config SET percentual = ?, valor_fixo = ?, aplicar_tipo = ?, dias_tolerancia = ?, ativa = TRUE, updated_at = NOW()
       WHERE school_id = ? AND tipo = ?`,
      [percentualNum, valorFixoNum, aplicar_tipo, diasToleranciaNum, schoolId, tipo]
    );

    if (resultado.affectedRows === 0) {
      const inserido = await queryAsync(
        `INSERT INTO multas_config (school_id, tipo, percentual, valor_fixo, aplicar_tipo, dias_tolerancia, ativa, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, TRUE, NOW(), NOW())`,
        [schoolId, tipo, percentualNum, valorFixoNum, aplicar_tipo, diasToleranciaNum]
      );
      return res.status(201).json({ message: 'Configuração de multas salva com sucesso', id: inserido.insertId });
    }

    res.status(200).json({ message: 'Configuração de multas atualizada com sucesso' });
  } catch (error) {
    console.error('[v0] Erro ao salvar configuração de multas:', error);
    res.status(500).json({ message: 'Erro ao salvar configuração de multas', error: error.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// 5. GET - Pesquisar aluno por nome ou código (com valor de mensalidade aplicável)
// ═══════════════════════════════════════════════════════════════════════════════
export const searchStudent = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const { query } = req.query;

    if (!query) {
      return res.status(400).json({ message: 'Query de busca é obrigatória' });
    }

    const resultados = await queryAsync(
      `
        SELECT
          s.id, s.nome, s.codigo_aluno, s.email, s.turma_id,
          t.nome as turma, c.nome as classe_nome,
          COALESCE(m_turma.valor, m_classe.valor) as valor_mensalidade
        FROM students s
        LEFT JOIN turmas t ON t.id = s.turma_id
        LEFT JOIN classes c ON c.id = t.class_id
        LEFT JOIN mensalidades m_turma ON m_turma.school_id = s.school_id AND m_turma.turma_id = s.turma_id AND m_turma.tipo = 'Mensalidade'
        LEFT JOIN mensalidades m_classe ON m_classe.school_id = s.school_id AND m_classe.classe_nome = c.nome AND m_classe.turma_id IS NULL AND m_classe.tipo = 'Mensalidade'
        WHERE s.school_id = ? AND s.ativo = 1 AND (s.nome LIKE ? OR s.codigo_aluno LIKE ?)
        ORDER BY s.nome ASC
        LIMIT 10
      `,
      [schoolId, `%${query}%`, `%${query}%`]
    );

    res.status(200).json(resultados);
  } catch (error) {
    console.error('[v0] Erro ao pesquisar aluno:', error);
    res.status(500).json({ message: 'Erro ao buscar aluno', error: error.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// 6. GET - Calcular débito total do aluno
// ═══════════════════════════════════════════════════════════════════════════════
export const calculateStudentDebt = (req, res) => {
  const { schoolId, studentId } = req.params;

  console.log(`[v0] GET Débito Aluno - Student: ${studentId}`);

  const query = `
    SELECT 
      COALESCE(SUM(CASE WHEN status = 'pendente' THEN valor_original ELSE 0 END), 0) as mensalidades_devidas,
      COALESCE(SUM(CASE WHEN status = 'pendente' THEN multa ELSE 0 END), 0) as multas_devidas
    FROM student_payments
    WHERE school_id = ? AND student_id = ? AND status = 'pendente'
  `;

  db.query(query, [schoolId, studentId], (error, results) => {
    if (error) {
      console.error('[v0] Erro CALCULATE Debt:', error);
      return res.status(500).json({ message: 'Erro ao calcular débito', error: error.message });
    }

    const result = results[0] || { mensalidades_devidas: 0, multas_devidas: 0 };
    const totalDebito = parseFloat(result.mensalidades_devidas) + parseFloat(result.multas_devidas);

    console.log(`[v0] ✅ Débito calculado - Total: ${totalDebito}`);
    res.status(200).json({
      mensalidades: parseFloat(result.mensalidades_devidas),
      multas: parseFloat(result.multas_devidas),
      total: totalDebito
    });
  });
};

/**
 * Garante que existem, pelo menos, `meses` cobranças de Mensalidade
 * pendentes/atrasadas para este aluno — criando as cobranças dos meses
 * seguintes que ainda não existem (a cobrança do mês só é criada
 * normalmente no próprio mês, ver gerarCobrancasDoMesParaEscola). Usada
 * pelo pagamento antecipado de vários meses de uma vez: se o encarregado
 * quer pagar 3 meses e só existe a cobrança do mês corrente, esta função
 * cria as 2 seguintes (mantendo o valor da mensalidade em vigor no momento
 * da criação, mesmo padrão já usado na geração mensal automática) para o
 * pagamento poder mesmo assim quitar as 3 de uma vez.
 * Devolve quantas cobranças novas foram criadas.
 */
/**
 * Descobre a mensalidade ATIVA aplicável a este aluno (por turma específica,
 * senão pela classe da turma) — mesma regra usada na geração mensal
 * automática (gerarCobrancasDoMesParaEscola). Extraída como helper partilhado
 * em v150 para ser usada tanto ao projetar meses futuros em sequência
 * (garantirCobrancasFuturasAluno) como ao gerar a cobrança de um mês
 * específico fora de sequência (garantirCobrancaMesEspecifico). Devolve
 * `null` se o aluno não tiver turma ou não houver mensalidade ativa
 * configurada para ela/a sua classe.
 */
const buscarMensalidadeAplicavelAluno = async (schoolId, studentId) => {
  const alunoRows = await queryAsync(`SELECT turma_id FROM students WHERE id = ? AND school_id = ?`, [studentId, schoolId]);
  const turmaId = alunoRows[0]?.turma_id || null;
  if (!turmaId) return null; // sem turma, não há mensalidade aplicável a projetar

  const turmaRows = await queryAsync(
    `SELECT c.nome as classe_nome FROM turmas t LEFT JOIN classes c ON c.id = t.class_id WHERE t.id = ? AND t.school_id = ?`,
    [turmaId, schoolId]
  );
  const classeNome = turmaRows[0]?.classe_nome || null;

  const mensalidadeRows = await queryAsync(
    `SELECT id, valor FROM mensalidades WHERE school_id = ? AND ativa = TRUE AND tipo = 'Mensalidade'
       AND ((turma_id = ? AND turma_id IS NOT NULL) OR (turma_id IS NULL AND classe_nome = ?))
     ORDER BY (turma_id IS NOT NULL) DESC LIMIT 1`,
    [schoolId, turmaId, classeNome]
  );
  if (mensalidadeRows.length === 0) return null;
  const mensalidade = mensalidadeRows[0];
  if (!mensalidade.valor || parseFloat(mensalidade.valor) <= 0) return null;
  return mensalidade;
};

const garantirCobrancasFuturasAluno = async (schoolId, studentId, meses) => {
  await ensurePaymentColumnsExist();
  if (!meses || meses < 1) return 0;

  const pendentesAtuais = await queryAsync(
    `SELECT COUNT(*) as total FROM student_payments sp INNER JOIN mensalidades m ON m.id = sp.mensalidade_id
     WHERE sp.school_id = ? AND sp.student_id = ? AND m.tipo = 'Mensalidade' AND sp.status IN ('pendente', 'atrasado')`,
    [schoolId, studentId]
  );
  const faltam = meses - (pendentesAtuais[0]?.total || 0);
  if (faltam <= 0) return 0;

  const mensalidade = await buscarMensalidadeAplicavelAluno(schoolId, studentId);
  if (!mensalidade) return 0;

  // Ponto de partida: o mês seguinte ao vencimento mais recente já lançado
  // (de qualquer status — pago, pendente ou atrasado), ou o mês corrente se
  // este aluno ainda não tiver nenhuma cobrança de mensalidade.
  const ultimaRows = await queryAsync(
    `SELECT MAX(sp.data_vencimento) as ultima FROM student_payments sp INNER JOIN mensalidades m ON m.id = sp.mensalidade_id
     WHERE sp.school_id = ? AND sp.student_id = ? AND m.tipo = 'Mensalidade'`,
    [schoolId, studentId]
  );
  let cursor;
  if (ultimaRows[0]?.ultima) {
    const d = new Date(ultimaRows[0].ultima);
    cursor = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  } else {
    const hoje = new Date();
    cursor = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
  }

  let criadas = 0;
  for (let i = 0; i < faltam; i += 1) {
    const ano = cursor.getFullYear();
    const mes = cursor.getMonth() + 1;
    const ultimoDiaMes = new Date(ano, mes, 0).getDate();
    const dataVencimento = `${ano}-${String(mes).padStart(2, '0')}-${String(ultimoDiaMes).padStart(2, '0')}`;
    const anoLetivo = await resolverAnoLetivoPorData(schoolId, dataVencimento);
    await queryAsync(
      `INSERT INTO student_payments (school_id, student_id, mensalidade_id, valor_original, multa, valor_pago, data_vencimento, academic_year_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?, 'pendente', NOW(), NOW())`,
      [schoolId, studentId, mensalidade.id, mensalidade.valor, dataVencimento, anoLetivo.virtual ? null : anoLetivo.id]
    );
    criadas += 1;
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return criadas;
};

/**
 * v150 — "pagar mês específico fora de sequência": garante que existe uma
 * cobrança de Mensalidade para o mês/ano exato pedido (`ano`/`mes`),
 * criando-a se ainda não tiver sido gerada (normalmente só é gerada quando
 * o mês chega, ver gerarCobrancasDoMesParaEscola), SEM criar nem tocar nas
 * cobranças de meses intermédios que continuem em aberto.
 *
 * Isto é deliberadamente diferente de garantirCobrancasFuturasAluno: aquela
 * preenche a sequência inteira a partir do último mês lançado (para "pagar
 * N meses de uma vez"); esta salta diretamente para o mês pedido, para o
 * encarregado poder adiantar, por exemplo, Dezembro sem ter de fechar
 * primeiro Setembro/Outubro em atraso.
 *
 * Devolve a linha de student_payments (existente ou recém-criada), ou
 * `null` se não houver mensalidade ativa aplicável ao aluno.
 */
const garantirCobrancaMesEspecifico = async (schoolId, studentId, ano, mes) => {
  await ensurePaymentColumnsExist();

  const inicioMes = `${ano}-${String(mes).padStart(2, '0')}-01`;
  const ultimoDiaMes = new Date(ano, mes, 0).getDate();
  const fimMes = `${ano}-${String(mes).padStart(2, '0')}-${String(ultimoDiaMes).padStart(2, '0')}`;

  const existentes = await queryAsync(
    `SELECT sp.* FROM student_payments sp INNER JOIN mensalidades m ON m.id = sp.mensalidade_id
     WHERE sp.school_id = ? AND sp.student_id = ? AND m.tipo = 'Mensalidade'
       AND sp.data_vencimento BETWEEN ? AND ?
     ORDER BY sp.data_vencimento DESC LIMIT 1`,
    [schoolId, studentId, inicioMes, fimMes]
  );
  if (existentes.length > 0) return existentes[0];

  const mensalidade = await buscarMensalidadeAplicavelAluno(schoolId, studentId);
  if (!mensalidade) return null;

  const anoLetivo = await resolverAnoLetivoPorData(schoolId, fimMes);
  const resultado = await queryAsync(
    `INSERT INTO student_payments (school_id, student_id, mensalidade_id, valor_original, multa, valor_pago, data_vencimento, academic_year_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 0, ?, ?, 'pendente', NOW(), NOW())`,
    [schoolId, studentId, mensalidade.id, mensalidade.valor, fimMes, anoLetivo.virtual ? null : anoLetivo.id]
  );
  const novaRows = await queryAsync(`SELECT * FROM student_payments WHERE id = ?`, [resultado.insertId]);
  return novaRows[0];
};

// ═══════════════════════════════════════════════════════════════════════════════
// 7. POST - Registrar pagamento
//    Aplica o valor às cobranças pendentes mais antigas primeiro. Uma cobrança só
//    é marcada como "paga" quando o valor recebido cobre integralmente o que é
//    devido (mensalidade + multa) — pagamentos parciais NÃO fecham a cobrança,
//    para não perder o controlo do que ainda falta receber.
//
//    v150 — exceção a essa ordem: se o pedido trouxer `mes_alvo` (AAAA-MM), o
//    pagamento é aplicado só a essa cobrança específica (gerando-a se
//    necessário), independentemente de existirem cobranças mais antigas por
//    fechar — ver garantirCobrancaMesEspecifico() acima.
// ═══════════════════════════════════════════════════════════════════════════════
export const registerPayment = async (req, res) => {
  try {
    const { schoolId, studentId } = req.params;
    const { valor, metodo = 'dinheiro', meses_antecipados, mes_alvo } = req.body;

    if (!valor || valor <= 0) {
      return res.status(400).json({ success: false, message: 'Valor inválido' });
    }

    // v150 — "pagar mês específico fora de sequência": quando `mes_alvo`
    // (formato "AAAA-MM") vem no pedido, ignora-se por completo a fila
    // sequencial abaixo — só a cobrança desse mês é gerada (se preciso) e
    // quitada, mesmo que existam cobranças mais antigas ainda em aberto.
    if (mes_alvo) {
      const match = /^(\d{4})-(\d{2})$/.exec(String(mes_alvo).trim());
      if (!match) {
        return res.status(400).json({ success: false, message: 'Formato de mês inválido para pagamento adiantado. Use AAAA-MM.' });
      }
      const anoAlvo = parseInt(match[1], 10);
      const mesAlvo = parseInt(match[2], 10);
      if (mesAlvo < 1 || mesAlvo > 12) {
        return res.status(400).json({ success: false, message: 'Mês inválido.' });
      }

      // Qualquer mês é válido: o sistema pode gerar ou regularizar a cobrança
      // do mês alvo mesmo que ele já tenha passado. Isso permite pagar meses
      // em atraso sem depender da sequência de cobranças mais recentes.

      // v131 — mesma garantia do fluxo normal: se por acaso já existir uma
      // cobrança deste mês em atraso (ex.: alvo é o mês corrente e o dia de
      // vencimento já passou), a multa é aplicada antes de calcular o total.
      try {
        await aplicarMultasPorAtraso(schoolId, studentId);
      } catch (erroMultas) {
        console.error('[v0] Aviso: falha ao garantir multas em atraso antes do pagamento por mês específico:', erroMultas.message);
      }

      const cobranca = await garantirCobrancaMesEspecifico(schoolId, studentId, anoAlvo, mesAlvo);
      if (!cobranca) {
        return res.status(400).json({
          success: false,
          message: 'Não foi possível determinar a mensalidade aplicável a este aluno (verifique a turma/classe e se existe mensalidade ativa configurada).',
        });
      }
      if (cobranca.status === 'pago') {
        return res.status(400).json({ success: false, message: `A mensalidade de ${match[2]}/${match[1]} já está paga.` });
      }

      const EPSILON = 0.01;
      const totalDevido = parseFloat(cobranca.valor_original) + parseFloat(cobranca.multa || 0);
      const valorPago = parseFloat(valor);
      if (valorPago + EPSILON < totalDevido) {
        const faltam = (totalDevido - valorPago).toFixed(2);
        return res.status(400).json({
          success: false,
          message: `Valor insuficiente para quitar a mensalidade de ${match[2]}/${match[1]}. Faltam ${faltam} MZN.`,
        });
      }
      const restante = parseFloat((valorPago - totalDevido).toFixed(2));

      await queryAsync(
        `UPDATE student_payments SET status = 'pago', valor_pago = ?, data_pagamento = NOW(), forma_pagamento = ? WHERE id = ?`,
        [totalDevido, metodo, cobranca.id]
      );

      try {
        await queryAsync(
          `INSERT INTO transaction_logs (school_id, student_id, tipo, valor, descricao, data) VALUES (?, ?, ?, ?, ?, NOW())`,
          [schoolId, studentId, 'pagamento', valor, `Pagamento adiantado da mensalidade de ${match[2]}/${match[1]} — ${valor} MZN via ${metodo} (fora da sequência normal)`]
        );
      } catch (erroLog) {
        console.error('[v0] Aviso: não foi possível registar o log de transação:', erroLog.message);
      }

      await registrarAuditoria(req, {
        acao: 'pagamento_registado',
        entidadeTipo: 'payment',
        entidadeId: studentId,
        dadosNovos: { student_id: studentId, valor: parseFloat(valor), metodo, cobrancas_quitadas: [cobranca.id], mes_alvo, fora_de_sequencia: true },
      });

      try {
        const [aluno] = await queryAsync(`SELECT nome FROM students WHERE id = ? AND school_id = ?`, [studentId, schoolId]);
        await criarNotificacao(
          schoolId,
          'pagamento',
          'Mensalidade paga (adiantada)',
          `${aluno?.nome || 'Aluno'}: pagamento adiantado da mensalidade de ${match[2]}/${match[1]} registado.`
        );
      } catch (erroNotif) {
        console.error('[v0] Aviso: não foi possível criar a notificação de pagamento:', erroNotif.message);
      }

      // v96 — mesmo fluxo de recibo automático por WhatsApp do pagamento normal.
      notificarPagamentoMensalidade(schoolId, studentId, cobranca.id);

      return res.status(200).json({
        success: true,
        message: restante > 0
          ? `Mensalidade de ${match[2]}/${match[1]} paga com sucesso. Sobraram ${restante.toFixed(2)} MZN não aplicados. As cobranças mais antigas em aberto (se existirem) continuam pendentes.`
          : `Mensalidade de ${match[2]}/${match[1]} paga com sucesso. As cobranças mais antigas em aberto (se existirem) continuam pendentes.`,
        processados: 1,
        valor_total: parseFloat(valor),
        sobra: restante > 0 ? restante : 0,
        fora_de_sequencia: true,
      });
    }

    // v148 — "pagar vários meses de uma vez": se o encarregado quer quitar
    // 2 ou 3 meses de uma só vez e ainda não existem esse número de
    // cobranças pendentes (só existe a do mês corrente, por exemplo — as
    // seguintes só são geradas automaticamente quando esse mês chegar),
    // criamos aqui as cobranças futuras que faltarem, com o valor da
    // mensalidade em vigor agora. Sem isto, o valor a mais pago ficava como
    // "sobra" sem nenhuma cobrança para aplicar.
    const mesesAntecipadosNum = parseInt(meses_antecipados, 10) || 1;
    if (mesesAntecipadosNum >= 1) {
      try {
        await garantirCobrancasFuturasAluno(schoolId, studentId, Math.min(mesesAntecipadosNum, 12));
      } catch (erroGarantia) {
        console.error('[v0] Aviso: falha ao garantir cobranças futuras para pagamento antecipado:', erroGarantia.message);
      }
    }

    // v131 — garante que qualquer cobrança deste aluno que já esteja em
    // atraso (mesmo que o cron diário ainda não tenha passado por ela hoje)
    // tem a multa aplicada ANTES de calcular o total devido abaixo — ver
    // aplicarMultasPorAtraso().
    try {
      await aplicarMultasPorAtraso(schoolId, studentId);
    } catch (erroMultas) {
      console.error('[v0] Aviso: falha ao garantir multas em atraso antes do pagamento:', erroMultas.message);
    }

    const pendentes = await queryAsync(
      `SELECT * FROM student_payments WHERE school_id = ? AND student_id = ? AND status IN ('pendente', 'atrasado') ORDER BY data_vencimento ASC`,
      [schoolId, studentId]
    );

    if (pendentes.length === 0) {
      return res.status(400).json({ success: false, message: 'Nenhuma cobrança pendente para este aluno' });
    }

    const EPSILON = 0.01; // tolerância para arredondamento de casas decimais
    let restante = parseFloat(valor);
    const processados = [];

    for (const pagamento of pendentes) {
      const totalDevido = parseFloat(pagamento.valor_original) + parseFloat(pagamento.multa || 0);
      if (restante + EPSILON < totalDevido) break; // valor não cobre esta cobrança por completo — pára aqui

      await queryAsync(
        `UPDATE student_payments SET status = 'pago', valor_pago = ?, data_pagamento = NOW(), forma_pagamento = ? WHERE id = ?`,
        [totalDevido, metodo, pagamento.id]
      );
      restante = parseFloat((restante - totalDevido).toFixed(2));
      processados.push(pagamento.id);
    }

    if (processados.length === 0) {
      const faltam = (parseFloat(pendentes[0].valor_original) + parseFloat(pendentes[0].multa || 0) - restante).toFixed(2);
      return res.status(400).json({
        success: false,
        message: `Valor insuficiente para quitar a cobrança mais antiga. Faltam ${faltam} MZN.`,
      });
    }

    try {
      await queryAsync(
        `INSERT INTO transaction_logs (school_id, student_id, tipo, valor, descricao, data) VALUES (?, ?, ?, ?, ?, NOW())`,
        [schoolId, studentId, 'pagamento', valor, `Pagamento de ${valor} MZN via ${metodo} (${processados.length} cobrança(s) quitada(s))`]
      );
    } catch (erroLog) {
      console.error('[v0] Aviso: não foi possível registar o log de transação:', erroLog.message);
    }

    await registrarAuditoria(req, {
      acao: 'pagamento_registado', entidadeTipo: 'payment', entidadeId: studentId,
      dadosNovos: { student_id: studentId, valor: parseFloat(valor), metodo, cobrancas_quitadas: processados },
    });

    try {
      const [aluno] = await queryAsync(`SELECT nome FROM students WHERE id = ? AND school_id = ?`, [studentId, schoolId]);
      await criarNotificacao(
        schoolId,
        'pagamento',
        'Mensalidade paga',
        `${aluno?.nome || 'Aluno'}: pagamento de ${valor} MZN registado (${processados.length} cobrança(s) quitada(s)).`
      );
    } catch (erroNotif) {
      console.error('[v0] Aviso: não foi possível criar a notificação de pagamento:', erroNotif.message);
    }

    // v96 — gera o recibo em PDF de cada cobrança quitada e envia
    // automaticamente por WhatsApp ao(s) encarregado(s) do aluno (cobre
    // mensalidade, taxa de inscrição e taxa de renovação, já que este
    // endpoint único não distingue o tipo). Sem `await` bloqueante — a
    // resposta ao operador não espera pelo envio.
    for (const paymentId of processados) {
      notificarPagamentoMensalidade(schoolId, studentId, paymentId);
    }

    res.status(200).json({
      success: true,
      message: restante > 0
        ? `Pagamento registado. ${processados.length} cobrança(s) quitada(s). Sobraram ${restante.toFixed(2)} MZN não aplicados (nenhuma outra cobrança pendente cabe nesse valor).`
        : `Pagamento registado com sucesso. ${processados.length} cobrança(s) quitada(s).`,
      processados: processados.length,
      valor_total: parseFloat(valor),
      sobra: restante > 0 ? restante : 0,
    });
  } catch (error) {
    console.error('[v0] Erro ao registar pagamento:', error);
    res.status(500).json({ success: false, message: 'Erro ao registar pagamento', error: error.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// 8. GET - Listar alunos devedores
// ═══════════════════════════════════════════════════════════════════════════════
export const getStudentDebtors = async (req, res) => {
  const { schoolId } = req.params;

  console.log(`[v0] GET Alunos Devedores - Escola: ${schoolId}`);

  // v131 — garante que a lista de devedores (e o total em dívida de cada um)
  // já reflete qualquer cobrança que tenha acabado de passar a estar em
  // atraso hoje, mesmo que o cron diário ainda não tenha corrido — ver
  // aplicarMultasPorAtraso().
  try {
    await aplicarMultasPorAtraso(schoolId);
  } catch (erroMultas) {
    console.error('[v0] Aviso: falha ao garantir multas em atraso antes da lista de devedores:', erroMultas.message);
  }

  const query = `
    SELECT 
      s.id,
      s.nome as nome,
      s.codigo_aluno,
      t.nome as turma,
      COALESCE(SUM(CASE WHEN sp.status IN ('pendente', 'atrasado') THEN sp.valor_original + sp.multa ELSE 0 END), 0) as debito,
      SUM(CASE WHEN sp.status = 'atrasado' THEN 1 ELSE 0 END) as cobrancas_atrasadas
    FROM students s
    LEFT JOIN turmas t ON s.turma_id = t.id
    LEFT JOIN student_payments sp ON s.id = sp.student_id AND s.school_id = sp.school_id
    WHERE s.school_id = ? AND s.ativo = 1
    GROUP BY s.id, s.nome, s.codigo_aluno, t.nome
    HAVING debito > 0
    ORDER BY debito DESC
  `;

  db.query(query, [schoolId], (error, results) => {
    if (error) {
      console.error('[v0] Erro GET Debtors:', error);
      if (error.code === 'ER_NO_SUCH_TABLE') {
        return res.status(200).json([]);
      }
      return res.status(500).json({ message: 'Erro ao buscar devedores', error: error.message });
    }
    console.log(`[v0] ✅ ${results.length} alunos devedores encontrados`);
    res.status(200).json(results);
  });
};

// ═══════════════════════════════════════════════════════════════════════════════
// 9. GET - Relatório de pagamentos do mês
// ═══════════════════════════════════════════════════════════════════════════════
export const getPaymentReport = (req, res) => {
  const { schoolId } = req.params;
  const mes = req.query.mes || new Date().getMonth() + 1;
  const ano = req.query.ano || new Date().getFullYear();

  console.log(`[v0] GET Relatório - Escola: ${schoolId}, Mês: ${mes}/${ano}`);

  const query = `
    SELECT 
      DATE(data_pagamento) as data,
      COUNT(*) as total_pagamentos,
      COALESCE(SUM(valor_original), 0) as total_mensalidades,
      COALESCE(SUM(multa), 0) as total_multas,
      COALESCE(SUM(valor_original + multa), 0) as total_recebido
    FROM student_payments
    WHERE school_id = ? 
    AND status = 'pago'
    AND MONTH(data_pagamento) = ?
    AND YEAR(data_pagamento) = ?
    GROUP BY DATE(data_pagamento)
    ORDER BY data DESC
  `;

  db.query(query, [schoolId, mes, ano], (error, results) => {
    if (error) {
      console.error('[v0] Erro GET Report:', error);
      return res.status(500).json({ message: 'Erro ao gerar relatório', error: error.message });
    }
    console.log(`[v0] ✅ Relatório com ${results.length} dias`);
    res.status(200).json(results);
  });
};

// ═══════════════════════════════════════════════════════════════════════════════
// 10. GERAÇÃO MENSAL DE COBRANÇAS
//     Para cada aluno ativo com turma, verifica a mensalidade aplicável (por turma
//     específica, senão pela classe) e cria a cobrança do mês corrente em
//     student_payments — se ainda não existir uma para este mês. Idempotente:
//     pode ser chamada várias vezes sem duplicar cobranças.
// ═══════════════════════════════════════════════════════════════════════════════
const gerarCobrancasDoMesParaEscola = async (schoolId) => {
  await ensurePaymentColumnsExist();
  const alunos = await queryAsync(
    `
      SELECT s.id as student_id, s.turma_id, c.nome as classe_nome
      FROM students s
      LEFT JOIN turmas t ON t.id = s.turma_id
      LEFT JOIN classes c ON c.id = t.class_id
      WHERE s.school_id = ? AND s.ativo = 1 AND s.turma_id IS NOT NULL
    `,
    [schoolId]
  );

  const hoje = new Date();
  const ano = hoje.getFullYear();
  const mes = hoje.getMonth() + 1; // 1-12
  let criadas = 0;

  for (const aluno of alunos) {
    try {
      // Mensalidade aplicável: primeiro tenta por turma específica, senão pela classe
      const mensalidadeRows = await queryAsync(
        `
          SELECT id, valor, vencimento_dia FROM mensalidades
          WHERE school_id = ? AND ativa = TRUE AND tipo = 'Mensalidade'
            AND ((turma_id = ? AND turma_id IS NOT NULL) OR (turma_id IS NULL AND classe_nome = ?))
          ORDER BY (turma_id IS NOT NULL) DESC
          LIMIT 1
        `,
        [schoolId, aluno.turma_id, aluno.classe_nome]
      );
      if (mensalidadeRows.length === 0) continue;
      const mensalidade = mensalidadeRows[0];
      if (!mensalidade.valor || parseFloat(mensalidade.valor) <= 0) continue;

      // Já existe cobrança de MENSALIDADE (independentemente de qual seja a
      // mensalidade aplicável hoje) para este aluno neste mês/ano? A verificação
      // é feita por tipo + mês/ano — e não pelo id específico da mensalidade —
      // para garantir sempre EXATAMENTE UMA cobrança de mensalidade por aluno
      // por mês, mesmo que a mensalidade aplicável mude a meio do mês (ex.: o
      // aluno muda de turma, ou é criada uma mensalidade específica para a
      // turma depois de a cobrança já ter sido gerada pela classe).
      const existente = await queryAsync(
        `SELECT sp.id FROM student_payments sp
         INNER JOIN mensalidades m ON m.id = sp.mensalidade_id
         WHERE sp.school_id = ? AND sp.student_id = ? AND m.tipo = 'Mensalidade'
           AND MONTH(sp.data_vencimento) = ? AND YEAR(sp.data_vencimento) = ? LIMIT 1`,
        [schoolId, aluno.student_id, mes, ano]
      );
      if (existente.length > 0) continue;

      // Dia de vencimento: SEMPRE o último dia do mês (regra fixa do sistema,
      // independentemente do que estiver gravado em vencimento_dia — esse campo
      // é mantido apenas por compatibilidade e já não é usado para calcular a data).
      const ultimoDiaMes = new Date(ano, mes, 0).getDate();
      const dataVencimento = `${ano}-${String(mes).padStart(2, '0')}-${String(ultimoDiaMes).padStart(2, '0')}`;
      const anoLetivo = await resolverAnoLetivoPorData(schoolId, dataVencimento);

      await queryAsync(
        `INSERT INTO student_payments (school_id, student_id, mensalidade_id, valor_original, multa, valor_pago, data_vencimento, academic_year_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, 0, ?, ?, 'pendente', NOW(), NOW())`,
        [schoolId, aluno.student_id, mensalidade.id, mensalidade.valor, dataVencimento, anoLetivo.virtual ? null : anoLetivo.id]
      );
      criadas++;
    } catch (erroAluno) {
      // Um erro num único aluno não pode impedir a geração da mensalidade dos
      // restantes — regista o aviso e continua o ciclo.
      console.error(`[v0] Aviso: falha ao gerar cobrança do mês para o aluno ${aluno.student_id}:`, erroAluno.message);
    }
  }

  return criadas;
};

// POST /schools/:schoolId/mensalidades/gerar-cobrancas — disparo manual pelo administrador
export const gerarCobrancasDoMes = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const criadas = await gerarCobrancasDoMesParaEscola(schoolId);
    res.json({
      success: true,
      message: criadas > 0 ? `${criadas} cobrança(s) do mês gerada(s) com sucesso.` : 'Nenhuma cobrança nova a gerar — todos os alunos já têm a mensalidade deste mês lançada.',
      criadas,
    });
  } catch (error) {
    console.error('[v0] Erro ao gerar cobranças do mês:', error);
    res.status(500).json({ success: false, message: 'Erro ao gerar cobranças do mês', error: error.message });
  }
};

/**
 * Tarefa agendada (cron, ver app.js): roda diariamente para TODAS as escolas —
 * (1) gera as cobranças do mês que ainda não existirem (seguro rodar todo dia,
 *     é idempotente) e (2) aplica a multa configurada pelo administrador e marca
 *     como "atrasado" qualquer cobrança pendente cujo prazo (vencimento + dias de
 *     tolerância) já tenha passado.
 */
export const executarRotinaFinanceiraDiaria = async () => {
  try {
    const escolas = await queryAsync(`SELECT id FROM schools WHERE status = 'ativa' OR status IS NULL`);

    for (const escola of escolas) {
      try {
        await gerarCobrancasDoMesParaEscola(escola.id);
      } catch (erroGeracao) {
        console.error(`[v0] Erro ao gerar cobranças do mês para a escola ${escola.id}:`, erroGeracao.message);
      }

      try {
        await aplicarMultasPorAtraso(escola.id);
      } catch (erroMultas) {
        console.error(`[v0] Erro ao aplicar multas por atraso para a escola ${escola.id}:`, erroMultas.message);
      }
    }
  } catch (error) {
    console.error('[v0] Erro na rotina financeira diária:', error);
  }
};
