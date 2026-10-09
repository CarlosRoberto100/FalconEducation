import db from "../config/db.js";
import ExcelJS from "exceljs";
import { startOfMonth, endOfMonth, startOfWeek, endOfWeek, format } from "date-fns";

// Helper para executar queries de forma segura
const safeQuery = (sql, params = []) => {
  return new Promise((resolve) => {
    db.query(sql, params, (err, data) => {
      if (err) {
        console.error(`[v0] Erro na query: ${err.message}`);
        resolve([]); // Retorna array vazio em caso de erro
      } else {
        resolve(data || []);
      }
    });
  });
};

// Helper para queries de contagem/soma seguras
const safeCountQuery = (sql, params = []) => {
  return new Promise((resolve) => {
    db.query(sql, params, (err, data) => {
      if (err) {
        console.error(`[v0] Erro na query de contagem: ${err.message}`);
        resolve({ count: 0, total: 0 }); // Retorna objeto com valores padrão
      } else {
        resolve(data?.[0] || { count: 0, total: 0 });
      }
    });
  });
};

// Gerar relatório mensal em Excel
export const generateMonthlyReport = async (req, res) => {
  console.log("[v0] Gerando relatório mensal...");

  try {
    const { year, month } = req.query;
    
    if (!year || !month) {
      return res.status(400).json({ error: "Ano e mês são obrigatórios" });
    }

    const date = new Date(year, month - 1, 1);
    const monthStart = startOfMonth(date);
    const monthEnd = endOfMonth(date);

    // Buscar dados do mês com queries seguras
    const schoolsSql = `
      SELECT s.*, COUNT(sa.id) as admin_count
      FROM schools s
      LEFT JOIN school_admins sa ON s.id = sa.school_id
      WHERE s.created_at BETWEEN ? AND ?
      GROUP BY s.id
    `;

    const paymentsSql = `
      SELECT sp.*, s.name as school_name
      FROM school_payments sp
      LEFT JOIN schools s ON sp.school_id = s.id
      WHERE sp.created_at BETWEEN ? AND ?
    `;

    const usersSql = `
      SELECT * FROM users
      WHERE created_at BETWEEN ? AND ?
    `;

    // Executar queries de forma segura
    const schools = await safeQuery(schoolsSql, [monthStart, monthEnd]);
    const payments = await safeQuery(paymentsSql, [monthStart, monthEnd]);
    const users = await safeQuery(usersSql, [monthStart, monthEnd]);

    // Criar workbook
    const workbook = new ExcelJS.Workbook();

    // Aba 1: Resumo
    const summarySheet = workbook.addWorksheet("Resumo");
    summarySheet.columns = [
      { header: "Métrica", key: "metric", width: 30 },
      { header: "Valor", key: "value", width: 20 }
    ];

    const totalPayments = payments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
    const paidPayments = payments.filter(p => p.status === 'pago').reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
    const pendingPayments = payments.filter(p => p.status === 'pendente').reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);

    summarySheet.addRows([
      { metric: "Escolas Cadastradas", value: schools.length },
      { metric: "Novos Usuários", value: users.length },
      { metric: "Total de Pagamentos", value: `R$ ${totalPayments.toFixed(2)}` },
      { metric: "Pagamentos Confirmados", value: `R$ ${paidPayments.toFixed(2)}` },
      { metric: "Pagamentos Pendentes", value: `R$ ${pendingPayments.toFixed(2)}` },
      { metric: "Período", value: `${format(monthStart, 'dd/MM/yyyy')} a ${format(monthEnd, 'dd/MM/yyyy')}` }
    ]);

    // Aba 2: Escolas
    const schoolsSheet = workbook.addWorksheet("Escolas");
    schoolsSheet.columns = [
      { header: "ID", key: "id", width: 10 },
      { header: "Nome", key: "name", width: 30 },
      { header: "Email", key: "email", width: 25 },
      { header: "Telefone", key: "phone", width: 15 },
      { header: "Alunos", key: "students", width: 10 },
      { header: "Status", key: "status", width: 12 },
      { header: "Admins", key: "admin_count", width: 10 },
      { header: "Data Criação", key: "created_at", width: 15 }
    ];

    schools.forEach(school => {
      schoolsSheet.addRow({
        ...school,
        created_at: school.created_at ? format(new Date(school.created_at), 'dd/MM/yyyy') : '-'
      });
    });

    // Aba 3: Pagamentos
    const paymentsSheet = workbook.addWorksheet("Pagamentos");
    paymentsSheet.columns = [
      { header: "ID", key: "id", width: 10 },
      { header: "Escola", key: "school_name", width: 30 },
      { header: "Valor", key: "amount", width: 15 },
      { header: "Status", key: "status", width: 12 },
      { header: "Data Vencimento", key: "due_date", width: 15 },
      { header: "Data Pagamento", key: "payment_date", width: 15 },
      { header: "Método", key: "payment_method", width: 15 }
    ];

    payments.forEach(payment => {
      paymentsSheet.addRow({
        ...payment,
        amount: `R$ ${parseFloat(payment.amount || 0).toFixed(2)}`,
        due_date: payment.due_date ? format(new Date(payment.due_date), 'dd/MM/yyyy') : '-',
        payment_date: payment.payment_date ? format(new Date(payment.payment_date), 'dd/MM/yyyy') : '-'
      });
    });

    // Aba 4: Usuários
    const usersSheet = workbook.addWorksheet("Usuários");
    usersSheet.columns = [
      { header: "ID", key: "id", width: 10 },
      { header: "Código", key: "code", width: 15 },
      { header: "Nome", key: "name", width: 25 },
      { header: "Email", key: "email", width: 25 },
      { header: "Role", key: "role", width: 12 },
      { header: "Status", key: "status", width: 12 },
      { header: "Data Criação", key: "created_at", width: 15 }
    ];

    users.forEach(user => {
      usersSheet.addRow({
        ...user,
        created_at: user.created_at ? format(new Date(user.created_at), 'dd/MM/yyyy') : '-'
      });
    });

    // Estilos
    [summarySheet, schoolsSheet, paymentsSheet, usersSheet].forEach(sheet => {
      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1e40af' } };
    });

    // Gerar arquivo
    const buffer = await workbook.xlsx.writeBuffer();
    const fileName = `relatorio-mensal-${format(date, 'MM-yyyy')}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(buffer);

    console.log("[v0] Relatório mensal gerado com sucesso");
  } catch (error) {
    console.error("[v0] Erro ao gerar relatório mensal:", error);
    return res.status(500).json({ error: "Erro ao gerar relatório", details: error.message });
  }
};

// Gerar relatório semanal em Excel
export const generateWeeklyReport = async (req, res) => {
  console.log("[v0] Gerando relatório semanal...");

  try {
    const { date } = req.query;
    
    if (!date) {
      return res.status(400).json({ error: "Data é obrigatória" });
    }

    const reportDate = new Date(date);
    const weekStart = startOfWeek(reportDate);
    const weekEnd = endOfWeek(reportDate);

    // Buscar dados da semana com queries seguras
    const schoolsSql = `
      SELECT s.*, COUNT(sa.id) as admin_count
      FROM schools s
      LEFT JOIN school_admins sa ON s.id = sa.school_id
      WHERE s.created_at BETWEEN ? AND ?
      GROUP BY s.id
    `;

    const paymentsSql = `
      SELECT sp.*, s.name as school_name
      FROM school_payments sp
      LEFT JOIN schools s ON sp.school_id = s.id
      WHERE sp.created_at BETWEEN ? AND ?
    `;

    const schools = await safeQuery(schoolsSql, [weekStart, weekEnd]);
    const payments = await safeQuery(paymentsSql, [weekStart, weekEnd]);

    // Criar workbook
    const workbook = new ExcelJS.Workbook();

    // Aba 1: Resumo
    const summarySheet = workbook.addWorksheet("Resumo Semanal");
    summarySheet.columns = [
      { header: "Métrica", key: "metric", width: 30 },
      { header: "Valor", key: "value", width: 20 }
    ];

    const totalPayments = payments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);

    summarySheet.addRows([
      { metric: "Semana de", value: format(weekStart, 'dd/MM/yyyy') },
      { metric: "até", value: format(weekEnd, 'dd/MM/yyyy') },
      { metric: "Novas Escolas", value: schools.length },
      { metric: "Total de Pagamentos", value: `R$ ${totalPayments.toFixed(2)}` },
      { metric: "Movimentações", value: payments.length }
    ]);

    // Aba 2: Detalhes
    const detailsSheet = workbook.addWorksheet("Detalhes");
    detailsSheet.columns = [
      { header: "Escola", key: "school_name", width: 30 },
      { header: "Valor", key: "amount", width: 15 },
      { header: "Status", key: "status", width: 12 },
      { header: "Data", key: "created_at", width: 15 }
    ];

    payments.forEach(payment => {
      detailsSheet.addRow({
        school_name: payment.school_name || 'N/A',
        amount: `R$ ${parseFloat(payment.amount || 0).toFixed(2)}`,
        status: payment.status || 'N/A',
        created_at: payment.created_at ? format(new Date(payment.created_at), 'dd/MM/yyyy') : '-'
      });
    });

    // Estilos
    [summarySheet, detailsSheet].forEach(sheet => {
      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1e40af' } };
    });

    // Gerar arquivo
    const buffer = await workbook.xlsx.writeBuffer();
    const fileName = `relatorio-semanal-${format(weekStart, 'dd-MM-yyyy')}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(buffer);

    console.log("[v0] Relatório semanal gerado com sucesso");
  } catch (error) {
    console.error("[v0] Erro ao gerar relatório semanal:", error);
    return res.status(500).json({ error: "Erro ao gerar relatório", details: error.message });
  }
};

