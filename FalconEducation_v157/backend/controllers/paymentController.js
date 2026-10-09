import db from "../config/db.js";
import { differenceInDays, format } from "date-fns";
import { notificarEscola } from '../services/notificationService.js';

// Helper para executar queries de forma segura
const safeQuery = (sql, params = []) => {
  return new Promise((resolve) => {
    db.query(sql, params, (err, data) => {
      if (err) {
        console.error(`[v0] Erro na query: ${err.message}`);
        resolve({ error: err, data: null });
      } else {
        resolve({ error: null, data: data || [] });
      }
    });
  });
};

// Verificar se tabela existe
const tableExists = async (tableName) => {
  const result = await safeQuery(`SHOW TABLES LIKE '${tableName}'`);
  return result.data && result.data.length > 0;
};

// Funcao auxiliar para gerar codigo de pagamento
const generatePaymentCode = () => {
  const timestamp = Date.now().toString().slice(-6);
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `PAG${timestamp}${random}`;
};

// Funcao auxiliar para formatar data para MySQL
const formatDateForMySQL = (dateInput) => {
  if (!dateInput) return null;
  
  try {
    const date = new Date(dateInput);
    if (isNaN(date.getTime())) return null;
    
    // Formato MySQL: YYYY-MM-DD HH:MM:SS
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  } catch (error) {
    console.error("[v0] Erro ao formatar data:", error);
    return null;
  }
};

// Obter configuracao do sistema
const getSystemSetting = async (key) => {
  const exists = await tableExists('system_settings');
  if (!exists) {
    console.log("[v0] Tabela 'system_settings' nao existe - retornando valor padrao");
    // Valores padrao
    const defaults = {
      'payment_overdue_days': '35',
      'payment_reminder_days': '7'
    };
    return defaults[key] || null;
  }

  const result = await safeQuery("SELECT setting_value FROM system_settings WHERE setting_key = ?", [key]);
  return result.data?.[0]?.setting_value || null;
};

// Criar pagamento para escola
export const createPayment = async (req, res) => {
  console.log("[v0] Criando novo pagamento:", req.body);
  
  let { school_id, amount, due_date, payment_method, notes } = req.body;

  if (!school_id || !amount || !due_date) {
    return res.status(400).json({ error: "school_id, amount e due_date sao obrigatorios" });
  }

  try {
    // Verificar se escola existe
    const checkSchool = await safeQuery("SELECT id FROM schools WHERE id = ?", [school_id]);

    if (checkSchool.error) {
      console.error("[v0] Erro ao verificar escola:", checkSchool.error);
      return res.status(500).json({ error: "Erro ao verificar escola" });
    }

    if (checkSchool.data.length === 0) {
      return res.status(404).json({ error: "Escola nao encontrada" });
    }

    // Formatar a data de vencimento para MySQL
    const formattedDueDate = formatDateForMySQL(due_date);
    
    if (!formattedDueDate) {
      return res.status(400).json({ error: "Formato de data invalido" });
    }

    const sql = `
      INSERT INTO school_payments (school_id, amount, due_date, payment_method, notes, status)
      VALUES (?, ?, ?, ?, ?, 'pendente')
    `;

    const result = await safeQuery(sql, [
      parseInt(school_id), 
      parseFloat(amount), 
      formattedDueDate, 
      payment_method || null,
      notes || null
    ]);

    if (result.error) {
      console.error("[v0] Erro ao criar pagamento:", result.error);
      return res.status(500).json({ error: "Erro ao criar pagamento" });
    }

    console.log("[v0] Pagamento criado com sucesso, ID:", result.data.insertId);
    res.status(201).json({
      id: result.data.insertId,
      school_id: parseInt(school_id),
      amount: parseFloat(amount),
      due_date: formattedDueDate,
      payment_method: payment_method || null,
      notes: notes || null,
      status: "pendente",
      created_at: new Date()
    });
  } catch (error) {
    console.error("[v0] Erro ao criar pagamento:", error);
    return res.status(500).json({ error: "Erro ao criar pagamento" });
  }
};

