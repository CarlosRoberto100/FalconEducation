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

// Gerar código único para admin: ADM + school_id + mês + dia
const generateAdminCode = (schoolId) => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `ADM${schoolId}${month}${day}`;
};

// Gerar senha aleatória
const generatePassword = (length = 12) => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%";
  let password = "";
  for (let i = 0; i < length; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
};

// Criar novo admin
export const createAdmin = async (req, res) => {
  console.log("[v0] Criando novo admin:", { ...req.body, password: "***" });

  let { school_id, name, email, phone, status, password } = req.body;

  // Validações
  if (!school_id || !name || !email) {
    return res.status(400).json({ error: "school_id, name e email são obrigatórios" });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: "Email inválido" });
  }

  name = String(name).trim();
  email = String(email).trim().toLowerCase();
  phone = phone ? String(phone).trim() : null;
  status = status === "inativo" ? "inativo" : "ativo";

  try {
    // Verificar se escola existe
    const checkSchool = await safeQuery("SELECT id FROM schools WHERE id = ?", [school_id]);
    if (checkSchool.error || checkSchool.data.length === 0) {
      return res.status(404).json({ error: "Escola não encontrada" });
    }

    // Verificar se email já existe
    const checkEmail = await safeQuery("SELECT id FROM school_admins WHERE email = ?", [email]);
    if (checkEmail.data && checkEmail.data.length > 0) {
      return res.status(409).json({ error: "Email já cadastrado" });
    }

    // Gerar código e senha
    const code = generateAdminCode(school_id);
    const plainPassword = String(password).trim();
    const hashedPassword = await bcrypt.hash(plainPassword, 10);

    const sql = `
      INSERT INTO school_admins (school_id, code, name, email, password, phone, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    const result = await safeQuery(sql, [school_id, code, name, email, hashedPassword, phone, status]);

    if (result.error) {
      console.error("[v0] Erro ao criar admin:", result.error);
      return res.status(500).json({ error: "Erro ao criar admin" });
    }

    console.log("[v0] Admin criado com sucesso, ID:", result.data.insertId);
    res.status(201).json({
      id: result.data.insertId,
      school_id,
      code,
      name,
      email,
      phone,
      status,
      plainPassword, // Retornar senha para o super admin mostrar
      created_at: new Date()
    });
  } catch (error) {
    console.error("[v0] Erro ao criar admin:", error);
    return res.status(500).json({ error: "Erro ao criar admin" });
  }
};

// Obter todos os admins
export const getAllAdmins = async (req, res) => {
  console.log("[v0] Buscando todos os admins");

  const exists = await tableExists('school_admins');
  if (!exists) {
    console.log("[v0] Tabela 'school_admins' não existe - retornando array vazio");
    return res.json([]);
  }

  const sql = `
    SELECT 
      sa.id,
      sa.school_id,
      sa.code,
      sa.name,
      sa.email,
      sa.phone,
      sa.status,
      sa.created_at,
      s.name as school_name
    FROM school_admins sa
    LEFT JOIN schools s ON sa.school_id = s.id
    ORDER BY sa.created_at DESC
  `;

  const result = await safeQuery(sql);

  if (result.error) {
    console.error("[v0] Erro ao buscar admins:", result.error);
    return res.status(500).json({ error: "Erro ao buscar admins" });
  }

  console.log("[v0] Total de admins:", result.data.length);
  res.json(result.data);
};

// Obter admins por escola
export const getAdminsBySchool = async (req, res) => {
  const { school_id } = req.params;

  console.log("[v0] Buscando admins da escola:", school_id);

  const sql = `
    SELECT id, code, name, email, phone, status, created_at
    FROM school_admins
    WHERE school_id = ?
    ORDER BY created_at DESC
  `;

  const result = await safeQuery(sql, [school_id]);

  if (result.error) {
    console.error("[v0] Erro ao buscar admins da escola:", result.error);
    return res.status(500).json({ error: "Erro ao buscar admins" });
  }

  res.json(result.data);
};

// Atualizar admin
export const updateAdmin = async (req, res) => {
  const adminId = req.params.id;
  let { name, email, phone, status, password } = req.body;

  console.log("[v0] Atualizando admin ID:", adminId);

  if (!name || !email) {
    return res.status(400).json({ error: "Nome e email são obrigatórios" });
  }

  name = String(name).trim();
  email = String(email).trim().toLowerCase();
  phone = phone ? String(phone).trim() : null;

  try {
    let sql, params;

    if (password && password.trim().length > 0) {
      const hashedPassword = await bcrypt.hash(password.trim(), 10);
      sql = `
        UPDATE school_admins 
        SET name=?, email=?, phone=?, status=?, password=?, updated_at=NOW()
        WHERE id=?
      `;
      params = [name, email, phone, status, hashedPassword, adminId];
    } else {
      sql = `
        UPDATE school_admins 
        SET name=?, email=?, phone=?, status=?, updated_at=NOW()
        WHERE id=?
      `;
      params = [name, email, phone, status, adminId];
    }

    const result = await safeQuery(sql, params);

    if (result.error) {
      console.error("[v0] Erro ao atualizar admin:", result.error);
      return res.status(500).json({ error: "Erro ao atualizar admin" });
    }

    console.log("[v0] Admin atualizado com sucesso");
    res.json({ message: "Admin atualizado com sucesso", id: adminId });
  } catch (error) {
    console.error("[v0] Erro ao atualizar admin:", error);
    return res.status(500).json({ error: "Erro ao atualizar admin" });
  }
};

// Deletar admin
export const deleteAdmin = async (req, res) => {
  const adminId = req.params.id;

  console.log("[v0] Deletando admin ID:", adminId);

  const result = await safeQuery("DELETE FROM school_admins WHERE id = ?", [adminId]);

  if (result.error) {
    console.error("[v0] Erro ao deletar admin:", result.error);
    return res.status(500).json({ error: "Erro ao deletar admin" });
  }

  console.log("[v0] Admin deletado com sucesso");
  res.json({ message: "Admin deletado com sucesso" });
};

// ⚠️ NÃO USADO / NÃO ROTEADO — mantido apenas para referência histórica.
// A rota que chamava esta função (POST /api/admins/login) foi removida de
// routes/adminRoutes.js porque estava atrás de verifyToken+verifySuperAdmin
// e por isso nunca respondia (ver comentário em adminRoutes.js). O login
// real do administrador de escola está em authSchoolAdminController.js
// (schoolAdminLogin), que já emite JWT e faz as mesmas verificações.
export const adminLogin = async (req, res) => {
  console.log("[v0] Tentativa de login do admin");

  const { code, password } = req.body;

  if (!code || !password) {
    return res.status(400).json({ error: "Código e senha são obrigatórios" });
  }

  try {
    const sql = `
      SELECT sa.*, s.name as school_name, s.status as school_status
      FROM school_admins sa
      LEFT JOIN schools s ON sa.school_id = s.id
      WHERE sa.code = ? OR sa.email = ?
    `;

    const result = await safeQuery(sql, [code, code]);

    if (result.error) {
      console.error("[v0] Erro ao buscar admin:", result.error);
      return res.status(500).json({ error: "Erro ao fazer login" });
    }

    if (result.data.length === 0) {
      return res.status(401).json({ error: "Código ou senha inválidos" });
    }

    const admin = result.data[0];

    // Verificar se admin está ativo
    if (admin.status === "inativo") {
      return res.status(401).json({ error: "Conta inativa. Contate o super admin." });
    }

    // Verificar se escola está ativa
    if (admin.school_status === "inativa") {
      return res.status(401).json({ error: "Escola inativa. Verifique o pagamento." });
    }

    const isPasswordValid = await bcrypt.compare(password, admin.password);

    if (!isPasswordValid) {
      return res.status(401).json({ error: "Código ou senha inválidos" });
    }

    console.log("[v0] Login bem-sucedido para admin:", admin.code);
    res.json({
      id: admin.id,
      code: admin.code,
      name: admin.name,
      email: admin.email,
      school_id: admin.school_id,
      school_name: admin.school_name,
      status: admin.status
    });
  } catch (error) {
    console.error("[v0] Erro ao fazer login:", error);
    return res.status(500).json({ error: "Erro ao fazer login" });
  }
};

// Obter credenciais do admin
export const getAdminCredentials = async (req, res) => {
  const adminId = req.params.id;

  console.log("[v0] Buscando credenciais do admin:", adminId);

  const result = await safeQuery(
    "SELECT id, code, email FROM school_admins WHERE id = ?",
    [adminId]
  );

  if (result.error) {
    console.error("[v0] Erro ao buscar credenciais:", result.error);
    return res.status(500).json({ error: "Erro ao buscar credenciais" });
  }

  if (result.data.length === 0) {
    return res.status(404).json({ error: "Admin não encontrado" });
  }

  res.json(result.data[0]);
};

// Resetar senha do admin
export const resetAdminPassword = async (req, res) => {
  const adminId = req.params.id;

  console.log("[v0] Resetando senha do admin:", adminId);

  try {
    const plainPassword = generatePassword();
    const hashedPassword = await bcrypt.hash(plainPassword, 10);

    const result = await safeQuery(
      "UPDATE school_admins SET password = ?, updated_at = NOW() WHERE id = ?",
      [hashedPassword, adminId]
    );

    if (result.error) {
      console.error("[v0] Erro ao resetar senha:", result.error);
      return res.status(500).json({ error: "Erro ao resetar senha" });
    }

    console.log("[v0] Senha resetada com sucesso");
    res.json({ 
      message: "Senha resetada com sucesso", 
      id: adminId,
      newPassword: plainPassword 
    });
  } catch (error) {
    console.error("[v0] Erro ao resetar senha:", error);
    return res.status(500).json({ error: "Erro ao resetar senha" });
  }
};