import bcrypt from 'bcrypt';
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

// ═══════════════════════════════════════════════════════════════════════════════
// ACESSO RESTRITO POR ÁREA — o administrador pode atribuir um código a
// qualquer área/aba do painel (ex.: "Financeiro"). Sem código = acesso livre.
// Com código = quem entrar nessa área tem de o introduzir primeiro. O código
// nunca é devolvido em texto simples — só o hash fica gravado, e a
// verificação é sempre feita aqui no backend.
// ═══════════════════════════════════════════════════════════════════════════════
export const ensureTabelasAreaRestrita = memoize(async () => {
  await queryAsync(`
    CREATE TABLE IF NOT EXISTS area_restrita_config (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL,
      area_id VARCHAR(50) NOT NULL,
      codigo_hash VARCHAR(255) NOT NULL,
      ativo TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_school_area (school_id, area_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await queryAsync(`
    CREATE TABLE IF NOT EXISTS area_restrita_tentativas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL,
      area_id VARCHAR(50) NOT NULL,
      sucesso TINYINT(1) NOT NULL,
      utilizador_codigo VARCHAR(100) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_school_area (school_id, area_id),
      KEY idx_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
});

// Nomes amigáveis das áreas — usados só para o relatório/auditoria ficar
// legível; a lista "oficial" de áreas (o que pode ou não ser restringido)
// vive no frontend (é o próprio menu lateral).
const NOMES_AREAS = {
  alunos: 'Alunos', professores: 'Professores', disciplinas: 'Disciplinas', turmas: 'Turmas',
  calendario: 'Calendário', biblioteca: 'Biblioteca', presencas: 'Presenças', renovacao: 'Renovações',
  horarios: 'Horários', salas: 'Salas', mensalidades: 'Mensalidades', financeiro: 'Central Financeira',
  funcionarios: 'Funcionários', relatorios: 'Relatórios',
};

// ── GUARDA DO PRÓPRIO PAINEL "ACESSO RESTRITO" ──────────────────────────────
// É uma "área" à parte, não listada no menu nem devolvida por
// getAreasRestritas (que só lista as áreas normais do menu) — existe só para
// proteger QUEM PODE VER/ALTERAR os códigos das outras áreas. Sem isto,
// qualquer pessoa com acesso ao painel do admin (Configurações fica sempre
// livre, de propósito) conseguiria remover ou trocar o código de qualquer
// área só por lá entrar. Guardamos na MESMA tabela (area_restrita_config),
// só que com este id reservado, que nunca aparece na lista de áreas normais.
const AREA_ID_GUARDA_PAINEL = '_painel_acesso_restrito';
const NOME_GUARDA_PAINEL = 'Painel de Acesso Restrito';

const areaIdValida = (areaId) => !!NOMES_AREAS[areaId] || areaId === AREA_ID_GUARDA_PAINEL;
const nomeDaArea = (areaId) => NOMES_AREAS[areaId] || (areaId === AREA_ID_GUARDA_PAINEL ? NOME_GUARDA_PAINEL : areaId);

// GET /schools/:schoolId/areas-restritas — lista o estado de todas as áreas
// (nunca devolve o código nem o hash, só se está definido/ativo).
export const getAreasRestritas = async (req, res) => {
  try {
    await ensureTabelasAreaRestrita();
    const { schoolId } = req.params;
    const linhas = await queryAsync(
      `SELECT area_id, ativo, updated_at FROM area_restrita_config WHERE school_id = ?`,
      [schoolId]
    );
    const porArea = {};
    linhas.forEach((l) => { porArea[l.area_id] = { tem_codigo: true, ativo: !!l.ativo, atualizado_em: l.updated_at }; });
    const areas = Object.keys(NOMES_AREAS).map((areaId) => ({
      area_id: areaId,
      nome: NOMES_AREAS[areaId],
      tem_codigo: !!porArea[areaId],
      ativo: porArea[areaId] ? porArea[areaId].ativo : false,
      atualizado_em: porArea[areaId]?.atualizado_em || null,
    }));
    res.json({ success: true, data: areas });
  } catch (err) {
    console.error('[v0] Erro ao listar áreas restritas:', err);
    res.status(500).json({ success: false, message: 'Erro ao listar áreas restritas', error: err.message });
  }
};

// GET /schools/:schoolId/areas-restritas/guarda — diz apenas se o painel de
// Acesso Restrito já tem um código de guarda configurado (para o frontend
// saber se deve mostrar "configure o código" ou "introduza o código").
export const getEstadoGuardaPainel = async (req, res) => {
  try {
    await ensureTabelasAreaRestrita();
    const { schoolId } = req.params;
    const linhas = await queryAsync(
      `SELECT id FROM area_restrita_config WHERE school_id = ? AND area_id = ? AND ativo = 1 LIMIT 1`,
      [schoolId, AREA_ID_GUARDA_PAINEL]
    );
    res.json({ success: true, tem_codigo: linhas.length > 0, area_id: AREA_ID_GUARDA_PAINEL });
  } catch (err) {
    console.error('[v0] Erro ao verificar guarda do painel de acesso restrito:', err);
    res.status(500).json({ success: false, message: 'Erro ao verificar guarda do painel', error: err.message });
  }
};

// PUT /schools/:schoolId/areas-restritas/:areaId — define ou atualiza o código de uma área
export const definirCodigoArea = async (req, res) => {
  try {
    await ensureTabelasAreaRestrita();
    const { schoolId, areaId } = req.params;
    const { codigo } = req.body;

    if (!areaIdValida(areaId)) {
      return res.status(400).json({ success: false, message: 'Área desconhecida' });
    }
    if (!codigo || String(codigo).trim().length < 4) {
      return res.status(400).json({ success: false, message: 'O código deve ter pelo menos 4 caracteres' });
    }

    const codigoHash = await bcrypt.hash(String(codigo).trim(), 10);
    await queryAsync(
      `INSERT INTO area_restrita_config (school_id, area_id, codigo_hash, ativo, created_at, updated_at)
       VALUES (?, ?, ?, 1, NOW(), NOW())
       ON DUPLICATE KEY UPDATE codigo_hash = VALUES(codigo_hash), ativo = 1, updated_at = NOW()`,
      [schoolId, areaId, codigoHash]
    );
    res.json({ success: true, message: `Código definido para "${nomeDaArea(areaId)}"` });
  } catch (err) {
    console.error('[v0] Erro ao definir código da área:', err);
    res.status(500).json({ success: false, message: 'Erro ao definir código da área', error: err.message });
  }
};

// DELETE /schools/:schoolId/areas-restritas/:areaId — remove a restrição (volta a ser livre)
export const removerCodigoArea = async (req, res) => {
  try {
    await ensureTabelasAreaRestrita();
    const { schoolId, areaId } = req.params;
    await queryAsync(`DELETE FROM area_restrita_config WHERE school_id = ? AND area_id = ?`, [schoolId, areaId]);
    res.json({ success: true, message: `"${nomeDaArea(areaId)}" voltou a ser de acesso livre` });
  } catch (err) {
    console.error('[v0] Erro ao remover código da área:', err);
    res.status(500).json({ success: false, message: 'Erro ao remover código da área', error: err.message });
  }
};

// POST /schools/:schoolId/areas-restritas/:areaId/verificar — confere o código
// introduzido por quem está a tentar entrar na área, e regista a tentativa.
export const verificarCodigoArea = async (req, res) => {
  try {
    await ensureTabelasAreaRestrita();
    const { schoolId, areaId } = req.params;
    const { codigo } = req.body;
    const utilizadorCodigo = req.user?.code || req.user?.id || null;

    const linhas = await queryAsync(
      `SELECT codigo_hash FROM area_restrita_config WHERE school_id = ? AND area_id = ? AND ativo = 1 LIMIT 1`,
      [schoolId, areaId]
    );

    // Sem restrição configurada — considera-se sempre válido (não há o que verificar)
    if (linhas.length === 0) {
      return res.json({ success: true, valido: true });
    }

    const valido = codigo ? await bcrypt.compare(String(codigo).trim(), linhas[0].codigo_hash) : false;

    await queryAsync(
      `INSERT INTO area_restrita_tentativas (school_id, area_id, sucesso, utilizador_codigo, created_at) VALUES (?, ?, ?, ?, NOW())`,
      [schoolId, areaId, valido ? 1 : 0, utilizadorCodigo]
    );

    res.json({ success: true, valido });
  } catch (err) {
    console.error('[v0] Erro ao verificar código da área:', err);
    res.status(500).json({ success: false, message: 'Erro ao verificar código da área', error: err.message });
  }
};

// GET /schools/:schoolId/areas-restritas/tentativas — histórico de tentativas
// (mais recentes primeiro), para o admin auditar quem tentou entrar onde.
export const getTentativasAreaRestrita = async (req, res) => {
  try {
    await ensureTabelasAreaRestrita();
    const { schoolId } = req.params;
    const { areaId, limite } = req.query;
    const params = [schoolId];
    let filtroArea = '';
    if (areaId) { filtroArea = ' AND area_id = ?'; params.push(areaId); }
    const limiteNum = Math.min(parseInt(limite, 10) || 100, 500);

    const linhas = await queryAsync(
      `SELECT id, area_id, sucesso, utilizador_codigo, created_at
       FROM area_restrita_tentativas WHERE school_id = ?${filtroArea}
       ORDER BY created_at DESC LIMIT ${limiteNum}`,
      params
    );
    const dados = linhas.map((l) => ({ ...l, area_nome: nomeDaArea(l.area_id), sucesso: !!l.sucesso }));
    res.json({ success: true, data: dados });
  } catch (err) {
    console.error('[v0] Erro ao listar tentativas de acesso restrito:', err);
    res.status(500).json({ success: false, message: 'Erro ao listar tentativas de acesso restrito', error: err.message });
  }
};
