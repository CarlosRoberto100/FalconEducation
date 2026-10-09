import db from "../config/db.js";

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

export const createSchool = async (req, res) => {
  console.log("[v0] Dados recebidos:", req.body);
  
  let { name, email, phone, students, student_limit, status } = req.body;

  // Validações
  if (!name || !email || !phone) {
    console.log("[v0] Validação falhou: campos obrigatórios faltando");
    return res.status(400).json({ error: "Nome, email e telefone são obrigatórios" });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    console.log("[v0] Validação falhou: email inválido", email);
    return res.status(400).json({ error: "Email inválido" });
  }

  // Sanitização
  name = String(name).trim();
  email = String(email).trim().toLowerCase();
  phone = String(phone).trim();
  students = parseInt(students) || 0;
  student_limit = student_limit ? parseInt(student_limit) : null;
  status = (status === "inativa") ? "inativa" : "ativa";

  console.log("[v0] Dados sanitizados:", { name, email, phone, students, student_limit, status });

  try {
    // Verificar se email já existe
    const checkEmail = await safeQuery("SELECT id FROM schools WHERE email = ?", [email]);
    
    if (checkEmail.error) {
      console.error("[v0] Erro ao verificar email:", checkEmail.error);
      return res.status(500).json({ error: "Erro ao verificar email" });
    }
    
    if (checkEmail.data.length > 0) {
      console.log("[v0] Email já existe:", email);
      return res.status(409).json({ error: "Email já cadastrado" });
    }

    // Inserir escola
    const sql = `INSERT INTO schools (name, email, phone, students, student_limit, status) VALUES (?, ?, ?, ?, ?, ?)`;
    const result = await safeQuery(sql, [name, email, phone, students, student_limit, status]);
    
    if (result.error) {
      console.error("[v0] Erro ao inserir escola no banco:", result.error);
      return res.status(500).json({ error: "Erro ao criar escola: " + result.error.message });
    }

    console.log("[v0] Escola criada com sucesso, ID:", result.data.insertId);
    res.status(201).json({
      id: result.data.insertId,
      name,
      email,
      phone,
      students,
      student_limit,
      status,
      created_at: new Date()
    });
  } catch (error) {
    console.error("[v0] Erro ao criar escola:", error);
    return res.status(500).json({ error: "Erro ao criar escola" });
  }
};

export const getSchools = async (req, res) => {
  // Verificar se tabela existe
  const exists = await tableExists('schools');
  if (!exists) {
    console.log("[v0] Tabela 'schools' não existe - retornando array vazio");
    return res.json([]);
  }

  // `schools.students` é um campo legado/manual e pode ficar desatualizado.
  // Expor a contagem real com um nome explícito evita colisão com esse campo.
  const result = await safeQuery(`
    SELECT
      s.*,
      COUNT(st.id) AS actual_students
    FROM schools s
    LEFT JOIN students st ON st.school_id = s.id AND st.ativo = 1
    GROUP BY s.id
    ORDER BY s.created_at DESC
  `);
  
  if (result.error) {
    console.error("[v0] Erro ao buscar escolas:", result.error);
    return res.status(500).json({ error: "Erro ao buscar escolas" });
  }
  
  console.log("[v0] Escolas encontradas:", result.data.length);
  res.json(result.data);
};

export const getActiveSchoolsCount = async (req, res) => {
  // Verificar se tabela existe
  const exists = await tableExists('schools');
  if (!exists) {
    console.log("[v0] Tabela 'schools' não existe - retornando 0");
    return res.json({ count: 0 });
  }

  const result = await safeQuery("SELECT COUNT(*) as count FROM schools WHERE status = 'ativa'");
  
  if (result.error) {
    console.error("[v0] Erro ao contar escolas ativas:", result.error);
    return res.status(500).json({ error: "Erro ao contar escolas" });
  }
  
  console.log("[v0] Escolas ativas:", result.data[0]?.count || 0);
  res.json({ count: result.data[0]?.count || 0 });
};

export const updateSchool = async (req, res) => {
  const id = req.params.id;
  const { name, email, phone, students, student_limit, status } = req.body;

  if (!name || !email || !phone) {
    return res.status(400).json({ error: "Campos obrigatórios não preenchidos" });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: "Email inválido" });
  }

  const sql = `UPDATE schools SET name=?, email=?, phone=?, students=?, student_limit=?, status=? WHERE id=?`;
  const result = await safeQuery(sql, [
    name, 
    email, 
    phone, 
    parseInt(students) || 0, 
    student_limit ? parseInt(student_limit) : null, 
    status, 
    id
  ]);
  
  if (result.error) {
    console.error("[v0] Erro ao atualizar escola:", result.error);
    return res.status(500).json({ error: "Erro ao atualizar escola" });
  }
  
  console.log("[v0] Escola atualizada, ID:", id);
  res.json({ message: "Escola atualizada com sucesso", id });
};

