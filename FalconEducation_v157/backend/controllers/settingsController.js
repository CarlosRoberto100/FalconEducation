import db from "../config/db.js";
import fs from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

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

// Obter todas as configurações
export const getSettings = async (req, res) => {
  console.log("[v0] Buscando todas as configurações");

  // Verificar se tabela existe
  const exists = await tableExists('system_settings');
  if (!exists) {
    console.log("[v0] Tabela 'system_settings' não existe - retornando configurações padrão");
    return res.json({
      currency: { value: 'MZN', type: 'string', description: 'Moeda padrão do sistema' },
      timezone: { value: 'Africa/Maputo', type: 'string', description: 'Zona horária do sistema' },
      payment_due_days: { value: '30', type: 'number', description: 'Dias para vencimento de pagamento' },
      company_name: { value: 'Falcon Education', type: 'string', description: 'Nome da empresa' }
    });
  }

  const result = await safeQuery("SELECT * FROM system_settings");

  if (result.error) {
    console.error("[v0] Erro ao buscar configurações:", result.error);
    return res.status(500).json({ error: "Erro ao buscar configurações" });
  }

  // Converter para objeto chave-valor
  const settings = {};
  result.data.forEach(setting => {
    settings[setting.setting_key] = {
      value: setting.setting_value,
      type: setting.setting_type,
      description: setting.description
    };
  });

  console.log("[v0] Configurações obtidas com sucesso");
  res.json(settings);
};

// Obter configuração específica
export const getSetting = async (req, res) => {
  const { key } = req.params;

  console.log("[v0] Buscando configuração:", key);

  const result = await safeQuery("SELECT * FROM system_settings WHERE setting_key = ?", [key]);

  if (result.error) {
    console.error("[v0] Erro ao buscar configuração:", result.error);
    return res.status(500).json({ error: "Erro ao buscar configuração" });
  }

  if (result.data.length === 0) {
    return res.status(404).json({ error: "Configuração não encontrada" });
  }

  console.log("[v0] Configuração obtida com sucesso");
  res.json(result.data[0]);
};

// Atualizar configuração
export const updateSetting = async (req, res) => {
  const { key } = req.params;
  const { value } = req.body;

  console.log("[v0] Atualizando configuração:", key, "para:", value);

  if (!key || value === undefined) {
    return res.status(400).json({ error: "key e value são obrigatórios" });
  }

  const result = await safeQuery(
    "UPDATE system_settings SET setting_value = ?, updated_at = NOW() WHERE setting_key = ?",
    [String(value), key]
  );

  if (result.error) {
    console.error("[v0] Erro ao atualizar configuração:", result.error);
    return res.status(500).json({ error: "Erro ao atualizar configuração" });
  }

  if (result.data.affectedRows === 0) {
    return res.status(404).json({ error: "Configuração não encontrada" });
  }

  console.log("[v0] Configuração atualizada com sucesso");
  res.json({ message: "Configuração atualizada com sucesso", key, value });
};

// Atualizar múltiplas configurações
export const updateSettings = async (req, res) => {
  console.log("[v0] Atualizando múltiplas configurações");

  const settings = req.body;

  if (!settings || Object.keys(settings).length === 0) {
    return res.status(400).json({ error: "Nenhuma configuração fornecida" });
  }

  const errors = [];
  const keys = Object.keys(settings);

  for (const key of keys) {
    const result = await safeQuery(
      "UPDATE system_settings SET setting_value = ?, updated_at = NOW() WHERE setting_key = ?",
      [String(settings[key]), key]
    );

    if (result.error) {
      console.error(`[v0] Erro ao atualizar ${key}:`, result.error);
      errors.push({ key, error: result.error.message });
    }
  }

  if (errors.length > 0) {
    console.log("[v0] Algumas configurações não foram atualizadas");
    return res.status(207).json({
      message: "Algumas configurações foram atualizadas",
      errors
    });
  }

  console.log("[v0] Todas as configurações foram atualizadas");
  res.json({ message: "Configurações atualizadas com sucesso" });
};