// Obter pagamentos com filtros
export const getPayments = async (req, res) => {
  console.log("[v0] Buscando pagamentos com query:", req.query);

  // Verificar se tabela existe
  const exists = await tableExists('school_payments');
  if (!exists) {
    console.log("[v0] Tabela 'school_payments' nao existe - retornando array vazio");
    return res.json([]);
  }

  let { status, school_id, search, limit = 100, offset = 0 } = req.query;

  let sql = `
    SELECT 
      sp.id,
      sp.school_id,
      sp.amount,
      sp.payment_date,
      sp.due_date,
      sp.status,
      sp.payment_method,
      sp.notes,
      sp.created_at,
      sp.updated_at,
      s.name as school_name,
      s.email as school_email,
      DATEDIFF(CURDATE(), sp.due_date) as days_overdue
    FROM school_payments sp
    LEFT JOIN schools s ON sp.school_id = s.id
    WHERE 1=1
  `;

  let params = [];

  if (status) {
    sql += " AND sp.status = ?";
    params.push(status);
  }

  if (school_id) {
    sql += " AND sp.school_id = ?";
    params.push(parseInt(school_id));
  }

  if (search) {
    sql += " AND (s.name LIKE ? OR s.email LIKE ?)";
    params.push(`%${search}%`, `%${search}%`);
  }

  sql += " ORDER BY sp.due_date ASC LIMIT ? OFFSET ?";
  params.push(parseInt(limit), parseInt(offset));

  const result = await safeQuery(sql, params);

  if (result.error) {
    console.error("[v0] Erro ao buscar pagamentos:", result.error);
    return res.status(500).json({ error: "Erro ao buscar pagamentos" });
  }

  console.log("[v0] Pagamentos encontrados:", result.data.length);
  res.json(result.data);
};

// Obter um pagamento especifico
export const getPaymentById = async (req, res) => {
  const paymentId = req.params.id;
  console.log("[v0] Buscando pagamento ID:", paymentId);

  const result = await safeQuery(`
    SELECT 
      sp.*,
      s.name as school_name,
      s.email as school_email
    FROM school_payments sp
    LEFT JOIN schools s ON sp.school_id = s.id
    WHERE sp.id = ?
  `, [parseInt(paymentId)]);

  if (result.error) {
    console.error("[v0] Erro ao buscar pagamento:", result.error);
    return res.status(500).json({ error: "Erro ao buscar pagamento" });
  }

  if (result.data.length === 0) {
    return res.status(404).json({ error: "Pagamento nao encontrado" });
  }

  res.json(result.data[0]);
};

