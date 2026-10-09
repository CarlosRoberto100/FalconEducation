import db from "../config/db.js";
import bcrypt from "bcrypt";

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

// Gerar código único para usuário
const generateUserCode = () => {
  const prefix = "USR";
  const timestamp = Date.now().toString().slice(-6);
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
  return `${prefix}${timestamp}${random}`;
};

// Criar novo usuário
export const createUser = async (req, res) => {
  console.log("[v0] Criando novo usuário:", { ...req.body, password: "***" });

  // Verificar se tabela existe
  const exists = await tableExists('users');
  if (!exists) {
    return res.status(503).json({ 
      error: "Tabela 'users' não existe. Execute o script SQL de criação de tabelas primeiro." 
    });
  }

  let { name, email, password, role, phone, status } = req.body;

  // Validações
  if (!name || !email || !password) {
    return res.status(400).json({ error: "Nome, email e senha são obrigatórios" });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: "Senha deve ter no mínimo 8 caracteres" });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: "Email inválido" });
  }

  name = String(name).trim();
  email = String(email).trim().toLowerCase();
  phone = phone ? String(phone).trim() : null;
  role = role || "user";
  status = status === "inativo" ? "inativo" : "ativo";

  try {
    // Verificar se email já existe
    const checkEmail = await safeQuery("SELECT id FROM users WHERE email = ?", [email]);
    
    if (checkEmail.error) {
      console.error("[v0] Erro ao verificar email:", checkEmail.error);
      return res.status(500).json({ error: "Erro ao verificar email" });
    }

    if (checkEmail.data.length > 0) {
      return res.status(409).json({ error: "Email já cadastrado" });
    }

    // Hash da senha
    const hashedPassword = await bcrypt.hash(password, 10);
    const code = generateUserCode();

    const sql = `
      INSERT INTO users (code, name, email, password, role, phone, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    const result = await safeQuery(sql, [code, name, email, hashedPassword, role, phone, status]);

    if (result.error) {
      console.error("[v0] Erro ao criar usuário:", result.error);
      return res.status(500).json({ error: "Erro ao criar usuário" });
    }

    console.log("[v0] Usuário criado com sucesso, ID:", result.data.insertId);
    res.status(201).json({
      id: result.data.insertId,
      code,
      name,
      email,
      role,
      phone,
      status,
      created_at: new Date()
    });
  } catch (error) {
    console.error("[v0] Erro ao criar usuário:", error);
    return res.status(500).json({ error: "Erro ao criar usuário" });
  }
};

// Obter todos os usuários com filtros
export const getUsers = async (req, res) => {
  console.log("[v0] Buscando usuários com query:", req.query);

  // Verificar se tabela existe
  const exists = await tableExists('users');
  if (!exists) {
    console.log("[v0] Tabela 'users' não existe - retornando array vazio");
    return res.json([]);
  }

  let { role, status, search, limit = 100, offset = 0 } = req.query;

  let sql = `
    SELECT 
      id, code, name, email, role, status, phone, last_login, created_at
    FROM users
    WHERE 1=1
  `;

  let params = [];

  if (role) {
    sql += " AND role = ?";
    params.push(role);
  }

  if (status) {
    sql += " AND status = ?";
    params.push(status);
  }

  if (search) {
    sql += " AND (name LIKE ? OR email LIKE ? OR code LIKE ?)";
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  params.push(parseInt(limit), parseInt(offset));

  const result = await safeQuery(sql, params);

  if (result.error) {
    console.error("[v0] Erro ao buscar usuários:", result.error);
    return res.status(500).json({ error: "Erro ao buscar usuários" });
  }

  console.log("[v0] Usuários encontrados:", result.data.length);
  res.json(result.data);
};

// Atualizar usuário
export const updateUser = async (req, res) => {
  const userId = req.params.id;
  const { name, email, phone, role, status, password } = req.body;

  console.log("[v0] Atualizando usuário ID:", userId);

  if (!name || !email) {
    return res.status(400).json({ error: "Nome e email são obrigatórios" });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: "Email inválido" });
  }

  try {
    let sql, params;

    // Se houver nova senha, criptografar
    if (password && password.length > 0) {
      if (password.length < 8) {
        return res.status(400).json({ error: "Senha deve ter no mínimo 8 caracteres" });
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      sql = `
        UPDATE users 
        SET name=?, email=?, phone=?, role=?, status=?, password=?
        WHERE id=?
      `;
      params = [name, email, phone, role, status, hashedPassword, userId];
    } else {
      sql = `
        UPDATE users 
        SET name=?, email=?, phone=?, role=?, status=?
        WHERE id=?
      `;
      params = [name, email, phone, role, status, userId];
    }

    const result = await safeQuery(sql, params);

    if (result.error) {
      console.error("[v0] Erro ao atualizar usuário:", result.error);
      return res.status(500).json({ error: "Erro ao atualizar usuário" });
    }

    console.log("[v0] Usuário atualizado com sucesso");
    res.json({ message: "Usuário atualizado com sucesso", id: userId });
  } catch (error) {
    console.error("[v0] Erro ao atualizar usuário:", error);
    return res.status(500).json({ error: "Erro ao atualizar usuário" });
  }
};

// Ativar/Inativar usuário
export const toggleUserStatus = async (req, res) => {
  const userId = req.params.id;
  const { status } = req.body;

  console.log("[v0] Alterando status do usuário ID:", userId, "para:", status);

  const newStatus = status === "inativo" ? "inativo" : "ativo";

  const result = await safeQuery("UPDATE users SET status = ? WHERE id = ?", [newStatus, userId]);

  if (result.error) {
    console.error("[v0] Erro ao alterar status:", result.error);
    return res.status(500).json({ error: "Erro ao alterar status" });
  }

  console.log("[v0] Status atualizado com sucesso");
  res.json({ message: `Usuário ${newStatus} com sucesso`, id: userId, status: newStatus });
};

// Deletar usuário
export const deleteUser = async (req, res) => {
  const userId = req.params.id;

  console.log("[v0] Deletando usuário ID:", userId);

  const result = await safeQuery("DELETE FROM users WHERE id = ?", [userId]);

  if (result.error) {
    console.error("[v0] Erro ao deletar usuário:", result.error);
    return res.status(500).json({ error: "Erro ao deletar usuário" });
  }

  console.log("[v0] Usuário deletado com sucesso");
  res.json({ message: "Usuário deletado com sucesso" });
};

// Login do usuário
export const userLogin = async (req, res) => {
  console.log("[v0] Tentativa de login do usuário");

  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email e senha são obrigatórios" });
  }

  try {
    const result = await safeQuery(
      "SELECT id, code, name, email, password, role, status FROM users WHERE email = ?", 
      [email]
    );

    if (result.error) {
      console.error("[v0] Erro ao buscar usuário:", result.error);
      return res.status(500).json({ error: "Erro ao fazer login" });
    }

    if (result.data.length === 0) {
      return res.status(401).json({ error: "Email ou senha inválidos" });
    }

    const user = result.data[0];

    // Verificar se usuário está inativo
    if (user.status === "inativo") {
      console.log("[v0] Usuário inativo tentou fazer login");
      return res.status(401).json({ error: "Usuário inativo. Contate o administrador." });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      await safeQuery(
        "UPDATE users SET login_attempts = login_attempts + 1, last_login_attempt = NOW() WHERE id = ?",
        [user.id]
      );

      console.log("[v0] Senha incorreta para usuário:", user.email);
      return res.status(401).json({ error: "Email ou senha inválidos" });
    }

    await safeQuery(
      "UPDATE users SET login_attempts = 0, last_login = NOW() WHERE id = ?",
      [user.id]
    );

    console.log("[v0] Login bem-sucedido para usuário:", user.email);
    res.json({
      id: user.id,
      code: user.code,
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status
    });
  } catch (error) {
    console.error("[v0] Erro ao fazer login:", error);
    return res.status(500).json({ error: "Erro ao fazer login" });
  }
};

// Resetar senha
export const resetPassword = async (req, res) => {
  const userId = req.params.id;
  const { newPassword } = req.body;

  console.log("[v0] Resetando senha para usuário ID:", userId);

  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: "Senha deve ter no mínimo 8 caracteres" });
  }

  try {
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    const result = await safeQuery("UPDATE users SET password = ? WHERE id = ?", [hashedPassword, userId]);

    if (result.error) {
      console.error("[v0] Erro ao resetar senha:", result.error);
      return res.status(500).json({ error: "Erro ao resetar senha" });
    }

    console.log("[v0] Senha resetada com sucesso");
    res.json({ message: "Senha resetada com sucesso", id: userId });
  } catch (error) {
    console.error("[v0] Erro ao resetar senha:", error);
    return res.status(500).json({ error: "Erro ao resetar senha" });
  }
};

// Obter estatísticas de usuários
export const getUserStats = async (req, res) => {
  console.log("[v0] Buscando estatísticas de usuários");

  // Verificar se tabela existe
  const exists = await tableExists('users');
  if (!exists) {
    console.log("[v0] Tabela 'users' não existe - retornando valores zerados");
    return res.json({
      total: 0,
      active: 0,
      inactive: 0,
      admins: 0,
      editors: 0,
      users: 0
    });
  }

  const sql = `
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'ativo' THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN status = 'inativo' THEN 1 ELSE 0 END) as inactive,
      SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) as admins,
      SUM(CASE WHEN role = 'editor' THEN 1 ELSE 0 END) as editors,
      SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) as users
    FROM users
  `;

  const result = await safeQuery(sql);

  if (result.error) {
    console.error("[v0] Erro ao buscar estatísticas:", result.error);
    return res.status(500).json({ error: "Erro ao buscar estatísticas" });
  }

  console.log("[v0] Estatísticas de usuários calculadas");
  res.json(result.data[0] || {
    total: 0,
    active: 0,
    inactive: 0,
    admins: 0,
    editors: 0,
    users: 0
  });
};
