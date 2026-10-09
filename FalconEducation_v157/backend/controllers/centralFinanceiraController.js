import db from '../config/db.js';
import { calcularInteligenciaFinanceira } from '../services/financialForecastService.js';
import { gerarRelatorioFinanceiro, gerarRelatorioFinanceiroPDF } from '../services/relatorioFinanceiroService.js';
import { garantirDespesasDoMesAtual } from './dashboardController.js';

const queryAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.query(sql, params, (err, results) => {
    if (err) return reject(err);
    resolve(results);
  });
});

const primeiroDiaDoMes = () => {
  const hoje = new Date();
  return new Date(hoje.getFullYear(), hoje.getMonth(), 1).toISOString().split('T')[0];
};
const ultimoDiaDoMes = () => {
  const hoje = new Date();
  return new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).toISOString().split('T')[0];
};

// Classifica o `tipo` da mensalidade (texto livre configurado pelo admin em
// `mensalidades.tipo`) numa das categorias de receita da Central Financeira.
const categorizarReceita = (tipo) => {
  const t = (tipo || '').toLowerCase();
  if (t.includes('renov')) return 'renovacao';
  if (t.includes('matric') || t.includes('inscri')) return 'matriculas';
  if (t.includes('mensalidade')) return 'mensalidades';
  return 'outros';
};

// Classifica a `categoria` da despesa (texto livre em `despesas.categoria`)
// numa das categorias de despesa da Central Financeira. Categorias antigas
// como "Serviços" (que agrupava água+luz+internet antes desta atualização)
// caem em "outros", porque não há como separar retroativamente o valor.
const categorizarDespesa = (categoria) => {
  const c = (categoria || '').toLowerCase();
  if (c.includes('salário') || c.includes('salario')) return 'salarios';
  if (c.includes('energia') || c.includes('eletricidade') || c.includes('luz')) return 'energia';
  if (c.includes('água') || c.includes('agua')) return 'agua';
  if (c.includes('internet')) return 'internet';
  if (c.includes('manutenç') || c.includes('manutenc')) return 'manutencao';
  if (c.includes('material')) return 'material';
  if (c.includes('transporte')) return 'transporte';
  return 'outros';
};