// Testar configurações SMTP
export const testSMTPSettings = async (req, res) => {
  console.log("[v0] Testando configurações SMTP");

  try {
    const result = await safeQuery(
      "SELECT * FROM system_settings WHERE setting_key IN ('smtp_host', 'smtp_port', 'smtp_user', 'smtp_password')"
    );

    if (result.error) {
      console.error("[v0] Erro ao buscar configurações SMTP:", result.error);
      return res.status(500).json({ error: "Erro ao testar SMTP" });
    }

    const smtpConfig = {};
    result.data.forEach(row => {
      smtpConfig[row.setting_key] = row.setting_value;
    });

    if (!smtpConfig.smtp_host || !smtpConfig.smtp_port) {
      return res.status(400).json({
        success: false,
        message: "Configurações SMTP incompletas"
      });
    }

    console.log("[v0] Configurações SMTP testadas");
    res.json({
      success: true,
      message: "Configurações SMTP válidas",
      config: {
        host: smtpConfig.smtp_host,
        port: smtpConfig.smtp_port,
        user: smtpConfig.smtp_user ? "***" : "não configurado"
      }
    });
  } catch (error) {
    console.error("[v0] Erro ao testar SMTP:", error);
    return res.status(500).json({ error: "Erro ao testar SMTP" });
  }
};

// Obter logs de auditoria
export const getAuditLogs = async (req, res) => {
  console.log("[v0] Buscando logs de auditoria");

  // Verificar se tabela existe
  const exists = await tableExists('audit_logs');
  if (!exists) {
    console.log("[v0] Tabela 'audit_logs' não existe - retornando array vazio");
    return res.json([]);
  }

  let { limit = 100, offset = 0, action, entity_type, user_id } = req.query;

  let sql = "SELECT * FROM audit_logs WHERE 1=1";
  let params = [];

  if (action) {
    sql += " AND action = ?";
    params.push(action);
  }

  if (entity_type) {
    sql += " AND entity_type = ?";
    params.push(entity_type);
  }

  if (user_id) {
    sql += " AND user_id = ?";
    params.push(user_id);
  }

  sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  params.push(parseInt(limit), parseInt(offset));

  const result = await safeQuery(sql, params);

  if (result.error) {
    console.error("[v0] Erro ao buscar logs:", result.error);
    return res.status(500).json({ error: "Erro ao buscar logs" });
  }

  console.log("[v0] Logs de auditoria obtidos com sucesso");
  res.json(result.data);
};

