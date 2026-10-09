import db from '../config/db.js';
import { getRadarConfig, classificarPercentual, percentual } from '../services/radarConfigService.js';
import { obterMinhasPermissoes } from '../services/permissionService.js';

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


// ═══════════════════════════════════════════════════════════════════════════════
// TABELAS NOVAS: despesas (para calcular o lucro) e eventos escolares
// ═══════════════════════════════════════════════════════════════════════════════
export const ensureTabelas = memoize(async () => {
  await queryAsync(`
    CREATE TABLE IF NOT EXISTS despesas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL,
      descricao VARCHAR(255) NOT NULL,
      categoria VARCHAR(50) NOT NULL DEFAULT 'Outros',
      valor DECIMAL(12,2) NOT NULL,
      data_despesa DATE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_school_data (school_id, data_despesa)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Colunas usadas para rastrear despesas geradas automaticamente (ex.: folha
  // salarial mensal de professores/funcionários) e não confundi-las com
  // despesas lançadas manualmente pelo admin — ver gerarDespesasSalariosDoMes.
  if (!(await columnExists('despesas', 'origem'))) {
    await queryAsync(`ALTER TABLE despesas ADD COLUMN origem VARCHAR(20) NOT NULL DEFAULT 'manual' AFTER valor`);
  }
  if (!(await columnExists('despesas', 'referencia_tipo'))) {
    await queryAsync(`ALTER TABLE despesas ADD COLUMN referencia_tipo VARCHAR(20) NULL AFTER origem`);
  }
  if (!(await columnExists('despesas', 'referencia_id'))) {
    await queryAsync(`ALTER TABLE despesas ADD COLUMN referencia_id INT NULL AFTER referencia_tipo`);
  }

  // ── RECORRÊNCIA DE DESPESAS ────────────────────────────────────────────
  // Uma despesa lançada manualmente pode ser:
  //  - 'unica'          → só este mês (comportamento antigo, continua default)
  //  - 'temporaria'      → repete todo mês por N meses (ex.: 12 = "por um ano")
  //  - 'indeterminada'   → repete todo mês até o admin cancelar
  // A linha original criada pelo admin é a "regra" (regra_origem_id = NULL).
  // Cada mês seguinte gerado automaticamente é uma "cópia" com
  // regra_origem_id apontando para a regra — assim o histórico de cada mês
  // fica preservado mesmo que a regra seja cancelada mais tarde. `ativa`
  // controla se a regra ainda deve gerar os próximos meses.
  if (!(await columnExists('despesas', 'recorrencia'))) {
    await queryAsync(`ALTER TABLE despesas ADD COLUMN recorrencia VARCHAR(20) NOT NULL DEFAULT 'unica' AFTER referencia_id`);
  }
  // v107 — periodicidade da recorrência: 'mensal' (repete todo mês, como
  // sempre foi) ou 'anual' (repete uma vez por ano, no mês de aniversário
  // da regra — ex.: seguro anual, licença de software anual). Só se aplica
  // quando recorrencia é 'temporaria' ou 'indeterminada'; para 'unica' fica
  // sempre 'mensal' por não ter efeito. meses_duracao continua a guardar a
  // duração no formato correspondente à periodicidade (meses OU anos — ver
  // createDespesa e gerarDespesasRecorrentesDoMes).
  if (!(await columnExists('despesas', 'periodicidade'))) {
    await queryAsync(`ALTER TABLE despesas ADD COLUMN periodicidade VARCHAR(10) NOT NULL DEFAULT 'mensal' AFTER recorrencia`);
  }
  if (!(await columnExists('despesas', 'meses_duracao'))) {
    await queryAsync(`ALTER TABLE despesas ADD COLUMN meses_duracao INT NULL AFTER recorrencia`);
  }
  if (!(await columnExists('despesas', 'data_fim_recorrencia'))) {
    await queryAsync(`ALTER TABLE despesas ADD COLUMN data_fim_recorrencia DATE NULL AFTER meses_duracao`);
  }
  if (!(await columnExists('despesas', 'regra_origem_id'))) {
    await queryAsync(`ALTER TABLE despesas ADD COLUMN regra_origem_id INT NULL AFTER data_fim_recorrencia`);
  }
  if (!(await columnExists('despesas', 'ativa'))) {
    await queryAsync(`ALTER TABLE despesas ADD COLUMN ativa TINYINT(1) NOT NULL DEFAULT 1 AFTER regra_origem_id`);
  }

  await queryAsync(`
    CREATE TABLE IF NOT EXISTS eventos_escolares (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL,
      titulo VARCHAR(255) NOT NULL,
      categoria VARCHAR(30) NOT NULL DEFAULT 'evento',
      data_evento DATE NOT NULL,
      descricao TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_school_data (school_id, data_evento)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Colunas usadas pela aba Calendário: em que classe/trimestre o evento se
  // insere (ex.: uma ACP é só da 5ª classe, no 2º trimestre) e o horário exato
  // (usado sobretudo para testes/ACP, para disponibilizar aos alunos).
  if (!(await columnExists('eventos_escolares', 'classe_id'))) {
    await queryAsync(`ALTER TABLE eventos_escolares ADD COLUMN classe_id INT NULL AFTER categoria`);
  }
  if (!(await columnExists('eventos_escolares', 'trimestre'))) {
    await queryAsync(`ALTER TABLE eventos_escolares ADD COLUMN trimestre TINYINT NULL AFTER classe_id`);
  }
  if (!(await columnExists('eventos_escolares', 'data_fim'))) {
    await queryAsync(`ALTER TABLE eventos_escolares ADD COLUMN data_fim DATE NULL AFTER data_evento`);
  }
  if (!(await columnExists('eventos_escolares', 'hora_inicio'))) {
    await queryAsync(`ALTER TABLE eventos_escolares ADD COLUMN hora_inicio TIME NULL AFTER data_fim`);
  }
  if (!(await columnExists('eventos_escolares', 'hora_fim'))) {
    await queryAsync(`ALTER TABLE eventos_escolares ADD COLUMN hora_fim TIME NULL AFTER hora_inicio`);
  }
});

// Categorias aceites no calendário. 'feriado' = feriados nacionais de Moçambique
// (semeados automaticamente, ver semearFeriadosMocambique); 'acp' e 'teste' são
// as datas de avaliação que a escola define manualmente, com horário, por
// classe — ficam visíveis para os alunos e servem de referência para alinhar a
// renovação trimestral (ver verificarCooldownRenovacao em renewalController.js).
const CATEGORIAS_VALIDAS = ['evento', 'exame', 'teste', 'acp', 'reuniao', 'feriado'];

// ═══════════════════════════════════════════════════════════════════════════════
// FERIADOS NACIONAIS DE MOÇAMBIQUE — datas fixas anuais (não inclui feriados
// móveis). Semeados uma vez por ano/escola (idempotente).
// ═══════════════════════════════════════════════════════════════════════════════
const FERIADOS_MOCAMBIQUE = [
  { dia: '01-01', titulo: 'Ano Novo' },
  { dia: '02-03', titulo: 'Dia dos Heróis Moçambicanos' },
  { dia: '04-07', titulo: 'Dia da Mulher Moçambicana' },
  { dia: '05-01', titulo: 'Dia Internacional dos Trabalhadores' },
  { dia: '06-25', titulo: 'Dia da Independência Nacional' },
  { dia: '09-07', titulo: 'Dia da Vitória' },
  { dia: '09-25', titulo: 'Dia das Forças Armadas de Libertação Nacional' },
  { dia: '10-04', titulo: 'Dia da Paz e Reconciliação' },
  { dia: '12-25', titulo: 'Dia da Família (Natal)' },
];

export const semearFeriadosMocambique = async (schoolId, ano) => {
  await ensureTabelas();
  const anoAlvo = parseInt(ano, 10) || new Date().getFullYear();

  const existentes = await queryAsync(
    `SELECT COUNT(*) as total FROM eventos_escolares WHERE school_id = ? AND categoria = 'feriado' AND YEAR(data_evento) = ?`,
    [schoolId, anoAlvo]
  );
  if (existentes[0]?.total > 0) return { criados: 0, ja_existiam: true };

  for (const feriado of FERIADOS_MOCAMBIQUE) {
    await queryAsync(
      `INSERT INTO eventos_escolares (school_id, titulo, categoria, data_evento, descricao, created_at) VALUES (?, ?, 'feriado', ?, ?, NOW())`,
      [schoolId, feriado.titulo, `${anoAlvo}-${feriado.dia}`, 'Feriado nacional de Moçambique']
    );
  }
  return { criados: FERIADOS_MOCAMBIQUE.length, ja_existiam: false };
};

export const seedFeriados = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const { ano } = req.query;
    const resultado = await semearFeriadosMocambique(schoolId, ano);
    res.json({ success: true, ...resultado });
  } catch (err) {
    console.error('[v0] Erro ao semear feriados:', err);
    res.status(500).json({ success: false, message: 'Erro ao adicionar feriados nacionais', error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// v136 — VISIBILIDADE DAS DESPESAS RECENTES (só o Diretor pode alterar)
// ─────────────────────────────────────────────────────────────────────────────
// A escola pode querer que o card "Despesas Recentes" do Painel Principal não
// fique visível a QUALQUER conta de administrador (ex.: uma conta de
// Secretaria ou Coordenação Pedagógica que também acede ao painel) — só ao
// Diretor. Reaproveita o sistema de perfis já existente (permissionService.js
// — perfil_id = NULL numa conta de school_admins já é tratado em todo o
// resto do código como "acesso total", equivalente ao Diretor): a mesma regra
// decide aqui quem pode VER a lista quando ocultada e quem pode LIGAR/DESLIGAR
// esta configuração — nunca é preciso inventar um papel "Diretor" à parte.
// ═══════════════════════════════════════════════════════════════════════════════
export const ensureDespesasConfigTable = memoize(async () => {
  await queryAsync(`
    CREATE TABLE IF NOT EXISTS despesas_config (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL UNIQUE,
      ocultar_despesas_recentes TINYINT(1) NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      updated_by_admin_id INT NULL,
      updated_by_nome VARCHAR(150) NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
});

const getConfigDespesas = async (schoolId) => {
  await ensureDespesasConfigTable();
  const linhas = await queryAsync(`SELECT ocultar_despesas_recentes FROM despesas_config WHERE school_id = ? LIMIT 1`, [schoolId]);
  return { ocultar_despesas_recentes: linhas.length > 0 ? !!linhas[0].ocultar_despesas_recentes : false };
};

// Diretor = conta sem perfil restrito atribuído (perfil_id NULL, "acesso
// total") — mesma equivalência já usada no resto do sistema de permissões.
// Contas superadmin (fora do papel 'schooladmin') não passam por aqui: as
// rotas de despesas exigem verifySchoolAccess, que já as filtra.
const contaEhDiretor = async (req) => {
  if (req.user?.role !== 'schooladmin') return false;
  const resultado = await obterMinhasPermissoes({ schoolId: req.params.schoolId, contaAdminId: req.user.id });
  return !!resultado.acesso_total;
};

// GET /schools/:schoolId/despesas/config
export const getDespesasConfig = async (req, res) => {
  try {
    const config = await getConfigDespesas(req.params.schoolId);
    const podeAlterar = await contaEhDiretor(req);
    res.json({ success: true, ...config, pode_alterar: podeAlterar });
  } catch (err) {
    console.error('[v0] Erro ao carregar configuração de despesas:', err);
    res.status(500).json({ success: false, message: 'Erro ao carregar configuração de despesas', error: err.message });
  }
};

// PUT /schools/:schoolId/despesas/config — só o Diretor (acesso total) pode alterar
export const atualizarDespesasConfig = async (req, res) => {
  try {
    await ensureDespesasConfigTable();
    const { schoolId } = req.params;
    const podeAlterar = await contaEhDiretor(req);
    if (!podeAlterar) {
      return res.status(403).json({ success: false, message: 'Só o Diretor (conta com acesso total) pode alterar a visibilidade das Despesas Recentes.' });
    }
    const ocultar = !!req.body.ocultar_despesas_recentes;
    await queryAsync(
      `INSERT INTO despesas_config (school_id, ocultar_despesas_recentes, updated_at, updated_by_admin_id, updated_by_nome)
       VALUES (?, ?, NOW(), ?, ?)
       ON DUPLICATE KEY UPDATE ocultar_despesas_recentes = VALUES(ocultar_despesas_recentes), updated_at = NOW(), updated_by_admin_id = VALUES(updated_by_admin_id), updated_by_nome = VALUES(updated_by_nome)`,
      [schoolId, ocultar ? 1 : 0, req.user?.id || null, req.user?.nome || null]
    );
    res.json({ success: true, ocultar_despesas_recentes: ocultar });
  } catch (err) {
    console.error('[v0] Erro ao atualizar configuração de despesas:', err);
    res.status(500).json({ success: false, message: 'Erro ao atualizar configuração de despesas', error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// DESPESAS — simples, para permitir calcular o lucro real (receita - despesas)
// ═══════════════════════════════════════════════════════════════════════════════
// v155 — ponto único que garante que as despesas do MÊS CORRENTE (folha
// salarial + regras recorrentes manuais ativas) já estão lançadas em
// `despesas` antes de qualquer leitura que some ou liste despesas deste mês.
// Sem isto, cada endpoint dependia só do cron diário (app.js) já ter corrido
// hoje — o que nem sempre acontece (escola nova, servidor reiniciado, admin
// entra às 6h e o cron corre às 6h10, etc.). Antes desta correção, só o
// resumo do Dashboard chamava gerarDespesasSalariosDoMes (e nem essa chamava
// gerarDespesasRecorrentesDoMes), pelo que a Central Financeira, o Relatório
// Financeiro e a própria lista de "Despesas Recentes" podiam mostrar um total
// mais baixo do que o Dashboard para o MESMO mês — dois números diferentes
// para a mesma pergunta. Chamado de forma idempotente (cada gerador já
// verifica "já existe este mês?" antes de inserir), por isso é seguro chamar
// em todos os pontos de leitura sem risco de duplicar lançamentos.
export const garantirDespesasDoMesAtual = async (schoolId) => {
  try {
    await gerarDespesasSalariosDoMes(schoolId);
  } catch (e) {
    console.error('[v0] Falha ao garantir despesas de salário do mês:', e.message);
  }
  try {
    await gerarDespesasRecorrentesDoMes(schoolId);
  } catch (e) {
    console.error('[v0] Falha ao garantir despesas recorrentes manuais do mês:', e.message);
  }
};

export const getDespesas = async (req, res) => {
  try {

    await ensureTabelas();
    const { schoolId } = req.params;
    const { limit = 20, mes_atual: mesAtual } = req.query;

    // v155 — garante que o mês corrente já está completo (salários + regras
    // recorrentes manuais) antes de listar, para esta lista bater sempre
    // certo com "Despesas do Mês" do Dashboard — ver garantirDespesasDoMesAtual.
    await garantirDespesasDoMesAtual(schoolId);

    // v136 — se o Diretor ocultou as Despesas Recentes e quem está a pedir
    // não é o próprio Diretor (acesso total), devolve a lista vazia e um
    // aviso — nunca os valores reais, mesmo que o pedido especifique um
    // limite maior. A escolha de esconder é feita nas Configurações.
    const config = await getConfigDespesas(schoolId);
    const podeVer = !config.ocultar_despesas_recentes || (await contaEhDiretor(req));
    if (!podeVer) {
      return res.json({
        success: true,
        data: [],
        total: 0,
        resumo_recorrencia: {
          salarios: { qtd: 0, total: 0 },
          recorrentes_manuais: { qtd: 0, total: 0 },
          recorrentes_anuais: { qtd: 0, total: 0 },
        },
        despesas_ocultas: true,
      });
    }

    // v155 — mes_atual=1: devolve TODOS os lançamentos do mês corrente (sem
    // limite), para o extrato que justifica o KPI "Despesas do Mês" no
    // Dashboard — a soma desta lista tem de bater exatamente com esse valor.
    // Sem este modo, `getDespesas` só devolve os últimos N lançamentos de
    // sempre, que nem sempre são "todos os do mês atual" (uma escola com
    // poucas despesas por mês pode ter os últimos 15 a espalhar-se por vários
    // meses; uma escola com muitos funcionários pode ter mais de 15 só na
    // folha salarial deste mês).
    const despesas = mesAtual
      ? await queryAsync(
          `SELECT * FROM despesas WHERE school_id = ? AND MONTH(data_despesa) = MONTH(CURDATE()) AND YEAR(data_despesa) = YEAR(CURDATE())
           ORDER BY data_despesa DESC, id DESC`,
          [schoolId]
        )
      : await queryAsync(
          `SELECT * FROM despesas WHERE school_id = ? ORDER BY data_despesa DESC LIMIT ?`,
          [schoolId, parseInt(limit, 10)]
    );

    // Resumo do compromisso mensal recorrente (salários + regras manuais
    // ativas) — usado no Dashboard para o admin ver, de relance, quanto já
    // está "comprometido" todo mês antes mesmo de olhar o detalhamento.
    const [salariosRow] = await queryAsync(
      `SELECT COUNT(*) as qtd, COALESCE(SUM(salario), 0) as total FROM (
         SELECT salario FROM teachers WHERE school_id = ? AND ativo = 1 AND salario > 0
         UNION ALL
         SELECT salario FROM funcionarios WHERE school_id = ? AND ativo = 1 AND salario > 0
       ) t`,
      [schoolId, schoolId]
    );
    // v128 — exclui origem = 'salario': a folha salarial já é contada à parte
    // (salariosRow, acima, a partir de teachers/funcionarios). As despesas de
    // salário geradas automaticamente por gerarDespesasSalariosDoMes gravam
    // recorrencia = 'indeterminada' e periodicidade cai no default 'mensal',
    // então sem este filtro elas batiam também com esta query e o salário
    // aparecia somado duas vezes no Dashboard (uma vez em "Folha Salarial",
    // outra dentro de "Outras Despesas Recorrentes").
    const [recorrentesRow] = await queryAsync(
      `SELECT COUNT(*) as qtd, COALESCE(SUM(valor), 0) as total FROM despesas
       WHERE school_id = ? AND regra_origem_id IS NULL AND recorrencia IN ('temporaria', 'indeterminada') AND ativa = 1
         AND origem != 'salario'
         AND (periodicidade IS NULL OR periodicidade = 'mensal')
         AND (data_fim_recorrencia IS NULL OR CURDATE() <= data_fim_recorrencia)`,
      [schoolId]
    );
    // v107 — separado das mensais: o valor de uma regra anual não deve
    // somar-se ao "compromisso mensal" (senão o KPI fica inflacionado só
    // porque, por acaso, a escola tem um seguro anual). Mostrado à parte.
    // v128 — mesmo filtro origem != 'salario' aplicado aqui por consistência
    // (a folha salarial nunca é anual, mas evita o mesmo tipo de bug se a
    // geração de salários mudar no futuro).
    const [recorrentesAnuaisRow] = await queryAsync(
      `SELECT COUNT(*) as qtd, COALESCE(SUM(valor), 0) as total FROM despesas
       WHERE school_id = ? AND regra_origem_id IS NULL AND recorrencia IN ('temporaria', 'indeterminada') AND ativa = 1
         AND origem != 'salario'
         AND periodicidade = 'anual'
         AND (data_fim_recorrencia IS NULL OR CURDATE() <= data_fim_recorrencia)`,
      [schoolId]
    );

    res.json({
      success: true,
      data: despesas,
      // v155 — soma exata da lista devolvida, para o frontend confirmar (sem
      // ter de somar ele próprio) que o extrato bate certo com o total
      // mostrado. Quando mes_atual=1, é exatamente o mesmo valor de
      // financeiro.despesas_mes no resumo do Dashboard (mesma condição de
      // filtro e mesma garantia prévia via garantirDespesasDoMesAtual).
      total: parseFloat(despesas.reduce((soma, d) => soma + parseFloat(d.valor || 0), 0).toFixed(2)),
      resumo_recorrencia: {
        salarios: { qtd: salariosRow?.qtd || 0, total: parseFloat(salariosRow?.total || 0) },
        recorrentes_manuais: { qtd: recorrentesRow?.qtd || 0, total: parseFloat(recorrentesRow?.total || 0) },
        recorrentes_anuais: { qtd: recorrentesAnuaisRow?.qtd || 0, total: parseFloat(recorrentesAnuaisRow?.total || 0) },
      },
      despesas_ocultas: false,
    });
  } catch (err) {
    console.error('[v0] Erro ao listar despesas:', err);
    res.status(500).json({ success: false, message: 'Erro ao listar despesas', error: err.message });
  }
};

const RECORRENCIAS_VALIDAS = ['unica', 'temporaria', 'indeterminada'];
const PERIODICIDADES_VALIDAS = ['mensal', 'anual'];

export const createDespesa = async (req, res) => {
  try {
    await ensureTabelas();
    const { schoolId } = req.params;
    const { descricao, categoria, valor, data_despesa, recorrencia, periodicidade, meses_duracao } = req.body;

    if (!descricao?.trim() || !valor || parseFloat(valor) <= 0 || !data_despesa) {
      return res.status(400).json({ success: false, message: 'Descrição, valor e data são obrigatórios' });
    }

    const tipoRecorrencia = RECORRENCIAS_VALIDAS.includes(recorrencia) ? recorrencia : 'unica';
    // Periodicidade só faz sentido para regras recorrentes; despesa única
    // fica sempre 'mensal' por convenção (não tem efeito prático).
    const tipoPeriodicidade = tipoRecorrencia !== 'unica' && PERIODICIDADES_VALIDAS.includes(periodicidade) ? periodicidade : 'mensal';
    let duracao = null;
    let dataFimRecorrencia = null;

    if (tipoRecorrencia === 'temporaria') {
      duracao = parseInt(meses_duracao, 10);
      if (tipoPeriodicidade === 'anual') {
        if (!duracao || duracao < 1 || duracao > 10) {
          return res.status(400).json({ success: false, message: 'Indique por quantos anos esta despesa deve repetir (1 a 10).' });
        }
        const dataBase = new Date(`${data_despesa}T00:00:00`);
        const dataFim = new Date(dataBase);
        dataFim.setFullYear(dataFim.getFullYear() + duracao);
        dataFimRecorrencia = dataFim.toISOString().split('T')[0];
      } else {
        if (!duracao || duracao < 1 || duracao > 60) {
          return res.status(400).json({ success: false, message: 'Indique por quantos meses esta despesa deve repetir (1 a 60).' });
        }
        const dataBase = new Date(`${data_despesa}T00:00:00`);
        const dataFim = new Date(dataBase);
        dataFim.setMonth(dataFim.getMonth() + duracao);
        dataFimRecorrencia = dataFim.toISOString().split('T')[0];
      }
    }

    const inserida = await queryAsync(
      `INSERT INTO despesas (school_id, descricao, categoria, valor, data_despesa, origem, recorrencia, periodicidade, meses_duracao, data_fim_recorrencia, ativa, created_at)
       VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, 1, NOW())`,
      [schoolId, descricao.trim(), categoria || 'Outros', parseFloat(valor), data_despesa, tipoRecorrencia, tipoPeriodicidade, duracao, dataFimRecorrencia]
    );
    res.status(201).json({ success: true, message: 'Despesa registada com sucesso', id: inserida.insertId });
  } catch (err) {
    console.error('[v0] Erro ao registar despesa:', err);
    res.status(500).json({ success: false, message: 'Erro ao registar despesa', error: err.message });
  }
};

export const deleteDespesa = async (req, res) => {
  try {
    await ensureTabelas();
    const { schoolId, despesaId } = req.params;
    const existentes = await queryAsync(`SELECT origem, recorrencia, regra_origem_id, ativa FROM despesas WHERE id = ? AND school_id = ?`, [despesaId, schoolId]);
    if (existentes.length === 0) return res.status(404).json({ success: false, message: 'Despesa não encontrada' });
    const despesa = existentes[0];

    if (despesa.origem === 'salario') {
      return res.status(400).json({
        success: false,
        message: 'Esta despesa foi gerada automaticamente a partir da folha salarial e não pode ser apagada aqui. Para a remover, arquive o professor/funcionário correspondente antes do próximo mês.',
      });
    }
    // Uma "regra" de recorrência ainda ativa (raiz, sem regra_origem_id) não
    // pode ser apagada diretamente — isso apagaria a definição da recorrência
    // sem parar a geração dos próximos meses de forma explícita. O admin deve
    // primeiro cancelar a recorrência (PATCH .../recorrencia).
    if (despesa.recorrencia !== 'unica' && despesa.regra_origem_id === null && despesa.ativa === 1) {
      return res.status(400).json({
        success: false,
        message: 'Esta despesa é uma recorrência ativa. Cancele a recorrência primeiro (isso não apaga os meses já lançados) e só depois remova, se necessário.',
      });
    }

    const resultado = await queryAsync(`DELETE FROM despesas WHERE id = ? AND school_id = ?`, [despesaId, schoolId]);
    if (resultado.affectedRows === 0) return res.status(404).json({ success: false, message: 'Despesa não encontrada' });
    res.json({ success: true, message: 'Despesa removida com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao remover despesa:', err);
    res.status(500).json({ success: false, message: 'Erro ao remover despesa', error: err.message });
  }
};

// PATCH /schools/:schoolId/despesas/:despesaId/recorrencia — pausar/retomar a
// geração dos próximos meses de uma despesa recorrente. Não apaga nem altera
// os meses já lançados (histórico fica intacto).
export const alterarRecorrenciaDespesa = async (req, res) => {
  try {
    await ensureTabelas();
    const { schoolId, despesaId } = req.params;
    const { ativa } = req.body;

    const existentes = await queryAsync(`SELECT recorrencia, regra_origem_id FROM despesas WHERE id = ? AND school_id = ?`, [despesaId, schoolId]);
    if (existentes.length === 0) return res.status(404).json({ success: false, message: 'Despesa não encontrada' });
    const despesa = existentes[0];
    if (despesa.recorrencia === 'unica' || despesa.regra_origem_id !== null) {
      return res.status(400).json({ success: false, message: 'Esta despesa não é uma regra de recorrência.' });
    }

    await queryAsync(`UPDATE despesas SET ativa = ? WHERE id = ? AND school_id = ?`, [ativa ? 1 : 0, despesaId, schoolId]);
    res.json({ success: true, message: ativa ? 'Recorrência reativada — voltará a lançar todos os meses.' : 'Recorrência cancelada — os meses já lançados continuam no histórico.' });
  } catch (err) {
    console.error('[v0] Erro ao alterar recorrência da despesa:', err);
    res.status(500).json({ success: false, message: 'Erro ao alterar recorrência', error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// DESPESAS RECORRENTES (manuais) — gera o lançamento do mês corrente para cada
// regra ativa ('temporaria' dentro do prazo, ou 'indeterminada'), uma vez por
// regra por mês. Mesmo padrão de idempotência de gerarDespesasSalariosDoMes.
// ═══════════════════════════════════════════════════════════════════════════════
export const gerarDespesasRecorrentesDoMes = async (schoolId) => {
  await ensureTabelas();

  const hoje = new Date();
  const ano = hoje.getFullYear();
  const mes = hoje.getMonth() + 1;
  const ultimoDiaMes = new Date(ano, mes, 0).getDate();
  const dataDespesaMensal = `${ano}-${String(mes).padStart(2, '0')}-${String(ultimoDiaMes).padStart(2, '0')}`;

  // v128 — origem != 'salario': a folha salarial já tem o seu próprio gerador
  // idempotente (gerarDespesasSalariosDoMes) e não deve ser tratada como uma
  // "regra recorrente manual" aqui — evita que este motor tente gerar cópias
  // adicionais de despesas de salário no futuro (hoje isto não duplica graças
  // à verificação `id = regra.id`, mas depender disso é frágil).
  const regras = await queryAsync(
    `SELECT * FROM despesas
     WHERE school_id = ? AND regra_origem_id IS NULL AND recorrencia IN ('temporaria', 'indeterminada') AND ativa = 1
       AND origem != 'salario'
       AND (data_fim_recorrencia IS NULL OR CURDATE() <= data_fim_recorrencia)`,
    [schoolId]
  );

  let totalGeradas = 0;
  for (const regra of regras) {
    try {
      const ehAnual = regra.periodicidade === 'anual';

      if (ehAnual) {
        // v107 — regra anual: só lança uma vez, no mês em que a regra
        // "faz aniversário" (o mês original em que foi criada), e no
        // mesmo dia do mês (limitado ao último dia do mês corrente, caso
        // a origem seja dia 29/30/31 e o mês de aniversário seja mais
        // curto). Verifica se já existe um lançamento este ANO (não só
        // este mês) para não duplicar.
        const dataOrigem = new Date(regra.data_despesa);
        const mesAniversario = dataOrigem.getMonth() + 1;
        if (mesAniversario !== mes) continue;

        const existenteEsteAno = await queryAsync(
          `SELECT id FROM despesas WHERE school_id = ? AND (id = ? OR regra_origem_id = ?) AND YEAR(data_despesa) = ? LIMIT 1`,
          [schoolId, regra.id, regra.id, ano]
        );
        if (existenteEsteAno.length > 0) continue;

        const diaAlvo = Math.min(dataOrigem.getDate(), ultimoDiaMes);
        const dataDespesaAnual = `${ano}-${String(mes).padStart(2, '0')}-${String(diaAlvo).padStart(2, '0')}`;

        await queryAsync(
          `INSERT INTO despesas (school_id, descricao, categoria, valor, data_despesa, origem, recorrencia, periodicidade, regra_origem_id, ativa, created_at)
           VALUES (?, ?, ?, ?, ?, 'recorrente', ?, 'anual', ?, 1, NOW())`,
          [schoolId, regra.descricao, regra.categoria, regra.valor, dataDespesaAnual, regra.recorrencia, regra.id]
        );
        totalGeradas += 1;
        continue;
      }

      // Já existe um lançamento este mês? (a própria regra, se foi criada
      // este mês, ou uma cópia gerada em meses anteriores)
      const existente = await queryAsync(
        `SELECT id FROM despesas WHERE school_id = ? AND (id = ? OR regra_origem_id = ?) AND MONTH(data_despesa) = ? AND YEAR(data_despesa) = ? LIMIT 1`,
        [schoolId, regra.id, regra.id, mes, ano]
      );
      if (existente.length > 0) continue;

      await queryAsync(
        `INSERT INTO despesas (school_id, descricao, categoria, valor, data_despesa, origem, recorrencia, periodicidade, regra_origem_id, ativa, created_at)
         VALUES (?, ?, ?, ?, ?, 'recorrente', ?, 'mensal', ?, 1, NOW())`,
        [schoolId, regra.descricao, regra.categoria, regra.valor, dataDespesaMensal, regra.recorrencia, regra.id]
      );
      totalGeradas += 1;
    } catch (erroRegra) {
      console.error(`[v0] Erro ao gerar lançamento recorrente da despesa #${regra.id}:`, erroRegra.message);
    }
  }
  return totalGeradas;
};

export const executarGeracaoDeDespesasRecorrentesDiaria = async () => {
  try {
    const escolas = await queryAsync(`SELECT id FROM schools WHERE status = 'ativa' OR status IS NULL`);
    for (const escola of escolas) {
      const geradas = await gerarDespesasRecorrentesDoMes(escola.id);
      if (geradas > 0) console.log(`[v0] ${geradas} despesa(s) recorrente(s) lançada(s) para a escola #${escola.id}`);
    }
  } catch (err) {
    console.error('[v0] Erro na geração diária de despesas recorrentes:', err);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// FOLHA SALARIAL COMO DESPESA — o salário de professores e funcionários sai uma
// vez por mês, por isso é lançado automaticamente como despesa (categoria
// "Salários") no último dia de cada mês, tal como as mensalidades vencem no
// último dia do mês (ver mensalidades.controller.js). Idempotente: corre todos
// os dias (cron em app.js) mas só cria uma despesa por pessoa por mês —
// verificado por referencia_tipo + referencia_id + mês/ano.
export const gerarDespesasSalariosDoMes = async (schoolId) => {
  await ensureTabelas();

  const hoje = new Date();
  const ano = hoje.getFullYear();
  const mes = hoje.getMonth() + 1;
  const ultimoDiaMes = new Date(ano, mes, 0).getDate();
  const dataDespesa = `${ano}-${String(mes).padStart(2, '0')}-${String(ultimoDiaMes).padStart(2, '0')}`;

  let totalGeradas = 0;

  const pessoas = [
    ...(await queryAsync(`SELECT id, nome, salario FROM teachers WHERE school_id = ? AND ativo = 1 AND salario IS NOT NULL AND salario > 0`, [schoolId]))
      .map((p) => ({ ...p, tipo: 'professor', rotulo: 'Professor' })),
    ...(await queryAsync(`SELECT id, nome, salario, cargo FROM funcionarios WHERE school_id = ? AND ativo = 1 AND salario IS NOT NULL AND salario > 0`, [schoolId]))
      .map((p) => ({ ...p, tipo: 'funcionario', rotulo: p.cargo || 'Funcionário' })),
  ];

  for (const pessoa of pessoas) {
    try {
      const existente = await queryAsync(
        `SELECT id FROM despesas WHERE school_id = ? AND referencia_tipo = ? AND referencia_id = ? AND MONTH(data_despesa) = ? AND YEAR(data_despesa) = ? LIMIT 1`,
        [schoolId, pessoa.tipo, pessoa.id, mes, ano]
      );
      if (existente.length > 0) continue;

      await queryAsync(
        `INSERT INTO despesas (school_id, descricao, categoria, valor, data_despesa, origem, referencia_tipo, referencia_id, recorrencia, ativa, created_at)
         VALUES (?, ?, 'Salários', ?, ?, 'salario', ?, ?, 'indeterminada', 1, NOW())`,
        [schoolId, `Salário — ${pessoa.nome} (${pessoa.rotulo})`, parseFloat(pessoa.salario), dataDespesa, pessoa.tipo, pessoa.id]
      );
      totalGeradas += 1;
    } catch (erroPessoa) {
      console.error(`[v0] Erro ao gerar despesa de salário para ${pessoa.tipo} #${pessoa.id}:`, erroPessoa.message);
    }
  }

  return totalGeradas;
};

// Corre para todas as escolas — chamado pelo cron diário em app.js, tal como a
// rotina financeira das mensalidades.
export const executarGeracaoDeSalariosDiaria = async () => {
  try {
    const escolas = await queryAsync(`SELECT id FROM schools WHERE status = 'ativa' OR status IS NULL`);
    for (const escola of escolas) {
      const geradas = await gerarDespesasSalariosDoMes(escola.id);
      if (geradas > 0) console.log(`[v0] ${geradas} despesa(s) de salário gerada(s) para a escola #${escola.id}`);
    }
  } catch (err) {
    console.error('[v0] Erro na geração diária de despesas de salário:', err);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// EVENTOS ESCOLARES — usado para "Próximos Eventos" e "Próximos Exames"
// (categoria = 'exame' aparece separadamente no dashboard)
// ═══════════════════════════════════════════════════════════════════════════════
export const getEventos = async (req, res) => {
  try {
    await ensureTabelas();
    const { schoolId } = req.params;
    const { apenasProximos, ano, mes, categoria, classe_id: classeId } = req.query;

    const condicoes = ['ee.school_id = ?'];
    const parametros = [schoolId];

    if (apenasProximos === 'true') condicoes.push('ee.data_evento >= CURDATE()');
    if (ano) { condicoes.push('YEAR(ee.data_evento) = ?'); parametros.push(ano); }
    if (mes) { condicoes.push('MONTH(ee.data_evento) = ?'); parametros.push(mes); }
    if (categoria) { condicoes.push('ee.categoria = ?'); parametros.push(categoria); }
    if (classeId) { condicoes.push('(ee.classe_id = ? OR ee.classe_id IS NULL)'); parametros.push(classeId); }

    const eventos = await queryAsync(
      `
        SELECT ee.*, c.nome as classe_nome
        FROM eventos_escolares ee
        LEFT JOIN classes c ON c.id = ee.classe_id
        WHERE ${condicoes.join(' AND ')}
        ORDER BY ee.data_evento ASC, ee.hora_inicio ASC
        LIMIT 500
      `,
      parametros
    );
    res.json({ success: true, data: eventos });
  } catch (err) {
    console.error('[v0] Erro ao listar eventos:', err);
    res.status(500).json({ success: false, message: 'Erro ao listar eventos', error: err.message });
  }
};

export const createEvento = async (req, res) => {
  try {
    await ensureTabelas();
    const { schoolId } = req.params;
    const { titulo, categoria, data_evento: dataEvento, data_fim: dataFim, descricao, classe_id: classeId, trimestre, hora_inicio: horaInicio, hora_fim: horaFim } = req.body;

    if (!titulo?.trim() || !dataEvento) {
      return res.status(400).json({ success: false, message: 'Título e data são obrigatórios' });
    }
    if (categoria && !CATEGORIAS_VALIDAS.includes(categoria)) {
      return res.status(400).json({ success: false, message: 'Categoria inválida' });
    }

    const inserido = await queryAsync(
      `
        INSERT INTO eventos_escolares
          (school_id, titulo, categoria, classe_id, trimestre, data_evento, data_fim, hora_inicio, hora_fim, descricao, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
      `,
      [
        schoolId, titulo.trim(), categoria || 'evento',
        classeId || null, trimestre || null,
        dataEvento, dataFim || null, horaInicio || null, horaFim || null,
        descricao || null,
      ]
    );
    res.status(201).json({ success: true, message: 'Evento criado com sucesso', id: inserido.insertId });
  } catch (err) {
    console.error('[v0] Erro ao criar evento:', err);
    res.status(500).json({ success: false, message: 'Erro ao criar evento', error: err.message });
  }
};

export const updateEvento = async (req, res) => {
  try {
    await ensureTabelas();
    const { schoolId, eventoId } = req.params;
    const { titulo, categoria, data_evento: dataEvento, data_fim: dataFim, descricao, classe_id: classeId, trimestre, hora_inicio: horaInicio, hora_fim: horaFim } = req.body;

    if (categoria && !CATEGORIAS_VALIDAS.includes(categoria)) {
      return res.status(400).json({ success: false, message: 'Categoria inválida' });
    }

    const existentes = await queryAsync(`SELECT * FROM eventos_escolares WHERE id = ? AND school_id = ?`, [eventoId, schoolId]);
    if (existentes.length === 0) return res.status(404).json({ success: false, message: 'Evento não encontrado' });
    const atual = existentes[0];

    await queryAsync(
      `
        UPDATE eventos_escolares SET
          titulo = ?, categoria = ?, classe_id = ?, trimestre = ?, data_evento = ?, data_fim = ?,
          hora_inicio = ?, hora_fim = ?, descricao = ?
        WHERE id = ? AND school_id = ?
      `,
      [
        titulo?.trim() || atual.titulo,
        categoria || atual.categoria,
        classeId !== undefined ? (classeId || null) : atual.classe_id,
        trimestre !== undefined ? (trimestre || null) : atual.trimestre,
        dataEvento || atual.data_evento,
        dataFim !== undefined ? (dataFim || null) : atual.data_fim,
        horaInicio !== undefined ? (horaInicio || null) : atual.hora_inicio,
        horaFim !== undefined ? (horaFim || null) : atual.hora_fim,
        descricao !== undefined ? descricao : atual.descricao,
        eventoId, schoolId,
      ]
    );
    res.json({ success: true, message: 'Evento atualizado com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao atualizar evento:', err);
    res.status(500).json({ success: false, message: 'Erro ao atualizar evento', error: err.message });
  }
};

export const deleteEvento = async (req, res) => {
  try {
    await ensureTabelas();
    const { schoolId, eventoId } = req.params;
    const resultado = await queryAsync(`DELETE FROM eventos_escolares WHERE id = ? AND school_id = ?`, [eventoId, schoolId]);
    if (resultado.affectedRows === 0) return res.status(404).json({ success: false, message: 'Evento não encontrado' });
    res.json({ success: true, message: 'Evento removido com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao remover evento:', err);
    res.status(500).json({ success: false, message: 'Erro ao remover evento', error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// CENTRAL DE ALERTAS + TAREFAS ADMINISTRATIVAS — "o que precisa da minha
// atenção agora?". Cada item aqui é calculado a partir de dados reais já
// existentes na base de dados (nada é inventado/fixo). Itens que a escola
// pediu mas que ainda não têm um campo/fluxo correspondente no sistema
// (ex.: validade de documento de funcionário, aprovação de matrícula,
// conflito de horário) foram deliberadamente deixados de fora — ver nota no
// fim do ficheiro / na resposta ao pedido.
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Núcleo de sinais em tempo real sobre a saúde da escola — extraído aqui
 * para ser a ÚNICA fonte de verdade, reutilizada tanto pela Central de
 * Alertas (getDashboardAlerts) como pelo Falcon Insights
 * (insightsController.js). Antes esta lógica vivia só dentro de
 * getDashboardAlerts; duplicá-la no Insights teria dois lugares a
 * divergir com o tempo.
 */
export const calcularSinaisEscola = async (schoolId) => {
  await ensureTabelas();

  // v113 — antes, uma query que falhasse (conexão caída, tabela bloqueada,
  // etc.) virava silenciosamente `{ qtd: 0 }` e o diretor via "🟢 tudo
  // certo" em vez de "🔴 não foi possível calcular". `falhas` regista a
  // CHAVE de cada sinal que não pôde ser calculado nesta consulta, para a
  // Central de Alertas e o Falcon Insights conseguirem mostrar isso
  // explicitamente em vez de tratarem o valor-padrão como um resultado real.
  const falhas = [];
  const consultarQtd = async (chave, sql, params) => {
    try {
      const [row] = await queryAsync(sql, params);
      return row || { qtd: 0 };
    } catch (e) {
      console.error(`[v0] Falha ao calcular sinal '${chave}':`, e.message);
      falhas.push(chave);
      return { qtd: 0 };
    }
  };
  const consultarIds = async (sql, params) => {
    try {
      const linhas = await queryAsync(sql, params);
      return linhas.map((x) => x.id);
    } catch (e) {
      // A falha em si já foi registada pelo consultarQtd() correspondente —
      // aqui só evitamos que a lista de IDs quebre a função inteira.
      return [];
    }
  };

  // ── 1. Mensalidades em atraso ───────────────────────────────────────────
  const atrasoRow = await consultarQtd(
    'mensalidades_atrasadas',
    `SELECT COUNT(*) as qtd FROM student_payments WHERE school_id = ? AND status = 'atrasado'`,
    [schoolId]
  );
  // v97 — ids dos alunos envolvidos, para a Central de Alertas poder levar
  // o admin diretamente ao aluno certo (ou a uma lista já filtrada), em vez
  // de só abrir a aba inteira. Limitado a 50 para não pesar o payload —
  // `qtd` continua a ser a contagem real, mesmo que ultrapasse o limite.
  const atrasoIds = await consultarIds(
    `SELECT DISTINCT student_id as id FROM student_payments WHERE school_id = ? AND status = 'atrasado' LIMIT 50`,
    [schoolId]
  );

  // ── 2. Pagamentos pendentes de confirmação ──────────────────────────────
  const pendenteRow = await consultarQtd(
    'pagamentos_pendentes',
    `SELECT COUNT(*) as qtd FROM student_payments WHERE school_id = ? AND status = 'pendente'`,
    [schoolId]
  );
  const pendenteIds = await consultarIds(
    `SELECT DISTINCT student_id as id FROM student_payments WHERE school_id = ? AND status = 'pendente' LIMIT 50`,
    [schoolId]
  );

  // ── 3. Alunos com documentação incompleta (sem nº de documento registado) ─
  const docIncompletaRow = await consultarQtd(
    'documentacao_incompleta',
    `SELECT COUNT(*) as qtd FROM students WHERE school_id = ? AND ativo = 1 AND (documento IS NULL OR TRIM(documento) = '')`,
    [schoolId]
  );
  const docIncompletaIds = await consultarIds(
    `SELECT id FROM students WHERE school_id = ? AND ativo = 1 AND (documento IS NULL OR TRIM(documento) = '') LIMIT 50`,
    [schoolId]
  );

  // ── 3b. Documentos do módulo "Documentação escolar" a vencer nos próximos
  // 30 dias (ou já vencidos) — student_documentos.data_validade ──────────
  let documentosVencendoRow = { qtd: 0 };
  let documentosVencendoIds = [];
  try {
    [documentosVencendoRow] = await queryAsync(
      `
        SELECT COUNT(*) as qtd FROM student_documentos d
        LEFT JOIN students s ON s.id = d.student_id
        WHERE d.school_id = ? AND d.data_validade IS NOT NULL
          AND DATEDIFF(d.data_validade, CURDATE()) <= 30
          AND (s.ativo = 1 OR s.ativo IS NULL)
      `,
      [schoolId]
    );
    documentosVencendoIds = await queryAsync(
      `
        SELECT DISTINCT d.student_id as id FROM student_documentos d
        LEFT JOIN students s ON s.id = d.student_id
        WHERE d.school_id = ? AND d.data_validade IS NOT NULL
          AND DATEDIFF(d.data_validade, CURDATE()) <= 30
          AND (s.ativo = 1 OR s.ativo IS NULL)
        LIMIT 50
      `,
      [schoolId]
    ).then((r) => r.map((x) => x.id));
  } catch (e) {
    // Tabela/coluna ainda não migrada nesta escola é um "0" legítimo; qualquer
    // outro erro (conexão, timeout, etc.) precisa ser reportado, não escondido.
    if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') {
      console.error("[v0] Falha ao calcular sinal 'documentos_vencendo':", e.message);
      falhas.push('documentos_vencendo');
    }
  }

  // ── 3c. Documentos de PROFESSORES a vencer nos próximos 30 dias (ou já
  // vencidos) — teacher_documentos.data_validade. Antes, este alerta só
  // existia para alunos; professores e funcionários tinham o upload de
  // documentos mas nenhum aviso de vencimento aparecia aqui. ──────────────
  let documentosProfessorVencendoRow = { qtd: 0 };
  let documentosProfessorVencendoIds = [];
  try {
    [documentosProfessorVencendoRow] = await queryAsync(
      `
        SELECT COUNT(*) as qtd FROM teacher_documentos d
        LEFT JOIN teachers t ON t.id = d.teacher_id
        WHERE d.school_id = ? AND d.data_validade IS NOT NULL
          AND DATEDIFF(d.data_validade, CURDATE()) <= 30
          AND (t.ativo = 1 OR t.ativo IS NULL)
      `,
      [schoolId]
    );
    documentosProfessorVencendoIds = await queryAsync(
      `
        SELECT DISTINCT d.teacher_id as id FROM teacher_documentos d
        LEFT JOIN teachers t ON t.id = d.teacher_id
        WHERE d.school_id = ? AND d.data_validade IS NOT NULL
          AND DATEDIFF(d.data_validade, CURDATE()) <= 30
          AND (t.ativo = 1 OR t.ativo IS NULL)
        LIMIT 50
      `,
      [schoolId]
    ).then((r) => r.map((x) => x.id));
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') {
      console.error("[v0] Falha ao calcular sinal 'documentos_professor_vencendo':", e.message);
      falhas.push('documentos_professor_vencendo');
    }
  }

  // ── 3d. Documentos de FUNCIONÁRIOS a vencer nos próximos 30 dias (ou já
  // vencidos) — funcionario_documentos.data_validade. ─────────────────────
  let documentosFuncionarioVencendoRow = { qtd: 0 };
  let documentosFuncionarioVencendoIds = [];
  try {
    [documentosFuncionarioVencendoRow] = await queryAsync(
      `
        SELECT COUNT(*) as qtd FROM funcionario_documentos d
        LEFT JOIN funcionarios f ON f.id = d.funcionario_id
        WHERE d.school_id = ? AND d.data_validade IS NOT NULL
          AND DATEDIFF(d.data_validade, CURDATE()) <= 30
          AND (f.ativo = 1 OR f.ativo IS NULL)
      `,
      [schoolId]
    );
    documentosFuncionarioVencendoIds = await queryAsync(
      `
        SELECT DISTINCT d.funcionario_id as id FROM funcionario_documentos d
        LEFT JOIN funcionarios f ON f.id = d.funcionario_id
        WHERE d.school_id = ? AND d.data_validade IS NOT NULL
          AND DATEDIFF(d.data_validade, CURDATE()) <= 30
          AND (f.ativo = 1 OR f.ativo IS NULL)
        LIMIT 50
      `,
      [schoolId]
    ).then((r) => r.map((x) => x.id));
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') {
      console.error("[v0] Falha ao calcular sinal 'documentos_funcionario_vencendo':", e.message);
      falhas.push('documentos_funcionario_vencendo');
    }
  }

  // ── 4. Turmas sem professor responsável ─────────────────────────────────
  const turmasSemProfRow = await consultarQtd(
    'turmas_sem_professor',
    `SELECT COUNT(*) as qtd FROM turmas WHERE school_id = ? AND ativa = 1 AND professor_responsavel_id IS NULL`,
    [schoolId]
  );
  const turmasSemProfIds = await consultarIds(
    `SELECT id FROM turmas WHERE school_id = ? AND ativa = 1 AND professor_responsavel_id IS NULL LIMIT 50`,
    [schoolId]
  );

  // ── 5. Turmas superlotadas (mais alunos ativos do que a capacidade máxima) ─
  let turmasLotadas = [];
  try {
    turmasLotadas = await queryAsync(
      `
        SELECT t.id, t.nome, t.capacidade_maxima, COUNT(s.id) as total_alunos
        FROM turmas t LEFT JOIN students s ON s.turma_id = t.id AND s.ativo = 1
        WHERE t.school_id = ? AND t.ativa = 1
        GROUP BY t.id, t.nome, t.capacidade_maxima
        HAVING total_alunos > t.capacidade_maxima
      `,
      [schoolId]
    );
  } catch (e) {
    console.error("[v0] Falha ao calcular sinal 'turmas_superlotadas':", e.message);
    falhas.push('turmas_superlotadas');
  }

  // ── 5b. Salas superlotadas (capacidade física da SALA, distinta da
  // capacidade administrativa da turma — uma turma pode caber no seu
  // limite de matrícula mas ainda assim não caber fisicamente na sala) ────
  let salasLotadas = [];
  try {
    salasLotadas = await queryAsync(
      `
        SELECT sl.id, sl.numero, sl.capacidade, COALESCE(SUM(ocupacao.total_alunos), 0) as total_alunos
        FROM salas sl
        LEFT JOIN (
          SELECT t.sala_id, COUNT(s.id) as total_alunos
          FROM turmas t LEFT JOIN students s ON s.turma_id = t.id AND s.ativo = 1
          WHERE t.school_id = ? AND t.ativa = 1 AND t.sala_id IS NOT NULL
          GROUP BY t.sala_id
        ) ocupacao ON ocupacao.sala_id = sl.id
        WHERE sl.school_id = ? AND sl.ativa = 1
        GROUP BY sl.id, sl.numero, sl.capacidade
        HAVING total_alunos > sl.capacidade
      `,
      [schoolId, schoolId]
    );
  } catch (e) {
    console.error("[v0] Falha ao calcular sinal 'salas_superlotadas':", e.message);
    falhas.push('salas_superlotadas');
  }

  // ── 6. Alunos com frequência abaixo do mínimo (75%, últimos 60 dias) ────
  let frequenciaBaixaRow = { qtd: 0 };
  let frequenciaBaixaIds = [];
  try {
    [frequenciaBaixaRow] = await queryAsync(
      `
        SELECT COUNT(*) as qtd FROM (
          SELECT student_id, SUM(CASE WHEN status IN ('presente','atraso') THEN 1 ELSE 0 END) / COUNT(*) * 100 as freq
          FROM presencas
          WHERE school_id = ? AND data >= CURDATE() - INTERVAL 60 DAY
          GROUP BY student_id
          HAVING COUNT(*) >= 5 AND freq < 75
        ) x
      `,
      [schoolId]
    );
    frequenciaBaixaIds = await queryAsync(
      `
        SELECT student_id as id FROM (
          SELECT student_id, SUM(CASE WHEN status IN ('presente','atraso') THEN 1 ELSE 0 END) / COUNT(*) * 100 as freq
          FROM presencas
          WHERE school_id = ? AND data >= CURDATE() - INTERVAL 60 DAY
          GROUP BY student_id
          HAVING COUNT(*) >= 5 AND freq < 75
        ) x LIMIT 50
      `,
      [schoolId]
    ).then((r) => r.map((row) => row.id));
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') {
      console.error("[v0] Falha ao calcular sinal 'frequencia_baixa':", e.message);
      falhas.push('frequencia_baixa');
    }
  }

  // ── 7. Professores sem horário atribuído ────────────────────────────────
  let professoresSemHorarioRow = { qtd: 0 };
  let professoresSemHorarioIds = [];
  try {
    [professoresSemHorarioRow] = await queryAsync(
      `
        SELECT COUNT(*) as qtd FROM teachers t
        WHERE t.school_id = ? AND t.ativo = 1
          AND NOT EXISTS (SELECT 1 FROM horarios h WHERE h.teacher_id = t.id AND h.ativo = 1)
      `,
      [schoolId]
    );
    professoresSemHorarioIds = await queryAsync(
      `
        SELECT t.id FROM teachers t
        WHERE t.school_id = ? AND t.ativo = 1
          AND NOT EXISTS (SELECT 1 FROM horarios h WHERE h.teacher_id = t.id AND h.ativo = 1)
        LIMIT 50
      `,
      [schoolId]
    ).then((r) => r.map((x) => x.id));
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') {
      console.error("[v0] Falha ao calcular sinal 'professores_sem_horario':", e.message);
      falhas.push('professores_sem_horario');
    }
  }

  // ── 7b. Conflitos de horário (professor em 2 turmas, ou sala partilhada,
  // ao mesmo tempo) — versão leve só para contagem; o detalhe completo com
  // as 6 categorias vive em GET /horarios/conflitos. ─────────────────────
  let conflitosHorarioRow = { qtd: 0 };
  try {
    const [linha] = await queryAsync(
      `
        SELECT
          (
            (SELECT COUNT(*) FROM (
              SELECT teacher_id, dia_semana, turno_id, ordem
              FROM horarios WHERE school_id = ? AND ativo = 1 AND teacher_id IS NOT NULL
              GROUP BY teacher_id, dia_semana, turno_id, ordem
              HAVING COUNT(DISTINCT turma_id) > 1
            ) x)
            +
            (SELECT COUNT(*) FROM (
              SELECT sala_id, dia_semana, turno_id, ordem
              FROM horarios WHERE school_id = ? AND ativo = 1 AND sala_id IS NOT NULL
              GROUP BY sala_id, dia_semana, turno_id, ordem
              HAVING COUNT(DISTINCT turma_id) > 1
            ) y)
          ) as qtd
      `,
      [schoolId, schoolId]
    );
    conflitosHorarioRow = { qtd: linha?.qtd || 0 };
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') {
      console.error("[v0] Falha ao calcular sinal 'conflitos_horario':", e.message);
      falhas.push('conflitos_horario');
    }
  }

  // ── 8. Renovações de matrícula pendentes (prazo já passou, sem renovação) ─
  let renovacoesPendentesRow = { qtd: 0 };
  let renovacoesPendentesIds = [];
  try {
    const settingsRows = await queryAsync(`SELECT periodicidade FROM renewal_settings WHERE school_id = ? LIMIT 1`, [schoolId]);
    const periodicidade = settingsRows[0]?.periodicidade || 'Anual';
    const meses = { Trimestral: 3, Semestral: 6, Anual: 12 }[periodicidade] || 12;
    [renovacoesPendentesRow] = await queryAsync(
      `
        SELECT COUNT(*) as qtd FROM students s
        WHERE s.school_id = ? AND s.ativo = 1
          AND COALESCE(
            (SELECT MAX(eh.created_at) FROM enrollment_history eh WHERE eh.student_id = s.id),
            s.data_inscricao
          ) < CURDATE() - INTERVAL ? MONTH
      `,
      [schoolId, meses]
    );
    renovacoesPendentesIds = await queryAsync(
      `
        SELECT s.id FROM students s
        WHERE s.school_id = ? AND s.ativo = 1
          AND COALESCE(
            (SELECT MAX(eh.created_at) FROM enrollment_history eh WHERE eh.student_id = s.id),
            s.data_inscricao
          ) < CURDATE() - INTERVAL ? MONTH
        LIMIT 50
      `,
      [schoolId, meses]
    ).then((r) => r.map((x) => x.id));
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') {
      console.error("[v0] Falha ao calcular sinal 'renovacoes_pendentes':", e.message);
      falhas.push('renovacoes_pendentes');
    }
  }

  // ── 9. Alunos ativos sem turma atribuída ────────────────────────────────
  const semTurmaRow = await consultarQtd(
    'alunos_sem_turma',
    `SELECT COUNT(*) as qtd FROM students WHERE school_id = ? AND ativo = 1 AND turma_id IS NULL`,
    [schoolId]
  );
  const semTurmaIds = await consultarIds(
    `SELECT id FROM students WHERE school_id = ? AND ativo = 1 AND turma_id IS NULL LIMIT 50`,
    [schoolId]
  );

  // ── 10. Alunos ativos sem nenhum encarregado de educação registado ─────
  const semEncarregadoRow = await consultarQtd(
    'alunos_sem_encarregado',
    `SELECT COUNT(*) as qtd FROM students s WHERE s.school_id = ? AND s.ativo = 1 AND NOT EXISTS (SELECT 1 FROM guardians g WHERE g.student_id = s.id)`,
    [schoolId]
  );
  const semEncarregadoIds = await consultarIds(
    `SELECT id FROM students s WHERE s.school_id = ? AND s.ativo = 1 AND NOT EXISTS (SELECT 1 FROM guardians g WHERE g.student_id = s.id) LIMIT 50`,
    [schoolId]
  );

  // ── 11. Notas lançadas fora do intervalo válido (0–20) — erro de digitação
  // ou registo antigo/importado antes de alguma validação existir. Sinal de
  // integridade de dados, não de desempenho académico. ────────────────────
  let notasForaIntervaloRow = { qtd: 0 };
  let notasForaIntervaloIds = [];
  try {
    [notasForaIntervaloRow] = await queryAsync(
      `SELECT COUNT(*) as qtd FROM grades WHERE school_id = ? AND (valor < 0 OR valor > 20)`,
      [schoolId]
    );
    notasForaIntervaloIds = await queryAsync(
      `SELECT DISTINCT student_id as id FROM grades WHERE school_id = ? AND (valor < 0 OR valor > 20) LIMIT 50`,
      [schoolId]
    ).then((r) => r.map((x) => x.id));
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') {
      console.error("[v0] Falha ao calcular sinal 'notas_fora_intervalo':", e.message);
      falhas.push('notas_fora_intervalo');
    }
  }

  // ── 12. Despesas com valor zero ou negativo — quase sempre erro de
  // digitação (vírgula/ponto trocados, campo deixado em branco) em vez de
  // uma despesa real. ──────────────────────────────────────────────────────
  const despesaValorInvalidoRow = await consultarQtd(
    'despesas_valor_invalido',
    `SELECT COUNT(*) as qtd FROM despesas WHERE school_id = ? AND valor <= 0`,
    [schoolId]
  );
  const despesaValorInvalidoIds = await consultarIds(
    `SELECT id FROM despesas WHERE school_id = ? AND valor <= 0 LIMIT 50`,
    [schoolId]
  );

  // ── 13. Despesas duplicadas — mesma descrição + valor + data lançadas
  // mais de uma vez (clique duplo no "Guardar", ou lançamento manual
  // repetido por engano). Despesas de salário automáticas nunca duplicam
  // (gerarDespesasSalariosDoMes já impede via referencia_tipo/referencia_id),
  // por isso ficam de fora desta verificação. ────────────────────────────
  let despesasDuplicadas = [];
  try {
    despesasDuplicadas = await queryAsync(
      `
        SELECT descricao, valor, data_despesa, COUNT(*) as qtd_duplicada
        FROM despesas
        WHERE school_id = ? AND origem != 'salario'
        GROUP BY descricao, valor, data_despesa
        HAVING COUNT(*) > 1
      `,
      [schoolId]
    );
  } catch (e) {
    console.error("[v0] Falha ao calcular sinal 'despesas_duplicadas':", e.message);
    falhas.push('despesas_duplicadas');
  }

  // ── 14. Professor(es)/funcionário(s) com salário configurado mas sem a
  // despesa do mês corrente gerada. Chama gerarDespesasSalariosDoMes aqui
  // primeiro (idempotente, mesmo padrão da v130) para autocorrigir o comum;
  // o que sobrar depois disso é uma falha real de geração (ex.: erro
  // pontual capturado e ignorado por pessoa dentro dessa função). ─────────
  let salarioSemDespesaRow = { qtd: 0 };
  let salarioSemDespesaIds = [];
  try {
    await gerarDespesasSalariosDoMes(schoolId);
    const linhas = await queryAsync(
      `
        SELECT 'professor' as tipo, id FROM teachers
        WHERE school_id = ? AND ativo = 1 AND salario IS NOT NULL AND salario > 0
          AND NOT EXISTS (
            SELECT 1 FROM despesas d WHERE d.school_id = teachers.school_id
              AND d.referencia_tipo = 'professor' AND d.referencia_id = teachers.id
              AND MONTH(d.data_despesa) = MONTH(CURDATE()) AND YEAR(d.data_despesa) = YEAR(CURDATE())
          )
        UNION ALL
        SELECT 'funcionario' as tipo, id FROM funcionarios
        WHERE school_id = ? AND ativo = 1 AND salario IS NOT NULL AND salario > 0
          AND NOT EXISTS (
            SELECT 1 FROM despesas d WHERE d.school_id = funcionarios.school_id
              AND d.referencia_tipo = 'funcionario' AND d.referencia_id = funcionarios.id
              AND MONTH(d.data_despesa) = MONTH(CURDATE()) AND YEAR(d.data_despesa) = YEAR(CURDATE())
          )
        LIMIT 50
      `,
      [schoolId, schoolId]
    );
    salarioSemDespesaRow = { qtd: linhas.length };
    salarioSemDespesaIds = linhas.map((x) => x.id);
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') {
      console.error("[v0] Falha ao calcular sinal 'salario_sem_despesa':", e.message);
      falhas.push('salario_sem_despesa');
    }
  }

  // ── 15. Turmas ativas sem nenhuma presença lançada nos últimos 3 dias —
  // cobertura de lançamento, não taxa de frequência (essa já é o sinal 6).
  // Turmas recém-criadas (nunca lançaram nada) também entram aqui. ───────
  let turmasSemPresencaRecente = [];
  try {
    turmasSemPresencaRecente = await queryAsync(
      `
        SELECT t.id, t.nome
        FROM turmas t
        WHERE t.school_id = ? AND t.ativa = 1
          AND NOT EXISTS (
            SELECT 1 FROM presencas p
            WHERE p.turma_id = t.id AND p.data >= CURDATE() - INTERVAL 3 DAY
          )
      `,
      [schoolId]
    );
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') {
      console.error("[v0] Falha ao calcular sinal 'turmas_sem_presenca_recente':", e.message);
      falhas.push('turmas_sem_presenca_recente');
    }
  }

  // v113 — cada alerta agora carrega `indisponivel: true` quando a chave
  // correspondente está em `falhas`. O filtro final (abaixo) deixa de exigir
  // qtd > 0 nesse caso, para o alerta aparecer como "não foi possível
  // calcular" em vez de desaparecer junto com o zero falso.
  const alertas = [
    {
      chave: 'mensalidades_atrasadas', qtd: atrasoRow?.qtd || 0,
      titulo: 'mensalidade(s) atrasada(s)', pagina: 'mensalidades', severidade: 'critico',
      alvo: { tipo: 'aluno', ids: atrasoIds, abaPerfil: 'financeiro' },
      indisponivel: falhas.includes('mensalidades_atrasadas'),
    },
    {
      chave: 'documentacao_incompleta', qtd: docIncompletaRow?.qtd || 0,
      titulo: 'aluno(s) com documentação incompleta', pagina: 'alunos', severidade: 'atencao',
      alvo: { tipo: 'aluno', ids: docIncompletaIds, abaPerfil: 'dados' },
      indisponivel: falhas.includes('documentacao_incompleta'),
    },
    {
      chave: 'documentos_vencendo', qtd: documentosVencendoRow?.qtd || 0,
      titulo: 'documento(s) de aluno(s) vencido(s) ou a vencer em 30 dias', pagina: 'alunos', severidade: 'atencao',
      alvo: { tipo: 'aluno', ids: documentosVencendoIds, abaPerfil: 'documentos', modal: 'perfil360' },
      indisponivel: falhas.includes('documentos_vencendo'),
    },
    {
      chave: 'documentos_professor_vencendo', qtd: documentosProfessorVencendoRow?.qtd || 0,
      titulo: 'documento(s) de professor(es) vencido(s) ou a vencer em 30 dias', pagina: 'professores', severidade: 'atencao',
      alvo: { tipo: 'professor', ids: documentosProfessorVencendoIds },
      indisponivel: falhas.includes('documentos_professor_vencendo'),
    },
    {
      chave: 'documentos_funcionario_vencendo', qtd: documentosFuncionarioVencendoRow?.qtd || 0,
      titulo: 'documento(s) de funcionário(s) vencido(s) ou a vencer em 30 dias', pagina: 'funcionarios', severidade: 'atencao',
      alvo: { tipo: 'funcionario', ids: documentosFuncionarioVencendoIds },
      indisponivel: falhas.includes('documentos_funcionario_vencendo'),
    },
    {
      chave: 'turmas_sem_professor', qtd: turmasSemProfRow?.qtd || 0,
      titulo: 'turma(s) sem professor responsável', pagina: 'turmas', severidade: 'critico',
      alvo: { tipo: 'turma', ids: turmasSemProfIds },
      indisponivel: falhas.includes('turmas_sem_professor'),
    },
    {
      chave: 'turmas_superlotadas', qtd: turmasLotadas.length || 0,
      titulo: 'turma(s) superlotada(s)', pagina: 'turmas', severidade: 'atencao',
      detalhe: turmasLotadas.map((t) => `${t.nome} (${t.total_alunos}/${t.capacidade_maxima})`),
      alvo: { tipo: 'turma', ids: turmasLotadas.map((t) => t.id) },
      indisponivel: falhas.includes('turmas_superlotadas'),
    },
    {
      chave: 'salas_superlotadas', qtd: salasLotadas.length || 0,
      titulo: 'sala(s) com lotação excedida', pagina: 'salas', severidade: 'critico',
      detalhe: salasLotadas.map((s) => `Sala ${s.numero} (${s.total_alunos}/${s.capacidade})`),
      alvo: { tipo: 'sala', ids: salasLotadas.map((s) => s.id) },
      indisponivel: falhas.includes('salas_superlotadas'),
    },
    {
      chave: 'frequencia_baixa', qtd: frequenciaBaixaRow?.qtd || 0,
      titulo: 'aluno(s) com frequência abaixo de 75%', pagina: 'presencas', severidade: 'critico',
      alvo: { tipo: 'aluno', ids: frequenciaBaixaIds, abaPerfil: 'perfilcompleto' },
      indisponivel: falhas.includes('frequencia_baixa'),
    },
    {
      chave: 'professores_sem_horario', qtd: professoresSemHorarioRow?.qtd || 0,
      titulo: 'professor(es) sem horário definido', pagina: 'horarios', severidade: 'atencao',
      alvo: { tipo: 'professor', ids: professoresSemHorarioIds },
      indisponivel: falhas.includes('professores_sem_horario'),
    },
    {
      chave: 'conflitos_horario', qtd: conflitosHorarioRow?.qtd || 0,
      titulo: 'conflito(s) de horário detectado(s) (professor/sala)', pagina: 'horarios', severidade: 'critico',
      indisponivel: falhas.includes('conflitos_horario'),
    },
    {
      chave: 'renovacoes_pendentes', qtd: renovacoesPendentesRow?.qtd || 0,
      titulo: 'renovação/ões de matrícula pendente(s)', pagina: 'renovacao', severidade: 'atencao',
      alvo: { tipo: 'aluno', ids: renovacoesPendentesIds, abaPerfil: 'matricula' },
      indisponivel: falhas.includes('renovacoes_pendentes'),
    },
    {
      chave: 'pagamentos_pendentes', qtd: pendenteRow?.qtd || 0,
      titulo: 'pagamento(s) por confirmar', pagina: 'mensalidades', severidade: 'info',
      alvo: { tipo: 'aluno', ids: pendenteIds, abaPerfil: 'financeiro' },
      indisponivel: falhas.includes('pagamentos_pendentes'),
    },
    {
      chave: 'alunos_sem_turma', qtd: semTurmaRow?.qtd || 0,
      titulo: 'aluno(s) ativo(s) sem turma atribuída', pagina: 'alunos', severidade: 'atencao',
      alvo: { tipo: 'aluno', ids: semTurmaIds, abaPerfil: 'dados' },
      indisponivel: falhas.includes('alunos_sem_turma'),
    },
    {
      chave: 'alunos_sem_encarregado', qtd: semEncarregadoRow?.qtd || 0,
      titulo: 'aluno(s) sem encarregado de educação registado', pagina: 'alunos', severidade: 'atencao',
      alvo: { tipo: 'aluno', ids: semEncarregadoIds, abaPerfil: 'encarregados' },
      indisponivel: falhas.includes('alunos_sem_encarregado'),
    },
    {
      chave: 'notas_fora_intervalo', qtd: notasForaIntervaloRow?.qtd || 0,
      titulo: 'nota(s) lançada(s) fora do intervalo 0–20', pagina: 'alunos', severidade: 'critico',
      alvo: { tipo: 'aluno', ids: notasForaIntervaloIds, abaPerfil: 'notas' },
      indisponivel: falhas.includes('notas_fora_intervalo'),
    },
    {
      chave: 'despesas_valor_invalido', qtd: despesaValorInvalidoRow?.qtd || 0,
      titulo: 'despesa(s) com valor zero ou negativo', pagina: 'dashboard', severidade: 'atencao',
      alvo: { tipo: 'despesa', ids: despesaValorInvalidoIds },
      indisponivel: falhas.includes('despesas_valor_invalido'),
    },
    {
      chave: 'despesas_duplicadas', qtd: despesasDuplicadas.length || 0,
      titulo: 'despesa(s) possivelmente duplicada(s) (mesma descrição, valor e data)', pagina: 'dashboard', severidade: 'atencao',
      detalhe: despesasDuplicadas.map((d) => `${d.descricao} — ${d.valor} MZN (${d.qtd_duplicada}x)`),
      indisponivel: falhas.includes('despesas_duplicadas'),
    },
    {
      chave: 'salario_sem_despesa', qtd: salarioSemDespesaRow?.qtd || 0,
      titulo: 'professor(es)/funcionário(s) com salário sem despesa do mês gerada', pagina: 'funcionarios', severidade: 'critico',
      indisponivel: falhas.includes('salario_sem_despesa'),
    },
    {
      chave: 'turmas_sem_presenca_recente', qtd: turmasSemPresencaRecente.length || 0,
      titulo: 'turma(s) sem presença lançada nos últimos 3 dias', pagina: 'presencas', severidade: 'atencao',
      detalhe: turmasSemPresencaRecente.map((t) => t.nome),
      alvo: { tipo: 'turma', ids: turmasSemPresencaRecente.map((t) => t.id) },
      indisponivel: falhas.includes('turmas_sem_presenca_recente'),
    },
  ];

  // Tarefas administrativas: mesmos dados, com verbo de ação em vez de descrição.
  const tarefas = [
    pendenteRow?.qtd > 0 && { chave: 'confirmar_pagamentos', qtd: pendenteRow.qtd, titulo: `Confirmar ${pendenteRow.qtd} pagamento(s)`, pagina: 'mensalidades', alvo: { tipo: 'aluno', ids: pendenteIds, abaPerfil: 'financeiro' } },
    renovacoesPendentesRow?.qtd > 0 && { chave: 'renovar_matriculas', qtd: renovacoesPendentesRow.qtd, titulo: `Renovar ${renovacoesPendentesRow.qtd} matrícula(s)`, pagina: 'renovacao', alvo: { tipo: 'aluno', ids: renovacoesPendentesIds, abaPerfil: 'matricula' } },
    docIncompletaRow?.qtd > 0 && { chave: 'atualizar_documentos', qtd: docIncompletaRow.qtd, titulo: `Atualizar documentos de ${docIncompletaRow.qtd} aluno(s)`, pagina: 'alunos', alvo: { tipo: 'aluno', ids: docIncompletaIds, abaPerfil: 'dados' } },
    documentosVencendoRow?.qtd > 0 && { chave: 'renovar_documentos_vencendo', qtd: documentosVencendoRow.qtd, titulo: `Renovar ${documentosVencendoRow.qtd} documento(s) de aluno(s) vencido(s)/a vencer`, pagina: 'alunos', alvo: { tipo: 'aluno', ids: documentosVencendoIds, abaPerfil: 'documentos', modal: 'perfil360' } },
    documentosProfessorVencendoRow?.qtd > 0 && { chave: 'renovar_documentos_professor_vencendo', qtd: documentosProfessorVencendoRow.qtd, titulo: `Renovar ${documentosProfessorVencendoRow.qtd} documento(s) de professor(es) vencido(s)/a vencer`, pagina: 'professores', alvo: { tipo: 'professor', ids: documentosProfessorVencendoIds } },
    documentosFuncionarioVencendoRow?.qtd > 0 && { chave: 'renovar_documentos_funcionario_vencendo', qtd: documentosFuncionarioVencendoRow.qtd, titulo: `Renovar ${documentosFuncionarioVencendoRow.qtd} documento(s) de funcionário(s) vencido(s)/a vencer`, pagina: 'funcionarios', alvo: { tipo: 'funcionario', ids: documentosFuncionarioVencendoIds } },
    turmasSemProfRow?.qtd > 0 && { chave: 'atribuir_professores', qtd: turmasSemProfRow.qtd, titulo: `Atribuir professor a ${turmasSemProfRow.qtd} turma(s)`, pagina: 'turmas', alvo: { tipo: 'turma', ids: turmasSemProfIds } },
    turmasLotadas.length > 0 && { chave: 'resolver_lotacao', qtd: turmasLotadas.length, titulo: `Resolver superlotação em ${turmasLotadas.length} turma(s)`, pagina: 'turmas', alvo: { tipo: 'turma', ids: turmasLotadas.map((t) => t.id) } },
    salasLotadas.length > 0 && { chave: 'resolver_lotacao_sala', qtd: salasLotadas.length, titulo: `Resolver superlotação em ${salasLotadas.length} sala(s)`, pagina: 'salas', alvo: { tipo: 'sala', ids: salasLotadas.map((s) => s.id) } },
    conflitosHorarioRow?.qtd > 0 && { chave: 'resolver_conflitos_horario', qtd: conflitosHorarioRow.qtd, titulo: `Resolver ${conflitosHorarioRow.qtd} conflito(s) de horário`, pagina: 'horarios' },
    semTurmaRow?.qtd > 0 && { chave: 'atribuir_turma_alunos', qtd: semTurmaRow.qtd, titulo: `Atribuir turma a ${semTurmaRow.qtd} aluno(s)`, pagina: 'alunos', alvo: { tipo: 'aluno', ids: semTurmaIds, abaPerfil: 'dados' } },
    semEncarregadoRow?.qtd > 0 && { chave: 'registar_encarregados', qtd: semEncarregadoRow.qtd, titulo: `Registar encarregado de ${semEncarregadoRow.qtd} aluno(s)`, pagina: 'alunos', alvo: { tipo: 'aluno', ids: semEncarregadoIds, abaPerfil: 'encarregados' } },
    notasForaIntervaloRow?.qtd > 0 && { chave: 'corrigir_notas_invalidas', qtd: notasForaIntervaloRow.qtd, titulo: `Corrigir ${notasForaIntervaloRow.qtd} nota(s) fora do intervalo 0–20`, pagina: 'alunos', alvo: { tipo: 'aluno', ids: notasForaIntervaloIds, abaPerfil: 'notas' } },
    despesaValorInvalidoRow?.qtd > 0 && { chave: 'corrigir_despesas_invalidas', qtd: despesaValorInvalidoRow.qtd, titulo: `Corrigir ${despesaValorInvalidoRow.qtd} despesa(s) com valor inválido`, pagina: 'dashboard' },
    despesasDuplicadas.length > 0 && { chave: 'revisar_despesas_duplicadas', qtd: despesasDuplicadas.length, titulo: `Revisar ${despesasDuplicadas.length} possível(is) despesa(s) duplicada(s)`, pagina: 'dashboard' },
    salarioSemDespesaRow?.qtd > 0 && { chave: 'verificar_salarios_sem_despesa', qtd: salarioSemDespesaRow.qtd, titulo: `Verificar ${salarioSemDespesaRow.qtd} salário(s) sem despesa do mês`, pagina: 'funcionarios' },
    turmasSemPresencaRecente.length > 0 && { chave: 'lancar_presencas_atrasadas', qtd: turmasSemPresencaRecente.length, titulo: `Lançar presença em ${turmasSemPresencaRecente.length} turma(s) atrasada(s)`, pagina: 'presencas', alvo: { tipo: 'turma', ids: turmasSemPresencaRecente.map((t) => t.id) } },
  ].filter(Boolean);

  // ═══════════════════════════════════════════════════════════════════════
  // v114 — SEVERIDADE CONFIGURÁVEL DA CENTRAL DE ALERTAS
  // ───────────────────────────────────────────────────────────────────────
  // Por omissão, cada alerta acima mantém a severidade fixa por tipo que
  // sempre teve (ex.: "mensalidade atrasada" = sempre crítico), qualquer
  // que seja a escola — 0 mudança de comportamento para quem nunca mexer
  // nisto. Só quando a escola ativa "aplicar_limiares_central_alertas" em
  // Configurações → Radar da Escola é que a severidade passa a ser
  // recalculada como percentual da população afetada, usando os MESMOS
  // limiares configuráveis do Radar da Escola (radar_config) — um único
  // lugar para configurar o conceito "que percentual é grave para a minha
  // escola", em vez de duplicar a ideia num segundo sistema. Nunca desce um
  // alerta ainda visível (qtd > 0) para 'ok': isso pareceria "está tudo bem"
  // com o item continuando na lista — só sobe ou confirma a severidade.
  let classificacaoConfiguravel = false;
  try {
    const radarConfig = await getRadarConfig(schoolId);
    if (radarConfig.aplicar_limiares_central_alertas) {
      classificacaoConfiguravel = true;
      const [totaisRow] = await queryAsync(
        `SELECT
          (SELECT COUNT(*) FROM students WHERE school_id = ? AND ativo = 1) as alunos,
          (SELECT COUNT(*) FROM teachers WHERE school_id = ? AND ativo = 1) as professores,
          (SELECT COUNT(*) FROM turmas WHERE school_id = ? AND ativa = 1) as turmas
        `,
        [schoolId, schoolId, schoolId]
      );
      let totalFuncionarios = 0;
      try {
        const [linha] = await queryAsync(`SELECT COUNT(*) as qtd FROM funcionarios WHERE school_id = ? AND ativo = 1`, [schoolId]);
        totalFuncionarios = linha?.qtd || 0;
      } catch (e) { /* tabela de funcionários ainda não migrada nesta escola — trata como indisponível abaixo */ }
      let totalSalas = 0;
      try {
        const [linha] = await queryAsync(`SELECT COUNT(*) as qtd FROM salas WHERE school_id = ?`, [schoolId]);
        totalSalas = linha?.qtd || 0;
      } catch (e) { /* tabela de salas ainda não migrada nesta escola — trata como indisponível abaixo */ }

      const totais = {
        alunos: totaisRow?.alunos || 0, professores: totaisRow?.professores || 0, turmas: totaisRow?.turmas || 0,
        funcionarios: totalFuncionarios, salas: totalSalas,
      };
      // Cada tipo de alerta mapeado para a área do Radar da Escola (de onde
      // vêm os limiares) e para a população que serve de base ao percentual.
      // 'pagamentos_pendentes' fica de fora de propósito: é informativo
      // (severidade 'info'), não uma classificação de gravidade.
      const MAPA_AREA_ALERTA = {
        mensalidades_atrasadas: { area: 'financeiro', base: 'alunos' },
        documentacao_incompleta: { area: 'documentacao', base: 'alunos' },
        documentos_vencendo: { area: 'documentacao', base: 'alunos' },
        documentos_professor_vencendo: { area: 'documentacao', base: 'professores' },
        documentos_funcionario_vencendo: { area: 'documentacao', base: 'funcionarios' },
        turmas_sem_professor: { area: 'turmas', base: 'turmas' },
        turmas_superlotadas: { area: 'turmas', base: 'turmas' },
        salas_superlotadas: { area: 'turmas', base: 'salas' },
        frequencia_baixa: { area: 'alunos', base: 'alunos' },
        professores_sem_horario: { area: 'professores', base: 'professores' },
        conflitos_horario: { area: 'turmas', base: 'turmas' },
      };

      for (const alerta of alertas) {
        const mapa = MAPA_AREA_ALERTA[alerta.chave];
        if (!mapa || alerta.indisponivel) continue;
        const totalBase = totais[mapa.base];
        if (!totalBase) continue; // sem população para comparar (ex.: escola ainda sem módulo de funcionários) — mantém a severidade fixa
        const pct = percentual(alerta.qtd, totalBase);
        const limiteCritico = radarConfig[`limite_critico_${mapa.area}`];
        const limiteAtencao = radarConfig[`limite_atencao_${mapa.area}`];
        const nova = classificarPercentual(pct, pct, limiteCritico, limiteAtencao);
        alerta.percentual_afetado = Number(pct.toFixed(1));
        if (nova !== 'ok') alerta.severidade = nova;
      }
    }
  } catch (e) {
    console.error("[v0] Falha ao aplicar limiares configuráveis à Central de Alertas:", e.message);
  }

  return {
    brutos: {
      atrasoRow, pendenteRow, docIncompletaRow, documentosVencendoRow, documentosProfessorVencendoRow,
      documentosFuncionarioVencendoRow, turmasSemProfRow, turmasLotadas, salasLotadas, frequenciaBaixaRow,
      professoresSemHorarioRow, conflitosHorarioRow, renovacoesPendentesRow,
      semTurmaRow, semEncarregadoRow, notasForaIntervaloRow, despesaValorInvalidoRow, despesasDuplicadas,
      salarioSemDespesaRow, turmasSemPresencaRecente,
    },
    alertas: alertas.filter((a) => a.qtd > 0 || a.indisponivel),
    tarefas,
    // v113 — chaves dos sinais que não puderam ser calculados nesta consulta
    // (erro de conexão/consulta real, não tabela ainda não migrada). Vazio
    // na imensa maioria das vezes; quando não está vazio, o frontend deve
    // avisar o admin em vez de tratar os zeros correspondentes como reais.
    falhas,
    // v114 — true quando a escola ativou "aplicar_limiares_central_alertas"
    // (Configurações → Radar da Escola): a severidade acima já não é fixa
    // por tipo, foi calculada como percentual da população configurável.
    classificacao_configuravel: classificacaoConfiguravel,
  };
};

export const getDashboardAlerts = async (req, res) => {
  try {
    const { schoolId } = req.params;
    const { alertas, tarefas, falhas, classificacao_configuravel } = await calcularSinaisEscola(schoolId);
    res.json({
      success: true, alertas, tarefas, falhas, classificacao_configuravel,
      aviso_classificacao: classificacao_configuravel
        ? 'Severidade calculada segundo os parâmetros configurados pela escola (Configurações → Radar da Escola).'
        : null,
      gerado_em: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[v0] Erro ao montar alertas do dashboard:', err);
    res.status(500).json({ success: false, message: 'Erro ao montar alertas do dashboard', error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// RESUMO COMPLETO DO DASHBOARD — um único endpoint, tudo com dados reais
// ═══════════════════════════════════════════════════════════════════════════════
export const getDashboardSummary = async (req, res) => {
  try {
    await ensureTabelas();
    const { schoolId } = req.params;

    // ── TOTAIS ──────────────────────────────────────────────────────────────
    const [alunosRow] = await queryAsync(`SELECT COUNT(*) as total FROM students WHERE school_id = ? AND ativo = 1`, [schoolId]);
    const [professoresRow] = await queryAsync(`SELECT COUNT(*) as total FROM teachers WHERE school_id = ? AND ativo = 1`, [schoolId]);
    const [turmasRow] = await queryAsync(`SELECT COUNT(*) as total FROM turmas WHERE school_id = ? AND ativa = 1`, [schoolId]);
    // v113 — só trata como "0 legítimo" quando a tabela ainda não foi
    // criada nesta escola (nunca abriram a aba Funcionários); qualquer outro
    // erro sobe para o catch geral do endpoint (resposta 500), em vez de
    // aparecer como "0 funcionários" ao lado de números reais no mesmo resumo.
    let funcionariosRow = { total: 0 };
    try {
      [funcionariosRow] = await queryAsync(`SELECT COUNT(*) as total FROM funcionarios WHERE school_id = ? AND ativo = 1`, [schoolId]);
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
    }

    // ── NOVOS ALUNOS ESTE MÊS + TAXA DE CRESCIMENTO ────────────────────────
    const [novosMesRow] = await queryAsync(
      `SELECT COUNT(*) as total FROM students WHERE school_id = ? AND ativo = 1 AND MONTH(data_inscricao) = MONTH(CURDATE()) AND YEAR(data_inscricao) = YEAR(CURDATE())`,
      [schoolId]
    );
    // v128 — faltava "AND ativo = 1" aqui (a contagem do mês atual, acima,
    // já filtrava). Sem isto, "Taxa de Crescimento" comparava o nº de
    // matrículas ativas este mês contra o total de matrículas do mês
    // passado incluindo as já inativadas/arquivadas — duas bases
    // diferentes, o que distorcia o percentual mostrado.
    const [novosMesAnteriorRow] = await queryAsync(
      `SELECT COUNT(*) as total FROM students WHERE school_id = ? AND ativo = 1 AND MONTH(data_inscricao) = MONTH(CURDATE() - INTERVAL 1 MONTH) AND YEAR(data_inscricao) = YEAR(CURDATE() - INTERVAL 1 MONTH)`,
      [schoolId]
    );
    const novosMes = novosMesRow?.total || 0;
    const novosMesAnterior = novosMesAnteriorRow?.total || 0;
    const taxaCrescimento = novosMesAnterior > 0
      ? parseFloat((((novosMes - novosMesAnterior) / novosMesAnterior) * 100).toFixed(1))
      : (novosMes > 0 ? 100 : 0);

    // ── PRESENÇA HOJE ───────────────────────────────────────────────────────
    // v128 — a query só somava status = 'presente'/'falta'; os alunos
    // marcados 'atraso' ou 'justificada' (ambos válidos — ver STATUS_VALIDOS
    // em attendanceController.js) não entravam em nenhuma das duas contagens
    // e simplesmente desapareciam do KPI, mesmo já registados no
    // total_registado. Num dia em que a maioria fosse marcada 'atraso', o
    // admin via "0 Presentes" com a chamada já toda lançada. 'atraso' passa a
    // somar-se a presentes (mesmo critério de frequência já usado em
    // calcularFrequenciaAluno/insightsController — quem chegou atrasado
    // esteve presente), e 'justificada' ganha a sua própria contagem em vez
    // de ser descartada (não deve inflar "faltas", já que é uma ausência
    // justificada, mas também não deve ficar invisível).
    let presencaHoje = { presentes: 0, faltas: 0, atrasos: 0, justificadas: 0, total_registado: 0 };
    try {
      const [linha] = await queryAsync(
        `SELECT
           SUM(CASE WHEN status = 'presente' THEN 1 ELSE 0 END) as presentes,
           SUM(CASE WHEN status = 'falta' THEN 1 ELSE 0 END) as faltas,
           SUM(CASE WHEN status = 'atraso' THEN 1 ELSE 0 END) as atrasos,
           SUM(CASE WHEN status = 'justificada' THEN 1 ELSE 0 END) as justificadas,
           COUNT(*) as total_registado
         FROM presencas WHERE school_id = ? AND data = CURDATE()`,
        [schoolId]
      );
      const atrasos = linha?.atrasos || 0;
      presencaHoje = {
        presentes: (linha?.presentes || 0) + atrasos,
        faltas: linha?.faltas || 0,
        atrasos,
        justificadas: linha?.justificadas || 0,
        total_registado: linha?.total_registado || 0,
      };
    } catch (e) { /* tabela presencas pode ainda não existir */ }

    // ── FINANCEIRO ──────────────────────────────────────────────────────────
    const [receitaMesRow] = await queryAsync(
      `SELECT COALESCE(SUM(valor_pago), 0) as total, COUNT(*) as qtd FROM student_payments
       WHERE school_id = ? AND status = 'pago' AND MONTH(data_pagamento) = MONTH(CURDATE()) AND YEAR(data_pagamento) = YEAR(CURDATE())`,
      [schoolId]
    );
    const [receitaAnoRow] = await queryAsync(
      `SELECT COALESCE(SUM(valor_pago), 0) as total FROM student_payments
       WHERE school_id = ? AND status = 'pago' AND YEAR(data_pagamento) = YEAR(CURDATE())`,
      [schoolId]
    );
    const [atrasoRow] = await queryAsync(
      `SELECT COUNT(*) as qtd, COALESCE(SUM(valor_original + COALESCE(multa,0)), 0) as total FROM student_payments
       WHERE school_id = ? AND status = 'atrasado'`,
      [schoolId]
    );
    // v129/v155 — "Despesas do Mês" / "Lucro do Mês" abaixo somam a tabela
    // `despesas` diretamente; sem isto, se o cron diário (executarGeracaoDe
    // SalariosDiaria/executarGeracaoDeDespesasRecorrentesDiaria, 6:10) ainda
    // não tiver corrido hoje (escola nova, professor contratado a meio do
    // mês, falha pontual do cron), a folha salarial e/ou as despesas
    // recorrentes manuais deste mês simplesmente não estariam lançadas ainda
    // em `despesas` — "Despesas do Mês" ficaria artificialmente baixo e
    // "Lucro do Mês" artificialmente alto, mesmo com o card "Compromissos
    // Fixos" já a mostrar o valor comprometido. Chamar aqui (idempotente —
    // ver garantirDespesasDoMesAtual) garante que os números ficam sempre
    // alinhados com o que a escola realmente tem comprometido, sem depender
    // do horário em que o admin abre o Dashboard em relação ao cron — e sem
    // depender de já ter aberto a Central Financeira ou a lista de despesas
    // antes (garantirDespesasDoMesAtual é chamado nesses pontos também).
    await garantirDespesasDoMesAtual(schoolId);

    const [despesasMesRow] = await queryAsync(
      `SELECT COALESCE(SUM(valor), 0) as total FROM despesas
       WHERE school_id = ? AND MONTH(data_despesa) = MONTH(CURDATE()) AND YEAR(data_despesa) = YEAR(CURDATE())`,
      [schoolId]
    );
    const receitaMes = parseFloat(receitaMesRow?.total || 0);
    const despesasMes = parseFloat(despesasMesRow?.total || 0);

    const financeiro = {
      mensalidades_pagas_mes: receitaMesRow?.qtd || 0,
      mensalidades_atraso_qtd: atrasoRow?.qtd || 0,
      mensalidades_atraso_valor: parseFloat(atrasoRow?.total || 0),
      receita_mes: receitaMes,
      receita_ano: parseFloat(receitaAnoRow?.total || 0),
      despesas_mes: despesasMes,
      lucro_mes: parseFloat((receitaMes - despesasMes).toFixed(2)),
    };

    // ── PRÓXIMOS EVENTOS / EXAMES (próximos 60 dias) ───────────────────────
    let proximosEventos = [];
    let proximosExames = [];
    try {
      const eventos = await queryAsync(
        `SELECT * FROM eventos_escolares WHERE school_id = ? AND data_evento >= CURDATE() AND data_evento <= CURDATE() + INTERVAL 60 DAY ORDER BY data_evento ASC`,
        [schoolId]
      );
      proximosEventos = eventos.filter((e) => e.categoria !== 'exame').slice(0, 5);
      proximosExames = eventos.filter((e) => e.categoria === 'exame').slice(0, 5);
    } catch (e) { /* ignore */ }

    // ── PRÓXIMOS ANIVERSÁRIOS (alunos, próximos 30 dias, ignorando o ano) ──
    let proximosAniversarios = [];
    try {
      proximosAniversarios = await queryAsync(
        `
          SELECT id, nome, data_nascimento,
            DATEDIFF(
              DATE_ADD(data_nascimento, INTERVAL (YEAR(CURDATE()) - YEAR(data_nascimento) + IF(DAYOFYEAR(CURDATE()) > DAYOFYEAR(data_nascimento), 1, 0)) YEAR),
              CURDATE()
            ) as dias_restantes
          FROM students
          WHERE school_id = ? AND ativo = 1 AND data_nascimento IS NOT NULL
          HAVING dias_restantes BETWEEN 0 AND 30
          ORDER BY dias_restantes ASC
          LIMIT 8
        `,
        [schoolId]
      );
    } catch (e) { /* ignore */ }

    // ── GRÁFICO MENSAL: receita paga por mês (últimos 12 meses) ────────────
    const graficoMensal = await queryAsync(
      `
        SELECT DATE_FORMAT(data_pagamento, '%Y-%m') as mes, COALESCE(SUM(valor_pago), 0) as receita
        FROM student_payments
        WHERE school_id = ? AND status = 'pago' AND data_pagamento >= CURDATE() - INTERVAL 12 MONTH
        GROUP BY DATE_FORMAT(data_pagamento, '%Y-%m')
        ORDER BY mes ASC
      `,
      [schoolId]
    );

    // ── GRÁFICO ANUAL: receita por ano (últimos 5 anos) ─────────────────────
    const graficoAnual = await queryAsync(
      `
        SELECT YEAR(data_pagamento) as ano, COALESCE(SUM(valor_pago), 0) as receita
        FROM student_payments
        WHERE school_id = ? AND status = 'pago' AND data_pagamento >= CURDATE() - INTERVAL 5 YEAR
        GROUP BY YEAR(data_pagamento)
        ORDER BY ano ASC
      `,
      [schoolId]
    );

    // ── GRÁFICO POR TURMA: alunos por turma ─────────────────────────────────
    const graficoPorTurma = await queryAsync(
      `
        SELECT t.nome as turma, COUNT(s.id) as total
        FROM turmas t LEFT JOIN students s ON s.turma_id = t.id AND s.ativo = 1
        WHERE t.school_id = ? AND t.ativa = 1
        GROUP BY t.id, t.nome
        ORDER BY t.nome ASC
      `,
      [schoolId]
    );

    // ── GRÁFICO POR SEXO ─────────────────────────────────────────────────────
    const graficoPorSexoRaw = await queryAsync(
      `SELECT COALESCE(NULLIF(genero, ''), 'Não informado') as genero, COUNT(*) as total
       FROM students WHERE school_id = ? AND ativo = 1 GROUP BY genero`,
      [schoolId]
    );

    // ── GRÁFICO DE PAGAMENTOS: por status ───────────────────────────────────
    const graficoPagamentos = await queryAsync(
      `SELECT status, COUNT(*) as qtd, COALESCE(SUM(valor_original + COALESCE(multa,0)), 0) as valor
       FROM student_payments WHERE school_id = ? GROUP BY status`,
      [schoolId]
    );

    res.json({
      success: true,
      totais: {
        alunos: alunosRow?.total || 0,
        professores: professoresRow?.total || 0,
        turmas: turmasRow?.total || 0,
        funcionarios: funcionariosRow?.total || 0,
      },
      crescimento: { novos_mes: novosMes, novos_mes_anterior: novosMesAnterior, taxa_crescimento: taxaCrescimento },
      presenca_hoje: presencaHoje,
      financeiro,
      proximos_eventos: proximosEventos,
      proximos_exames: proximosExames,
      proximos_aniversarios: proximosAniversarios,
      graficos: {
        mensal: graficoMensal,
        anual: graficoAnual,
        por_turma: graficoPorTurma,
        por_sexo: graficoPorSexoRaw,
        pagamentos: graficoPagamentos,
      },
    });
  } catch (err) {
    console.error('[v0] Erro ao montar resumo do dashboard:', err);
    res.status(500).json({ success: false, message: 'Erro ao montar resumo do dashboard', error: err.message });
  }
};
