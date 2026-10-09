import db from '../config/db.js';
import { gerarDespesasSalariosDoMes } from './dashboardController.js';

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

const CARGOS_COMUNS = [
  'Segurança', 'Limpeza', 'Cozinha', 'Secretária', 'Bibliotecário(a)',
  'Motorista', 'Porteiro(a)', 'Assistente Administrativo', 'Contabilista', 'Outro',
];

const TIPOS_CONTRATO = ['Efetivo', 'Termo Certo', 'Termo Incerto', 'Estágio', 'Prestação de Serviços'];

export const ensureFuncionariosTableExists = async () => {
  await queryAsync(`
    CREATE TABLE IF NOT EXISTS funcionarios (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL,
      nome VARCHAR(255) NOT NULL,
      cargo VARCHAR(100) NOT NULL,
      nuit VARCHAR(20) NULL,
      telefone VARCHAR(50) NULL,
      email VARCHAR(255) NULL,
      salario DECIMAL(12,2) NOT NULL DEFAULT 0,
      tipo_contrato VARCHAR(30) NOT NULL DEFAULT 'Efetivo',
      data_admissao DATE NULL,
      ativo TINYINT(1) NOT NULL DEFAULT 1,
      observacoes TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_school (school_id),
      KEY idx_ativo (ativo)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // ⚠️ CREATE TABLE IF NOT EXISTS não faz nada se `funcionarios` já existir a
  // partir de uma versão anterior sem estas colunas. Sem isto, criar/editar
  // um funcionário falhava com "Unknown column 'nuit'" em bases de dados já
  // em produção. Mesmo padrão de auto-migração usado no resto do sistema.
  const funcionariosColunasNovas = [
    { nome: 'nuit', ddl: "ADD COLUMN nuit VARCHAR(20) NULL AFTER cargo" },
    { nome: 'tipo_contrato', ddl: "ADD COLUMN tipo_contrato VARCHAR(30) NOT NULL DEFAULT 'Efetivo' AFTER salario" },
    { nome: 'data_admissao', ddl: "ADD COLUMN data_admissao DATE NULL AFTER tipo_contrato" },
    { nome: 'observacoes', ddl: "ADD COLUMN observacoes TEXT NULL AFTER data_admissao" },
  ];
  for (const coluna of funcionariosColunasNovas) {
    if (!(await columnExists('funcionarios', coluna.nome))) {
      try {
        await queryAsync(`ALTER TABLE funcionarios ${coluna.ddl}`);
      } catch (err) {
        if (err.code !== 'ER_DUP_FIELDNAME') throw err;
      }
    }
  }
};

// GET /schools/:schoolId/funcionarios
export const getFuncionarios = async (req, res) => {
  try {
    await ensureFuncionariosTableExists();
    const { schoolId } = req.params;
    const { status = 'ativos' } = req.query;

    const filtroAtivo = status === 'arquivados' ? 0 : status === 'todos' ? null : 1;
    const where = filtroAtivo === null ? 'WHERE school_id = ?' : 'WHERE school_id = ? AND ativo = ?';
    const params = filtroAtivo === null ? [schoolId] : [schoolId, filtroAtivo];

    const funcionarios = await queryAsync(
      `SELECT * FROM funcionarios ${where} ORDER BY nome ASC`,
      params
    );

    const statsRows = await queryAsync(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN ativo = 1 THEN 1 ELSE 0 END) as ativos,
         SUM(CASE WHEN ativo = 1 THEN salario ELSE 0 END) as folha_salarial
       FROM funcionarios WHERE school_id = ?`,
      [schoolId]
    );

    res.json({
      success: true,
      data: funcionarios,
      stats: {
        total: statsRows[0]?.total || 0,
        ativos: statsRows[0]?.ativos || 0,
        folha_salarial: parseFloat(statsRows[0]?.folha_salarial || 0),
      },
      cargos_sugeridos: CARGOS_COMUNS,
      tipos_contrato: TIPOS_CONTRATO,
    });
  } catch (err) {
    console.error('[v0] Erro ao listar funcionários:', err);
    res.status(500).json({ success: false, message: 'Erro ao listar funcionários', error: err.message });
  }
};

// POST /schools/:schoolId/funcionarios
export const createFuncionario = async (req, res) => {
  try {
    await ensureFuncionariosTableExists();
    const { schoolId } = req.params;
    const { nome, cargo, nuit, telefone, email, salario, tipo_contrato, data_admissao, observacoes } = req.body;

    if (!nome?.trim() || !cargo?.trim()) {
      return res.status(400).json({ success: false, message: 'Nome e cargo são obrigatórios' });
    }
    // Salário passou a ser obrigatório: todo funcionário cadastrado entra
    // automaticamente na folha salarial (lançada como despesa todo mês — ver
    // gerarDespesasSalariosDoMes). Sem um salário definido não há despesa a
    // gerar, por isso já não se aceita 0/vazio aqui (mesma regra já aplicada
    // a professores em teacherController.js).
    const salarioNum = parseFloat(salario);
    if (!salario || isNaN(salarioNum) || salarioNum <= 0) {
      return res.status(400).json({ success: false, message: 'Indique o salário do funcionário — é usado para lançar a folha salarial automaticamente todo mês.' });
    }
    if (nuit && !/^\d{9}$/.test(String(nuit).trim())) {
      return res.status(400).json({ success: false, message: 'NUIT deve ter 9 dígitos' });
    }

    const inserido = await queryAsync(
      `INSERT INTO funcionarios (school_id, nome, cargo, nuit, telefone, email, salario, tipo_contrato, data_admissao, observacoes, ativo, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW(), NOW())`,
      [schoolId, nome.trim(), cargo.trim(), nuit || null, telefone || null, email || null, salarioNum, tipo_contrato || 'Efetivo', data_admissao || null, observacoes || null]
    );

    // Gera já a despesa deste mês (categoria "Salários"), em vez de esperar
    // pelo cron diário — assim o admin vê o impacto financeiro imediatamente
    // ao cadastrar. Idempotente, e uma falha aqui não deve impedir o cadastro.
    try {
      await gerarDespesasSalariosDoMes(schoolId);
    } catch (erroDespesa) {
      console.error('[v0] Funcionário cadastrado, mas falhou ao gerar a despesa de salário do mês:', erroDespesa.message);
    }

    res.status(201).json({ success: true, message: 'Funcionário cadastrado com sucesso', id: inserido.insertId });
  } catch (err) {
    console.error('[v0] Erro ao cadastrar funcionário:', err);
    res.status(500).json({ success: false, message: 'Erro ao cadastrar funcionário', error: err.message });
  }
};