// ═══════════════════════════════════════════════════════════════════════════════
// CENTRAL FINANCEIRA — GET /schools/:schoolId/financeiro/central?inicio=&fim=
// Receitas (mensalidades, matrículas, renovação, multas, outros) · Despesas
// (salários, energia, água, internet, manutenção, material, transporte,
// outros) · Resultado (receita - despesa). Período padrão: mês atual.
// ═══════════════════════════════════════════════════════════════════════════════
export const getCentralFinanceira = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const inicio = req.query.inicio || primeiroDiaDoMes();
    const fim = req.query.fim || ultimoDiaDoMes();

    // v155 — garante que o mês corrente (salários + despesas recorrentes
    // manuais) já está lançado em `despesas` antes de somar, para este
    // ecrã nunca mostrar um total de despesas mais baixo do que o Dashboard
    // para o mesmo mês só por causa do horário em que cada um foi aberto em
    // relação ao cron diário — ver garantirDespesasDoMesAtual em
    // dashboardController.js. Sem efeito em períodos que não incluam o mês
    // corrente (os geradores só lançam despesas com data de hoje).
    await garantirDespesasDoMesAtual(schoolId);

    // ── RECEITAS: pagamentos confirmados (status = 'pago') no período ───────
    const linhasReceita = await queryAsync(
      `
        SELECT m.tipo, SUM(sp.valor_pago - COALESCE(sp.multa, 0)) as valor_principal, SUM(COALESCE(sp.multa, 0)) as valor_multa, COUNT(*) as qtd
        FROM student_payments sp
        JOIN mensalidades m ON m.id = sp.mensalidade_id
        WHERE sp.school_id = ? AND sp.status = 'pago' AND sp.data_pagamento BETWEEN ? AND ?
        GROUP BY m.tipo
      `,
      [schoolId, inicio, fim]
    );

    const receitas = { mensalidades: 0, matriculas: 0, renovacao: 0, multas: 0, outros: 0 };
    let qtdPagamentos = 0;
    linhasReceita.forEach((l) => {
      const categoria = categorizarReceita(l.tipo);
      receitas[categoria] += parseFloat(l.valor_principal || 0);
      receitas.multas += parseFloat(l.valor_multa || 0);
      qtdPagamentos += l.qtd || 0;
    });
    const totalReceitas = Object.values(receitas).reduce((s, v) => s + v, 0);

    // ── DESPESAS no período ──────────────────────────────────────────────────
    const linhasDespesa = await queryAsync(
      `SELECT categoria, SUM(valor) as total, COUNT(*) as qtd FROM despesas WHERE school_id = ? AND data_despesa BETWEEN ? AND ? GROUP BY categoria`,
      [schoolId, inicio, fim]
    );

    const despesas = { salarios: 0, energia: 0, agua: 0, internet: 0, manutencao: 0, material: 0, transporte: 0, outros: 0 };
    let qtdDespesas = 0;
    linhasDespesa.forEach((l) => {
      const categoria = categorizarDespesa(l.categoria);
      despesas[categoria] += parseFloat(l.total || 0);
      qtdDespesas += l.qtd || 0;
    });
    const totalDespesas = Object.values(despesas).reduce((s, v) => s + v, 0);

    // ── EVOLUÇÃO MENSAL (últimos 6 meses) — receita vs despesa, para gráfico ─
    const evolucaoReceita = await queryAsync(
      `
        SELECT DATE_FORMAT(data_pagamento, '%Y-%m') as mes, COALESCE(SUM(valor_pago), 0) as total
        FROM student_payments
        WHERE school_id = ? AND status = 'pago' AND data_pagamento >= CURDATE() - INTERVAL 6 MONTH
        GROUP BY DATE_FORMAT(data_pagamento, '%Y-%m') ORDER BY mes ASC
      `,
      [schoolId]
    );
    const evolucaoDespesa = await queryAsync(
      `
        SELECT DATE_FORMAT(data_despesa, '%Y-%m') as mes, COALESCE(SUM(valor), 0) as total
        FROM despesas WHERE school_id = ? AND data_despesa >= CURDATE() - INTERVAL 6 MONTH
        GROUP BY DATE_FORMAT(data_despesa, '%Y-%m') ORDER BY mes ASC
      `,
      [schoolId]
    );
    const mesesUnicos = [...new Set([...evolucaoReceita.map((l) => l.mes), ...evolucaoDespesa.map((l) => l.mes)])].sort();
    const evolucao = mesesUnicos.map((mes) => ({
      mes,
      receita: parseFloat(evolucaoReceita.find((l) => l.mes === mes)?.total || 0),
      despesa: parseFloat(evolucaoDespesa.find((l) => l.mes === mes)?.total || 0),
    }));

    res.json({
      success: true,
      periodo: { inicio, fim },
      receitas: { ...receitas, total: totalReceitas, qtd_pagamentos: qtdPagamentos },
      despesas: { ...despesas, total: totalDespesas, qtd_lancamentos: qtdDespesas },
      resultado: Number((totalReceitas - totalDespesas).toFixed(2)),
      evolucao,
    });
  } catch (err) {
    console.error('[v0] Erro ao montar Central Financeira:', err);
    res.status(500).json({ success: false, message: 'Erro ao montar Central Financeira', error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// FINANCIAL INTELLIGENCE — GET /schools/:schoolId/financeiro/inteligencia
// Receita esperada vs recebida, previsão de recebimento, risco de
// incumprimento e o top de famílias com maior probabilidade de atraso.
// Lógica do cálculo em services/financialForecastService.js.
// ═══════════════════════════════════════════════════════════════════════════════
export const getInteligenciaFinanceira = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const inicio = req.query.inicio || primeiroDiaDoMes();
    const fim = req.query.fim || ultimoDiaDoMes();

    const inteligencia = await calcularInteligenciaFinanceira(schoolId, { inicio, fim });
    res.json({ success: true, ...inteligencia });
  } catch (err) {
    console.error('[v0] Erro ao calcular Financial Intelligence:', err);
    res.status(500).json({ success: false, message: 'Erro ao calcular inteligência financeira', error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// RELATÓRIO FINANCEIRO DO PERÍODO — v101
// GET /schools/:schoolId/financeiro/relatorio?inicio=&fim=      → JSON, para o ecrã
// GET /schools/:schoolId/financeiro/relatorio/pdf?inicio=&fim=  → download em PDF
// Documento auditável: detalha, recibo a recibo, tudo o que foi cobrado no
// período em Taxa de Inscrição, Taxa de Renovação e Mensalidades, além do
// resumo de despesas. Lógica completa em services/relatorioFinanceiroService.js.
// ═══════════════════════════════════════════════════════════════════════════════
export const getRelatorioFinanceiro = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const inicio = req.query.inicio || primeiroDiaDoMes();
    const fim = req.query.fim || ultimoDiaDoMes();
    await garantirDespesasDoMesAtual(schoolId);
    const relatorio = await gerarRelatorioFinanceiro(schoolId, { inicio, fim });
    res.json({ success: true, ...relatorio });
  } catch (err) {
    console.error('[v0] Erro ao gerar Relatório Financeiro:', err);
    res.status(500).json({ success: false, message: 'Não foi possível gerar o Relatório Financeiro agora.', error: err.message });
  }
};

export const baixarRelatorioFinanceiroPDF = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const inicio = req.query.inicio || primeiroDiaDoMes();
    const fim = req.query.fim || ultimoDiaDoMes();
    await garantirDespesasDoMesAtual(schoolId);
    await gerarRelatorioFinanceiroPDF(res, schoolId, { inicio, fim });
  } catch (err) {
    console.error('[v0] Erro ao gerar o PDF do Relatório Financeiro:', err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Não foi possível gerar o PDF do Relatório Financeiro agora.', error: err.message });
    } else {
      res.end();
    }
  }
};