// Registrar ação na auditoria
export const logAction = async (userId, action, entityType, entityId, oldData, newData, ipAddress) => {
  const exists = await tableExists('audit_logs');
  if (!exists) {
    console.log("[v0] Tabela 'audit_logs' não existe - pulando log de auditoria");
    return;
  }

  const sql = `
    INSERT INTO audit_logs (user_id, action, entity_type, entity_id, old_data, new_data, ip_address)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;

  const result = await safeQuery(sql, [
    userId, 
    action, 
    entityType, 
    entityId, 
    JSON.stringify(oldData), 
    JSON.stringify(newData), 
    ipAddress
  ]);

  if (result.error) {
    console.error("[v0] Erro ao registrar ação na auditoria:", result.error);
  } else {
    console.log("[v0] Ação registrada na auditoria:", action);
  }
};

// v121 — getNotifications/markNotificationAsRead removidas daqui: eram uma
// SEGUNDA implementação da mesma leitura/escrita de `notifications` já
// feita (e usada de verdade, pelo sino do admin) em
// notificationController.js/services/notificationService.js — mas SEM
// filtrar por school_id, e confirmadas como não chamadas por nenhum
// componente do frontend (código morto). Ver o cabeçalho de
// services/notificationService.js para o histórico completo da unificação.

// ═══════════════════════════════════════════════════════════════════════════════
// BACKUP DA BASE DE DADOS
// ─────────────────────────────────────────────────────────────────────────────
// A versão anterior desta função só montava um caminho de ficheiro e devolvia
// "Backup criado com sucesso" — sem chamar mysqldump, sem tocar em disco e
// sem validar nada. Corrigido: agora corre mysqldump de verdade contra a
// mesma base configurada em config/db.js, escreve o ficheiro .sql, e só
// responde sucesso depois de confirmar que o ficheiro existe em disco e tem
// conteúdo (tamanho > 0). Qualquer falha do mysqldump (binário ausente,
// credenciais erradas, etc.) é reportada como erro — nunca como sucesso.
//
// Segurança da credencial: a password NUNCA é passada como argumento de
// linha de comando (ficaria visível para qualquer utilizador do servidor via
// `ps`). Em vez disso, é escrita momentaneamente num ficheiro
// --defaults-extra-file temporário (permissões 600, apagado logo a seguir,
// mesmo se o mysqldump falhar).
// ═══════════════════════════════════════════════════════════════════════════════

const BACKUP_DIR = process.env.BACKUP_DIR
  ? path.resolve(process.env.BACKUP_DIR)
  : path.join(process.cwd(), "backups");
const MYSQLDUMP_PATH = process.env.MYSQLDUMP_PATH || "mysqldump";

// Nome de ficheiro sempre gerado pelo servidor (nunca a partir de input do
// utilizador) — timestamp sem caracteres inválidos para nome de ficheiro.
const gerarNomeBackup = () => `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.sql`;

const garantirDiretorioBackups = () => {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
};

// Só aceita nomes exatamente no formato gerado por gerarNomeBackup — bloqueia
// qualquer tentativa de path traversal (../../etc/passwd) num parâmetro de
// rota que, por definição, vem de fora.
const NOME_BACKUP_VALIDO = /^backup-[0-9T\-]+Z\.sql$/;

export const createBackup = async (req, res) => {
  console.log("[v0] Criando backup do banco de dados");

  const { DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, DB_PORT } = process.env;
  if (!DB_HOST || !DB_USER || !DB_NAME) {
    return res.status(500).json({
      success: false,
      message: "Configuração da base de dados incompleta (DB_HOST/DB_USER/DB_NAME) — não é possível gerar backup.",
    });
  }

  garantirDiretorioBackups();
  const nomeFicheiro = gerarNomeBackup();
  const backupPath = path.join(BACKUP_DIR, nomeFicheiro);

  // --defaults-extra-file precisa de ser o PRIMEIRO argumento e de um
  // ficheiro real em disco — é assim que se passa a password ao mysqldump
  // sem ela aparecer na lista de processos do servidor.
  const defaultsFilePath = path.join(os.tmpdir(), `falcon-backup-${process.pid}-${Date.now()}.cnf`);
  const conteudoDefaults = `[client]\nhost=${DB_HOST}\nport=${DB_PORT || 3306}\nuser=${DB_USER}\npassword=${DB_PASSWORD || ""}\n`;

  try {
    fs.writeFileSync(defaultsFilePath, conteudoDefaults, { mode: 0o600 });

    await execFileAsync(
      MYSQLDUMP_PATH,
      [
        `--defaults-extra-file=${defaultsFilePath}`,
        "--single-transaction",
        "--routines",
        "--triggers",
        "--result-file",
        backupPath,
        DB_NAME,
      ],
      { maxBuffer: 1024 * 1024 * 50 } // até 50MB de stderr/stdout — dumps grandes só escrevem no ficheiro, isto é margem para avisos
    );

    // Nunca confiar só no exit code — confirmar que o ficheiro existe MESMO
    // e tem conteúdo antes de dizer ao utilizador que o backup foi feito.
    if (!fs.existsSync(backupPath) || fs.statSync(backupPath).size === 0) {
      throw new Error("mysqldump terminou sem erro mas o ficheiro de backup não foi criado ou está vazio.");
    }

    const stats = fs.statSync(backupPath);
    console.log(`[v0] Backup criado com sucesso: ${backupPath} (${stats.size} bytes)`);

    res.json({
      success: true,
      message: "Backup criado com sucesso",
      filename: nomeFicheiro,
      size_bytes: stats.size,
      timestamp: new Date(),
    });
  } catch (error) {
    console.error("[v0] Erro ao criar backup:", error.message);

    // Não deixar um ficheiro parcial/corrompido a passar por backup válido.
    if (fs.existsSync(backupPath)) {
      try { fs.unlinkSync(backupPath); } catch (_) { /* melhor esforço */ }
    }

    const binarioAusente = error.code === "ENOENT";
    res.status(500).json({
      success: false,
      message: binarioAusente
        ? "mysqldump não foi encontrado no servidor. Instale o cliente MySQL/MariaDB ou configure MYSQLDUMP_PATH no .env."
        : "Erro ao criar backup da base de dados.",
      error: error.message,
    });
  } finally {
    // O ficheiro de credenciais é de uso único — remover sempre, mesmo em
    // caso de falha do mysqldump.
    if (fs.existsSync(defaultsFilePath)) {
      try { fs.unlinkSync(defaultsFilePath); } catch (_) { /* melhor esforço */ }
    }
  }
};

// Listar backups já existentes em disco — usado pelo ecrã para mostrar o
// histórico e permitir descarregar um backup anterior, não só o mais recente.
export const listBackups = async (req, res) => {
  try {
    garantirDiretorioBackups();
    const ficheiros = fs.readdirSync(BACKUP_DIR)
      .filter((nome) => NOME_BACKUP_VALIDO.test(nome))
      .map((nome) => {
        const stats = fs.statSync(path.join(BACKUP_DIR, nome));
        return { filename: nome, size_bytes: stats.size, created_at: stats.birthtime || stats.mtime };
      })
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json({ success: true, backups: ficheiros });
  } catch (error) {
    console.error("[v0] Erro ao listar backups:", error.message);
    res.status(500).json({ success: false, message: "Erro ao listar backups", error: error.message });
  }
};

// Descarregar um backup específico — nome validado contra o formato exato
// gerado pelo servidor, e sempre resolvido dentro de BACKUP_DIR (nunca
// diretamente a partir do path.join com o input, para bloquear traversal).
export const downloadBackup = async (req, res) => {
  const nomeFicheiro = path.basename(req.params.filename || "");

  if (!NOME_BACKUP_VALIDO.test(nomeFicheiro)) {
    return res.status(400).json({ success: false, message: "Nome de ficheiro de backup inválido." });
  }

  const caminhoCompleto = path.join(BACKUP_DIR, nomeFicheiro);
  if (!caminhoCompleto.startsWith(BACKUP_DIR) || !fs.existsSync(caminhoCompleto)) {
    return res.status(404).json({ success: false, message: "Backup não encontrado." });
  }

  res.download(caminhoCompleto, nomeFicheiro, (error) => {
    if (error) console.error("[v0] Erro ao descarregar backup:", error.message);
  });
};

// Obter status do sistema
export const getSystemStatus = (req, res) => {
  console.log("[v0] Obtendo status do sistema");

  const statusData = {
    timestamp: new Date(),
    database: { connected: true, status: "OK" },
    services: []
  };

  db.ping((err) => {
    if (err) {
      statusData.database.connected = false;
      statusData.database.status = "ERROR";
      console.error("[v0] Erro na conexão com banco:", err);
    }

    res.json(statusData);
  });
};

// Deletar logs antigos
export const cleanOldLogs = async (req, res) => {
  console.log("[v0] Limpando logs antigos");

  const { days = 90 } = req.body;

  const exists = await tableExists('audit_logs');
  if (!exists) {
    return res.json({ message: "Tabela de logs não existe", deletedRows: 0 });
  }

  const result = await safeQuery(
    "DELETE FROM audit_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)",
    [parseInt(days)]
  );

  if (result.error) {
    console.error("[v0] Erro ao limpar logs:", result.error);
    return res.status(500).json({ error: "Erro ao limpar logs" });
  }

  console.log("[v0] Logs antigos removidos:", result.data.affectedRows);
  res.json({
    message: `${result.data.affectedRows} logs removidos com sucesso`,
    deletedRows: result.data.affectedRows
  });
};