// Confirmar pagamento manualmente
export const confirmPayment = async (req, res) => {
  const paymentId = req.params.id;
  console.log("[v0] Confirmando pagamento ID:", paymentId);
  console.log("[v0] Body recebido:", req.body);

  const { payment_date, notes } = req.body;

  try {
    // Buscar pagamento atual
    const paymentResult = await safeQuery("SELECT * FROM school_payments WHERE id = ?", [parseInt(paymentId)]);

    if (paymentResult.error) {
      console.error("[v0] Erro ao buscar pagamento:", paymentResult.error);
      return res.status(500).json({ error: "Erro ao buscar pagamento" });
    }

    if (!paymentResult.data || paymentResult.data.length === 0) {
      console.log("[v0] Pagamento nao encontrado");
      return res.status(404).json({ error: "Pagamento nao encontrado" });
    }

    const payment = paymentResult.data[0];
    const oldStatus = payment.status;

    console.log("[v0] Pagamento encontrado:", payment);
    console.log("[v0] Status anterior:", oldStatus);

    // Verificar se ja esta pago
    if (payment.status === 'pago') {
      return res.status(400).json({ error: "Este pagamento ja foi confirmado" });
    }

    // Formatar a data de pagamento para MySQL
    let formattedPaymentDate;
    if (payment_date) {
      formattedPaymentDate = formatDateForMySQL(payment_date);
    } else {
      formattedPaymentDate = formatDateForMySQL(new Date());
    }

    console.log("[v0] Data de pagamento formatada:", formattedPaymentDate);

    // Atualizar pagamento para pago
    const updateSql = `
      UPDATE school_payments 
      SET status = 'pago', 
          payment_date = ?, 
          notes = CASE WHEN ? IS NOT NULL THEN ? ELSE notes END,
          updated_at = NOW()
      WHERE id = ?
    `;

    const updateResult = await safeQuery(updateSql, [
      formattedPaymentDate,
      notes || null,
      notes || null,
      parseInt(paymentId)
    ]);

    if (updateResult.error) {
      console.error("[v0] Erro ao atualizar pagamento:", updateResult.error);
      return res.status(500).json({ error: "Erro ao confirmar pagamento: " + updateResult.error.message });
    }

    console.log("[v0] Resultado da atualizacao:", updateResult.data);

    // Verificar se a atualizacao afetou alguma linha
    if (updateResult.data.affectedRows === 0) {
      console.log("[v0] Nenhuma linha afetada na atualizacao");
      return res.status(500).json({ error: "Falha ao atualizar pagamento - nenhuma linha afetada" });
    }

    // Tentar registrar no historico (ignorar se falhar)
    const historyExists = await tableExists('payment_history');
    if (historyExists) {
      const historyResult = await safeQuery(`
        INSERT INTO payment_history (payment_id, school_id, previous_status, new_status, amount, notes)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        parseInt(paymentId), 
        payment.school_id, 
        oldStatus, 
        'pago', 
        payment.amount, 
        notes || 'Pagamento confirmado manualmente'
      ]);

      if (historyResult.error) {
        console.log("[v0] Aviso: Erro ao registrar historico (ignorado):", historyResult.error.message);
      } else {
        console.log("[v0] Historico registrado com sucesso");
      }
    }

    // Atualizar status da escola para ativa
    const schoolUpdateResult = await safeQuery("UPDATE schools SET status = 'ativa' WHERE id = ?", [payment.school_id]);
    
    if (schoolUpdateResult.error) {
      console.log("[v0] Aviso: Erro ao atualizar escola (ignorado):", schoolUpdateResult.error.message);
    } else {
      console.log("[v0] Escola atualizada para ativa");
    }

    console.log("[v0] Pagamento confirmado com sucesso");
    
    res.json({ 
      success: true,
      message: "Pagamento confirmado com sucesso", 
      id: parseInt(paymentId),
      payment_date: formattedPaymentDate,
      status: 'pago'
    });

  } catch (error) {
    console.error("[v0] Erro ao confirmar pagamento:", error);
    return res.status(500).json({ error: "Erro interno ao confirmar pagamento: " + error.message });
  }
};

// Atualizar pagamento
export const updatePayment = async (req, res) => {
  const paymentId = req.params.id;
  console.log("[v0] Atualizando pagamento ID:", paymentId);

  const { school_id, amount, due_date, payment_method, status, notes } = req.body;

  try {
    // Verificar se pagamento existe
    const checkPayment = await safeQuery("SELECT * FROM school_payments WHERE id = ?", [parseInt(paymentId)]);

    if (checkPayment.error) {
      console.error("[v0] Erro ao verificar pagamento:", checkPayment.error);
      return res.status(500).json({ error: "Erro ao verificar pagamento" });
    }

    if (checkPayment.data.length === 0) {
      return res.status(404).json({ error: "Pagamento nao encontrado" });
    }

    const currentPayment = checkPayment.data[0];

    // ── IMUTABILIDADE DO HISTÓRICO FINANCEIRO (v55) ──────────────────────────
    // Um pagamento já confirmado ('pago') é um facto histórico e não pode ser
    // reescrito (nem valor, nem vencimento, nem status) — isso permitia editar
    // silenciosamente um pagamento já recebido, adulterando o histórico. Só
    // 'notes' continua editável livremente. Para corrigir um pagamento já
    // confirmado, deve ser feito um estorno (nova entrada), nunca um UPDATE
    // sobre o registo original.
    if (currentPayment.status === 'pago') {
      const camposSensiveis = [];
      if (amount !== undefined && parseFloat(amount) !== parseFloat(currentPayment.amount)) camposSensiveis.push('amount');
      if (due_date !== undefined && formatDateForMySQL(due_date) !== formatDateForMySQL(currentPayment.due_date)) camposSensiveis.push('due_date');
      if (status !== undefined && status !== currentPayment.status) camposSensiveis.push('status');

      if (camposSensiveis.length > 0) {
        return res.status(400).json({
          error: `Não é possível alterar ${camposSensiveis.join(', ')} de um pagamento já confirmado. O histórico financeiro é imutável — se precisar corrigir este pagamento, registe um estorno em vez de editar o registo original.`,
        });
      }
    }

    // Preparar dados para atualizacao
    const updates = [];
    const params = [];

    if (school_id !== undefined) {
      updates.push("school_id = ?");
      params.push(parseInt(school_id));
    }

    if (amount !== undefined && currentPayment.status !== 'pago') {
      updates.push("amount = ?");
      params.push(parseFloat(amount));
    }

    if (due_date !== undefined && currentPayment.status !== 'pago') {
      const formattedDueDate = formatDateForMySQL(due_date);
      if (formattedDueDate) {
        updates.push("due_date = ?");
        params.push(formattedDueDate);
      }
    }

    if (payment_method !== undefined) {
      updates.push("payment_method = ?");
      params.push(payment_method);
    }

    if (status !== undefined && currentPayment.status !== 'pago') {
      updates.push("status = ?");
      params.push(status);
    }

    if (notes !== undefined) {
      updates.push("notes = ?");
      params.push(notes);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "Nenhum campo para atualizar" });
    }

    updates.push("updated_at = NOW()");
    params.push(parseInt(paymentId));

    const sql = `UPDATE school_payments SET ${updates.join(", ")} WHERE id = ?`;

    const result = await safeQuery(sql, params);

    if (result.error) {
      console.error("[v0] Erro ao atualizar pagamento:", result.error);
      return res.status(500).json({ error: "Erro ao atualizar pagamento" });
    }

    console.log("[v0] Pagamento atualizado com sucesso");
    res.json({ message: "Pagamento atualizado com sucesso", id: parseInt(paymentId) });

  } catch (error) {
    console.error("[v0] Erro ao atualizar pagamento:", error);
    return res.status(500).json({ error: "Erro ao atualizar pagamento" });
  }
};

// Verificar e atualizar status de pagamentos atrasados
export const checkOverduePayments = async () => {
  console.log("[v0] Verificando pagamentos atrasados...");

  try {
    // Verificar se tabela existe
    const exists = await tableExists('school_payments');
    if (!exists) {
      console.log("[v0] Tabela 'school_payments' nao existe - pulando verificacao");
      return;
    }

    const overdueDays = parseInt(await getSystemSetting('payment_overdue_days')) || 35;
    const reminderDays = parseInt(await getSystemSetting('payment_reminder_days')) || 7;

    // Encontrar pagamentos atrasados
    const result = await safeQuery(`
      SELECT sp.*, s.email, s.name
      FROM school_payments sp
      LEFT JOIN schools s ON sp.school_id = s.id
      WHERE sp.status IN ('pendente', 'atrasado')
      AND sp.due_date < NOW()
    `);

    if (result.error) {
      console.error("[v0] Erro ao verificar pagamentos atrasados:", result.error);
      return;
    }

    for (const payment of result.data) {
      const daysOverdue = differenceInDays(new Date(), new Date(payment.due_date));

      // Marcar como vencido se > 35 dias
      if (daysOverdue >= overdueDays && payment.status !== 'vencido') {
        await safeQuery(
          "UPDATE school_payments SET status = 'vencido', updated_at = NOW() WHERE id = ?",
          [payment.id]
        );

        await safeQuery(
          "UPDATE schools SET status = 'inativa' WHERE id = ?",
          [payment.school_id]
        );

        // v121 — antes, um INSERT INTO notifications escrito à mão aqui
        // (com a sua própria verificação de existência da tabela) em vez de
        // reaproveitar a função central; notificarEscola() já garante a
        // tabela sozinha e é a mesma usada por todo o resto do sistema.
        await notificarEscola(
          payment.school_id, 'payment_overdue', 'Conta Inativada',
          `Sua conta foi inativada devido ao pagamento atrasado por ${daysOverdue} dias.`
        );

        console.log(`[v0] Escola ${payment.school_id} marcada como inativa`);
      }
      // Marcar como atrasado se > 7 dias
      else if (daysOverdue >= reminderDays && payment.status === 'pendente') {
        await safeQuery(
          "UPDATE school_payments SET status = 'atrasado', updated_at = NOW() WHERE id = ?",
          [payment.id]
        );

        await notificarEscola(
          payment.school_id, 'payment_overdue', 'Pagamento Atrasado',
          `Seu pagamento esta atrasado por ${daysOverdue} dias. Por favor, atualize sua situacao.`
        );

        console.log(`[v0] Pagamento ${payment.id} marcado como atrasado`);
      }
    }
  } catch (error) {
    console.error("[v0] Erro ao verificar pagamentos:", error);
  }
};

// Obter resumo financeiro
export const getFinancialSummary = async (req, res) => {
  console.log("[v0] Buscando resumo financeiro");

  // Verificar se tabela existe
  const exists = await tableExists('school_payments');
  if (!exists) {
    console.log("[v0] Tabela 'school_payments' nao existe - retornando valores zerados");
    return res.json({
      totalPending: [{ total: 0 }],
      totalPaid: [{ total: 0 }],
      totalOverdue: [{ total: 0 }],
      paymentCount: []
    });
  }

  try {
    const [totalPending, totalPaid, totalOverdue, paymentCount] = await Promise.all([
      safeQuery("SELECT COALESCE(SUM(amount), 0) as total FROM school_payments WHERE status = 'pendente'"),
      safeQuery("SELECT COALESCE(SUM(amount), 0) as total FROM school_payments WHERE status = 'pago'"),
      safeQuery("SELECT COALESCE(SUM(amount), 0) as total FROM school_payments WHERE status IN ('atrasado', 'vencido')"),
      safeQuery("SELECT COUNT(*) as count, status, COALESCE(SUM(amount), 0) as total FROM school_payments GROUP BY status")
    ]);

    // v134 — antes só se olhava para `.data` (com fallback [{total:0}]) e
    // nunca se verificava `.error`; uma query que falhasse (não a tabela em
    // falta — já tratado acima — mas um erro real de SQL/ligação) devolvia
    // "0 MT" com resposta 200, indistinguível de um saldo realmente zero.
    // Isto alimenta o KPI "Faturamento" no Dashboard do Super Admin.
    const falhas = [totalPending, totalPaid, totalOverdue, paymentCount].filter((r) => r.error);
    if (falhas.length > 0) {
      console.error("[v0] Erro ao buscar resumo financeiro:", falhas.map((f) => f.error.message).join('; '));
      return res.status(500).json({ error: "Erro ao buscar resumo financeiro" });
    }

    console.log("[v0] Resumo financeiro calculado");
    res.json({
      totalPending: totalPending.data || [{ total: 0 }],
      totalPaid: totalPaid.data || [{ total: 0 }],
      totalOverdue: totalOverdue.data || [{ total: 0 }],
      paymentCount: paymentCount.data || []
    });
  } catch (error) {
    console.error("[v0] Erro ao buscar resumo financeiro:", error);
    res.status(500).json({ error: "Erro ao buscar resumo financeiro" });
  }
};

// Obter pagamentos por escola
export const getPaymentsBySchool = async (req, res) => {
  const schoolId = req.params.schoolId;
  console.log("[v0] Buscando pagamentos da escola:", schoolId);

  const result = await safeQuery(`
    SELECT 
      sp.*,
      s.name as school_name,
      s.email as school_email
    FROM school_payments sp
    LEFT JOIN schools s ON sp.school_id = s.id
    WHERE sp.school_id = ?
    ORDER BY sp.due_date DESC
  `, [parseInt(schoolId)]);

  if (result.error) {
    console.error("[v0] Erro ao buscar pagamentos:", result.error);
    return res.status(500).json({ error: "Erro ao buscar pagamentos" });
  }

  res.json(result.data);
};

// Deletar pagamento
export const deletePayment = async (req, res) => {
  const paymentId = req.params.id;

  console.log("[v0] Deletando pagamento ID:", paymentId);

  // Primeiro verificar se existe
  const checkResult = await safeQuery("SELECT id, status FROM school_payments WHERE id = ?", [parseInt(paymentId)]);

  if (checkResult.error) {
    console.error("[v0] Erro ao verificar pagamento:", checkResult.error);
    return res.status(500).json({ error: "Erro ao verificar pagamento" });
  }

  if (checkResult.data.length === 0) {
    return res.status(404).json({ error: "Pagamento nao encontrado" });
  }

  // ── IMUTABILIDADE DO HISTÓRICO FINANCEIRO (v55) ────────────────────────────
  // Um pagamento já confirmado ('pago') nunca pode ser apagado — é histórico.
  // Só cobranças ainda pendentes/canceladas podem ser removidas.
  if (checkResult.data[0].status === 'pago') {
    return res.status(400).json({
      error: "Não é possível excluir um pagamento já confirmado. O histórico financeiro é imutável — registe um estorno em vez de apagar o registo original.",
    });
  }

  const result = await safeQuery("DELETE FROM school_payments WHERE id = ?", [parseInt(paymentId)]);

  if (result.error) {
    console.error("[v0] Erro ao deletar pagamento:", result.error);
    return res.status(500).json({ error: "Erro ao deletar pagamento" });
  }

  console.log("[v0] Pagamento deletado com sucesso");
  res.json({ success: true, message: "Pagamento deletado com sucesso" });
};

// Estatisticas gerais de pagamentos
export const getPaymentStats = async (req, res) => {
  console.log("[v0] Buscando estatisticas de pagamentos");

  const exists = await tableExists('school_payments');
  if (!exists) {
    return res.json({
      total: 0,
      paid: 0,
      pending: 0,
      overdue: 0,
      totalAmount: 0,
      paidAmount: 0,
      pendingAmount: 0,
      overdueAmount: 0
    });
  }

  try {
    const result = await safeQuery(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pago' THEN 1 ELSE 0 END) as paid,
        SUM(CASE WHEN status = 'pendente' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status IN ('atrasado', 'vencido') THEN 1 ELSE 0 END) as overdue,
        COALESCE(SUM(amount), 0) as totalAmount,
        COALESCE(SUM(CASE WHEN status = 'pago' THEN amount ELSE 0 END), 0) as paidAmount,
        COALESCE(SUM(CASE WHEN status = 'pendente' THEN amount ELSE 0 END), 0) as pendingAmount,
        COALESCE(SUM(CASE WHEN status IN ('atrasado', 'vencido') THEN amount ELSE 0 END), 0) as overdueAmount
      FROM school_payments
    `);

    if (result.error) {
      console.error("[v0] Erro ao buscar estatisticas:", result.error);
      return res.status(500).json({ error: "Erro ao buscar estatisticas" });
    }

    res.json(result.data[0] || {
      total: 0,
      paid: 0,
      pending: 0,
      overdue: 0,
      totalAmount: 0,
      paidAmount: 0,
      pendingAmount: 0,
      overdueAmount: 0
    });

  } catch (error) {
    console.error("[v0] Erro ao buscar estatisticas:", error);
    res.status(500).json({ error: "Erro ao buscar estatisticas" });
  }
};