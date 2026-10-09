import db from "../config/db.js";

const queryAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.query(sql, params, (error, rows) => {
    if (error) return reject(error);
    resolve(rows || []);
  });
});

const normalizarPaginacao = (query) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 25));
  return { page, limit, offset: (page - 1) * limit };
};

export const getPlatformOverview = async (req, res) => {
  try {
    const { page, limit, offset } = normalizarPaginacao(req.query);
    const search = String(req.query.search || "").trim();
    const role = String(req.query.role || "").trim();
    const status = String(req.query.status || "").trim();
    const like = `%${search}%`;

    const where = [];
    const params = [];
    if (search) {
      where.push("(name LIKE ? OR email LIKE ? OR code LIKE ?)");
      params.push(like, like, like);
    }
    if (role) {
      where.push("role = ?");
      params.push(role);
    }
    if (status) {
      where.push("status = ?");
      params.push(status);
    }
    const filtro = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const baseQuery = `
            SELECT sa.id, sa.code, sa.name, sa.email, sa.phone,
              'administrador' AS role, sa.status, sa.school_id,
              s.name AS school_name, sa.created_at
      FROM school_admins sa LEFT JOIN schools s ON s.id = sa.school_id
      UNION ALL
            SELECT t.id, t.codigo_professor AS code, t.nome AS name, t.email, t.telefone AS phone,
              'professor' AS role, IF(t.ativo = 1, 'ativo', 'inativo') AS status,
              t.school_id, s.name AS school_name, t.created_at
      FROM teachers t LEFT JOIN schools s ON s.id = t.school_id
      UNION ALL
            SELECT st.id, st.codigo_aluno AS code, st.nome AS name, st.email, st.telefone AS phone,
              'aluno' AS role, IF(st.ativo = 1, 'ativo', 'inativo') AS status,
              st.school_id, s.name AS school_name, st.created_at
      FROM students st LEFT JOIN schools s ON s.id = st.school_id
    `;

    const [schools, totals, users, countRows] = await Promise.all([
      queryAsync(`
        SELECT s.*, COUNT(st.id) AS actual_students
        FROM schools s
        LEFT JOIN students st ON st.school_id = s.id AND st.ativo = 1
        GROUP BY s.id ORDER BY s.created_at DESC
      `),
      queryAsync(`
        SELECT
          (SELECT COUNT(*) FROM school_admins) AS administradores,
          (SELECT COUNT(*) FROM teachers WHERE ativo = 1) AS professores,
          (SELECT COUNT(*) FROM students WHERE ativo = 1) AS alunos
      `),
      queryAsync(`SELECT * FROM (${baseQuery}) plataforma ${filtro} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]),
      queryAsync(`SELECT COUNT(*) AS total FROM (${baseQuery}) plataforma ${filtro}`, params),
    ]);

    const total = Number(countRows[0]?.total || 0);
    res.json({
      success: true,
      schools,
      totals: totals[0] || { administradores: 0, professores: 0, alunos: 0 },
      users,
      pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error) {
    console.error("[super-admin] Erro ao carregar visão global:", error);
    res.status(500).json({ success: false, message: "Erro ao carregar dados globais do Super Admin" });
  }
};