// Obter dados para gráficos
export const getChartData = async (req, res) => {
  console.log("[v0] Buscando dados para gráficos");

  try {
    // Executar todas as queries de forma segura
    const [paymentStatus, schoolStatus, monthlyGrowth, financialSummary] = await Promise.all([
      safeQuery("SELECT status, COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM school_payments GROUP BY status"),
      safeQuery("SELECT status, COUNT(*) as count FROM schools GROUP BY status"),
      safeQuery(`
        SELECT DATE_FORMAT(created_at, '%Y-%m') as month, COUNT(*) as schools
        FROM schools
        GROUP BY DATE_FORMAT(created_at, '%Y-%m')
        ORDER BY month DESC
        LIMIT 12
      `),
      safeCountQuery(`
        SELECT 
          COALESCE(SUM(CASE WHEN status = 'pago' THEN amount ELSE 0 END), 0) as paid,
          COALESCE(SUM(CASE WHEN status = 'pendente' THEN amount ELSE 0 END), 0) as pending,
          COALESCE(SUM(CASE WHEN status IN ('atrasado', 'vencido') THEN amount ELSE 0 END), 0) as overdue
        FROM school_payments
      `)
    ]);

    const chartsData = {
      paymentStatus,
      schoolStatus,
      monthlyGrowth,
      financialSummary
    };

    console.log("[v0] Dados de gráficos obtidos com sucesso");
    res.json(chartsData);
  } catch (error) {
    console.error("[v0] Erro ao buscar dados para gráficos:", error);
    res.status(500).json({ 
      error: "Erro ao buscar dados", 
      details: error.message,
      // Retornar dados vazios para não quebrar o frontend
      paymentStatus: [],
      schoolStatus: [],
      monthlyGrowth: [],
      financialSummary: { paid: 0, pending: 0, overdue: 0 }
    });
  }
};