export const deleteSchool = async (req, res) => {
  const id = req.params.id;
  
  const result = await safeQuery("DELETE FROM schools WHERE id = ?", [id]);
  
  if (result.error) {
    console.error("[v0] Erro ao deletar escola:", result.error);
    return res.status(500).json({ error: "Erro ao deletar escola" });
  }
  
  console.log("[v0] Escola deletada, ID:", id);
  res.json({ message: "Escola deletada com sucesso" });
};

// ═══════════════════════════════════════════════════════════════════════════════
// PERFIL DA ESCOLA (usado pelo Administrador na aba Configurações) — distinto do
// updateSchool acima (que é de uso exclusivo do Super Admin, sem autenticação
// própria de escola). Aqui o admin só edita os dados da própria escola: nome,
// contacto, morada e NUIT (identificação fiscal em Moçambique).
// ═══════════════════════════════════════════════════════════════════════════════
export const ensureSchoolProfileColumnsExist = async () => {
  const columnExists = async (column) => {
    const result = await safeQuery(`SHOW COLUMNS FROM schools LIKE ?`, [column]);
    return Array.isArray(result.data) && result.data.length > 0;
  };
  if (!(await columnExists('nuit'))) {
    await safeQuery(`ALTER TABLE schools ADD COLUMN nuit VARCHAR(20) NULL AFTER phone`);
  }
  if (!(await columnExists('address'))) {
    await safeQuery(`ALTER TABLE schools ADD COLUMN address TEXT NULL`);
  }
  if (!(await columnExists('provincia'))) {
    await safeQuery(`ALTER TABLE schools ADD COLUMN provincia VARCHAR(50) NULL`);
  }
};

const PROVINCIAS_MOCAMBIQUE = [
  'Cabo Delgado', 'Gaza', 'Inhambane', 'Manica', 'Maputo Cidade', 'Maputo Província',
  'Nampula', 'Niassa', 'Sofala', 'Tete', 'Zambézia',
];

export const getSchoolProfile = async (req, res) => {
  try {
    await ensureSchoolProfileColumnsExist();
    const { schoolId } = req.params;
    const resultado = await safeQuery(`SELECT id, name, email, phone, nuit, address, provincia, status FROM schools WHERE id = ?`, [schoolId]);
    if (resultado.error || resultado.data.length === 0) {
      return res.status(404).json({ success: false, message: 'Escola não encontrada' });
    }
    res.json({ success: true, data: resultado.data[0], provincias: PROVINCIAS_MOCAMBIQUE });
  } catch (err) {
    console.error('[v0] Erro ao buscar perfil da escola:', err);
    res.status(500).json({ success: false, message: 'Erro ao buscar perfil da escola', error: err.message });
  }
};

export const updateSchoolProfile = async (req, res) => {
  try {
    await ensureSchoolProfileColumnsExist();
    const { schoolId } = req.params;
    const { name, email, phone, nuit, address, provincia } = req.body;

    if (!name?.trim() || !email?.trim()) {
      return res.status(400).json({ success: false, message: 'Nome e email são obrigatórios' });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, message: 'Email inválido' });
    }
    if (nuit && !/^\d{9}$/.test(String(nuit).trim())) {
      return res.status(400).json({ success: false, message: 'NUIT deve ter exatamente 9 dígitos' });
    }

    const resultado = await safeQuery(
      `UPDATE schools SET name=?, email=?, phone=?, nuit=?, address=?, provincia=? WHERE id=?`,
      [name.trim(), email.trim(), phone || null, nuit || null, address || null, provincia || null, schoolId]
    );
    if (resultado.error) {
      return res.status(500).json({ success: false, message: 'Erro ao salvar perfil da escola', error: resultado.error });
    }
    res.json({ success: true, message: 'Dados da escola atualizados com sucesso' });
  } catch (err) {
    console.error('[v0] Erro ao atualizar perfil da escola:', err);
    res.status(500).json({ success: false, message: 'Erro ao atualizar perfil da escola', error: err.message });
  }
};

// Obter escola por ID
export const getSchoolById = async (req, res) => {
  const id = req.params.id;

  const result = await safeQuery("SELECT * FROM schools WHERE id = ?", [id]);
  
  if (result.error) {
    console.error("[v0] Erro ao buscar escola:", result.error);
    return res.status(500).json({ error: "Erro ao buscar escola" });
  }

  if (result.data.length === 0) {
    return res.status(404).json({ error: "Escola não encontrada" });
  }

  res.json(result.data[0]);
};

// Obter escolas com filtros
export const getSchoolsFiltered = async (req, res) => {
  let { status, search, limit = 100, offset = 0 } = req.query;

  let sql = "SELECT * FROM schools WHERE 1=1";
  let params = [];

  if (status) {
    sql += " AND status = ?";
    params.push(status);
  }

  if (search) {
    sql += " AND (name LIKE ? OR email LIKE ?)";
    params.push(`%${search}%`, `%${search}%`);
  }

  sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  params.push(parseInt(limit), parseInt(offset));

  const result = await safeQuery(sql, params);
  
  if (result.error) {
    console.error("[v0] Erro ao buscar escolas:", result.error);
    return res.status(500).json({ error: "Erro ao buscar escolas" });
  }
  
  console.log("[v0] Escolas encontradas:", result.data.length);
  res.json(result.data);
};