// PUT /schools/:schoolId/funcionarios/:id
export const updateFuncionario = async (req, res) => {
  try {
    await ensureFuncionariosTableExists();
    const { schoolId, id } = req.params;
    const { nome, cargo, nuit, telefone, email, salario, tipo_contrato, data_admissao, observacoes } = req.body;

    if (!nome?.trim() || !cargo?.trim()) {
      return res.status(400).json({ success: false, message: 'Nome e cargo são obrigatórios' });
    }
    const salarioNum = parseFloat(salario);
    if (!salario || isNaN(salarioNum) || salarioNum <= 0) {
      return res.status(400).json({ success: false, message: 'Indique o salário do funcionário — é usado para lançar a folha salarial automaticamente todo mês.' });
    }
    if (nuit && !/^\d{9}$/.test(String(nuit).trim())) {
      return res.status(400).json({ success: false, message: 'NUIT deve ter 9 dígitos' });
    }

    const resultado = await queryAsync(
      `UPDATE funcionarios SET nome=?, cargo=?, nuit=?, telefone=?, email=?, salario=?, tipo_contrato=?, data_admissao=?, observacoes=?, updated_at=NOW()
       WHERE id=? AND school_id=?`,
      [nome.trim(), cargo.trim(), nuit || null, telefone || null, email || null, salarioNum, tipo_contrato || 'Efetivo', data_admissao || null, observacoes || null, id, schoolId]
    );

    if (resultado.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Funcionário não encontrado' });
    }

    // Se o salário mudou (ou ainda não havia despesa deste mês), garante que
    // a despesa do mês corrente já reflete o valor atualizado na próxima
    // consulta — o próprio gerarDespesasSalariosDoMes é idempotente, então só
    // cria se ainda não existir uma despesa de salário para este funcionário
    // neste mês; não duplica nem corrige retroativamente meses já lançados.
    try {
      await gerarDespesasSalariosDoMes(schoolId);
    } catch (erroDespesa) {
      console.error('[v0] Funcionário atualizado, mas falhou ao gerar/verificar a despesa de salário do mês:', erroDespesa.message);
    }

    res.json({ success: true, message: 'Funcionário atualizado com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao atualizar funcionário:', err);
    res.status(500).json({ success: false, message: 'Erro ao atualizar funcionário', error: err.message });
  }
};

// PUT /schools/:schoolId/funcionarios/:id/status — arquivar/reativar (soft delete, como em students)
export const toggleFuncionarioStatus = async (req, res) => {
  try {
    await ensureFuncionariosTableExists();
    const { schoolId, id } = req.params;
    const { ativo } = req.body;

    const resultado = await queryAsync(
      `UPDATE funcionarios SET ativo=?, updated_at=NOW() WHERE id=? AND school_id=?`,
      [ativo ? 1 : 0, id, schoolId]
    );
    if (resultado.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Funcionário não encontrado' });
    }

    // Reativado a meio do mês → já entra na despesa deste mês, se ainda não
    // tiver sido lançada. Arquivar não remove despesas já lançadas: isso é
    // histórico. A partir do arquivamento é que deixa de gerar despesas
    // futuras (gerarDespesasSalariosDoMes só considera ativo = 1).
    if (ativo) {
      try {
        await gerarDespesasSalariosDoMes(schoolId);
      } catch (erroDespesa) {
        console.error('[v0] Funcionário reativado, mas falhou ao gerar a despesa de salário do mês:', erroDespesa.message);
      }
    }

    res.json({ success: true, message: ativo ? 'Funcionário reativado' : 'Funcionário arquivado' });
  } catch (err) {
    console.error('[v0] Erro ao atualizar status do funcionário:', err);
    res.status(500).json({ success: false, message: 'Erro ao atualizar status', error: err.message });
  }
};

// DELETE /schools/:schoolId/funcionarios/:id — remoção definitiva
export const deleteFuncionario = async (req, res) => {
  try {
    await ensureFuncionariosTableExists();
    const { schoolId, id } = req.params;
    const resultado = await queryAsync(`DELETE FROM funcionarios WHERE id=? AND school_id=?`, [id, schoolId]);
    if (resultado.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Funcionário não encontrado' });
    }
    res.json({ success: true, message: 'Funcionário removido com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao remover funcionário:', err);
    res.status(500).json({ success: false, message: 'Erro ao remover funcionário', error: err.message });
  }
};