// Verificar se tabela existe
const tableExists = (tableName) => {
  return new Promise((resolve) => {
    db.query(`SHOW TABLES LIKE '${tableName}'`, (err, data) => {
      if (err) {
        console.error(`[v0] Erro ao verificar tabela ${tableName}:`, err.message);
        resolve(false);
      } else {
        resolve(data && data.length > 0);
      }
    });
  });
};

// Obter estatísticas gerais
export const getGeneralStats = async (req, res) => {
  console.log("[v0] Buscando estatísticas gerais");

  try {
    // Verificar quais tabelas existem
    const usersTableExists = await tableExists('users');
    const schoolsTableExists = await tableExists('schools');
    const adminsTableExists = await tableExists('school_admins');
    const paymentsTableExists = await tableExists('school_payments');

    // Construir queries apenas para tabelas existentes
    const queries = [];

    if (schoolsTableExists) {
      queries.push(
        safeCountQuery("SELECT COUNT(*) as count FROM schools").then(r => ({ key: 'totalSchools', value: r })),
        safeCountQuery("SELECT COUNT(*) as count FROM schools WHERE status = 'ativa'").then(r => ({ key: 'activeSchools', value: r }))
      );
    } else {
      queries.push(
        Promise.resolve({ key: 'totalSchools', value: { count: 0 } }),
        Promise.resolve({ key: 'activeSchools', value: { count: 0 } })
      );
    }

    if (adminsTableExists) {
      queries.push(
        safeCountQuery("SELECT COUNT(*) as count FROM school_admins").then(r => ({ key: 'totalAdmins', value: r }))
      );
    } else {
      queries.push(Promise.resolve({ key: 'totalAdmins', value: { count: 0 } }));
    }

    if (usersTableExists) {
      queries.push(
        safeCountQuery("SELECT COUNT(*) as count FROM users").then(r => ({ key: 'totalUsers', value: r }))
      );
    } else {
      console.log("[v0] Tabela 'users' não existe - retornando 0");
      queries.push(Promise.resolve({ key: 'totalUsers', value: { count: 0 } }));
    }

    if (paymentsTableExists) {
      queries.push(
        safeCountQuery("SELECT COALESCE(SUM(amount), 0) as total FROM school_payments").then(r => ({ key: 'totalPayments', value: r })),
        safeCountQuery("SELECT COALESCE(SUM(amount), 0) as total FROM school_payments WHERE status = 'pago'").then(r => ({ key: 'paidPayments', value: r })),
        safeCountQuery("SELECT COALESCE(SUM(amount), 0) as total FROM school_payments WHERE status = 'pendente'").then(r => ({ key: 'pendingPayments', value: r })),
        safeCountQuery("SELECT COALESCE(SUM(amount), 0) as total FROM school_payments WHERE status IN ('atrasado', 'vencido')").then(r => ({ key: 'overduePayments', value: r }))
      );
    } else {
      queries.push(
        Promise.resolve({ key: 'totalPayments', value: { total: 0 } }),
        Promise.resolve({ key: 'paidPayments', value: { total: 0 } }),
        Promise.resolve({ key: 'pendingPayments', value: { total: 0 } }),
        Promise.resolve({ key: 'overduePayments', value: { total: 0 } })
      );
    }

    // Executar todas as queries
    const results = await Promise.all(queries);

    // Construir objeto de estatísticas
    const statsData = {};
    results.forEach(({ key, value }) => {
      statsData[key] = value;
    });

    console.log("[v0] Estatísticas gerais calculadas com sucesso");
    res.json(statsData);
  } catch (error) {
    console.error("[v0] Erro ao buscar estatísticas:", error);
    res.status(500).json({ 
      error: "Erro ao buscar estatísticas",
      details: error.message,
      // Retornar valores padrão para não quebrar o frontend
      totalSchools: { count: 0 },
      activeSchools: { count: 0 },
      totalAdmins: { count: 0 },
      totalUsers: { count: 0 },
      totalPayments: { total: 0 },
      paidPayments: { total: 0 },
      pendingPayments: { total: 0 },
      overduePayments: { total: 0 }
    });
  }
};
